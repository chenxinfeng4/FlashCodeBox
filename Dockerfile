# syntax=docker/dockerfile:1

# 国内镜像源（可用 --build-arg 覆盖回官方源）
#   APK_MIRROR    Alpine apk 镜像站主机
#   NPM_REGISTRY  npm registry
#   GOPROXY       Go module proxy（`|` 表示网络错误也依次回退）
ARG APK_MIRROR=mirrors.tuna.tsinghua.edu.cn
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG GOPROXY=https://goproxy.cn|https://proxy.golang.org|direct

# ---------------------------------------------------------------------------
# Stage 1 — 构建前端（与目标架构无关，固定用构建机架构，避免 QEMU 跑 Node）
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:20-alpine AS frontend
ARG NPM_REGISTRY
WORKDIR /src/frontend
# 先装依赖，最大化利用层缓存
COPY frontend/package.json frontend/package-lock.json ./
RUN sed -i "s#https://registry.npmjs.org#${NPM_REGISTRY}#g" package-lock.json \
 && npm ci --no-audit --no-fund --registry="${NPM_REGISTRY}"
COPY frontend/ ./
# vite outDir = ../internal/web/dist
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 — 构建 Go 后端（前端产物已 embed 进二进制）
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS backend
ARG TARGETOS
ARG TARGETARCH
ARG APK_MIRROR
ARG GOPROXY
ENV GOPROXY=${GOPROXY}
WORKDIR /src
RUN sed -i "s#dl-cdn.alpinelinux.org#${APK_MIRROR}#g" /etc/apk/repositories \
 && apk add --no-cache git
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# 用第 1 阶段的新鲜产物覆盖源码树里的预构建 dist
COPY --from=frontend /src/internal/web/dist ./internal/web/dist
# CGO 关闭：modernc.org/sqlite 为纯 Go 实现，可产出静态二进制
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} \
    go build -trimpath -ldflags "-s -w" -o /out/flashcodebox ./cmd/flashcodebox

# ---------------------------------------------------------------------------
# Stage 3 — 极简运行时
# ---------------------------------------------------------------------------
FROM alpine:3.20
ARG APK_MIRROR
RUN sed -i "s#dl-cdn.alpinelinux.org#${APK_MIRROR}#g" /etc/apk/repositories \
 && apk add --no-cache ca-certificates tzdata wget \
 && addgroup -g 1000 -S app \
 && adduser  -u 1000 -S -G app -h /app app

COPY --from=backend /out/flashcodebox /usr/local/bin/flashcodebox

WORKDIR /app
RUN mkdir -p /data && chown -R app:app /data /app

USER app
ENV DATA_DIR=/data \
    PORT=12345 \
    TZ=Asia/Shanghai
VOLUME ["/data"]
EXPOSE 12345

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/config" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["flashcodebox"]
