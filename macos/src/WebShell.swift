/* ============================================================
   WebShell.swift —— WKWebView 宿主与原生桥

   设计要点（均由 spike 实测确定，不是推测）：

   1. 页面来源用自定义 scheme `pfframe://app/`，而不是 file://。
      这样 origin 与安装路径无关（朋友把 .app 挪个位置也不会丢 localStorage），
      而且同一个 origin 还能顺带把「用户拖进来的文件」喂给页面 ——
      外部文件走 `pfframe://app/__ext/?p=<路径>`，同 host 因此不触发跨域。

   2. 网络用 WKContentRuleList 在 WebKit 层硬阻断。这是「保证不联网」，
      而不只是「观察到没联网」。注意 WebKit 的规则正则不支持析取（`|`），
      所以一条协议写一条规则。

   3. 页面的 saveBlob() 一行都不用改：实测 a[download] + blob: 会触发
      WKDownloadDelegate，WebKit 自己把数据流式写盘 —— 没有 base64 膨胀，
      批量导出几百 MB 的 ZIP 也不会撑爆内存。

   4. 三个 <input type=file> 全部走 WKUIDelegate.runOpenPanelWith。

   5. 坑：scheme handler 与 user script 必须在创建 WKWebView **之前**注册
      （WebView 会拷贝配置）。所以 scheme 处理拆成了独立的 SchemeServer，
      否则拿不到 self、只能注册在 WebView 创建之后 —— 那样等于没注册。
   ============================================================ */

import AppKit
import WebKit
import UniformTypeIdentifiers

// MARK: - 自定义 scheme 服务

/// 只服务两处：
///   pfframe://app/<相对路径>          → 应用自带资源（index.html 等）
///   pfframe://app/__ext/?p=<绝对路径> → 用户显式授权过的本地文件
final class SchemeServer: NSObject, WKURLSchemeHandler {

    let resourceDir: URL
    private var allowed = Set<String>()
    private let verbose: Bool

    init(resourceDir: URL, verbose: Bool) {
        self.resourceDir = resourceDir
        self.verbose = verbose
        super.init()
    }

    /// 用户通过打开面板 / 拖入 / 应用图标打开而授权给页面的路径
    func allow(_ path: String) { allowed.insert(path) }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, url.host == "app" else {
            return fail(task, "未知来源")
        }

        if url.path.hasPrefix("/__ext") {
            let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
            guard let p = comps?.queryItems?.first(where: { $0.name == "p" })?.value else {
                return fail(task, "外部文件请求缺少路径参数")
            }
            guard allowed.contains(p) else {
                return fail(task, "该文件未获授权")
            }
            return serve(task, at: URL(fileURLWithPath: p))
        }

        let rel = url.path.isEmpty ? "/index.html" : url.path
        let target = resourceDir.appendingPathComponent(String(rel.dropFirst())).standardizedFileURL
        guard target.path.hasPrefix(resourceDir.standardizedFileURL.path) else {
            return fail(task, "路径越界")
        }
        serve(task, at: target)
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func serve(_ task: WKURLSchemeTask, at fileURL: URL) {
        guard let data = try? Data(contentsOf: fileURL) else {
            return fail(task, "读不到文件：\(fileURL.lastPathComponent)")
        }
        let header = [
            "Content-Type": Self.mimeType(for: fileURL.pathExtension),
            "Content-Length": String(data.count),
            "Cache-Control": "no-cache",
            "Access-Control-Allow-Origin": "*",
        ]
        guard let u = task.request.url,
              let resp = HTTPURLResponse(url: u, statusCode: 200,
                                         httpVersion: "HTTP/1.1", headerFields: header) else {
            return fail(task, "构造响应失败")
        }
        if verbose { print("PF_SERVE \(u.absoluteString) → \(data.count)B") }
        task.didReceive(resp)
        task.didReceive(data)
        task.didFinish()
    }

    private func fail(_ task: WKURLSchemeTask, _ reason: String) {
        if verbose { print("PF_SERVE_FAIL \(task.request.url?.absoluteString ?? "?") \(reason)") }
        task.didFailWithError(NSError(domain: "pfframe", code: 404,
                                      userInfo: [NSLocalizedDescriptionKey: reason]))
    }

    private static func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html"
        case "js", "mjs":   return "text/javascript"
        case "css":         return "text/css"
        case "json":        return "application/json"
        case "png":         return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp":        return "image/webp"
        case "gif":         return "image/gif"
        case "svg":         return "image/svg+xml"
        case "avif":        return "image/avif"
        case "tif", "tiff": return "image/tiff"
        case "heic":        return "image/heic"
        case "heif":        return "image/heif"
        case "ico":         return "image/x-icon"
        default:            return "application/octet-stream"
        }
    }
}

// MARK: - 宿主

final class WebShell: NSObject {

    let webView: WKWebView

    private let config: WKWebViewConfiguration
    private let server: SchemeServer
    private let mode: String
    private let verbose: Bool

    /// 自测模式下保存面板不弹，直接落到这个目录
    private var autoSaveDir: URL?

    /// 自测用：打开面板的自动应答队列
    private var openPanelQueue: [URL] = []
    private var primedTotal = 0
    var primedCount: Int { primedTotal }

    /// 已落盘的导出文件（自测据此断言）
    private(set) var finishedFiles: [URL] = []
    private(set) var failedFiles: [(String, String)] = []

    // 批量导出时避免连弹 N 个保存面板
    private var pendingDest: [ObjectIdentifier: URL] = [:]
    private var panelOpen = false
    private var queuedRequests: [(WKDownload, String, (URL?) -> Void)] = []
    private var recentDir: URL?
    private var recentDirAt = Date.distantPast

    // MARK: 构造

    init(mode: String, selfTestOut: URL?) {
        let verbose = selfTestOut != nil
        let dir = WebShell.resourceDir ?? URL(fileURLWithPath: "/")
        let srv = SchemeServer(resourceDir: dir, verbose: verbose)

        // ⚠️ 顺序有讲究：scheme handler 与 user script 必须在 WKWebView 创建前挂好，
        //    WebView 会把配置拷贝走，之后再改就无效了。所以这部分不能放到 super.init() 之后。
        let cfg = WKWebViewConfiguration()
        cfg.defaultWebpagePreferences.allowsContentJavaScript = true
        cfg.setURLSchemeHandler(srv, forURLScheme: "pfframe")
        cfg.userContentController.addUserScript(
            WKUserScript(source: WebShell.bootScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.userContentController.addUserScript(
            WKUserScript(source: WebShell.endScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))

        self.mode = mode
        self.verbose = verbose
        self.server = srv
        self.config = cfg
        self.autoSaveDir = selfTestOut?.appendingPathComponent("saves", isDirectory: true)
        self.webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1460, height: 940), configuration: cfg)
        super.init()

        if let autoSaveDir {
            try? FileManager.default.createDirectory(at: autoSaveDir, withIntermediateDirectories: true)
        }

        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        if #available(macOS 13.3, *) { webView.isInspectable = true }
    }

    // MARK: 注入脚本

    /// documentStart：标记宿主身份 + 装错误收集器
    private static let bootScript = """
    (function(){
      if (window.__PF_SHELL__) return;
      window.__PF_SHELL__ = { platform: 'macos', offline: true, version: '1.0.0' };
      window.__pfErrors = [];
      window.addEventListener('error', function(e){
        try { window.__pfErrors.push(String(e.message)); } catch(_) {}
      });
      window.addEventListener('unhandledrejection', function(e){
        try { window.__pfErrors.push('rejection: ' + String(e.reason)); } catch(_) {}
      });
    })();
    """

    /// documentEnd：隐私徽标改成实话实说（应用确实在 WebKit 层断网了）
    private static let endScript = """
    (function(){
      try {
        if (!window.__PF_SHELL__ || !window.__PF_SHELL__.offline) return;
        var b = document.getElementById('privacyBadge');
        if (b) b.textContent = '照片不出本机 · 应用完全离线运行';
      } catch (e) {}
    })();
    """

    // MARK: 加载

    func load() {
        // 在 WebKit 层硬阻断一切对外请求。
        // 注意：WebKit 的规则正则不支持析取（`|`），`^(https?|wss?)://.*` 会编译失败，
        // 必须一条协议写一条规则。
        let rules = """
        [
          {"trigger":{"url-filter":"^http://.*"},"action":{"type":"block"}},
          {"trigger":{"url-filter":"^https://.*"},"action":{"type":"block"}},
          {"trigger":{"url-filter":"^ws://.*"},"action":{"type":"block"}},
          {"trigger":{"url-filter":"^wss://.*"},"action":{"type":"block"}},
          {"trigger":{"url-filter":"^ftp://.*"},"action":{"type":"block"}}
        ]
        """
        WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "pfframe-offline", encodedContentRuleList: rules
        ) { list, err in
            DispatchQueue.main.async {
                if let list {
                    self.config.userContentController.add(list)
                    if self.verbose { print("PF_RULES_OK 离线拦截规则已生效") }
                } else {
                    print("PF_WARN 离线拦截规则编译失败：\(String(describing: err))")
                }
                self.loadPage()
            }
        }
    }

    private func loadPage() {
        if mode == "file", let dir = WebShell.resourceDir {
            if verbose { print("PF_LOAD file://\(dir.path)/index.html") }
            webView.loadFileURL(dir.appendingPathComponent("index.html"), allowingReadAccessTo: dir)
        } else {
            if verbose { print("PF_LOAD pfframe://app/index.html") }
            webView.load(URLRequest(url: URL(string: "pfframe://app/index.html")!))
        }
    }

    private static var resourceDir: URL? {
        if let r = Bundle.main.resourceURL { return r }
        let exe = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        return exe.deletingLastPathComponent()
    }

    // MARK: 工具

    func eval(_ js: String) {
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    func setPageZoom(_ z: Double) {
        webView.pageZoom = min(3.0, max(0.5, z))
    }

    func primeOpenPanel(with urls: [URL]) {
        openPanelQueue = urls
        primedTotal = urls.count
        urls.forEach { server.allow($0.path) }
    }

    /// 把外部文件喂给页面：先授权路径，再让页面 fetch 回来构造成 File。
    /// 走同源 URL 而不是 base64，几十 MB 的 RAW 也不会膨胀。
    func adoptExternalFiles(_ urls: [URL]) {
        let paths = urls.map { $0.path }
        guard !paths.isEmpty else { return }
        paths.forEach { server.allow($0) }
        let body = """
        var enc = function(p){ return 'pfframe://app/__ext/?p=' + encodeURIComponent(p); };
        var jobs = paths.map(function(p){
          var name = p.split('/').pop();
          return fetch(enc(p)).then(function(r){ return r.blob(); }).then(function(b){
            return new File([b], name, { type: b.type || 'application/octet-stream' });
          });
        });
        return await Promise.all(jobs).then(function(files){ return addFiles(files); }).then(function(){ return 'ok'; });
        """
        webView.callAsyncJavaScript(body, arguments: ["paths": paths], in: nil, in: .page) { _ in }
    }

    /// 打开面板允许的类型。
    /// webp / avif / RAW 用「按扩展名问系统」而不是写死 UTI 常量 ——
    /// 它们是后加的格式，写死常量在旧 SDK 上会编译不过，这样写更耐操。
    private static let imageTypes: [UTType] = {
        var t: [UTType] = [.image, .rawImage, .jpeg, .png, .tiff, .heic, .heif]
        for ext in ["webp", "avif", "cr2", "cr3", "nef", "arw", "raf", "dng", "orf", "rw2"] {
            if let u = UTType(filenameExtension: ext), !t.contains(u) { t.append(u) }
        }
        return t
    }()
}

// MARK: - 文件打开：三个 input[type=file] 都走这里

extension WebShell: WKUIDelegate {

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {

        // 自测：直接吃队列里的文件，不弹面板
        if !openPanelQueue.isEmpty {
            var urls = openPanelQueue
            openPanelQueue = []
            if !parameters.allowsMultipleSelection, let first = urls.first { urls = [first] }
            urls.forEach { server.allow($0.path) }
            completionHandler(urls)
            return
        }

        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsOtherFileTypes = true
        panel.message = "选择要加边框水印的照片"
        panel.prompt = "导入"
        panel.allowedContentTypes = WebShell.imageTypes

        let finish: (NSApplication.ModalResponse) -> Void = { resp in
            guard resp == .OK else { completionHandler(nil); return }
            let urls = panel.urls
            urls.forEach { self.server.allow($0.path) }
            completionHandler(urls)
        }

        if let w = webView.window {
            panel.beginSheetModal(for: w, completionHandler: finish)
        } else {
            finish(panel.runModal())
        }
    }
}

// MARK: - 导航诊断 + 导出保存

extension WebShell: WKNavigationDelegate, WKDownloadDelegate {

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if verbose { print("PF_NAV_OK") }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        print("PF_NAV_FAIL \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        print("PF_NAV_FAIL \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    // ------------------------------------------------------------------
    // 页面那句 `a[download]` + blob: 会落到这里。WebKit 自己把数据流式写盘，
    // 我们只负责决定写到哪个路径。
    // ------------------------------------------------------------------
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let name = Self.sanitize(suggestedFilename)

        // 自测模式：不弹面板，直接落盘
        if let dir = autoSaveDir {
            let url = Self.uniqueURL(in: dir, name: name)
            pendingDest[ObjectIdentifier(download)] = url
            completionHandler(url)
            return
        }

        // 刚保存过 → 当作同一次批量导出，复用一个目录，别连弹 N 个面板
        if let dir = recentDir, Date().timeIntervalSince(recentDirAt) < 4.0 {
            let url = Self.uniqueURL(in: dir, name: name)
            recentDirAt = Date()
            pendingDest[ObjectIdentifier(download)] = url
            completionHandler(url)
            return
        }

        // 已有面板开着 → 排队等它的结果
        if panelOpen {
            queuedRequests.append((download, name, completionHandler))
            return
        }

        panelOpen = true
        let panel = NSSavePanel()
        panel.nameFieldStringValue = name
        panel.canCreateDirectories = true
        panel.isExtensionHidden = false
        if let d = recentDir { panel.directoryURL = d }

        let finish: (NSApplication.ModalResponse) -> Void = { resp in
            self.panelOpen = false
            if resp == .OK, let url = panel.url {
                self.recentDir = url.deletingLastPathComponent()
                self.recentDirAt = Date()
                self.pendingDest[ObjectIdentifier(download)] = url
                completionHandler(url)
                // 同一批次的其余文件直接落到同一目录
                let dir = self.recentDir!
                let queued = self.queuedRequests
                self.queuedRequests = []
                for (d, n, cb) in queued {
                    let u = WebShell.uniqueURL(in: dir, name: n)
                    self.pendingDest[ObjectIdentifier(d)] = u
                    cb(u)
                }
            } else {
                completionHandler(nil)
                let queued = self.queuedRequests
                self.queuedRequests = []
                queued.forEach { $0.2(nil) }
            }
        }

        if let w = webView.window {
            panel.beginSheetModal(for: w, completionHandler: finish)
        } else {
            finish(panel.runModal())
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let url = pendingDest.removeValue(forKey: ObjectIdentifier(download)) {
            finishedFiles.append(url)
            print("PF_SAVED \(url.path)")
            fflush(stdout)
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let url = pendingDest.removeValue(forKey: ObjectIdentifier(download))
        failedFiles.append((url?.lastPathComponent ?? "?", error.localizedDescription))
        print("PF_SAVE_FAIL \(url?.lastPathComponent ?? "?") \(error.localizedDescription)")
        fflush(stdout)
    }

    // MARK: 文件名处理

    private static func sanitize(_ name: String) -> String {
        let cleaned = name
            .replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? "export" : cleaned
    }

    /// 同名时插入「 2」「 3」，不覆盖已有文件
    static func uniqueURL(in dir: URL, name: String) -> URL {
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var candidate = dir.appendingPathComponent(name)
        var n = 2
        while FileManager.default.fileExists(atPath: candidate.path) {
            let fn = ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)"
            candidate = dir.appendingPathComponent(fn)
            n += 1
        }
        return candidate
    }
}
