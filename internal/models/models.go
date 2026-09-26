package models

import "time"

const (
	TypeText = "text"
	TypeFile = "file"

	// ExpireCountUnlimited means the share can be used without a count limit.
	ExpireCountUnlimited = -1
)

type FileCode struct {
	ID          int64  `json:"id"`
	Code        string `json:"code"`
	Type        string `json:"type"`
	Text        string `json:"text,omitempty"`
	StoragePath string `json:"-"`
	Filename    string `json:"filename,omitempty"`
	Size        int64  `json:"size"`
	FileHash    string `json:"file_hash,omitempty"`
	ExpireAt    int64  `json:"expire_at"`    // unix seconds; 0 = never
	ExpireCount int64  `json:"expire_count"` // -1 = unlimited; >0 = remaining uses
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
