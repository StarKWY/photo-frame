#!/usr/bin/env bash
#
# 构建「留白」macOS 应用。
#
#   ./build.sh              通用二进制（arm64 + x86_64）
#   ./build.sh --thin       只构建本机架构（快一倍）
#   ./build.sh --no-sign    跳过签名（调试用）
#
# 产物：macos/dist/留白.app
#
# 说明：
#   · 自用 + 几个朋友用，不分发，所以不需要 Apple 开发者账号，
#     ad-hoc 签名（codesign -s -）就够。首次打开若被 Gatekeeper 拦住，
#     右键「打开」一次即可。
#   · 本脚本刻意**不做任何删除操作**：中间产物就地覆写，最终二进制用
#     mv -f 原子替换（顺带避免"应用正在运行时无法覆盖"的问题）。
#     因此重复构建是增量且幂等的，不会误删任何东西。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

APP_NAME="留白"
APP="$HERE/dist/$APP_NAME.app"
BUILD="$HERE/build"
MIN_MACOS="14.0"

THIN=0
SIGN=1
for a in "$@"; do
  case "$a" in
    --thin)    THIN=1 ;;
    --no-sign) SIGN=0 ;;
    *) echo "未知参数：$a" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;36m▸\033[0m %s\n' "$1"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$1" >&2; exit 1; }

command -v swiftc >/dev/null || die "找不到 swiftc，请先装 Xcode 命令行工具：xcode-select --install"

mkdir -p "$BUILD" "$APP/Contents/MacOS" "$APP/Contents/Resources"

# ---------------------------------------------------------------- 1. 编译
say "编译 Swift 源码"

SOURCES=("$HERE"/src/*.swift)
FRAMEWORKS=(-framework AppKit -framework WebKit -framework UniformTypeIdentifiers)
LOG="$BUILD/compile.log"
: > "$LOG"

# 直接把 swiftc 的退出码往外传，别用管道把它吃掉
compile() {  # $1=target triple  $2=输出路径
  swiftc -O -swift-version 5 -target "$1" -o "$2" "${SOURCES[@]}" "${FRAMEWORKS[@]}" 2>>"$LOG"
}

X86_OK=0
if [ "$THIN" = "0" ]; then
  if compile "x86_64-apple-macosx$MIN_MACOS" "$BUILD/pf-x86_64"; then
    X86_OK=1
  else
    say "工具链不含 x86_64 切片，退回单架构"
  fi
fi

if ! compile "arm64-apple-macosx$MIN_MACOS" "$BUILD/pf-arm64"; then
  grep -E 'error' "$LOG" | head -30 || true
  die "arm64 编译失败，完整日志见 $LOG"
fi

if [ "$X86_OK" = "1" ]; then
  lipo -create "$BUILD/pf-arm64" "$BUILD/pf-x86_64" -output "$BUILD/PhotoFrame"
  say "已合成通用二进制：$(lipo -archs "$BUILD/PhotoFrame")"
else
  cp "$BUILD/pf-arm64" "$BUILD/PhotoFrame"
  say "单架构二进制：$(lipo -archs "$BUILD/PhotoFrame")"
fi

# 原子替换：应用正在运行时 mv 也能成功（cp 覆盖会 ETXTBSY）
cp "$BUILD/PhotoFrame" "$APP/Contents/MacOS/.PhotoFrame.new"
chmod +x "$APP/Contents/MacOS/.PhotoFrame.new"
mv -f "$APP/Contents/MacOS/.PhotoFrame.new" "$APP/Contents/MacOS/PhotoFrame"

# ---------------------------------------------------------------- 2. 图标
say "渲染应用图标"
if "$APP/Contents/MacOS/PhotoFrame" --render-icon "$BUILD/icon-1024.png" >/dev/null 2>&1 \
   && [ -s "$BUILD/icon-1024.png" ]; then
  ICONSET="$BUILD/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z "$s" "$s" "$BUILD/icon-1024.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null 2>&1
    d=$((s * 2))
    sips -z "$d" "$d" "$BUILD/icon-1024.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null 2>&1
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
  say "图标已生成（$(du -h "$APP/Contents/Resources/AppIcon.icns" | cut -f1)）"
else
  say "图标渲染失败，沿用上一次的图标（若有）"
fi

# ---------------------------------------------------------------- 3. 组装
say "组装 .app"

# 页面是唯一数据源：直接从仓库根复制，不存副本，保证网页版与 App 版永不分叉
[ -f "$REPO/index.html" ] || die "找不到 $REPO/index.html"
cp "$REPO/index.html" "$APP/Contents/Resources/index.html"

cp "$HERE/resources/Info.plist" "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
plutil -lint "$APP/Contents/Info.plist" >/dev/null || die "Info.plist 格式有误"

# ---------------------------------------------------------------- 4. 签名
if [ "$SIGN" = "1" ]; then
  say "ad-hoc 签名"
  codesign --force --sign - "$APP" >/dev/null 2>&1 || die "签名失败"
  codesign --verify --deep --strict "$APP" >/dev/null 2>&1 \
    && say "签名校验通过" \
    || say "签名校验有告警（ad-hoc 自用通常无碍）"
fi

# ---------------------------------------------------------------- 5. 就位
SIZE="$(du -sh "$APP" | cut -f1)"
# 注意：变量后跟全角括号必须加花括号，否则 bash 会把括号并入变量名（set -u 下直接炸）
say "完成：${APP}（${SIZE}）"
echo
echo "  打开：open \"$APP\""
echo "  自测：node tests/run-selftest.mjs"
