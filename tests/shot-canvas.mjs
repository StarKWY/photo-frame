#!/usr/bin/env node
/* 只截「预览画布」本身（带 2 倍放大），便于近距离检查文字落位。
   用法：node shot-canvas.mjs <页面名> <输出png> [宽] [高] */
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = process.argv[2];
const OUT = process.argv[3];
const W = Number(process.argv[4]) || 1300;
const H = Number(process.argv[5]) || 1000;
const PORT = 9600 + Math.floor(Math.random() * 300);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function cdp(ws) {
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  });
  return (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('timeout ' + method)); } }, 25000);
  });
}

const chrome = spawn(CH, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/crs-clip-${PORT}`, `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });

try {
  for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch (e) { } await sleep(250); }
  const url = `file://${DIR}/._shot_${NAME}.html`;
  const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const t = await r.json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws')), { once: true }); });
  const send = cdp(ws);
  await send('Page.enable'); await send('Runtime.enable');
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const q = await send('Runtime.evaluate', { expression: 'window.__err || (window.__ready ? "OK" : "")', returnByValue: true });
    const v = q.result && q.result.value;
    if (v === 'OK') break;
    if (v) { console.log('页面报错', v.slice(0, 200)); break; }
  }
  await sleep(350);
  const box = await send('Runtime.evaluate', {
    expression: `(function(){var r=document.getElementById('preview').getBoundingClientRect();
      return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height});})()`, returnByValue: true
  });
  const b = JSON.parse(box.result.value);
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: Math.round(b.x) - 6, y: Math.round(b.y) - 6, width: Math.round(b.w) + 12, height: Math.round(b.h) + 12, scale: 2 }
  });
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log(`${NAME} → ${OUT} (画布 ${Math.round(b.w)}×${Math.round(b.h)} @2x)`);
  ws.close();
} catch (e) {
  console.log('ERR', e.message);
} finally {
  chrome.kill('SIGKILL');
}
