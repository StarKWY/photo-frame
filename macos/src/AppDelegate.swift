/* ============================================================
   AppDelegate.swift —— 应用委托、菜单栏、主窗口
   ============================================================ */

import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {

    private let isSelfTest: Bool
    private let outDir: URL?
    private let primeFiles: [URL]
    private let urlMode: String
    private let iconOut: String?
    private let phase: Int

    private var window: NSWindow!
    private var shell: WebShell!
    private var tester: SelfTestRunner?
    private var watchdog: DispatchSourceTimer?

    init(selfTest: Bool, outDir: String?, primeFiles: String?, urlMode: String, iconOut: String?, phase: Int) {
        self.isSelfTest = selfTest
        self.outDir = outDir.map { URL(fileURLWithPath: $0) }
        self.primeFiles = (primeFiles ?? "")
            .split(separator: ",")
            .map { URL(fileURLWithPath: String($0)) }
        self.urlMode = urlMode
        self.iconOut = iconOut
        self.phase = phase
        super.init()
    }

    // MARK: - 启动

    func applicationDidFinishLaunching(_ note: Notification) {
        // 图标渲染是独立的一次性任务，不建主窗口
        if let iconOut {
            IconRenderer.render(to: iconOut) { ok in
                print(ok ? "ICON_OK" : "ICON_FAIL")
                fflush(stdout)
                exit(ok ? 0 : 1)
            }
            return
        }

        shell = WebShell(mode: urlMode, selfTestOut: outDir)

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1460, height: 940),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "留白 · 边框水印工坊"
        window.minSize = NSSize(width: 1000, height: 680)
        window.contentView = shell.webView
        window.setFrameAutosaveName("PhotoFrameMainWindow")
        window.isReleasedWhenClosed = false

        if !isSelfTest { window.center() }
        window.makeKeyAndOrderFront(nil)
        if !isSelfTest { NSApp.activate(ignoringOtherApps: true) }

        shell.primeOpenPanel(with: primeFiles)
        shell.load()

        // 自测看门狗：任何一步卡死都要能自己退出，否则自动化会挂住
        if isSelfTest, let dir = outDir {
            startWatchdog(seconds: 150)
            let runner = SelfTestRunner(shell: shell, outDir: dir, phase: phase)
            tester = runner
            runner.start { ok in
                print(ok ? "SELFTEST_RESULT PASS" : "SELFTEST_RESULT FAIL")
                fflush(stdout)
                exit(ok ? 0 : 1)
            }
        }
    }

    private func startWatchdog(seconds: Double) {
        let t = DispatchSource.makeTimerSource(queue: .main)
        t.schedule(deadline: .now() + seconds)
        t.setEventHandler {
            print("PFTEST|watchdog|FAIL|自测超时（\(Int(seconds))s），强制退出")
            print("SELFTEST_RESULT FAIL")
            fflush(stdout)
            exit(1)
        }
        t.resume()
        watchdog = t
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    /// Finder 里把照片拖到应用图标上 / 右键「打开方式」
    func application(_ application: NSApplication, open urls: [URL]) {
        guard let shell else { return }
        shell.adoptExternalFiles(urls)
    }

    // MARK: - 菜单动作（全部转发到页面里已有的函数，index.html 零修改）

    @objc private func actOpenFiles()     { shell.eval("document.getElementById('fileInput').click(); 'ok'") }
    @objc private func actExportCurrent() { shell.eval("exportCurrent(); 'ok'") }
    @objc private func actExportAll()     { shell.eval("exportAll(); 'ok'") }
    @objc private func actToggleTheme()   { shell.eval("document.getElementById('btnTheme').click(); 'ok'") }
    @objc private func actToggleZoom()    { shell.eval("document.getElementById('btnZoom').click(); 'ok'") }

    /// 撤销 / 重做。
    /// 页面本来自己用 ⌘Z 管「设置层」历史，但原生菜单会先截走快捷键，所以必须转发；
    /// 同时要尊重页面那条「在输入框里保留原生文本撤销」的规则。
    @objc private func actUndo() { shell.eval(Self.undoJS(redo: false)) }
    @objc private func actRedo() { shell.eval(Self.undoJS(redo: true)) }

    private static func undoJS(redo: Bool) -> String {
        """
        (function(){
          try {
            var el = document.activeElement;
            var typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
            if (typing){ try { document.execCommand('undo'); } catch(e){} return 'text'; }
            \(redo ? "redo()" : "undo()");
            return 'app';
          } catch (e) { return 'err:' + e.message; }
        })()
        """
    }

    @objc private func actZoomIn()    { shell.setPageZoom(shell.webView.pageZoom * 1.1) }
    @objc private func actZoomOut()   { shell.setPageZoom(shell.webView.pageZoom / 1.1) }
    @objc private func actZoomReset() { shell.setPageZoom(1.0) }

    @objc private func actShowAbout() {
        let a = NSAlert()
        a.messageText = "留白 · 边框水印工坊"
        a.informativeText = """
        本地照片留白与边框水印工具。

        你导入的每一张照片都只在这台电脑的内存里处理 —— \
        应用已在 WebKit 层面阻断一切对外网络请求，照片不会去任何地方。

        导入　JPG / PNG / WebP / TIFF / HEIC（HEIC 由系统原生解码）
        导出　当前照片 ⌘S　·　打包导出全部 ⇧⌘S
        """
        a.alertStyle = .informational
        a.addButton(withTitle: "好")
        a.runModal()
    }

    @objc private func actShowHelp() {
        let a = NSAlert()
        a.messageText = "使用说明"
        a.informativeText = """
        · 打开照片：⌘O，或把照片拖进窗口，或拖到 Dock 图标上
        · 切换模板：按数字键 1–7，或点右侧模板卡片
        · 全屏预览：⇧⌘F（再按一次退出，Esc 也可以）
        · 切换深色主题：⇧⌘D（首次启动跟随系统设置）
        · 导出当前照片：⌘S　　打包导出全部：⇧⌘S
        · 撤销 / 重做：⌘Z / ⇧⌘Z　　窗口全屏：⌃⌘F
        · 粘贴导入：⌘V（截图后可直接粘贴）
        """
        a.alertStyle = .informational
        a.addButton(withTitle: "好")
        a.runModal()
    }

    // MARK: - 菜单栏

    func buildMenu() -> NSMenu {
        let main = NSMenu()

        // ---- 应用菜单 ----
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        own(appMenu, "关于 留白", #selector(actShowAbout))
        appMenu.addItem(.separator())
        chain(appMenu, "隐藏 留白", #selector(NSApplication.hide(_:)), "h")
        chain(appMenu, "隐藏其他",
              #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option])
        chain(appMenu, "显示全部", #selector(NSApplication.unhideAllApplications(_:)))
        appMenu.addItem(.separator())
        chain(appMenu, "退出 留白", #selector(NSApplication.terminate(_:)), "q")
        appItem.submenu = appMenu

        // ---- 文件 ----
        let fileItem = NSMenuItem()
        main.addItem(fileItem)
        let fileMenu = NSMenu(title: "文件")
        own(fileMenu, "打开照片…", #selector(actOpenFiles), "o")
        fileMenu.addItem(.separator())
        own(fileMenu, "导出当前照片", #selector(actExportCurrent), "s")
        own(fileMenu, "打包导出全部", #selector(actExportAll), "s", [.command, .shift])
        fileMenu.addItem(.separator())
        chain(fileMenu, "关闭窗口", #selector(NSWindow.performClose(_:)), "w")
        fileItem.submenu = fileMenu

        // ---- 编辑 ----
        let editItem = NSMenuItem()
        main.addItem(editItem)
        let editMenu = NSMenu(title: "编辑")
        own(editMenu, "撤销", #selector(actUndo), "z")
        own(editMenu, "重做", #selector(actRedo), "z", [.command, .shift])
        editMenu.addItem(.separator())
        // 这几项 target 留空走响应链交给 WKWebView，输入框的文本编辑才正常
        chain(editMenu, "剪切", #selector(NSText.cut(_:)), "x")
        chain(editMenu, "拷贝", #selector(NSText.copy(_:)), "c")
        chain(editMenu, "粘贴", #selector(NSText.paste(_:)), "v")
        chain(editMenu, "全选", #selector(NSText.selectAll(_:)), "a")
        editItem.submenu = editMenu

        // ---- 视图 ----
        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let viewMenu = NSMenu(title: "视图")
        own(viewMenu, "切换深色主题", #selector(actToggleTheme), "d", [.command, .shift])
        own(viewMenu, "全屏预览", #selector(actToggleZoom), "f", [.command, .shift])
        viewMenu.addItem(.separator())
        own(viewMenu, "放大", #selector(actZoomIn), "+")
        own(viewMenu, "缩小", #selector(actZoomOut), "-")
        own(viewMenu, "实际大小", #selector(actZoomReset), "0")
        viewMenu.addItem(.separator())
        chain(viewMenu, "进入全屏", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])
        viewItem.submenu = viewMenu

        // ---- 窗口 ----
        let winItem = NSMenuItem()
        main.addItem(winItem)
        let winMenu = NSMenu(title: "窗口")
        chain(winMenu, "最小化", #selector(NSWindow.performMiniaturize(_:)), "m")
        chain(winMenu, "缩放", #selector(NSWindow.performZoom(_:)))
        winMenu.addItem(.separator())
        chain(winMenu, "前置全部窗口", #selector(NSApplication.arrangeInFront(_:)))
        winItem.submenu = winMenu
        NSApp.windowsMenu = winMenu

        // ---- 帮助 ----
        let helpItem = NSMenuItem()
        main.addItem(helpItem)
        let helpMenu = NSMenu(title: "帮助")
        own(helpMenu, "使用说明", #selector(actShowHelp), "?")
        helpItem.submenu = helpMenu
        NSApp.helpMenu = helpMenu

        return main
    }

    /// target = 本对象（自定义动作）
    @discardableResult
    private func own(_ menu: NSMenu, _ title: String, _ action: Selector,
                     _ key: String = "", _ mods: NSEvent.ModifierFlags = [.command]) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        item.keyEquivalentModifierMask = key.isEmpty ? [] : mods
        menu.addItem(item)
        return item
    }

    /// target = nil（沿响应链派发，交给 WKWebView / NSApp / 关键窗口）
    @discardableResult
    private func chain(_ menu: NSMenu, _ title: String, _ action: Selector,
                       _ key: String = "", _ mods: NSEvent.ModifierFlags = [.command]) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = nil
        item.keyEquivalentModifierMask = key.isEmpty ? [] : mods
        menu.addItem(item)
        return item
    }
}
