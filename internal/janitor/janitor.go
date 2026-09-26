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

	// 1. Expired shares: drop the payload, then the row.
	if expired, err := st.DeleteExpired(context.Background(), now); err != nil {
		log.Printf("[janitor] 清理过期分享失败: %v", err)
	} else {
		for _, fc := range expired {
			if fc.Type == models.TypeFile && fc.StoragePath != "" {
				if err := sto.Delete(fc.StoragePath); err != nil {
					log.Printf("[janitor] 删除过期文件失败 %s: %v", fc.StoragePath, err)
				}
			}
			log.Printf("[janitor] 已清理过期分享 %s", fc.Code)
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
