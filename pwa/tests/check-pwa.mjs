/* ============================================================
   check-pwa.mjs —— PWA 自测
   分两段：
   A. 静态检查（不起 server）：
      - manifest 字段齐全、合法
      - 图标实际像素与 manifest 声明严格一致
      - index.html 包含 manifest 链接、apple-touch-icon、registerSW
      - sw.js 包含 install/activate/fetch 事件 + SKIP_WAITING
   B. 动态检查（起 http server + CDP）：
      - 加载页面后 SW 成功注册并接管（controller 非空）
      - 预缓存了 index.html
      - 断网后刷新仍能加载（离线兜底）
   ============================================================ */

import { readFileSync, existsSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';
import http from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const WORK = join(HERE, '.tmp-pwa');

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}` + (detail ? `  \x1b[2m${detail}\x1b[0m` : '')); }
  else    { fail++; failures.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}` + (detail ? `  ${detail}` : '')); }
};
const section = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

const sips = (file) => {
  const out = execSync(`sips -g pixelWidth -g pixelHeight "${file}"`, { encoding: 'utf8' });
  return {
    w: parseInt(out.match(/pixelWidth:\s*(\d+)/)?.[1] || '0', 10),
    h: parseInt(out.match(/pixelHeight:\s*(\d+)/)?.[1] || '0', 10),
  };
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

// ---------------------------------------------------------------- A. 静态检查

section('A. 静态检查');

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.webmanifest'), 'utf8'));
check('manifest 是合法 JSON', !!manifest.name, `name=${manifest.name}`);
check('manifest 有 start_url 与 scope', !!manifest.start_url && !!manifest.scope,
  `start_url=${manifest.start_url} scope=${manifest.scope}`);
check('manifest 是 standalone 模式', manifest.display === 'standalone', `display=${manifest.display}`);
check('manifest 有 theme_color 和 background_color',
  !!manifest.theme_color && !!manifest.background_color);

const need = ['icon-192.png', 'icon-512.png', 'icon-512-maskable.png'];
const haveAll = need.every(n => (manifest.icons || []).some(i => i.src.endsWith(n)));
check('manifest 声明了 192/512/maskable 三个图标', haveAll,
  (manifest.icons || []).map(i => i.src.split('/').pop()).join(', '));

let sizesOK = true;
const sizeDetail = [];
for (const icon of (manifest.icons || [])) {
  const path = join(ROOT, icon.src);
  if (!existsSync(path)) { sizesOK = false; sizeDetail.push(`${icon.src}=缺`); continue; }
  const [w, h] = icon.sizes.split('x').map(Number);
  const actual = sips(path);
  if (actual.w !== w || actual.h !== h) {
    sizesOK = false;
    sizeDetail.push(`${icon.src} 声明 ${icon.sizes} 实际 ${actual.w}x${actual.h}`);
  } else sizeDetail.push(`${icon.src} ${actual.w}x${actual.h} ✓`);
}
check('所有图标实际尺寸与 manifest 声明一致', sizesOK, sizeDetail.join(' | '));

const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
check('index.html 包含 manifest 链接',
  /<link[^>]*rel="manifest"[^>]*manifest\.webmanifest/.test(html));
check('index.html 包含 apple-touch-icon',
  /<link[^>]*rel="apple-touch-icon"[^>]*\.png/.test(html));
check('index.html 定义了 registerSW 函数', /function\s+registerSW\s*\(/.test(html));
check('registerSW 检测 isSecureContext 并 return', /isSecureContext\s*\)\s*return/.test(html));
check('boot() 调用了 registerSW',
  /function\s+boot\s*\(\)\s*{[^}]*registerSW\s*\(\s*\)/s.test(html));

const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
check('sw.js 注册了 install/activate/fetch 三个事件',
  /addEventListener\(['"]install['"]/.test(sw) &&
  /addEventListener\(['"]activate['"]/.test(sw) &&
  /addEventListener\(['"]fetch['"]/.test(sw));
check('sw.js 处理 SKIP_WAITING', /SKIP_WAITING/.test(sw));
check('sw.js 放行 jsdelivr', /cdn\.jsdelivr\.net/.test(sw));

// ---------------------------------------------------------------- B. 动态检查

section('B. 动态检查（http server + CDP）');

try { rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
mkdirSync(WORK, { recursive: true });

const server = http.createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';
  const path = join(ROOT, url);
  if (!existsSync(path) || !statSync(path).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  const buf = readFileSync(path);
  const ct = MIME[extname(path)] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': ct, 'content-length': buf.length });
  res.end(buf);
});

await new Promise((res) => server.listen(0, '127.0.0.1', res));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;
console.log(`  Server: ${BASE}`);

const CDP = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9333;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const child = spawn(CDP, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, '--no-sandbox', '--disable-gpu',
  `--user-data-dir=${join(WORK, 'profile')}`,
  'about:blank',
], { stdio: 'pipe' });
child.stderr.on('data', () => {});
child.stdout.on('data', () => {});

for (let i = 0; i < 50; i++) {
  await sleep(300);
  try {
    const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    if (r.ok) break;
  } catch (e) {}
}
console.log('  Chrome started.');

// 通用 WS 客户端
function cdp(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  const idRef = { i: 0 };
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const d = JSON.parse(e.data);
    if (d.id != null && pending.has(d.id)) {
      const { res, rej } = pending.get(d.id);
      pending.delete(d.id);
      d.error ? rej(new Error(d.error.message)) : res(d.result);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws')), { once: true });
  });
  return {
    ready,
    _ws: ws,    // 暴露 ws 以便监听事件
    send(method, params = {}) {
      const n = idRef.i++;
      return new Promise((res, rej) => {
        pending.set(n, { res, rej });
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    },
    close() { try { ws.close(); } catch (e) {} },
  };
}

async function newTab(url) {
  // 新版 Chrome 只接受 PUT /json/new（GET 已被标记 "Using unsafe..."）
  const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  return await r.json();
}
async function closeTab(t) {
  try { await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${t.id}`); } catch (e) {}
}

try {
  // 辅助：创建空白标签，导航到目标 url，等待 load 事件
  async function withPage(url, fn) {
    const t = await newTab('');  // about:blank
    const c = cdp(t); await c.ready;
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    // 监听 load
    const loaded = new Promise((res) => {
      const handler = (e) => {
        const d = JSON.parse(e.data);
        if (d.method === 'Page.loadEventFired') {
          c._ws && c._ws.removeEventListener('message', handler);
          res();
        }
      };
      c._ws && c._ws.addEventListener('message', handler);
    });
    await c.send('Page.navigate', { url });
    await Promise.race([loaded, sleep(8000)]);
    await sleep(500);  // 再等一下让 JS 跑
    return await fn(c);
  }

  // B1. SW 注册
  console.log('  B1: 验证 SW 注册...');
  const swInfo = await withPage(`${BASE}/index.html`, async (c) => {
    return await c.send('Runtime.evaluate', {
      expression: `(async () => {
        try {
          await navigator.serviceWorker.ready;
          const reg = await navigator.serviceWorker.getRegistration();
          return {
            ok: true,
            reg: !!reg,
            active: reg && reg.active && reg.active.state,
            scope: reg && reg.scope,
            controller: !!navigator.serviceWorker.controller,
            isSecure: window.isSecureContext,
            origin: location.origin
          };
        } catch (e) {
          return { ok: false, err: String(e) };
        }
      })()`,
      returnByValue: true, awaitPromise: true,
    });
  });
  if (swInfo.exceptionDetails) {
    check('Service Worker 探测未抛错', false, JSON.stringify(swInfo.exceptionDetails));
  }
  const v = swInfo.result && swInfo.result.value;
  check('页面是 secure context（navigator.serviceWorker 存在）',
    v && v.isSecure === true, `isSecure=${v && v.isSecure} origin=${v && v.origin}`);
  check('Service Worker 注册成功', v && v.ok && v.reg, JSON.stringify(v));
  check('SW 处于 active 或 installed',
    v && v.ok && ['activated', 'installed'].includes(v.active),
    `active=${v && v.active}`);
  check('SW 已接管页面（controller）', v && v.ok && v.controller === true,
    `controller=${v && v.controller}`);

  // B2. 预缓存
  console.log('  B2: 验证预缓存...');
  const cacheInfo = await withPage(`${BASE}/index.html`, async (c) => {
    return await c.send('Runtime.evaluate', {
      expression: `(async () => {
        const names = await caches.keys();
        const shell = names.find(n => n.startsWith('photoframe-shell-'));
        if (!shell) return { ok: false, why: '无 shell 缓存', names };
        const cache = await caches.open(shell);
        const r = await cache.match('./index.html');
        return { ok: !!r, why: r ? '命中' : 'cache 里有 shell 但无 index.html', shellName: shell };
      })()`,
      returnByValue: true, awaitPromise: true,
    });
  });
  const ci = cacheInfo.result && cacheInfo.result.value;
  check('存在 photoframe-shell-* 缓存', !!ci && !!ci.shellName,
    (ci && ci.shellName) || (ci && ci.why));
  check('预缓存了 index.html', ci && ci.ok, ci && ci.why);

  // B3. 离线刷新
  console.log('  B3: 验证离线可用...');
  // 上面已经加载过页面（SW 已就绪），现在关 server
  server.close();
  await sleep(300);
  const offline = await withPage(`${BASE}/index.html`, async (c) => {
    return await c.send('Runtime.evaluate', {
      expression: `({
        title: document.title,
        tabsExists: !!document.getElementById('tabs'),
        bodyHTMLLen: (document.body && document.body.innerHTML || '').length,
      })`,
      returnByValue: true,
    });
  });
  const of = offline.result && offline.result.value;
  check('断网后刷新仍能加载（SW 兜底）',
    of && of.title && of.title.length > 0,
    `title=${(of && of.title || '').slice(0, 30)}`);
  check('断网后页面有交互骨架（tabs 存在）',
    of && of.tabsExists,
    `bodyLen=${of && of.bodyHTMLLen}`);

} catch (e) {
  check('动态检查流程未崩溃', false, e.message + '\n' + e.stack);
} finally {
  try { child.kill('SIGKILL'); } catch (e) {}
  await sleep(300);
}

// ---------------------------------------------------------------- 汇总

console.log(`\n\x1b[1m结果：\x1b[0m通过 \x1b[32m${pass}\x1b[0m 项，失败 \x1b[31m${fail}\x1b[0m 项\n`);
if (fail) {
  console.log('失败项：');
  failures.forEach(f => console.log(`  · ${f}`));
  process.exit(1);
}
