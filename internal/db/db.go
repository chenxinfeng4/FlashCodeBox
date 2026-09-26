package db

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS file_codes (
	id           INTEGER PRIMARY KEY AUTOINCREMENT,
	code         TEXT    NOT NULL UNIQUE,
	type         TEXT    NOT NULL,
	text         TEXT    NOT NULL DEFAULT '',
	storage_path TEXT    NOT NULL DEFAULT '',
	filename     TEXT    NOT NULL DEFAULT '',
	size         INTEGER NOT NULL DEFAULT 0,
	file_hash    TEXT    NOT NULL DEFAULT '',
	expire_at    INTEGER NOT NULL DEFAULT 0,
	expire_count INTEGER NOT NULL DEFAULT -1,
	used_count   INTEGER NOT NULL DEFAULT 0,
	created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_codes_expire_at ON file_codes(expire_at);
CREATE INDEX IF NOT EXISTS idx_file_codes_created_at ON file_codes(created_at);

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
// WAL mode + busy_timeout; a single connection keeps writers serialized and
// avoids SQLITE_BUSY entirely, which is plenty for this workload.
func Open(dataDir string) (*sql.DB, error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, fmt.Errorf("创建数据目录失败: %w", err)
	}
	dsn := filepath.Join(dataDir, "filesender.db") +
		"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(10000)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(ON)"

	gdb, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("打开数据库失败: %w", err)
	}
	gdb.SetMaxOpenConns(1)
	gdb.SetMaxIdleConns(1)
	gdb.SetConnMaxLifetime(0)

	if err := gdb.Ping(); err != nil {
		gdb.Close()
		return nil, fmt.Errorf("连接数据库失败: %w", err)
	}
	if _, err := gdb.Exec(schema); err != nil {
		gdb.Close()
		return nil, fmt.Errorf("初始化表结构失败: %w", err)
	}
	return gdb, nil
}
