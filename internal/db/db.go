package db

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	"flashcodebox/internal/models"

	_ "modernc.org/sqlite"
)

const schema = `
-- 群（群号即原取件码）
CREATE TABLE IF NOT EXISTS rooms (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	code        TEXT    NOT NULL UNIQUE,
	expire_at   INTEGER NOT NULL DEFAULT 0,   -- unix 秒；0 = 永久
	allow_reply INTEGER NOT NULL DEFAULT 1,   -- 访客可否回消息
	created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rooms_expire_at ON rooms(expire_at);

-- 成员：群主与访客各持随机令牌
CREATE TABLE IF NOT EXISTS members (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	room_code  TEXT    NOT NULL,
	role       TEXT    NOT NULL,               -- 'owner' | 'guest'
	guest_no   INTEGER NOT NULL DEFAULT 0,     -- 访客编号（群主为 0）
	token      TEXT    NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_members_room ON members(room_code);
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_token ON members(token);

-- 消息（文字 / 文件）
CREATE TABLE IF NOT EXISTS messages (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	room_code   TEXT    NOT NULL,
	member_id   INTEGER NOT NULL,
	role        TEXT    NOT NULL,               -- 'owner' | 'guest'
	sender      TEXT    NOT NULL,               -- '群主' | '访客N'
	type        TEXT    NOT NULL,               -- 'text' | 'file'
	text        TEXT    NOT NULL DEFAULT '',
	storage_path TEXT   NOT NULL DEFAULT '',
	filename    TEXT    NOT NULL DEFAULT '',
	size        INTEGER NOT NULL DEFAULT 0,
	file_hash   TEXT    NOT NULL DEFAULT '',
	created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_code, id);

CREATE TABLE IF NOT EXISTS chunk_sessions (
	upload_id    TEXT PRIMARY KEY,
	file_name    TEXT    NOT NULL,
	file_size    INTEGER NOT NULL,
	chunk_size   INTEGER NOT NULL,
	total_chunks INTEGER NOT NULL,
	file_hash    TEXT    NOT NULL DEFAULT '',
	created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunk_sessions_created_at ON chunk_sessions(created_at);

CREATE TABLE IF NOT EXISTS chunk_parts (
	upload_id  TEXT    NOT NULL,
	part_index INTEGER NOT NULL,
	part_hash  TEXT    NOT NULL DEFAULT '',
	PRIMARY KEY (upload_id, part_index)
);

CREATE TABLE IF NOT EXISTS settings (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
`

// Open opens (and creates if needed) the SQLite database inside dataDir.
// WAL mode + busy_timeout. A small pool lets the read-heavy poll path (and
// SSE snapshots) run concurrently — WAL readers never block the writer —
// while writers still serialize behind busy_timeout instead of failing.
func Open(dataDir string) (*sql.DB, error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, fmt.Errorf("创建数据目录失败: %w", err)
	}
	dsn := filepath.Join(dataDir, "flashcodebox.db") +
		"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(10000)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(ON)"

	gdb, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("打开数据库失败: %w", err)
	}
	gdb.SetMaxOpenConns(8)
	gdb.SetMaxIdleConns(8)
	gdb.SetConnMaxLifetime(0)

	if err := gdb.Ping(); err != nil {
		gdb.Close()
		return nil, fmt.Errorf("连接数据库失败: %w", err)
	}
	if _, err := gdb.Exec(schema); err != nil {
		gdb.Close()
		return nil, fmt.Errorf("初始化表结构失败: %w", err)
	}
	if err := migrateLegacy(gdb); err != nil {
		gdb.Close()
		return nil, fmt.Errorf("迁移旧数据失败: %w", err)
	}
	if err := migrateOwnerName(gdb); err != nil {
		gdb.Close()
		return nil, fmt.Errorf("迁移旧数据失败: %w", err)
	}
	return gdb, nil
}

// migrateOwnerName renames the historic owner display name (楼主 → 群主) in
// existing messages. Idempotent: a no-op once no old rows remain.
func migrateOwnerName(gdb *sql.DB) error {
	res, err := gdb.Exec(`UPDATE messages SET sender = ? WHERE sender = ?`, models.SenderNameOwner, "楼主")
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n > 0 {
		fmt.Printf("已将 %d 条旧消息的发送者显示名更新为「%s」\n", n, models.SenderNameOwner)
	}
	return nil
}

// migrateLegacy upgrades pre-0.2 databases:
//   - v0.1 "share_items" model (file_codes + share_items)
//   - v0.0 single-item model (file_codes with type/text columns)
//
// Everything becomes a room with one owner member whose token is lost
// (historic shares are read-only: guests can join and view/download).
func migrateLegacy(gdb *sql.DB) error {
	hasRooms, err := hasTable(gdb, "rooms")
	if err != nil {
		return err
	}
	hasFC, err := hasTable(gdb, "file_codes")
	if err != nil {
		return err
	}
	if !hasFC {
		return nil // fresh database
	}
	if hasRooms {
		// Already migrated (rooms exist but file_codes left behind) → drop legacy.
		if _, err := gdb.Exec(`DROP TABLE IF EXISTS file_codes`); err != nil {
			return err
		}
		return nil
	}

	legacySingle, _ := hasColumn(gdb, "file_codes", "type")
	tx, err := gdb.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if legacySingle {
		// v0.0：payload 直接在 file_codes 上
		if _, err := tx.Exec(`INSERT INTO messages
			(room_code, member_id, role, sender, type, text, storage_path, filename, size, file_hash, created_at)
			SELECT code, 0, 'owner', '群主', type, text, storage_path, filename, size, file_hash, created_at
			  FROM file_codes WHERE type IN ('text','file')`); err != nil {
			return err
		}
	} else {
		// v0.1：file_codes + share_items
		if _, err := tx.Exec(`INSERT INTO messages
			(room_code, member_id, role, sender, type, text, storage_path, filename, size, file_hash, created_at)
			SELECT share_code, 0, 'owner', '群主', type, text, storage_path, filename, size, file_hash, created_at
			  FROM share_items`); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`INSERT INTO rooms (code, expire_at, allow_reply, created_at)
		SELECT code, expire_at, 1, created_at FROM file_codes
		 WHERE EXISTS (SELECT 1 FROM messages WHERE messages.room_code = file_codes.code)`); err != nil {
		return err
	}
	if _, err := tx.Exec(`DROP TABLE file_codes`); err != nil {
		return err
	}
	if _, err := tx.Exec(`DROP TABLE IF EXISTS share_items`); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	fmt.Println("已将旧版分享数据迁移为群结构（历史分享为只读，无群主令牌）")
	return nil
}

func hasTable(gdb *sql.DB, name string) (bool, error) {
	var n int
	err := gdb.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`, name).Scan(&n)
	return n > 0, err
}

func hasColumn(gdb *sql.DB, table, column string) (bool, error) {
	rows, err := gdb.Query(fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, ctype string
		var notNull, pk int
		var dflt any
		if err := rows.Scan(&cid, &name, &ctype, &notNull, &dflt, &pk); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}
