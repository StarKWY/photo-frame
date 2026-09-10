#!/usr/bin/env node
/* 逐拍追踪：每次点模板后，看 .app / main / .stage / .canvas-area / canvas 的高度链 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAGE = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html')).href;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const W = Number(process.argv[2]) || 1600;
const H = Number(process.argv[3]) || 900;
const DPR = Number(process.argv[4]) || 2;
const EMU = process.argv[5] === 'emu';
const CLICKS = Number(process.argv[6]) || 10;
const PORT = 9100 + Math.floor(Math.random() * 4000);

function cdp(ws) {
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  });
  return (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('timeout ' + method)); } }, 30000);
  });
}

const chrome = spawn(CH, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/crs-tr-${PORT}`,
  `--window-size=${W},${H}`, `--force-device-scale-factor=${DPR}`, 'about:blank'], { stdio: 'ignore' });

try {
  for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch (e) { } await sleep(250); }
  const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(PAGE)}`, { method: 'PUT' });
  const t = await r.json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws')), { once: true }); });
  const send = cdp(ws);
  await send('Page.enable'); await send('Runtime.enable');
  if (EMU) await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: W < 900 });
  await sleep(1300);
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval');
    return r.result.value;
  };

  console.log('内层信息', await ev('JSON.stringify({iw:innerWidth,ih:innerHeight,dpr:devicePixelRatio})'));

  await ev(`(async () => {
    const c = document.createElement('canvas'); c.width = 1067; c.height = 1600;
    const x = c.getContext('2d'); x.fillStyle = '#3a4a5a'; x.fillRect(0, 0, 1067, 1600);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', .9));
    await addFiles([new File([blob], 'P.jpg', { type: 'image/jpeg' })]);
    await new Promise(r => setTimeout(r, 150));
    return 'photo ok';
  })()`);

  const out = await ev(`(async () => {
    const rows = [];
    const probe = (tag) => {
      const mm = (el) => el ? Math.round(el.getBoundingClientRect().height) : -1;
      const cv = document.getElementById('preview');
      rows.push([tag,
        'app=' + mm(document.querySelector('.app')),
        'main=' + mm(document.querySelector('main')),
        'stage=' + mm(document.querySelector('.stage')),
        'area=' + mm(document.getElementById('canvasArea')),
        'areaClient=' + document.getElementById('canvasArea').clientHeight,
        'cv.style=' + cv.style.height,
        'cv.attr=' + cv.height
      ].join(' '));
    };
    probe('start');
    const seq = ['minimal','bar','paper','float','film','paper','float','bar','paper','float'];
    for (let i = 0; i < ${CLICKS}; i++) {
      const id = seq[i % seq.length];
      document.querySelector('.tpl[data-tpl="' + id + '"]').click();
      await new Promise(r => setTimeout(r, 260));
      probe('c' + (i + 1) + ':' + id);
    }
    return rows.join('\\n');
  })()`);
  console.log(out);
  ws.close();
} catch (e) {
  console.log('ERR', e.message);
} finally {
  chrome.kill('SIGKILL');
}
