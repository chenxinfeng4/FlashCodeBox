package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"filesender/internal/models"
	"filesender/internal/storage"
	"filesender/internal/store"
)

// ---------------------------------------------------------------------------
// expiry

var expireStyles = map[string]bool{
	"day": true, "hour": true, "minute": true, "count": true, "forever": true,
}

func normalizeStyle(style string) string {
	style = strings.ToLower(strings.TrimSpace(style))
	if style == "" {
		return "day"
	}
	return style
}

// computeExpire mirrors the original semantics:
//   - day/hour/minute: expires after N units (capped by maxSaveSeconds)
//   - count: expires after N uses (backstopped by maxSaveSeconds)
//   - forever: never expires
func computeExpire(style string, value, maxSaveSeconds int64, now time.Time) (expireAt, expireCount int64, err error) {
	if value < 1 {
		value = 1
	}
	if value > 9999 {
		value = 9999
	}
	switch style {
	case "forever":
		return 0, models.ExpireCountUnlimited, nil
	case "count":
		backstop := int64(30 * 86400)
		if maxSaveSeconds > 0 {
			backstop = maxSaveSeconds
		}
		return now.Unix() + backstop, value, nil
	case "day":
		at := now.AddDate(0, 0, int(value))
		return capExpire(at, now, maxSaveSeconds), models.ExpireCountUnlimited, nil
	case "hour":
		at := now.Add(time.Duration(value) * time.Hour)
		return capExpire(at, now, maxSaveSeconds), models.ExpireCountUnlimited, nil
	case "minute":
		at := now.Add(time.Duration(value) * time.Minute)
		return capExpire(at, now, maxSaveSeconds), models.ExpireCountUnlimited, nil
	default:
		return 0, 0, fmt.Errorf("不支持的过期类型: %s", style)
	}
}

func capExpire(at time.Time, now time.Time, maxSaveSeconds int64) int64 {
	if maxSaveSeconds > 0 && at.Sub(now) > time.Duration(maxSaveSeconds)*time.Second {
		return now.Unix() + maxSaveSeconds
	}
	return at.Unix()
}

// ---------------------------------------------------------------------------
// share creation

type expireFields struct {
	ExpireValue int64  `json:"expire_value" form:"expire_value"`
	ExpireStyle string `json:"expire_style" form:"expire_style"`
}

// createShare inserts a FileCode with a freshly generated unique code.
func (a *App) createShare(ctx context.Context, typ, text, filename, storagePath string,
	size int64, hash string, ef expireFields) (*models.FileCode, error) {

	cfg := a.Cfg.Get()
	style := normalizeStyle(ef.ExpireStyle)
	if !expireStyles[style] {
		return nil, fmt.Errorf("不支持的过期类型: %s", style)
	}
	now := time.Now()
	expireAt, expireCount, err := computeExpire(style, ef.ExpireValue, cfg.MaxSaveSeconds, now)
	if err != nil {
		return nil, err
	}
	for attempt := 0; attempt < store.CodeGenAttempts; attempt++ {
		code, err := store.RandomCode(cfg.CodeType)
		if err != nil {
			return nil, err
		}
		fc := &models.FileCode{
			Code:        code,
			Type:        typ,
			Text:        text,
			StoragePath: storagePath,
			Filename:    filename,
			Size:        size,
			FileHash:    hash,
			ExpireAt:    expireAt,
			ExpireCount: expireCount,
			CreatedAt:   now.Unix(),
		}
		err = a.Store.InsertCode(ctx, fc)
		if err == nil {
			return fc, nil
		}
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			continue // code collision, draw another
		}
		return nil, err
	}
	return nil, errors.New("取件码生成失败，请重试")
}

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

// ---------------------------------------------------------------------------
// text share

type sendTextReq struct {
	Text        string `json:"text" form:"text" binding:"required"`
	ExpireValue int64  `json:"expire_value" form:"expire_value"`
	ExpireStyle string `json:"expire_style" form:"expire_style"`
}

func (a *App) SendText(c *gin.Context) {
	if !requireOpenUpload(c, a) {
		return
	}
	var req sendTextReq
	if err := c.ShouldBind(&req); err != nil {
		fail(c, http.StatusBadRequest, "内容不能为空")
		return
	}
	cfg := a.Cfg.Get()
	text := strings.TrimRight(req.Text, "\r\n")
	if strings.TrimSpace(text) == "" {
		fail(c, http.StatusBadRequest, "内容不能为空")
		return
	}
	if int64(len(text)) > cfg.MaxTextSize {
		fail(c, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("文本超过大小限制（最大 %s）", humanBytes(cfg.MaxTextSize)))
		return
	}
	fc, err := a.createShare(c.Request.Context(), models.TypeText, text, "", "", int64(len(text)), "", expireFields{
		ExpireValue: req.ExpireValue, ExpireStyle: req.ExpireStyle,
	})
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	ok(c, shareResp(fc))
}

// ---------------------------------------------------------------------------
// file share (streaming multipart: the payload never fully buffers)

func (a *App) SendFile(c *gin.Context) {
	if !requireOpenUpload(c, a) {
		return
	}
	cfg := a.Cfg.Get()
	// Cheap early rejection before touching the body.
	const slack = 1 << 20
	if c.Request.ContentLength > cfg.MaxUploadSize+slack {
		fail(c, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("文件超过大小限制（最大 %s）", humanBytes(cfg.MaxUploadSize)))
		return
	}
	mr, err := c.Request.MultipartReader()
	if err != nil {
		fail(c, http.StatusBadRequest, "需要 multipart/form-data 格式")
		return
	}

	var (
		ef       expireFields
		filename string
		relPath  string
		size     int64
		hash     string
		gotFile  bool
		cleanup  []string
		tooBig   bool
		badName  bool
	)
	defer func() {
		for _, p := range cleanup {
			_ = a.Storage.Delete(p)
		}
	}()

	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			fail(c, http.StatusBadRequest, "上传数据解析失败")
			return
		}
		switch part.FormName() {
		case "expire_value":
			b, _ := io.ReadAll(io.LimitReader(part, 64))
			ef.ExpireValue = parseInt64(strings.TrimSpace(string(b)))
		case "expire_style":
			b, _ := io.ReadAll(io.LimitReader(part, 64))
			ef.ExpireStyle = strings.TrimSpace(string(b))
		case "file":
			if gotFile {
				// Drain and ignore extra file parts.
				_, _ = io.Copy(io.Discard, part)
				continue
			}
			name := storage.SanitizeFilename(part.FileName())
			if name == "" || !storage.ExtAllowed(name, cfg.AllowedTypes) {
				badName = true
				_, _ = io.Copy(io.Discard, part)
				continue
			}
			relPath = storage.NewRelPath(name)
			limited := io.LimitReader(part, cfg.MaxUploadSize+1)
			size, hash, err = a.Storage.SaveStream(limited, relPath)
			if err != nil {
				fail(c, http.StatusInternalServerError, "文件保存失败: "+err.Error())
				return
			}
			if size > cfg.MaxUploadSize {
				tooBig = true
				cleanup = append(cleanup, relPath)
				continue
			}
			gotFile = true
			filename = name
		default:
			_, _ = io.Copy(io.Discard, part)
		}
	}

	if badName {
		fail(c, http.StatusBadRequest, "文件类型不被允许")
		return
	}
	if tooBig {
		fail(c, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("文件超过大小限制（最大 %s）", humanBytes(cfg.MaxUploadSize)))
		return
	}
	if !gotFile {
		fail(c, http.StatusBadRequest, "缺少文件字段 file")
		return
	}

	fc, err := a.createShare(c.Request.Context(), models.TypeFile, "", filename, relPath, size, hash, ef)
	if err != nil {
		cleanup = append(cleanup, relPath)
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	ok(c, shareResp(fc))
}

func parseInt64(s string) int64 {
	var n int64
	_, _ = fmt.Sscanf(s, "%d", &n)
	return n
}

// shareResp is the payload returned to the sender right after a share is
// created. download_url is deliberately RELATIVE so it keeps working behind
// any reverse-proxy path/port combination.
func shareResp(fc *models.FileCode) gin.H {
	resp := gin.H{
		"code":         fc.Code,
		"type":         fc.Type,
		"expire_at":    fc.ExpireAt,
		"expire_count": fc.ExpireCount,
		"created_at":   fc.CreatedAt,
	}
	if fc.Type == models.TypeFile {
		resp["filename"] = fc.Filename
		resp["size"] = fc.Size
		resp["download_url"] = "./api/download/" + fc.Code
	}
	return resp
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
