package api

import (
	"bytes"
	"context"
	"errors"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"filesender/internal/models"
	"filesender/internal/storage"
	"filesender/internal/store"
)

func normalizeCode(raw string) string {
	return strings.ToUpper(strings.TrimSpace(raw))
}

type getReq struct {
	Code string `json:"code" form:"code" binding:"required"`
}

// GetShare resolves a pickup code. Text shares are consumed here; file
// shares only return metadata + a RELATIVE download_url and are consumed at
// download time, so previewing never burns a use.
func (a *App) GetShare(c *gin.Context) {
	var req getReq
	if err := c.ShouldBind(&req); err != nil {
		fail(c, http.StatusBadRequest, "缺少取件码")
		return
	}
	code := normalizeCode(req.Code)
	fc, err := a.Store.GetByCode(c.Request.Context(), code)
	if errors.Is(err, store.ErrNotFound) {
		fail(c, http.StatusNotFound, "取件码不存在或已过期")
		return
	}
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	if fc.IsExpired(models.Now()) {
		a.removeShare(c.Request.Context(), fc)
		fail(c, http.StatusGone, "分享已过期")
		return
	}

	base := gin.H{"code": fc.Code,
		"type":         fc.Type,
		"expire_at":    fc.ExpireAt,
		"expire_count": fc.ExpireCount,
		"used_count":   fc.UsedCount,
		"created_at":   fc.CreatedAt,
	}
	if fc.Type == models.TypeText {
		// 原子消费一次：WHERE 保证取件码在消费前仍有效（时间未过期且次数未用尽），
		// 消费成功即返回内容；失败的竞争者拿到 ErrNotFound → 410。
		used, err := a.Store.ConsumeByCode(c.Request.Context(), code, models.Now())
		if errors.Is(err, store.ErrNotFound) {
			fail(c, http.StatusGone, "分享已过期")
			return
		}
		if err != nil {
			fail(c, http.StatusInternalServerError, err.Error())
			return
		}
		base["text"] = fc.Text
		base["expire_count"] = used.ExpireCount
		base["used_count"] = used.UsedCount
		ok(c, base)
		return
	}

	// File share: verify the payload still exists before promising a URL.
	exists, err := a.Storage.Exists(fc.StoragePath)
	if err != nil || !exists {
		a.removeShare(c.Request.Context(), fc)
		fail(c, http.StatusGone, "文件已失效")
		return
	}
	base["filename"] = fc.Filename
	base["size"] = fc.Size
	base["download_url"] = "./api/download/" + fc.Code
	ok(c, base)
}

// Download streams the payload. os.File + ServeContent give Range (断点续传)
// support for free; every response is forced to attachment to defuse any
// stored-content XSS (HTML/SVG uploads cannot execute).
func (a *App) Download(c *gin.Context) {
	code := normalizeCode(c.Param("code"))
	fc, err := a.Store.GetByCode(c.Request.Context(), code)
	if errors.Is(err, store.ErrNotFound) {
		fail(c, http.StatusNotFound, "取件码不存在或已过期")
		return
	}
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	if fc.IsExpired(models.Now()) {
		a.removeShare(c.Request.Context(), fc)
		fail(c, http.StatusGone, "分享已过期")
		return
	}

	modTime := time.Unix(fc.CreatedAt, 0)
	if fc.Type == models.TypeText {
		setAttachment(c, "取件_"+fc.Code+".txt")
		http.ServeContent(c.Writer, c.Request, fc.Code+".txt", modTime,
			bytes.NewReader([]byte(fc.Text)))
		return
	}

	f, _, err := a.Storage.Open(fc.StoragePath)
	if errors.Is(err, storage.ErrNotFound) {
		a.removeShare(c.Request.Context(), fc)
		fail(c, http.StatusGone, "文件已失效")
		return
	}
	if err != nil {
		fail(c, http.StatusInternalServerError, "文件读取失败: "+err.Error())
		return
	}
	defer f.Close()

	used, err := a.Store.ConsumeByCode(c.Request.Context(), code, models.Now())
	if errors.Is(err, store.ErrNotFound) {
		fail(c, http.StatusGone, "分享已过期")
		return
	}
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	_ = used

	c.Header("Content-Type", "application/octet-stream")
	setAttachment(c, fc.Filename)
	http.ServeContent(c.Writer, c.Request, fc.Filename, modTime, f)
}

func setAttachment(c *gin.Context, filename string) {
	c.Header("Content-Disposition",
		mime.FormatMediaType("attachment", map[string]string{"filename": filename}))
}

// removeShare deletes the row and its payload (lazy expiry cleanup).
func (a *App) removeShare(ctx context.Context, fc *models.FileCode) {
	if fc.Type == models.TypeFile && fc.StoragePath != "" {
		_ = a.Storage.Delete(fc.StoragePath)
	}
	if _, err := a.Store.DeleteByCode(ctx, fc.Code); err != nil && !errors.Is(err, store.ErrNotFound) {
		return
	}
}
