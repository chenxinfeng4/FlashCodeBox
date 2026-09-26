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

	"flashcodebox/internal/models"
	"flashcodebox/internal/storage"
	"flashcodebox/internal/store"
)

// ---------------------------------------------------------------------------
// 群/成员辅助

func roomView(r *models.Room) gin.H {
	return gin.H{
		"code":        r.Code,
		"expire_at":   r.ExpireAt,
		"allow_reply": r.AllowReply,
		"created_at":  r.CreatedAt,
	}
}

func memberView(m *models.Member) gin.H {
	return gin.H{"member_id": m.ID, "role": m.Role, "sender": m.Sender, "guest_no": m.GuestNo}
}

func messageView(m *models.Message) gin.H {
	entry := gin.H{
		"id":         m.ID,
		"member_id":  m.MemberID,
		"role":       m.Role,
		"sender":     m.Sender,
		"type":       m.Type,
		"created_at": m.CreatedAt,
	}
	if m.Type == models.TypeText {
		entry["text"] = m.Text
	} else {
		entry["filename"] = m.Filename
		entry["size"] = m.Size
		entry["download_url"] = fmt.Sprintf("./api/room/%s/messages/%d/file", m.RoomCode, m.ID)
	}
	return entry
}

// loadRoom loads a live room or fails the request.
func (a *App) loadRoom(c *gin.Context, code string) (*models.Room, bool) {
	room, err := a.Store.GetRoom(c.Request.Context(), code)
	if errors.Is(err, store.ErrNotFound) {
		fail(c, http.StatusNotFound, "群号不存在或已过期")
		return nil, false
	}
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return nil, false
	}
	if room.IsExpired(models.Now()) {
		a.removeRoom(c.Request.Context(), room)
		fail(c, http.StatusGone, "群已解散")
		return nil, false
	}
	return room, true
}

// authMember resolves the caller via X-Room-Token header；浏览器发起的
// <img>/<a> 请求带不了自定义 header，故同时接受 ?token=（下载/缩略图场景）。
func (a *App) authMember(c *gin.Context, room *models.Room) *models.Member {
	token := strings.TrimSpace(c.GetHeader("X-Room-Token"))
	if token == "" {
		token = strings.TrimSpace(c.Query("token"))
	}
	if token == "" {
		return nil
	}
	return a.authMemberByToken(c.Request.Context(), room, token)
}

func (a *App) authMemberByToken(ctx context.Context, room *models.Room, token string) *models.Member {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil
	}
	m, err := a.Store.GetMemberByToken(ctx, room.Code, token)
	if err != nil {
		return nil
	}
	return m
}

// checkReplyPermission: 非群主必须携带有效令牌且回复开关打开。
func (a *App) checkReplyPermission(ctx context.Context, room *models.Room, token string) (*models.Member, int, error) {
	m := a.authMemberByToken(ctx, room, token)
	if m == nil {
		return nil, http.StatusForbidden, errors.New("无效的成员令牌，请重新加入")
	}
	if !room.AllowReply && m.Role != models.RoleOwner {
		return nil, http.StatusForbidden, errors.New("群主已关闭访客回消息")
	}
	return m, 0, nil
}

// createRoomWithOwner creates a room + owner member, retrying on code clash.
func (a *App) createRoomWithOwner(ctx context.Context, ef expireFields) (*models.Room, *models.Member, error) {
	cfg := a.Cfg.Get()
	style := normalizeStyle(ef.ExpireStyle)
	if !expireStyles[style] {
		return nil, nil, fmt.Errorf("不支持的过期类型: %s", style)
	}
	now := time.Now()
	expireAt, err := computeExpire(style, ef.ExpireValue, cfg.MaxSaveSeconds, now)
	if err != nil {
		return nil, nil, err
	}
	ownerToken, err := store.RandomToken()
	if err != nil {
		return nil, nil, err
	}
	for attempt := 0; attempt < store.CodeGenAttempts; attempt++ {
		code, err := store.RandomCode(cfg.CodeType)
		if err != nil {
			return nil, nil, err
		}
		room := &models.Room{Code: code, ExpireAt: expireAt, AllowReply: true, CreatedAt: now.Unix()}
		if err := a.Store.InsertRoom(ctx, room); err != nil {
			if strings.Contains(err.Error(), "UNIQUE constraint failed") {
				continue
			}
			return nil, nil, err
		}
		member := &models.Member{
			RoomCode: code, Role: models.RoleOwner, GuestNo: 0,
			Token: ownerToken, Sender: models.SenderNameOwner, CreatedAt: now.Unix(),
		}
		if err := a.Store.InsertMember(ctx, member); err != nil {
			_ = a.Store.DeleteRoomCascade(ctx, code)
			return nil, nil, err
		}
		return room, member, nil
	}
	return nil, nil, errors.New("群号生成失败，请重试")
}

// insertRoomMessage: 消息条数上限校验 + 落库。
func (a *App) insertRoomMessage(ctx context.Context, room *models.Room, member *models.Member,
	build func() *models.Message) (*models.Message, int, error) {

	n, err := a.Store.CountMessages(ctx, room.Code)
	if err != nil {
		return nil, http.StatusInternalServerError, err
	}
	if n >= models.MaxMessagesPerRoom {
		return nil, http.StatusBadRequest,
			fmt.Errorf("群消息已达上限（%d 条）", models.MaxMessagesPerRoom)
	}
	msg := build()
	msg.RoomCode = room.Code
	msg.MemberID = member.ID
	msg.Role = member.Role
	msg.Sender = member.Sender
	msg.CreatedAt = models.Now()
	if err := a.Store.InsertMessage(ctx, msg); err != nil {
		return nil, http.StatusInternalServerError, err
	}
	return msg, 0, nil
}

// appendMessage: room == nil 时创建群（发送者成为群主），否则校验成员身份。
// 返回的 member 在创建路径上直接复用，避免二次查库。
func (a *App) appendMessage(ctx context.Context, room *models.Room, ef expireFields, token string,
	build func() *models.Message) (*models.Room, *models.Member, *models.Message, int, error) {

	if room == nil {
		var err error
		room, member, err := a.createRoomWithOwner(ctx, ef)
		if err != nil {
			return nil, nil, nil, http.StatusInternalServerError, err
		}
		msg, status, err := a.insertRoomMessage(ctx, room, member, build)
		if err != nil {
			_ = a.Store.DeleteRoomCascade(ctx, room.Code)
			return nil, nil, nil, status, err
		}
		return room, member, msg, 0, nil
	}

	member, status, err := a.checkReplyPermission(ctx, room, token)
	if err != nil {
		return nil, nil, nil, status, err
	}
	msg, status, err := a.insertRoomMessage(ctx, room, member, build)
	if err != nil {
		return nil, nil, nil, status, err
	}
	return room, member, msg, 0, nil
}

// ---------------------------------------------------------------------------
// 群创建 / 加入

type expireFields struct {
	Code        string `json:"code" form:"code"`
	Token       string `json:"token" form:"token"`
	ExpireValue int64  `json:"expire_value" form:"expire_value"`
	ExpireStyle string `json:"expire_style" form:"expire_style"`
}

// RoomCreate: 群主发出第一条文字消息时建群（文件走 RoomSendFile）。
func (a *App) RoomCreate(c *gin.Context) {
	if !requireOpenUpload(c, a) {
		return
	}
	cfg := a.Cfg.Get()
	var req struct {
		Text        string `json:"text"`
		ExpireValue int64  `json:"expire_value"`
		ExpireStyle string `json:"expire_style"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "参数错误")
		return
	}
	ef := expireFields{ExpireValue: req.ExpireValue, ExpireStyle: req.ExpireStyle}
	text := strings.TrimRight(req.Text, "\r\n")

	if strings.TrimSpace(text) == "" {
		fail(c, http.StatusBadRequest, "第一条消息不能为空")
		return
	}
	if int64(len(text)) > cfg.MaxTextSize {
		fail(c, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("文本超过大小限制（最大 %s）", humanBytes(cfg.MaxTextSize)))
		return
	}

	room, member, msg, status, err := a.appendMessage(c.Request.Context(), nil, ef, "",
		func() *models.Message {
			return &models.Message{
				Type: models.TypeText, Text: text, Size: int64(len(text)),
			}
		})
	if err != nil {
		fail(c, status, err.Error())
		return
	}
	ok(c, gin.H{
		"room":    roomView(room),
		"token":   member.Token,
		"member":  memberView(member),
		"message": messageView(msg),
	})
}

// JoinRoom: 凭群号加入。带有效 token → 返回既有身份；否则分配新访客编号。
func (a *App) JoinRoom(c *gin.Context) {
	code := normalizeCode(c.Param("code"))
	if code == "" {
		var req struct {
			Code string `json:"code"`
		}
		_ = c.ShouldBindJSON(&req)
		code = normalizeCode(req.Code)
	}
	if code == "" {
		fail(c, http.StatusBadRequest, "缺少群号")
		return
	}
	room, okR := a.loadRoom(c, code)
	if !okR {
		return
	}
	if token := strings.TrimSpace(c.GetHeader("X-Room-Token")); token != "" {
		if m := a.authMember(c, room); m != nil {
			ok(c, gin.H{"room": roomView(room), "token": token, "member": memberView(m)})
			return
		}
	}
	// 新访客：分配递增编号
	guestNo, err := a.Store.NextGuestNo(c.Request.Context(), code)
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	newToken, err := store.RandomToken()
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	member := &models.Member{
		RoomCode: code, Role: models.RoleGuest, GuestNo: guestNo,
		Token: newToken, Sender: fmt.Sprintf("访客%d", guestNo),
		CreatedAt: models.Now(),
	}
	if err := a.Store.InsertMember(c.Request.Context(), member); err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	ok(c, gin.H{"room": roomView(room), "token": newToken, "member": memberView(member)})
}

// ---------------------------------------------------------------------------
// 消息（轮询）

// RoomMessages: 全量（after=0）或增量拉取，返回群状态与自身身份。
func (a *App) RoomMessages(c *gin.Context) {
	code := normalizeCode(c.Param("code"))
	room, okR := a.loadRoom(c, code)
	if !okR {
		return
	}
	member := a.authMember(c, room)
	if member == nil {
		fail(c, http.StatusForbidden, "请先加入群聊")
		return
	}
	var after int64
	_, _ = fmt.Sscanf(c.DefaultQuery("after", "0"), "%d", &after)
	msgs, err := a.Store.ListMessages(c.Request.Context(), code, after, 200)
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	out := make([]gin.H, 0, len(msgs))
	for _, m := range msgs {
		out = append(out, messageView(m))
	}
	ok(c, gin.H{
		"room":     roomView(room),
		"you":      memberView(member),
		"members":  a.memberCount(code),
		"messages": out,
	})
}

func (a *App) memberCount(code string) int {
	n, err := a.Store.CountMembers(context.Background(), code)
	if err != nil {
		return 0
	}
	return n
}

// ---------------------------------------------------------------------------
// 发送

type sendTextReq struct {
	Code  string `json:"code"`
	Token string `json:"token"`
	Text  string `json:"text" binding:"required"`
}

// RoomSendText: 发文字。URL 的 :code 为空 → 建群成为群主。
func (a *App) RoomSendText(c *gin.Context) {
	if !requireOpenUpload(c, a) {
		return
	}
	cfg := a.Cfg.Get()
	var req sendTextReq
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "缺少内容")
		return
	}
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

	// 群号优先取 URL 参数，其次 body（兼容）
	code := normalizeCode(c.Param("code"))
	if code == "" {
		code = normalizeCode(req.Code)
	}
	// 令牌：body 优先，header 兜底（与轮询端点一致）
	token := strings.TrimSpace(req.Token)
	if token == "" {
		token = strings.TrimSpace(c.GetHeader("X-Room-Token"))
	}
	var room *models.Room
	if code != "" {
		var okR bool
		room, okR = a.loadRoom(c, code)
		if !okR {
			return
		}
	}

	room, member, msg, status, err := a.appendMessage(c.Request.Context(), room, expireFields{}, token,
		func() *models.Message {
			return &models.Message{Type: models.TypeText, Text: text, Size: int64(len(text))}
		})
	if err != nil {
		fail(c, status, err.Error())
		return
	}
	ok(c, gin.H{"room": roomView(room), "member": memberView(member), "message": messageView(msg)})
}

type pendingFile struct {
	path, name string
	size       int64
	hash       string
}

// RoomSendFile: 文件直传（multipart；code+token 追加，否则建群成为群主）。
func (a *App) RoomSendFile(c *gin.Context) {
	if !requireOpenUpload(c, a) {
		return
	}
	cfg := a.Cfg.Get()
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
		code    string
		token   string
		pending []pendingFile
		cleanup []string
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
		case "code":
			b, _ := io.ReadAll(io.LimitReader(part, 32))
			code = normalizeCode(strings.TrimSpace(string(b)))
		case "token":
			b, _ := io.ReadAll(io.LimitReader(part, 128))
			token = strings.TrimSpace(string(b))
		case "expire_value":
			b, _ := io.ReadAll(io.LimitReader(part, 64))
			ef.ExpireValue = parseInt64(strings.TrimSpace(string(b)))
		case "expire_style":
			b, _ := io.ReadAll(io.LimitReader(part, 64))
			ef.ExpireStyle = strings.TrimSpace(string(b))
		case "file":
			name := storage.SanitizeFilename(part.FileName())
			if name == "" || !storage.ExtAllowed(name, cfg.AllowedTypes) {
				_, _ = io.Copy(io.Discard, part)
				fail(c, http.StatusBadRequest, "文件类型不被允许")
				return
			}
			relPath := storage.NewRelPath(name)
			size, hash, err := a.Storage.SaveStream(io.LimitReader(part, cfg.MaxUploadSize+1), relPath)
			if err != nil {
				fail(c, http.StatusInternalServerError, "文件保存失败: "+err.Error())
				return
			}
			if size > cfg.MaxUploadSize {
				_ = a.Storage.Delete(relPath)
				fail(c, http.StatusRequestEntityTooLarge,
					fmt.Sprintf("文件超过大小限制（最大 %s）", humanBytes(cfg.MaxUploadSize)))
				return
			}
			cleanup = append(cleanup, relPath)
			pending = append(pending, pendingFile{path: relPath, name: name, size: size, hash: hash})
		default:
			_, _ = io.Copy(io.Discard, part)
		}
	}
	if len(pending) == 0 {
		fail(c, http.StatusBadRequest, "缺少文件字段 file")
		return
	}

	// 已有群：先做一次权限校验（避免多文件重复报错路径不一致）
	var room *models.Room
	if code != "" {
		var okR bool
		room, okR = a.loadRoom(c, code)
		if !okR {
			return
		}
		if _, status, err := a.checkReplyPermission(c.Request.Context(), room, token); err != nil {
			fail(c, status, err.Error())
			return
		}
	}

	var member *models.Member
	var first *models.Message
	for i, it := range pending {
		var (
			msg    *models.Message
			status int
			err    error
		)
		if room == nil || member == nil {
			room, member, msg, status, err = a.appendMessage(c.Request.Context(), room, ef, token,
				func() *models.Message {
					return &models.Message{
						Type: models.TypeFile, StoragePath: it.path,
						Filename: it.name, Size: it.size, FileHash: it.hash,
					}
				})
			if err != nil {
				fail(c, status, err.Error())
				return
			}
		} else {
			// 同一请求的后续文件：成员已认证，直接落库
			msg, status, err = a.insertRoomMessage(c.Request.Context(), room, member,
				func() *models.Message {
					return &models.Message{
						Type: models.TypeFile, StoragePath: it.path,
						Filename: it.name, Size: it.size, FileHash: it.hash,
					}
				})
			if err != nil {
				fail(c, status, err.Error())
				return
			}
		}
		if i == 0 {
			first = msg
		}
		cleanup = cleanup[1:]
	}
	ok(c, gin.H{
		"room":    roomView(room),
		"token":   member.Token,
		"member":  memberView(member),
		"message": messageView(first),
		"added":   len(pending),
	})
}

// RoomMessageFile: 群内消息文件的下载/内联。
func (a *App) RoomMessageFile(c *gin.Context) {
	code := normalizeCode(c.Param("code"))
	room, okR := a.loadRoom(c, code)
	if !okR {
		return
	}
	if a.authMember(c, room) == nil {
		fail(c, http.StatusForbidden, "请先加入群聊")
		return
	}
	var msgID int64
	if _, err := fmt.Sscanf(c.Param("msg"), "%d", &msgID); err != nil || msgID < 1 {
		fail(c, http.StatusBadRequest, "消息编号无效")
		return
	}
	msg, err := a.Store.GetMessage(c.Request.Context(), code, msgID)
	if errors.Is(err, store.ErrNotFound) || msg == nil {
		fail(c, http.StatusNotFound, "消息不存在")
		return
	}
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	if msg.Type != models.TypeFile || msg.StoragePath == "" {
		fail(c, http.StatusBadRequest, "该消息不是文件")
		return
	}
	f, _, err := a.Storage.Open(msg.StoragePath)
	if errors.Is(err, storage.ErrNotFound) {
		_ = a.Store.DeleteMessage(c.Request.Context(), code, msg.ID)
		fail(c, http.StatusGone, "文件已失效")
		return
	}
	if err != nil {
		fail(c, http.StatusInternalServerError, "文件读取失败: "+err.Error())
		return
	}
	defer f.Close()

	modTime := time.Unix(msg.CreatedAt, 0)
	if mime := imageMime(msg.Filename); mime != "" && c.Query("inline") == "1" {
		c.Header("Content-Type", mime)
		c.Header("Content-Disposition", "inline")
		c.Header("X-Content-Type-Options", "nosniff")
	} else {
		c.Header("Content-Type", "application/octet-stream")
		setAttachment(c, msg.Filename)
	}
	http.ServeContent(c.Writer, c.Request, msg.Filename, modTime, f)
}

// ---------------------------------------------------------------------------
// 群主设置：访客回消息开关、群过期时间

func (a *App) RoomSettings(c *gin.Context) {
	code := normalizeCode(c.Param("code"))
	room, okR := a.loadRoom(c, code)
	if !okR {
		return
	}
	member := a.authMember(c, room)
	if member == nil || member.Role != models.RoleOwner {
		fail(c, http.StatusForbidden, "仅群主可修改设置")
		return
	}
	if c.Request.Method == http.MethodGet {
		ok(c, roomView(room))
		return
	}

	var req struct {
		AllowReply  *bool  `json:"allow_reply"`
		ExpireValue int64  `json:"expire_value"`
		ExpireStyle string `json:"expire_style"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "参数错误")
		return
	}
	if req.AllowReply != nil {
		if err := a.Store.SetRoomReply(c.Request.Context(), code, *req.AllowReply); err != nil {
			fail(c, http.StatusInternalServerError, err.Error())
			return
		}
	}
	if req.ExpireStyle != "" {
		style := normalizeStyle(req.ExpireStyle)
		if !expireStyles[style] {
			fail(c, http.StatusBadRequest, "不支持的过期类型")
			return
		}
		var expireAt int64
		if style == "forever" {
			expireAt = 0
		} else {
			now := time.Now()
			at, err := computeExpire(style, req.ExpireValue, a.Cfg.Get().MaxSaveSeconds, now)
			if err != nil {
				fail(c, http.StatusBadRequest, err.Error())
				return
			}
			expireAt = at
		}
		if err := a.Store.SetRoomExpire(c.Request.Context(), code, expireAt); err != nil {
			fail(c, http.StatusInternalServerError, err.Error())
			return
		}
	}
	updated, err := a.Store.GetRoom(c.Request.Context(), code)
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	ok(c, roomView(updated))
}

// removeRoom deletes the room, members, messages and all file payloads.
func (a *App) removeRoom(ctx context.Context, room *models.Room) {
	msgs, err := a.Store.ListMessages(ctx, room.Code, 0, models.MaxMessagesPerRoom+1)
	if err == nil {
		for _, m := range msgs {
			if m.Type == models.TypeFile && m.StoragePath != "" {
				_ = a.Storage.Delete(m.StoragePath)
			}
		}
	}
	_ = a.Store.DeleteRoomCascade(ctx, room.Code)
}
