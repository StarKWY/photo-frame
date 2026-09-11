# PWA · Progressive Web App

把 `index.html` 包成可"添加到主屏幕"的 PWA，安装到安卓/iPhone 后：

- 全屏运行（无浏览器地址栏）
- 图标、启动画面跟原生 App 一样
- **首次访问后离线可用**（Service Worker 预缓存所有资源）
- localStorage 跨启动持久化（用户偏好、模板、主题都保留）
- HEIC 解码与网页版一致（按需从 jsDelivr 拉 heic2any，照片本身不出本机）

## 文件结构

```
photo-frame/
├── index.html              # 主页（已加入 manifest 链接 + registerSW 调用）
├── manifest.webmanifest    # PWA 清单（名称、图标、主题色、display 模式）
├── sw.js                   # Service Worker（App Shell 预缓存 + cache-first）
├── pwa/
│   ├── icons/              # 4 个尺寸的图标（192/512/512-maskable/apple-touch-180）
│   ├── gen-icons.swift     # 重新生成图标的工具
│   └── tests/
│       └── check-pwa.mjs   # PWA 自测（22 项）
```

## 部署到手机

PWA 需要 **HTTPS**（或 `localhost`）。最简单的几条路：

### 方案 A：用 macOS 应用直接打开

macOS 版的 `留白.app`（见 `../macos/`）已经把 `pfframe://app/` 作为 origin，
**不算 PWA**。如果只是要在 macOS 上用，原生 App 已经是终态。

### 方案 B：起一个本地 http server，把手机连到同一 Wi-Fi

```bash
# 在仓库根目录起 server
python3 -m http.server 8000
# 拿到本机 IP，比如 192.168.1.10
# 手机浏览器打开 http://192.168.1.10:8000
# 注意：iOS 14+ 不允许从 http 安装 PWA（Secure Context 限制），
# 只能"添加到主屏幕"作为网页书签，体验略差。
```

### 方案 C：部署到任意 HTTPS 静态托管

**Cloudflare Pages / Netlify / GitHub Pages / Vercel** 任选一个，把整个仓库
根目录上传即可。会自动拿到 HTTPS 域名，PWA 安装全功能可用。

例如 Cloudflare Pages：
1. 把仓库推到 GitHub
2. Cloudflare Dashboard → Pages → Connect to Git → 选仓库
3. Build command 留空、Build output 选仓库根
4. 部署完成后访问 `https://<your-name>.pages.dev`
5. 在手机 Chrome/Safari 打开 → 菜单 → "添加到主屏幕"

## 自测

```bash
node pwa/tests/check-pwa.mjs
```

22 项断言覆盖：manifest 字段、图标尺寸、SW 注册、预缓存、离线兜底、secure context 检测。

## 重新生成图标

```bash
swiftc -O pwa/gen-icons.swift -o /tmp/gen-icons -framework AppKit -framework WebKit
/tmp/gen-icons pwa/icons/
```

会输出 4 个 PNG：192、512、512-maskable（深色背景 + 80% 安全区）、apple-touch-180。
Retina 屏上 `takeSnapshot` 是 2x 像素，脚本会再调 `sips` 缩放到精确尺寸。

## 已知限制

- **iOS Safari PWA** 不支持 `manifest` 的 `shortcuts`、`share_target` 等高级字段；
  只支持最小集（name/icons/start_url/display/theme_color），够用
- **iOS PWA localStorage 持久性**：Safari 长期不清理，但若用户主动卸载 PWA 则全清
- **安卓 WebView 的 HEIC 解码**未支持（PWA 用系统 WebView），需联网拉 heic2any
- **本机测试**只能验证 PWA 在 macOS Chrome 下的行为；手机端的实际安装体验
  （添加到主屏幕的提示、启动画面）需在真机/真模拟器验证
