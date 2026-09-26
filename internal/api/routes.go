package api

import "github.com/gin-gonic/gin"

// RegisterRoutes wires the whole API onto the engine. Every route is
// registered relative to the engine root so the app works under any
// reverse-proxy prefix and any port.
func RegisterRoutes(r *gin.Engine, a *App) {
	api := r.Group("api")

	api.GET("config", a.PublicConfig)

	// 聊天室
	room := api.Group("room", a.uploadRateLimit())
	room.POST("create", a.RoomCreate)                       // 楼主第一条文字消息 → 建房
	room.POST("join/:code", a.JoinRoom)                     // 访客加入
	room.GET(":code/messages", a.RoomMessages)              // 轮询拉取（after=增量）
	room.POST(":code/send/text", a.RoomSendText)            // 发文字
	room.POST("send/file", a.RoomSendFile)                  // 发文件（建房或追加）
	room.GET(":code/messages/:msg/file", a.RoomMessageFile) // 消息文件下载/内联
	room.GET(":code/settings", a.RoomSettings)              // 楼主读设置
	room.PUT(":code/settings", a.RoomSettings)              // 楼主改设置

	// 分片上传（complete 落入房间）
	up := api.Group("upload", a.uploadRateLimit())
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
