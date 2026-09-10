#!/usr/bin/env node
/* 生成用于无头 Chrome 截图的预览页（临时文件，统一落在 tests/.tmp/，已被 gitignore） */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
// 临时预览页收在 tests/.tmp/ 下，别再往仓库根目录丢文件
const TMP = join(DIR, 'tests', '.tmp');
mkdirSync(TMP, { recursive: true });
const src = readFileSync(join(DIR, 'index.html'), 'utf8');

const P = (o) => JSON.stringify(o);

function page(name, body, theme) {
  const inject = [
    '<scr' + 'ipt>',
    '(function(){',
    '  setTimeout(function(){',
    '   (async function(){',
    '    try {',
    body,
    '     window.__ready = 1;',
    '    } catch(e){ window.__err = String(e && e.stack || e); }',
    '   })();',
    '  }, 250);',
    '})();',
    '</scr' + 'ipt>'
  ].join('\n');
  // 深色不能只把 data-theme 属性改掉了事：必须在主题引导脚本之前写好 localStorage，
  // 走用户真正会走的那条路径（顺带把防白闪逻辑一起验到）
  let html = src;
  if (theme){
    html = html.replace('<script id="theme-boot">',
      '<script>try{localStorage.setItem("photoframe.theme.v1","' + theme + '")}catch(e){}</script>\n<script id="theme-boot">');
  }
  writeFileSync(join(TMP, 'shot_' + name + '.html'), html.replace('</body>', inject + '\n</body>'));
  console.log('built', name + (theme ? ' [' + theme + ']' : ''));
}

/* 造一张像照片的合成图 */
const MAKE_PHOTO = `
    const c = document.createElement('canvas'); c.width = 1800; c.height = 1200;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 1800, 1200);
    g.addColorStop(0, '#1d2733'); g.addColorStop(.45, '#8a6a45'); g.addColorStop(1, '#2a1d16');
    x.fillStyle = g; x.fillRect(0, 0, 1800, 1200);
    const rg = x.createRadialGradient(1180, 330, 20, 1180, 330, 520);
    rg.addColorStop(0, 'rgba(255,222,168,.95)'); rg.addColorStop(1, 'rgba(255,222,168,0)');
    x.fillStyle = rg; x.fillRect(0, 0, 1800, 1200);
    x.fillStyle = 'rgba(18,22,28,.94)';
    x.beginPath(); x.moveTo(0,1200); x.lineTo(0,760); x.lineTo(360,470);
    x.lineTo(680,800); x.lineTo(980,560); x.lineTo(1800,1010); x.lineTo(1800,1200); x.closePath(); x.fill();
    x.fillStyle = 'rgba(10,12,16,.98)';
    x.beginPath(); x.moveTo(0,1200); x.lineTo(0,980); x.lineTo(430,760);
    x.lineTo(830,1040); x.lineTo(1500,860); x.lineTo(1800,1080); x.lineTo(1800,1200); x.closePath(); x.fill();
    for (let i = 0; i < 260; i++){
      x.fillStyle = 'rgba(255,240,210,' + (Math.random()*0.35) + ')';
      x.fillRect(Math.random()*1800, Math.random()*760, 1.6, 1.6);
    }
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.95));
    await addFiles([new File([blob], 'DSC_0421.jpg', { type: 'image/jpeg' })]);
    const it = state.items[0];
    it.exif = { make: 'NIKON CORPORATION', model: 'NIKON Z 8', lensModel: 'NIKKOR Z 24-70mm f/2.8 S', fNumber: 2.8, exposureTime: 1/500, iso: 400, focalLength: 35 };
    const fill = (id, v) => { const e = document.getElementById(id); e.value = v; e.dataset.auto = '1'; };
    fill('fModel', 'NIKON Z 8'); fill('fLens', 'NIKKOR Z 24-70mm f/2.8 S');
    fill('fParams', 'f/2.8  ·  1/500s  ·  ISO 400  ·  35mm'); fill('fDate', '2026.09.10');
    fill('fCustom', '© ZQL STUDIO');
`;

function setOpts(o, extra) {
  return MAKE_PHOTO + `
    Object.assign(state.opts, ${P(o)});
    ${extra || ''}
    syncControls();
    scheduleRender();
    await new Promise(r => setTimeout(r, 400));
`;
}

/* ---------- 七套模板 ---------- */
const TPL_OPTS = {
  minimal:  { template:'minimal',  ratio:'orig', pad:6,  bg:'#FFFFFF', textColor:'#1B1B19', family:'sans',  fontSize:2.2, radius:0,   shadow:false, mark:'none' },
  polaroid: { template:'polaroid', ratio:'orig', pad:5,  bg:'#FFFFFF', textColor:'#2E2A24', family:'serif', fontSize:2.8, radius:0,   shadow:false, mark:'none' },
  bar:      { template:'bar',      ratio:'orig', pad:4,  bg:'#FFFFFF', textColor:'#1B1B19', family:'sans',  fontSize:2.3, radius:0,   shadow:false, mark:'none' },
  classic:  { template:'classic',  ratio:'orig', pad:8,  bg:'#FFFFFF', textColor:'#1B1B19', family:'sans',  fontSize:1.9, radius:0,   shadow:false, mark:'none' },
  film:     { template:'film',     ratio:'orig', pad:5,  bg:'#141414', textColor:'#E8A33D', family:'mono',  fontSize:2.0, radius:1.2, shadow:false, mark:'none' },
  paper:    { template:'paper',    ratio:'orig', pad:9,  bg:'#F4EFE6', textColor:'#3A342C', family:'serif', fontSize:1.7, radius:0,   shadow:false, mark:'none' },
  float:    { template:'float',    ratio:'orig', pad:10, bg:'#EDEBE6', textColor:'#1B1B19', family:'sans',  fontSize:2.0, radius:3.2, shadow:true,  mark:'none' }
};

for (const [k, v] of Object.entries(TPL_OPTS)) page(`tpl_${k}`, setOpts(v));

/* ---------- 竖幅照片：复刻用户实测那张（1067×1600 竖构图 + 4 行参数） ---------- */
const MAKE_PHOTO_PORT = `
    const c = document.createElement('canvas'); c.width = 1067; c.height = 1600;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 1067, 1600);
    g.addColorStop(0, '#cfd6d8'); g.addColorStop(.45, '#7d8a63'); g.addColorStop(1, '#3b3a2f');
    x.fillStyle = g; x.fillRect(0, 0, 1067, 1600);
    x.fillStyle = 'rgba(28,30,26,.9)';
    x.beginPath(); x.moveTo(0,1600); x.lineTo(0,900); x.lineTo(300,640);
    x.lineTo(620,980); x.lineTo(1067,760); x.lineTo(1067,1600); x.closePath(); x.fill();
    x.fillStyle = 'rgba(196,178,140,.55)';
    x.beginPath(); x.ellipse(620, 780, 250, 330, .2, 0, Math.PI * 2); x.fill();
    x.fillStyle = 'rgba(250,248,240,.5)';
    x.beginPath(); x.ellipse(560, 620, 90, 120, .25, 0, Math.PI * 2); x.fill();
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.95));
    await addFiles([new File([blob], 'DSC_0107.jpg', { type: 'image/jpeg' })]);
    const fill = (id, v) => { const e = document.getElementById(id); e.value = v; e.dataset.auto = '1'; };
    fill('fModel', 'ILCE-7CM2'); fill('fLens', 'FE 70-200mm F2.8 GM OSS II');
    fill('fParams', 'f/2.8  ·  1/1250s  ·  ISO 1600  ·  180mm'); fill('fDate', '2026.09.10');
`;
function setOptsPort(o, extra) {
  return MAKE_PHOTO_PORT + `
    Object.assign(state.opts, ${P(o)});
    ${extra || ''}
    syncControls();
    scheduleRender();
    await new Promise(r => setTimeout(r, 400));
`;
}
page('port_paper', setOptsPort(TPL_OPTS.paper));
page('port_float', setOptsPort(TPL_OPTS.float));
page('port_film', setOptsPort(TPL_OPTS.film));
page('port_polaroid', setOptsPort(TPL_OPTS.polaroid));

/* ---------- 品牌标识（底栏右，与文字分列） ---------- */
page('mark_brand', setOpts({
  template:'bar', ratio:'orig', pad:4, bg:'#FFFFFF', textColor:'#1B1B19', family:'sans', fontSize:2.2,
  radius:0, shadow:false, mark:'brand', markPos:'bl', markSize:4.2, markTint:false
}));

/* ---------- 品牌标识（画面内右下） ---------- */
page('mark_inphoto', setOpts({
  template:'float', ratio:'orig', pad:10, bg:'#EDEBE6', textColor:'#1B1B19', family:'sans', fontSize:2.0,
  radius:3.2, shadow:true, mark:'brand', markPos:'ibr', markSize:3.4, markTint:false
}));

/* ---------- 平铺防盗图水印 ---------- */
page('wm_tile', setOpts({
  template:'minimal', ratio:'orig', pad:6, bg:'#FFFFFF', textColor:'#1B1B19', family:'sans', fontSize:2.2,
  radius:0, shadow:false, mark:'none',
  overlay:true, overlayTile:true, overlaySource:'custom', overlaySize:2.6, overlayOpacity:34, overlayAngle:-28
}, "document.getElementById('ovPosRow').hidden = false;"));

/* ---------- 单点画面内水印 ---------- */
page('wm_single', setOpts({
  template:'paper', ratio:'orig', pad:9, bg:'#F4EFE6', textColor:'#3A342C', family:'serif', fontSize:1.7,
  radius:0, shadow:false, mark:'none',
  overlay:true, overlayTile:false, overlaySource:'custom', overlayPos:'br', overlaySize:2.0, overlayOpacity:62
}));

/* ---------- 空状态 ---------- */
page('empty', `
    syncControls();
    scheduleRender();
    await new Promise(r => setTimeout(r, 200));
`);

/* ---------- 移动端：各分组 ---------- */
const M_BASE = { template:'film', ratio:'orig', pad:5, bg:'#141414', textColor:'#E8A33D', family:'mono', fontSize:2.0, radius:1.2, shadow:false, mark:'none' };

page('m_tpl', setOpts(M_BASE, "setTab('tpl');"));
page('m_layout', setOpts(
  Object.assign({}, M_BASE, { template:'float', bg:'#EDEBE6', textColor:'#1B1B19', family:'sans', fontSize:2.0, radius:3.2, shadow:true, pad:10 }),
  "setTab('layout');"
));
page('m_mark', setOpts(
  Object.assign({}, M_BASE, { template:'bar', bg:'#FFFFFF', textColor:'#1B1B19', family:'sans', fontSize:2.3, radius:0, mark:'brand', markPos:'br', markSize:4.2 }),
  "setTab('mark');"
));
page('m_wm', setOpts(
  Object.assign({}, M_BASE, { template:'minimal', bg:'#FFFFFF', textColor:'#1B1B19', family:'sans', fontSize:2.2, radius:0,
    overlay:true, overlayTile:true, overlaySource:'custom', overlaySize:2.6, overlayOpacity:34, overlayAngle:-28 }),
  "setTab('wm');"
));
page('m_empty', "setTab('photo');");
page('m_text', setOpts(M_BASE, "setTab('text');"));
page('d_tpl_saved', setOpts(
  Object.assign({}, TPL_OPTS.float, {}),
  "localStorage.setItem('photoframe.presets.v1', JSON.stringify([{id:'a1',name:'夜色街拍',opts:{template:'film',bg:'#141414',textColor:'#E8A33D'}},{id:'a2',name:'画册留白',opts:{template:'paper'}},{id:'a3',name:'浮层封面',opts:{template:'float'}}])); savedPresets = loadPresets(); renderSavedPresets(); setTab('tpl');"
));

/* ---------- 第三期：导出面板（输出尺寸 / 实测大小 / EXIF 开关） ---------- */
page('d_out', setOpts(
  { template:'minimal', ratio:'orig', pad:6, format:'image/jpeg', quality:92, outSize:'orig', keepExif:true, overlay:false, mark:'none' },
  "document.getElementById('panelScroll').scrollTop = 99999; await new Promise(r => setTimeout(r, 1600));"
));
page('d_color', setOpts(
  { template:'paper', ratio:'orig', pad:9, bg:'#F4EFE6', textColor:'#3A342C', family:'serif', fontSize:1.7, outSize:'2048' },
  "document.getElementById('panelScroll').scrollTop = 265; await new Promise(r => setTimeout(r, 1200));"
));
page('m_out', setOpts(
  Object.assign({}, M_BASE, { template:'minimal', bg:'#FFFFFF', textColor:'#1B1B19', family:'sans', fontSize:2.2, radius:0 }),
  "setTab('out'); document.getElementById('panelScroll').scrollTop = 0; await new Promise(r => setTimeout(r, 1600));"
));
page('m_color', setOpts(
  Object.assign({}, M_BASE, { template:'minimal', bg:'#FFFFFF', textColor:'#1B1B19', family:'sans', fontSize:2.2, radius:0 }),
  "setTab('text'); await new Promise(r => setTimeout(r, 400)); document.getElementById('panelScroll').scrollTop = 470; await new Promise(r => setTimeout(r, 300));"
));

/* ---------- 批量导出进度条 ---------- */
page('d_prog', setOpts(
  { template:'minimal', ratio:'orig', pad:6, format:'image/jpeg', quality:92 },
  "document.getElementById('actionbar').classList.add('busy'); document.getElementById('prog').hidden = false; setProgress(5, 12); document.getElementById('panelScroll').scrollTop = 99999; await new Promise(r => setTimeout(r, 300));"
));

/* ---------- 深色主题：桌面 / 移动各来一张 ---------- */
page('d_dark_tpl', setOpts(
  Object.assign({}, TPL_OPTS.minimal, { ratio:'orig' }),
  "setTab('tpl'); await new Promise(r => setTimeout(r, 400));"
), 'dark');

page('d_dark_out', setOpts(
  { template:'minimal', ratio:'orig', pad:6, format:'image/jpeg', quality:92, outSize:'2048', keepExif:true, overlay:false, mark:'none' },
  "setTab('out'); document.getElementById('panelScroll').scrollTop = 99999; await new Promise(r => setTimeout(r, 1600));"
), 'dark');

page('m_dark', setOptsPort(
  Object.assign({}, M_BASE, { template:'minimal', bg:'#FFFFFF', textColor:'#1B1B19', family:'sans', fontSize:2.2, radius:0 }),
  "setTab('out'); document.getElementById('panelScroll').scrollTop = 0; await new Promise(r => setTimeout(r, 1600));"
), 'dark');

console.log('done');
