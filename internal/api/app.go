package api

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"flashcodebox/internal/config"
	"flashcodebox/internal/storage"
	"flashcodebox/internal/store"
)

// Version is overridden at release builds via
// -ldflags "-X flashcodebox/internal/api.Version=<tag>".
var Version = "1.0.0"

// App carries every dependency the handlers need.
type App struct {
	Cfg      *config.Manager
	Store    *store.Store
	Storage  storage.Storage
	ChunkDir string

	sse      *sseHub
	upLim    *limiter
	loginLim *limiter
}

func NewApp(cfg *config.Manager, st *store.Store, sto storage.Storage, chunkDir string) *App {
	return &App{
		Cfg:      cfg,
		Store:    st,
		Storage:  sto,
		ChunkDir: chunkDir,
		sse:      newSSEHub(),
		upLim:    newLimiter(),
		loginLim: newLimiter(),
	}
}

// ---------------------------------------------------------------------------
// response helpers

func ok(c *gin.Context, data any) {
	c.JSON(http.StatusOK, gin.H{"code": 200, "message": "ok", "data": data})
}

func fail(c *gin.Context, httpCode int, msg string) {
	c.JSON(httpCode, gin.H{"code": httpCode, "message": msg})
}

func failAbort(c *gin.Context, httpCode int, msg string) {
	fail(c, httpCode, msg)
	c.Abort()
}

// PublicConfig exposes what the SPA needs before doing anything else.
func (a *App) PublicConfig(c *gin.Context) {
	cfg := a.Cfg.Get()
	ok(c, gin.H{
		"initialized":      a.Cfg.Initialized(),
		"name":             cfg.Name,
		"description":      cfg.Description,
		"open_upload":      cfg.OpenUpload,
		"max_upload_size":  cfg.MaxUploadSize,
		"max_text_size":    cfg.MaxTextSize,
		"chunk_size":       cfg.ChunkSize,
		"code_type":        cfg.CodeType,
		"allowed_types":    cfg.AllowedTypes,
		"max_save_seconds": cfg.MaxSaveSeconds,
		"version":          Version,
	})
}

// ---------------------------------------------------------------------------
// CORS (the SPA talks to same-origin relative URLs; CORS stays permissive so
// the API can also be exercised from tools and alternate frontends)

func CORS() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
		c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Chunk-Hash")
		c.Header("Access-Control-Max-Age", "86400")
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

// ---------------------------------------------------------------------------
// sliding-window per-IP rate limiting (in-process, like the original)

type limiter struct {
	mu   sync.Mutex
	hits map[string][]int64
}

func newLimiter() *limiter { return &limiter{hits: make(map[string][]int64)} }

func (l *limiter) allow(key string, count, window int) bool {
	now := time.Now().Unix()
	threshold := now - int64(window)
	l.mu.Lock()
	defer l.mu.Unlock()

	arr := l.hits[key]
	out := arr[:0]
	for _, t := range arr {
		if t > threshold {
			out = append(out, t)
		}
	}
	if len(out) >= count {
		l.hits[key] = out
		l.sweepLocked(threshold)
		return false
	}
	l.hits[key] = append(out, now)
	return true
}

// sweepLocked drops stale keys once the map grows; keeps memory bounded.
func (l *limiter) sweepLocked(threshold int64) {
	if len(l.hits) < 4096 {
		return
	}
	for k, v := range l.hits {
		keep := v[:0]
		for _, t := range v {
			if t > threshold {
				keep = append(keep, t)
			}
		}
		if len(keep) == 0 {
			delete(l.hits, k)
		} else {
			l.hits[k] = keep
		}
	}
}

func (a *App) uploadRateLimit() gin.HandlerFunc {
	return func(c *gin.Context) {
		cfg := a.Cfg.Get()
		if cfg.RateLimitCount <= 0 || cfg.RateLimitWindow <= 0 {
			c.Next()
			return
		}
		if !a.upLim.allow("up:"+c.ClientIP(), cfg.RateLimitCount, cfg.RateLimitWindow) {
			failAbort(c, http.StatusTooManyRequests, "操作过于频繁，请稍后再试")
			return
		}
		c.Next()
	}
}

const loginLimitCount, loginLimitWindow = 8, 300

func (a *App) loginRateLimit() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !a.loginLim.allow("login:"+c.ClientIP(), loginLimitCount, loginLimitWindow) {
			failAbort(c, http.StatusTooManyRequests, "登录尝试过于频繁，请 5 分钟后再试")
			return
		}
		c.Next()
	}
}
