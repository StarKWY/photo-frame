#!/usr/bin/env node
/* 用 CDP 驱动无头 Chrome：等页面真正就绪后再截图，避开虚拟时钟竞态。
   用法：node shot-cdp.mjs <宽> <高> <输出目录> <页面1> <页面2> ...  */
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9411 + Math.floor(Math.random() * 200);

const args = process.argv.slice(2);
const W = Number(args[0]) || 1500;
const H = Number(args[1]) || 1080;
const OUTDIR = args[2] || '/tmp';
const PAGES = args.slice(3);
const MOBILE = W < 900;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitPort() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch (e) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口没起来');
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  });
  return (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('CDP 超时: ' + method)); } }, 25000);
  });
}

async function openWs(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WS 连不上')), { once: true });
  });
  return ws;
}

const chrome = spawn(CH, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--hide-scrollbars', '--disable-extensions', '--mute-audio',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=/tmp/crs-cdp-${PORT}`,
  'about:blank'
], { stdio: 'ignore' });

let failed = 0;
try {
  await waitPort();

  for (const name of PAGES) {
    const url = `file://${DIR}/tests/.tmp/shot_${name}.html`;
    let target;
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
      target = await r.json();
    } catch (e) {
      console.log(`${name} SKIP(新建标签失败)`);
      failed++; continue;
    }

    const ws = await openWs(target.webSocketDebuggerUrl);
    const send = cdp(ws);
    try {
      await send('Page.enable');
      await send('Emulation.setDeviceMetricsOverride', {
        width: W, height: H, deviceScaleFactor: MOBILE ? 2 : 1, mobile: MOBILE
      });

      // 等页面自报就绪
      let ready = false, err = '';
      for (let i = 0; i < 60; i++) {
        await sleep(250);
        const r = await send('Runtime.evaluate', {
          expression: 'window.__err || (window.__ready ? "OK" : "")',
          returnByValue: true
        });
        const v = r.result && r.result.value;
        if (v === 'OK') { ready = true; break; }
        if (v && v !== '') { err = v; break; }
      }
      await sleep(320);

      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(`${OUTDIR}/${name}.png`, Buffer.from(shot.data, 'base64'));
      console.log(`${name} ${ready ? 'OK' : 'NOT_READY'} ${err ? 'ERR:' + err.slice(0, 160) : ''}`);
      if (!ready) failed++;
    } catch (e) {
      console.log(`${name} FAIL ${e.message}`);
      failed++;
    } finally {
      try { ws.close(); } catch (e) { }
      try { await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`); } catch (e) { }
    }
  }
} finally {
  chrome.kill('SIGKILL');
}
process.exit(failed ? 1 : 0);
