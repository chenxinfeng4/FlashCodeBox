#!/usr/bin/env bash
# FlashCodeBox 终端 CLI：包装 HTTP API，供 curl/脚本/CI 在终端直接传文件、查询、下载。
# 依赖：curl + jq（会话默认存 ~/.fcb_session，可用 FCB_SESSION 覆盖）
# 用法：FCB_BASE=http://192.168.1.20:12345 cli.sh <命令> [参数]
set -euo pipefail

BASE="${FCB_BASE:-http://127.0.0.1:12345}"
SESSION="${FCB_SESSION:-$HOME/.fcb_session}"

usage() {
  cat <<'EOF'
FlashCodeBox CLI —— 终端传文件/查消息/下载

用法: cli.sh <命令> [参数]

  create [TEXT]      建群（发首条消息，自己成为群主），会话自动保存
  join CODE          凭群号加入，会话自动保存
  use CODE TOKEN     手动设置会话（在其他机器恢复身份）
  info               当前会话：群号 / 身份 / 剩余时间
  send TEXT          发文字消息
  sendfile FILE...   发文件（可多个；流式直传，受站点单文件上限约束）
  ls [N]             查看最近 N 条消息（默认 20）
  cat MSG_ID         查看某条文字消息全文
  down MSG_ID [DIR]  下载文件消息（默认存当前目录，重名自动加序号）
  dissolve           解散群（仅群主；删除全部消息与文件）

环境变量:
  FCB_BASE    服务地址（默认 http://127.0.0.1:12345）
  FCB_SESSION 会话文件（默认 ~/.fcb_session）

示例:
  FCB_BASE=http://192.168.1.20:12345 cli.sh create "会议资料群"
  cli.sh sendfile 报告.pdf 截图.png
  cli.sh ls
  cli.sh down 3
EOF
}

CODE="" && TOKEN=""
load_session() {
  if [ -f "$SESSION" ]; then
    CODE=$(jq -r '.code // empty' "$SESSION")
    TOKEN=$(jq -r '.token // empty' "$SESSION")
  fi
  if [ -z "$CODE" ] || [ -z "$TOKEN" ]; then
    echo "✗ 无会话：先执行 create / join / use" >&2
    exit 1
  fi
}

save_session() { # $1=code $2=token $3=role
  printf '{"code":"%s","token":"%s","role":"%s"}\n' "$1" "$2" "${3:-}" > "$SESSION"
  chmod 600 "$SESSION"
}

api() { # method path [curl-extra...]
  local method=$1 path=$2; shift 2
  curl -sS -X "$method" "$BASE$path" "$@"
}

need_jq() { command -v jq >/dev/null 2>&1 || { echo "✗ 需要 jq（解析 JSON）" >&2; exit 1; }; }

cmd="${1:-}"; [ -n "$cmd" ] || { usage; exit 0; }; shift || true

case "$cmd" in
  create)
    need_jq
    text="${*:-CLI 创建}"
    R=$(api POST /api/room/create -H 'Content-Type: application/json' -d "{\"text\":\"$text\",\"expire_value\":1,\"expire_style\":\"day\"}")
    CODE=$(jq -r '.data.room.code' <<<"$R")
    TOKEN=$(jq -r '.data.token' <<<"$R")
    save_session "$CODE" "$TOKEN" owner
    echo "✓ 已建群，群号 $CODE（会话已保存到 $SESSION）"
    ;;
  join)
    need_jq
    [ -n "${1:-}" ] || { echo "用法: cli.sh join CODE" >&2; exit 1; }
    R=$(api POST "/api/room/join/$1")
    CODE=$(jq -r '.data.room.code' <<<"$R")
    TOKEN=$(jq -r '.data.token' <<<"$R")
    ROLE=$(jq -r '.data.member.role' <<<"$R")
    save_session "$CODE" "$TOKEN" "$ROLE"
    echo "✓ 已加入 $CODE（身份: $(jq -r '.data.member.sender' <<<"$R")）"
    ;;
  use)
    [ -n "${2:-}" ] || { echo "用法: cli.sh use CODE TOKEN" >&2; exit 1; }
    save_session "$1" "$2"
    echo "✓ 会话已设置: $1"
    ;;
  info)
    load_session
    api GET "/api/room/$CODE/messages?after=0" -H "X-Room-Token: $TOKEN" |
      jq -r '"群号: \(.data.room.code)  身份: \(.data.you.sender)  消息: \(.data.messages | length) 条  成员数: \(.data.you.guest_no | if . == 0 then "群主" else . end)"' 2>/dev/null ||
      echo "✗ 群已失效或网络错误"
    ;;
  send)
    load_session
    [ -n "${*:-}" ] || { echo "用法: cli.sh send TEXT" >&2; exit 1; }
    BODY=$(jq -n --arg token "$TOKEN" --arg text "$*" '{token:$token, text:$text}')
    api POST "/api/room/$CODE/send/text" -H 'Content-Type: application/json' -d "$BODY" | jq -r 'if .code==200 then "✓ 已发送" else "✗ " + .message end'
    ;;
  sendfile)
    load_session
    [ $# -ge 1 ] || { echo "用法: cli.sh sendfile FILE..." >&2; exit 1; }
    for f in "$@"; do
      [ -f "$f" ] || { echo "✗ 文件不存在: $f" >&2; exit 1; }
      R=$(curl -sS -X POST "$BASE/api/room/send/file" -F "code=$CODE" -F "token=$TOKEN" -F "file=@$f")
      echo "$R" | jq -r 'if .code==200 then "✓ " + .data.message.filename + " (" + (.data.message.size|tostring) + " bytes)" else "✗ " + .message end'
    done
    ;;
  ls)
    load_session
    api GET "/api/room/$CODE/messages?after=0" -H "X-Room-Token: $TOKEN" |
      jq -r --argjson n "${1:-20}" '.data.messages[-$n:][] |
        "#\(.id) [\(.created_at | todate)] \(.sender): \(if .type == "text" then (.text | .[0:60]) else "📄 " + .filename + " (" + (.size|tostring) + "B)" end)"'
    ;;
  cat)
    load_session
    [ -n "${1:-}" ] || { echo "用法: cli.sh cat MSG_ID" >&2; exit 1; }
    api GET "/api/room/$CODE/messages?after=0" -H "X-Room-Token: $TOKEN" |
      jq -r --argjson id "$1" '.data.messages[] | select(.id == $id) | if .type == "text" then .text else "📄 \(.filename)（文件，用 down 下载）" end'
    ;;
  down)
    load_session
    [ -n "${1:-}" ] || { echo "用法: cli.sh down MSG_ID [DIR]" >&2; exit 1; }
    dir="${2:-.}"
    name=$(api GET "/api/room/$CODE/messages?after=0" -H "X-Room-Token: $TOKEN" |
      jq -r --argjson id "$1" '.data.messages[] | select(.id == $id) | .filename // empty')
    [ -n "$name" ] || { echo "✗ 消息不存在或不是文件" >&2; exit 1; }
    out="$dir/$name"
    if [ -e "$out" ]; then
      case "$name" in
        *.*) base="${name%.*}"; ext=".${name##*.}" ;;
        *)   base="$name"; ext="" ;;
      esac
      i=1; while [ -e "$dir/$base($i)$ext" ]; do i=$((i+1)); done
      out="$dir/$base($i)$ext"
    fi
    curl -sS "$BASE/api/room/$CODE/messages/$1/file?token=$TOKEN" -o "$out"
    echo "✓ 已下载: $out ($(stat -c%s "$out" 2>/dev/null || stat -f%z "$out") bytes)"
    ;;
  dissolve)
    load_session
    R=$(api DELETE "/api/room/$CODE" -H "X-Room-Token: $TOKEN")
    echo "$R" | jq -r 'if .code==200 then "✓ 群已解散（消息与文件已删除）" else "✗ " + .message end'
    [ -f "$SESSION" ] && rm -f "$SESSION"
    ;;
  help|-h|--help) usage ;;
  *) usage; exit 1 ;;
esac
