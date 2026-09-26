package janitor

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"time"

	"flashcodebox/internal/config"
	"flashcodebox/internal/models"
	"flashcodebox/internal/storage"
	"flashcodebox/internal/store"
)

// Start runs the periodic cleanup loop: expired shares, stale chunk sessions
// and orphan chunk directories. It mirrors the original's three background
// tasks but in a single goroutine with one interval. onExpire (optional) is
// called after a room is deleted so SSE clients can be kicked immediately.
func Start(ctx context.Context, cfg *config.Manager, st *store.Store, sto storage.Storage,
	chunkDir string, onExpire func(code string)) {
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				sweep(cfg, st, sto, chunkDir, onExpire)
			}
		}
	}()
}

func sweep(cfg *config.Manager, st *store.Store, sto storage.Storage,
	chunkDir string, onExpire func(code string)) {
	now := models.Now()

	// 1. 过期群：先删全部消息文件，再级联删行。
	if expired, err := st.ExpiredRooms(context.Background(), now); err != nil {
		log.Printf("[janitor] 查询过期群失败: %v", err)
	} else {
		for _, r := range expired {
			msgs, err := st.ListMessages(context.Background(), r.Code, 0, 10000)
			if err != nil {
				log.Printf("[janitor] 读取消息失败 %s: %v", r.Code, err)
			}
			for _, m := range msgs {
				if m.Type == models.TypeFile && m.StoragePath != "" {
					if err := sto.Delete(m.StoragePath); err != nil {
						log.Printf("[janitor] 删除过期文件失败 %s: %v", m.StoragePath, err)
					}
				}
			}
			if err := st.DeleteRoomCascade(context.Background(), r.Code); err != nil {
				log.Printf("[janitor] 级联删除群失败 %s: %v", r.Code, err)
			} else {
				log.Printf("[janitor] 已清理过期群 %s（%d 条消息）", r.Code, len(msgs))
				if onExpire != nil {
					onExpire(r.Code)
				}
			}
		}
	}

	// 1.5 空群（建群后第一条消息没落库的崩溃残留）。
	if codes, err := st.EmptyRooms(context.Background(), now-3600); err != nil {
		log.Printf("[janitor] 清理空群失败: %v", err)
	} else {
		for _, code := range codes {
			log.Printf("[janitor] 已清理空群 %s", code)
		}
	}

	// 2. Stale chunk sessions (client never completed the upload).
	c := cfg.Get()
	if ids, err := st.DeleteExpiredChunkSessions(context.Background(), now-int64(c.ChunkExpireHours)*3600); err != nil {
		log.Printf("[janitor] 清理过期分片会话失败: %v", err)
	} else {
		for _, id := range ids {
			if err := os.RemoveAll(filepath.Join(chunkDir, id)); err != nil {
				log.Printf("[janitor] 删除分片目录失败 %s: %v", id, err)
			}
			log.Printf("[janitor] 已清理过期分片会话 %s", id)
		}
	}

	// 3. Orphan chunk directories with no session row (crash leftovers).
	entries, err := os.ReadDir(chunkDir)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("[janitor] 读取分片目录失败: %v", err)
		}
		return
	}
	live := map[string]bool{}
	if ids, err := st.AllChunkUploadIDs(context.Background()); err == nil {
		for _, id := range ids {
			live[id] = true
		}
	}
	for _, e := range entries {
		if !e.IsDir() || live[e.Name()] {
			continue
		}
		info, err := e.Info()
		if err == nil && time.Since(info.ModTime()) < time.Hour {
			continue // too fresh; give slow clients the benefit of the doubt
		}
		if err := os.RemoveAll(filepath.Join(chunkDir, e.Name())); err != nil {
			log.Printf("[janitor] 删除孤儿分片目录失败 %s: %v", e.Name(), err)
		} else {
			log.Printf("[janitor] 已清理孤儿分片目录 %s", e.Name())
		}
	}
}
