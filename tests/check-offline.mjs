#!/usr/bin/env node
/* 离线运行审计：证明页面在正常使用路径下**不发任何网络请求**。

   为什么值得单独一条：静态 grep 只能证明"源码里没写 http://"，证明不了运行时行为——
   * 某个库可能在运行时按需拉取（懒加载）
   * 某个 API 可能隐式联网（字体、地图、CDN 兜底）
   这里用 CDP 的 Network 域记录**运行时真实发出的每一个请求**，再分类断言。

   审计分两段：
   A. 正常路径（导入 JPEG → 遍历模板 → 切主题 → 导出打包）：应零外部请求。
   B. HEIC 路径（伪造一个解不开的 .heic）：会触发唯一那个条件性 CDN 依赖，
      断言它「确实被尝试」——把依赖显式记录下来，而不是假装不存在。

   用法：node tests/check-offline.mjs
*/

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = pathToFileURL(join(ROOT, 'index.html')).href;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? ' → ' + detail : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
};

/* 请求日志：CDP 事件与响应要分开处理，所以这里不能直接用只认 id 的简版封装 */
function cdpWithEvents(ws, onEvent) {
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
      return;
    }
    if (m.method && onEvent) onEvent(m.method, m.params);
  });
  return (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('timeout ' + method)); } }, 40000);
  });
}

const W = 1500, H = 1000, PORT = 9700 + Math.floor(Math.random() * 300);

const chrome = spawn(CH, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/crs-offline-${PORT}`,
  `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });

let exitCode = 0;
try {
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { up = true; break; } } catch (e) { }
    await sleep(250);
  }
  if (!up) { console.log('浏览器没起来'); chrome.kill('SIGKILL'); process.exit(1); }

  // 关键顺序：先开一个 about:blank 的标签、**开启 Network 监听**、最后才导航到目标页。
  // 若直接用 /json/new?<目标URL> 建标签，主文档请求发生在 Network.enable 之前，抓不到。
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws 连不上')), { once: true });
  });

  const reqs = [];          // 所有被发出的请求
  let phaseName = 'A';
  const send = cdpWithEvents(ws, (method, p) => {
    if (method === 'Network.requestWillBeSent') {
      reqs.push({ id: p.requestId, url: p.request.url, type: p.type, phase: phaseName });
    }
    if (method === 'Network.loadingFailed') {
      const r = reqs.find(x => x.id === p.requestId);
      if (r) r.failed = p.errorText;
    }
  });

  await send('Page.enable'); await send('Runtime.enable');
  await send('Network.enable');
  await send('Page.navigate', { url: PAGE });
  await sleep(1600);                 // 等首屏彻底加载完

  const ev = async (expr) => {
    const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'eval 出错');
    return res.result.value;
  };

  const isExternal = (u) => /^https?:/i.test(u);
  const external = (list) => list.filter(r => isExternal(r.url));

  /* ---------------- A. 正常使用路径 ---------------- */
  console.log('\nA · 正常使用路径（导入 → 模板 → 主题 → 导出打包）');

  const tplCount = await ev(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    // 1) 导入一张正常的 JPEG（走 createImageBitmap + canvas 降采样）
    const c = document.createElement('canvas'); c.width = 1600; c.height = 1200;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 1600, 1200);
    g.addColorStop(0, '#243040'); g.addColorStop(.5, '#b8814f'); g.addColorStop(1, '#151b22');
    x.fillStyle = g; x.fillRect(0, 0, 1600, 1200);
    x.fillStyle = '#fff'; x.font = '90px sans-serif'; x.fillText('OFFLINE TEST', 90, 600);
    const b = await new Promise(r => c.toBlob(r, 'image/jpeg', .92));
    await addFiles([new File([b], 'A.jpg', { type: 'image/jpeg' })]);
    await wait(800);

    // 2) 真实点击遍历所有模板
    const tpls = [...document.querySelectorAll('#tplGrid .tpl')];
    for (const el of tpls){ el.click(); await wait(70); }

    // 3) 点几个快速预设（走 buildSeg 的真实分支）
    const presets = [...document.querySelectorAll('#presetRow button')];
    for (const el of presets.slice(0, 4)){ el.click(); await wait(70); }

    // 4) 切到导出分组（导出与颜色/尺寸相关的控件此时才可见）
    const outTab = [...document.querySelectorAll('#tabs button')].find(b => /导出/.test(b.textContent));
    if (outTab) outTab.click();
    await wait(400);

    // 5) 深浅主题各切一次（会重绘整个预览）
    document.getElementById('btnTheme').click(); await wait(250);
    document.getElementById('btnTheme').click(); await wait(250);

    // 6) 导出：完整走 render → encode → 手写 ZIP32 打包
    await exportAll();
    await wait(1800);

    return { tpls: tpls.length, presets: presets.length,
             items: state.items.length, status: state.items[0] && state.items[0].status };
  })()`);

  await sleep(900);
  const phaseA = reqs.filter(r => r.phase === 'A');
  const extA = external(phaseA);

  console.log('  共记录 ' + phaseA.length + ' 个请求：');
  for (const r of phaseA) {
    const flag = isExternal(r.url) ? '外部' : '本地';
    console.log('    [' + flag + '] ' + r.type + '  ' + r.url.slice(0, 96) + (r.failed ? '  ← 失败: ' + r.failed : ''));
  }
  console.log('');

  check('导入/遍历模板/切换主题/导出打包全程走通', tplCount && tplCount.items === 1 && tplCount.status === 'ready',
    tplCount ? tplCount.tpls + ' 个模板, ' + tplCount.items + ' 张图' : '未返回');
  check('正常路径**零外部请求**', extA.length === 0, extA.length === 0 ? '0 个外部请求' : extA.map(r => r.url).join(' | '));
  check('页面主文档来自本地 file://', phaseA.some(r => /^file:\/\//.test(r.url) && r.type === 'Document'),
    (phaseA.find(r => r.type === 'Document') || {}).url);
  check('没有加载任何外部字体/样式', !phaseA.some(r => r.type === 'Font' || r.type === 'Stylesheet'),
    'Font/Stylesheet 请求数 ' + phaseA.filter(r => r.type === 'Font' || r.type === 'Stylesheet').length);

  /* ---------------- B. HEIC 路径（唯一的条件依赖） ---------------- */
  console.log('\nB · HEIC 路径（浏览器无法原生解码时才会联网）');

  phaseName = 'B';
  const heic = await ev(`(async () => {
    // 伪造一个"扩展名像 HEIC、但内容解不开"的文件：
    // 必然走 createImageBitmap 失败 → isHeic 为真 → loadScript(CDN) 这条分支
    const junk = new Uint8Array(2048);
    junk.set([0,0,0,24,0x66,0x74,0x79,0x70,0x68,0x65,0x69,0x63]);   // ftyp heic 头
    const f = new File([junk], 'broken.heic', { type: 'image/heic' });
    const before = performance.now();
    await addFiles([f]);
    await new Promise(r => setTimeout(r, 2500));
    const it = state.items[state.items.length - 1];
    return { status: it.status, error: it.error, ms: Math.round(performance.now() - before) };
  })()`);

  await sleep(1200);
  const phaseB = reqs.filter(r => r.phase === 'B');
  const extB = external(phaseB);

  console.log('  共记录 ' + phaseB.length + ' 个请求：');
  for (const r of phaseB) {
    const flag = isExternal(r.url) ? '外部' : '本地';
    console.log('    [' + flag + '] ' + r.type + '  ' + r.url.slice(0, 96) + (r.failed ? '  ← 失败: ' + r.failed : ''));
  }
  console.log('');

  check('伪造的 HEIC 被识别为错误（没有静默吞掉）', heic && heic.status === 'error', heic ? heic.status + ' / ' + heic.error : '未返回');
  check('错误提示如实告知"需联网"这一前提', heic && /联网|解码/.test(heic.error || ''), heic ? heic.error : '');
  check('确认这是唯一的外部依赖，且只在 HEIC 分支触发',
    extB.length > 0 && extB.every(r => /cdn\.jsdelivr\.net/.test(r.url)) && extB.length <= 1,
    extB.length ? extB.map(r => r.url).join(' | ') : '（本次未触发：该浏览器可能原生支持 HEIC，依赖未激活）');
  check('非 HEIC 场景下该依赖不会被加载', extA.length === 0 && !reqs.some(r => r.phase === 'A' && /jsdelivr/.test(r.url)),
    '正常路径未触碰 CDN');

  /* ---------------- C. 真正断网，验证 README 的「断网全部可用」 ---------------- */
  console.log('\nC · 模拟完全断网（CDP offline），验证「断网全部可用」');

  await send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0
  });

  phaseName = 'C';
  const beforeC = reqs.length;

  const offlineRun = await ev(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const mk = async (name, type, w, h) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d');
      x.fillStyle = '#3a6ea5'; x.fillRect(0, 0, w, h);
      x.fillStyle = '#fff'; x.font = '60px sans-serif'; x.fillText(name, 40, 120);
      const b = await new Promise(r => c.toBlob(r, type, .9));
      return new File([b], name, { type });
    };

    // 断网下依次导入三种浏览器原生支持的格式
    const base = state.items.length;          // 只核对本段新增的条目（前面几段已往列表里加过图）
    const good = ['a.jpg', 'b.png', 'c.webp'];
    for (const n of good){
      const type = n.endsWith('.png') ? 'image/png' : n.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      await addFiles([await mk(n, type, 900, 700)]);
      await wait(500);
    }

    // 每个模板点一遍 + 导出
    for (const el of [...document.querySelectorAll('#tplGrid .tpl')]){ el.click(); await wait(60); }
    document.getElementById('btnTheme').click(); await wait(200);
    document.getElementById('btnTheme').click(); await wait(200);
    const outTab = [...document.querySelectorAll('#tabs button')].find(b => /导出/.test(b.textContent));
    if (outTab) outTab.click();
    await wait(300);
    await exportAll();
    await wait(2000);

    const added = state.items.slice(base).map(i => ({ name: i.name, status: i.status, error: i.error }));
    return { added: added, ready: added.filter(s => s.status === 'ready').length, total: added.length };
  })()`);

  check('断网下三种原生格式全部导入成功',
    offlineRun && offlineRun.ready === offlineRun.total && offlineRun.total === 3,
    offlineRun ? offlineRun.added.map(s => s.name + ':' + s.status + (s.error ? '(' + s.error + ')' : '')).join(', ') : '未返回');
  check('断网下遍历模板 + 切换主题 + 导出打包全程无异常',
    !!(offlineRun && offlineRun.total === 3), '本段新增 ' + (offlineRun ? offlineRun.total : 0) + ' 张');
  check('断网期间仍未发出任何外部请求',
    external(reqs.slice(beforeC)).length === 0,
    external(reqs.slice(beforeC)).length === 0 ? '0 个' : external(reqs.slice(beforeC)).map(r => r.url).join(' | '));

  // 断网 + HEIC：这是唯一会失败的组合，必须给出诚实提示而不是静默失败
  const offHeic = await ev(`(async () => {
    const junk = new Uint8Array(1024);
    junk.set([0,0,0,24,0x66,0x74,0x79,0x70,0x68,0x65,0x69,0x63]);
    await addFiles([new File([junk], 'off.heic', { type: 'image/heic' })]);
    await new Promise(r => setTimeout(r, 1200));
    const it = state.items[state.items.length - 1];
    return { status: it.status, error: it.error };
  })()`);

  check('断网导入 HEIC 失败但不崩，且提示如实说明需要联网',
    offHeic && offHeic.status === 'error' && /联网/.test(offHeic.error || ''),
    offHeic ? offHeic.error : '未返回');

  await send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1
  });

  /* ---------------- 汇总 ---------------- */
  console.log('\n依赖结论：');
  console.log('  · 界面渲染：纯本地（系统字体，无 @font-face / @import / 外链 CSS）');
  console.log('  · 图片导入与解码：纯本地（createImageBitmap + canvas）');
  console.log('  · 边框/水印合成：纯本地');
  console.log('  · ZIP 打包：纯本地（手写 ZIP32 + CRC32，无外部库）');
  console.log('  · HEIC 解码：**唯一例外** —— 浏览器不支持时按需拉取 heic2any（约 100KB），');
  console.log('               失败会超时兜底并提示，不影响其它格式');

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) exitCode = 1;
} catch (e) {
  console.error('审计异常：' + (e && e.stack || e));
  exitCode = 1;
} finally {
  try { chrome.kill('SIGKILL'); } catch (e) { }
}

process.exit(exitCode);
