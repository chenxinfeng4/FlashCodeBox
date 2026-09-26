package storage

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// Local stores payloads under a root directory on the local filesystem.
// All access goes through relPath verification so traversal ("..") is
// impossible from the API surface.
type Local struct {
	root string
}

func NewLocal(root string) (*Local, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, fmt.Errorf("创建存储目录失败: %w", err)
	}
	return &Local{root: abs}, nil
}

func (l *Local) resolve(relPath string) (string, error) {
	clean := path.Clean("/" + strings.ReplaceAll(relPath, "\\", "/"))
	full := filepath.Join(l.root, filepath.FromSlash(strings.TrimPrefix(clean, "/")))
	if full != l.root && !strings.HasPrefix(full, l.root+string(os.PathSeparator)) {
		return "", errors.New("非法路径")
	}
	return full, nil
}

func (l *Local) SaveStream(r io.Reader, relPath string) (int64, string, error) {
	full, err := l.resolve(relPath)
	if err != nil {
		return 0, "", err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return 0, "", err
	}
	f, err := os.CreateTemp(filepath.Dir(full), ".tmp-*")
	if err != nil {
		return 0, "", err
	}
	tmpName := f.Name()
	defer os.Remove(tmpName) // no-op after successful rename

	hasher := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, hasher), r)
	if err != nil {
		f.Close()
		return 0, "", err
	}
	if err := f.Close(); err != nil {
		return 0, "", err
	}
	if err := os.Rename(tmpName, full); err != nil {
		return 0, "", err
	}
	return n, hex.EncodeToString(hasher.Sum(nil)), nil
}

func (l *Local) Open(relPath string) (*os.File, int64, error) {
	full, err := l.resolve(relPath)
	if err != nil {
		return nil, 0, err
	}
	f, err := os.Open(full)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, 0, ErrNotFound
		}
		return nil, 0, err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, 0, err
	}
	if info.IsDir() {
		f.Close()
		return nil, 0, ErrNotFound
	}
	return f, info.Size(), nil
}

func (l *Local) Delete(relPath string) error {
	full, err := l.resolve(relPath)
	if err != nil {
		return err
	}
	if err := os.Remove(full); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

func (l *Local) Exists(relPath string) (bool, error) {
	full, err := l.resolve(relPath)
	if err != nil {
		return false, err
	}
	info, err := os.Stat(full)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	return err == nil && !info.IsDir(), nil
}
