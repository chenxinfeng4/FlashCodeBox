#!/usr/bin/env bash
# 本地构建（不开 Docker）：前端 Vite → Go embed → 单二进制
# 产物：build/flashcodebox
set -euo pipefail

cd "$(dirname "$0")/.."

# 依赖检查
command -v node >/dev/null 2>&1 || { echo "✗ 需要 Node.js 20+（构建前端）" >&2; exit 1; }
command -v go   >/dev/null 2>&1 || { echo "✗ 需要 Go 1.27+（构建后端）"    >&2; exit 1; }

echo "→ 构建前端 …"
cd frontend
if [ ! -d node_modules ]; then npm ci; fi
npm run build
cd ..

echo "→ 构建 Go 二进制 …"
mkdir -p build
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o build/flashcodebox ./cmd/flashcodebox

echo "✓ 构建完成：build/flashcodebox"
echo "  运行：./build/flashcodebox -port 12345 -data ./data"
