package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"

	"filesender/internal/models"
	"filesender/internal/storage"
	"filesender/internal/store"
)

func newUploadID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}

func (a *App) chunkPath(uploadID string, index int64) string {
	return filepath.Join(a.ChunkDir, uploadID, fmt.Sprintf("%06d.part", index))
}

// saveChunk writes one chunk atomically (temp file + rename) and returns its
// size and sha256. Chunk files are managed directly by the api layer under
// ChunkDir — they are transient and never part of the share payload tree.
func (a *App) saveChunk(r io.Reader, uploadID string, index int64) (int64, string, error) {
	dir := filepath.Join(a.ChunkDir, uploadID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return 0, "", err
	}
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return 0, "", err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	hasher := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, hasher), r)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return 0, "", err
	}
	if err := os.Rename(tmpName, a.chunkPath(uploadID, index)); err != nil {
		return 0, "", err
	}
	return n, hex.EncodeToString(hasher.Sum(nil)), nil
}

func (a *App) removeChunkFile(uploadID string, index int64) {
	_ = os.Remove(a.chunkPath(uploadID, index))
}

type uploadInitReq struct {
	FileName string `json:"file_name" form:"file_name" binding:"required"`
	FileSize int64  `json:"file_size" form:"file_size" binding:"required,min=1"`
	FileHash string `json:"file_hash" form:"file_hash"`
}

// UploadInit creates (or resumes) a chunked upload session. Clients may send
// a whole-file sha256 as file_hash; sessions with the same fingerprint are
// reused so a failed upload can continue where it stopped.
func (a *App) UploadInit(c *gin.Context) {
	if !requireOpenUpload(c, a) {
		return
	}
	var req uploadInitReq
	if err := c.ShouldBind(&req); err != nil {
		fail(c, http.StatusBadRequest, "参数不完整（需要 file_name、file_size）")
		return
	}
	cfg := a.Cfg.Get()
	if req.FileSize > cfg.MaxUploadSize {
		fail(c, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("文件超过大小限制（最大 %s）", humanBytes(cfg.MaxUploadSize)))
		return
	}
	name := storage.SanitizeFilename(req.FileName)
	if name == "" || !storage.ExtAllowed(name, cfg.AllowedTypes) {
		fail(c, http.StatusBadRequest, "文件类型不被允许")
		return
	}
	req.FileHash = strings.ToLower(strings.TrimSpace(req.FileHash))

	if session, err := a.Store.FindResumableSession(c.Request.Context(), req.FileHash, req.FileSize); err == nil {
		uploaded, _ := a.Store.ListChunkParts(c.Request.Context(), session.UploadID)
		a.replySession(c, session, uploaded)
		return
	}

	chunkSize := cfg.ChunkSize
	if chunkSize < 64<<10 {
		chunkSize = 64 << 10
	}
	total := (req.FileSize + chunkSize - 1) / chunkSize

	session := &models.ChunkSession{
		UploadID:    newUploadID(),
		FileName:    name,
		FileSize:    req.FileSize,
		ChunkSize:   chunkSize,
		TotalChunks: total,
		FileHash:    req.FileHash,
		CreatedAt:   models.Now(),
	}
	if err := a.Store.CreateChunkSession(c.Request.Context(), session); err != nil {
		fail(c, http.StatusInternalServerError, "创建上传会话失败: "+err.Error())
		return
	}
	if err := os.MkdirAll(filepath.Join(a.ChunkDir, session.UploadID), 0o755); err != nil {
		_ = a.Store.DeleteChunkSession(c.Request.Context(), session.UploadID)
		fail(c, http.StatusInternalServerError, "创建分片目录失败: "+err.Error())
		return
	}
	a.replySession(c, session, nil)
}

func (a *App) replySession(c *gin.Context, session *models.ChunkSession, uploaded []int64) {
	if uploaded == nil {
		uploaded = []int64{}
	}
	ok(c, gin.H{
		"upload_id":    session.UploadID,
		"file_name":    session.FileName,
		"file_size":    session.FileSize,
		"chunk_size":   session.ChunkSize,
		"total_chunks": session.TotalChunks,
		"uploaded":     uploaded,
	})
}

// UploadChunk receives one chunk as a RAW request body (no multipart
// overhead). Optional X-Chunk-Hash carries the chunk sha256 for integrity.
func (a *App) UploadChunk(c *gin.Context) {
	session, okS := a.loadSession(c)
	if !okS {
		return
	}
	var index int64
	if _, err := fmt.Sscanf(c.Param("index"), "%d", &index); err != nil || index < 0 || index >= session.TotalChunks {
		fail(c, http.StatusBadRequest, "分片序号无效")
		return
	}

	limited := io.LimitReader(c.Request.Body, session.ChunkSize+1)
	size, hash, err := a.saveChunk(limited, session.UploadID, index)
	if err != nil {
		fail(c, http.StatusInternalServerError, "分片写入失败: "+err.Error())
		return
	}
	if size > session.ChunkSize {
		a.removeChunkFile(session.UploadID, index)
		fail(c, http.StatusBadRequest, fmt.Sprintf("分片超过大小限制（%d 字节）", session.ChunkSize))
		return
	}
	if want := strings.ToLower(strings.TrimSpace(c.GetHeader("X-Chunk-Hash"))); want != "" && want != hash {
		a.removeChunkFile(session.UploadID, index)
		fail(c, http.StatusBadRequest, "分片校验失败（sha256 不匹配）")
		return
	}
	if err := a.Store.AddChunkPart(c.Request.Context(), session.UploadID, index, hash); err != nil {
		fail(c, http.StatusInternalServerError, "分片登记失败: "+err.Error())
		return
	}
	ok(c, gin.H{"index": index, "size": size, "hash": hash})
}

// UploadComplete merges chunks in order into the final payload, verifies the
// whole-file size (and hash when provided), then posts it into a room —
// either an existing one (code+token) or a freshly created one (owner).
func (a *App) UploadComplete(c *gin.Context) {
	session, okS := a.loadSession(c)
	if !okS {
		return
	}
	var ef expireFields
	if err := c.ShouldBind(&ef); err != nil {
		fail(c, http.StatusBadRequest, "参数不完整")
		return
	}
	ctx := c.Request.Context()

	// 会议号/令牌：JSON body（ef）或 multipart 表单均可
	code := normalizeCode(c.PostForm("code"))
	if code == "" {
		code = normalizeCode(ef.Code)
	}
	token := strings.TrimSpace(c.PostForm("token"))
	if token == "" {
		token = strings.TrimSpace(ef.Token)
	}

	// 已有房间：先做权限校验
	var room *models.Room
	if code != "" {
		var okR bool
		room, okR = a.loadRoom(c, code)
		if !okR {
			return
		}
		if _, status, err := a.checkReplyPermission(ctx, room, token); err != nil {
			fail(c, status, err.Error())
			return
		}
	}

	parts, err := a.Store.ListChunkParts(ctx, session.UploadID)
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	have := make(map[int64]bool, len(parts))
	for _, p := range parts {
		have[p] = true
	}
	var missing []int64
	for i := int64(0); i < session.TotalChunks; i++ {
		if !have[i] {
			missing = append(missing, i)
		}
	}
	if len(missing) > 0 {
		fail(c, http.StatusBadRequest, fmt.Sprintf("还有 %d 个分片未上传（如 %d…）", len(missing), missing[0]))
		return
	}

	// Open every part, chain them, and stream into storage (computes sha256).
	files := make([]*os.File, 0, len(parts))
	readers := make([]io.Reader, 0, len(parts))
	for i := int64(0); i < session.TotalChunks; i++ {
		f, err := os.Open(a.chunkPath(session.UploadID, i))
		if err != nil {
			closeFiles(files)
			fail(c, http.StatusInternalServerError, "分片文件缺失: "+err.Error())
			return
		}
		files = append(files, f)
		readers = append(readers, f)
	}
	relPath := storage.NewRelPath(session.FileName)
	size, hash, err := a.Storage.SaveStream(io.MultiReader(readers...), relPath)
	closeFiles(files)
	if err != nil {
		fail(c, http.StatusInternalServerError, "文件合并失败: "+err.Error())
		return
	}
	if size != session.FileSize {
		_ = a.Storage.Delete(relPath)
		fail(c, http.StatusBadRequest,
			fmt.Sprintf("文件大小不符（期望 %d，实际 %d）", session.FileSize, size))
		return
	}
	if session.FileHash != "" && session.FileHash != hash {
		_ = a.Storage.Delete(relPath)
		fail(c, http.StatusBadRequest, "文件校验失败（sha256 不匹配）")
		return
	}

	var member *models.Member
	var msg *models.Message
	var status int
	if room == nil {
		room, member, msg, status, err = a.appendMessage(ctx, nil, ef, "",
			func() *models.Message {
				return &models.Message{
					Type: models.TypeFile, StoragePath: relPath,
					Filename: session.FileName, Size: size, FileHash: hash,
				}
			})
	} else {
		var member2 *models.Member
		member2, status, err = a.checkReplyPermission(ctx, room, token)
		if err != nil {
			_ = a.Storage.Delete(relPath)
			fail(c, status, err.Error())
			return
		}
		member = member2
		msg, status, err = a.insertRoomMessage(ctx, room, member,
			func() *models.Message {
				return &models.Message{
					Type: models.TypeFile, StoragePath: relPath,
					Filename: session.FileName, Size: size, FileHash: hash,
				}
			})
	}
	if err != nil {
		_ = a.Storage.Delete(relPath)
		fail(c, status, err.Error())
		return
	}
	_ = a.Store.DeleteChunkSession(ctx, session.UploadID)
	_ = os.RemoveAll(filepath.Join(a.ChunkDir, session.UploadID))
	ok(c, gin.H{
		"room":    roomView(room),
		"token":   member.Token,
		"member":  memberView(member),
		"message": messageView(msg),
	})
}

// UploadStatus lets clients inspect which parts already landed (resume).
func (a *App) UploadStatus(c *gin.Context) {
	session, okS := a.loadSession(c)
	if !okS {
		return
	}
	uploaded, err := a.Store.ListChunkParts(c.Request.Context(), session.UploadID)
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	a.replySession(c, session, uploaded)
}

func (a *App) loadSession(c *gin.Context) (*models.ChunkSession, bool) {
	session, err := a.Store.GetChunkSession(c.Request.Context(), c.Param("id"))
	if errors.Is(err, store.ErrNotFound) {
		fail(c, http.StatusNotFound, "上传会话不存在或已过期，请重新上传")
		return nil, false
	}
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return nil, false
	}
	return session, true
}

func closeFiles(files []*os.File) {
	for _, f := range files {
		_ = f.Close()
	}
}
