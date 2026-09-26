package api

import "github.com/gin-gonic/gin"

// RegisterRoutes wires the whole API onto the engine. Every route is
// registered relative to the engine root so the app works under any
// reverse-proxy prefix and any port.
func RegisterRoutes(r *gin.Engine, a *App) {
	api := r.Group("api")

	api.GET("config", a.PublicConfig)

	send := api.Group("send", a.uploadRateLimit())
	send.POST("text", a.SendText)
	send.POST("file", a.SendFile)

	up := api.Group("upload", a.uploadRateLimit())
	up.POST("init", a.UploadInit)
	up.PUT(":id/:index", a.UploadChunk)
	up.POST(":id/complete", a.UploadComplete)
	up.GET(":id/status", a.UploadStatus)

	api.POST("get", a.GetShare)
	api.GET("get", a.GetShare)
	api.GET("download/:code", a.Download)

	admin := api.Group("admin")
	admin.GET("status", a.AdminStatus)
	admin.POST("setup", a.AdminSetup)
	admin.POST("login", a.loginRateLimit(), a.AdminLogin)

	auth := admin.Group("", a.RequireAdmin)
	auth.GET("config", a.AdminGetConfig)
	auth.PUT("config", a.AdminPutConfig)
	auth.GET("list", a.AdminList)
	auth.DELETE("share/:code", a.AdminDelete)
}
