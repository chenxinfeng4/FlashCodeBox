package janitor

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"time"

	"filesender/internal/config"
	"filesender/internal/models"
	"filesender/internal/storage"
	"filesender/internal/store"
)

// Start runs the periodic cleanup loop: expired shares, stale chunk sessions
// and orphan chunk directories. It mirrors the original's three background
// tasks but in a single goroutine with one interval.
func Start(ctx context.Context, cfg *config.Manager, st *store.Store, sto storage.Storage, chunkDir string) {
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				sweep(cfg, st, sto, chunkDir)
			}
		}
	}()
}

func sweep(cfg *config.Manager, st *store.Store, sto storage.Storage, chunkDir string) {
	now := models.Now()

	// 1. Expired shares: delete every item payload first, then cascade rows.
	if expired, err := st.ExpiredShares(context.Background(), now); err != nil {
		log.Printf("[janitor] 查询过期分享失败: %v", err)
	} else {
		for _, fc := range expired {
			items, err := st.ListShareItems(context.Background(), fc.Code)
			if err != nil {
				log.Printf("[janitor] 读取分享条目失败 %s: %v", fc.Code, err)
			}
			for _, it := range items {
				if it.Type == models.TypeFile && it.StoragePath != "" {
					if err := sto.Delete(it.StoragePath); err != nil {
						log.Printf("[janitor] 删除过期文件失败 %s: %v", it.StoragePath, err)
					}
				}
			}
			if err := st.DeleteShareCascade(context.Background(), fc.Code); err != nil {
				log.Printf("[janitor] 级联删除分享失败 %s: %v", fc.Code, err)
			} else {
				log.Printf("[janitor] 已清理过期分享 %s（%d 条内容）", fc.Code, len(items))
			}
		}
	}

	// 1.5 Empty shares (process died before first item landed).
	if codes, err := st.DeleteEmptyShares(context.Background(), now-3600); err != nil {
		log.Printf("[janitor] 清理空分享失败: %v", err)
	} else {
		for _, code := range codes {
			log.Printf("[janitor] 已清理空分享 %s", code)
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
