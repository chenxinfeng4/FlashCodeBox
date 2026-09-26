#!/usr/bin/env bash
# 非交互式初始化管理员密码（用于自动化 / 容器编排）
# 站点首次访问需要设置管理密码；此脚本通过 API 完成，免去手动打开页面。
#
# 用法：
#   ADMIN_PASSWORD=yourpass bash scripts/init-admin.sh
#   BASE=http://127.0.0.1:8080 ADMIN_PASSWORD=yourpass bash scripts/init-admin.sh
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:12345}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"

if [ -z "$ADMIN_PASSWORD" ]; then
  echo "✗ 请通过环境变量 ADMIN_PASSWORD 提供管理密码（至少 8 位）" >&2
  exit 1
fi

status=$(curl -fsS "$BASE/api/admin/status" 2>/dev/null || true)
case "$status" in
  *'"initialized":true'*)
    echo "✓ 已完成初始化，跳过"
    exit 0
    ;;
esac

resp=$(curl -fsS -X POST "$BASE/api/admin/setup" \
  -H 'Content-Type: application/json' \
  -d "{\"password\":\"${ADMIN_PASSWORD}\"}" 2>/dev/null || true)

case "$resp" in
  *'"code":200'*)
    echo "✓ 管理员密码设置成功，可打开 $BASE/#/admin 登录"
    ;;
  *)
    echo "✗ 初始化失败：${resp:-无响应}" >&2
    exit 1
    ;;
esac
