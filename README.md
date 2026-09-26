# 快闪群享 (FlashShare)

**局域网内的临时群聊**：同一 Wi-Fi 下，报「群号」即入，可收发**文字与文件**，到期自动解散。

基于 [FileCodeBox](https://github.com/vastsa/FileCodeBox) 思路的 Go 语言重写版。编译后是**单个静态二进制**（前端已内嵌，数据库用纯 Go 的 SQLite 驱动），没有任何运行时依赖 —— 在内网一台机器上跑起来，同一网段的电脑/手机打开网址就能用，文件数据不出内网、传输跑满内网带宽。

## 使用方式

1. 打开首页就是一个微信式聊天窗口：输入第一条消息（或发第一个文件）即**自动建群**并生成**群号**，你就是**群主**
2. 把群号（或邀请链接）分享给同一局域网的任何人，他们输入群号、或打开链接即可加入，成为**访客1、访客2…**（人数不限）
3. 群主与所有访客共用一个聊天窗口：文字气泡、文件卡片、图片缩略图（点击放大），大家都能下载文件
4. 群主可随时打开「设置」：
   - **允许访客回消息**（默认开启；关闭后访客输入框禁用）
   - **消息保留时长**（默认 1 天，可改小时/天/永久；到期后整个群与文件自动解散删除）

## 主要特性

- **群聊**：群主/访客双角色、双向气泡（自己右侧绿、他人左侧白 + 群名片）、2.5s 轮询近实时刷新
- **文件收发**：📎/拖拽/粘贴即自动上传；分片上传（默认 5MB/片）带字节级进度条与网速；断点续传；sha256 校验
- **图片预览**：jpg/png/gif/webp/bmp/svg/avif 自动缩略图，单击灯箱放大、可下载原图
- **局域网友好**：启动时打印 `局域网访问: http://192.168.x.x:端口`，同一 Wi-Fi 直接访问；数据不出内网
- **反代友好**：前端全相对路径、服务端永不生成绝对 URL，子路径/任意端口开箱即用（分片避开 body 限制）
- **下载鉴权**：文件仅群成员可下载（令牌随 URL 传递，支持 header 或 query）
- **自动清理**：后台协程删除过期群（含全部消息与文件）、未完成分片、空群
- **管理后台**（`#/admin`）：首次设置管理密码；站点配置在线修改、群列表/删除
- 主题切换（明/暗，默认明）、IP 限流（0=关闭）、类型白名单、大小限制

## 快速开始

前端为 Vite + React（构建产物由 Go embed 进二进制），需要先构建前端：

```bash
# 1. 构建前端（产物输出到 internal/web/dist）
cd frontend
npm install
npm run build
cd ..

# 2. 构建 Go（embed 前端产物）
go build -o flashshare ./cmd/filesender

# 3. 运行
./flashshare -port 12345 -data ./data
```

启动日志会列出本机的局域网地址，手机/同事连同一 Wi-Fi 直接用：

```
快闪群享 (FlashShare) 1.0.0 已启动: http://:12345  数据目录: /path/to/data
局域网访问: http://192.168.1.20:12345
```

前端开发模式（热更新，API 代理到本地 12345）：

```bash
cd frontend && npm run dev
```

| flag | 环境变量 | 默认 | 说明 |
|------|---------|------|------|
| `-port` | `PORT` | `12345` | 监听端口（默认绑定 0.0.0.0） |
| `-data` | `DATA_DIR` | `./data` | 数据目录（数据库/文件/配置） |
| `-trusted-proxies` | `TRUSTED_PROXIES` | 空 | 可信反代网段（逗号分隔 CIDR） |
| `-debug` | `DEBUG=1` | 关 | 调试日志 |

> 二进制/目录名仍为 `filesender`（Go module 名），品牌显示名可在管理后台修改。

## 反向代理（子路径 + 任意端口）

```nginx
server {
    listen 443 ssl;
    server_name chat.example.com;

    location /chat/ {
        proxy_pass http://127.0.0.1:12345/;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        client_max_body_size 6m;   # 略大于分片即可
    }
}
```

访问 `https://chat.example.com/chat/` 即可；带 `X-Forwarded-For` 的真实 IP 需 `-trusted-proxies` 指定代理网段。

## API 一览

响应统一 `{"code": http状态码, "message": "ok|错误", "data": {...}}`；文件 URL 一律相对路径。
群成员令牌：`X-Room-Token` header（fetch 场景）或 `?token=`（`<img>`/`<a>` 场景）。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `api/config` | 公开站点参数 |
| POST | `api/room/create` | 群主首条文字消息建群 `{text, expire_value, expire_style}` → `{room, token, member, message}` |
| POST | `api/room/join/{code}` | 加入（带有效 token 返回原身份，否则分配新访客编号） |
| GET | `api/room/{code}/messages?after=N` | 轮询拉取消息（增量）+ 群状态 + 自身身份 |
| POST | `api/room/{code}/send/text` | 发文字 `{token, text}` |
| POST | `api/room/send/file` | 发文件（multipart：`code`/`token`/`file`，无 code 即建群） |
| GET | `api/room/{code}/messages/{msg}/file` | 消息文件下载；图片可 `?inline=1`（仅成员） |
| GET/PUT | `api/room/{code}/settings` | 群主读写设置：`allow_reply`、`expire_style/expire_value` |
| POST | `api/upload/init` / PUT `api/upload/{id}/{n}` / POST `api/upload/{id}/complete` / GET `api/upload/{id}/status` | 分片上传（complete 带 `{code, token}` 入群） |
| GET | `api/admin/*` | 管理后台（status/setup/login/config/list/room 删除） |

示例：

```bash
# 群主建群
R=$(curl -s -X POST http://127.0.0.1:12345/api/room/create \
  -H 'Content-Type: application/json' \
  -d '{"text":"大家好","expire_value":1,"expire_style":"day"}')
CODE=$(echo $R | jq -r .data.room.code)
TOKEN=$(echo $R | jq -r .data.token)

# 访客加入
curl -s -X POST http://127.0.0.1:12345/api/room/join/$CODE

# 群主发文件
curl -s -X POST http://127.0.0.1:12345/api/room/send/file \
  -F "code=$CODE" -F "token=$TOKEN" -F "file=@报告.pdf"

# 拉取消息（轮询 after=已见最大消息 id）
curl -s "http://127.0.0.1:12345/api/room/$CODE/messages?after=0" -H "X-Room-Token: $TOKEN"
```

## 数据结构

所有状态都在 `-data` 目录：`filesender.db`（rooms/members/messages/settings）、`share/`（文件）、`chunks/`（未完成分片）。停机整目录拷贝即备份。

## 前端技术栈

Vite + React 19（`frontend/`），构建产物输出到 `internal/web/dist` 并由 Go `embed` 进二进制：
- `base: './'` 保持资产相对路径引用，反向代理子路径开箱即用
- 无 UI 框架依赖（仅 react/react-dom），样式为手写 CSS（明暗主题 CSS 变量）
- 会话身份存 `sessionStorage`（不跨标签页）；分片上传为 XHR 字节级进度 + EMA 网速

## 与原版 FileCodeBox 的差异

- 形态从"单条分享"演进为"局域网临时群"：群号=原取件码，群主/访客多对多收发，到期自动解散
- Go 单二进制（内嵌 React 构建产物）、全相对路径、启动打印局域网地址、分片上传默认开启（原版关闭）
- 未实现：WebSocket 推送（现为 2.5s 轮询）、多存储后端（接口已预留）、多语言
