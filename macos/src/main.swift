/* ============================================================
   main.swift —— 程序入口
   留白 · 边框水印工坊（macOS 原生壳）

   只做参数解析与 NSApplication 启动，业务逻辑在 AppDelegate / WebShell。
   ============================================================ */

import AppKit

let argv = Array(CommandLine.arguments.dropFirst())

func hasFlag(_ name: String) -> Bool { argv.contains(name) }

func optValue(_ name: String) -> String? {
    guard let i = argv.firstIndex(of: name), i + 1 < argv.count else { return nil }
    return argv[i + 1]
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)

let delegate = AppDelegate(
    selfTest: hasFlag("--selftest"),
    outDir: optValue("--out"),
    primeFiles: optValue("--open-files"),
    urlMode: optValue("--url-mode") ?? "pfframe",
    iconOut: optValue("--render-icon"),
    phase: Int(optValue("--phase") ?? "1") ?? 1
)

app.delegate = delegate
app.mainMenu = delegate.buildMenu()
app.run()
