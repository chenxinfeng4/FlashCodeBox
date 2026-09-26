package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// ---------------------------------------------------------------------------
// SSE hub：按群号分组的订阅者集合，消息/设置/解散事件实时推送给在线成员。

type sseEvent struct {
	name string // message | room | members | gone
	data any
}

type sseHub struct {
	mu    sync.Mutex
	rooms map[string]map[chan sseEvent]struct{}
}

func newSSEHub() *sseHub {
	return &sseHub{rooms: make(map[string]map[chan sseEvent]struct{})}
}

func (h *sseHub) subscribe(code string) chan sseEvent {
	ch := make(chan sseEvent, 16)
	h.mu.Lock()
	defer h.mu.Unlock()
	set := h.rooms[code]
	if set == nil {
		set = make(map[chan sseEvent]struct{})
		h.rooms[code] = set
	}
	set[ch] = struct{}{}
	return ch
}

func (h *sseHub) unsubscribe(code string, ch chan sseEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if set := h.rooms[code]; set != nil {
		delete(set, ch)
		if len(set) == 0 {
			delete(h.rooms, code)
		}
	}
}

// publish delivers an event to every subscriber of a room. Delivery is
// best-effort and never blocks the request path: a slow consumer's buffered
// channel simply drops the event (its client recovers via the polling
// fallback or a visibility-change resync).
func (h *sseHub) publish(code, name string, data any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.rooms[code] {
		select {
		case ch <- sseEvent{name, data}:
		default:
		}
	}
}

// NotifyRoomGone lets the janitor (which deletes rooms outside the api
// package) kick every connected member out of a dissolved room.
func (a *App) NotifyRoomGone(code string) {
	a.sse.publish(code, "gone", gin.H{"code": code})
}

const sseHeartbeat = 25 * time.Second

// RoomEvents streams live room updates as Server-Sent Events. The member
// token travels via query string (EventSource cannot set custom headers).
// The polling endpoint stays available as a fallback for strict proxies and
// older clients.
func (a *App) RoomEvents(c *gin.Context) {
	code := normalizeCode(c.Param("code"))
	room, okR := a.loadRoom(c, code)
	if !okR {
		return
	}
	member := a.authMemberByToken(c.Request.Context(), room, c.Query("token"))
	if member == nil {
		fail(c, http.StatusForbidden, "请先加入群聊")
		return
	}
	flusher, okF := c.Writer.(http.Flusher)
	if !okF {
		fail(c, http.StatusInternalServerError, "当前环境不支持流式响应")
		return
	}

	ch := a.sse.subscribe(code)
	defer a.sse.unsubscribe(code, ch)

	hdr := c.Writer.Header()
	hdr.Set("Content-Type", "text/event-stream")
	hdr.Set("Cache-Control", "no-cache")
	hdr.Set("X-Accel-Buffering", "no") // nginx: stream through, don't buffer
	c.Writer.WriteHeader(http.StatusOK)

	write := func(name string, data any) bool {
		payload, err := json.Marshal(data)
		if err != nil {
			return true // skip a malformed event, keep the stream alive
		}
		if _, err := fmt.Fprintf(c.Writer, "event: %s\ndata: %s\n\n", name, payload); err != nil {
			return false // client went away
		}
		flusher.Flush()
		return true
	}

	// 初始快照：房间头 + 成员数，join 后立即同步而无需等首次轮询
	if !write("room", roomView(room)) {
		return
	}
	if !write("members", gin.H{"count": a.memberCount(c.Request.Context(), code)}) {
		return
	}

	heartbeat := time.NewTicker(sseHeartbeat)
	defer heartbeat.Stop()
	for {
		select {
		case <-c.Request.Context().Done():
			return
		case ev := <-ch:
			if !write(ev.name, ev.data) {
				return
			}
		case <-heartbeat.C:
			if _, err := fmt.Fprint(c.Writer, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
