# FileSender

基于 [FileCodeBox](https://github.com/vastsa/FileCodeBox) 的 Go 语言重写版 —— 用取件码收发文本与文件。
编译后是**单个静态二进制**（前端已内嵌，数据库用纯 Go 的 SQLite 驱动），没有任何运行时依赖。

相对原版 FileCodeBox 的三个核心改进：

| # | 改进 | 说明 |
|---|------|------|
| 1 | **发送与取件同页** | 单页双栏布局，一侧"生成取件码"、一侧"输码取件"，`#/c/取件码` 链接打开自动取件 |
| 2 | **前端全相对路径** | 所有请求都是相对当前页面的 `api/...`，服务端永不生成绝对 URL，反代子路径/任意端口开箱即用 |
| 3 | **反代大文件上传修复** | 分片上传默认开启（5MB/片，可配置），避开 `client_max_body_size` 与代理缓冲问题；支持断点续传、整文件 sha256 校验 |

## 功能

- **聊天式发送**：一个输入框混搭文字与多文件（📎/拖拽/粘贴），生成取件码后**可继续追加内容**，同一批内容共用一个取件码
- 取件侧按条目展示：文本气泡 + 文件卡片（各自独立下载）
- 5 位取件码（纯数字或去混淆的大写字母+数字）
- 过期策略：天 / 小时 / 分钟 / 可取次数 / 永久（可设全局有效期上限）；**打开取件即计次**，取件后的下载不再计次
- 分片上传：并发、失败退避重试、刷新页面后断点续传、分片与整文件 sha256 校验
- 下载支持 HTTP Range（断点续传下载），响应强制 `Content-Disposition: attachment`
- 精简管理后台（`#/admin`）：首次进入设置管理密码；站点配置在线修改、分享记录列表/删除
- IP 限流（滑动窗口，次数设 0 可关闭）、文件类型白名单、上传大小限制
- 后台协程自动清理过期分享、未完成的分片会话与孤儿分片
- 配置存 SQLite，重启保留；SQLite 为 WAL 模式 + 单连接，免运维

## 快速开始

```bash
# 构建（Go ≥ 1.22）
go build -o filesender ./cmd/filesender

# 运行
./filesender -port 12345 -data ./data
```

打开 `http://127.0.0.1:12345` 即可使用。首次进入管理页（右上角"管理"）设置管理密码完成初始化——**收发分享本身不需要密码**，管理密码只保护后台。

### 启动参数 / 环境变量

| flag | 环境变量 | 默认 | 说明 |
|------|---------|------|------|
| `-port` | `PORT` | `12345` | 监听端口 |
| `-data` | `DATA_DIR` | `./data` | 数据目录（数据库/文件/配置） |
| `-trusted-proxies` | `TRUSTED_PROXIES` | 空 | 可信反代网段（逗号分隔 CIDR）。留空则不信任任何 `X-Forwarded-*` 头（限流/日志用 TCP 对端地址） |
| `-debug` | `DEBUG=1` | 关 | gin 调试日志 |

### 运行时可改配置（管理后台）

站点名称/描述、开放匿名上传、单文件上限（默认 1GB）、文本上限（默认 1MB）、
分片大小（默认 5MB）、取件码类型、类型白名单、有效期上限、限流参数、分片保留时长。

## 反向代理部署（重点）

得益于全相对路径 + 分片上传，**子路径、不同端口都可以**，无需改任何代码或配置：

### nginx —— 子路径 + 不同端口

```nginx
server {
    listen 443 ssl;                      # 对外端口与后端不同也完全没问题
    server_name filesender.example.com;

    location /filesender/ {              # 子路径部署
        proxy_pass http://127.0.0.1:12345/;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # 分片上传每片默认 5MB，body 限制只需略大于分片即可（不必放开到整个文件大小）
        client_max_body_size 6m;
    }
}
```

访问 `https://filesender.example.com/filesender/` 即可。
原理：前端从 `/filesender/` 页面发起 `api/...` 相对请求 → 浏览器自动解析为 `/filesender/api/...` → nginx 去掉前缀转发。访问不带斜杠的 `/filesender` 时服务端会 301 补斜杠。

> 注意：即便忘了配 `client_max_body_size`（nginx 默认 1m），把分片大小在管理后台调到 ≤1MB 依然能正常传大文件——这正是分片设计对反代友好的意义。

### nginx —— 域名根路径

```nginx
location / {
    proxy_pass http://127.0.0.1:12345;
    proxy_set_header Host $host;
    client_max_body_size 6m;
}
```

### Caddy

```caddyfile
filesender.example.com {
    handle_path /filesender/* {
        reverse_proxy 127.0.0.1:12345
    }
    # 或根路径： reverse_proxy 127.0.0.1:12345
}
```

如果部署在反代后并希望限流/日志记录真实客户端 IP，把代理网段传给服务端：

```bash
./filesender -trusted-proxies 127.0.0.1,10.0.0.0/8
```

## API 一览

响应统一为 `{"code": http状态码, "message": "ok|错误信息", "data": {...}}`；
`data` 中的下载链接一律为相对路径（`./api/download/...`）。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `api/config` | 公开站点参数 |
| POST | `api/send/text` | 发文本 `{text, expire_value?, expire_style?, code?}`；带 `code` 即追加 |
| POST | `api/send/file` | 发文件（multipart：`file` 可多个 + `code`? + 过期字段），适合小文件/curl |
| POST | `api/upload/init` | 分片上传初始化 `{file_name, file_size, file_hash?}`，同指纹自动续传 |
| PUT | `api/upload/{id}/{n}` | 上传第 n 片（raw body，可选 `X-Chunk-Hash`） |
| GET | `api/upload/{id}/status` | 已传分片查询（断点续传） |
| POST | `api/upload/{id}/complete` | 合并；`{code?}` 追加到已有分享，否则创建 |
| POST/GET | `api/get` | 输码取件：**计次**，返回全部条目（文本内容+文件列表） |
| GET | `api/download/{code}/{item}` | 下载指定条目（不计次；支持 Range） |
| GET | `api/download/{code}` | 兼容：下载第一个内容 |
| GET | `api/admin/status` | 是否已初始化 |
| POST | `api/admin/setup` | 首次设置管理密码 |
| POST | `api/admin/login` | 登录（Bearer token，30 天） |
| GET/PUT | `api/admin/config` | 读取/修改运行时配置（限流次数 0=关闭） |
| GET | `api/admin/list` | 分享记录（分页，含条目聚合） |
| DELETE | `api/admin/share/{code}` | 删除分享（级联删除全部条目与文件） |

示例：

```bash
# 发文本（生成新取件码）
curl -X POST http://127.0.0.1:12345/api/send/text \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello","expire_value":1,"expire_style":"day"}'

# 追加文本到已有分享（共用取件码）
curl -X POST http://127.0.0.1:12345/api/send/text \
  -H 'Content-Type: application/json' \
  -d '{"text":"再来一条","code":"12345"}'

# 发文件（小文件直传，可一次多个）
curl -X POST http://127.0.0.1:12345/api/send/file \
  -F "code=12345" -F "file=@报告.pdf" -F "file=@说明.txt"

# 取件（返回全部条目）
curl -X POST http://127.0.0.1:12345/api/get \
  -H 'Content-Type: application/json' -d '{"code":"12345"}'
```

## 目录结构

```
filesender/
├── cmd/filesender/main.go   # 入口：flag/env、优雅关闭
├── internal/
│   ├── db/                  # SQLite 初始化 + schema
│   ├── config/              # 默认配置 + keyvalue 持久化（管理后台可改）
│   ├── models/              # FileCode / ChunkSession
│   ├── store/               # DAO：取件码生成、原子扣减、分片会话
│   ├── storage/             # Storage 接口 + 本地磁盘实现（流式、防路径穿越）
│   ├── api/                 # handlers：send/get/upload/admin + 限流/CORS
│   ├── janitor/             # 过期清理协程
│   └── web/                 # embed 前端 + SPA fallback + 子路径 301
└── internal/web/static/     # 单页前端（原生 HTML/CSS/JS，无构建步骤）
```

## 与原版 FileCodeBox 的主要差异

- Go 单二进制，前端内嵌，无 Python/Node 运行时
- 发送/取件同页；前端全相对路径，支持任意反代子路径
- 分片上传默认开启（原版默认关闭），规避反代 body 限制导致的"必须同端口"问题
- 一个取件码对应一个可追加的内容包（多条文本 + 多个文件），原版一码只对应一条内容
- 取件码字符集去掉 `0/O/1/I`，避免手抄混淆
- 次数型分享的有效期兜底从 1 天放宽为可配置的全局上限（默认 7 天）
- 计次发生在"打开取件"时（原版文本取一次、文件下载又计一次）
- 未实现：多存储后端（S3/OneDrive/WebDAV/OpenDAL，接口已预留）、多语言界面

## 数据备份

所有状态都在 `-data` 指向的目录：`filesender.db`（数据库）、`share/`（文件）、`chunks/`（未完成分片）。
停机状态下整目录拷贝即可完成备份。
