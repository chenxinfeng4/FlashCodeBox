# FlashCodeBox — 常用任务入口
.PHONY: help build run docker compose up down logs test clean dev frontend

IMAGE ?= flashcodebox:latest
PORT  ?= 12345

help: ## 显示帮助
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

build: ## 本地构建（前端 + Go）→ build/flashcodebox
	bash scripts/build.sh

run: build ## 本地构建并运行
	./build/flashcodebox -port $(PORT) -data ./data

dev: ## 开发模式（Go + Vite 热更新）
	bash scripts/dev.sh

frontend: ## 仅构建前端
	cd frontend && npm run build

docker: ## 构建 Docker 镜像
	docker build -t $(IMAGE) .

compose: ## docker compose 一键启动（构建 + 后台）
	docker compose up -d --build

up: ## 一键运行（镜像缺失则自动构建）
	bash scripts/quickstart.sh

down: ## 停止并删除容器
	docker compose down

logs: ## 查看容器日志
	docker compose logs -f

test: ## 运行后端结构测试（go test）
	go test ./...

clean: ## 清理构建产物
	rm -rf build devdata
