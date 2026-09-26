package api

import "github.com/gin-gonic/gin"

// RegisterRoutes wires the whole API onto the engine. Every route is
// registered relative to the engine root so the app works under any
// reverse-proxy prefix and any port.
func RegisterRoutes(r *gin.Engine, a *App) {
	api := r.Group("api")

	api.GET("config", a.PublicConfig)

	// 聊天室。
	// 限流只挂写操作：轮询拉取与文件下载是正常高频读，不能计数，
	// 否则访客一进入（join + 全量拉取 + 2.5s 轮询）就会撞上限流。
	room := api.Group("room")
	room.POST("create", a.uploadRateLimit(), a.RoomCreate)
	room.POST("join/:code", a.uploadRateLimit(), a.JoinRoom)
	room.GET(":code/messages", a.RoomMessages) // 轮询，不限流
	room.POST(":code/send/text", a.uploadRateLimit(), a.RoomSendText)
	room.POST("send/file", a.uploadRateLimit(), a.RoomSendFile)
	room.GET(":code/messages/:msg/file", a.RoomMessageFile) // 下载/缩略图，不限流
	room.GET(":code/settings", a.RoomSettings)
	room.PUT(":code/settings", a.uploadRateLimit(), a.RoomSettings)

	// 分片上传（complete 落入房间）。
	// 注意：分片 PUT 不做请求次数限流——大文件动辄上百个分片，
	// 按请求数限流会误伤正常上传（429）；滥用防护由会话校验与过期清理承担。
	up := api.Group("upload")
	up.POST("init", a.UploadInit)
	up.PUT(":id/:index", a.UploadChunk)
	up.POST(":id/complete", a.UploadComplete)
	up.GET(":id/status", a.UploadStatus)

	// 管理后台
	admin := api.Group("admin")
	admin.GET("status", a.AdminStatus)
	admin.POST("setup", a.AdminSetup)
	admin.POST("login", a.loginRateLimit(), a.AdminLogin)

	auth := admin.Group("", a.RequireAdmin)
	auth.GET("config", a.AdminGetConfig)
	auth.PUT("config", a.AdminPutConfig)
	auth.GET("list", a.AdminList)
	auth.DELETE("room/:code", a.AdminDelete)
}
