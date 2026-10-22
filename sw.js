/* ============================================================
   sw.js —— Service Worker
   缓存策略：
   - 页面导航（HTML）→ network-first：联网时永远拿最新页面，
     断网时回退缓存。否则 cache-first 会让已安装用户永远停在旧版本
     （SW 脚本自身不变就不会触发更新）。
   - 其它同源 GET 资源 → cache-first，回退 network
   - install 阶段预缓存 App Shell（manifest、图标、index.html）
   - 跨域资源（jsdelivr heic2any）→ 不拦截，让浏览器走自身缓存

   PWA 部署：manifest 与本 sw.js 都放在站点根，所以 './' 就是 index.html。
   路径全部保持相对，因此部署到 https://<user>.github.io/<repo>/ 这类
   子路径站点时也无需改动。
   ============================================================ */

const VERSION = '2026-10-22-1';
const SHELL_CACHE = `photoframe-shell-${VERSION}`;
const RUNTIME_CACHE = `photoframe-runtime-${VERSION}`;

const SHELL_URLS = [
    './',
    './index.html',
    './manifest.webmanifest',
    './pwa/icons/icon-192.png',
    './pwa/icons/icon-512.png',
    './pwa/icons/icon-512-maskable.png',
    './pwa/icons/apple-touch-icon.png',
];

// 跨域例外列表：完全不拦截，直接放行（不让 SW 污染 jsdelivr 请求，
// 否则 HEIC 解码库的增量更新会被 SW 锁住）
const PASSTHROUGH = [
    'cdn.jsdelivr.net',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(SHELL_CACHE)
            .then((cache) =>
                // addAll 任何一个失败就整个失败，所以用 best-effort + 日志
                Promise.all(SHELL_URLS.map((u) =>
                    cache.add(u).catch((e) => {
                        console.warn(`[SW] 预缓存失败：${u} (${e.message})`);
                    })
                ))
            )
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys
                    .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
                    .map((k) => {
                        console.log(`[SW] 清理旧缓存：${k}`);
                        return caches.delete(k);
                    })
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    // 只处理 GET
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // 跨域放行（不拦截，让浏览器正常处理）
    if (url.origin !== self.location.origin) {
        if (PASSTHROUGH.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) {
            return; // 不响应，让浏览器走默认
        }
        // 其它跨域也放行
        return;
    }

    // 页面导航：network-first
    // 联网时直接取新 HTML（'no-cache' 绕过 HTTP 缓存的 max-age），
    // 并顺手更新缓存；失败才回退缓存。这样发版后用户刷新即见新版。
    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req, { cache: 'no-cache' })
                .then((resp) => {
                    if (resp && resp.status === 200 && resp.type === 'basic') {
                        const clone = resp.clone();
                        caches.open(SHELL_CACHE).then((cache) => cache.put(req, clone));
                    }
                    return resp;
                })
                .catch(() => caches.match(req)
                    .then((hit) => hit || caches.match('./index.html'))
                    // 首次安装且断网、缓存也没命中时，别让 respondWith 拿到 undefined
                    .then((hit) => hit || new Response('离线，且本地暂无缓存。', {
                        status: 503,
                        headers: { 'content-type': 'text/plain; charset=utf-8' },
                    })))
        );
        return;
    }

    // 同源静态资源：cache-first
    event.respondWith(
        caches.match(req).then((hit) => {
            if (hit) return hit;
            return fetch(req).then((resp) => {
                // 只缓存基本成功响应
                if (resp && resp.status === 200 && resp.type === 'basic') {
                    const clone = resp.clone();
                    caches.open(RUNTIME_CACHE).then((cache) => cache.put(req, clone));
                }
                return resp;
            }).catch(() => {
                // 网络失败且缓存没有：返回 fallback
                if (req.mode === 'navigate') {
                    return caches.match('./index.html');
                }
                return new Response('', { status: 504, statusText: 'Offline' });
            });
        })
    );
});

// 接收页面消息：让页面主动触发更新检查
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});
