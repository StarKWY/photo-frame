# 封装为 macOS 应用 / Android App 的可行性分析

> 结论先行：**技术上高度可行，且这个项目比绝大多数网页更适合封装**——单文件、零依赖、
> 全部本地处理、只用到 4 个浏览器能力。真正的成本不在技术，而在**上架门槛**、
> **HEIC 的处理方式**、以及**长期的双份维护**。

---

## 一、先看先天条件：这个项目为什么好封装

| 特征 | 实测值 | 对封装的意义 |
|---|---|---|
| 代码形态 | 单文件 `index.html`，139 KB / 3427 行 | 直接塞进 WebView，无需构建 |
| 依赖 | **零**运行时依赖 | 没有 npm 供应链、没有版本冲突 |
| 联网 | 仅 HEIC 一处（见第五节） | 天然离线应用 |
| 资源 | 无外链图片/CSS/字体 | 打包就是复制一个文件 |

**用到的浏览器能力一共只有这些**（已全量扫描）：

```
createImageBitmap(3)  toBlob(1)  toDataURL(1)  createObjectURL(2)
matchMedia(3)  localStorage(9)
```

**没有**用到：`OffscreenCanvas` / `Web Worker` / `File System Access API` /
`CompressionStream` / IndexedDB / `navigator.share` / `navigator.clipboard`。

这是好消息——API 面越窄，WebView 的兼容性风险越小。**只有 4 个地方需要原生接管**：

| # | Web 侧现状 | 为什么必须接管 |
|---|---|---|
| 1 | `<input type="file" id="fileInput" multiple>` + `logoInput` + `jsonInput` | WebView 不会自动弹系统选择器，要接原生回调 |
| 2 | `saveBlob()` → `a[download]` 点击 | **`blob:` URL 的下载在 WebView 里不生效**，两端都要接原生保存 |
| 3 | 拖放 `drop` / 粘贴 `paste` | 桌面端可用；Android 上基本用不到，可降级 |
| 4 | `maxPixels()` 返回 1 亿像素 | 这个上限是给桌面浏览器的，手机上会 **OOM** |

其余全部（EXIF 自写解析器、边框合成、手写 ZIP32 打包、撤销重做、模板系统）都是纯 JS，
**跨平台零改动**。

---

## 二、必须改的代码（工作量清单）

| 改造点 | 现状 | macOS 侧 | Android 侧 | 难度 |
|---|---|---|---|---|
| 文件选择 | 3 个隐藏 `<input type=file>` | WKWebView **原生支持**，通常零改动 | 需实现 `WebChromeClient.onShowFileChooser` | 低 / 中 |
| 保存导出 | `a[download]` | WKWebView（macOS 11.3+）支持 `download` 属性，需接 `WKDownloadDelegate` | **完全不支持**，必须 JS 桥 + 原生写 MediaStore | 中 / **高** |
| HEIC 解码 | CDN 拉 heic2any | **原生支持**（Safari 17+/macOS 14+），可删掉这段逻辑 | WebView 不支持 → 走原生 `ImageDecoder` | 低 / 中 |
| 像素上限 | 桌面 1 亿像素 | 保持 | **必须下调**（建议 1600 万～2400 万） | 低 |
| 系统外观跟随 | 已有 `prefers-color-scheme` | 自动生效 | 需把系统深浅色同步进 WebView | 低 |
| 安全区 / 刘海 | 有 `env(safe-area-inset)` 式布局 | 无需 | 需处理沉浸式状态栏与手势区 | 低 |
| 返回键 | 无 | 无需 | 需接管：优先关面板，而不是直接退出 | 低 |
| 分享到相册/其他 App | 无（Web 没这能力） | 可加 | **建议加**，比"下载到目录"更符合直觉 | 中 |

**核心工程量集中在第 2 行（保存）和第 3 行（HEIC）**，其余都是小活。

---

## 三、macOS 方案对比

| 方案 | 包体积 | 内存占用 | 改造量 | 适用 |
|---|---|---|---|---|
| **Tauri v2**（Rust + 系统 WKWebView） | 约 5–10 MB | 低（共享系统 WebView） | **最小**，前端基本原样 | 推荐 |
| 原生 Swift + WKWebView 壳 | 约 2–5 MB | 最低 | 小，但要写 Swift | 想要极简 & 完全掌控 |
| Electron | 100 MB+ | 高（自带 Chromium） | 最小 | 不推荐，为一个 139 KB 页面背 100 MB |

**无论哪种，分发都要过 Apple 这道关：**

- **Apple Developer Program：99 美元/年**，个人或公司同价（企业计划 299 美元/年，此处不需要）。
- 非 App Store 分发（.dmg / .zip 直接给用户）必须：**Developer ID 证书签名 + 启用 Hardened Runtime + 公证（notarization）+ 钉票据（staple）**。
- 自 macOS 10.15 Catalina 起，**未公证的 App 用户双击打不开**（只有右键-打开或去系统设置里放行）。
  所以除非只给自己用，否则这 99 美元是省不掉的。
- 若走 Mac App Store：还需额外过 App Review，并启用 **App Sandbox**（文件访问要声明 entitlement）。

**自己用的话**：直接 `codesign -s -`（ad-hoc 签名）本地构建即可，零成本，但换了机器或系统大版本升级可能要重新构建。

---

## 四、Android 方案对比

| 方案 | 说明 | 改造量 |
|---|---|---|
| **原生 Kotlin + WebView** | 最直接，完全掌控桥接 | 中（推荐） |
| Capacitor | 现成的 WebView 容器 + 插件生态 | 小，但多一层抽象和依赖 |
| TWA（Trusted Web Activity） | **不适用**：要求页面托管在线上，与离线单文件定位冲突 | — |

### 4.1 三个必须做对的技术点

**(1) 不要用 `file://` 加载，改用 `WebViewAssetLoader`**

`file://` 来源是 **opaque origin**，会导致 `localStorage` 不可靠——
而本项目用它存「我的模板」和主题偏好（9 处调用）。

```kotlin
// 用 https://appassets.androidplatform.net/ 这个虚拟来源，拿到正常的安全上下文
webView.loadUrl("https://appassets.androidplatform.net/assets/index.html")
```

**(2) 文件选择的实现**

```kotlin
webChromeClient = object : WebChromeClient() {
    override fun onShowFileChooser(
        wv: WebView, cb: ValueCallback<Array<Uri>>,
        params: FileChooserParams
    ): Boolean {
        // 用 ActivityResultContracts.OpenMultipleDocuments() 起系统选择器
        // 走 SAF，因此不需要 READ_MEDIA_IMAGES 权限
    }
}
```

用 SAF（Storage Access Framework）的好处：**零权限**。Android 13+ 的媒体权限、Android 10 的
分区存储，全都绕开了。

**(3) 保存导出（最大的坑）**

`blob:` URL 在 Android WebView 里**不会触发 `DownloadListener`**，所以 `a.click()` 静默失效。
必须改成：canvas → `toDataURL`/ArrayBuffer → JS 桥 → 原生写文件。

```kotlin
class Bridge {
    @JavascriptInterface
    fun saveFile(base64: String, name: String, mime: String) { /* 写 MediaStore */ }
}
```

写成 **ZIP 的批量导出**要注意：整个 ZIP 在内存里拼好后要 base64 过桥，会**翻 1.33 倍**。
20 张 2048px 的图约 30 MB → base64 后 40 MB，勉强可行，但**更好的做法是直接传字节数组**
（`@JavascriptInterface` 支持 `ByteArray`？不支持，得用 `WebMessage` + `ArrayBuffer`，
或分片传）。这是需要专门设计的部分。

### 4.2 上架门槛（比技术难）

| 项目 | 要求 |
|---|---|
| 注册费 | **25 美元，一次性**，无年费 |
| 目标 API 级别 | **自 2026-08-31 起，新应用与更新必须 target Android 16（API 36）或更高** |
| 打包格式 | 必须 AAB（Android App Bundle），不再是 APK |
| 签名 | 强制启用 Play App Signing（Google 托管最终签名密钥） |
| **个人账号额外要求** | **开通后需先找至少 12 名测试者、连续测试 14 天**，才能申请正式发布；且需通过 Play Console 手机 App 验证你有一台真实 Android 设备 |
| 隐私合规 | 需填 Data Safety 表单、提供隐私政策链接（涉及照片属敏感数据，必须如实申报"不上传"） |

> 那 12 名测试者 × 14 天，对个人项目是**实打实的时间成本**——不是交钱就能上。

**不想上架的话**：直接发 APK 侧载，零成本、当天可用。代价是用户要在系统设置里允许
"未知来源"，且没有自动更新。

---

## 五、HEIC 专项：唯一的联网点怎么处理（重点）

现状：`index.html` 在浏览器解不开 HEIC 时，从 jsDelivr 懒加载 `heic2any`。
封装成 App 后**不能保留这个行为**——用户会认为"装在手机里的 App 不该联网"。

### 三条路线

| 路线 | 做法 | 优点 | 风险 |
|---|---|---|---|
| A. 保留 CDN | 不改 | 零成本 | App 仍依赖网络；离线不可用；观感差 |
| B. 内置 heic2any | 打包进资源 | 行为一致，跨平台统一 | **1.32 MB**（实测磁盘体积；CDN 走 Brotli 后实际传输约 323 KB）；内嵌 `libheif`（LGPL-3.0）→ 有开源合规义务；HEVC 有专利池问题 |
| C. **用平台原生解码器** | macOS 交给 WebKit；Android 交给 `ImageDecoder` | **零体积、零许可风险、更快** | Android 侧"设备相关"（见下） |

### 推荐 C，理由与细节

**macOS**：Safari 17（macOS 14 Sonoma）起，WKWebView 原生支持 HEIC 渲染。
所以 Tauri / Swift 壳上**把 heic2any 那段逻辑整个删掉**即可，APP 变成 100% 离线。

**Android**：WebView **完全不支持 HEIC**（Capacitor 官方论坛原话："the WebView under
Android does not support the heic format at all"）。但 Android 系统本身支持——
`android.graphics.ImageDecoder`（API 28+）官方文档明确把 HEIF 列入支持的格式。

做法：在 JS 桥里加一个 `decodeHeic(bytes) → JPEG bytes`，用原生解码后把 JPEG 交给 WebView。

```kotlin
val src = ImageDecoder.createSource(ByteBuffer.wrap(heicBytes))
val bmp = ImageDecoder.decodeBitmap(src)
// 压成 JPEG 回传给 JS
```

**关键注意事项**：Android 的 HEIC 支持标注为**"设备相关"**——它依赖设备的 HEVC 解码器。
主流机型（2019 年后）都有硬件解码，但**低端机可能缺失**。
所以必须保留降级路径：原生解码失败时，给出明确提示（"此设备无法解码 HEIC，请先导出为 JPG"），
而不是白屏或崩溃。

> 顺带说明为什么**不建议**选 B：把 1.32 MB 的 libheif/wasm 打进 App，除了体积，
> 还意味着你在**分发一个 HEVC 解码器**——HEVC 的专利授权由 MPEG LA / Access Advance 等
> 专利池管理。用系统解码器则是"使用操作系统能力"，许可责任在 OS 厂商那边。
> 这是选 C 最主要的非技术理由。

---

## 六、风险清单（按严重程度排序）

| # | 风险 | 说明 | 应对 |
|---|---|---|---|
| 1 | **Android 内存溢出** | `maxPixels()` 现在允许 1 亿像素 = 400 MB RGBA；再加 ZIP 全内存拼接，必炸 | 加 Android 分支下调上限；ZIP 流式写盘 |
| 2 | **保存路径体验** | Web 的"下载"概念在手机上不成立 | 用 MediaStore 直接进相册；或做"分享" |
| 3 | **上架合规** | Data Safety / 隐私政策 / 12×14 测试 | 提前准备，或先走侧载 |
| 4 | HEVC 专利与 LGPL | 仅当选路线 B 才出现 | 选路线 C 规避 |
| 5 | 系统版本依赖 | HEIC 原生支持需 macOS 14+ / Android 9+ | 明确最低版本；旧系统降级提示 |
| 6 | **长期双份维护** | 一次封装不难，难的是**以后每改一次网页，要验两个平台** | 见第七节 |

> 第 6 条是最容易被低估的。现在这个项目有 **403 项自动化断言**，但那些都是针对浏览器跑的。
> 封装后，**"文件选择"和"保存导出"这两条最核心的路径反而没有自动化覆盖**——
> 它们变成了原生代码，jsdom 测不到，CDP 也测不到（WebView 里的桥接行为不同）。
> 这是维护成本的真正来源。

---

## 七、建议路线

**如果目标是"自己/小范围用"** —— 建议先做 **PWA**，性价比最高：

- 加 `manifest.json` + 一个 Service Worker，就能"添加到主屏幕"，全屏运行、有图标、离线可用。
- macOS：Safari 里"添加到程序坞"，Safari 17+ 原生解 HEIC，**连联网问题都自动消失**。
- Android：Chrome 里"添加到主屏幕"，但 HEIC 仍需 CDN（WebView/Chrome for Android 都不支持）。
- **成本：半天以内**。可以先用它验证"是否真的有人需要在手机/桌面上用"，再决定要不要投入原生封装。

**如果确定要做原生 App**：

1. **macOS 先行**（工作量最小、体验提升明确）：Tauri v2，删掉 HEIC 联网逻辑，
   接 `WKDownloadDelegate` 处理导出。需要 99 美元/年才能分发给别人。
2. **Android 随后**：原生 Kotlin 壳 + `WebViewAssetLoader` + SAF 选择器 +
   MediaStore 保存 + `ImageDecoder` 解码 HEIC + 下调像素上限。
3. **上架前**：先侧载自测，确认 12×14 测试要求能凑齐再交 25 美元。

**不建议**：为这个体量的页面引入 Electron（100 MB 换 139 KB 的页面）。

---

## 八、需要先明确的问题

这份分析里有几个分叉点，取决于你的实际目标：

1. **只给自己用，还是要分发给别人？**
   - 自己用：macOS 侧可跳过签名公证（省 99 美元/年），Android 侧直接侧载（省 25 美元 + 免掉 12×14 测试）
   - 给别人用：Apple 99 美元/年 + Google 25 美元一次性，且必须过公证与 Play 审核
2. **是否必须支持 HEIC？** 如果主要用户是 iPhone 转过来的照片，HEIC 是刚需；
   如果自己拍的照片都是 JPG，Android 侧可以完全不碰 HEIC，工程量和风险都大幅下降。
3. **手机端的使用场景是什么？** 桌面端"拖入大量照片批量加边框"是核心场景；
   手机上更可能是"选一张照片快速加边框然后分享到社交平台"——
   如果是后者，界面还需要为触屏重新设计（现在的三栏布局是按鼠标设计的）。

---

## 附：本次分析的事实依据

| 结论 | 来源 |
|---|---|
| Google Play 自 2026-08-31 起要求 target API 36 | Google Play 目标 API 级别要求（官方文档） |
| Play 注册费 25 美元一次性；个人账号需 12 测试者 × 14 天 | Google Play Console 注册与测试要求（官方帮助中心） |
| Apple Developer Program 99 美元/年；非商店分发须公证 | Apple 公证文档；Developer ID 要求 |
| Android WebView 不支持 HEIC | Capacitor 官方论坛；caniuse（Chrome for Android 未支持 HEIF） |
| Android `ImageDecoder` 支持 HEIF，API 28+，设备相关 | Android 官方 API 文档；Android 9 功能说明 |
| Safari 17+ / WKWebView 支持 HEIC | caniuse；LambdaTest HEIF 兼容性表 |
| heic2any 体积 1.32 MB、自包含、内嵌 libheif | 实测：下载 dist 文件 + 解析包内容清单 |
| 本项目 API 使用面、`maxPixels` 上限、保存实现 | 实测：对 `index.html` 全量扫描 |
