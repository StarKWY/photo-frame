/* ============================================================
   SelfTest.swift —— 应用自测（app --selftest）

   为什么必须有这个：现有 403 项断言全是针对浏览器的，而封装后最核心的
   「文件打开 / 保存导出」两条路径变成了原生代码 —— jsdom 测不到，
   现有 CDP 脚本也测不到。所以壳自己得能验自己。

   覆盖：页面启动 / 结构渲染 / origin 有效（localStorage 可写）/
         WebKit 层断网确实生效 / 打开面板走通 / HEIC 系统原生解码 /
         导出落盘 / 批量导出 ZIP / 主题切换 / 无 JS 报错
   ============================================================ */

import AppKit
import WebKit

final class SelfTestRunner {

    private let shell: WebShell
    private let outDir: URL
    private let phase: Int
    private var results: [(String, Bool, String)] = []

    init(shell: WebShell, outDir: URL, phase: Int) {
        self.shell = shell
        self.outDir = outDir
        self.phase = phase
    }

    func start(completion: @escaping (Bool) -> Void) {
        Task { @MainActor in
            let ok = self.phase == 2 ? await self.runStorageProbe() : await self.run()
            completion(ok)
        }
    }

    // MARK: - 基础设施

    @discardableResult
    private func check(_ key: String, _ ok: Bool, _ detail: String = "") -> Bool {
        let d = detail
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "|", with: "/")
        results.append((key, ok, d))
        print("PFTEST|\(key)|\(ok ? "PASS" : "FAIL")|\(d)")
        fflush(stdout)
        return ok
    }

    @MainActor private func js(_ code: String) async -> Any? {
        await withCheckedContinuation { c in
            shell.webView.evaluateJavaScript(code) { r, _ in c.resume(returning: r) }
        }
    }

    @MainActor private func jsAsync(_ body: String) async -> Any? {
        await withCheckedContinuation { c in
            shell.webView.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { r in
                c.resume(returning: try? r.get())
            }
        }
    }

    @MainActor private func waitUpTo(_ seconds: Double, _ cond: @escaping () async -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if await cond() { return true }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return await cond()
    }

    @MainActor private func pageReady(seconds: Double = 40) async -> Bool {
        await waitUpTo(seconds) {
            let v = await self.js("""
            (function(){ try {
              return document.readyState === 'complete'
                  && document.querySelectorAll('#tplGrid .tpl').length > 0;
            } catch(e){ return false; } })()
            """) as? Bool
            return v == true
        }
    }

    private static func dict(_ raw: String?) -> [String: Any] {
        guard let raw, let d = raw.data(using: .utf8),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return [:] }
        return o
    }

    private static func arr(_ raw: String?) -> [[String: Any]] {
        guard let raw, let d = raw.data(using: .utf8),
              let o = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]] else { return [] }
        return o
    }

    // MARK: - 第二阶段：只核对 localStorage 是否跨进程存活

    @MainActor private func runStorageProbe() async -> Bool {
        guard await pageReady() else {
            print("PF_STORAGE_READ <page-not-ready>")
            return false
        }
        let v = await js("""
        (function(){ try { return localStorage.getItem('photoframe.selftest.v1') || ''; }
                     catch(e){ return 'ERR:' + e.message; } })()
        """) as? String
        print("PF_STORAGE_READ \(v ?? "")")
        fflush(stdout)
        return !(v ?? "").isEmpty
    }

    // MARK: - 主流程

    @MainActor private func run() async -> Bool {

        // ---------- 1. 页面启动 ----------
        let ready = await pageReady()
        check("页面加载并完成启动", ready,
              ready ? "readyState=complete，模板卡片已渲染" : "40 秒内未就绪")
        guard ready else { return summary() }

        let info = Self.dict(await js("""
        JSON.stringify({
          tpl: document.querySelectorAll('#tplGrid .tpl').length,
          tabs: document.querySelectorAll('#tabs button').length,
          badge: (document.getElementById('privacyBadge') || {}).textContent || '',
          shell: (window.__PF_SHELL__ || {}).platform || 'none',
          offlineFlag: !!(window.__PF_SHELL__ || {}).offline,
          missing: ['saveBlob','addFiles','exportCurrent','exportAll','undo','redo']
                     .filter(function(n){ return typeof window[n] !== 'function'; }),
          theme: document.documentElement.getAttribute('data-theme') || ''
        })
        """) as? String)

        let tpl = (info["tpl"] as? NSNumber)?.intValue ?? 0
        let tabs = (info["tabs"] as? NSNumber)?.intValue ?? 0
        check("模板与标签页正常渲染", tpl >= 7 && tabs >= 5, "模板 \(tpl) 个、标签 \(tabs) 个")

        let missing = (info["missing"] as? [String]) ?? []
        check("页面关键函数可在壳内调用", missing.isEmpty,
              missing.isEmpty ? "saveBlob / addFiles / exportCurrent / exportAll / undo / redo 全部就位"
                              : "缺失：" + missing.joined(separator: ","))

        let shellMark = (info["shell"] as? String) ?? "none"
        let offlineFlag = (info["offlineFlag"] as? Bool) ?? false
        check("页面已识别出原生宿主", shellMark == "macos" && offlineFlag,
              "platform=\(shellMark) offline=\(offlineFlag)")

        let badge = (info["badge"] as? String) ?? ""
        check("隐私徽标已按离线事实改写", badge.contains("离线"), badge.isEmpty ? "未找到徽标" : badge)

        let theme0 = (info["theme"] as? String) ?? ""
        check("主题已初始化（无白闪）", theme0 == "light" || theme0 == "dark", "data-theme=\(theme0)")

        // ---------- 2. 断网是「强制」而不是「碰巧」 ----------
        let netResult = await jsAsync("""
        var ctl = new AbortController();
        var timer = setTimeout(function(){ ctl.abort(); }, 8000);
        try {
          var r = await fetch('https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js',
                              { signal: ctl.signal });
          clearTimeout(timer);
          return 'ALLOWED:' + r.status;
        } catch (e) {
          clearTimeout(timer);
          return ctl.signal.aborted ? 'TIMEOUT' : 'BLOCKED';
        }
        """) as? String
        check("WebKit 层已阻断对外网络请求", netResult == "BLOCKED",
              netResult == "BLOCKED" ? "对外 fetch 被内容拦截规则拒绝" : "实际结果：\(netResult ?? "nil")")

        // ---------- 3. origin 有效 + 持久化写入 ----------
        let token = "pf-\(Int(Date().timeIntervalSince1970))-\(Int.random(in: 1000...9999))"
        let wrote = await js("""
        (function(){ try {
          localStorage.setItem('photoframe.selftest.v1', '\(token)');
          return localStorage.getItem('photoframe.selftest.v1');
        } catch(e){ return 'ERR:' + e.message; } })()
        """) as? String
        check("localStorage 可写（origin 有效）", wrote == token,
              wrote == token ? "写入并读回一致" : "读回：\(wrote ?? "nil")")
        print("PF_STORAGE_TOKEN \(token)")
        fflush(stdout)

        // ---------- 4. 打开面板 → HEIC 系统原生解码 ----------
        let primed = self.shell.primedCount
        await js("document.getElementById('fileInput').click(); 'ok'")
        let imported = await waitUpTo(30) {
            let n = await self.js("""
            (function(){ try { return state.items.length; } catch(e){ return -1; } })()
            """) as? NSNumber
            return (n?.intValue ?? -1) >= primed && primed > 0
        }
        check("原生打开面板回填到页面", imported && primed > 0,
              imported ? "经 WKUIDelegate 导入 \(primed) 个文件" : "30 秒内未导入")

        _ = await waitUpTo(30) {
            let v = await self.js("""
            (function(){ try {
              return state.items.every(function(i){ return i.status !== 'loading'; });
            } catch(e){ return false; } })()
            """) as? Bool
            return v == true
        }

        let items = Self.arr(await js("""
        JSON.stringify(state.items.map(function(i){
          return { name: i.name, status: i.status,
                   conv: !!i.heicConverted, err: i.error || '',
                   w: (i.full && i.full.width) || 0, h: (i.full && i.full.height) || 0 };
        }))
        """) as? String)

        let allReady = !items.isEmpty && items.allSatisfy { ($0["status"] as? String) == "ready" }
        check("导入的照片全部就绪", allReady,
              items.map { "\($0["name"] as? String ?? "?")=\($0["status"] as? String ?? "?")" }
                   .joined(separator: " "))

        let heicItems = items.filter { (($0["name"] as? String) ?? "").lowercased().hasSuffix(".heic") }
        let heicDecoded = heicItems.first.map {
            (($0["w"] as? NSNumber)?.intValue ?? 0) > 0 && ($0["conv"] as? Bool) != true
                && (($0["err"] as? String) ?? "").isEmpty
        } ?? false
        check("HEIC 由系统原生解码（未走 CDN）", heicDecoded,
              heicItems.first.map { "\($0["w"] as? NSNumber ?? 0)×\($0["h"] as? NSNumber ?? 0) conv=\($0["conv"] as? Bool ?? false)" }
                   ?? "样本中没有 .heic 文件")

        let heic2anyLoaded = await js("typeof window.heic2any !== 'undefined'") as? Bool
        check("未加载任何外部解码器", heic2anyLoaded == false,
              heic2anyLoaded == true ? "window.heic2any 竟然存在" : "window.heic2any 未定义")

        // ---------- 5. 导出：单张 ----------
        let before1 = shell.finishedFiles.count
        await js("exportCurrent(); 'ok'")
        let ok1 = await waitUpTo(40) { self.shell.finishedFiles.count > before1 }
        let f1 = shell.finishedFiles.last
        check("导出当前照片已落盘", ok1 && f1 != nil,
              f1.map { "\($0.lastPathComponent)（\(fileSize($0)) 字节）" } ?? "未产生文件")

        // ---------- 6. 导出：批量打包 ----------
        let before2 = shell.finishedFiles.count
        await js("exportAll(); 'ok'")
        let ok2 = await waitUpTo(90) { self.shell.finishedFiles.count > before2 }
        let bundle = shell.finishedFiles.dropFirst(before2).first
        check("批量导出已落盘", ok2 && bundle != nil,
              bundle.map { "\($0.lastPathComponent)（\(fileSize($0)) 字节）" } ?? "未产生文件")

        let isZip = bundle?.pathExtension.lowercased() == "zip"
        check("批量导出为 ZIP 包", isZip,
              isZip ? "扩展名 .zip" : "实际扩展名：\(bundle?.pathExtension ?? "无")")

        // ---------- 7. 主题切换 ----------
        let t1 = await js("document.documentElement.getAttribute('data-theme')") as? String
        await js("document.getElementById('btnTheme').click(); 'ok'")
        try? await Task.sleep(nanoseconds: 500_000_000)
        let t2 = await js("document.documentElement.getAttribute('data-theme')") as? String
        check("主题切换生效", t1 != nil && t2 != nil && t1 != t2, "\(t1 ?? "nil") → \(t2 ?? "nil")")

        // ---------- 8. 全程无 JS 报错 ----------
        let errs = (await js("JSON.stringify(window.__pfErrors || [])") as? String) ?? "[]"
        let errList = (try? JSONSerialization.jsonObject(with: Data(errs.utf8))) as? [String] ?? []
        check("全程无 JavaScript 报错", errList.isEmpty,
              errList.isEmpty ? "0 条" : errList.prefix(3).joined(separator: " / "))

        check("导出过程无失败记录", shell.failedFiles.isEmpty,
              shell.failedFiles.isEmpty ? "0 次失败"
                                        : shell.failedFiles.map { "\($0.0):\($0.1)" }.joined(separator: " "))

        // ---------- 9. 界面截图 ----------
        // 功能断言通过 ≠ 布局没崩。存一张实际渲染图，人能看、也能做视觉回归。
        _ = await js("(function(){ try { setTab('photo'); return 1; } catch(e){ return 0; } })()")
        try? await Task.sleep(nanoseconds: 1_200_000_000)
        let shotPath = outDir.appendingPathComponent("app-screenshot.png").path
        let shotOK = await snapshot(to: shotPath)
        check("已生成界面截图（可用于视觉复核）", shotOK,
              shotOK ? shotPath : "截图失败")

        return summary()
    }

    /// 把 WebView 当前内容截一张图
    @MainActor private func snapshot(to path: String) async -> Bool {
        await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            let cfg = WKSnapshotConfiguration()
            cfg.rect = shell.webView.bounds
            shell.webView.takeSnapshot(with: cfg) { image, error in
                guard let image, error == nil else {
                    c.resume(returning: false)
                    return
                }
                c.resume(returning: PngWriter.write(image, to: path))
            }
        }
    }

    private func fileSize(_ url: URL) -> Int {
        (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
    }

    @MainActor private func summary() -> Bool {
        let failed = results.filter { !$0.1 }
        print("PF_SUMMARY \(results.count - failed.count)/\(results.count) 通过")
        for f in failed { print("PF_FAILED \(f.0) → \(f.2)") }
        fflush(stdout)
        return failed.isEmpty
    }
}
