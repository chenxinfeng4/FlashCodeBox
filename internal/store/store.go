package store

import (
	"context"
	crand "crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strings"

	"filesender/internal/models"
)

var ErrNotFound = errors.New("记录不存在")

type Store struct {
	gdb *sql.DB
}

func New(gdb *sql.DB) *Store { return &Store{gdb: gdb} }

// ---------------------------------------------------------------------------
// rooms

func (s *Store) InsertRoom(ctx context.Context, r *models.Room) error {
	res, err := s.gdb.ExecContext(ctx,
		`INSERT INTO rooms (code, expire_at, allow_reply, created_at) VALUES (?,?,?,?)`,
		r.Code, r.ExpireAt, boolInt(r.AllowReply), r.CreatedAt,
	)
	if err != nil {
		return err
	}
	r.ID, _ = res.LastInsertId()
	return nil
}

const roomCols = `id, code, expire_at, allow_reply, created_at`

func scanRoom(scan func(dest ...any) error) (*models.Room, error) {
	var r models.Room
	var allow int64
	err := scan(&r.ID, &r.Code, &r.ExpireAt, &allow, &r.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	r.AllowReply = allow != 0
	return &r, nil
}

func (s *Store) GetRoom(ctx context.Context, code string) (*models.Room, error) {
	row := s.gdb.QueryRowContext(ctx, `SELECT `+roomCols+` FROM rooms WHERE code = ?`, code)
	return scanRoom(row.Scan)
}

func (s *Store) SetRoomReply(ctx context.Context, code string, allow bool) error {
	_, err := s.gdb.ExecContext(ctx, `UPDATE rooms SET allow_reply = ? WHERE code = ?`, boolInt(allow), code)
	return err
}

func (s *Store) SetRoomExpire(ctx context.Context, code string, expireAt int64) error {
	_, err := s.gdb.ExecContext(ctx, `UPDATE rooms SET expire_at = ? WHERE code = ?`, expireAt, code)
	return err
}

// ExpiredRooms returns every expired room header (caller cascades deletion).
func (s *Store) ExpiredRooms(ctx context.Context, now int64) ([]*models.Room, error) {
	rows, err := s.gdb.QueryContext(ctx, `SELECT `+roomCols+` FROM rooms WHERE expire_at > 0 AND expire_at <= ?`, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.Room
	for rows.Next() {
		r, err := scanRoom(rows.Scan)
		if err != nil {
			return out, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// DeleteRoomCascade removes a room, its members and messages.
// Payload files must be deleted by the caller (it needs the paths first).
func (s *Store) DeleteRoomCascade(ctx context.Context, code string) error {
	for _, q := range []string{
		`DELETE FROM messages WHERE room_code = ?`,
		`DELETE FROM members WHERE room_code = ?`,
		`DELETE FROM rooms WHERE code = ?`,
	} {
		if _, err := s.gdb.ExecContext(ctx, q, code); err != nil {
			return err
		}
	}
	return nil
}

// EmptyRooms returns room codes created before `before` without any message
// (process died between room insert and first message insert).
func (s *Store) EmptyRooms(ctx context.Context, before int64) ([]string, error) {
	rows, err := s.gdb.QueryContext(ctx, `SELECT code FROM rooms
		WHERE created_at < ?
		  AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.room_code = rooms.code)`, before)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			return out, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) ListRooms(ctx context.Context, offset, limit int) ([]*models.Room, int, error) {
	var total int
	if err := s.gdb.QueryRowContext(ctx, `SELECT COUNT(*) FROM rooms`).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.gdb.QueryContext(ctx, `SELECT `+roomCols+` FROM rooms
		ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []*models.Room
	for rows.Next() {
		r, err := scanRoom(rows.Scan)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, r)
	}
	return out, total, rows.Err()
}

// ---------------------------------------------------------------------------
// members

func (s *Store) InsertMember(ctx context.Context, m *models.Member) error {
	res, err := s.gdb.ExecContext(ctx,
		`INSERT INTO members (room_code, role, guest_no, token, created_at) VALUES (?,?,?,?,?)`,
		m.RoomCode, m.Role, m.GuestNo, m.Token, m.CreatedAt,
	)
	if err != nil {
		return err
	}
	m.ID, _ = res.LastInsertId()
	return nil
}

const memberCols = `id, room_code, role, guest_no, token, created_at`

func scanMember(scan func(dest ...any) error) (*models.Member, error) {
	var m models.Member
	err := scan(&m.ID, &m.RoomCode, &m.Role, &m.GuestNo, &m.Token, &m.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if m.Role == models.RoleGuest {
		m.Sender = fmt.Sprintf("访客%d", m.GuestNo)
	} else {
		m.Sender = models.SenderNameOwner
	}
	return &m, nil
}

// GetMemberByToken resolves a member by room code + token.
func (s *Store) GetMemberByToken(ctx context.Context, code, token string) (*models.Member, error) {
	row := s.gdb.QueryRowContext(ctx, `SELECT `+memberCols+` FROM members
		WHERE room_code = ? AND token = ?`, code, token)
	return scanMember(row.Scan)
}

// NextGuestNo allocates the next guest number for a room (atomic enough:
// SQLite serializes writers, and the single connection removes races).
func (s *Store) NextGuestNo(ctx context.Context, code string) (int64, error) {
	var n sql.NullInt64
	err := s.gdb.QueryRowContext(ctx,
		`SELECT MAX(guest_no) FROM members WHERE room_code = ? AND role = ?`, code, models.RoleGuest).Scan(&n)
	if err != nil {
		return 0, err
	}
	return n.Int64 + 1, nil
}

func (s *Store) CountMembers(ctx context.Context, code string) (int, error) {
	var n int
	err := s.gdb.QueryRowContext(ctx, `SELECT COUNT(*) FROM members WHERE room_code = ?`, code).Scan(&n)
	return n, err
}

// ---------------------------------------------------------------------------
// messages

func (s *Store) InsertMessage(ctx context.Context, msg *models.Message) error {
	res, err := s.gdb.ExecContext(ctx, `INSERT INTO messages
		(room_code, member_id, role, sender, type, text, storage_path, filename, size, file_hash, created_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		msg.RoomCode, msg.MemberID, msg.Role, msg.Sender, msg.Type,
		msg.Text, msg.StoragePath, msg.Filename, msg.Size, msg.FileHash, msg.CreatedAt,
	)
	if err != nil {
		return err
	}
	msg.ID, _ = res.LastInsertId()
	return nil
}

const msgCols = `id, room_code, member_id, role, sender, type, text, storage_path, filename, size, file_hash, created_at`

func scanMessage(scan func(dest ...any) error) (*models.Message, error) {
	var m models.Message
	err := scan(&m.ID, &m.RoomCode, &m.MemberID, &m.Role, &m.Sender, &m.Type,
		&m.Text, &m.StoragePath, &m.Filename, &m.Size, &m.FileHash, &m.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &m, nil
}

func (s *Store) CountMessages(ctx context.Context, code string) (int, error) {
	var n int
	err := s.gdb.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages WHERE room_code = ?`, code).Scan(&n)
	return n, err
}

// ListMessages returns room messages with id > after ordered ascending.
func (s *Store) ListMessages(ctx context.Context, code string, after int64, limit int) ([]*models.Message, error) {
	rows, err := s.gdb.QueryContext(ctx, `SELECT `+msgCols+` FROM messages
		WHERE room_code = ? AND id > ? ORDER BY id LIMIT ?`, code, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.Message
	for rows.Next() {
		m, err := scanMessage(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Store) GetMessage(ctx context.Context, code string, msgID int64) (*models.Message, error) {
	row := s.gdb.QueryRowContext(ctx, `SELECT `+msgCols+` FROM messages
		WHERE room_code = ? AND id = ?`, code, msgID)
	return scanMessage(row.Scan)
}

func (s *Store) DeleteMessage(ctx context.Context, code string, msgID int64) error {
	_, err := s.gdb.ExecContext(ctx, `DELETE FROM messages WHERE room_code = ? AND id = ?`, code, msgID)
	return err
}

// MessagesForRooms loads messages for a batch of rooms (admin list page).
func (s *Store) MessagesForRooms(ctx context.Context, codes []string) (map[string][]*models.Message, error) {
	out := make(map[string][]*models.Message, len(codes))
	if len(codes) == 0 {
		return out, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(codes)), ",")
	args := make([]any, len(codes))
	for i, c := range codes {
		args[i] = c
	}
	rows, err := s.gdb.QueryContext(ctx, `SELECT `+msgCols+` FROM messages
		WHERE room_code IN (`+placeholders+`) ORDER BY room_code, id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		m, err := scanMessage(rows.Scan)
		if err != nil {
			return nil, err
		}
		out[m.RoomCode] = append(out[m.RoomCode], m)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------------------
// chunk uploads

func (s *Store) CreateChunkSession(ctx context.Context, cs *models.ChunkSession) error {
	_, err := s.gdb.ExecContext(ctx, `INSERT INTO chunk_sessions
		(upload_id, file_name, file_size, chunk_size, total_chunks, file_hash, created_at)
		VALUES (?,?,?,?,?,?,?)`,
		cs.UploadID, cs.FileName, cs.FileSize, cs.ChunkSize, cs.TotalChunks, cs.FileHash, cs.CreatedAt)
	return err
}

func (s *Store) GetChunkSession(ctx context.Context, uploadID string) (*models.ChunkSession, error) {
	row := s.gdb.QueryRowContext(ctx, `SELECT upload_id, file_name, file_size, chunk_size,
		total_chunks, file_hash, created_at FROM chunk_sessions WHERE upload_id = ?`, uploadID)
	var cs models.ChunkSession
	err := row.Scan(&cs.UploadID, &cs.FileName, &cs.FileSize, &cs.ChunkSize,
		&cs.TotalChunks, &cs.FileHash, &cs.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &cs, nil
}

// FindResumableSession returns an unfinished session matching a client-side
// file fingerprint, so a refresh/retry can continue the same upload.
func (s *Store) FindResumableSession(ctx context.Context, fileHash string, fileSize int64) (*models.ChunkSession, error) {
	if fileHash == "" {
		return nil, ErrNotFound
	}
	row := s.gdb.QueryRowContext(ctx, `SELECT upload_id, file_name, file_size, chunk_size,
		total_chunks, file_hash, created_at FROM chunk_sessions
		WHERE file_hash = ? AND file_size = ? ORDER BY created_at DESC LIMIT 1`, fileHash, fileSize)
	var cs models.ChunkSession
	err := row.Scan(&cs.UploadID, &cs.FileName, &cs.FileSize, &cs.ChunkSize,
		&cs.TotalChunks, &cs.FileHash, &cs.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &cs, nil
}

func (s *Store) ListChunkParts(ctx context.Context, uploadID string) ([]int64, error) {
	rows, err := s.gdb.QueryContext(ctx,
		`SELECT part_index FROM chunk_parts WHERE upload_id = ? ORDER BY part_index`, uploadID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var i int64
		if err := rows.Scan(&i); err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	return out, rows.Err()
}

func (s *Store) AddChunkPart(ctx context.Context, uploadID string, index int64, hash string) error {
	_, err := s.gdb.ExecContext(ctx, `INSERT OR REPLACE INTO chunk_parts
		(upload_id, part_index, part_hash) VALUES (?,?,?)`, uploadID, index, hash)
	return err
}

func (s *Store) DeleteChunkSession(ctx context.Context, uploadID string) error {
	if _, err := s.gdb.ExecContext(ctx, `DELETE FROM chunk_parts WHERE upload_id = ?`, uploadID); err != nil {
		return err
	}
	_, err := s.gdb.ExecContext(ctx, `DELETE FROM chunk_sessions WHERE upload_id = ?`, uploadID)
	return err
}

func (s *Store) DeleteExpiredChunkSessions(ctx context.Context, before int64) ([]string, error) {
	rows, err := s.gdb.QueryContext(ctx,
		`SELECT upload_id FROM chunk_sessions WHERE created_at < ?`, before)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return ids, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return ids, err
	}
	for _, id := range ids {
		if err := s.DeleteChunkSession(ctx, id); err != nil {
			return ids, err
		}
	}
	return ids, nil
}

func (s *Store) AllChunkUploadIDs(ctx context.Context) ([]string, error) {
	rows, err := s.gdb.QueryContext(ctx, `SELECT upload_id FROM chunk_sessions`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------------------
// code / token generation

const (
	secretAlphabet  = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no 0/O/1/I: avoids pickup confusion
	CodeGenAttempts = 64
)

// RandomCode returns a candidate room code: 5-digit number, or 5 chars of an
// unambiguous A-Z/2-9 alphabet ("secret" style).
func RandomCode(codeType string) (string, error) {
	switch codeType {
	case "secret":
		var sb strings.Builder
		for i := 0; i < 5; i++ {
			n, err := crand.Int(crand.Reader, big.NewInt(int64(len(secretAlphabet))))
			if err != nil {
				return "", err
			}
			sb.WriteByte(secretAlphabet[n.Int64()])
		}
		return sb.String(), nil
	case "number":
		n, err := crand.Int(crand.Reader, big.NewInt(90000))
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("%05d", n.Int64()+10000), nil
	default:
		return "", fmt.Errorf("未知群号类型: %s", codeType)
	}
}

// RandomToken returns a 32-byte hex token for member authentication.
func RandomToken() (string, error) {
	var b [32]byte
	if _, err := crand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func boolInt(b bool) int64 {
	if b {
		return 1
	}
	return 0
}
