#!/usr/bin/env node
/* ============================================================
   run-selftest.mjs —— 驱动 macOS 应用自测并独立验证产物

   分工：
     · 应用自己跑（--selftest）：页面启动、断网拦截、打开面板、
       HEIC 原生解码、导出落盘、主题切换、无 JS 报错
     · 这个脚本在外部独立核对产物：导出的照片是不是合法 JPEG、
       导出的 ZIP 结构是否完整、每条 entry 的 CRC32 对不对，
       以及 localStorage 是否跨进程存活（重启应用再读一次）

   CRC32 这条尤其重要 —— 它把「页面手写的 ZIP32 编码器」和
   「应用把 blob 流式写盘」两段拼起来做了端到端校验。
   ============================================================ */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const APP = process.argv[2] || path.join(HERE, '..', 'dist', '留白.app');
const BIN = path.join(APP, 'Contents', 'MacOS', 'PhotoFrame');

let pass = 0, fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? '  \x1b[2m' + detail + '\x1b[0m' : ''}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? '  \x1b[2m' + detail + '\x1b[0m' : ''}`); }
}

// ---------------------------------------------------------------- PNG 生成

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makePNG(w, h, rgb) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const off = y * stride;
    raw[off] = 0;
    for (let x = 0; x < w; x++) {
      const p = off + 1 + x * 3;
      raw[p] = rgb[0]; raw[p + 1] = rgb[1]; raw[p + 2] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- JPEG 解析

function readJPEG(buf) {
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return { ok: false, why: '缺少 SOI' };
  let i = 2, w = 0, h = 0;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
    if (m === 0xD9) break;
    const len = buf.readUInt16BE(i + 2);
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      h = buf.readUInt16BE(i + 5);
      w = buf.readUInt16BE(i + 7);
      break;
    }
    i += 2 + len;
  }
  const eoi = buf[buf.length - 2] === 0xFF && buf[buf.length - 1] === 0xD9;
  return { ok: w > 0 && h > 0 && eoi, w, h, eoi };
}

// ---------------------------------------------------------------- ZIP 解析 + CRC 校验

function readZIP(buf) {
  const eocdSig = 0x06054b50;
  let eocd = -1;
  const from = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === eocdSig) { eocd = i; break; }
  }
  if (eocd < 0) return { ok: false, why: '找不到 EOCD' };

  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff + cdSize > buf.length) return { ok: false, why: '中央目录越界' };

  const entries = [];
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return { ok: false, why: `第 ${n + 1} 条中央目录签名错` };
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    // 定位本地头，取出实际数据
    if (buf.readUInt32LE(lho) !== 0x04034b50) return { ok: false, why: `${name} 本地头签名错` };
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + csize);

    entries.push({
      name, usize, csize,
      crcOK: crc32(data) === crc,
      crcExpected: crc, crcActual: crc32(data),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { ok: true, count, entries };
}

// ---------------------------------------------------------------- 主流程

async function main() {
  console.log(`\n\x1b[1m留白 macOS 应用自测\x1b[0m\n\x1b[2m${BIN}\x1b[0m\n`);

  if (!fs.existsSync(BIN)) {
    console.error(`找不到可执行文件：${BIN}\n请先跑 ./build.sh`);
    process.exit(1);
  }

  // 每次全新目录（应用内的 uniqueURL 靠"文件不存在"来判重，复用目录会串味）。
  // 刻意不做删除：留在 build/ 下，跑完可以翻截图和中间产物。
  const workRoot = path.join(HERE, '..', 'build');
  fs.mkdirSync(workRoot, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(workRoot, 'selftest-'));
  const png = path.join(tmp, 'src.png');
  // 用真实相机风格的命名。故意不给两个样本同名 ——
  // 页面 outName() 不做去重，同名不同扩展名的照片会在 ZIP 里撞名
  // （已知问题，另见 README「已知问题」）。
  const jpg = path.join(tmp, 'IMG_0001.jpg');
  const heic = path.join(tmp, 'IMG_0002.heic');
  fs.writeFileSync(png, makePNG(240, 180, [198, 118, 60]));

  for (const [fmt, out] of [['jpeg', jpg], ['heic', heic]]) {
    const r = spawnSync('sips', ['-s', 'format', fmt, png, '--out', out], { encoding: 'utf8' });
    if (r.status !== 0 || !fs.existsSync(out)) {
      console.error(`生成测试样本失败（sips ${fmt}）: ${r.stderr || r.stdout}`);
      process.exit(1);
    }
  }
  console.log(`  测试样本：${path.basename(jpg)} ${fs.statSync(jpg).size}B · ${path.basename(heic)} ${fs.statSync(heic).size}B\n`);

  // ---------- 应用自测 ----------
  console.log('\x1b[1m① 应用内自测\x1b[0m');
  const r1 = spawnSync(BIN, ['--selftest', '--phase', '1', '--out', tmp, '--open-files', `${jpg},${heic}`], {
    encoding: 'utf8', timeout: 200000,
  });
  const out1 = (r1.stdout || '') + (r1.stderr || '');
  const lines = out1.split('\n').filter(l => l.startsWith('PFTEST|'));
  if (!lines.length) {
    console.error('  应用没有输出任何自测结果。原始输出：\n' + out1.slice(0, 3000));
    process.exit(1);
  }
  for (const l of lines) {
    const [, key, verdict, detail] = l.split('|');
    check(key, verdict === 'PASS', detail);
  }
  const token = (out1.match(/PF_STORAGE_TOKEN (\S+)/) || [])[1] || '';
  const savedPaths = [...out1.matchAll(/PF_SAVED (.+)/g)].map(m => m[1].trim());

  // 应用自报的退出码
  const verdict = (out1.match(/SELFTEST_RESULT (PASS|FAIL)/) || [])[1];
  check('应用自测整体判定为通过', verdict === 'PASS', verdict ? `SELFTEST_RESULT ${verdict}` : '未输出判定');
  check('应用退出码为 0', r1.status === 0, `exit=${r1.status}`);

  // ---------- 独立核对产物 ----------
  console.log('\n\x1b[1m② 独立核对导出产物\x1b[0m');

  const photo = savedPaths.find(p => /\.(jpe?g|png)$/i.test(p));
  if (!photo || !fs.existsSync(photo)) {
    check('找到导出的照片文件', false, photo ? `路径不存在：${photo}` : `未报告导出路径（${savedPaths.length} 条 PF_SAVED）`);
  } else {
    const buf = fs.readFileSync(photo);
    if (/\.png$/i.test(photo)) {
      const isPNG = buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG';
      check('导出的照片是合法 PNG', isPNG, `${path.basename(photo)} ${buf.length}B`);
    } else {
      const j = readJPEG(buf);
      check('导出的照片是合法 JPEG（含 SOI/SOF/EOI）', j.ok,
        j.ok ? `${j.w}×${j.h}，${buf.length}B` : `解析失败：${j.why || '无 SOF'}`);
      check('导出尺寸已含边框留白（大于 240×180 原图）',
        j.ok && j.w > 240 && j.h > 180, j.ok ? `${j.w}×${j.h}` : '无法判定');
    }
  }

  const zipPath = savedPaths.find(p => /\.zip$/i.test(p));
  if (!zipPath || !fs.existsSync(zipPath)) {
    check('找到导出的 ZIP 文件', false, zipPath ? `路径不存在：${zipPath}` : '未报告 ZIP 路径');
  } else {
    const z = readZIP(fs.readFileSync(zipPath));
    check('导出的 ZIP 结构完整（EOCD + 中央目录）', z.ok, z.ok ? `${z.count} 条 entry` : z.why);
    if (z.ok) {
      check('ZIP 条目数与导入照片数一致', z.count === 2, `${z.count} 条：${z.entries.map(e => e.name).join(', ')}`);
      const names = z.entries.map(e => e.name);
      check('ZIP 内条目名互不重复', new Set(names).size === names.length,
        new Set(names).size === names.length ? '无重名' : `重名：${names.join(', ')}`);
      check('条目标记了 _framed 后缀且为 jpg',
        names.every(n => /_framed\.jpg$/.test(n)), names.join(', '));
      const bad = z.entries.filter(e => !e.crcOK);
      check('每条 ZIP 条目的 CRC32 校验通过', bad.length === 0,
        bad.length ? bad.map(e => `${e.name} 期望 ${e.crcExpected.toString(16)} 实得 ${e.crcActual.toString(16)}`).join('; ')
                   : `${z.entries.length} 条全部匹配`);
      const sized = z.entries.every(e => e.usize > 0 && e.csize === e.usize);
      check('ZIP 为 store 模式且各条目非空', sized,
        z.entries.map(e => `${e.name}=${e.usize}B`).join(' '));
    }
  }

  // ---------- 跨进程持久化 ----------
  console.log('\n\x1b[1m③ localStorage 跨进程存活\x1b[0m');
  const r2 = spawnSync(BIN, ['--selftest', '--phase', '2', '--out', tmp], { encoding: 'utf8', timeout: 120000 });
  const out2 = (r2.stdout || '') + (r2.stderr || '');
  const read = (out2.match(/PF_STORAGE_READ (\S*)/) || [])[1] || '';
  check('重启应用后 localStorage 仍在', !!token && read === token,
    token ? `写入 ${token} / 读回 ${read || '(空)'}` : '第一阶段没拿到 token');

  // ---------- 正常模式启动 ----------
  // 自测模式跑通不等于「双击打开」也正常，所以再按用户真实路径起一次
  console.log('\n\x1b[1m④ 正常启动（不带任何参数）\x1b[0m');
  const child = spawn(BIN, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = null;
  child.on('exit', (code, sig) => { exited = `code=${code} sig=${sig}`; });
  let errBuf = '';
  child.stderr.on('data', d => { errBuf += d.toString(); });
  await new Promise(r => setTimeout(r, 7000));
  check('正常模式启动后保持运行（未崩溃退出）', exited === null,
    exited === null ? '7 秒内进程存活' : `已退出：${exited}`);
  if (errBuf.trim()) {
    const lines = errBuf.trim().split('\n').filter(l => /error|fatal|exception/i.test(l));
    check('正常模式无错误输出', lines.length === 0, lines.slice(0, 2).join(' / ') || '无');
  }
  try { child.kill('SIGTERM'); } catch { /* 已退出 */ }

  // ---------- 汇总 ----------
  console.log(`\n\x1b[1m结果：\x1b[0m通过 \x1b[32m${pass}\x1b[0m 项，失败 \x1b[31m${fail}\x1b[0m 项`);
  if (fail) {
    console.log('\n失败项：');
    failures.forEach(f => console.log(`  · ${f}`));
    console.log(`\n工作目录保留以便排查：${tmp}\n`);
    process.exit(1);
  }
  console.log(`\n工作目录保留供查阅：\x1b[2m${tmp}\x1b[0m`);
  console.log(`  · 截图：  ${path.join(tmp, 'app-screenshot.png')}`);
  console.log(`  · 导出：  ${path.join(tmp, '*_framed.jpg')}`);
  console.log(`  · ZIP：   ${path.join(tmp, '*.zip')}`);
}

main().catch(e => {
  console.error('\n自测驱动本身出错：', e);
  process.exit(1);
});
