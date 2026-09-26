package config

import (
	"database/sql"
	"encoding/json"
	"errors"
	"sync"
	"time"
)

const settingsKey = "settings"

// Config holds every runtime-editable setting. It is persisted as one JSON
// blob in the settings table (same approach as the original FileCodeBox) so
// the admin panel can change values without restarting.
type Config struct {
	Name        string `json:"name"`
	Description string `json:"description"`

	OpenUpload    bool  `json:"open_upload"`     // anonymous send allowed
	MaxUploadSize int64 `json:"max_upload_size"` // bytes per file
	MaxTextSize   int64 `json:"max_text_size"`   // bytes per text share
	ChunkSize     int64 `json:"chunk_size"`      // bytes per chunk

	CodeType       string   `json:"code_type"`        // "number" | "secret"
	AllowedTypes   []string `json:"allowed_types"`    // lowercase ext w/o dot; ["*"] = all
	MaxSaveSeconds int64    `json:"max_save_seconds"` // cap for time-based expiry; 0 = no cap

	RateLimitCount   int `json:"rate_limit_count"`   // uploads per window per IP
	RateLimitWindow  int `json:"rate_limit_window"`  // seconds
	ChunkExpireHours int `json:"chunk_expire_hours"` // unfinished chunk session TTL

	// Internal secrets: never returned by the public/admin config API.
	AdminPasswordHash string `json:"admin_password_hash,omitempty"`
	AdminSecret       string `json:"admin_secret,omitempty"`
}

func Defaults() *Config {
	return &Config{
		Name:             "快闪群传",
		Description:      "局域网 · 临时群 · 到期自动解散",
		OpenUpload:       true,
		MaxUploadSize:    1 << 30, // 1 GiB
		MaxTextSize:      1 << 20, // 1 MiB
		ChunkSize:        5 << 20, // 5 MiB
		CodeType:         "number",
		AllowedTypes:     []string{"*"},
		MaxSaveSeconds:   7 * 86400,
		RateLimitCount:   30,
		RateLimitWindow:  60,
		ChunkExpireHours: 24,
	}
}

type Manager struct {
	mu      sync.RWMutex
	cfg     *Config
	gdb     *sql.DB
	nowFunc func() time.Time
}

func NewManager(gdb *sql.DB) *Manager {
	return &Manager{cfg: Defaults(), gdb: gdb, nowFunc: time.Now}
}

// Load reads the persisted blob and merges it over the defaults so new keys
// added by upgrades keep sane values.
func (m *Manager) Load() error {
	var raw string
	err := m.gdb.QueryRow(`SELECT value FROM settings WHERE key = ?`, settingsKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return m.persistLocked(Defaults())
	}
	if err != nil {
		return err
	}
	cfg := Defaults()
	if err := json.Unmarshal([]byte(raw), cfg); err != nil {
		return err
	}
	m.mu.Lock()
	m.cfg = cfg
	m.mu.Unlock()
	return nil
}

func (m *Manager) Get() Config {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.snapshotLocked()
}

// Update mutates the config under lock and persists it atomically.
func (m *Manager) Update(fn func(*Config)) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	fn(m.cfg)
	return m.persistLocked(m.cfg)
}

// Initialized reports whether the admin password has been set up.
func (m *Manager) Initialized() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.cfg.AdminPasswordHash != ""
}

func (m *Manager) persistLocked(cfg *Config) error {
	raw, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	_, err = m.gdb.Exec(
		`INSERT INTO settings (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		settingsKey, string(raw),
	)
	return err
}

func (m *Manager) snapshotLocked() Config {
	c := *m.cfg
	c.AllowedTypes = append([]string(nil), m.cfg.AllowedTypes...)
	return c
}
