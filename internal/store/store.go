package store

import (
	"context"
	crand "crypto/rand"
	"database/sql"
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
// share codes

func (s *Store) InsertCode(ctx context.Context, c *models.FileCode) error {
	res, err := s.gdb.ExecContext(ctx,
		`INSERT INTO file_codes
			(code, type, text, storage_path, filename, size, file_hash,
			 expire_at, expire_count, used_count, created_at)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		c.Code, c.Type, c.Text, c.StoragePath, c.Filename, c.Size, c.FileHash,
		c.ExpireAt, c.ExpireCount, 0, c.CreatedAt,
	)
	if err != nil {
		return err
	}
	c.ID, _ = res.LastInsertId()
	return nil
}

func (s *Store) GetByCode(ctx context.Context, code string) (*models.FileCode, error) {
	row := s.gdb.QueryRowContext(ctx, `SELECT `+codeCols+` FROM file_codes WHERE code = ?`, code)
	return scanCode(row.Scan)
}

func (s *Store) GetByID(ctx context.Context, id int64) (*models.FileCode, error) {
	row := s.gdb.QueryRowContext(ctx, `SELECT `+codeCols+` FROM file_codes WHERE id = ?`, id)
	return scanCode(row.Scan)
}

// ConsumeByCode atomically consumes one use: it only succeeds while the share
// is neither time-expired nor count-exhausted, bumping used_count and
// decrementing expire_count in the same statement (race-free under SQLite's
// single-writer model).
func (s *Store) ConsumeByCode(ctx context.Context, code string, now int64) (*models.FileCode, error) {
	row := s.gdb.QueryRowContext(ctx, `
		UPDATE file_codes SET
			used_count   = used_count + 1,
			expire_count = CASE WHEN expire_count > 0 THEN expire_count - 1 ELSE expire_count END
		WHERE code = ?
		  AND (expire_count < 0 OR expire_count > 0)
		  AND (expire_at = 0 OR expire_at > ?)
		RETURNING `+codeCols, code, now)
	return scanCode(row.Scan)
}

// DeleteExpired returns every share that has expired and removes the rows.
func (s *Store) DeleteExpired(ctx context.Context, now int64) ([]*models.FileCode, error) {
	rows, err := s.gdb.QueryContext(ctx, `SELECT `+codeCols+` FROM file_codes
		WHERE (expire_at > 0 AND expire_at <= ?) OR expire_count = 0`, now)
	if err != nil {
		return nil, err
	}
	var out []*models.FileCode
	for rows.Next() {
		c, err := scanCode(rows.Scan)
		if err != nil {
			rows.Close()
			return out, err
		}
		out = append(out, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	if len(out) > 0 {
		if _, err := s.gdb.ExecContext(ctx,
			`DELETE FROM file_codes WHERE (expire_at > 0 AND expire_at <= ?) OR expire_count = 0`, now); err != nil {
			return out, err
		}
	}
	return out, nil
}

func (s *Store) ListCodes(ctx context.Context, offset, limit int) ([]*models.FileCode, int, error) {
	var total int
	if err := s.gdb.QueryRowContext(ctx, `SELECT COUNT(*) FROM file_codes`).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.gdb.QueryContext(ctx, `SELECT `+codeCols+` FROM file_codes
		ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []*models.FileCode
	for rows.Next() {
		c, err := scanCode(rows.Scan)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, c)
	}
	return out, total, rows.Err()
}

func (s *Store) DeleteByCode(ctx context.Context, code string) (*models.FileCode, error) {
	c, err := s.GetByCode(ctx, code)
	if err != nil {
		return nil, err
	}
	_, err = s.gdb.ExecContext(ctx, `DELETE FROM file_codes WHERE code = ?`, code)
	return c, err
}

const codeCols = `id, code, type, text, storage_path, filename, size, file_hash,
	expire_at, expire_count, used_count, created_at`

func scanCode(scan func(dest ...any) error) (*models.FileCode, error) {
	var c models.FileCode
	err := scan(&c.ID, &c.Code, &c.Type, &c.Text, &c.StoragePath, &c.Filename,
		&c.Size, &c.FileHash, &c.ExpireAt, &c.ExpireCount, &c.UsedCount, &c.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
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
// code generation

const (
	secretAlphabet  = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no 0/O/1/I: avoids pickup confusion
	CodeGenAttempts = 64
)

// RandomCode returns a candidate code: 5-digit number, or 5 chars of an
// unambiguous A-Z/2-9 alphabet ("secret" style, like the original).
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
		return "", fmt.Errorf("未知取件码类型: %s", codeType)
	}
}
