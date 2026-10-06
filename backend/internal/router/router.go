// Package router 是计划 §4 全部 50 条路由的唯一注册点。
//
// 路由命名规避了一个 Gin 陷阱：Gin 的路由树对「同一层级混用静态段和参数段」
// （如 /api/items/mine 与 /api/items/:id）有限制，历史上会 panic 导致启动失败。
// 所以「当前用户自己的资源」统一收进 /api/my/...，让每一层要么全静态、要么全参数。
// router_test.go 是这条约束的安全网 —— 将来谁加了冲突路径，测试立刻红，而不是服务启动时才 panic。
package router

import (
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"

	"lostfound/internal/apperr"
	"lostfound/internal/config"
	"lostfound/internal/handler"
	"lostfound/internal/middleware"
)

// Setup 组装整个 HTTP 服务。main.go 只调这一个函数，冒烟测试也调它 ——
// 测试用的是和生产完全相同的装配路径，所以「测试过了但线上不行」这类事故不会发生。
func Setup(cfg config.Config, pool *pgxpool.Pool) *gin.Engine {
	if cfg.IsProd() {
		gin.SetMode(gin.ReleaseMode)
	}

	e := gin.New()
	// 打开它，方法不对时才会走 NoMethod(405) 而不是 NoRoute(404)
	e.HandleMethodNotAllowed = true

	// 顺序是有讲究的，别随便调：
	//   RequestID 必须在最外层 —— 后面两个中间件打的日志都要靠它预绑定的 request_id
	//   AccessLog 必须在 Recovery 外面 —— Recovery 在内层把 panic 转成 500 之后正常返回，
	//     AccessLog 才能记到真实的 500；反过来放的话 panic 会穿过 AccessLog，
	//     它的 defer 在栈展开时执行，那时 c.Writer.Status() 还是默认的 200，日志会撒谎
	//   Recovery 必须在最内层 —— 它要兜住 handler 里的 panic
	e.Use(middleware.RequestID(), middleware.AccessLog(), middleware.Recovery())

	e.NoRoute(apperr.NoRoute)
	e.NoMethod(apperr.NoMethod)

	api := e.Group("/api")

	// ---- M0：地基 ----
	health := handler.Health{Pool: pool}
	api.GET("/health", health.Get)

	// ---- M1：认证（#1–#5）----
	// ---- M2：字典·物品·上传（#6–#8、#13–#19、#40、#42）----
	// ---- M3：匹配（#20）----
	// ---- M4：解锁·通知·举报（#21、#22、#30–#32、#41）----
	// ---- M5：归还确认·积分（#23–#29、#33）----
	// ---- M6：治理与管理后台（#9–#12、#34–#37、#39、#43–#50）----

	return e
}
