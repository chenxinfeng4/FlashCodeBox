#!/usr/bin/env bash
# 发布打包（本地与 GitHub Actions 共用）：
# 前端 Vite 构建一次 → 交叉编译 linux/amd64、linux/arm64、darwin/arm64（Mac Apple Silicon）、windows/amd64
# 产物：release/flashcodebox-<平台>-<架构>[.exe]（裸二进制）、
#       release/flashcodebox-<版本>-<平台>-<架构>.tar.gz|.zip、release/checksums.txt
# 用法：bash scripts/release.sh [版本号]   （缺省取 git describe，去掉 v 前缀）
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

# 依赖检查
command -v node >/dev/null 2>&1 || { echo "✗ 需要 Node.js 24+（构建前端）" >&2; exit 1; }
node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$node_major" -ge 24 ] || { echo "✗ Node.js 版本过低（$(node -v 2>/dev/null || echo 未知)），需要 24+" >&2; exit 1; }
command -v go   >/dev/null 2>&1 || { echo "✗ 需要 Go 1.27+（构建后端）"    >&2; exit 1; }
command -v zip  >/dev/null 2>&1 || { echo "✗ 需要 zip 命令（打包 Windows 包）" >&2; exit 1; }

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  VERSION="$(git describe --tags --always 2>/dev/null || echo dev)"
  VERSION="${VERSION#v}"
fi
# 版本号用于目录/文件名/ldflags，禁止路径与空白字符
if ! [[ "$VERSION" =~ ^[0-9A-Za-z._-]+$ ]]; then
  echo "✗ 版本号含非法字符：$VERSION（仅允许字母数字与 . _ -）" >&2
  exit 1
fi

OUT=release
STAGE="$OUT/stage"
rm -rf "$OUT"
mkdir -p "$STAGE"

echo "→ 构建前端（embed 产物）…"
cd frontend
if [ ! -d node_modules ]; then npm ci; fi
npm run build
cd ..

LDFLAGS="-s -w -X flashcodebox/internal/api.Version=${VERSION}"

for target in linux/amd64 linux/arm64 darwin/arm64 windows/amd64; do
  goos=${target%/*}
  goarch=${target#*/}
  ext=""
  [ "$goos" = windows ] && ext=".exe"
  name="flashcodebox-${VERSION}-${goos}-${goarch}"
  echo "→ 交叉编译 ${goos}/${goarch} …"
  mkdir -p "$STAGE/$name"
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath -ldflags "$LDFLAGS" -o "$STAGE/$name/flashcodebox${ext}" ./cmd/flashcodebox

  # 裸二进制单独放一份：Releases 页直接下载即可执行（文件名不带版本，方便固定 latest 下载链接）
  cp "$STAGE/$name/flashcodebox${ext}" "$OUT/flashcodebox-${goos}-${goarch}${ext}"

  cp README.md README.en.md LICENSE .env.example "$STAGE/$name/"
  if [ "$goos" = windows ]; then
    ( cd "$STAGE" && zip -rq "$ROOT/$OUT/$name.zip" "$name" )
    echo "  ✓ $OUT/flashcodebox-${goos}-${goarch}${ext}"
    echo "  ✓ $OUT/$name.zip"
  else
    tar -czf "$OUT/$name.tar.gz" -C "$STAGE" "$name"
    echo "  ✓ $OUT/flashcodebox-${goos}-${goarch}${ext}"
    echo "  ✓ $OUT/$name.tar.gz"
  fi
done

echo "→ 生成 sha256 清单 …"
cd "$OUT"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum flashcodebox-* > checksums.txt
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 flashcodebox-* > checksums.txt
else
  echo "✗ 需要 sha256sum 或 shasum 命令" >&2
  exit 1
fi
rm -rf stage
cd ..

echo
echo "✓ 发布包已生成（版本 ${VERSION}）："
ls -lh "$OUT"
