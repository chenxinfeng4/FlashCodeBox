package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"

	"flashcodebox/internal/api"
	"flashcodebox/internal/config"
	"flashcodebox/internal/db"
	"flashcodebox/internal/janitor"
	"flashcodebox/internal/storage"
	"flashcodebox/internal/store"
	"flashcodebox/internal/web"
)

func hasAnyPrefix(s string, prefixes ...string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}

// lanAddrs returns the machine's non-loopback IPv4 addresses (deduped), so the
// startup banner can advertise how to reach the server from the local network.
func lanAddrs() []string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		// Skip container/bridge virtual interfaces (docker0, br-*, veth*, virbr*):
		// they are not reachable from other machines on the LAN.
		if hasAnyPrefix(ifc.Name, "docker", "br-", "veth", "virbr") {
			continue
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip4 := ipnet.IP.To4()
			if ip4 == nil || ip4.IsLoopback() || ip4.IsLinkLocalUnicast() || seen[ip4.String()] {
				continue
			}
			seen[ip4.String()] = true
			out = append(out, ip4.String())
		}
	}
	return out
}

func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
		log.Printf("环境变量 %s=%q 不是合法整数，使用默认值 %d", key, v, def)
	}
	return def
}

func main() {
	var (
		port    = flag.Int("port", envInt("PORT", 12345), "监听端口（env: PORT）")
		dataDir = flag.String("data", envOr("DATA_DIR", "./data"), "数据目录（数据库/文件/配置）")
		proxies = flag.String("trusted-proxies", envOr("TRUSTED_PROXIES", ""), "可信反代网段（逗号分隔 CIDR；留空=不信任任何代理头）")
		debug   = flag.Bool("debug", envOr("DEBUG", "") == "1", "调试模式（gin 调试日志）")
	)
	flag.Parse()

	gin.SetMode(gin.ReleaseMode)
	if *debug {
		gin.SetMode(gin.DebugMode)
	}

	absData, err := filepath.Abs(*dataDir)
	if err != nil {
		log.Fatalf("解析数据目录失败: %v", err)
	}

	gdb, err := db.Open(absData)
	if err != nil {
		log.Fatalf("%v", err)
	}
	defer gdb.Close()

	cfgMgr := config.NewManager(gdb)
	if err := cfgMgr.Load(); err != nil {
		log.Fatalf("加载配置失败: %v", err)
	}

	sto, err := storage.NewLocal(filepath.Join(absData, "share"))
	if err != nil {
		log.Fatalf("%v", err)
	}
	chunkDir := filepath.Join(absData, "chunks")
	if err := os.MkdirAll(chunkDir, 0o755); err != nil {
		log.Fatalf("创建分片目录失败: %v", err)
	}

	app := api.NewApp(cfgMgr, store.New(gdb), sto, chunkDir)

	r := gin.New()
	r.Use(gin.Logger(), gin.Recovery(), api.CORS())

	// Trust proxy headers (X-Forwarded-For) only for explicitly configured
	// networks; everything else falls back to the TCP peer address. URL
	// generation never depends on these headers — all URLs are relative.
	var trusted []string
	for _, p := range strings.Split(*proxies, ",") {
		if p = strings.TrimSpace(p); p != "" {
			trusted = append(trusted, p)
		}
	}
	if err := r.SetTrustedProxies(trusted); err != nil {
		log.Fatalf("可信代理配置无效: %v", err)
	}

	api.RegisterRoutes(r, app)
	web.Register(r)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	janitor.Start(ctx, cfgMgr, app.Store, sto, chunkDir)

	addr := fmt.Sprintf(":%d", *port)
	srv := &http.Server{
		Addr:              addr,
		Handler:           r,
		ReadHeaderTimeout: 15 * time.Second,
	}
	go func() {
		log.Printf("快闪群传 (FlashCodeBox) %s 已启动: http://%s  数据目录: %s", api.Version, addr, absData)
		for _, ip := range lanAddrs() {
			log.Printf("局域网访问: http://%s:%d", ip, *port)
		}
		if len(trusted) == 0 {
			log.Printf("提示：部署在反向代理后请用 -trusted-proxies 指定代理网段，日志与限流才能取到真实客户端 IP")
		}
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("HTTP 服务异常退出: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("正在关闭…")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("关闭超时: %v", err)
	}
	log.Println("已退出")
}
