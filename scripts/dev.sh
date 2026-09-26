#!/usr/bin/env bash
# 开发模式：Go 后端（:12345）+ Vite 热更新（:5173，/api 代理到后端）
# 按 Ctrl-C 结束，两进程一起退出。
set -euo pipefail

cd "$(dirname "$0")/.."

command -v node >/dev/null 2>&1 || { echo "✗ 需要 Node.js 24+" >&2; exit 1; }
node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$node_major" -ge 24 ] || { echo "✗ Node.js 版本过低（$(node -v 2>/dev/null || echo 未知)），需要 24+" >&2; exit 1; }
command -v go   >/dev/null 2>&1 || { echo "✗ 需要 Go 1.27+"   >&2; exit 1; }

cleanup() { [ -n "${GO_PID:-}" ] && kill "$GO_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "→ 构建并启动 Go 后端 :12345 …"
mkdir -p build
go build -o build/flashcodebox-dev ./cmd/flashcodebox
./build/flashcodebox-dev -port 12345 -data ./devdata &
GO_PID=$!

sleep 1
echo "→ 启动 Vite 开发服务器 :5173 …"
( cd frontend && { [ -d node_modules ] || npm ci; } && npm run dev )
