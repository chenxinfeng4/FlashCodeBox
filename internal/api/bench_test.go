package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"flashcodebox/internal/config"
	"flashcodebox/internal/db"
	"flashcodebox/internal/models"
	"flashcodebox/internal/storage"
	"flashcodebox/internal/store"
)

func stringReader(s string) io.Reader { return strings.NewReader(s) }

func parseJSON(data []byte) map[string]any {
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		panic(err)
	}
	if inner, ok := m["data"].(map[string]any); ok {
		return inner
	}
	return m
}

// setupBench spins the real HTTP stack (SQLite in a temp dir + gin + routes)
// with one room, one owner and 3 guests, seeded with seed messages.
func setupBench(b *testing.B, seed int) (*httptest.Server, string, []string, func()) {
	b.Helper()
	gin.SetMode(gin.ReleaseMode)

	tmp, err := os.MkdirTemp("", "fcb-bench-*")
	if err != nil {
		b.Fatal(err)
	}
	cleanup := func() { os.RemoveAll(tmp) }

	gdb, err := db.Open(tmp)
	if err != nil {
		cleanup()
		b.Fatal(err)
	}
	cfg := config.NewManager(gdb)
	if err := cfg.Load(); err != nil {
		b.Fatal(err)
	}
	sto, err := storage.NewLocal(tmp + "/share")
	if err != nil {
		b.Fatal(err)
	}
	app := NewApp(cfg, store.New(gdb), sto, tmp+"/chunks")
	r := gin.New()
	RegisterRoutes(r, app)
	ts := httptest.NewServer(r)

	client := ts.Client()

	postJSON := func(path string, body string, hdr map[string]string) map[string]any {
		req, _ := http.NewRequest("POST", ts.URL+path, stringReader(body))
		req.Header.Set("Content-Type", "application/json")
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		resp, err := client.Do(req)
		if err != nil {
			b.Fatal(err)
		}
		data, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 {
			b.Fatalf("POST %s: HTTP %d: %s", path, resp.StatusCode, data)
		}
		return parseJSON(data)
	}

	// 群主建群 + 首条消息
	owner := postJSON("/api/room/create", `{"text":"bench","expire_value":1,"expire_style":"day"}`, nil)
	code := owner["room"].(map[string]any)["code"].(string)
	ownerToken := owner["token"].(string)
	tokens := []string{ownerToken}

	// 3 个访客加入
	for i := 0; i < 3; i++ {
		req, _ := http.NewRequest("POST", ts.URL+"/api/room/join/"+code, nil)
		resp, err := client.Do(req)
		if err != nil {
			b.Fatal(err)
		}
		data, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		g := parseJSON(data)
		tokens = append(tokens, g["token"].(string))
	}

	// 预置 seed 条消息（直插 store，绕开限流与消息上限）
	st := store.New(gdb)
	for i := 0; i < seed; i++ {
		_ = st.InsertMessage(context.Background(), &models.Message{
			RoomCode: code, Role: "owner", Sender: "群主", Type: "text",
			Text: fmt.Sprintf("seed message %d", i), CreatedAt: models.Now(),
		})
	}

	return ts, code, tokens, func() {
		ts.Close()
		gdb.Close()
		cleanup()
	}
}

func BenchmarkRoomMessages(b *testing.B) {
	ts, code, tokens, cleanup := setupBench(b, 100)
	defer cleanup()

	client := ts.Client()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		i := 0
		for pb.Next() {
			req, _ := http.NewRequest("GET",
				ts.URL+"/api/room/"+code+"/messages?after=0", nil)
			req.Header.Set("X-Room-Token", tokens[i%len(tokens)])
			resp, err := client.Do(req)
			if err != nil {
				b.Fatal(err)
			}
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			i++
		}
	})
}
