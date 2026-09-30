---
name: flashcodebox-cli
description: 用 FlashCodeBox（快闪群传）的 CLI 脚本或 curl 在终端上传、下载、查询文件与消息。当用户提到"传个文件到群/服务器"、"用终端/CLI/curl 上传或下载"、"跨机器传文件"、"查一下群里的消息"、"下载 #N 消息的文件"、或任何涉及 FlashCodeBox / 快闪群传 / FCB_BASE 服务 API 的操作时使用本 skill——即使用户没有明确说"CLI"两个字。局域网临时传文件的首选方案。
---

# FlashCodeBox 终端传文件（CLI）

FlashCodeBox（快闪群传）是一个局域网临时群聊 + 文件分享服务：单二进制、无账号、
报群号即入、到期自动解散。它的 HTTP API 对终端完全友好（令牌走 header 或 query，
无 cookie），本 skill 用 `scripts/cli.sh`（curl+jq 包装）完成上传/下载/查询。

> 本 skill 随仓库分发（`.opencode/skills/flashcodebox-cli/`）；`scripts/cli.sh`
> 就是仓库根目录下的脚本，克隆仓库后即可用。全局安装副本在
> `~/.config/opencode/skills/flashcodebox-cli/`，二者内容保持同步。

## 第 0 步：确认服务可用

先探测服务，不要盲目执行后续命令：

```bash
FCB_BASE="${FCB_BASE:-http://127.0.0.1:12345}"
curl -s --max-time 3 "$FCB_BASE/api/config" | jq -r '.data.version'
```

- 有版本号输出 → 服务可用，继续。
- 连接失败 → 服务未运行或地址不对。若用户在本机仓库（scripts/build.sh 所在目录），
  可询问后执行 `bash scripts/build.sh && (nohup ./build/flashcodebox -port 12345 -data ./data &)`
  并从启动日志取「局域网访问」地址告知用户；不要静默启动对外服务。

## 会话模型（先理解再动手）

- `FCB_BASE`：服务地址，默认 `http://127.0.0.1:12345`。局域网机器用启动日志里的
  `http://<IP>:12345`。
- `FCB_SESSION`：会话文件（默认 `~/.fcb_session`），保存 `{code, token, role}`。
  多个群/多个身份 = 多个会话文件。
- **上传前必须有会话**：没有就 `create`（建群当群主）或 `join`（凭群号加入）。
- 会话可能失效（群到期自动解散、被解散）→ 报错 403/404/410 时重新 create/join。

## 上传文件

```bash
export FCB_BASE=http://192.168.1.20:12345   # 按实际服务地址

CLI=<仓库>/scripts/cli.sh                    # 仓库根目录下的 scripts/cli.sh

# 没有群时：建群（首条消息即建群，自己是群主）
bash $CLI create "传文件用"                  # 会话自动保存

# 上传一个或多个文件（流式直传，受站点单文件上限约束，默认 1GiB）
bash $CLI sendfile 报告.pdf 截图.png
```

- `sendfile` 输出 `✓ 文件名 (字节数)`；失败会给出原因（类型白名单/超限/限流 429）。
- 空文件会被服务端拒绝；上传大文件时 curl 是流式的，不会占满内存。
- 同群重复传同名文件没问题——每条消息独立，消息 id 不同。

## 下载文件

```bash
bash $CLI ls            # 列出最近消息，形如 "#16 [date] 群主: 📄 README.md (11114B)"
bash $CLI down 16       # 按 #消息id 下载到当前目录（重名自动加 (1) 序号）
bash $CLI down 16 /tmp  # 也可指定目录
```

- 消息 id 就是 `ls` 输出**行首 `#` 后面的数字**；脚本取最新一条的 id：
  `ID=$(bash $CLI ls | tail -1 | grep -o '^#[0-9]*' | tr -d '#')`。

- 只有 `type` 为文件的消息能 `down`；文字消息用 `cat <id>` 看全文。
- 下载走 `?token=`（`<a>/<img>` 同款通道），无需额外 header。
- 校验完整性：与源文件 `cmp` 比对（此前实测字节级一致）。

## 查询 / 发文字 / 解散

```bash
bash $CLI ls                  # 最近 20 条（可传数量参数）
bash $CLI cat 15              # 看 #15 文字消息全文
bash $CLI send "来自终端"     # 发文字
bash $CLI info                # 当前会话概要
bash $CLI join 76047          # 另一台机器凭群号加入（访客身份可能被禁止发言）
bash $CLI dissolve            # 解散群（仅群主；删除全部消息与文件，成员全部被踢）
```

注意权限：访客在群主关闭「允许访客回消息」后无法 send/sendfile（输入即 403）；
解散与改设置只有群主可以。

## 无 cli.sh 时：纯 curl 流程（远程机器、CI）

目标机器上没有仓库时，用 curl 等价操作（需 jq 解析；没有 jq 就用 python3 -c json）：

```bash
B=http://192.168.1.20:12345

# 建群 → 拿到 code + token（务必保存，丢失无法找回身份）
R=$(curl -s -X POST $B/api/room/create -H 'Content-Type: application/json' \
  -d '{"text":"CLI","expire_value":1,"expire_style":"day"}')
CODE=$(echo $R | jq -r .data.room.code); TOKEN=$(echo $R | jq -r .data.token)

# 上传（multipart，流式）
curl -s -X POST $B/api/room/send/file -F "code=$CODE" -F "token=$TOKEN" -F "file=@报告.pdf"

# 查询（增量：after=最后已见消息 id）
curl -s "$B/api/room/$CODE/messages?after=0" -H "X-Room-Token: $TOKEN" | jq -r '.data.messages[] | "#\(.id) \(.type) \(.filename // .text)"'

# 下载（消息 id 3；query token 即可）
curl -s "$B/api/room/$CODE/messages/3/file?token=$TOKEN" -o 报告.pdf

# 加入已有群（访客）
curl -s -X POST $B/api/room/join/$CODE | jq -r .data.token

# 群主解散
curl -s -X DELETE $B/api/room/$CODE -H "X-Room-Token: $TOKEN"
```

大文件（数百 MB+）建议走分片上传：`POST api/upload/init`（带 file_name/file_size）
→ 逐片 `PUT api/upload/:id/:n`（raw body，可选 `X-Chunk-Hash: <分片sha256>`）
→ `POST api/upload/:id/complete`（带 code/token）。断点续传：重新 init 会返回已传分片列表。

## 排错速查

| 现象 | 原因 | 处理 |
|---|---|---|
| `403 无效的成员令牌` | 群已解散/到期，或 token 错 | 重新 create/join |
| `410 群已解散` | 到期自动清理 | 同上；重要文件先 down |
| `429 操作过于频繁` | 写操作限流（默认 30 次/60s/IP） | 等 1 分钟；查消息/下载不受限 |
| `文件类型不被允许` | 管理后台白名单 | 换格式或让管理员调整 |
| `超过大小限制` | 超过站点单文件上限 | 管理后台调大，或分卷压缩 |
| jq 解析报错 | 服务返回了 HTML（路径打错落到前端页） | 检查 URL 是否带 `/api/` 前缀 |

## 注意事项

- 该服务面向局域网临时分享：群会到期自动解散（默认 1 天，上限由管理后台设定），
  **不要当作持久存储**；需要留存的文件先 `down` 下来。
- 任何能拿到群号的局域网成员都可加入并下载群内文件——不要传敏感/未授权内容。
- 写操作有 IP 限流，循环上传请加间隔；查询与下载不计入限流。
