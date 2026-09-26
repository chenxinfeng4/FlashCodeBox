package api

import (
	"bytes"
	"context"
	"errors"
	"mime"
	"net/http"
	"strconv"
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

// GetShare resolves a pickup code and returns ALL of its items (text
// messages + file list). One pickup consumes one use; afterwards the files
// can be downloaded freely.
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

	items, err := a.Store.ListShareItems(c.Request.Context(), code)
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	if len(items) == 0 {
		a.removeShare(c.Request.Context(), fc)
		fail(c, http.StatusGone, "分享内容为空")
		return
	}

	// 取件计次：打开即消耗一次（时间/次数校验在 UPDATE 内原子完成）。
	used, err := a.Store.ConsumeByCode(c.Request.Context(), code, models.Now())
	if errors.Is(err, store.ErrNotFound) {
		fail(c, http.StatusGone, "分享已过期")
		return
	}
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}

	out := make([]gin.H, 0, len(items))
	for _, it := range items {
		entry := gin.H{
			"id":         it.ID,
			"type":       it.Type,
			"created_at": it.CreatedAt,
		}
		if it.Type == models.TypeText {
			entry["text"] = it.Text
		} else {
			entry["filename"] = it.Filename
			entry["size"] = it.Size
			// 相对路径，任何反代子路径/端口下都成立
			entry["download_url"] = "./api/download/" + it.ShareCode + "/" + strconv.FormatInt(it.ID, 10)
		}
		out = append(out, entry)
	}
	ok(c, gin.H{
		"code":         code,
		"expire_at":    used.ExpireAt,
		"expire_count": used.ExpireCount,
		"used_count":   used.UsedCount,
		"created_at":   fc.CreatedAt,
		"items":        out,
	})
}

// Download streams one item. os.File + ServeContent give Range (断点续传)
// support for free; every response is forced to attachment to defuse any
// stored-content XSS (HTML/SVG uploads cannot execute).
//
//	GET api/download/{code}/{itemID}  指定条目
//	GET api/download/{code}           兼容：第一个内容（文本 → .txt）
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

	var item *models.ShareItem
	if raw := c.Param("item"); raw != "" {
		itemID, perr := strconv.ParseInt(raw, 10, 64)
		if perr != nil || itemID < 1 {
			fail(c, http.StatusBadRequest, "条目编号无效")
			return
		}
		item, err = a.Store.GetShareItem(c.Request.Context(), code, itemID)
	} else {
		var items []*models.ShareItem
		items, err = a.Store.ListShareItems(c.Request.Context(), code)
		if err == nil && len(items) > 0 {
			item = items[0]
		}
	}
	if errors.Is(err, store.ErrNotFound) || (err == nil && item == nil) {
		fail(c, http.StatusNotFound, "内容不存在")
		return
	}
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}

	modTime := time.Unix(item.CreatedAt, 0)
	if item.Type == models.TypeText {
		setAttachment(c, "取件_"+code+".txt")
		http.ServeContent(c.Writer, c.Request, code+".txt", modTime,
			bytes.NewReader([]byte(item.Text)))
		return
	}

	f, _, err := a.Storage.Open(item.StoragePath)
	if errors.Is(err, storage.ErrNotFound) {
		// 文件丢了：删掉这个条目，分享继续可用
		_ = a.deleteItem(c.Request.Context(), item)
		fail(c, http.StatusGone, "文件已失效")
		return
	}
	if err != nil {
		fail(c, http.StatusInternalServerError, "文件读取失败: "+err.Error())
		return
	}
	defer f.Close()

	// 下载不再计次——计次发生在取件（api/get）时
	c.Header("Content-Type", "application/octet-stream")
	setAttachment(c, item.Filename)
	http.ServeContent(c.Writer, c.Request, item.Filename, modTime, f)
}

func setAttachment(c *gin.Context, filename string) {
	c.Header("Content-Disposition",
		mime.FormatMediaType("attachment", map[string]string{"filename": filename}))
}

// removeShare deletes the header, its items and all file payloads
// (lazy expiry cleanup).
func (a *App) removeShare(ctx context.Context, fc *models.FileCode) {
	items, err := a.Store.ListShareItems(ctx, fc.Code)
	if err == nil {
		for _, it := range items {
			if it.Type == models.TypeFile && it.StoragePath != "" {
				_ = a.Storage.Delete(it.StoragePath)
			}
		}
	}
	_ = a.Store.DeleteShareCascade(ctx, fc.Code)
}

func (a *App) deleteItem(ctx context.Context, it *models.ShareItem) error {
	if it.Type == models.TypeFile && it.StoragePath != "" {
		_ = a.Storage.Delete(it.StoragePath)
	}
	return a.Store.DeleteShareItem(ctx, it.ShareCode, it.ID)
}
