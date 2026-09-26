package api

import (
	"fmt"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// ---------------------------------------------------------------------------
// 过期计算

var expireStyles = map[string]bool{
	"day": true, "hour": true, "minute": true, "forever": true,
}

func normalizeStyle(style string) string {
	style = strings.ToLower(strings.TrimSpace(style))
	if style == "" {
		return "day"
	}
	return style
}

// computeExpire: day/hour/minute → N 个单位后（受 maxSaveSeconds 封顶）；forever → 永久。
func computeExpire(style string, value, maxSaveSeconds int64, now time.Time) (expireAt int64, err error) {
	if value < 1 {
		value = 1
	}
	if value > 9999 {
		value = 9999
	}
	switch style {
	case "forever":
		return 0, nil
	case "day":
		return capExpire(now.AddDate(0, 0, int(value)), now, maxSaveSeconds), nil
	case "hour":
		return capExpire(now.Add(time.Duration(value)*time.Hour), now, maxSaveSeconds), nil
	case "minute":
		return capExpire(now.Add(time.Duration(value)*time.Minute), now, maxSaveSeconds), nil
	default:
		return 0, fmt.Errorf("不支持的过期类型: %s", style)
	}
}

func capExpire(at time.Time, now time.Time, maxSaveSeconds int64) int64 {
	if maxSaveSeconds > 0 && at.Sub(now) > time.Duration(maxSaveSeconds)*time.Second {
		return now.Unix() + maxSaveSeconds
	}
	return at.Unix()
}

// ---------------------------------------------------------------------------
// 通用

func requireOpenUpload(c *gin.Context, a *App) bool {
	if a.Cfg.Get().OpenUpload {
		return true
	}
	if a.validAdminToken(c) {
		return true
	}
	failAbort(c, http.StatusForbidden, "站点已关闭匿名上传")
	return false
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGTPE"[exp])
}

func parseInt64(s string) int64 {
	var n int64
	_, _ = fmt.Sscanf(s, "%d", &n)
	return n
}

func normalizeCode(raw string) string {
	return strings.ToUpper(strings.TrimSpace(raw))
}

func setAttachment(c *gin.Context, filename string) {
	c.Header("Content-Disposition",
		mime.FormatMediaType("attachment", map[string]string{"filename": filename}))
}

// imageExts 决定 ?inline=1 允许内联展示的扩展名（仅图片；svg 只在
// <img> 上下文渲染，脚本不执行，灯箱同样用 <img>，安全）。
var imageExts = map[string]string{
	".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
	".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
	".svg": "image/svg+xml", ".avif": "image/avif",
}

func imageMime(filename string) string {
	i := strings.LastIndexByte(filename, '.')
	if i < 0 {
		return ""
	}
	return imageExts[strings.ToLower(filename[i:])]
}

func previewText(s string, n int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) > n {
		return string(r[:n]) + "…"
	}
	return string(r)
}
