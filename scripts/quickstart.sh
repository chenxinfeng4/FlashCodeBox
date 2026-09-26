#!/usr/bin/env bash
# 一键运行 FlashCodeBox（Docker）
#   - 若本地没有镜像，则自动构建
#   - 启动容器并打印本机访问地址 / 局域网地址
# 用法：
#   bash scripts/quickstart.sh                # 默认端口 12345，数据存 ./data
#   PORT=8080 bash scripts/quickstart.sh      # 改端口
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE="${IMAGE:-flashcodebox:latest}"
NAME="${NAME:-flashcodebox}"
PORT="${PORT:-12345}"
DATA="${DATA:-$PWD/data}"
TZ_VAL="${TZ:-Asia/Shanghai}"

if ! command -v docker >/dev/null 2>&1; then
  echo "✗ 未检测到 Docker。请先安装 Docker，或改用本地构建：bash scripts/build.sh" >&2
  exit 1
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "→ 未找到镜像 $IMAGE，开始构建（首次较慢，请耐心等待）…"
  docker build -t "$IMAGE" .
fi

echo "→ 启动容器 $NAME（端口 $PORT，数据目录 $DATA）…"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d \
  --name "$NAME" \
  --restart unless-stopped \
  -p "${PORT}:12345" \
  -v "${DATA}:/data" \
  -e "TZ=${TZ_VAL}" \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  "$IMAGE" >/dev/null

# 等待就绪
for _ in $(seq 1 30); do
  if wget -qO- "http://127.0.0.1:${PORT}/api/config" >/dev/null 2>&1; then break; fi
  sleep 0.5
done

echo
echo "✓ FlashCodeBox 已启动"
echo "  本机访问：  http://127.0.0.1:${PORT}"
# 列出局域网 IPv4（私有网段）
ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 \
  | grep -E '^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)' | sort -u | while read -r ip; do
    echo "  局域网访问：http://${ip}:${PORT}   （同一 Wi-Fi 的电脑/手机可直接打开）"
  done
echo
echo "  首次使用：打开页面 → 右上角「管理」→ 设置管理密码完成初始化"
echo "  查看日志：docker logs -f ${NAME}"
echo "  停止服务：docker rm -f ${NAME}"
