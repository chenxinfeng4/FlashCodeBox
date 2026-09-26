// Package web embeds the SPA frontend and serves it with an SPA fallback.
package web

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"

	"github.com/gin-gonic/gin"
)

//go:embed all:static
var staticFS embed.FS

// Register mounts the frontend on the engine.
//
// Serving rules:
//   - real files are served as-is (with range + mime support);
//   - any other path falls back to index.html (SPA, hash routing);
//   - a single-segment extension-less path (".../app") is redirected to
//     ".../app/" so RELATIVE api URLs ("api/...") keep resolving under a
//     reverse-proxy prefix.
func Register(r *gin.Engine) {
	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		panic(err)
	}
	r.NoRoute(func(c *gin.Context) {
		p := strings.TrimPrefix(path.Clean("/"+c.Request.URL.Path), "/")
		if p == "" {
			p = "index.html"
		} else if !strings.HasSuffix(c.Request.URL.Path, "/") &&
			path.Ext(p) == "" && !strings.Contains(p, "/") {
			// 单段无扩展名路径（如 "/appsub"）→ 301 补斜杠，让相对路径的
			// API 请求以该目录为基准解析（子路径反代的关键一环）。
			// 多段路径视为 SPA 深链接，直接回退 index.html。
			loc := c.Request.URL.Path + "/"
			if c.Request.URL.RawQuery != "" {
				loc += "?" + c.Request.URL.RawQuery
			}
			c.Redirect(http.StatusMovedPermanently, loc)
			return
		}
		if _, err := fs.Stat(sub, p); err != nil {
			p = "index.html" // SPA fallback
		}
		if p == "index.html" {
			c.Header("Cache-Control", "no-cache")
		}
		http.ServeFileFS(c.Writer, c.Request, sub, p)
	})
}
