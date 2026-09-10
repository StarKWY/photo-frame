# 留白 · 边框水印工坊

给照片加边框和参数水印的单文件网页工具。**照片全程在浏览器本地处理，不上传任何服务器**——双击 `index.html` 就能用，不需要装任何东西。

> **🍎 macOS 用户**：项目已包含原生 `.app` 封装，见 [`macos/`](macos/)。构建后双击 `dist/留白.app` 即可，完全离线，Dock 里也有图标。

## 它解决什么

PixFrame、Lenso Pro、EXIFrame 这类 app 做的是同一件事：把照片放进好看的边框里，附上相机、镜头、光圈、快门这些拍摄参数，方便发社交平台。这个工具是它们的免费替代，而且不用把照片传到别人服务器上。

## 用法

```bash
open index.html
```

或者直接在访达里双击。

### 支持的模板

| 模板 | 形态 |
|---|---|
| 极简留白 | 纯留白边，参数压角 |
| 参数条 | 底部参数条，信息密度高 |
| 相纸 | 装裱细线 + 居中文字，模拟冲印相纸 |
| 浮层 | 文字浮于照片之上的半透明层 |
| 胶片 | 胶片齿孔与边框 |

### 主要能力

- **EXIF 自动读取**：零依赖自写解析器，读出相机/镜头/光圈/快门/ISO 并自动填充
- **文字任意取色**：原生拾色器 + hex 手输 + 屏幕吸管 + 最近使用色
- **边框色取自照片**：量化取样照片主色
- **导出预计大小**：控件一动先给估算，静默后用真实编码量校正
- **导出尺寸预设**：原图 / 2560 / 2048 / 1440 / 1080
- **保留 EXIF**：导出 JPEG 时原地改写 Orientation 与像素尺寸，保留拍摄信息
- **批量导出**：多选或直接 `Cmd+V` 粘贴导入，打成一个 ZIP
- **撤销 / 重做**：`Cmd+Z` / `Shift+Cmd+Z`
- **快捷键**：`1`–`7` 切模板、`R` 循环比例、`E` 导出、`C` 打包、`/` 全屏、`Esc` 退出
- **移动端竖屏**：图片在上、参数在下

## 测试

```bash
npm install           # 只装 jsdom，用于 jsdom 冒烟测试
npm test              # 340 项冒烟断言（jsdom）
npm run test:layout   # 42 项真实浏览器布局回归   ┐
npm run test:dark     #  9 项深色主题对比度审计   ├ 都需要本机装了 Chrome
npm run test:offline  # 12 项联网行为审计         ┘
npm run test:all      # 四套一起跑
```

测试脚本一律基于**自身位置**解析项目路径（`import.meta.url`），所以仓库放在哪儿都能跑，不需要改任何配置。

### 四套测试各自负责什么

- **`tests/smoke-photoframe.mjs`** —— 在 jsdom 里真实执行 `index.html`，断言渲染结果与交互行为。覆盖 EXIF 解析、模板渲染、颜色归一与对比度、撤销重做、尺寸预设、字节估算、CRC32 与 ZIP 字节结构、EXIF 原地改写（大小端双测）、快捷键、粘贴、批量导出与取消。**加了 `toBlob` / `getImageData` 桩**，所以文件体积和主色提取的断言是有意义的，不是空转。
- **`tests/check-preview-size.mjs`** —— 真实 Chrome 里跑布局回归。**jsdom 的 `clientWidth/Height` 恒为 0，这类 bug 只有它能抓**：曾经有个「每点一次边框样式，预览图就放大一圈」的问题，根因是预览容器高度由内容驱动、而计算可用空间时 padding 只算了单边，形成每轮 +24px 的正反馈。6 组视口 × 连点 12 次模板，断言同模板幂等、容器高度恒定、画布不超容器内容盒。

  > 注意陷阱一：CDP 的 `Emulation.setDeviceMetricsOverride` 会**掩盖**这个 bug（覆盖视口后 `100dvh` 恰等于视口，auto 行不再溢出）。所以回归必须同时覆盖「真实窗口」和「覆盖视口」两种模式。
  >
  > 注意陷阱二：它要拉起真实 Chrome，**在沙箱里可能因 Chrome 写不了自己的 `code_sign_clone` 临时目录而退出码非 0**。判断是否通过看输出末尾的「通过 N 项，失败 M 项」，不要看退出码。
- **`tests/check-dark-theme.mjs`** —— 真实 Chrome 里做主题审计：逐个元素实测「文字色 / 实际背景色」的对比度（背景沿祖先链找第一个不透明层，opacity 沿链累乘），断言深色下正文全部达到 WCAG AA；并断言**所有带底色的组件都随主题改变**，用来抓漏改的硬编码色。jsdom 不做布局也不跑完整样式级联，这类问题只有它看得见。
- **`tests/check-offline.mjs`** —— 用 CDP 的 Network 域记录**运行时真实发出的每一个请求**，证明正常路径零外部请求；再用 `Network.emulateNetworkConditions({offline:true})` **模拟完全断网**跑完整流程，验证下面「关于联网」那节的说法。静态 grep 只能证明"源码里没写 http://"，证明不了运行时行为。

### 辅助工具

`tests/shot-photoframe.mjs` 生成注入好状态的预览页；`tests/shot-cdp.mjs` 和 `tests/shot-canvas.mjs` 用 CDP 驱动无头 Chrome 截图，后者只截预览画布本身（@2x），用来近距离核对文字落位；`tests/repro-trace.mjs` 打印每次点击后的高度链，排查布局反馈用。

## 关于联网

**只有一种情况需要联网：导入 HEIC / HEIF 照片，且当前浏览器不能原生解码它。**

实测数据（`npm run test:offline` 可复现）：

| 环节 | 是否需要联网 |
|---|---|
| 界面渲染 | 否。纯系统字体，无 `@font-face` / `@import` / 外链 CSS / 外链 JS |
| JPG / PNG / WebP / TIFF / AVIF 导入与解码 | 否。走浏览器原生 `createImageBitmap` + canvas |
| 边框与水印合成 | 否 |
| 批量导出打包 ZIP | 否。手写 ZIP32 编码器（自算 CRC32），刻意不用 CDN 上的 zip 库 |
| **HEIC / HEIF 解码** | **是**——但只在浏览器自己解不了的时候 |

HEIC 这一条的细节：

- 触发条件是「`createImageBitmap` 解不开这个 HEIC」。**实测本机 Chrome 解不开**（Safari 等
  原生支持 HEIC 的浏览器不会触发）。
- 触发时从 jsDelivr 拉一次 `heic2any`。文件本身 1.32 MB，但 CDN 走 Brotli 压缩，
  **实际传输约 323 KB**（实测），之后走浏览器缓存。
- **下载的是解码库，不是你的照片**——照片始终没有离开本机，解码在本地完成。
- 有 8 秒超时兜底，失败会明确提示「HEIC 解码失败，需联网加载解码器」，不会卡住界面，
  也不影响其它格式的照片继续处理。

所以：**断网时除 HEIC 外的全部功能可用**；要处理 HEIC 就联一次网，或者先把 HEIC 在
系统相册里导出成 JPG 再拖进来。

## 结构

```
index.html          # 全部代码：HTML + CSS + JS，无构建步骤
tests/              # 测试与截图工具
package.json        # 仅声明 jsdom
```

## 开发记录

这个项目的设计决策与踩坑记录（例如上面那个自放大 bug 的完整根因链路、为什么用自写 ZIP 编码器替掉 CDN 库、并行编辑同一文件导致的静默损坏）保存在
`~/WorkBuddy/2026-09-10-17-01-09/.workbuddy/memory/2026-09-10.md`。
