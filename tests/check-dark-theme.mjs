#!/usr/bin/env node
/* 主题（浅色 / 深色）的真实浏览器审计。

   为什么必须用真实浏览器：jsdom 不做布局、也不跑完整样式级联，
   「某处漏改的硬编码颜色在深色模式下变成浅底浅字」这种事它看不见。
   截图能看出来，但要人一张张盯；这里把它变成可回归的断言。

   审计规则：对每个「自己直接持有可见文字」的元素，实测「文字色 / 实际背景色」的对比度，
   达不到 WCAG AA（正文 4.5:1 / 大字号 3:1）就报出来。这条规则不关心设计意图——
   按钮反白成浅底深字没问题，浅底浅字就是 bug。

   两个细节容易被忽略，这里都处理了：
   - 背景要沿祖先链找第一个不透明层（很多文字在 --surface-2 的说明框里，比面板还暗）
   - opacity 要沿祖先链累乘，并把文字色按透明度与背景混合（刻意淡化的删除按钮就属于这类，
     它们单独归类为「静默元素」，不参与 AA 断言，只做报告）

   用法：node tests/check-dark-theme.mjs
*/

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAGE = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html')).href;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

const AUDIT = `(() => {
  const parse = (s) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(s || '');
    if (!m) return null;
    const p = m[1].split(',').map(v => parseFloat(v));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lin = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b), hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  };
  const blend = (f, b, o) => ({ r: f.r * o + b.r * (1 - o), g: f.g * o + b.g * (1 - o), b: f.b * o + b.b * (1 - o), a: 1 });

  const rootBg = parse(getComputedStyle(document.documentElement).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
  const effBg = (el) => {
    let n = el;
    while (n && n.nodeType === 1) {
      const bg = parse(getComputedStyle(n).backgroundColor);
      if (bg && bg.a > 0.5) return { r: bg.r, g: bg.g, b: bg.b, a: 1 };
      n = n.parentElement;
    }
    return rootBg;
  };
  const cumOpacity = (el) => {
    let o = 1, n = el;
    while (n && n.nodeType === 1) { o *= parseFloat(getComputedStyle(n).opacity || '1'); n = n.parentElement; }
    return o;
  };
  const label = (el) => {
    const cls = [...el.classList].slice(0, 2).join('.');
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '');
  };
  const ownText = (el) => [...el.childNodes]
    .filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();

  const items = [];
  const lightBg = [];

  // 逐组件取计算样式：用来断言「换成深色后每个组件的底色都真的变了」。
  // 任何一个组件的背景在深浅两套下相同，就说明它的颜色没走 CSS 变量（漏改的硬编码）。
  const PROBE = ['header', '.panel', '.drop', '.out-info', '.tpl', '.tpl.on', '.chip.on',
    '.chip.saved', '.btn.primary', '.btn', '.actionbar', '.thumbs', '.toast', '.zoom',
    '.thumb', '.badge', '.prog-bar', '.seg button.on', '.tabs button.on', '.icon-btn',
    '.fld input', '.row input[type=text]'];
  const cs1 = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, color: s.color, border: s.borderTopColor };
  };
  const probe = {};
  PROBE.forEach(sel => { const v = cs1(sel); if (v) probe[sel] = v; });

  document.querySelectorAll('body *').forEach(el => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const bg = effBg(el);
    if (lum(bg) > 0.5) lightBg.push(label(el));

    const t = ownText(el);
    if (!t) return;
    const r0 = el.getBoundingClientRect();
    if (r0.width < 4 || r0.height < 4) return;
    const fg0 = parse(cs.color);
    if (!fg0) return;

    const op = cumOpacity(el);
    const fg = op < 0.999 ? blend(fg0, bg, op) : fg0;
    const r = ratio(fg, bg);
    const fsz = parseFloat(cs.fontSize) || 13;
    const big = fsz >= 24 || (fsz >= 18.66 && parseInt(cs.fontWeight, 10) >= 700);
    items.push({
      label: label(el), ratio: r, need: big ? 3.0 : 4.5, op: op,
      size: fsz, text: t.slice(0, 16)
    });
  });

  return {
    theme: document.documentElement.getAttribute('data-theme'),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    bodyColor: getComputedStyle(document.body).color,
    items: items,
    probe: probe,
    lightBgSample: [...new Set(lightBg)].slice(0, 14),
    lightBgCount: lightBg.length
  };
})()`;

const fmt = (x) => x.label + ' [' + x.size + 'px] ' + x.ratio.toFixed(2) + ' < ' + x.need + ' 「' + x.text + '」';
const hard = (r) => r.items.filter(x => x.op >= 0.999 && x.ratio < x.need);
const muted = (r) => r.items.filter(x => x.op < 0.999);

const W = 1600, H = 1000, DPR = 2;
const PORT = 9500 + Math.floor(Math.random() * 400);

const chrome = spawn(CH, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/crs-theme-${PORT}`,
  `--window-size=${W},${H}`, `--force-device-scale-factor=${DPR}`, 'about:blank'], { stdio: 'ignore' });

let exitCode = 0;
try {
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { up = true; break; } } catch (e) { }
    await sleep(250);
  }
  if (!up) { console.log('浏览器没起来'); chrome.kill('SIGKILL'); process.exit(1); }

  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(PAGE)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws 连不上')), { once: true });
  });
  const send = cdp(ws);
  await send('Page.enable'); await send('Runtime.enable');
  await sleep(1400);

  const ev = async (e) => {
    const res = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'eval 出错');
    return res.result.value;
  };

  // 先导入一张照片并切到「导出」分组：否则大片控件处于隐藏状态，审计会漏掉它们
  await ev(`(async () => {
    const c = document.createElement('canvas'); c.width = 1400; c.height = 1000;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 1400, 1000);
    g.addColorStop(0, '#243040'); g.addColorStop(.5, '#b8814f'); g.addColorStop(1, '#151b22');
    x.fillStyle = g; x.fillRect(0, 0, 1400, 1000);
    const b = await new Promise(r => c.toBlob(r, 'image/jpeg', .9));
    await addFiles([new File([b], 'A.jpg', { type: 'image/jpeg' })]);
    await new Promise(r => setTimeout(r, 300));
    setTab('out');
    await new Promise(r => setTimeout(r, 300));
    return 1;
  })()`);

  /* ---------- 浅色 ---------- */
  console.log('\n浅色主题 · 真实浏览器实测');
  await ev(`document.documentElement.setAttribute('data-theme','light'); 1`);
  await sleep(400);
  const light = await ev(AUDIT);
  check('主题标记为 light', light.theme === 'light', light.theme);
  check('审计覆盖到足够多的文字元素', light.items.length > 40, light.items.length + ' 个');
  check('浅色下页面底色是亮的（对照组有效）', /rgba?\(2[0-9]{2},/.test(light.bodyBg), light.bodyBg);

  /* ---------- 深色 ---------- */
  console.log('\n深色主题 · 真实浏览器实测');
  await ev(`document.getElementById('btnTheme').click(); 1`);
  await sleep(500);
  const dark = await ev(AUDIT);
  check('点按钮后主题标记为 dark', dark.theme === 'dark', dark.theme);
  check('审计覆盖元素数与浅色一致', dark.items.length === light.items.length,
    dark.items.length + ' vs ' + light.items.length);

  const darkHard = hard(dark);
  check('深色下没有对比度不达标的正文（AA 4.5:1）', darkHard.length === 0,
    darkHard.map(fmt).join(' | ') || '全部达标');

  const darkMuted = muted(dark);
  console.log('\n  刻意淡化的元素（opacity<1，悬停才完整显现，不参与 AA 断言）');
  console.log('    ' + (darkMuted.map(x => x.label + ' ' + x.ratio.toFixed(2) + ' (opacity ' + x.op.toFixed(2) + ')').join(', ') || '（无）'));

  /* 核心回归断言：每个组件的配色都必须真的换了。
     只要有一个组件的背景色在深浅两套下完全相同，就说明它的颜色没走 CSS 变量——
     也就是「漏改的硬编码颜色」，而这正是做深色主题最容易出的问题。 */
  const TRANSPARENT = /^(rgba\(0, 0, 0, 0\)|transparent)$/;
  const sameBg = [];
  let probed = 0;
  for (const sel of Object.keys(light.probe)) {
    const a = light.probe[sel], b = dark.probe[sel];
    if (!a || !b) continue;
    if (TRANSPARENT.test(a.bg)) continue;      // 本来就没有底色的组件不参与
    probed++;
    if (a.bg === b.bg) sameBg.push(sel + ' = ' + a.bg);
  }
  check('所有带底色的组件都随主题改变（无漏改的硬编码色）',
    sameBg.length === 0 && probed >= 14,
    sameBg.join(' | ') || probed + ' 个组件全部跟随主题');

  const lumOf = (s) => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s || '');
    if (!m) return NaN;
    const lin = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    return 0.2126 * lin(+m[1]) + 0.7152 * lin(+m[2]) + 0.0722 * lin(+m[3]);
  };
  check('深色下页面底色确实变暗', lumOf(dark.bodyBg) < 0.06, dark.bodyBg);
  check('深色下文字色确实变亮', lumOf(dark.bodyColor) > 0.6, dark.bodyColor);

  console.log('\n  参考：深色下背景偏亮的元素（反白按钮属预期设计）');
  console.log('    ' + (dark.lightBgSample.join(', ') || '（无）'));

  /* ---------- 浅色既有问题的报告（不判定，供决策） ---------- */
  const lightHard = hard(light);
  if (lightHard.length) {
    console.log('\n  提示：浅色主题下存在 ' + lightHard.length + ' 处低于 AA 的文字（本次改动之前就有，未擅自修改）：');
    [...new Set(lightHard.map(x => x.label + ' ' + x.ratio.toFixed(2)))].slice(0, 8)
      .forEach(s => console.log('    · ' + s));
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  exitCode = fail ? 1 : 0;
} catch (e) {
  console.log('\n运行出错：' + e.message);
  exitCode = 1;
} finally {
  try { chrome.kill('SIGKILL'); } catch (e) { }
}
process.exit(exitCode);
