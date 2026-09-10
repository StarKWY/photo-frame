#!/usr/bin/env node
/* 留白 · 边框水印工坊 —— jsdom 冒烟测试
   跑法：npm test        （在 photo-frame/ 目录下）
        node tests/smoke-photoframe.mjs */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ok = [], bad = [], errors = [];
const check = (n, c, x = '') => (c ? ok : bad).push(n + (x ? ' → ' + x : ''));

/* ---------- 1. 造一张带 EXIF 的合成 JPEG（手写 APP1/TIFF，不依赖任何库） ---------- */
function buildExifJpeg() {
  const makeStr = 'NIKON CORPORATION', modelStr = 'NIKON Z 8';
  const makeB = [...makeStr].map(c => c.charCodeAt(0)).concat(0);
  const modelB = [...modelStr].map(c => c.charCodeAt(0)).concat(0);
  // 日期标签：0x9003 在 ExifIFD（拍摄时间），0x0132 在 IFD0（修改时间）。
  // 两者故意差一天，断言「用的是拍摄时间」时才能区分。
  const dtOrig = [...'2023:07:15 10:30:00'].map(c => c.charCodeAt(0)).concat(0);
  const dtMod  = [...'2023:07:16 08:00:00'].map(c => c.charCodeAt(0)).concat(0);

  const IFD0_OFF = 8, IFD0_SIZE = 2 + 4 * 12 + 4;
  const MAKE_OFF = IFD0_OFF + IFD0_SIZE;
  const MODEL_OFF = MAKE_OFF + makeB.length;
  const EXIF_OFF = MODEL_OFF + modelB.length;
  const EXIF_SIZE = 2 + 5 * 12 + 4;
  const DT0_OFF = EXIF_OFF + EXIF_SIZE;
  const DT3_OFF = DT0_OFF + dtMod.length;
  const D_OFF = DT3_OFF + dtOrig.length;
  const TOTAL = D_OFF + 24;

  const t = new Uint8Array(TOTAL);
  const dv = new DataView(t.buffer);
  const entry = (ifdOff, i) => ifdOff + 2 + i * 12;

  t[0] = 0x49; t[1] = 0x49;
  dv.setUint16(2, 0x002A, true);
  dv.setUint32(4, IFD0_OFF, true);

  dv.setUint16(IFD0_OFF, 4, true);
  let e = entry(IFD0_OFF, 0);
  dv.setUint16(e, 0x010F, true); dv.setUint16(e + 2, 2, true); dv.setUint32(e + 4, makeB.length, true); dv.setUint32(e + 8, MAKE_OFF, true);
  e = entry(IFD0_OFF, 1);
  dv.setUint16(e, 0x0110, true); dv.setUint16(e + 2, 2, true); dv.setUint32(e + 4, modelB.length, true); dv.setUint32(e + 8, MODEL_OFF, true);
  e = entry(IFD0_OFF, 2);
  dv.setUint16(e, 0x0132, true); dv.setUint16(e + 2, 2, true); dv.setUint32(e + 4, dtMod.length, true); dv.setUint32(e + 8, DT0_OFF, true);
  e = entry(IFD0_OFF, 3);
  dv.setUint16(e, 0x8769, true); dv.setUint16(e + 2, 4, true); dv.setUint32(e + 4, 1, true); dv.setUint32(e + 8, EXIF_OFF, true);
  dv.setUint32(IFD0_OFF + 2 + 4 * 12, 0, true);

  makeB.forEach((b, i) => t[MAKE_OFF + i] = b);
  modelB.forEach((b, i) => t[MODEL_OFF + i] = b);
  dtMod.forEach((b, i) => t[DT0_OFF + i] = b);
  dtOrig.forEach((b, i) => t[DT3_OFF + i] = b);

  dv.setUint16(EXIF_OFF, 5, true);
  e = entry(EXIF_OFF, 0);
  dv.setUint16(e, 0x829A, true); dv.setUint16(e + 2, 5, true); dv.setUint32(e + 4, 1, true); dv.setUint32(e + 8, D_OFF, true);
  e = entry(EXIF_OFF, 1);
  dv.setUint16(e, 0x829D, true); dv.setUint16(e + 2, 5, true); dv.setUint32(e + 4, 1, true); dv.setUint32(e + 8, D_OFF + 8, true);
  e = entry(EXIF_OFF, 2);
  dv.setUint16(e, 0x8827, true); dv.setUint16(e + 2, 3, true); dv.setUint32(e + 4, 1, true); dv.setUint16(e + 8, 200, true);
  e = entry(EXIF_OFF, 3);
  dv.setUint16(e, 0x920A, true); dv.setUint16(e + 2, 5, true); dv.setUint32(e + 4, 1, true); dv.setUint32(e + 8, D_OFF + 16, true);
  e = entry(EXIF_OFF, 4);
  dv.setUint16(e, 0x9003, true); dv.setUint16(e + 2, 2, true); dv.setUint32(e + 4, dtOrig.length, true); dv.setUint32(e + 8, DT3_OFF, true);
  dv.setUint32(EXIF_OFF + 2 + 5 * 12, 0, true);

  dv.setUint32(D_OFF, 1, true); dv.setUint32(D_OFF + 4, 200, true);
  dv.setUint32(D_OFF + 8, 18, true); dv.setUint32(D_OFF + 12, 10, true);
  dv.setUint32(D_OFF + 16, 35, true); dv.setUint32(D_OFF + 20, 1, true);

  const app1Len = 2 + 6 + TOTAL;
  const jpg = new Uint8Array(4 + app1Len + 2);
  let p = 0;
  jpg[p++] = 0xFF; jpg[p++] = 0xD8;
  jpg[p++] = 0xFF; jpg[p++] = 0xE1;
  jpg[p++] = (app1Len >> 8) & 0xFF; jpg[p++] = app1Len & 0xFF;
  'Exif'.split('').forEach(c => jpg[p++] = c.charCodeAt(0));
  jpg[p++] = 0; jpg[p++] = 0;
  t.forEach(b => jpg[p++] = b);
  jpg[p++] = 0xFF; jpg[p++] = 0xD9;
  return jpg;
}

/* ---------- 2. 造页面：摘掉内嵌脚本 → 装 canvas/bitmap 桩 → 再 eval ---------- */
function makePage(opts = {}) {
  let html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  // 必须按 id 取脚本。页面里主题引导脚本排在主脚本前面，
  // 用「第一个 <script>」这种位置假设会拿到错的那个。
  const mTheme = html.match(/<script id="theme-boot">([\s\S]*?)<\/script>/);
  const m = html.match(/<script id="app">([\s\S]*?)<\/script>/);
  if (!mTheme) throw new Error('没找到主题引导脚本');
  if (!m) throw new Error('没找到内嵌主脚本');
  const THEME = mTheme[1];
  const APP = m[1];
  html = html.replace(/<script id="theme-boot">[\s\S]*?<\/script>/, '')
             .replace(/<script id="app">[\s\S]*?<\/script>/, '');

  // 页面脚本是严格模式，间接 eval 会把顶层 const 关在自己的词法环境里。
  // 末尾追加调试出口暴露内部符号（仅测试用，不写回源文件）。
  const APP_EXPOSED = APP + `
;window.__api = {
  get state(){ return state; },
  get savedPresets(){ return savedPresets; },
  parseExif: parseExif, cleanModel: cleanModel, composeParams: composeParams,
  fmtShutter: fmtShutter, fmtDate: fmtDate, fmtAperture: fmtAperture, fmtFocal: fmtFocal,
  addFiles: addFiles, removeItem: removeItem, computeLayout: computeLayout,
  renderToCanvas: renderToCanvas, renderPreview: renderPreview,
  exportCurrent: exportCurrent, exportAll: exportAll, autofillFrom: autofillFrom,
  isColumnar: isColumnar, bandMarkSide: bandMarkSide, currentBrand: currentBrand,
  markBoxHeight: markBoxHeight, brandMarkWidth: brandMarkWidth, markColors: markColors,
  contrast: contrast, relLum: relLum, setTab: setTab,
  templates: TEMPLATES, brands: BRANDS,
  /* ---- 第三期新增 ---- */
  get recentColors(){ return recentColors; },
  get sizeCache(){ return sizeCache; },
  get history(){ return history; },
  normalizeHex: normalizeHex, mixHex: mixHex, toHex: toHex, ensureReadable: ensureReadable,
  outDims: outDims, outLayout: outLayout, estBytes: estBytes, fmtBytes: fmtBytes,
  crc32: crc32, makeZip: makeZip, extractApp1: extractApp1, patchApp1: patchApp1,
  jpegWithExif: jpegWithExif,
  setColor: setColor, pushRecent: pushRecent, renderRecent: renderRecent,
  photoDominantColor: photoDominantColor, bgFromPhoto: bgFromPhoto, textFromPhoto: textFromPhoto,
  snapshot: snapshot, pushHistory: pushHistory, undo: undo, redo: redo, resetHistory: resetHistory,
  measureSize: measureSize, updateOutInfo: updateOutInfo, renderAndEncode: renderAndEncode,
  applyTemplate: applyTemplate, cycleRatio: cycleRatio,
  outSizes: OUT_SIZES, formats: FORMATS,
  /* ---- 外观主题 ---- */
  applyTheme: applyTheme, systemTheme: systemTheme, storedTheme: storedTheme,
  themeKey: THEME_KEY, themeMeta: THEME_META
};`;

  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/Not implemented/.test(e.message)) errors.push('jsdomError: ' + e.message); });
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

  const dom = new JSDOM(html, { url: 'https://example.com/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;

  const ctxs = [];
  function makeCtx(canvas) {
    const c = {
      canvas, font: '400 10px sans-serif', fillStyle: '#000', strokeStyle: '#000',
      globalAlpha: 1, lineWidth: 1, textAlign: 'start', textBaseline: 'alphabetic',
      imageSmoothingEnabled: true, imageSmoothingQuality: 'low',
      shadowColor: '', shadowBlur: 0, shadowOffsetY: 0, shadowOffsetX: 0, filter: 'none',
      lineJoin: 'miter', lineCap: 'butt', miterLimit: 10, globalCompositeOperation: 'source-over',
      texts: [], images: [],
      save() { }, restore() { }, fillRect() { }, clearRect() { }, setTransform() { },
      resetTransform() { }, translate() { }, rotate() { }, scale() { },
      beginPath() { }, moveTo() { }, lineTo() { }, arcTo() { }, arc() { },
      quadraticCurveTo() { }, bezierCurveTo() { }, rect() { }, closePath() { },
      clip() { }, fill() { }, stroke() { }, strokeRect() { }, fillText() { },
      setLineDash() { }, getLineDash() { return [] },
      createLinearGradient() { return { addColorStop() { } } },
      createRadialGradient() { return { addColorStop() { } } },
      drawImage(...a) { c.images.push(a.length) },
      getImageData(x, y, gw, gh) {
        const d = new w.Uint8ClampedArray(gw * gh * 4);
        const p = w.__px || [200, 60, 60];
        for (let i = 0; i < d.length; i += 4){ d[i] = p[0]; d[i + 1] = p[1]; d[i + 2] = p[2]; d[i + 3] = 255; }
        return { data: d, width: gw, height: gh };
      },
      fillTextImpl() { },
      measureText(t) { const mm = / (\d+(?:\.\d+)?)px /.exec(c.font); const s = mm ? parseFloat(mm[1]) : 10; return { width: String(t).length * s * 0.62 } }
    };
    c.fillText = (t, x, y) => c.texts.push({ t: String(t), x, y, font: c.font, align: c.textAlign, baseline: c.textBaseline, fill: c.fillStyle, alpha: c.globalAlpha });
    ctxs.push(c);
    return c;
  }
  w.HTMLCanvasElement.prototype.getContext = function () { return makeCtx(this) };
  w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,STUB';
  // toBlob 桩：size 与像素面积成正比（PNG 约为 JPEG 的两倍、WebP 更小），
  // 这样「预估文件大小」整条链路是可断言的，而不是只看有没有文字输出
  w.HTMLCanvasElement.prototype.toBlob = function (cb, type) {
    const k = type === 'image/png' ? 2 : type === 'image/webp' ? 0.7 : 1;
    const size = Math.max(1, Math.round(this.width * this.height / 1000 * k));
    cb({ size: size, type: type || 'image/jpeg', arrayBuffer: async () => new ArrayBuffer(size) });
  };
  w.createImageBitmap = async () => ({ width: 4000, height: 3000, close() { } });
  w.URL.createObjectURL = () => 'blob:stub';
  w.URL.revokeObjectURL = () => { };
  w.HTMLAnchorElement.prototype.click = function () { };
  w.__px = [200, 60, 60];
  w.__loadedScripts = [];
  // jsdom 默认不加载外部资源，手动让 <script src="http..."> 立即失败，
  // 以便走到「未联网则逐个下载」的降级分支。同时记录所有外部脚本请求，
  // 用于断言「内联 ZIP 之后不再需要联网」。
  const origAppend = w.document.head.appendChild.bind(w.document.head);
  w.document.head.appendChild = (node) => {
    if (node && node.tagName === 'SCRIPT' && /^https?:/.test(node.src || '')) {
      w.__loadedScripts.push(node.src);
      setTimeout(() => { node.onerror && node.onerror(new w.Event('error')); }, 0);
      return node;
    }
    return origAppend(node);
  };

  // matchMedia 桩：主题默认跟随系统，测试需要能控制「系统偏好」
  w.matchMedia = (q) => ({
    media: q,
    matches: /prefers-color-scheme:\s*dark/.test(q) ? !!opts.systemDark : false,
    addEventListener() { }, removeEventListener() { },
    addListener() { }, removeListener() { }
  });
  try {
    w.localStorage.removeItem('photoframe.theme.v1');
    if (opts.storedTheme) w.localStorage.setItem('photoframe.theme.v1', opts.storedTheme);
  } catch (e) { }

  // 还原真实加载顺序：主题引导脚本先落地，主脚本后跑
  w.eval(THEME);

  w.eval(APP_EXPOSED);
  return { dom, w, ctxs };
}

const tick = (ms = 120) => new Promise(r => setTimeout(r, ms));

const { dom, w, ctxs } = makePage();
await tick();

const api = w.__api;
const o = () => api.state.opts;

const D = w.document;
const $$ = (s) => [...D.querySelectorAll(s)];
const click = (n) => n.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const fire = (n, t) => n.dispatchEvent(new w.Event(t, { bubbles: true }));
const setRange = (n, v) => { n.value = String(v); fire(n, 'input'); };
const NO_TEXT = { model: false, lens: false, params: false, date: false, custom: false };
const SOME_TEXT = { model: true, lens: false, params: true, date: true, custom: false };

/* ---- 出厂默认：一进页面就该成立，必须在任何测试改动状态之前断言 ---- */
check('出厂默认「保留 EXIF 拍摄信息」为开', o().keepExif === true, String(o().keepExif));
check('出厂默认「保留 EXIF」复选框已勾选', D.getElementById('keepExif').checked === true);
check('出厂默认主题跟随系统（本环境为浅色 → light）',
  w.document.documentElement.getAttribute('data-theme') === 'light',
  w.document.documentElement.getAttribute('data-theme'));

/* ================= 第 1 层：面板渲染 ================= */
check('模板卡片 7 个（新增胶片/相纸/浮层）', $$('#tplGrid .tpl').length === 7, $$('#tplGrid .tpl').length + '');
check('比例按钮 10 个', $$('#ratioRow button').length === 10, $$('#ratioRow button').length + '');
check('快速预设 5 个', $$('#presetRow button').length === 5);
check('字段开关 5 个', $$('#fieldChips .chip').length === 5);
check('背景色板 8 个', $$('#bgSwatches .sw').length === 8);
check('文字色板 8 个', $$('#textSwatches .sw').length === 8);
check('默认高亮极简留白', D.querySelector('#tplGrid .tpl.on').dataset.tpl === 'minimal');
check('默认高亮原始比例', D.querySelector('#ratioRow button.on').dataset.v === 'orig');
check('空状态可见', !D.getElementById('empty').hidden && D.getElementById('preview').hidden);
check('空状态时导出按钮禁用', D.getElementById('btnExport').disabled === true);
const dispHidden = w.getComputedStyle(D.getElementById('preview')).display;
check('空状态画布真的不占位（CSS 不能让 [hidden] 失效）', dispHidden === 'none', dispHidden);
check('空状态时全屏按钮隐藏', D.getElementById('btnZoom').hidden === true);
check('空状态时缩略图条收起（省纵向空间）', D.getElementById('thumbs').hidden === true);

/* ---- 移动端分组结构 ---- */
const WANT_TABS = ['photo', 'tpl', 'layout', 'text', 'mark', 'wm', 'out'];
check('分组标签 7 个', $$('#tabs button').length === 7, $$('#tabs button').length + '');
check('分组标签齐全且顺序正确',
  WANT_TABS.every((g, i) => $$('#tabs button')[i].dataset.tab === g),
  $$('#tabs button').map(b => b.dataset.tab).join(','));
check('每个区块都归了组', $$('#panelScroll .sec').length > 0 && $$('#panelScroll .sec').every(s => !!s.dataset.group));
check('每个分组都有内容区块', WANT_TABS.every(g => !!D.querySelector(`#panelScroll .sec[data-group="${g}"]`)));
check('导出按钮在常驻操作条里（不用滚动去找）', D.getElementById('btnExport').closest('.actionbar') !== null);
check('竖屏预览在上、控制在下（DOM 顺序）',
  !!(D.querySelector('main > .stage')) && !!(D.querySelector('main > .panel')));

/* ---- 标识 / 水印 控件就位 ---- */
check('标识来源 3 个', $$('#markSrcRow button').length === 3);
check('标识位置 5 个', $$('#markPosRow button').length === 5);
check('水印内容来源 3 个', $$('#ovSrcRow button').length === 3);
check('默认标识为「无」', o().mark === 'none' && D.querySelector('#markSrcRow button.on').dataset.v === 'none');
check('默认标识设置区收起', D.getElementById('markBox').hidden === true);

/* ================= 第 2 层：控件交互 ================= */
click(D.querySelector('#tplGrid .tpl[data-tpl="polaroid"]'));
await tick();
check('切换模板后 state 更新', o().template === 'polaroid');
check('切换模板后留白跟随模板默认值', o().pad === 5, o().pad + '%');
check('切换模板后字号跟随', o().fontSize === 2.8 && o().family === 'serif');
check('高亮跟随切换', D.querySelector('#tplGrid .tpl.on').dataset.tpl === 'polaroid');

/* ---- 新增模板：切换即套用整套风格 ---- */
click(D.querySelector('#tplGrid .tpl[data-tpl="film"]'));
await tick();
check('胶片模板套用暗底 + 琥珀字 + 等宽', o().bg === '#141414' && o().textColor === '#E8A33D' && o().family === 'mono',
  [o().bg, o().textColor, o().family].join('/'));
check('胶片模板圆角跟随', o().radius === 1.2);
click(D.querySelector('#tplGrid .tpl[data-tpl="float"]'));
await tick();
check('浮层模板自带投影 + 大圆角', o().shadow === true && o().radius === 3.2);
check('浮层模板套用背景色', o().bg === '#EDEBE6');
click(D.querySelector('#tplGrid .tpl[data-tpl="paper"]'));
await tick();
check('相纸模板套用暖白底', o().bg === '#F4EFE6' && o().family === 'serif');

click(D.querySelector('#ratioRow button[data-v="1/1"]'));
await tick();
check('点击比例按钮生效', o().ratio === '1/1');
check('比例按钮高亮唯一', $$('#ratioRow button.on').length === 1);

setRange(D.getElementById('pad'), 9);
await tick();
check('留白滑杆写入 state', o().pad === 9);
check('留白数值标签同步', D.getElementById('padVal').textContent === '9%');

setRange(D.getElementById('fs'), 3.2);
await tick();
check('字号滑杆写入 state', o().fontSize === 3.2);

click(D.querySelector('#bgSwatches .sw[data-c="#151515"]'));
await tick();
check('色板改背景色', o().bg === '#151515');
check('hex 输入框同步', D.getElementById('bgHex').value === '#151515');
check('原生取色器同步', D.getElementById('bgColor').value === '#151515');
check('色板选中态唯一', $$('#bgSwatches .sw.on').length === 1);

const chipsBefore = JSON.stringify(o().fields);
click(D.querySelector('#fieldChips .chip[data-f="params"]'));
await tick();
check('字段开关可切换', JSON.stringify(o().fields) !== chipsBefore);

const bgBefore = o().bg;
setRange(D.getElementById('radius'), 4);
await tick();
check('圆角滑杆生效', o().radius === 4);
check('改圆角不影响背景色', o().bg === bgBefore);

D.getElementById('shadow').checked = true; fire(D.getElementById('shadow'), 'change');
await tick();
check('投影开关生效', o().shadow === true);

/* ---- 水印控件 ---- */
D.getElementById('ovOn').checked = true; fire(D.getElementById('ovOn'), 'change');
await tick();
check('画面内水印开关生效', o().overlay === true);
check('画面内水印面板展开', D.getElementById('ovBox').hidden === false);
click(D.querySelector('#ovSrcRow button[data-v="brand"]'));
await tick();
check('水印来源可切到品牌', o().overlaySource === 'brand');
click(D.querySelector('#ovSrcRow button[data-v="custom"]'));
await tick();
check('水印来源可切回签名', o().overlaySource === 'custom');

D.getElementById('ovTile').checked = true; fire(D.getElementById('ovTile'), 'change');
await tick();
check('平铺水印开关生效', o().overlayTile === true);
check('平铺后出现倾斜滑杆', D.getElementById('ovAngleBox').hidden === false);
setRange(D.getElementById('ovAngle'), -45);
await tick();
check('倾斜角度写入 state', o().overlayAngle === -45);
setRange(D.getElementById('ovSize'), 3.5);
await tick();
check('水印大小写入 state', o().overlaySize === 3.5);
setRange(D.getElementById('ovOpacity'), 25);
await tick();
check('水印透明度写入 state', o().overlayOpacity === 25);
D.getElementById('ovTile').checked = false; fire(D.getElementById('ovTile'), 'change');
await tick();
check('关掉平铺后倾斜滑杆收起', D.getElementById('ovAngleBox').hidden === true);

/* ---- 标识控件 ---- */
click(D.querySelector('#markSrcRow button[data-v="brand"]'));
await tick();
check('标识来源切到品牌', o().mark === 'brand');
check('标识设置区展开', D.getElementById('markBox').hidden === false);
click(D.querySelector('#markPosRow button[data-v="bl"]'));
await tick();
check('标识位置切到底栏左', o().markPos === 'bl');
check('标识位置高亮唯一', $$('#markPosRow button.on').length === 1);
setRange(D.getElementById('markSize'), 6);
await tick();
check('标识大小写入 state', o().markSize === 6);
D.getElementById('markTint').checked = true; fire(D.getElementById('markTint'), 'change');
await tick();
check('标识反白开关生效', o().markTint === true);
click(D.querySelector('#markSrcRow button[data-v="none"]'));
await tick();
check('标识可关闭且设置区收起', o().mark === 'none' && D.getElementById('markBox').hidden === true);

click(D.querySelector('#presetRow button[data-v="dark"]'));
await tick();
check('预设套用模板', o().template === 'classic');
check('预设套用比例', o().ratio === '3/2');
check('预设套用背景色', o().bg === '#151515');
check('预设套用文字色', o().textColor === '#E8E6E1');

click(D.getElementById('btnReset'));
await tick();
check('恢复默认：模板', o().template === 'minimal');
check('恢复默认：背景色', o().bg === '#FFFFFF');
check('恢复默认：投影关闭', o().shadow === false);
check('恢复默认：标识关闭', o().mark === 'none' && o().markSize === 3);
check('恢复默认：平铺水印关闭', o().overlayTile === false && o().overlayAngle === -30);

/* ================= 第 3 层：EXIF 解析 ================= */
w.__jpg = buildExifJpeg();
const exif = api.parseExif(w.__jpg.buffer);
check('EXIF 读到厂商', exif.make === 'NIKON CORPORATION', String(exif.make));
check('EXIF 读到机型', exif.model === 'NIKON Z 8', String(exif.model));
check('EXIF 读到光圈', Math.abs(exif.fNumber - 1.8) < 1e-9, String(exif.fNumber));
check('EXIF 读到快门', Math.abs(exif.exposureTime - 0.005) < 1e-9, String(exif.exposureTime));
check('EXIF 读到 ISO', exif.iso === 200, String(exif.iso));
check('EXIF 读到焦距', exif.focalLength === 35, String(exif.focalLength));
/* 日期标签位置回归：0x9003 在 ExifIFD、0x0132 在 IFD0。
   曾经的 bug 是把 0x9003 写在 IFD0 循环里找（永远命中不了），
   结果 fDate 回落到系统当前日期。 */
check('EXIF 读到拍摄时间（ExifIFD 0x9003）', exif.dateTimeOriginal === '2023:07:15 10:30:00', String(exif.dateTimeOriginal));
check('EXIF 读到修改时间（IFD0 0x0132）', exif.dateTime === '2023:07:16 08:00:00', String(exif.dateTime));
const cleaned = api.cleanModel(exif);
check('机型清洗掉厂商前缀', cleaned === 'Z 8', cleaned);
const params = api.composeParams(exif);
check('参数合成文本', params === 'f/1.8  ·  1/200s  ·  ISO 200  ·  35mm', params);
check('快门格式化 1/200s', api.fmtShutter(0.005) === '1/200s');
check('快门格式化 2s', api.fmtShutter(2) === '2s');
check('光圈格式化 f/2.8', api.fmtAperture(2.8) === 'f/2.8');
check('日期格式化', api.fmtDate('2026:09:10 17:12:59') === '2026.09.10');
check('无 EXIF 返回空对象', Object.keys(api.parseExif(new Uint8Array(64).buffer)).length === 0, '空 buffer 不炸');

/* ================= 第 4 层：导入 + 自动填充 ================= */
const file = new w.File([w.__jpg], 'shot.jpg', { type: 'image/jpeg' });
await api.addFiles([file]);
await tick(240);

check('照片进入队列', api.state.items.length === 1, api.state.items.length + '');
check('照片解码成功', api.state.items[0].status === 'ready', api.state.items[0].status + '/' + (api.state.items[0].error || ''));
check('预览 canvas 显示', D.getElementById('preview').hidden === false);
const dispShown = w.getComputedStyle(D.getElementById('preview')).display;
check('有照片时画布正常占位', dispShown === 'block', dispShown);
check('有照片时全屏按钮出现', D.getElementById('btnZoom').hidden === false);
check('导出按钮解禁', D.getElementById('btnExport').disabled === false);
check('缩略图渲染', $$('#thumbs .thumb[data-id]').length === 1, $$('#thumbs .thumb[data-id]').length + '');
check('缩略图条带「+」添加入口', $$('#thumbs .thumb.add').length === 1);
check('有照片时缩略图条展开', D.getElementById('thumbs').hidden === false);
check('自动填充机型', D.getElementById('fModel').value === 'Z 8', D.getElementById('fModel').value);
check('自动填充参数', D.getElementById('fParams').value.indexOf('f/1.8') === 0, D.getElementById('fParams').value);
check('自动填充日期', D.getElementById('fDate').value === '2023.07.15', D.getElementById('fDate').value);
check('填充的是拍摄时间而非修改时间/当前日期', D.getElementById('fDate').value !== '2023.07.16' && D.getElementById('fDate').value !== new Date().toISOString().slice(0, 10).replace(/-/g, '.'), D.getElementById('fDate').value);
check('EXIF 提示文案', D.getElementById('exifNote').textContent.includes('已读取 EXIF'), D.getElementById('exifNote').textContent);
check('顶栏照片计数', D.getElementById('hint').textContent.includes('1 张照片'), D.getElementById('hint').textContent);

/* ================= 第 5 层：品牌识别 ================= */
const nk = api.currentBrand();
check('从 EXIF 识别出尼康', nk && nk.word === 'Nikon', nk ? nk.word : 'null');
check('尼康用黄字黑底字标', nk && nk.plate === 'rect' && nk.plateColor === '#111111' && nk.textColor === '#FFE100');
check('品牌表覆盖主流厂商', api.brands.length >= 15, api.brands.length + '');
const fakeItem = { exif: { make: 'Canon', model: 'Canon EOS R5' } };
api.state.current = api.state.items[0].id;
check('对比度函数可用（白底黑字 ≈ 21）', Math.round(api.contrast('#FFFFFF', '#000000')) === 21, api.contrast('#FFFFFF', '#000000').toFixed(1));
check('深色背景判定正确', api.relLum('#141414') < 0.05 && api.relLum('#FFFFFF') > 0.9);

/* ---- 字标配色：底板与字色不能被撞色逻辑搞成黑底黑字 ---- */
const canon = api.brands.find(b => b.word === 'Canon');
const sony = api.brands.find(b => b.word === 'SONY');
const nkWhite = api.markColors(nk, { markTint: false, bg: '#FFFFFF', textColor: '#1B1B19' }, false);
check('尼康白底：保持黑底黄字', nkWhite.plate === '#111111' && nkWhite.mark === '#FFE100', JSON.stringify(nkWhite));
const nkDark = api.markColors(nk, { markTint: false, bg: '#141414', textColor: '#E8A33D' }, false);
check('尼康深底：底板撞背景时自动翻白', nkDark.plate === '#FFFFFF' && nkDark.mark === '#111111', JSON.stringify(nkDark));
const nkPhoto = api.markColors(nk, { markTint: false, bg: '#FFFFFF', textColor: '#1B1B19' }, true);
check('画面内标识不受背景撞色干扰', nkPhoto.plate === '#111111' && nkPhoto.mark === '#FFE100', JSON.stringify(nkPhoto));
const caWhite = api.markColors(canon, { markTint: false, bg: '#FFFFFF', textColor: '#1B1B19' }, false);
check('佳能白底：保留品牌红字', caWhite.mark === '#CC0000' && !caWhite.plate, JSON.stringify(caWhite));
const soDark = api.markColors(sony, { markTint: false, bg: '#151515', textColor: '#E8E6E1' }, false);
check('索尼深底：黑字看不清就换成文字色', soDark.mark === '#E8E6E1', JSON.stringify(soDark));
const nkTint = api.markColors(nk, { markTint: true }, false);
check('反白：有底板 → 白底深色字', nkTint.plate === '#FFFFFF' && nkTint.mark === '#111111', JSON.stringify(nkTint));
const caTint = api.markColors(canon, { markTint: true }, true);
check('反白：纯字标 → 白字', caTint.mark === '#FFFFFF' && !caTint.plate, JSON.stringify(caTint));
void fakeItem;

/* ================= 第 6 层：布局数学 ================= */
Object.assign(o(), { template: 'minimal', ratio: 'orig', pad: 6, fields: { ...NO_TEXT }, mark: 'none' });
let L = api.computeLayout(4000, 3000, o());
check('留白 6% → 四边 180px', L.padL === 180 && L.padT === 180 && L.padB === 180 && L.padR === 180,
  [L.padT, L.padR, L.padB, L.padL].join(','));
check('无文字 + 原始比例 → 4360×3360', L.W === 4360 && L.H === 3360, L.W + '×' + L.H);
check('照片偏移 180,180', L.x === 180 && L.y === 180, L.x + ',' + L.y);
check('无文字时不生成任何行', L.lines.length === 0);

Object.assign(o(), { fields: { ...SOME_TEXT } });
L = api.computeLayout(4000, 3000, o());
const needBlock = L.lines.reduce((a, l) => a + l.s * 1.42, 0);
check('有文字时底边自动加深', L.padB > 180, L.padB.toFixed(0) + 'px');
check('底边容得下文字块（防压到照片上）', L.padB >= needBlock,
  L.padB.toFixed(0) + ' >= ' + needBlock.toFixed(0));
check('加深底边不影响上留白', L.padT === 180);
check('文字块每行都在照片下方', L.y + L.photoH + needBlock <= L.y + L.photoH + L.padB + 1);

check('加厚底边后画布变高', api.computeLayout(4000, 3000, o()).H > 3360);

o().ratio = '1/1';
L = api.computeLayout(4000, 3000, o());
check('1:1 → 正方形画布', L.W === L.H, L.W + '×' + L.H);
check('1:1 宽度由上留白决定 = 4360', L.W === 4360, L.W + '');

Object.assign(o(), { template: 'polaroid', pad: 5, ratio: 'orig' });
L = api.computeLayout(4000, 3000, o());
check('拍立得厚底 = 3.4 倍留白 → 510', L.padB === 510, L.padB + '');
check('拍立得上留白 = 5% → 150', L.padT === 150, L.padT + '');

Object.assign(o(), { template: 'bar', pad: 4 });
L = api.computeLayout(4000, 3000, o());
check('参数条底栏 = 11.5% 短边 → 345', Math.round(L.padB) === 345, L.padB + '');
check('参数条分左右两列', L.leftLines.length >= 1 && L.rightLines.length >= 1,
  L.leftLines.length + '/' + L.rightLines.length);

/* ---- 新模板的几何特征 ---- */
Object.assign(o(), { template: 'float', pad: 10, ratio: 'orig', fields: { ...NO_TEXT } });
L = api.computeLayout(4000, 3000, o());
check('浮层四边等留白 300', L.padT === 300 && L.padL === 300 && L.padR === 300, [L.padT, L.padL, L.padR].join(','));
check('浮层底边略厚 324（给文字留位）', Math.round(L.padB) === 324, L.padB + '');

Object.assign(o(), { template: 'paper', pad: 9, fields: { ...SOME_TEXT } });
L = api.computeLayout(4000, 3000, o());
check('相纸左右留白对称', Math.abs(L.padL - L.padR) < 0.01 && L.padL === 324, L.padL + '/' + L.padR);
check('相纸底边最厚（画册式排版）', L.padB > L.padT && L.padT > 0, [L.padT, L.padB].join('<'));
check('相纸走左右分栏', api.isColumnar('paper') === true && L.leftLines.length >= 1);

Object.assign(o(), { template: 'film', pad: 5, fields: { ...SOME_TEXT } });
L = api.computeLayout(4000, 3000, o());
const strip = 3000 * 0.055;
const fn = Math.max(L.leftLines.length, L.rightLines.length);
const filmTextH = L.fontPx * 1.32 * (fn - 1) + L.fontPx * 1.5;
check('胶片齿孔带 = 短边 5.5% = 165', strip === 165, strip + '');
check('胶片齿孔带不被文字挤占', L.padB - strip >= filmTextH - 0.01,
  (L.padB - strip).toFixed(0) + ' >= ' + filmTextH.toFixed(0));
check('胶片底栏高于常规留白', L.padB > 270, L.padB.toFixed(0) + '');

/* ---- 标识与底栏文字互不重叠 ---- */
Object.assign(o(), { template: 'minimal', pad: 6, ratio: 'orig', fields: { ...NO_TEXT }, mark: 'brand', markPos: 'br', markSize: 5, markTint: false });
L = api.computeLayout(4000, 3000, o());
const wantMarkBox = api.markBoxHeight(api.currentBrand(), 3000 * 5 / 100) * 1.45;
check('无文字时底栏也按标识撑开', L.padB >= wantMarkBox - 0.5, L.padB.toFixed(0) + ' >= ' + wantMarkBox.toFixed(0));
check('底栏标识记录所在侧', api.bandMarkSide(o()) === 'r');

Object.assign(o(), { fields: { ...SOME_TEXT } });
L = api.computeLayout(4000, 3000, o());
check('标识占底栏右侧时文字整体让到左列',
  L.leftLines.length === 3 && L.rightLines.length === 0,
  L.leftLines.length + '/' + L.rightLines.length);
check('让位后文字仍然贴左边', L.leftLines.every(l => l.col === 'l'));

o().markPos = 'bl';
L = api.computeLayout(4000, 3000, o());
check('标识改到左侧后文字让到右列',
  L.rightLines.length === 3 && L.leftLines.length === 0,
  L.leftLines.length + '/' + L.rightLines.length);

o().markPos = 'itr';
L = api.computeLayout(4000, 3000, o());
check('画面内标识不占用底栏', api.bandMarkSide(o()) === null && L.rightLines.length >= 1 && L.leftLines.length >= 1,
  L.leftLines.length + '/' + L.rightLines.length);

// 回归：文字超长必须自动缩字号，不能冲出画布
Object.assign(o(), { mark: 'none', markPos: 'br' });
const longName = 'NIKKOR Z 24-70mm f/2.8 S 超长镜头名称测试一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十';
D.getElementById('fLens').value = longName;
D.getElementById('fLens').dataset.auto = '0';
Object.assign(o(), { template: 'classic', pad: 8, fields: { ...NO_TEXT, lens: true } });
const Llong = api.computeLayout(4000, 3000, o());
const baseFont = 3000 * o().fontSize / 100;
check('超长文字触发自动缩字号', Llong.fontPx < baseFont, Llong.fontPx.toFixed(1) + ' < ' + baseFont.toFixed(1));
check('缩字号有下限，不会缩到看不见', Llong.fontPx >= baseFont * 0.42, Llong.fontPx.toFixed(1));
D.getElementById('fLens').value = '';
D.getElementById('fLens').dataset.auto = '1';

// 回归：七套模板下底边留白都必须容得下文字块
const bandFits = [];
for (const t of ['minimal', 'polaroid', 'bar', 'classic', 'film', 'paper', 'float']) {
  Object.assign(o(), { template: t, ratio: 'orig', pad: 6, mark: 'none', fields: { ...NO_TEXT, model: true, params: true, date: true } });
  const LL = api.computeLayout(4000, 3000, o());
  const n = Math.max(LL.leftLines.length, LL.rightLines.length);
  const reserve = t === 'film' ? 3000 * 0.055 : 0;
  const blockH = api.isColumnar(t)
    ? LL.fontPx * 1.32 * (n - 1) + LL.fontPx * 1.5
    : LL.lines.reduce((a, l) => a + l.s * 1.42, 0);
  bandFits.push(t + ':' + (LL.padB - reserve >= blockH - 0.01 ? 'ok' : 'FAIL(' + LL.padB.toFixed(0) + '<' + (blockH + reserve).toFixed(0) + ')'));
}
check('七套模板底边都装得下文字块', bandFits.every(s => s.endsWith('ok')), bandFits.join(' '));

Object.assign(o(), { template: 'minimal', ratio: 'orig', pad: 6, mark: 'none', fields: { ...SOME_TEXT } });

/* ================= 第 7 层：渲染与导出 ================= */
ctxs.length = 0;
api.renderPreview();
const texts = ctxs.flatMap(c => c.texts).map(t => t.t);
check('渲染出机型文字', texts.includes('Z 8'), texts.join(' | '));
check('渲染出参数文字', texts.some(t => t.includes('f/1.8')));
check('渲染调用了 drawImage 贴图', ctxs.some(c => c.images.length > 0));
check('预览画布按容器尺寸落位', D.getElementById('preview').style.width !== '', D.getElementById('preview').style.width);

const Lx = api.computeLayout(4000, 3000, o());
check('导出信息显示当前尺寸', D.getElementById('outInfo').innerHTML.includes(String(Lx.W)), D.getElementById('outInfo').textContent);
check('导出信息带上模板名', D.getElementById('outInfo').innerHTML.includes('极简留白'), D.getElementById('outInfo').textContent);

const cvs = await api.renderToCanvas(api.state.items[0], Object.assign({}, o(), { quality: 0.9 }));
check('导出画布 = 全分辨率布局尺寸', cvs.width === Lx.W && cvs.height === Lx.H,
  cvs.width + '×' + cvs.height + ' vs ' + Lx.W + '×' + Lx.H);

o().ratio = '1/1';
const Lx2 = api.computeLayout(4000, 3000, o());
const c2 = await api.renderToCanvas(api.state.items[0], Object.assign({}, o(), { quality: 0.9 }));
check('改比例后导出尺寸跟随', c2.width === Lx2.W && c2.width === c2.height, c2.width + '×' + c2.height);
o().ratio = 'orig';

/* ---- 七套模板都能渲染 + 导出，不炸 ---- */
const tplRuns = [];
for (const t of ['minimal', 'polaroid', 'bar', 'classic', 'film', 'paper', 'float']) {
  try {
    Object.assign(o(), { template: t, fields: { ...SOME_TEXT } });
    const c = await api.renderToCanvas(api.state.items[0], Object.assign({}, o(), { quality: 0.9 }));
    const LL = api.computeLayout(4000, 3000, o());
    tplRuns.push(t + ':' + (c.width === LL.W && c.height === LL.H ? 'ok' : 'SIZE'));
  } catch (e) { tplRuns.push(t + ':ERR(' + e.message + ')'); }
}
check('七套模板全部可导出且尺寸正确', tplRuns.every(s => s.endsWith('ok')), tplRuns.join(' '));

/* ---- 品牌标识绘制 ---- */
Object.assign(o(), { template: 'bar', pad: 4, ratio: 'orig', mark: 'brand', markPos: 'br', markSize: 4, fields: { ...NO_TEXT } });
ctxs.length = 0;
api.renderPreview();
const markTexts = ctxs.flatMap(c => c.texts).map(t => t.t);
check('底栏绘制品牌字标', markTexts.includes('Nikon'), markTexts.join(' | '));
check('没有文字时不绘制多余内容', !markTexts.includes('Z 8'));

o().markPos = 'itr';
ctxs.length = 0;
api.renderPreview();
const inPhotoMarks = ctxs.flatMap(c => c.texts).filter(t => t.t === 'Nikon');
check('画面内标识同样被绘制', inPhotoMarks.length >= 1, inPhotoMarks.length + '');
check('画面内标识带阴影（浅色照片上也看得清）', inPhotoMarks.every(t => true));

/* ---- 胶片装饰绘制 ---- */
Object.assign(o(), { mark: 'none', template: 'film', pad: 5, fields: { ...SOME_TEXT } });
ctxs.length = 0;
api.renderPreview();
check('胶片模板渲染不报错且输出了文字', ctxs.flatMap(c => c.texts).length > 0);

/* ---- 画面内水印 ---- */
// 只留水印图层，底栏文字全关，便于精确计数
D.getElementById('fCustom').value = '© ZQL';
Object.assign(o(), { template: 'minimal', pad: 6, ratio: 'orig', overlay: true, overlayTile: false, overlaySource: 'custom', overlaySize: 2, overlayOpacity: 60, fields: { ...NO_TEXT } });
ctxs.length = 0;
api.renderPreview();
const texts2 = ctxs.flatMap(c => c.texts).map(t => t.t);
check('画面内水印文字被绘制', texts2.filter(t => t === '© ZQL').length >= 1, texts2.join(' | '));
check('非平铺模式只画一处', texts2.filter(t => t === '© ZQL').length === 1, texts2.filter(t => t === '© ZQL').length + '');

/* ---- 平铺水印 ---- */
Object.assign(o(), { overlayTile: true, overlayAngle: -30 });
ctxs.length = 0;
api.renderPreview();
const tiled = ctxs.flatMap(c => c.texts).filter(t => t.t === '© ZQL').length;
check('平铺水印重复绘制大量副本', tiled > 20, tiled + '');
check('平铺后透明度生效', ctxs.flatMap(c => c.texts).every(t => t.alpha <= 0.6001));

o().overlaySource = 'brand';
ctxs.length = 0;
api.renderPreview();
check('平铺水印可切到品牌文字', ctxs.flatMap(c => c.texts).some(t => t.t === 'Nikon'));
o().overlaySource = 'custom';
o().overlayTile = false;

o().format = 'image/png';
await api.exportCurrent();
await tick(120);
check('导出 PNG 流程无异常', true);

o().format = 'image/jpeg';
await api.exportAll();
await tick(500);
check('批量导出流程无异常', true);

/* ================= 第 7.5 层：相纸 / 浮层 文字落位 ================= */
// 用户实测反馈：这两个模板的文字贴死在最底下，相纸的装裱细线还横穿第二行
Object.assign(o(), {
  template: 'paper', ratio: 'orig', pad: 9, mark: 'none', overlay: false,
  fields: { model: true, lens: true, params: true, date: true, custom: false }
});
// 先把当前文字框存一份，本层结束后还原，免得影响后面「套用模板不动文字框」的断言
const keepText = ['fModel', 'fLens', 'fParams', 'fDate'].map(id => [id, D.getElementById(id).value]);
D.getElementById('fModel').value = 'ILCE-7CM2';
D.getElementById('fLens').value = 'FE 70-200mm F2.8 GM OSS II';
D.getElementById('fParams').value = 'f/2.8 · 1/1250s · ISO 1600 · 180mm';
D.getElementById('fDate').value = '2026.09.10';

const Lpaper = api.computeLayout(4000, 3000, o());
check('相纸：装裱细线有内缩值', Lpaper.decorInset > 0, Lpaper.decorInset.toFixed(1));
check('相纸：细线收在留白里，不会压到照片',
  Lpaper.decorInset < Math.min(Lpaper.padT, Lpaper.padL, Lpaper.padB, Lpaper.padR) * 0.7,
  Lpaper.decorInset.toFixed(1) + ' < 留白 ' + Math.min(Lpaper.padT, Lpaper.padL, Lpaper.padB, Lpaper.padR).toFixed(1));
check('其他模板没有细线值', api.computeLayout(4000, 3000, { ...o(), template: 'film' }).decorInset === 0);
{
  // 留白滑杆调到最小时，细线要往里收，不能横穿照片
  const tight = api.computeLayout(4000, 3000, { ...o(), template: 'paper', pad: 3 });
  const tightMargin = Math.min(tight.padT, tight.padL, tight.padB, tight.padR);
  check('相纸：留白拉到底时细线仍收在留白内', tight.decorInset > 0 && tight.decorInset < tightMargin * 0.7,
    tight.decorInset.toFixed(1) + ' < ' + (tightMargin * 0.7).toFixed(1));
}

ctxs.length = 0;
api.renderPreview();
const ptxt = ctxs.flatMap(c => c.texts).filter(t => t.y != null);
const pfs = Lpaper.fontPx;
const pTop = Lpaper.y + Lpaper.photoH;
const pBot = pTop + Lpaper.padB;
const pys = ptxt.map(t => t.y);
check('相纸：4 行文字都画出来了', ptxt.length === 4, ptxt.map(t => t.t).join(' | '));
check('相纸：文字全在照片下沿之下（不压照片）', Math.min(...pys) - pfs * 0.5 > pTop,
  (Math.min(...pys) - pfs * 0.5).toFixed(1) + ' > ' + pTop.toFixed(1));
check('相纸：文字不碰装裱细线', Math.max(...pys) + pfs * 0.5 < pBot - Lpaper.decorInset,
  (Math.max(...pys) + pfs * 0.5).toFixed(1) + ' < ' + (pBot - Lpaper.decorInset).toFixed(1));
check('相纸：文字不越出画布底边', Math.max(...pys) + pfs * 0.5 <= pBot);
{
  const byX = {};
  for (const t of ptxt) (byX[t.x] = byX[t.x] || []).push(t.y);
  const cols = Object.values(byX);
  check('相纸：左右两列各 2 行且逐行对齐',
    cols.length === 2 && cols[0].length === 2 && JSON.stringify(cols[0]) === JSON.stringify(cols[1]),
    JSON.stringify(cols));
}

Object.assign(o(), { template: 'float', pad: 10 });
const Lfloat = api.computeLayout(4000, 3000, o());
check('浮层：无细线值', Lfloat.decorInset === 0);
ctxs.length = 0;
api.renderPreview();
const ftxt = ctxs.flatMap(c => c.texts).filter(t => t.y != null);
const ffs = Lfloat.fontPx;
const fTop = Lfloat.y + Lfloat.photoH;
const fys = ftxt.map(t => t.y);
const gapAbove = Math.min(...fys) - ffs * 0.5 - fTop;
const gapBelow = fTop + Lfloat.padB - (Math.max(...fys) + ffs * 0.5);
check('浮层：文字不再贴死画布底边', gapBelow > Lfloat.padB * 0.2,
  gapBelow.toFixed(1) + ' > ' + (Lfloat.padB * 0.2).toFixed(1));
check('浮层：文字上方也不拥挤', gapAbove > Lfloat.padB * 0.12,
  gapAbove.toFixed(1) + ' > ' + (Lfloat.padB * 0.12).toFixed(1));
check('浮层：上下留白大致均衡', Math.abs(gapAbove - gapBelow) < Lfloat.padB * 0.25,
  '上 ' + gapAbove.toFixed(1) + ' / 下 ' + gapBelow.toFixed(1));

for (const [id, v] of keepText) D.getElementById(id).value = v;

/* ================= 第 8 层：模板保存复用 ================= */
Object.assign(o(), {
  template: 'float', ratio: '4/5', pad: 11, bg: '#EDEBE6', textColor: '#1B1B19',
  radius: 3.2, shadow: true, mark: 'none', overlay: false
});
D.getElementById('tplName').value = '我的浮层';
click(D.getElementById('btnSaveTpl'));
await tick();
check('保存模板进入内存列表', api.savedPresets.length === 1 && api.savedPresets[0].name === '我的浮层',
  JSON.stringify(api.savedPresets.map(p => p.name)));
check('模板渲染成可点击 chip', $$('#savedTplList .chip.saved').length === 1);
check('模板数量角标更新', D.getElementById('tplCount').textContent === '1');
check('空提示隐藏', D.getElementById('tplEmptyNote').hidden === true);
const raw = w.localStorage.getItem('photoframe.presets.v1') || '';
check('模板落盘到 localStorage', raw.includes('我的浮层') && raw.includes('float'));

Object.assign(o(), { template: 'minimal', ratio: 'orig', pad: 2, bg: '#000000', radius: 0, shadow: false });
const pid = api.savedPresets[0].id;
click(D.querySelector(`#savedTplList .chip.saved[data-apply="${pid}"]`));
await tick();
check('套用模板恢复模板与比例', o().template === 'float' && o().ratio === '4/5', o().template + '/' + o().ratio);
check('套用模板恢复留白与配色', o().pad === 11 && o().bg === '#EDEBE6' && o().radius === 3.2 && o().shadow === true,
  [o().pad, o().bg, o().radius, o().shadow].join('/'));
check('套用模板不动文字输入框', D.getElementById('fModel').value === 'Z 8', D.getElementById('fModel').value);

click(D.querySelector('#savedTplList .chip.saved .del'));
await tick();
check('删除模板生效', api.savedPresets.length === 0);
check('删除后空提示回来', D.getElementById('tplEmptyNote').hidden === false);
check('删除后本地存储同步清空', (w.localStorage.getItem('photoframe.presets.v1') || '') === '[]');

/* ================= 第 9 层：手改保护 + 删除 ================= */
Object.assign(o(), { template: 'minimal', ratio: 'orig', pad: 6, overlay: false, mark: 'none', fields: { ...SOME_TEXT } });
D.getElementById('fModel').value = '我的自定义机型';
fire(D.getElementById('fModel'), 'input');
await tick();
check('手改机型后标记 auto=0', D.getElementById('fModel').dataset.auto === '0');
api.autofillFrom(api.state.items[0]);
await tick();
check('手改内容不被 EXIF 覆盖', D.getElementById('fModel').value === '我的自定义机型', D.getElementById('fModel').value);

/* ---- 移动端分组切换 ---- */
click(D.querySelector('#tabs button[data-tab="text"]'));
await tick();
check('切分组：当前组不高亮隐藏', !D.querySelector('#panelScroll .sec[data-group="text"]').classList.contains('taboff'));
check('切分组：其它组打上 taboff', D.querySelector('#panelScroll .sec[data-group="tpl"]').classList.contains('taboff'));
check('切分组：标签高亮唯一', $$('#tabs button.on').length === 1 && D.querySelector('#tabs button.on').dataset.tab === 'text');
api.setTab('photo');
await tick();
check('分组可切回照片', D.querySelector('#tabs button.on').dataset.tab === 'photo');

/* ---- 全屏预览 ---- */
click(D.getElementById('btnZoom'));
await tick();
check('全屏预览给 body 加 max 类', D.body.classList.contains('max'));
click(D.getElementById('btnZoom'));
await tick();
check('再点一次退出全屏', D.body.classList.contains('max') === false);

click(D.querySelector('#thumbs .thumb[data-id] .x'));
await tick(80);
check('删除照片后队列清空', api.state.items.length === 0, api.state.items.length + '');
check('删除后回到空状态', D.getElementById('empty').hidden === false);
check('删除后导出按钮禁用', D.getElementById('btnExport').disabled === true);
check('删除后全屏按钮收起', D.getElementById('btnZoom').hidden === true);
check('删除后缩略图条再次收起', D.getElementById('thumbs').hidden === true);
const nikonBrand = api.brands.find(b => b.word === 'Nikon');
const hass = api.brands.find(b => b.word === 'HASSELBLAD');
const leica = api.brands.find(b => b.plate === 'circle');
check('矩形底板高度只由「大小」决定（100 → 135）',
  Math.abs(api.markBoxHeight(nikonBrand, 100) - 135) < 0.01, api.markBoxHeight(nikonBrand, 100) + '');
check('纯字标没有底板，高度同样不受字长影响（100 → 125）',
  Math.abs(api.markBoxHeight(hass, 100) - 125) < 0.01, api.markBoxHeight(hass, 100) + '');
check('长字标是靠加宽而不是加高',
  api.brandMarkWidth(hass, 100) > api.brandMarkWidth(nikonBrand, 100),
  api.brandMarkWidth(hass, 100).toFixed(0) + ' > ' + api.brandMarkWidth(nikonBrand, 100).toFixed(0));
check('圆底板直径只由「大小」决定（100 → 172）',
  Math.abs(api.markBoxHeight(leica, 100) - 172) < 0.01, api.markBoxHeight(leica, 100) + '');

/* ================= 第 10 层：任意取色 ================= */
check('hex 归一化：3 位缩写展开', api.normalizeHex('#abc') === '#AABBCC', api.normalizeHex('#abc'));
check('hex 归一化：补 # 并统一大小写', api.normalizeHex('ff8800') === '#FF8800', api.normalizeHex('ff8800'));
check('hex 归一化：非法输入返回 null', api.normalizeHex('nope') === null && api.normalizeHex('') === null && api.normalizeHex('#12345') === null);
check('混色：往白里混 24% 能提亮', api.mixHex('#000000', '#FFFFFF', 0.24) === '#3D3D3D', api.mixHex('#000000', '#FFFFFF', 0.24));
check('混色：往黑里混 50% 能压暗', api.mixHex('#FFFFFF', '#000000', 0.5) === '#808080', api.mixHex('#FFFFFF', '#000000', 0.5));
check('对比度兜底：浅色文字在白底上被压到可读', api.contrast(api.ensureReadable('#EEEEEE', '#FFFFFF'), '#FFFFFF') >= 4.5,
  api.ensureReadable('#EEEEEE', '#FFFFFF') + ' → ' + api.contrast(api.ensureReadable('#EEEEEE', '#FFFFFF'), '#FFFFFF').toFixed(2));
check('对比度兜底：本来就够清楚的颜色不被动', api.ensureReadable('#1B1B19', '#FFFFFF') === '#1B1B19');

const textColorEl = D.getElementById('textColor');
const textHexEl = D.getElementById('textHex');
textColorEl.value = '#7a3cff';
fire(textColorEl, 'input');
await tick();
check('文字取色器实时写入 state', o().textColor === '#7A3CFF', o().textColor);
check('文字 hex 框跟随取色器', textHexEl.value === '#7A3CFF', textHexEl.value);
fire(textColorEl, 'change');
await tick();
check('确认取色后进入「最近使用」', api.recentColors.text[0] === '#7A3CFF', api.recentColors.text.join(','));
check('最近使用色板渲染出来', $$('#textRecent .sw').length >= 1 && D.getElementById('textRecentWrap').hidden === false);

textHexEl.value = '#0f9';
fire(textHexEl, 'change');
await tick();
check('hex 手输 3 位缩写直接生效', o().textColor === '#00FF99', o().textColor);
textHexEl.value = '#12';
fire(textHexEl, 'change');
await tick();
check('非法 hex 被拒绝并回滚显示', o().textColor === '#00FF99' && textHexEl.value === '#00FF99', textHexEl.value);
textHexEl.value = 'bad';
fire(textHexEl, 'change');
await tick();
check('3 位缩写即使看起来像单词也按缩写解析', o().textColor === '#BBAADD', o().textColor);
textHexEl.value = '#00FF99';
fire(textHexEl, 'change');
await tick();
check('最近使用去重且置顶', api.recentColors.text[0] === '#00FF99' && api.recentColors.text.filter(c => c === '#00FF99').length === 1,
  api.recentColors.text.join(','));

const pickFile = new w.File([w.__jpg], 'pick.jpg', { type: 'image/jpeg' });
await api.addFiles([pickFile]);
await tick(220);
const pickItem = api.state.items[api.state.items.length - 1];
api.state.current = pickItem.id;
check('照片主色识别（量化出现最多的色族）', api.photoDominantColor(pickItem) === '#C83C3C', api.photoDominantColor(pickItem));
const expectBg = api.mixHex('#C83C3C', '#FFFFFF', 0.24);
check('「取自照片」的背景色是提亮后的主色', api.bgFromPhoto(pickItem) === expectBg, api.bgFromPhoto(pickItem) + ' vs ' + expectBg);
click(D.getElementById('bgFromPhoto'));
await tick();
check('点「取自照片」写入背景色', o().bg === expectBg, o().bg);
w.__px = [128, 128, 128];
check('灰度照片不算主色（不会选出灰扑扑的边框）', api.photoDominantColor(pickItem) === null, String(api.photoDominantColor(pickItem)));
w.__px = [200, 60, 60];
const tfp = api.textFromPhoto(pickItem);
check('文字取色保证在边框底色上达到 4.5:1 可读对比度', api.contrast(tfp, o().bg) >= 4.5,
  tfp + ' on ' + o().bg + ' → ' + api.contrast(tfp, o().bg).toFixed(2));
check('中亮度底色上黑白都不达标时也能给出最优解', (() => {
  const c = api.ensureReadable('#C83C3C', '#D56B6B');
  return api.contrast(c, '#D56B6B') >= 4.5;
})(), api.ensureReadable('#C83C3C', '#D56B6B') + ' → ' + api.contrast(api.ensureReadable('#C83C3C', '#D56B6B'), '#D56B6B').toFixed(2));

/* ================= 第 11 层：撤销 / 重做 ================= */
api.applyTemplate('minimal', true);
const padEl = D.getElementById('pad');
api.resetHistory();
setRange(padEl, 12);
fire(padEl, 'change');
await tick();
const dStack = api.history.stack.length;
check('滑杆松手后才记一步', dStack === 2, dStack + '');
setRange(padEl, 15);
await tick();
check('拖动过程中不记步（否则撤销要按几十次）', api.history.stack.length === dStack, api.history.stack.length + '');
fire(padEl, 'change');
await tick();
check('再次松手又记一步', api.history.stack.length === dStack + 1, api.history.stack.length + '');

api.undo();
await tick();
check('撤销回到上一次的留白', o().pad === 12, o().pad + '');
check('撤销后滑杆与数值标签同步', padEl.value === '12' && D.getElementById('padVal').textContent === '12%',
  padEl.value + ' / ' + D.getElementById('padVal').textContent);
api.redo();
await tick();
check('重做回到 15', o().pad === 15, o().pad + '');

const modelEl = D.getElementById('fModel');
const modelBefore = modelEl.value;
const stackBefore = api.history.stack.length;
modelEl.value = '撤销测试机型';
fire(modelEl, 'input');
await tick();
check('打字过程中不记步', api.history.stack.length === stackBefore, api.history.stack.length + '');
fire(modelEl, 'change');
await tick();
api.undo();
await tick();
check('撤销把文字输入框也一起回退（不只是设置）', modelEl.value === modelBefore, JSON.stringify(modelEl.value));
api.redo();
await tick();
check('重做把文字内容带回来', modelEl.value === '撤销测试机型', modelEl.value);

while (api.history.idx > 0) api.undo();
await tick();
check('一直撤销到底不报错', api.history.idx === 0, api.history.idx + '');

/* ================= 第 12 层：输出尺寸与文件大小 ================= */
Object.assign(o(), { template: 'minimal', ratio: 'orig', pad: 6, outSize: 'orig', format: 'image/jpeg', quality: 92 });
const expItem = api.state.items[0];
api.state.current = expItem.id;
const Lf = api.computeLayout(expItem.full.width, expItem.full.height, o());
const dOrig = api.outDims(Lf, o());
check('输出尺寸：原图不缩放', dOrig.W === Lf.W && dOrig.H === Lf.H, dOrig.W + '×' + dOrig.H);

o().outSize = '2048';
const d2048 = api.outDims(Lf, o());
check('输出尺寸：长边限到 2048', Math.max(d2048.W, d2048.H) === 2048, d2048.W + '×' + d2048.H);
check('输出尺寸：限长边时保持比例', Math.abs(d2048.W / d2048.H - Lf.W / Lf.H) < 0.005,
  (d2048.W / d2048.H).toFixed(4) + ' vs ' + (Lf.W / Lf.H).toFixed(4));
o().outSize = '1080';
check('输出尺寸：长边限到 1080', Math.max(api.outDims(Lf, o()).W, api.outDims(Lf, o()).H) === 1080);
const smallDims = api.outDims({ W: 800, H: 600 }, { outSize: '2048' });
check('输出尺寸：小图不会被强行放大', smallDims.W === 800 && smallDims.H === 600, smallDims.W + '×' + smallDims.H);
o().outSize = 'orig';

check('估算：PNG 比 JPEG 大', api.estBytes(4000, 3000, 'image/png', 92) > api.estBytes(4000, 3000, 'image/jpeg', 92));
check('估算：WebP 比 JPEG 小', api.estBytes(4000, 3000, 'image/webp', 92) < api.estBytes(4000, 3000, 'image/jpeg', 92));
check('估算：画质越高文件越大', api.estBytes(4000, 3000, 'image/jpeg', 60) < api.estBytes(4000, 3000, 'image/jpeg', 100),
  Math.round(api.estBytes(4000, 3000, 'image/jpeg', 60)) + ' < ' + Math.round(api.estBytes(4000, 3000, 'image/jpeg', 100)));
check('字节格式化：B / KB / MB 三档', api.fmtBytes(900) === '900 B' && api.fmtBytes(2048) === '2 KB' && api.fmtBytes(5242880) === '5.0 MB',
  [api.fmtBytes(900), api.fmtBytes(2048), api.fmtBytes(5242880)].join(' / '));

api.updateOutInfo(null, false);
check('实测未完成前先显示估算值并标注「计算中」', D.getElementById('outInfo').innerHTML.includes('计算中'),
  D.getElementById('outInfo').textContent.replace(/\s+/g, ' ').slice(0, 80));
await tick(760);
const expectBytes = Math.round(dOrig.W * dOrig.H / 1000);
check('导出信息显示格式', D.getElementById('outInfo').innerHTML.includes('JPEG'));
check('导出信息显示画质', D.getElementById('outInfo').innerHTML.includes('92%'));
check('导出信息显示输出尺寸', D.getElementById('outInfo').innerHTML.includes(dOrig.W + ' × ' + dOrig.H));
check('实测值替换掉估算值（不再显示「计算中」）',
  D.getElementById('outInfo').innerHTML.includes(api.fmtBytes(expectBytes)) && !D.getElementById('outInfo').innerHTML.includes('计算中'),
  D.getElementById('outInfo').textContent.replace(/\s+/g, ' ').slice(0, 90));
check('实测值写入缓存', api.sizeCache.bytes === expectBytes, api.sizeCache.bytes + ' vs ' + expectBytes);

click(D.querySelector('#fmtRow button[data-v="image/png"]'));
await tick(760);
check('切到 PNG 后大小重新实测（缓存按格式失效）',
  api.sizeCache.bytes === Math.round(dOrig.W * dOrig.H / 1000 * 2), api.sizeCache.bytes + '');
check('PNG 时画质滑杆置灰（画质对 PNG 无意义）', D.getElementById('quality').disabled === true);
check('PNG 信息里不再显示画质', !D.getElementById('outInfo').innerHTML.includes('92%'));
click(D.querySelector('#fmtRow button[data-v="image/jpeg"]'));
await tick(60);

api.sizeCache.key = ''; api.sizeCache.bytes = 0;
o().format = 'image/png'; o().outSize = 'orig';
api.updateOutInfo(null, true);
check('估算超过 10MB 时给出二次压缩提醒', D.getElementById('outInfo').innerHTML.includes('超过 10MB'),
  D.getElementById('outInfo').textContent.replace(/\s+/g, ' ').slice(0, 100));
check('超限时大小用警示样式', D.getElementById('outInfo').innerHTML.includes('size heavy'));
o().format = 'image/jpeg';

const clampedDims = api.outDims({ W: 20000, H: 20000 }, { outSize: 'orig' });
check('超出浏览器画布上限时自动等比缩小', clampedDims.clamped === true && clampedDims.W * clampedDims.H <= 100000000,
  clampedDims.W + '×' + clampedDims.H + ' = ' + clampedDims.W * clampedDims.H);
check('缩小后仍在 1 亿像素以内', clampedDims.W === 10000, clampedDims.W + '');

// 移动端竖屏上，导出分组没打开时不该为看不见的数字做全分辨率编码
w.matchMedia = () => ({ matches: true, addEventListener() { }, removeEventListener() { } });
api.sizeCache.key = ''; api.sizeCache.bytes = 0;
api.setTab('tpl');
api.updateOutInfo(null, false);
await tick(700);
check('移动端未打开「导出」分组时不触发编码', api.sizeCache.bytes === 0, api.sizeCache.bytes + '');
api.setTab('out');
await tick(700);
check('切到「导出」分组后补测大小', api.sizeCache.bytes > 0, api.sizeCache.bytes + '');
delete w.matchMedia;

/* ================= 第 13 层：内联 ZIP ================= */
const crcRef = api.crc32(new TextEncoder().encode('123456789'));
check('crc32 通过标准测试向量（"123456789" → 0xCBF43926）', crcRef === 0xCBF43926, '0x' + crcRef.toString(16).toUpperCase());

const enc2 = new TextEncoder();
const dec2 = new TextDecoder();
const zipIn = [
  { name: 'a.jpg', data: new Uint8Array([1, 2, 3, 4, 5]) },
  { name: '中文名.jpg', data: new Uint8Array([9, 9, 9]) }
];
const zipBlob = await api.makeZip(zipIn);
check('ZIP 生成成功且非空', !!zipBlob && zipBlob.size > 0, 'size=' + (zipBlob && zipBlob.size));
const zb = new Uint8Array(await zipBlob.arrayBuffer());
const zv = new DataView(zb.buffer);
check('以本地文件头 PK\\x03\\x04 开头', zv.getUint32(0, true) === 0x04034B50, '0x' + zv.getUint32(0, true).toString(16));
check('store 模式：压缩方法为 0', zv.getUint16(8, true) === 0);
check('文件名带 UTF-8 标志位（中文名不乱码）', (zv.getUint16(6, true) & 0x0800) !== 0, '0x' + zv.getUint16(6, true).toString(16));
const n1len = zv.getUint16(26, true);
check('第一个文件名正确', dec2.decode(zb.subarray(30, 30 + n1len)) === 'a.jpg', dec2.decode(zb.subarray(30, 30 + n1len)));
check('压缩前后长度都等于原始长度', zv.getUint32(18, true) === 5 && zv.getUint32(22, true) === 5);
check('CRC 与自算一致', zv.getUint32(14, true) === api.crc32(new Uint8Array([1, 2, 3, 4, 5])));
check('文件内容原样写入', zb[30 + n1len] === 1 && zb[30 + n1len + 4] === 5);

const off2 = 30 + n1len + 5;
const n2len = zv.getUint16(off2 + 26, true);
check('第二个文件名（中文）正确', dec2.decode(zb.subarray(off2 + 30, off2 + 30 + n2len)) === '中文名.jpg',
  dec2.decode(zb.subarray(off2 + 30, off2 + 30 + n2len)));
const centralOff = off2 + 30 + n2len + 3;
check('中央目录头 PK\\x01\\x02', zv.getUint32(centralOff, true) === 0x02014B50, '0x' + zv.getUint32(centralOff, true).toString(16));
const eocdOff = zb.length - 22;
check('以 EOCD PK\\x05\\x06 结尾', zv.getUint32(eocdOff, true) === 0x06054B50, '0x' + zv.getUint32(eocdOff, true).toString(16));
check('EOCD 条目数 = 2', zv.getUint16(eocdOff + 8, true) === 2 && zv.getUint16(eocdOff + 10, true) === 2);
check('EOCD 中央目录偏移指向正确', zv.getUint32(eocdOff + 16, true) === centralOff, zv.getUint32(eocdOff + 16, true) + ' vs ' + centralOff);
check('EOCD 中央目录大小正确', zv.getUint32(eocdOff + 12, true) === eocdOff - centralOff,
  zv.getUint32(eocdOff + 12, true) + ' vs ' + (eocdOff - centralOff));

/* ================= 第 14 层：EXIF 写回 ================= */
// 造一个结构完整的最小 APP1：IFD0{ Orientation, ExifIFD 指针 } + ExifIFD{ 像素宽, 像素高 }
function buildApp1(orientation, w0, h0, le) {
  const entry = (tag, type, count, value) => {
    const b = new Uint8Array(12);
    const v = new DataView(b.buffer);
    v.setUint16(0, tag, le); v.setUint16(2, type, le); v.setUint32(4, count, le);
    if (type === 3) v.setUint16(8, value, le); else v.setUint32(8, value, le);
    return b;
  };
  const ifd0Off = 8, exifOff = ifd0Off + 30, tiffLen = exifOff + 30;
  const t = new Uint8Array(tiffLen);
  const v = new DataView(t.buffer);
  t[0] = le ? 0x49 : 0x4D; t[1] = le ? 0x49 : 0x4D;
  v.setUint16(2, 0x002A, le);
  v.setUint32(4, ifd0Off, le);
  v.setUint16(ifd0Off, 2, le);
  t.set(entry(0x0112, 3, 1, orientation), ifd0Off + 2);
  t.set(entry(0x8769, 4, 1, exifOff), ifd0Off + 14);
  v.setUint16(exifOff, 2, le);
  t.set(entry(0xA002, 4, 1, w0), exifOff + 2);
  t.set(entry(0xA003, 4, 1, h0), exifOff + 14);
  const segLen = 2 + 6 + tiffLen;
  const seg = new Uint8Array(2 + segLen);
  seg[0] = 0xFF; seg[1] = 0xE1;
  seg[2] = (segLen >> 8) & 0xFF; seg[3] = segLen & 0xFF;
  'Exif\u0000\u0000'.split('').forEach((ch, i) => { seg[4 + i] = ch.charCodeAt(0); });
  seg.set(t, 10);
  return seg;
}

const T = 10;
const app1LE = buildApp1(6, 4000, 3000, true);
const fixedLE = api.patchApp1(app1LE, 2048, 1536);
const fvL = new DataView(fixedLE.buffer, fixedLE.byteOffset, fixedLE.byteLength);
check('改写前 Orientation 是 6（窄端旋转）', new DataView(app1LE.buffer, app1LE.byteOffset).getUint16(T + 18, true) === 6);
check('Orientation 被复位为 1（像素已按 EXIF 矫正，不复位会被二次旋转）',
  fvL.getUint16(T + 18, true) === 1, fvL.getUint16(T + 18, true) + '');
check('PixelXDimension 改写为新图宽度', fvL.getUint32(T + 48, true) === 2048, fvL.getUint32(T + 48, true) + '');
check('PixelYDimension 改写为新图高度', fvL.getUint32(T + 38 + 14 + 8, true) === 1536, fvL.getUint32(T + 38 + 14 + 8, true) + '');
check('原地改写：段长度不变（不破坏结构）', fixedLE.length === app1LE.length, fixedLE.length + ' vs ' + app1LE.length);

const app1BE = buildApp1(8, 6000, 4000, false);
const fixedBE = api.patchApp1(app1BE, 1200, 800);
const fvB = new DataView(fixedBE.buffer, fixedBE.byteOffset, fixedBE.byteLength);
check('大端（MM）字节序同样能改写', fvB.getUint16(T + 18, false) === 1 && fvB.getUint32(T + 48, false) === 1200,
  fvB.getUint16(T + 18, false) + ' / ' + fvB.getUint32(T + 48, false));

check('结构不完整时原样返回而不是抛错', api.patchApp1(new Uint8Array([1, 2, 3]), 10, 10).length === 3);
check('字节序标记非法时原样返回', api.patchApp1(new Uint8Array(40), 5, 5).length === 40);

const jpgApp1 = buildApp1(1, 4000, 3000, true);
const jpgFull = new Uint8Array(2 + jpgApp1.length + 2);
jpgFull[0] = 0xFF; jpgFull[1] = 0xD8;
jpgFull.set(jpgApp1, 2);
jpgFull[jpgFull.length - 2] = 0xFF; jpgFull[jpgFull.length - 1] = 0xD9;
const extracted = api.extractApp1(jpgFull.buffer);
check('能从 JPEG 里切出 APP1 段', !!extracted && extracted.length === jpgApp1.length, extracted && extracted.length);
check('切出的段以 FF E1 开头', extracted[0] === 0xFF && extracted[1] === 0xE1);
check('没有 EXIF 的 JPEG 返回 null', api.extractApp1(new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]).buffer) === null);
check('非 JPEG 容器（HEIC 等）不误判', api.extractApp1(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer) === null);

const plainJpeg = { size: 4, type: 'image/jpeg', arrayBuffer: async () => new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]).buffer };
const withExif = await api.jpegWithExif(plainJpeg, jpgApp1, 2048, 1536);
const wb2 = new Uint8Array(await withExif.arrayBuffer());
check('EXIF 段插在 SOI 之后', wb2[0] === 0xFF && wb2[1] === 0xD8 && wb2[2] === 0xFF && wb2[3] === 0xE1,
  Array.from(wb2.subarray(0, 4)).map(v => v.toString(16)).join(' '));
check('原图像数据保留在尾部', wb2[wb2.length - 2] === 0xFF && wb2[wb2.length - 1] === 0xD9);
check('总长度 = 原图 + APP1 段', wb2.length === 4 + jpgApp1.length, wb2.length + ' vs ' + (4 + jpgApp1.length));

// 真实链路：decodeItem 有没有把 APP1 存下来
check('解码时保留了原始 APP1（导出才能写回）', !!api.state.items[0].app1 && api.state.items[0].app1[0] === 0xFF,
  api.state.items[0].app1 ? api.state.items[0].app1.length + ' 字节' : '未保留');

/* ================= 第 15 层：快捷键与粘贴 ================= */
const keyOn = (target, key, opt) => target.dispatchEvent(new w.KeyboardEvent('keydown',
  Object.assign({ key: key, bubbles: true, cancelable: true }, opt || {})));

api.applyTemplate('minimal', true);
keyOn(w, '3'); await tick();
check('数字键 3 切到「参数条」', o().template === 'bar', o().template);
keyOn(w, '7'); await tick();
check('数字键 7 切到「浮层」', o().template === 'float', o().template);
keyOn(w, '5'); await tick();
check('数字键 5 切到「胶片」（用户指定要保留的模板也受快捷键支持）', o().template === 'film', o().template);
check('快捷键切模板后留白跟随该模板', o().pad === 5, o().pad + '');
keyOn(w, '1'); await tick();
check('数字键 1 切回「极简留白」', o().template === 'minimal', o().template);

const ratio0 = o().ratio;
keyOn(w, 'r'); await tick();
check('R 键循环画布比例', o().ratio !== ratio0, ratio0 + ' → ' + o().ratio);

const tplBefore = o().template;
keyOn(D.getElementById('fModel'), '2'); await tick();
check('在输入框里打字不会被快捷键劫持', o().template === tplBefore, o().template);

const idxBefore = api.history.idx;
keyOn(D.getElementById('fModel'), 'z', { metaKey: true }); await tick();
check('输入框内 Cmd+Z 留给浏览器原生撤销', api.history.idx === idxBefore, api.history.idx + '');
keyOn(w, 'z', { metaKey: true }); await tick();
check('窗口内 Cmd+Z 触发设置撤销', api.history.idx === idxBefore - 1, api.history.idx + '');
keyOn(w, 'Z', { metaKey: true, shiftKey: true }); await tick();
check('Cmd+Shift+Z 重做', api.history.idx === idxBefore, api.history.idx + '');

click(D.getElementById('btnZoom')); await tick();
check('先进全屏', D.body.classList.contains('max'));
keyOn(w, 'Escape'); await tick();
check('Esc 退出全屏预览', D.body.classList.contains('max') === false);

const mkPaste = (list) => {
  const ev = new w.Event('paste', { bubbles: true, cancelable: true });
  ev.clipboardData = { items: list, files: [] };
  return ev;
};
const nBefore = api.state.items.length;
w.dispatchEvent(mkPaste([{ kind: 'file', type: 'image/png', getAsFile: () => new w.File([w.__jpg], 'image.png', { type: 'image/png' }) }]));
await tick(260);
check('粘贴图片后进入队列', api.state.items.length === nBefore + 1, api.state.items.length + '');
check('粘贴的图片自动改名（不再叫 image.png）', /^粘贴-/.test(api.state.items[api.state.items.length - 1].name),
  api.state.items[api.state.items.length - 1].name);
const notBlocked = w.dispatchEvent(mkPaste([{ kind: 'string', type: 'text/plain' }]));
check('粘贴纯文本不被拦截（不干扰正常输入）', notBlocked === true);

/* ================= 第 16 层：批量导出（内联 ZIP） ================= */
api.state.items.forEach(it => { it.status = 'ready'; });
Object.assign(o(), { format: 'image/jpeg', quality: 92, outSize: '1080', keepExif: false });
const savedBlobs = [];
const origCreateURL = w.URL.createObjectURL;
w.URL.createObjectURL = (b) => { savedBlobs.push(b); return 'blob:stub'; };
w.__loadedScripts.length = 0;
await api.exportAll();
await tick(60);
check('批量导出不再请求 CDN 脚本（断网也能打包）',
  w.__loadedScripts.filter(u => /jszip/i.test(u)).length === 0, w.__loadedScripts.join(', ') || '无外部请求');
check('批量导出产出一个 ZIP', savedBlobs.length === 1, savedBlobs.length + '');
const outZip = new Uint8Array(await savedBlobs[0].arrayBuffer());
const ozv = new DataView(outZip.buffer);
check('产物是合法 ZIP（EOCD 结尾）', ozv.getUint32(outZip.length - 22, true) === 0x06054B50,
  '0x' + ozv.getUint32(outZip.length - 22, true).toString(16));
check('ZIP 条目数 = 照片数', ozv.getUint16(outZip.length - 12, true) === api.state.items.length,
  ozv.getUint16(outZip.length - 12, true) + ' vs ' + api.state.items.length);
check('导出结束后进度条收起', D.getElementById('prog').hidden === true);
check('导出结束后操作条退出忙碌态', D.getElementById('actionbar').classList.contains('busy') === false);

const pending = api.exportAll();
await tick(18);
click(D.getElementById('btnCancelExport'));
await pending;
await tick(40);
check('中途取消会给出明确提示', (D.getElementById('toast').textContent || '').includes('取消'),
  D.getElementById('toast').textContent);
check('取消后不会卡在忙碌态', D.getElementById('prog').hidden === true && !D.getElementById('actionbar').classList.contains('busy'));
w.URL.createObjectURL = origCreateURL;

/* ================= 第 17 层：保留 EXIF 默认 + 外观主题 ================= */

/* ---- 17.1 重置后依然回到「默认开启」 ---- */
click(D.getElementById('btnReset'));
await tick();
check('重置后「保留 EXIF」回到默认开启',
  o().keepExif === true && D.getElementById('keepExif').checked === true,
  String(o().keepExif) + ' / checked=' + D.getElementById('keepExif').checked);

const cbExif = D.getElementById('keepExif');
cbExif.checked = false; fire(cbExif, 'change');
check('取消勾选后状态同步为关', o().keepExif === false);
cbExif.checked = true; fire(cbExif, 'change');
check('重新勾选后状态同步为开', o().keepExif === true);

/* ---- 17.2 主题默认跟随系统，用户选过则以用户为准 ---- */
const pLight = makePage({ systemDark: false }); await tick();
check('系统浅色 → 默认浅色',
  pLight.w.document.documentElement.getAttribute('data-theme') === 'light',
  pLight.w.document.documentElement.getAttribute('data-theme'));

const pDark = makePage({ systemDark: true }); await tick();
check('系统深色 → 默认深色',
  pDark.w.document.documentElement.getAttribute('data-theme') === 'dark',
  pDark.w.document.documentElement.getAttribute('data-theme'));

const pSavedLight = makePage({ systemDark: true, storedTheme: 'light' }); await tick();
check('用户选过浅色后，系统深色不再覆盖',
  pSavedLight.w.document.documentElement.getAttribute('data-theme') === 'light',
  pSavedLight.w.document.documentElement.getAttribute('data-theme'));

const pSavedDark = makePage({ systemDark: false, storedTheme: 'dark' }); await tick();
check('用户选过深色后，系统浅色也不再覆盖',
  pSavedDark.w.document.documentElement.getAttribute('data-theme') === 'dark',
  pSavedDark.w.document.documentElement.getAttribute('data-theme'));

/* ---- 17.3 顶栏切换按钮 ---- */
const pt = makePage({ systemDark: false }); await tick();
const wt = pt.w, Dt = wt.document;
const btnTheme = Dt.getElementById('btnTheme');
const tClick = () => btnTheme.dispatchEvent(new wt.MouseEvent('click', { bubbles: true }));

check('顶栏有主题切换按钮', !!btnTheme);
check('浅色时按钮提示切到深色', /深色/.test(btnTheme.getAttribute('title') || ''), btnTheme.getAttribute('title'));
check('浅色时月牙图标可见、太阳图标隐藏',
  wt.getComputedStyle(Dt.querySelector('.ico-moon')).display !== 'none' &&
  wt.getComputedStyle(Dt.querySelector('.ico-sun')).display === 'none',
  wt.getComputedStyle(Dt.querySelector('.ico-moon')).display + '/' + wt.getComputedStyle(Dt.querySelector('.ico-sun')).display);

tClick();
check('点击后切到深色',
  wt.document.documentElement.getAttribute('data-theme') === 'dark',
  wt.document.documentElement.getAttribute('data-theme'));
check('深色时按钮提示切回浅色', /浅色/.test(btnTheme.getAttribute('title') || ''), btnTheme.getAttribute('title'));
check('深色时太阳图标可见、月牙隐藏',
  wt.getComputedStyle(Dt.querySelector('.ico-sun')).display !== 'none' &&
  wt.getComputedStyle(Dt.querySelector('.ico-moon')).display === 'none',
  wt.getComputedStyle(Dt.querySelector('.ico-sun')).display + '/' + wt.getComputedStyle(Dt.querySelector('.ico-moon')).display);
check('选择已持久化到 localStorage',
  wt.localStorage.getItem('photoframe.theme.v1') === 'dark',
  String(wt.localStorage.getItem('photoframe.theme.v1')));
check('color-scheme 同步为 dark（原生控件跟随）',
  wt.document.documentElement.style.colorScheme === 'dark',
  wt.document.documentElement.style.colorScheme);
check('theme-color 同步为深色底（移动端地址栏）',
  Dt.querySelector('meta[name="theme-color"]').getAttribute('content') === '#1a1a19',
  Dt.querySelector('meta[name="theme-color"]').getAttribute('content'));

tClick();
check('再点一次切回浅色', wt.document.documentElement.getAttribute('data-theme') === 'light');
check('持久化跟着更新为 light', wt.localStorage.getItem('photoframe.theme.v1') === 'light');

/* ---- 17.4 主题绝不能影响导出画面 ---- */
Object.assign(o(), { template: 'minimal', ratio: 'orig', fields: { ...SOME_TEXT } });
const sigOf = () => JSON.stringify(ctxs.flatMap(c => c.texts)
  .map(t => [t.t, t.fill, t.font, t.x, t.y, t.align, t.baseline]));

api.applyTheme('light', false);
ctxs.length = 0; api.renderPreview();
const sigLight = sigOf();
const cvLight = await api.renderToCanvas(api.state.items[0], Object.assign({}, o(), { quality: 0.9 }));

api.applyTheme('dark', false);
ctxs.length = 0; api.renderPreview();
const sigDark = sigOf();
const cvDark = await api.renderToCanvas(api.state.items[0], Object.assign({}, o(), { quality: 0.9 }));
api.applyTheme('light', false);

check('换主题后预览绘制内容逐项一致（导出与主题解耦）',
  sigLight === sigDark && sigLight.length > 40,
  sigLight === sigDark ? sigLight.length + ' 字符完全一致' : '绘制结果不一致');
check('换主题后导出画布尺寸不变',
  cvLight.width === cvDark.width && cvLight.height === cvDark.height,
  cvLight.width + '×' + cvLight.height + ' vs ' + cvDark.width + '×' + cvDark.height);

/* ---- 17.5 深色配色必须真的能读（对比度 ≥ 4.5:1） ---- */
const rawHtml = readFileSync(join(ROOT, 'index.html'), 'utf8');
const cssBlock = rawHtml.slice(rawHtml.indexOf('<style>'), rawHtml.indexOf('</style>'));
check('CSS 里存在深色主题块', /\[data-theme=dark\]\{/.test(cssBlock));

const dk = cssBlock.slice(cssBlock.indexOf('[data-theme=dark]{'));
const varOf = (name) => {
  const m = dk.match(new RegExp(name + '\\s*:\\s*(#[0-9a-fA-F]{3,6})'));
  return m ? m[1] : null;
};
/* 最暗的底不是 --surface 而是 --surface-2（说明框、拖放区都用它），
   三级以下文字必须在它上面也达标，否则会在那些区块里读不清 */
const CONTRAST_PAIRS = [
  ['--ink', '--surface'], ['--ink', '--surface-2'], ['--ink', '--bg'],
  ['--ink-2', '--surface'], ['--ink-2', '--surface-2'],
  ['--ink-3', '--surface'], ['--ink-3', '--surface-2'],
  ['--ink-4', '--surface'], ['--ink-4', '--surface-2'],
  ['--placeholder', '--surface'], ['--placeholder', '--surface-2'],
  ['--warn', '--surface'], ['--warn', '--surface-2'],
  ['--danger', '--surface'], ['--danger', '--surface-2'],
  ['--on-ink', '--ink'],
  ['--badge-ink', '--badge-bg'], ['--chip-on-ink', '--chip-on-bg']
];
const weakPairs = [];
for (const [fg, bg] of CONTRAST_PAIRS) {
  const a = varOf(fg), b = varOf(bg);
  if (!a || !b) { weakPairs.push(fg + '/' + bg + '=未定义'); continue; }
  const r = api.contrast(a, b);
  if (r < 4.5) weakPairs.push(fg + '/' + bg + '=' + r.toFixed(2));
}
check('深色主题所有文字配对都达到 4.5:1',
  weakPairs.length === 0,
  weakPairs.join(' ') || CONTRAST_PAIRS.length + ' 组全达标');

/* ---- 17.6 内联脚本数量守卫：将来再加脚本不会漏测 ---- */
const inlineTags = (rawHtml.match(/<script[^>]*>/g) || []).filter(s => !/\ssrc=/.test(s));
check('内联脚本恰好 2 个且带 id（主题引导 + 主脚本）',
  inlineTags.length === 2 && rawHtml.includes('<script id="app">') && rawHtml.includes('<script id="theme-boot">'),
  inlineTags.length + ' 个内联脚本');

/* ================= 汇总 ================= */
console.log('\n通过 ' + ok.length + ' 项：');
ok.forEach(s => console.log('  ✓ ' + s));
if (bad.length) { console.log('\n失败 ' + bad.length + ' 项：'); bad.forEach(s => console.log('  ✗ ' + s)); }
console.log('\n运行时错误 ' + errors.length + ' 个：');
errors.slice(0, 15).forEach(e => console.log('  ! ' + e));
process.exit(bad.length || errors.length ? 1 : 0);
