/* ============================================================
   gen-icons.swift —— 生成 PWA 图标集（独立工具，不依赖 macOS app）

   复用 macOS 版的图标美术，但 PWA 图标要求：
   - 方形不透明背景（手机桌面/抽屉里是圆角方，不能靠透明圆角）
   - maskable 版：核心图形缩进到 80% 安全区内，避免被系统裁成圆/胶囊
   - 多尺寸：192 / 512 / 512-maskable / 180(apple-touch)

   用法：swiftc -O gen-icons.swift -o /tmp/gen-icons && /tmp/gen-icons <输出目录>
   ============================================================ */

import AppKit
import WebKit
import ImageIO

final class Gen: NSObject, WKNavigationDelegate {
    private static var keepAlive: Gen?

    private var jobs: [(name: String, size: Int, maskable: Bool, bg: String)] = []
    private var outDir = ""
    private var idx = 0
    private var web: WKWebView!
    private var win: NSWindow!
    private var failed = false

    static func main(outDir: String) {
        let g = Gen()
        g.outDir = outDir
        g.jobs = [
            ("icon-192.png", 192, false, "#FCFBF7"),
            ("icon-512.png", 512, false, "#FCFBF7"),
            ("icon-512-maskable.png", 512, true, "#3A3934"),
            ("apple-touch-icon.png", 180, false, "#FCFBF7"),
        ]
        keepAlive = g
        g.renderNext()
    }

    /// WKWebView 在 Retina 屏会以 2x 像素密度出图，所以 manifest 声明的 192px
    /// 图标实际生成出来是 384px。manifest 的 sizes 与实际像素必须严格匹配
    /// （不匹配会被一些启动器忽略），所以截图写盘后用 sips 精确缩放到目标尺寸。
    private func resizeToExact(_ path: String, size: Int) -> Bool {
        let p = Process()
        p.launchPath = "/usr/bin/env"
        p.arguments = ["sips", "-z", String(size), String(size), path]
        let err = Pipe()
        p.standardError = err
        p.standardOutput = Pipe()
        do { try p.run() } catch { return false }
        p.waitUntilExit()
        return p.terminationStatus == 0
    }

    private func renderNext() {
        guard idx < jobs.count else {
            finish()
            return
        }
        let job = jobs[idx]
        let size = job.size

        let cfg = WKWebViewConfiguration()
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: size, height: size), configuration: cfg)
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")

        win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: size, height: size),
                       styleMask: [.borderless], backing: .buffered, defer: false)
        win.contentView = web
        win.setFrameOrigin(NSPoint(x: -20000, y: -20000))
        win.orderFront(nil)

        web.loadHTMLString(html(size: size, maskable: job.maskable, bg: job.bg), baseURL: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [weak self] in self?.snap() }
    }

    private func snap() {
        let job = jobs[idx]
        let size = job.size
        let sc = WKSnapshotConfiguration()
        sc.rect = CGRect(x: 0, y: 0, width: size, height: size)
        sc.snapshotWidth = NSNumber(value: Double(size))
        web.takeSnapshot(with: sc) { [weak self] image, error in
            guard let self else { return }
            guard let image, error == nil else {
                print("ICON_ERR \(job.name) 截图失败：\(String(describing: error))")
                self.failed = true
                self.idx += 1
                self.renderNext()
                return
            }
            var rect = CGRect(x: 0, y: 0, width: size, height: size)
            guard let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
                print("ICON_ERR \(job.name) 无法取得 CGImage")
                self.failed = true
                self.idx += 1
                self.renderNext()
                return
            }
            let path = (self.outDir as NSString).appendingPathComponent(job.name)
            let url = URL(fileURLWithPath: path)
            guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
                print("ICON_ERR \(job.name) 无法创建输出")
                self.failed = true
                self.idx += 1
                self.renderNext()
                return
            }
            CGImageDestinationAddImage(dest, cg, nil)
            guard CGImageDestinationFinalize(dest) else {
                print("ICON_ERR \(job.name) PNG 写入失败")
                self.failed = true
                self.idx += 1
                self.renderNext()
                return
            }
            // Retina 屏上快照是 2x 像素密度，sips 缩放到精确目标尺寸
            if !self.resizeToExact(path, size: job.size) {
                print("ICON_ERR \(job.name) sips 缩放失败")
                self.failed = true
                self.idx += 1
                self.renderNext()
                return
            }
            print("ICON_WROTE \(path) \(Int(cg.width))x\(Int(cg.height)) maskable=\(job.maskable)")
            self.win?.orderOut(nil)
            self.web = nil
            self.win = nil
            self.idx += 1
            self.renderNext()
        }
    }

    private func finish() {
        win?.orderOut(nil)
        Gen.keepAlive = nil
        exit(failed ? 1 : 0)
    }

    // MARK: - 图标美术（复用 macOS 版，加 maskable 安全区缩放）

    private func html(size: Int, maskable: Bool, bg: String) -> String {
        // maskable：整个画面作为背景色，核心图形缩到 80% 居中（安全区）
        let scale: Double = maskable ? 0.80 : 1.0
        let inner = Int(Double(size) * scale)
        let pad = (size - inner) / 2
        // 核心图形内部比例基于 1024 设计稿
        let k = Double(inner) / 1024.0

        func s(_ v: Double) -> String { String(format: "%.1f", v * k) }

        return """
        <!doctype html><html><head><meta charset="utf-8"><style>
          html,body{margin:0;padding:0;width:\(size)px;height:\(size)px;overflow:hidden;background:\(bg)}
          .stage{position:absolute;left:\(pad)px;top:\(pad)px;width:\(inner)px;height:\(inner)px}
          .sq{
            position:absolute;inset:0;border-radius:\(s(228))px;
            background:linear-gradient(158deg,#FCFBF7 0%,#F0EEE6 52%,#E1DED3 100%);
            box-shadow:inset 0 -\(s(10))px \(s(26))px rgba(90,80,60,.10), inset 0 \(s(10))px \(s(26))px rgba(255,255,255,.95);
            display:flex;align-items:center;justify-content:center;
          }
          .photo{
            width:\(s(600))px;height:\(s(600))px;border-radius:\(s(82))px;position:relative;overflow:hidden;
            background:linear-gradient(152deg,#3A3934 0%,#1D1D1B 58%,#121211 100%);
            box-shadow:0 \(s(20))px \(s(48))px rgba(24,20,12,.30), 0 \(s(3))px \(s(8))px rgba(24,20,12,.20);
          }
          .sun{position:absolute;left:\(s(106))px;top:\(s(98))px;width:\(s(128))px;height:\(s(128))px;border-radius:50%;
               background:radial-gradient(circle at 34% 30%,#F8DDBB,#D8904F 72%);
               box-shadow:0 0 \(s(46))px rgba(216,144,79,.45)}
          .m1{position:absolute;left:-\(s(52))px;bottom:-\(s(124))px;width:\(s(530))px;height:\(s(346))px;
              border-radius:\(s(132))px \(s(132))px 0 0;transform:rotate(-16deg);
              background:linear-gradient(180deg,#95938A,#65635B)}
          .m2{position:absolute;right:-\(s(104))px;bottom:-\(s(152))px;width:\(s(480))px;height:\(s(308))px;
              border-radius:\(s(118))px \(s(118))px 0 0;transform:rotate(13deg);
              background:linear-gradient(180deg,#C2BFB2,#9C998E)}
          .cap{position:absolute;left:\(s(106))px;bottom:\(s(92))px;width:\(s(198))px;height:\(s(17))px;border-radius:\(s(9))px;
               background:rgba(247,243,233,.94)}
          .cap2{position:absolute;left:\(s(106))px;bottom:\(s(62))px;width:\(s(122))px;height:\(s(13))px;border-radius:\(s(7))px;
                background:rgba(247,243,233,.46)}
        </style></head><body>
        <div class="stage"><div class="sq"><div class="photo">
          <div class="sun"></div><div class="m1"></div><div class="m2"></div>
          <div class="cap"></div><div class="cap2"></div>
        </div></div></div>
        </body></html>
        """
    }
}

let args = CommandLine.arguments
let outDir = args.count > 1 ? args[1] : "."
try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
Gen.main(outDir: outDir)
RunLoop.main.run()
