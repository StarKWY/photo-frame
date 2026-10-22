# 技术文档 · 留白边框水印工坊

> 面向**开发者与维护者**。用户视角的说明见根目录 [`README.md`](../README.md)，平台封装说明见
> [`macos/README.md`](../macos/README.md) 与 [`pwa/README.md`](../pwa/README.md)，封装可行性论证见
> [`docs/packaging-feasibility.md`](./packaging-feasibility.md)。

本文档描述：整体架构、代码分区、数据流、关键算法、主题系统、三端封装、测试体系，以及有记录价值的
设计决策与踩坑。

---

## 目录

1. [项目概览](#1-项目概览)
2. [整体架构](#2-整体架构)
3. [代码分区（index.html 内部结构）](#3-代码分区indexhtml-内部结构)
4. [数据流](#4-数据流)
5. [关键算法](#5-关键算法)
6. [主题系统](#6-主题系统)
7. [三端封装](#7-三端封装)
8. [测试体系](#8-测试体系)
9. [设计决策与踩坑记录](#9-设计决策与踩坑记录)

---

## 1. 项目概览

| 项 | 值 |
|---|---|
| 定位 | 给照片加边框与参数水印的本地网页工具 |
| 代码形态 | **单文件** `index.html`（HTML + CSS + JS 全内联，约 3400+ 行 / 139 KB） |
| 运行时依赖 | **零**。无 npm 运行时依赖、无 CDN 资源、无外链字体/图片/CSS/JS |
| 构建步骤 | 无。直接打开即可运行 |
| 数据安全 | 照片全程浏览器本地处理，不上传任何服务器 |
| 平台形态 | 网页版（`index.html`）+ macOS 原生 App（`macos/`）+ PWA（`sw.js`） |

**设计原则（贯穿所有平台封装）**：`index.html` 是唯一真源。macOS 与 PWA 都**不改动**网页源码，
只提供不同的运行环境。任何功能改动只发生在 `index.html` 一处。

---

## 2. 整体架构

```
                          ┌────────────────────────────────────┐
                          │           index.html（单文件）        │
  用户输入                │  ┌──────┐  ┌──────┐  ┌───────────┐  │
  ──────────►            │  │ 导入  │  │ 状态  │  │  模板系统  │  │
  文件/拖放/粘贴/快捷键     │  │ 解码  │─►│ state │─►│ TPL_ICONS │  │
                          │  └──┬───┘  └──┬───┘  └─────┬─────┘  │
                          │     │EXIF      │            │        │
                          │  ┌──▼───┐  ┌──▼────────┐  ┌▼─────┐  │
                          │  │ EXIF │  │ 布局/绘制  │  │ 撤销  │  │
                          │  │解析器│  │drawTextBand│  │/重做 │  │
                          │  └──────┘  └──┬────────┘  └───────┘  │
                          │              ▼                        │
                          │        ┌────────────┐                 │
                          │        │  preview   │──► canvas       │
                          │        │  (rAF 节流) │                 │
                          │        └─────┬──────┘                 │
                          │              ▼                        │
                          │   ┌──────────────────────┐            │
                          │   │  导出 (toBlob/ZIP32)  │──► 文件    │
                          │   └──────────────────────┘            │
                          └────────────────────────────────────┘

   运行环境（不改源码，只提供容器）：
   ┌──────────────────┐   ┌──────────────────┐   ┌──────────────┐
   │  macOS（原生）    │   │  PWA（安卓/iPhone）│   │   浏览器      │
   │  Swift+WKWebView │   │  manifest + SW    │   │  直接打开     │
   └──────────────────┘   └──────────────────┘   └──────────────┘
```

核心思想是**单向数据流**：`状态 state` 是唯一数据源，任何控件改动 → 更新 `state` → 触发
`scheduleRender()`（`requestAnimationFrame` 节流）→ 重绘 canvas 预览。导出时不依赖预览 canvas，
而是按当前 `state` **独立重算**合成结果，因此导出画质与预览解耦。

---

## 3. 代码分区（index.html 内部结构）

`index.html` 用 `/* ==== 分隔注释 ==== */` 划成 18 个逻辑分区。维护时**在分区内定位代码**最省时间：

| 分区 | 行号（约） | 职责 |
|---|---|---|
| CSS 主题变量 | ~90–348 | 浅色/深色两套 CSS 变量，见[主题系统](#6-主题系统) |
| 移动端竖屏 CSS | ~349–649 | `@media (max-width:860px)` 预览在上、参数在下 |
| **0. 常量与工具** | ~650–895 | `FONTS`、颜色归一化 `normColor`、对比度计算、`$()` 选择器等 |
| **1. EXIF 解析** | ~896–1196 | 零依赖 TIFF/EXIF 解析器，见[关键算法](#5-关键算法) |
| **2. 应用状态** | ~1197–1243 | 全局 `state` 对象（items/current/所有控件值） |
| **3. 面板构建** | ~1244–1461 | `TPL_ICONS` 模板图标、控件渲染 |
| **3.5 撤销/重做** | ~1462–1619 | `HISTORY_MAX=60`，命令式快照 |
| **4. 我的模板** | ~1620–1727 | localStorage 持久化（`photoframe.presets.v1`） |
| **5. 标识（品牌识别）** | ~1728–1898 | `currentBrand()` 从 EXIF 推断机型/镜头文字 |
| **6. 文件导入与解码** | ~1899–2048 | 拖放/`<input>`/`createImageBitmap`/HEIC 分支 |
| **7. 标识图片上传** | ~2049–2099 | logo 图片、SVG 处理 |
| **8. 布局** | ~2100–2257 | `paddingsFor()` 五种模板的留白/参数条几何 |
| **9. 绘制** | ~2258–2520 | `drawTextBand()` 文字带、边框、参数合成 |
| **10. 预览渲染** | ~2521–2716 | `scheduleRender()` rAF 节流 |
| **11. 缩略图** | ~2717–2790 | 底部缩略图条 |
| **12. 导出** | ~2791–3048 | `outDims()` 尺寸预设、单张导出、ZIP32 批量 |
| **12.5 粘贴导入与快捷键** | ~3049–3127 | `renamePasted()`、键盘绑定 |
| **13. 启动** | ~3128–3345 | `buildPanel()`、事件绑定、`boot()` |
| 外观主题 | ~3346+ | 主题切换、`matchMedia` 监听、`registerSW()` |

> 分区编号 3.5、12.5 是历史迭代自然形成的命名，非笔误。

---

## 4. 数据流

### 4.1 导入 → 显示

```
文件/拖放/粘贴
   │
   ├─ 读取 ArrayBuffer
   ├─ parseExif(buffer)          // 提取 EXIF（有则缓存）
   ├─ 解码：
   │     ├─ createImageBitmap() 成功 → 直接用
   │     └─ 失败且是 HEIC → 懒加载 heic2any（联网，8s 超时兜底）
   ├─ 构造 item { bitmap, file, exif, ... } 推入 state.items
   ├─ state.current = 最新项
   └─ scheduleRender() → 重绘
```

### 4.2 控件交互 → 预览

```
控件事件 → 更新 state（字段/颜色/滑杆值）
        → history.pushSnapshot()（可撤销操作）
        → scheduleRender()
        → requestAnimationFrame 合并多次改动 → 单次重绘
```

### 4.3 导出

```
导出当前：outDims() 定尺寸 → 独立 canvas 合成 → toBlob
        →（keepExif 开启）原地改写 Orientation/像素尺寸 → saveBlob()

批量导出：遍历 items → 逐个 toBlob → 内存拼 ZIP32 → 单次下载
```

**关键点**：导出用**独立 canvas**，与预览 canvas 无关，因此预览缩放、DPR 等不影响导出结果。

---

## 5. 关键算法

### 5.1 EXIF 解析（零依赖自实现，分区 1）

自写 TIFF 结构解析器，不引入 `exifr`/`exif-js` 等库。要点：

- **字节序**：读取前两字节 `II`（小端）或 `MM`（大端），后续所有整数读取据此选择。
- **IFD 遍历**：从 `tiffHeaderOffset` 进入 IFD0，读取条目数，逐个 `tag + type + count + valueOffset`
  解析；`0x8769`（ExifIFDPointer）指向子 IFD，递归进入。
- **标签映射**（本项目用到的）：
  - IFD0：`0x010F`（Make）、`0x0110`（Model）、`0x0132`（DateTime 兜底）
  - Exif 子 IFD：`0x9003`（DateTimeOriginal）、`0x9004`（DateTimeDigitized）、
    `0x829A`（ExposureTime）、`0x829D`（FNumber）、`0x8827`（ISO）、`0x920A`（FocalLength）、
    `0xA434`（LensModel）、`0xA432`（LensSpecification）
  - GPS IFD：经纬度（度/分/秒有理数 → 十进制）
- **拍摄日期优先级**：`DateTimeOriginal` → `DateTime` → 系统当前时间。
  > 曾有一个 bug：`0x9003/0x9004` 写在 Exif 子 IFD，却误放到 IFD0 循环里读，永远读不到，
  > 导致日期回退到系统时间。修复后补了回归断言。

### 5.2 手写 ZIP32 打包器（分区 12）

批量导出刻意**不用** CDN 上的 zip 库（如 JSZip），以保持离线。自实现要点：

- **ZIP32 格式**：本地文件头（Local File Header）+ 数据 + 中央目录（Central Directory）+
  结束记录（End of Central Directory）。
- **CRC32 自算**：用查表法计算每个条目的 CRC32 校验值。
- **store 模式**（不压缩）：因为 JPEG/PNG 本身已压缩，再 DEFLATE 收益极低，直接原样存储。
- **无数据描述符**：写入时已知大小与 CRC，可省略 streaming 场景才需要的数据描述符标志位。
- 整个 ZIP 在内存中拼接，最后 `toBlob` 一次导出（见 `packaging-feasibility.md` 关于
  Android 端 base64 过桥会放大 1.33 倍的讨论）。

### 5.3 边框色取自照片（主色量化）

- 将照片缩到极小尺寸绘制到离屏 canvas，`getImageData` 采样像素。
- 对像素做量化/聚类，取占比最高的主色作为边框默认色。
- 配合 `normColor()` 做颜色归一（HEX ↔ RGB 互转、亮度计算）。

### 5.4 EXIF 原地改写（保留拍摄信息）

导出 JPEG 且勾选"保留 EXIF"时，不重新生成 EXIF，而是**在原始 JPEG 字节上原地改写**：

- **Orientation**：把方向标志重写为 1，避免二次打开时又被旋转。
- **像素尺寸**：更新 EXIF 里的宽高字段，与导出后尺寸一致。
- 支持大小端两种字节序（测试双测覆盖）。
- 非 JPEG（PNG/WebP）无法承载 EXIF 时，跳过此步骤。

### 5.5 预览渲染节流（分区 10）

`scheduleRender()` 用 `requestAnimationFrame` 合并一帧内的多次状态改动，避免拖滑杆时
逐事件重绘造成卡顿。`rafPending` 标志防重入。

---

## 6. 主题系统

- **CSS 变量双层定义**：`:root`（浅色默认）+ `[data-theme="dark"]`（深色），变量覆盖
  背景、面板、文字、边框、组件底色等全部颜色。
- **跟随系统**：`matchMedia('(prefers-color-scheme: dark)')` 监听系统外观；用户手动切换后
  以用户选择为准，写入 `localStorage`（`photoframe.theme.v1`）持久化。
- **canvas 绘制不读 CSS 变量**：绘制用的颜色来自 `state` 中的具体色值，而非 CSS 变量，
  因此导出结果与界面主题解耦——切主题不影响已合成照片的颜色。
- **macOS 侧同步**：`WebShell.swift` 通过 `ThemeBridge` 把页面 `data-theme` 上报给原生层，
  原生层据此设置 `NSWindow.appearance`（深色 Aqua / 浅色 Aqua），使**窗口标题栏与页面主题一致**。
  > 曾有一个 bug：页面切深色后，窗口控制按钮那行仍是白色。根因是只改了网页 DOM，没同步
  > `NSWindow.appearance`。修复后加入自测断言。

---

## 7. 三端封装

### 7.1 网页版（`index.html`）

直接 `open index.html`。走 `file://` 协议，`localStorage` 可用但 origin 不稳（不同启动路径
origin 可能变化）——网页版场景可接受，因为"我的模板"只做轻量持久化。

### 7.2 macOS 原生 App（`macos/`）

- **技术栈**：Swift + AppKit + WKWebView，通用二进制（`x86_64 arm64`），ad-hoc 签名。
- **关键实现**（`WebShell.swift`）：
  - **自定义 scheme** `pfframe://app/index.html`：保证 `localStorage` 拥有稳定 origin
    （`file://` 在不同路径下 origin 会变）。
  - **断网拦截**：`WKContentRuleList` 拦截所有 http/https/ws 请求，应用完全离线。
  - **文件选择**：原生 `NSOpenPanel` 喂回 `input[type=file]` 的 `FileList`，网页代码零感知。
  - **导出下载**：`a[download]` + `blob:` URL 触发 `WKDownloadDelegate`，走原生保存面板。
  - **HEIC**：WKWebView（macOS 14+）原生解码 HEIC，**无需** `heic2any`，完全离线。
- **系统要求**：macOS 14 Sonoma+（HEIC 原生解码依赖 Safari 17+ 能力）。
- **构建**：`macos/build.sh` 一键产出 `dist/留白.app`。

### 7.3 PWA（安卓/iPhone）

- **资产**（放仓库根，因 manifest 的 scope 要求）：
  - `manifest.webmanifest`：名称、图标、主题色、`display: standalone`。
  - `sw.js`：App Shell 预缓存 + cache-first 策略，**不拦截** jsDelivr（HEIC 解码器走网络）。
- **接入点**：`index.html` `<head>` 的 manifest 链接 + `boot()` 里调 `registerSW()`，
  检测 `isSecureContext` 后注册，新 SW 安装完成后 `SKIP_WAITING` + 自动 reload。
- **图标**：`pwa/icons/` 4 个尺寸（192/512/512-maskable/apple-touch-180），由 `gen-icons.swift`
  用 WebView 渲染 + `sips` 缩放生成。
- **限制**：需要 HTTPS 或 localhost；安卓 WebView 不解 HEIC，仍需联网拉 `heic2any`。

> 原生 Android App（Kotlin + WebView）尚未实现，方案见 `packaging-feasibility.md` 第四节。

---

## 8. 测试体系

`package.json` 声明唯一 devDependency `jsdom`，全部测试脚本基于 `import.meta.url` 解析项目路径，
仓库放哪儿都能跑。

| 命令 | 断言数 | 依赖 | 负责什么 |
|---|---|---|---|
| `npm test` | ~340 | jsdom | 在 jsdom 里真实执行 `index.html`，断言渲染与交互 |
| `npm run test:layout` | ~42 | 真实 Chrome | 布局回归（`clientWidth/Height` 在 jsdom 恒 0，只有真浏览器能抓） |
| `npm run test:dark` | ~9 | 真实 Chrome | 深色主题对比度审计 + 组件底色随主题变化 |
| `npm run test:offline` | ~12 | 真实 Chrome | CDP 抓运行时网络请求 + 断网模拟 |
| `npm run test:pwa` | ~22 | 真实 Chrome | manifest 字段、图标尺寸、SW 注册/预缓存/离线兜底 |
| `npm run test:all` | 全量 | — | 五套串联 |

**每套测试的边界与为什么缺一不可**：

- **jsdom 冒烟**：加了 `toBlob`/`getImageData` 桩，所以文件体积、主色提取的断言有意义。
  但 jsdom 不跑布局、不跑完整 CSS 级联、`clientWidth` 恒 0。
- **layout**：专门抓"内容驱动高度 + padding 单边计算"导致的预览自放大 bug。
  注意陷阱：CDP `Emulation.setDeviceMetricsOverride` 会掩盖该 bug，必须同时覆盖真实窗口与覆盖视口。
- **dark**：对比度沿祖先链找第一个不透明层、opacity 沿链累乘；抓漏改的硬编码色。
- **offline**：静态 grep 只能证明"源码没写 http://"，证明不了运行时行为，必须 CDP 抓真实请求。
- **pwa**：验证 manifest/SW/图标/secure context 检测。

macOS 原生侧另有 `macos/tests/run-selftest.mjs`（32 项：应用内自测 19 + 独立核对产物 8 +
跨进程持久化 1 + 正常启动 3）。

**测试注意事项**：layout/dark/offline/pwa 需要拉起真实 Chrome，在沙箱里可能因 Chrome 写不了
自己的临时目录而退出码非 0——判断通过与否看输出末尾「通过 N 项，失败 M 项」，不要看退出码。

---

## 9. 设计决策与踩坑记录

以下是有长期价值的决策与坑，按主题记录。更完整的当日记录见会话工作区的
`.workbuddy/memory/` 日志。

### 决策

1. **单文件、零依赖**：一切以"双击就能用、离线可跑"为最高优先级。ZIP 打包、EXIF 解析都
   自实现，只为不引入 CDN/npm 依赖。
2. **导出与预览解耦**：导出用独立 canvas 按 `state` 重算，预览缩放不影响导出画质。
3. **`index.html` 是唯一真源**：macOS/PWA 都只提供运行环境，不复制/改动网页逻辑。
4. **HEIC 采用平台原生解码优先**（macOS），网页版保留 CDN 兜底，Android 端规划用
   `ImageDecoder`——不把带 LGPL/HEVC 专利的 `heic2any` 打进 App。
5. **ZIP 用 store 模式**：JPEG/PNG 已压缩，再压缩无收益，直接原样存储省 CPU。

### 踩坑

1. **EXIF 日期标签放错 IFD**：`0x9003/0x9004` 在 Exif 子 IFD，误放 IFD0 循环导致永远读不到，
   日期回退系统时间。教训：解析器标签归属要用规范核对，并补回归断言。
2. **布局自放大正反馈**：预览容器高度由内容驱动，计算可用空间时 padding 只算单边，形成每轮
   +24px 的正反馈，连点模板预览图一圈圈放大。只有真浏览器 layout 回归能抓（jsdom 抓不到）。
3. **CDP 覆盖视口掩盖 bug**：`Emulation.setDeviceMetricsOverride` 会让 `100dvh` 恰等于视口，
   auto 行不再溢出，从而掩盖布局 bug。回归必须双模式覆盖。
4. **深色标题栏不同步**：网页切深色后原生窗口标题栏仍白。需把 `data-theme` 上报原生层并同步
   `NSWindow.appearance`。
5. **并行编辑同一文件导致静默损坏**：多次并行 `Edit` 同一文件会互相覆盖、落地不全。改为串行单点
   编辑并复查。
6. **测试脚本提取错 script**：非全局正则抓到第一个 `<script>`。给目标 `<script>` 加 `id` 后
   按 id 提取。
7. **WKWebView 注册时机**：`WKURLSchemeHandler` 必须在创建 `WKWebView` **之前**注册。
8. **沙箱 git index.lock**：沙箱内 git 无法删除自己创建的 `.git/index.lock`，每条 git 命令前
   需 `rm -f .git/index.lock`（详见用户级记忆）。
9. **heic2any 体积**：磁盘 1.32 MB，CDN 走 Brotli 后实际传输约 323 KB。曾被误报为"约 100 KB"。

---

## 附录：关键文件清单

```
photo-frame/
├── index.html              # 唯一真源：HTML+CSS+JS 全内联，18 个分区
├── manifest.webmanifest    # PWA 清单（放根，因 scope 要求）
├── sw.js                   # Service Worker：App Shell 预缓存 + cache-first
├── package.json            # 仅声明 jsdom；测试脚本入口
├── docs/
│   ├── technical-architecture.md   # 本文档
│   └── packaging-feasibility.md    # 封装可行性分析（macOS/Android）
├── macos/                  # macOS 原生 App（Swift + WKWebView）
│   ├── src/{main,AppDelegate,WebShell,IconRender,SelfTest}.swift
│   ├── build.sh            # 一键构建通用二进制 .app
│   └── tests/run-selftest.mjs
├── pwa/                    # PWA 图标与工具
│   ├── icons/              # 192/512/512-maskable/apple-touch-180
│   ├── gen-icons.swift
│   └── tests/check-pwa.mjs
└── tests/                  # 网页版五套测试
    ├── smoke-photoframe.mjs        # jsdom 冒烟（~340 项）
    ├── check-preview-size.mjs      # 布局回归（真实 Chrome）
    ├── check-dark-theme.mjs        # 深色主题审计
    ├── check-offline.mjs           # 联网行为审计
    └── shot-*.mjs / repro-trace.mjs # 截图与排查辅助工具
```
