package models

import "time"

const (
	RoleOwner = "owner"
	RoleGuest = "guest"

	TypeText = "text"
	TypeFile = "file"

	// MaxMessagesPerRoom caps how many messages one room may hold.
	MaxMessagesPerRoom = 500

	// SenderNameOwner is the display name for the room owner.
	SenderNameOwner = "群主"
)

// Room is a chat room; its code doubles as the "group number".
type Room struct {
	ID         int64  `json:"id"`
	Code       string `json:"code"`
	ExpireAt   int64  `json:"expire_at"`   // unix seconds; 0 = never
	AllowReply bool   `json:"allow_reply"` // 访客可否回消息
	CreatedAt  int64  `json:"created_at"`
}

func (r *Room) IsExpired(now int64) bool {
	return r.ExpireAt > 0 && r.ExpireAt <= now
}

// Member is a room participant holding a random token.
type Member struct {
	ID        int64  `json:"id"`
	RoomCode  string `json:"room_code"`
	Role      string `json:"role"`     // owner | guest
	GuestNo   int64  `json:"guest_no"` // 访客编号（群主为 0）
	Token     string `json:"-"`
	Sender    string `json:"sender"` // 展示名：群主 / 访客N
	CreatedAt int64  `json:"created_at"`
}

// Message is one chat message (text or file).
type Message struct {
	ID          int64  `json:"id"`
	RoomCode    string `json:"room_code"`
	MemberID    int64  `json:"member_id"`
	Role        string `json:"role"`
	Sender      string `json:"sender"` // 群主 / 访客N
	Type        string `json:"type"`
	Text        string `json:"text,omitempty"`
	StoragePath string `json:"-"`
	Filename    string `json:"filename,omitempty"`
	Size        int64  `json:"size"`
	FileHash    string `json:"-"`
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
