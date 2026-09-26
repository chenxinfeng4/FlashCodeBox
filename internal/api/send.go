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
//   - count: expires after N pickups (backstopped by maxSaveSeconds)
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
// share / item helpers

type expireFields struct {
	Code        string `json:"code" form:"code"` // 非空 = 追加到该分享
	ExpireValue int64  `json:"expire_value" form:"expire_value"`
	ExpireStyle string `json:"expire_style" form:"expire_style"`
}

// resolveShare loads the share to append to; empty code means "create new".
func (a *App) resolveShare(ctx context.Context, rawCode string) (*models.FileCode, int, error) {
	code := normalizeCode(rawCode)
	if code == "" {
		return nil, 0, nil
	}
	fc, err := a.Store.GetByCode(ctx, code)
	if errors.Is(err, store.ErrNotFound) {
		return nil, http.StatusNotFound, errors.New("分享不存在，可能已过期，请生成新的取件码")
	}
	if err != nil {
		return nil, http.StatusInternalServerError, err
	}
	if fc.IsExpired(models.Now()) {
		a.removeShare(ctx, fc)
		return nil, http.StatusGone, errors.New("分享已过期，无法继续添加，请生成新的取件码")
	}
	return fc, 0, nil
}

// createShareHeader inserts a new share header with a fresh unique code.
func (a *App) createShareHeader(ctx context.Context, ef expireFields) (*models.FileCode, error) {
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
			ExpireAt:    expireAt,
			ExpireCount: expireCount,
			CreatedAt:   now.Unix(),
		}
		err = a.Store.InsertShare(ctx, fc)
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

// appendItem adds one item to a share (creating the header first when needed).
func (a *App) appendItem(ctx context.Context, share *models.FileCode, it *models.ShareItem, ef expireFields) (*models.FileCode, error) {
	if share == nil {
		var err error
		share, err = a.createShareHeader(ctx, ef)
		if err != nil {
			return nil, err
		}
	}
	n, err := a.Store.CountShareItems(ctx, share.Code)
	if err != nil {
		return nil, err
	}
	if n >= models.MaxItemsPerShare {
		return nil, fmt.Errorf("该取件码下内容已达上限（%d 条），请新开分享", models.MaxItemsPerShare)
	}
	it.ShareCode = share.Code
	it.CreatedAt = models.Now()
	if err := a.Store.AddShareItem(ctx, it); err != nil {
		return nil, err
	}
	return share, nil
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

// shareStateResp tells the sender which code the content landed in.
func shareStateResp(fc *models.FileCode, itemType string, label string) gin.H {
	return gin.H{
		"code":         fc.Code,
		"expire_at":    fc.ExpireAt,
		"expire_count": fc.ExpireCount,
		"created_at":   fc.CreatedAt,
		"item_type":    itemType,
		"item_label":   label,
	}
}

// ---------------------------------------------------------------------------
// text share

type sendTextReq struct {
	Text        string `json:"text" form:"text" binding:"required"`
	Code        string `json:"code" form:"code"`
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
	share, status, err := a.resolveShare(c.Request.Context(), req.Code)
	if err != nil {
		fail(c, status, err.Error())
		return
	}
	item := &models.ShareItem{Type: models.TypeText, Text: text, Size: int64(len(text))}
	share, err = a.appendItem(c.Request.Context(), share, item, expireFields{
		Code: req.Code, ExpireValue: req.ExpireValue, ExpireStyle: req.ExpireStyle,
	})
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	ok(c, shareStateResp(share, models.TypeText, previewText(text, 40)))
}

func previewText(s string, n int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) > n {
		return string(r[:n]) + "…"
	}
	return string(r)
}

// ---------------------------------------------------------------------------
// file share (streaming multipart; multiple `file` parts allowed)

func (a *App) SendFile(c *gin.Context) {
	if !requireOpenUpload(c, a) {
		return
	}
	cfg := a.Cfg.Get()
	// Cheap early rejection before touching the body.
	const slack = 4 << 20
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
		ef      expireFields
		share   *models.FileCode
		pending []*models.ShareItem // 流式落盘后暂存，流解析完统一入库
		skipped []string
		cleanup []string
	)
	defer func() {
		for _, p := range cleanup {
			_ = a.Storage.Delete(p)
		}
	}()
	addSkipped := func(name, reason string) {
		skipped = append(skipped, name+": "+reason)
	}

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
		case "code":
			b, _ := io.ReadAll(io.LimitReader(part, 32))
			ef.Code = strings.TrimSpace(string(b))
		case "expire_value":
			b, _ := io.ReadAll(io.LimitReader(part, 64))
			ef.ExpireValue = parseInt64(strings.TrimSpace(string(b)))
		case "expire_style":
			b, _ := io.ReadAll(io.LimitReader(part, 64))
			ef.ExpireStyle = strings.TrimSpace(string(b))
		case "file":
			name := storage.SanitizeFilename(part.FileName())
			if name == "" {
				addSkipped(part.FileName(), "文件名无效")
				_, _ = io.Copy(io.Discard, part)
				continue
			}
			if !storage.ExtAllowed(name, cfg.AllowedTypes) {
				addSkipped(name, "文件类型不被允许")
				_, _ = io.Copy(io.Discard, part)
				continue
			}
			relPath := storage.NewRelPath(name)
			limited := io.LimitReader(part, cfg.MaxUploadSize+1)
			size, hash, err := a.Storage.SaveStream(limited, relPath)
			if err != nil {
				fail(c, http.StatusInternalServerError, "文件保存失败: "+err.Error())
				return
			}
			if size > cfg.MaxUploadSize {
				_ = a.Storage.Delete(relPath)
				addSkipped(name, fmt.Sprintf("超过大小限制（最大 %s）", humanBytes(cfg.MaxUploadSize)))
				continue
			}
			// multipart 字段顺序任意：先落盘暂存，解析完 code 后统一入库
			cleanup = append(cleanup, relPath)
			pending = append(pending, &models.ShareItem{
				Type: models.TypeFile, StoragePath: relPath, Filename: name,
				Size: size, FileHash: hash,
			})
		default:
			_, _ = io.Copy(io.Discard, part)
		}
	}

	if len(pending) == 0 {
		if len(skipped) > 0 {
			fail(c, http.StatusBadRequest, strings.Join(skipped, "；"))
			return
		}
		fail(c, http.StatusBadRequest, "缺少文件字段 file")
		return
	}

	// 流解析完毕：确定分享（追加或新建），再逐条入库
	share, status, err := a.resolveShare(c.Request.Context(), ef.Code)
	if err != nil {
		fail(c, status, err.Error())
		return
	}
	for _, it := range pending {
		share, err = a.appendItem(c.Request.Context(), share, it, ef)
		if err != nil {
			fail(c, http.StatusInternalServerError, err.Error())
			return
		}
		cleanup = cleanup[1:] // 已入库的不再清理
	}
	ok(c, gin.H{
		"code":         share.Code,
		"expire_at":    share.ExpireAt,
		"expire_count": share.ExpireCount,
		"created_at":   share.CreatedAt,
		"added":        len(pending),
		"skipped":      skipped,
	})
}

func parseInt64(s string) int64 {
	var n int64
	_, _ = fmt.Sscanf(s, "%d", &n)
	return n
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
