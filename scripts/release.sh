#!/usr/bin/env bash
# 发布打包（本地与 GitHub Actions 共用）：
# 前端 Vite 构建一次 → 交叉编译 linux/amd64 + linux/arm64 → 各打 tar.gz + sha256 清单
# 产物：release/flashcodebox-<版本>-linux-<架构>.tar.gz 与 release/checksums.txt
# 用法：bash scripts/release.sh [版本号]   （缺省取 git describe，去掉 v 前缀）
set -euo pipefail

cd "$(dirname "$0")/.."

# 依赖检查
command -v node >/dev/null 2>&1 || { echo "✗ 需要 Node.js 20+（构建前端）" >&2; exit 1; }
command -v go   >/dev/null 2>&1 || { echo "✗ 需要 Go 1.27+（构建后端）"    >&2; exit 1; }

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  VERSION="$(git describe --tags --always 2>/dev/null || echo dev)"
  VERSION="${VERSION#v}"
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

for arch in amd64 arm64; do
  name="flashcodebox-${VERSION}-linux-${arch}"
  echo "→ 交叉编译 linux/${arch} …"
  mkdir -p "$STAGE/$name"
  CGO_ENABLED=0 GOOS=linux GOARCH="$arch" \
    go build -trimpath -ldflags "$LDFLAGS" -o "$STAGE/$name/flashcodebox" ./cmd/flashcodebox

  # 裸二进制单独放一份：Releases 页直接下载即可执行（文件名不带版本，方便固定 latest 下载链接）
  cp "$STAGE/$name/flashcodebox" "$OUT/flashcodebox-linux-${arch}"

  cp README.md README.en.md LICENSE .env.example "$STAGE/$name/"
  tar -czf "$OUT/$name.tar.gz" -C "$STAGE" "$name"
  echo "  ✓ $OUT/flashcodebox-linux-${arch}"
  echo "  ✓ $OUT/$name.tar.gz"
done

echo "→ 生成 sha256 清单 …"
cd "$OUT"
sha256sum flashcodebox-linux-* flashcodebox-*.tar.gz > checksums.txt
rm -rf stage
cd ..

echo
echo "✓ 发布包已生成（版本 ${VERSION}）："
ls -lh "$OUT"
