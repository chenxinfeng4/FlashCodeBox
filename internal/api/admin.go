package api

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"

	"flashcodebox/internal/config"
	"flashcodebox/internal/models"
	"flashcodebox/internal/store"
)

const (
	adminTokenTTL  = 30 * 24 * time.Hour
	minPasswordLen = 8
	maxPasswordLen = 64
)

// ---------------------------------------------------------------------------
// stateless admin tokens: base64url(exp).base64url(hmac_sha256(secret, exp))

func (a *App) newAdminToken(secret string) (string, int64) {
	exp := time.Now().Add(adminTokenTTL).Unix()
	payload := base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(exp, 10)))
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), exp
}

func verifyAdminToken(secret, token string) bool {
	payload, sig, found := strings.Cut(token, ".")
	if !found || payload == "" || sig == "" || secret == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(sig), []byte(want)) != 1 {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return false
	}
	exp, err := strconv.ParseInt(string(raw), 10, 64)
	return err == nil && time.Now().Unix() < exp
}

func (a *App) validAdminToken(c *gin.Context) bool {
	cfg := a.Cfg.Get()
	if cfg.AdminSecret == "" {
		return false
	}
	auth := c.GetHeader("Authorization")
	token, found := strings.CutPrefix(auth, "Bearer ")
	return found && verifyAdminToken(cfg.AdminSecret, strings.TrimSpace(token))
}

// RequireAdmin guards the admin surface.
func (a *App) RequireAdmin(c *gin.Context) {
	if a.validAdminToken(c) {
		c.Next()
		return
	}
	failAbort(c, http.StatusUnauthorized, "未登录或登录已过期")
}

// ---------------------------------------------------------------------------
// setup / login

func (a *App) AdminStatus(c *gin.Context) {
	ok(c, gin.H{"initialized": a.Cfg.Initialized()})
}

type adminPasswordReq struct {
	Password string `json:"password" form:"password" binding:"required"`
}

func (a *App) AdminSetup(c *gin.Context) {
	if a.Cfg.Initialized() {
		fail(c, http.StatusForbidden, "管理密码已初始化，请直接登录")
		return
	}
	var req adminPasswordReq
	if err := c.ShouldBind(&req); err != nil {
		fail(c, http.StatusBadRequest, "缺少密码")
		return
	}
	pw := strings.TrimSpace(req.Password)
	if len(pw) < minPasswordLen || len(pw) > maxPasswordLen {
		fail(c, http.StatusBadRequest, fmt.Sprintf("密码长度需在 %d-%d 位之间", minPasswordLen, maxPasswordLen))
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.DefaultCost)
	if err != nil {
		fail(c, http.StatusInternalServerError, "密码加密失败")
		return
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		fail(c, http.StatusInternalServerError, "生成密钥失败")
		return
	}
	if err := a.Cfg.Update(func(cfg *config.Config) {
		cfg.AdminPasswordHash = string(hash)
		cfg.AdminSecret = base64.RawURLEncoding.EncodeToString(secret)
	}); err != nil {
		fail(c, http.StatusInternalServerError, "保存配置失败: "+err.Error())
		return
	}
	cfg := a.Cfg.Get()
	token, exp := a.newAdminToken(cfg.AdminSecret)
	ok(c, gin.H{"token": token, "expires_at": exp})
}

func (a *App) AdminLogin(c *gin.Context) {
	if !a.Cfg.Initialized() {
		fail(c, http.StatusPreconditionRequired, "尚未初始化，请先设置管理密码")
		return
	}
	var req adminPasswordReq
	if err := c.ShouldBind(&req); err != nil {
		fail(c, http.StatusBadRequest, "缺少密码")
		return
	}
	cfg := a.Cfg.Get()
	if bcrypt.CompareHashAndPassword([]byte(cfg.AdminPasswordHash), []byte(req.Password)) != nil {
		fail(c, http.StatusUnauthorized, "密码错误")
		return
	}
	token, exp := a.newAdminToken(cfg.AdminSecret)
	ok(c, gin.H{"token": token, "expires_at": exp})
}

// ---------------------------------------------------------------------------
// config

var publicAdminConfigFields = func(cfg config.Config) gin.H {
	return gin.H{
		"name":               cfg.Name,
		"description":        cfg.Description,
		"open_upload":        cfg.OpenUpload,
		"max_upload_size":    cfg.MaxUploadSize,
		"max_text_size":      cfg.MaxTextSize,
		"chunk_size":         cfg.ChunkSize,
		"code_type":          cfg.CodeType,
		"allowed_types":      cfg.AllowedTypes,
		"max_save_seconds":   cfg.MaxSaveSeconds,
		"rate_limit_count":   cfg.RateLimitCount,
		"rate_limit_window":  cfg.RateLimitWindow,
		"chunk_expire_hours": cfg.ChunkExpireHours,
	}
}

func (a *App) AdminGetConfig(c *gin.Context) {
	ok(c, publicAdminConfigFields(a.Cfg.Get()))
}

type adminConfigReq struct {
	Name             string   `json:"name"`
	Description      string   `json:"description"`
	OpenUpload       *bool    `json:"open_upload"`
	MaxUploadSize    int64    `json:"max_upload_size"`
	MaxTextSize      int64    `json:"max_text_size"`
	ChunkSize        int64    `json:"chunk_size"`
	CodeType         string   `json:"code_type"`
	AllowedTypes     []string `json:"allowed_types"`
	MaxSaveSeconds   int64    `json:"max_save_seconds"`
	RateLimitCount   int      `json:"rate_limit_count"`
	RateLimitWindow  int      `json:"rate_limit_window"`
	ChunkExpireHours int      `json:"chunk_expire_hours"`
}

func (a *App) AdminPutConfig(c *gin.Context) {
	var req adminConfigReq
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "配置格式错误: "+err.Error())
		return
	}
	if req.MaxUploadSize < 1<<20 || req.MaxUploadSize > 1<<40 {
		fail(c, http.StatusBadRequest, "单文件大小限制需在 1MB - 1TB 之间")
		return
	}
	if req.MaxTextSize < 1024 || req.MaxTextSize > 10<<20 {
		fail(c, http.StatusBadRequest, "文本大小限制需在 1KB - 10MB 之间")
		return
	}
	if req.ChunkSize < 64<<10 || req.ChunkSize > 64<<20 || req.ChunkSize > req.MaxUploadSize {
		fail(c, http.StatusBadRequest, "分片大小需在 64KB - 64MB 之间且不超过单文件限制")
		return
	}
	if req.CodeType != "number" && req.CodeType != "secret" {
		fail(c, http.StatusBadRequest, "群号类型只能是 number 或 secret")
		return
	}
	types := make([]string, 0, len(req.AllowedTypes))
	hasStar := false
	for _, t := range req.AllowedTypes {
		t = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(t), ".")))
		if t == "" {
			continue
		}
		if t == "*" {
			hasStar = true
			break
		}
		types = append(types, t)
	}
	if hasStar {
		types = []string{"*"}
	}
	if len(types) == 0 {
		fail(c, http.StatusBadRequest, "文件类型白名单不能为空")
		return
	}
	if req.MaxSaveSeconds != 0 && (req.MaxSaveSeconds < 60 || req.MaxSaveSeconds > 365*86400) {
		fail(c, http.StatusBadRequest, "有效期上限需为 0（不限制）或 60 秒 - 365 天")
		return
	}
	// 0 = 关闭限流
	if req.RateLimitCount < 0 || req.RateLimitCount > 10000 ||
		req.RateLimitWindow < 1 || req.RateLimitWindow > 86400 {
		fail(c, http.StatusBadRequest, "限流参数超出范围（次数 0-10000，0 为关闭；窗口 1-86400 秒）")
		return
	}
	if req.ChunkExpireHours < 1 || req.ChunkExpireHours > 720 {
		fail(c, http.StatusBadRequest, "分片保留时间需在 1 - 720 小时")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" || len(name) > 60 {
		fail(c, http.StatusBadRequest, "站点名称需为 1-60 个字符")
		return
	}
	if len(req.Description) > 200 {
		fail(c, http.StatusBadRequest, "描述不能超过 200 字符")
		return
	}

	if err := a.Cfg.Update(func(cfg *config.Config) {
		cfg.Name = name
		cfg.Description = req.Description
		if req.OpenUpload != nil {
			cfg.OpenUpload = *req.OpenUpload
		}
		cfg.MaxUploadSize = req.MaxUploadSize
		cfg.MaxTextSize = req.MaxTextSize
		cfg.ChunkSize = req.ChunkSize
		cfg.CodeType = req.CodeType
		cfg.AllowedTypes = types
		cfg.MaxSaveSeconds = req.MaxSaveSeconds
		cfg.RateLimitCount = req.RateLimitCount
		cfg.RateLimitWindow = req.RateLimitWindow
		cfg.ChunkExpireHours = req.ChunkExpireHours
	}); err != nil {
		fail(c, http.StatusInternalServerError, "保存配置失败: "+err.Error())
		return
	}
	ok(c, publicAdminConfigFields(a.Cfg.Get()))
}

// ---------------------------------------------------------------------------
// share management

func (a *App) AdminList(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("page_size", "20"))
	if page < 1 {
		page = 1
	}
	if size < 1 {
		size = 20
	}
	if size > 100 {
		size = 100
	}
	rooms, total, err := a.Store.ListRooms(c.Request.Context(), (page-1)*size, size)
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	codes := make([]string, 0, len(rooms))
	for _, r := range rooms {
		codes = append(codes, r.Code)
	}
	msgsByRoom, err := a.Store.MessagesForRooms(c.Request.Context(), codes)
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	now := models.Now()
	items := make([]gin.H, 0, len(rooms))
	for _, r := range rooms {
		var textCount, fileCount, totalSize int64
		preview := ""
		for _, m := range msgsByRoom[r.Code] {
			switch m.Type {
			case models.TypeText:
				textCount++
				if preview == "" {
					preview = previewText(m.Text, 60)
				}
			case models.TypeFile:
				fileCount++
				totalSize += m.Size
				if preview == "" {
					preview = m.Filename
				}
			}
		}
		memberCount, _ := a.Store.CountMembers(c.Request.Context(), r.Code)
		items = append(items, gin.H{
			"code":        r.Code,
			"msg_count":   textCount + fileCount,
			"text_count":  textCount,
			"file_count":  fileCount,
			"total_size":  totalSize,
			"members":     memberCount,
			"preview":     preview,
			"allow_reply": r.AllowReply,
			"expire_at":   r.ExpireAt,
			"created_at":  r.CreatedAt,
			"expired":     r.IsExpired(now),
		})
	}
	ok(c, gin.H{"total": total, "page": page, "page_size": size, "items": items})
}

func (a *App) AdminDelete(c *gin.Context) {
	code := normalizeCode(c.Param("code"))
	if _, err := a.Store.GetRoom(c.Request.Context(), code); errors.Is(err, store.ErrNotFound) {
		fail(c, http.StatusNotFound, "记录不存在")
		return
	}
	// 先删文件，再级联删消息、成员和群
	msgs, err := a.Store.ListMessages(c.Request.Context(), code, 0, models.MaxMessagesPerRoom+1)
	if err == nil {
		for _, m := range msgs {
			if m.Type == models.TypeFile && m.StoragePath != "" {
				_ = a.Storage.Delete(m.StoragePath)
			}
		}
	}
	if err := a.Store.DeleteRoomCascade(c.Request.Context(), code); err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	ok(c, gin.H{"deleted": code})
}
