# 留白 · macOS 原生应用

这是「留白 · 边框水印工坊」的 **macOS 原生封装版本**。它用 Swift + AppKit + WKWebView 把同一个 `index.html` 装进 `.app`，文件选取与导出走原生接口。

## 谁适合用

- 你想要一个**可以双击打开、有图标、在 Dock 里**的 macOS 应用。
- 你**不需要**通过 Mac App Store 分发（本方案是 ad-hoc 签名，适合自用或几台 Mac 之间拷贝）。
- 你想彻底离线运行（**本方案完全去掉了 HEIC 的 CDN 解码器依赖**，macOS 14+ 直接用 WebKit 原生 HEIC/HEIF 解码）。

## 不使用 App Store 分发

本项目采用 **ad-hoc codesign**（`codesign -s -`），好处是：

- 不需要 Apple Developer Program 的 **$99/年年费**。
- 不需要公证（Notarization）。
- 你自己和朋友的 Mac 上双击就能跑。

限制是：

- **不能进 Mac App Store**（上架需要 Developer ID + 公证）。
- 拷贝到另一台 Mac 时，如果对方 macOS Gatekeeper 较严，首次打开可能需要在「系统设置 → 隐私与安全性」里点「仍要打开」。
- 按右键 → 打开，也能绕过 Gatekeeper 的弹窗。

如果你想上 App Store / 做正式分发，需要换成 Developer ID 签名 + 公证，并把 `WKWebView` 的资源读取逻辑针对沙箱做调整（见源码 `WebShell.swift` 的注释）。

## 系统要求

- macOS **14 Sonoma** 或更新版本
- 已安装 **Command Line Tools for Xcode**（`xcode-select --install`）
- 兼容 **Apple Silicon + Intel**（通用二进制 `x86_64 arm64`）

> 旧版本（Ventura / Monterey）理论上仍能运行，但 **HEIC 原生解码** 依赖 Safari 17+ 引入的能力；如果 HEIC 解不开，会显示提示而不是去拉 CDN。

## 一键构建

```bash
cd photo-frame/macos
./build.sh
```

构建产物：

- `dist/留白.app` —— 可直接双击的应用
- `build/PhotoFrame` —— 通用二进制 Mach-O
- `build/AppIcon.iconset/` —— 1024/512/256/128/32/16 各尺寸图标 PNG
- `build/icon-1024.png` —— 1024×1024 的源图标

也可以用 `build.sh --thin` 只编译当前架构（构建稍快，但产物不是通用二进制）：

```bash
./build.sh --thin
```

## 用法

```bash
# 直接打开
open dist/留白.app

# 或者从命令行启动（可看到日志）
dist/留白.app/Contents/MacOS/PhotoFrame
```

### 支持的操作

| 操作 | 路径 |
|---|---|
| 导入照片 | 拖放，或点击左侧「点击选择或拖入照片」 |
| 粘贴图片 | 系统剪贴板 → 页面内 `⌘V` |
| 切换模板 | 点左侧 7 个模板卡片 |
| 切换主题 | 点右上角月亮/太阳图标 |
| 导出当前 | 「导出当前照片」按钮 |
| 批量导出 | 「打包导出全部」按钮（ZIP） |
| 撤销/重做 | `⌘Z` / `⇧⌘Z`（原生菜单也支持） |
| 清空历史 | `⌘R`（菜单「文件 → 清空全部」） |

### 导出位置

应用弹出的是**原生保存面板**，你可以选择任意目录。批量导出生成一个 ZIP 包，单张导出保存为 JPG。

## 自测

```bash
cd photo-frame/macos
./build.sh              # 先构建
node tests/run-selftest.mjs
```

这会跑 4 段验证：

1. **应用内自测**（19 项）—— 页面启动、断网拦截、打开面板、HEIC 原生解码、导出落盘、主题切换、无 JS 报错
2. **独立核对产物**（8 项）—— JPEG 结构、ZIP 结构、CRC32、store 模式、重名检查
3. **跨进程持久化**（1 项）—— 重启应用后 localStorage 是否仍在
4. **正常模式启动**（3 项）—— 不带参数双击能否保持运行

正常结果：`结果：通过 31 项，失败 0 项`

截图会保留在 `build/selftest-<随机串>/app-screenshot.png`，可以人工检查界面有没有崩。

## 为什么 macOS 封装比 Android 简单很多

核心原因是 **WebKit / WKWebView 原生支持 HEIC**（iPhone 默认照片格式），所以：

- `index.html` 的 HEIC 分支会自动走 WebKit 原生解码，**不需要改动 JS**。
- 可以把对外网络请求全部拦截掉，**应用完全离线**，也不用内嵌 `heic2any`。
- `a[download]` + `blob:` URL 在 macOS WebKit 上能正确触发 `WKDownloadDelegate`，保存逻辑全部由系统处理。
- 文件选择面板直接把文件路径喂回 `input[type=file]` 的 `FileList`，网页代码零感知。

Android 则相反：Android WebView 不解 HEIC、`blob:` 下载不会触发 `DownloadListener`、以及 `localStorage` 需要 HTTPS 来源才稳定。所以 Android 需要改 JS 和增加原生桥接。

## 目录结构

```
macos/
├── build.sh              # 一键构建脚本
├── resources/
│   └── Info.plist        # App Bundle 元信息
├── src/
│   ├── main.swift        # 入口 + 参数解析
│   ├── AppDelegate.swift # NSApplicationDelegate + 菜单
│   ├── WebShell.swift    # WKWebView + scheme handler + 打开/保存面板 + 下载委托
│   ├── IconRender.swift  # 用 WebView 渲染 1024×1024 应用图标
│   └── SelfTest.swift    # --selftest 模式
├── tests/
│   └── run-selftest.mjs  # Node 驱动脚本，生成样本 + 核对产物
└── dist/                 # 构建产物目录
    └── 留白.app
```

## 设计原则

- **不修改 `index.html`**：网页版和 App 版共享完全同一份源码。`macos/` 只提供运行环境。
- **完全离线**：禁止 WKWebView 发起任何外部请求（通过 `WKContentRuleList` 拦截所有 http/https/ws）。
- **原生 origin**：用 `pfframe://app/index.html` 加载页面，使 `localStorage` 拥有稳定来源（`file://` 在不同启动路径下 origin 会变化）。
- **最小权限**：`Info.plist` 不申请相机、麦克风、位置等敏感权限；读取照片完全依赖用户从面板选择，与浏览器行为一致。

## 已知问题

- 第一次把 `.app` 拷到另一台 Mac 时，Gatekeeper 可能会弹窗。解决：右键 → 打开 → 点「仍要打开」。
- 当前窗口尺寸固定在 1460×940；未来可以根据 macOS 的「自动隐藏菜单栏/Dock」做自适应。
- 从 `.app` 内部直接读取 `index.html` 时，自定义 scheme 不提供目录索引；如果地址错写，`pfframe://app/` 会返回 404。

## 如果你想上 Mac App Store

需要额外处理：

1. 用 **Apple Developer ID** 替换 ad-hoc 签名。
2. 启用 **Hardened Runtime**，并把 `WKWebView` 的网络策略声明清楚。
3. 把 `pfframe://` 资源读取逻辑从自定义 scheme 改为 `WKWebView.loadFileURL(_:allowingReadAccessTo:)`，或把 `index.html` 作为本地资源包加载；否则可能触发 App Review 对 custom URL scheme 的询问。
4. 走公证流程，并在 CI 里钉票据（staple）。

这些都属于分发合规改造，不影响当前「几台 Mac 自用」的目标。如果你要进 App Store，我可以继续做。
