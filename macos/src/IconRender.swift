/* ============================================================
   IconRender.swift —— 用 WebView 渲染 App 图标

   与其手写光栅代码画圆角和渐变，不如用 HTML/CSS 画好再截一张图 ——
   WKWebView 的渲染质量比手搓高得多，代价只有几十行。
   ============================================================ */

import AppKit
import WebKit
import ImageIO

/// NSImage → PNG 落盘（图标渲染与界面截图共用）
enum PngWriter {
    @discardableResult
    static func write(_ image: NSImage, to path: String) -> Bool {
        var rect = CGRect(x: 0, y: 0, width: image.size.width, height: image.size.height)
        guard let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
            print("PNG_ERR 无法取得 CGImage")
            return false
        }
        let url = URL(fileURLWithPath: path)
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
            print("PNG_ERR 无法创建 PNG 输出")
            return false
        }
        CGImageDestinationAddImage(dest, cg, nil)
        guard CGImageDestinationFinalize(dest) else {
            print("PNG_ERR PNG 写入失败")
            return false
        }
        return true
    }
}

final class IconRenderer: NSObject, WKNavigationDelegate {

    private static var keepAlive: IconRenderer?

    private let out: String
    private let done: (Bool) -> Void
    private let size: CGFloat = 1024
    private var web: WKWebView!
    private var win: NSWindow!

    private init(out: String, done: @escaping (Bool) -> Void) {
        self.out = out
        self.done = done
        super.init()
    }

    static func render(to path: String, completion: @escaping (Bool) -> Void) {
        let r = IconRenderer(out: path, done: completion)
        keepAlive = r            // 渲染期间必须持有，否则会被提前释放
        r.begin()
    }

    private func begin() {
        let cfg = WKWebViewConfiguration()
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: size, height: size), configuration: cfg)
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")   // 圆角外要透明

        win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: size, height: size),
                       styleMask: [.borderless], backing: .buffered, defer: false)
        win.contentView = web
        win.setFrameOrigin(NSPoint(x: -20000, y: -20000))   // 挪到屏幕外，别闪一下
        win.orderFront(nil)

        web.loadHTMLString(Self.html, baseURL: nil)

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { self.snap() }
    }

    private func snap() {
        let sc = WKSnapshotConfiguration()
        sc.rect = CGRect(x: 0, y: 0, width: size, height: size)
        sc.snapshotWidth = NSNumber(value: Double(size))
        web.takeSnapshot(with: sc) { image, error in
            guard let image, error == nil else {
                print("ICON_ERR 截图失败：\(String(describing: error))")
                self.finish(false)
                return
            }
            self.finish(self.write(image))
        }
    }

    private func write(_ image: NSImage) -> Bool {
        var rect = CGRect(x: 0, y: 0, width: image.size.width, height: image.size.height)
        guard let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
            print("ICON_ERR 无法取得 CGImage")
            return false
        }
        guard PngWriter.write(image, to: out) else { return false }
        print("ICON_WROTE \(out) \(Int(cg.width))x\(Int(cg.height))")
        return true
    }

    private func finish(_ ok: Bool) {
        win?.orderOut(nil)
        let cb = done
        IconRenderer.keepAlive = nil
        cb(ok)
    }

    // MARK: - 图标美术

    private static let html = """
    <!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;width:1024px;height:1024px;overflow:hidden;background:transparent}
      .sq{
        position:absolute;inset:0;border-radius:228px;
        background:linear-gradient(158deg,#FCFBF7 0%,#F0EEE6 52%,#E1DED3 100%);
        box-shadow:inset 0 -10px 26px rgba(90,80,60,.10), inset 0 10px 26px rgba(255,255,255,.95);
        display:flex;align-items:center;justify-content:center;
      }
      .photo{
        width:600px;height:600px;border-radius:82px;position:relative;overflow:hidden;
        background:linear-gradient(152deg,#3A3934 0%,#1D1D1B 58%,#121211 100%);
        box-shadow:0 20px 48px rgba(24,20,12,.30), 0 3px 8px rgba(24,20,12,.20);
      }
      .sun{position:absolute;left:106px;top:98px;width:128px;height:128px;border-radius:50%;
           background:radial-gradient(circle at 34% 30%,#F8DDBB,#D8904F 72%);
           box-shadow:0 0 46px rgba(216,144,79,.45)}
      .m1{position:absolute;left:-52px;bottom:-124px;width:530px;height:346px;
          border-radius:132px 132px 0 0;transform:rotate(-16deg);
          background:linear-gradient(180deg,#95938A,#65635B)}
      .m2{position:absolute;right:-104px;bottom:-152px;width:480px;height:308px;
          border-radius:118px 118px 0 0;transform:rotate(13deg);
          background:linear-gradient(180deg,#C2BFB2,#9C998E)}
      .cap{position:absolute;left:106px;bottom:92px;width:198px;height:17px;border-radius:9px;
           background:rgba(247,243,233,.94)}
      .cap2{position:absolute;left:106px;bottom:62px;width:122px;height:13px;border-radius:7px;
            background:rgba(247,243,233,.46)}
    </style></head><body>
    <div class="sq"><div class="photo">
      <div class="sun"></div><div class="m1"></div><div class="m2"></div>
      <div class="cap"></div><div class="cap2"></div>
    </div></div>
    </body></html>
    """
}
