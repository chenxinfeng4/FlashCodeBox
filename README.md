<div align="center">

<img src="./.github/images/logo.svg" alt="FlashCodeBox" width="96" />

# FlashCodeBox · 快闪群传

### 局域网里的临时群：报个群号就进来，传文件像发消息

**同一 Wi-Fi，开箱即用；到期自动解散，数据不出内网。**

[![License](https://img.shields.io/badge/License-MIT-3da639?style=flat-square)](./LICENSE)
[![Go](https://img.shields.io/badge/Go-1.27-00ADD8?style=flat-square&logo=go&logoColor=white)](./go.mod)
[![Node](https://img.shields.io/badge/Node-24-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](./frontend/package.json)
[![Docker](https://img.shields.io/badge/Docker-多架构-2496ED?style=flat-square&logo=docker&logoColor=white)](#docker-部署)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-111111?style=flat-square)](#参与贡献)

[English](./README.en.md)　·　[快速开始](#一条命令开始)　·　[常见问题](#常见问题)

</div>

<img src="./.github/images/screenshot.webp" alt="FlashCodeBox 聊天界面" width="100%" />

## 这是什么

一个**单文件、零依赖**的局域网临时群聊工具。打开网页就是一个微信群式的窗口：

- 发第一条消息（或第一个文件）→ **自动建群**，生成 5 位**群号**，你就是**群主**
- 把群号或邀请链接丢给同一 Wi-Fi 下的同事/家人 → 输入即入，成为**访客**（人数不限）
- 文字、文件、图片都能发；文件分片上传，**跑满内网带宽**；图片可缩略图 + 点开放大
- 到期（默认 1 天）**整群自动解散**，消息与文件一并删除，数据只留在你自己的机器上

适合：**会议室临时传资料、同事之间传大文件、家庭内网共享照片、不想注册任何账号的即用即走场景**。

## 一条命令开始

### 方式 A：Docker（推荐）

```bash
git clone https://github.com/chenxinfeng4/FlashCodeBox.git
cd FlashCodeBox
docker compose up -d --build
```

或者用一键脚本（镜像不存在会自动构建，并打印局域网访问地址）：

```bash
bash scripts/quickstart.sh
```

也可以直接用已发布的镜像：

```bash
docker run -d --restart unless-stopped \
  -p 12345:12345 \
  -v flashcodebox-data:/data \
  -e TZ=Asia/Shanghai \
  --log-opt max-size=10m --log-opt max-file=3 \
  --name flashcodebox \
  ghcr.io/chenxinfeng4/flashcodebox:latest
```

启动后打开 `http://localhost:12345` 即可。

### 方式 B：本地二进制（无需 Docker）

无需编译环境：从 [Releases](https://github.com/chenxinfeng4/FlashCodeBox/releases/latest) 直接下载编译好的二进制，覆盖 **Linux**（amd64/arm64）、**macOS**（Apple Silicon）、**Windows**（x86_64）；tar.gz/zip 包内另附说明文档：

```bash
# Linux amd64；按平台替换文件名：
#   flashcodebox-linux-arm64 / flashcodebox-darwin-arm64 / flashcodebox-windows-amd64.exe
wget https://github.com/chenxinfeng4/FlashCodeBox/releases/latest/download/flashcodebox-linux-amd64 -O flashcodebox
chmod +x flashcodebox
./flashcodebox -port 12345 -data ./data
```

> macOS 若浏览器下载后运行被 Gatekeeper 拦截：`xattr -d com.apple.quarantine flashcodebox-darwin-arm64`

也可以自行构建（需要 Go 1.27+ 与 Node 24+）：

```bash
bash scripts/build.sh          # 前端 Vite → Go embed → build/flashcodebox
./build/flashcodebox -port 12345 -data ./data
```

启动日志会直接给出局域网地址，手机连同一 Wi-Fi 即可打开：

```
快闪群传 (FlashCodeBox) 1.0.0 已启动: http://:12345  数据目录: /path/to/data
局域网访问: http://192.168.1.20:12345
```

## 初始化

站点首次访问需要设置**管理密码**（仅用于管理后台，群聊本身不需要登录）：

1. 打开首页 → 右上角「管理」→ 设置管理密码（≥ 8 位）
2. 之后可在管理后台在线修改：站点名称/描述、上传大小、分片大小、群号类型、类型白名单、有效期上限、IP 限流等

自动化部署可用脚本免手动初始化：

```bash
ADMIN_PASSWORD=yourpassword bash scripts/init-admin.sh
# 自定义地址：BASE=http://127.0.0.1:8080 ADMIN_PASSWORD=... bash scripts/init-admin.sh
```

## 特性

| | |
|---|---|
| **即用即走** | 无需注册、无需账号；发第一条消息即建群，5 位群号/邀请链接加入 |
| **局域网优先** | 启动打印局域网地址，同一 Wi-Fi 直接访问；文件在内网传输，数据不出网 |
| **文字 / 文件 / 图片** | 微信式气泡；文件卡片（类型图标）；图片缩略图 + 灯箱放大 |
| **大文件友好** | 分片上传（默认 5MB/片）带字节级进度与网速；断点续传；sha256 校验 |
| **自动解散** | 默认 1 天到期，可改小时/天/永久；后台协程清理过期群、空群、未完成分片 |
| **群主可控** | 群主可关闭“访客回消息”、修改保留时长；一键复制群号 / 邀请链接 |
| **单二进制** | 前端已 embed，数据库为纯 Go SQLite；无任何运行期依赖，交叉编译即可 |
| **反代友好** | 全相对路径、服务端不生成绝对 URL，子路径/任意端口开箱即用 |
| **明暗主题** | 跟随按钮一键切换，移动端满屏适配 |

<img src="./.github/images/screenshot-mobile.webp" alt="移动端" width="320" />

## Docker 部署

`docker-compose.yml` 默认使用**命名卷** `flashcodebox-data` 存放数据（开箱即用），端口 `12345`，可用 `.env` 覆盖：

```bash
cp .env.example .env    # 可选：改端口/时区
docker compose up -d --build
docker compose logs -f
docker compose down
```

想把数据放在宿主机目录，编辑 `docker-compose.yml` 换成 bind mount；容器以非 root 用户（uid 1000）运行，宿主目录需可写：

```bash
sudo mkdir -p ./data && sudo chown -R 1000:1000 ./data
# 然后把 volumes 改为 - ./data:/data
```

用一键脚本 `quickstart.sh` 时会自动以当前用户身份运行，bind mount 也不会有权限问题。

多架构镜像由 GitHub Actions 在推送 `v*` 标签时自动构建并发布到 GHCR（`linux/amd64`、`linux/arm64`），见 [`.github/workflows/docker.yml`](./.github/workflows/docker.yml)。

> Dockerfile 默认使用国内镜像源（apk = 清华、npm = npmmirror、GOPROXY = goproxy.cn）。海外构建可覆盖：
> `docker build --build-arg APK_MIRROR=dl-cdn.alpinelinux.org --build-arg NPM_REGISTRY=https://registry.npmjs.org --build-arg GOPROXY=https://proxy.golang.org,direct .`

## 配置

命令行参数（亦可用环境变量）：

| flag | 环境变量 | 默认 | 说明 |
|------|---------|------|------|
| `-port` | `PORT` | `12345` | 监听端口（默认绑定 `0.0.0.0`） |
| `-data` | `DATA_DIR` | `./data` | 数据目录（数据库/文件/配置） |
| `-trusted-proxies` | `TRUSTED_PROXIES` | 空 | 可信反代网段（逗号分隔 CIDR），用于取真实客户端 IP |
| `-debug` | `DEBUG=1` | 关 | 调试日志 |

其余配置（站点名、上传上限、分片大小、群号类型、类型白名单、有效期上限、限流等）均可在**管理后台**在线修改，实时生效。

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

访问 `https://chat.example.com/chat/`；若要记录真实客户端 IP，请用 `-trusted-proxies` 指定代理网段（如 `127.0.0.1/32,10.0.0.0/8`）。

## 终端使用（CLI / curl）

API 全部为相对路径、令牌走 header 或 `?token=`，无需注册登录，终端可直接使用。

### CLI 脚本（推荐）

```bash
export FCB_BASE=http://192.168.1.20:12345     # 服务地址（默认本机 12345）
bash scripts/cli.sh create "会议资料群"        # 建群（成为群主），会话存 ~/.fcb_session
bash scripts/cli.sh sendfile 报告.pdf 照片.png # 发文件
bash scripts/cli.sh send "来自终端的消息"
bash scripts/cli.sh ls                        # 列出最近消息
bash scripts/cli.sh down 3                    # 下载 #3 消息的文件到当前目录
bash scripts/cli.sh join 12345                # 凭群号加入（另一台机器/另一个终端）
bash scripts/cli.sh dissolve                  # 解散群（仅群主）
```

依赖 `curl` + `jq`；会话文件可用 `FCB_SESSION` 指定，多终端互不干扰。

> opencode 用户：仓库内置同名 skill（`.opencode/skills/flashcodebox-cli/`），
> 会话中提到"传文件/下载/查消息"即可自动触发，复制到 `~/.config/opencode/skills/` 可全局启用。

### curl 速查

```bash
B=http://127.0.0.1:12345

# 建群（发首条消息即建群，成为群主）
R=$(curl -s -X POST $B/api/room/create -H 'Content-Type: application/json' \
  -d '{"text":"大家好","expire_value":1,"expire_style":"day"}')
CODE=$(echo $R | jq -r .data.room.code); TOKEN=$(echo $R | jq -r .data.token)

# 访客加入
GUEST=$(curl -s -X POST $B/api/room/join/$CODE | jq -r .data.token)

# 发文字 / 发文件（multipart 流式直传）
curl -s -X POST $B/api/room/$CODE/send/text -H 'Content-Type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"text\":\"你好\"}"
curl -s -X POST $B/api/room/send/file -F "code=$CODE" -F "token=$TOKEN" -F "file=@报告.pdf"

# 查询消息（增量拉取，?after=最后已见消息 id）
curl -s "$B/api/room/$CODE/messages?after=0" -H "X-Room-Token: $TOKEN"

# 下载文件（消息 id 3；header 或 query 均可）
curl -s "$B/api/room/$CODE/messages/3/file?token=$TOKEN" -o 报告.pdf

# 群主解散群（删除全部消息与文件）
curl -s -X DELETE $B/api/room/$CODE -H "X-Room-Token: $TOKEN"
```

大文件推荐走分片上传（`api/upload/init` → `PUT api/upload/:id/:n` → `api/upload/:id/complete`，支持断点续传与 sha256 校验），网页端默认使用；curl 直传与分片均受管理后台「单文件上限」约束。

## 技术栈

- **后端**：Go 1.27 · Gin · `modernc.org/sqlite`（纯 Go，无 CGO）
- **前端**：Vite 7 · React 19 · TypeScript（strict）· 手写 CSS（明暗主题 CSS 变量），产物由 `go:embed` 打进二进制
- **存储**：所有状态在 `-data` 目录 —— `flashcodebox.db`（群/成员/消息/配置）、`share/`（文件）、`chunks/`（未完成分片）；停机整目录拷贝即备份
- **鉴权**：群成员随机令牌（header / query 双通道）；管理端 Bearer 令牌

## 常见问题

<details>
<summary>手机/别人电脑打不开？</summary>

- 确认在同一局域网，且用**局域网 IP**（如 `http://192.168.1.20:12345`）而不是 `localhost`
- 检查防火墙是否放行端口；Docker 部署确认端口已映射
- 启动日志里的 `局域网访问:` 行即正确地址

</details>

<details>
<summary>文件太大传不动？</summary>

默认单文件上限 1 GiB、分片 5 MiB。可在管理后台调整「单文件上限 / 分片大小」。反向代理时记得把 `client_max_body_size` 设得略大于分片。

</details>

<details>
<summary>群到期后数据还在吗？</summary>

不在。过期群的消息与文件由后台协程删除。数据仅存于 `-data` 目录，备份请在停机后整目录拷贝。

</details>

<details>
<summary>如何修改站点名称 / 关闭限流？</summary>

管理后台（`/#/admin`）可改站点名称、描述；限流次数填 `0` 即关闭。

</details>

## 致谢

本项目的灵感来自 [FileCodeBox](https://github.com/vastsa/FileCodeBox)（文件快递柜）——「像取快递一样取文件」的匿名口令分享工具。感谢它用「一个短口令完成一次分享」的极简思路，启发了本项目的诞生。

两者在核心理念上一脉相承：

- **局域网自托管**：部署在自己的机器/内网，数据自主可控、不出网
- **大文件**：分片上传，不惧大文件
- **拖拽上传**：文件拖进页面即传（FlashCodeBox 另支持粘贴）
- **口令（CODE）取件**：无需注册登录，凭短码/群号直接获取内容

在此基础上，FlashCodeBox 做了两点不同的取舍：

| | FileCodeBox | FlashCodeBox |
|---|---|---|
| **对话式交互** | 快递柜式：上传 → 生成口令 → 对方凭码取件 | **微信群式聊天窗**：发条消息即建群，传文件像发消息，对非技术人员更友好 |
| **一个会话多次分享** | 一次分享对应一个口令，多次分享需多次操作 | **一个 session 持续收发**：群内可反复发送文字与多份文件，全员实时可见、随时下载 |
| **收发同界面** | 发送（上传）与取件分属两个页面，需来回切换 | **发送方与接收方在同一界面**：同一个聊天窗互发互见，发完即达，无需切换页面 |
| **反代子路径** | — | **原生支持任意子路径/端口反代**（如 `https://chat.example.com/chat/`），全相对路径、零改造 |

## 参与贡献

欢迎提交 Issue 与 Pull Request。开始前请先跑通 `go test ./...` 与前端构建。

## 许可证

[MIT](./LICENSE) © 2026 chenxinfeng（陈昕枫）

## 免责声明

本项目仅供合法的文件与文本分享场景使用。请勿上传、存储或传播违法、侵权或未经授权的内容；使用者应自行承担部署、数据合规与内容管理责任。

<div align="center">

**如果 FlashCodeBox 对你有帮助，欢迎点亮一个 Star ⭐**

</div>
