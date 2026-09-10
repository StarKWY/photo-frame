#!/usr/bin/env node
/* 真实浏览器里的布局回归：预览画布不能「点一次长一圈」。
   jsdom 里没有布局（clientWidth/Height 恒为 0），这类 bug 只有真实浏览器能抓到。

   检查三件事：
   1. 连点 12 次模板，画布 CSS 尺寸必须完全不变
   2. 预览容器 (.canvas-area) 高度必须完全不变
   3. 画布 + 容器 padding 不能超过容器本身（否则说明容器被内容反向撑大了）

   用法：node check-preview-size.mjs            # 跑全部场景
        node check-preview-size.mjs 1600 900    # 只跑一个尺寸
*/
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAGE = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html')).href;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// [宽, 高, dpr, 用 CDP 覆盖视口, 说明]
const SCENES = [
  [1600, 900, 2, false, '桌面窗口（这个场景最能暴露自我放大）'],
  [1440, 900, 2, false, '桌面窗口 · 小高度'],
  [1280, 800, 2, false, '桌面窗口 · 更小'],
  [2560, 1440, 2, false, '大屏'],
  [430, 932, 3, true, '手机竖屏'],
  [787, 1077, 2, true, '窄窗口 / 平板竖屏'],
];

const TPL_SEQ = ['minimal', 'bar', 'paper', 'float', 'film', 'paper', 'float', 'bar', 'minimal', 'paper', 'film', 'float'];

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

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? ' → ' + detail : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
};

const only = process.argv[2] ? [Number(process.argv[2]), Number(process.argv[3]), Number(process.argv[4] || 2)] : null;

for (const [W, H, DPR, EMU, label] of SCENES) {
  if (only && !(W === only[0] && H === only[1])) continue;
  const PORT = 9300 + Math.floor(Math.random() * 4000);
  const chrome = spawn(CH, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/crs-chk-${PORT}`,
    `--window-size=${W},${H}`, `--force-device-scale-factor=${DPR}`, 'about:blank'], { stdio: 'ignore' });

  console.log(`\n${W}×${H} @${DPR}x ${EMU ? '(覆盖视口)' : '(真实窗口)'} · ${label}`);
  try {
    let up = false;
    for (let i = 0; i < 80; i++) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { up = true; break; } } catch (e) { }
      await sleep(250);
    }
    if (!up) { check('浏览器启动', false, '调试端口没起来'); chrome.kill('SIGKILL'); continue; }

    const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(PAGE)}`, { method: 'PUT' });
    const t = await r.json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws 连不上')), { once: true }); });
    const send = cdp(ws);
    await send('Page.enable'); await send('Runtime.enable');
    if (EMU) await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: W < 900 });
    await sleep(1300);

    const ev = async (e) => {
      const res = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'eval 出错');
      return res.result.value;
    };

    // 一张竖幅照片：宽高比和用户实测的一致
    const ph = await ev(`(async () => {
      const c = document.createElement('canvas'); c.width = 1067; c.height = 1600;
      const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, 1067, 1600);
      g.addColorStop(0, '#233040'); g.addColorStop(.4, '#b8814f'); g.addColorStop(1, '#151b22');
      x.fillStyle = g; x.fillRect(0, 0, 1067, 1600);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', .9));
      await addFiles([new File([blob], 'P.jpg', { type: 'image/jpeg' })]);
      await new Promise(r => setTimeout(r, 180));
      return currentItem().full.width + '×' + currentItem().full.height;
    })()`);
    check('照片导入成功', !!ph, ph);

    const data = await ev(`(async () => {
      const area = document.getElementById('canvasArea');
      const cv = document.getElementById('preview');
      const cs = getComputedStyle(area);
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const measure = () => ({
        cssW: cv.style.width,
        cssH: cv.style.height,
        attrW: cv.width,
        attrH: cv.height,
        areaH: area.clientHeight,
        areaW: area.clientWidth,
        stageH: Math.round(document.querySelector('.stage').getBoundingClientRect().height),
        mainH: Math.round(document.querySelector('main').getBoundingClientRect().height),
        padY
      });
      const shots = [Object.assign(measure(), { tpl: 'init' })];
      for (const tpl of ${JSON.stringify(TPL_SEQ)}) {
        document.querySelector('.tpl[data-tpl="' + tpl + '"]').click();
        await new Promise(r => setTimeout(r, 240));
        shots.push(Object.assign(measure(), { tpl }));
      }
      return shots;
    })()`);

    const sizes = data.map(s => s.tpl + ':' + s.cssW + '×' + s.cssH);
    const areaHs = data.map(s => s.areaH);
    const canvasHs = data.map(s => s.cssH);
    const uniqArea = [...new Set(areaHs)];
    const uniqCanvasH = [...new Set(canvasHs)];

    // 同一模板重复点到时必须给出完全相同的尺寸（幂等 = 不会自我放大）
    const byTpl = {};
    for (const s of data) (byTpl[s.tpl] = byTpl[s.tpl] || []).push(s.cssW + '×' + s.cssH);
    const drift = Object.entries(byTpl).filter(([, v]) => new Set(v).size > 1);
    check('同一模板重复点击尺寸完全相同（幂等）', drift.length === 0,
      drift.length ? drift.map(([k, v]) => k + '=' + v.join('/')).join(' ; ') : sizes.join(' '));
    // 各模板比例不同，宽度受限时高度会有取整差；但绝不能一路变大（原来的 bug 是每点 +24px）
    const hNums = canvasHs.map(parseFloat);
    check('画布高度不随点击增长（仅允许取整误差）',
      Math.max(...hNums) - Math.min(...hNums) <= 2,
      Math.min(...hNums) + '~' + Math.max(...hNums) + ' (差 ' + (Math.max(...hNums) - Math.min(...hNums)) + 'px)');
    check('预览容器高度恒定', uniqArea.length === 1, uniqArea.join(' / '));
    const last = data[data.length - 1];
    check('画布没有超出容器内容盒',
      parseFloat(last.cssH) + last.padY <= last.areaH + 1,
      parseFloat(last.cssH).toFixed(0) + ' + ' + last.padY + ' ≤ ' + last.areaH);
    check('舞台高度不超过主区', last.stageH <= last.mainH + 1, last.stageH + ' ≤ ' + last.mainH);
    check('画布属性尺寸 = CSS 尺寸 × DPR',
      last.attrW === Math.round(parseFloat(last.cssW) * DPR) || last.attrW === Math.round(parseFloat(last.cssW) * Math.min(DPR, 2)),
      last.attrW + ' vs ' + last.cssW + '×' + DPR);

    ws.close();
  } catch (e) {
    check('场景执行', false, e.message);
  } finally {
    chrome.kill('SIGKILL');
  }
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
