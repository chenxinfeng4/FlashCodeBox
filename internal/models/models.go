package models

import "time"

const (
	TypeText = "text"
	TypeFile = "file"

	// ExpireCountUnlimited means the share can be picked up without a count limit.
	ExpireCountUnlimited = -1

	// MaxItemsPerShare caps how many items one share (pickup code) may hold.
	MaxItemsPerShare = 100
)

// FileCode is the share header: a pickup code plus its expiry state.
// The actual content lives in ShareItem rows (text messages / files),
// which can be appended to the share at any time while it is alive.
type FileCode struct {
	ID          int64  `json:"id"`
	Code        string `json:"code"`
	ExpireAt    int64  `json:"expire_at"`    // unix seconds; 0 = never
	ExpireCount int64  `json:"expire_count"` // -1 = unlimited; >0 = remaining pickups
	UsedCount   int64  `json:"used_count"`
	CreatedAt   int64  `json:"created_at"`
}

func (f *FileCode) IsExpired(now int64) bool {
	if f.ExpireAt > 0 && f.ExpireAt <= now {
		return true
	}
	if f.ExpireCount == 0 {
		return true
	}
	return false
}

// ShareItem is one piece of content inside a share.
type ShareItem struct {
	ID          int64  `json:"id"`
	ShareCode   string `json:"share_code"`
	Type        string `json:"type"`
	Text        string `json:"text,omitempty"`
	StoragePath string `json:"-"`
	Filename    string `json:"filename,omitempty"`
	Size        int64  `json:"size"`
	FileHash    string `json:"file_hash,omitempty"`
	CreatedAt   int64  `json:"created_at"`
}

// ChunkSession tracks an in-progress chunked upload.
type ChunkSession struct {
	UploadID    string
	FileName    string
	FileSize    int64
	ChunkSize   int64
	TotalChunks int64
	FileHash    string
	CreatedAt   int64
}

type ChunkPart struct {
	UploadID  string
	PartIndex int64
	PartHash  string
}

func Now() int64 { return time.Now().Unix() }
