package storage

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path"
	"strings"
	"time"
	"unicode/utf8"
)

var ErrNotFound = errors.New("文件不存在")

// Storage abstracts where share payloads live. v1 ships a local-disk
// implementation; the interface leaves room for S3/WebDAV later.
type Storage interface {
	// SaveStream writes r to relPath, returns bytes written and sha256 hex.
	SaveStream(r io.Reader, relPath string) (int64, string, error)
	// Open returns a readable handle + size for relPath.
	Open(relPath string) (*os.File, int64, error)
	Delete(relPath string) error
	Exists(relPath string) (bool, error)
}

// NewRelPath builds "<YYYY/MM/DD>/<hex-uuid>/<name>" (UTC+8, like the original).
func NewRelPath(filename string) string {
	t := time.Now().In(time.FixedZone("CST", 8*3600))
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err) // crypto/rand failure is unrecoverable
	}
	return path.Join(t.Format("2006/01/02"), hex.EncodeToString(b[:]), filename)
}

// SanitizeFilename strips path components, control characters and dangerous
// names; it keeps unicode names intact and caps the length.
func SanitizeFilename(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	if i := strings.LastIndexByte(name, '/'); i >= 0 {
		name = name[i+1:]
	}
	var sb strings.Builder
	for _, r := range name {
		switch {
		case r < 32, r == 0x7f,
			r == '"', r == '<', r == '>', r == ':', r == '|', r == '?', r == '*':
			continue
		}
		sb.WriteRune(r)
	}
	name = strings.Trim(sb.String(), " .")

	const maxName = 160
	if len(name) > maxName {
		ext := path.Ext(name)
		if len(ext) > 24 {
			ext = ext[:24]
		}
		base := strings.TrimSuffix(name, path.Ext(name))
		budget := maxName - len(ext)
		if budget < 1 {
			budget = 1
		}
		if len(base) > budget {
			base = base[:budget]
			for len(base) > 0 && !utf8.ValidString(base) {
				base = base[:len(base)-1]
			}
		}
		name = base + ext
	}
	if name == "" {
		name = "file"
	}
	return name
}

// ExtAllowed checks the filename against the configured whitelist
// (lowercase extensions without the dot; "*" allows everything).
func ExtAllowed(filename string, allowed []string) bool {
	for _, a := range allowed {
		if a == "*" {
			return true
		}
	}
	ext := strings.ToLower(path.Ext(filename))
	if ext == "" {
		return false // no extension and no wildcard → deny
	}
	ext = ext[1:]
	for _, a := range allowed {
		if a == ext {
			return true
		}
	}
	return false
}
