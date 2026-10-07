// Package router 是计划 §4 全部 50 条路由的唯一注册点。
//
// 路由命名规避了一个 Gin 陷阱：Gin 的路由树对「同一层级混用静态段和参数段」
// （如 /api/items/mine 与 /api/items/:id）有限制，历史上会 panic 导致启动失败。
// 所以「当前用户自己的资源」统一收进 /api/my/...，让每一层要么全静态、要么全参数。
// router_test.go 是这条约束的安全网 —— 将来谁加了冲突路径，测试立刻红，而不是服务启动时才 panic。
package router

import (
	"fmt"
	"log/slog"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"

	"lostfound/internal/apperr"
	"lostfound/internal/auth"
	"lostfound/internal/config"
	"lostfound/internal/handler"
	"lostfound/internal/middleware"
	"lostfound/internal/repo"
	"lostfound/internal/service"
)

// Setup 组装整个 HTTP 服务。main.go 只调这一个函数，冒烟测试也调它 ——
// 测试用的是和生产完全相同的装配路径，所以「测试过了但线上不行」这类事故不会发生。
//
// ⚠ 正因为如此，依赖的 new（repo → auth → service → handler）也全部在这里面，
// 而不是在 main.go 里 new 完再传进来。如果装配分散在两处，测试就只能覆盖
// 「handler 以下」的部分，而「谁传给谁」这一步恰恰是最容易接错、
// 且接错了测试还全绿的地方（比如把 provider 接到了错误的 signer 上）。
//
// 返回 error 是因为装配确实可能失败：JWT_SECRET 太短时 auth.NewTokenSigner
// 会拒绝。这个失败必须发生在启动时，绝不能拖到第一个用户登录。
func Setup(cfg config.Config, pool *pgxpool.Pool) (*gin.Engine, error) {
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
	//   Recovery 必须包住所有 handler —— 它要兜住 handler 里的 panic
	//   MaxBodySize 只给 body 套一层限流读取器，和上面三条的顺序约束无关，
	//     放最后是为了不打断那三条
	e.Use(middleware.RequestID(), middleware.AccessLog(), middleware.Recovery(), middleware.MaxBodySize())

	e.NoRoute(apperr.NoRoute)
	e.NoMethod(apperr.NoMethod)

	api := e.Group("/api")

	// ---- M0：地基 ----
	health := handler.Health{Pool: pool}
	api.GET("/health", health.Get)

	// ---- M1：认证（#1–#5）----
	// 装配顺序就是依赖顺序，一个变量只被下面一行用到，读一遍就能看出整条链。
	users := repo.NewUser(pool)

	signer, err := auth.NewTokenSigner(cfg.JWTSecret, cfg.JWTExpire)
	if err != nil {
		return nil, fmt.Errorf("router.Setup: %w", err)
	}

	// M8 接杭电助手时，这一行换成（或包一层）SSO Provider，其余全部不动。
	provider := auth.NewLocalProvider(users, slog.Default())

	authSvc := service.NewAuth(users, provider, signer, slog.Default())
	authH := handler.Auth{Svc: authSvc}

	// #1 #2 公开：还没登录的人要能用它们登录。
	api.POST("/auth/register", authH.Register)
	api.POST("/auth/login", authH.Login)

	// #3 #4 #5 需要登录态。
	//
	// jwt 中间件绑在 Group 上而不是逐条路由写：漏写一条不会编译报错，
	// 而漏掉鉴权是这个系统里后果最严重的一类 bug（任何人都能改别人的资料）。
	// 放在 Group 上，「这个组里的路由都需要登录」是一个看得见的结构事实。
	jwt := middleware.JWT(signer, users)
	me := api.Group("/auth", jwt)
	me.GET("/me", authH.Me)
	me.PUT("/me", authH.UpdateMe)
	me.POST("/change-password", authH.ChangePassword)

	// ---- M2：字典·物品·上传（#6–#8、#13–#19、#40、#42）----

	// NewUpload 会 MkdirAll，返回 error 是因为磁盘不可写时必须在启动阶段就炸 ——
	// 拖到第一个用户点「发布拾物」再失败，他只会看到一个 INTERNAL。
	uploads, err := service.NewUpload(cfg.UploadDir, cfg.UploadBaseURL, slog.Default())
	if err != nil {
		return nil, fmt.Errorf("router.Setup: %w", err)
	}

	dictRepo := repo.NewDict(pool)
	itemRepo := repo.NewItem(pool)
	matchRepo := repo.NewMatch(pool)

	dictSvc := service.NewDict(dictRepo)

	// 装配顺序：matchSvc 必须在 itemSvc 之前 —— 发帖service 拿着 MatchRunner 这个接缝，
	// 而它的实现就是 matchSvc。谁把两行调了个，编译期就会报「未定义」，
	// 不用启动时才在 nil 上炸。
	//
	// cfg.Match 传进去而不是让 service 自己读环境变量：调参是运维的事，
	// 「阈值现在是 0.75 还是 0.80」必须能在 /api/debug/config 里看到（§9），
	// 藏在 service 里读 os.Getenv 就看不见了，而且测试没法换掉它。
	matchSvc := service.NewMatch(matchRepo, itemRepo, uploads, cfg.Match, slog.Default())
	itemSvc := service.NewItem(itemRepo, dictRepo, uploads, matchSvc, slog.Default())

	dictH := handler.Dict{Svc: dictSvc}
	itemH := handler.Item{Svc: itemSvc}
	matchH := handler.Match{Svc: matchSvc}
	uploadH := handler.Upload{Svc: uploads}

	// #40 静态文件。挂在 engine 上而不是 api 组里：计划里的路径就是
	// /uploads/*filepath，不带 /api 前缀，而且它**不走 JSON 信封**（直接回图片二进制）。
	e.Static(cfg.UploadBaseURL, uploads.Dir())

	// #6 要登录：匿名上传等于给全网开一个免费图床，磁盘会被填满。
	api.POST("/uploads", jwt, uploadH.Create)

	// #7 #8 公开：未登录也要能逛广场并按分类/地点筛选，
	// 拿不到字典树，前端那两个三级下拉框根本渲染不出来。
	api.GET("/categories", dictH.Categories)
	api.GET("/locations", dictH.Locations)

	// #13 #14 #15 #16 #17 #18。
	//
	// 全部写在 api 上而不是开一个 /items 子组：这几条的鉴权**不一样**
	// （列表公开、详情公开但要认人、其余要登录），套进一个组里就得给组挑一个
	// 最宽松的中间件再在 handler 里补判断，那正是「漏掉鉴权」这类 bug 的温床。
	// 逐条写出来，每条路由需要什么鉴权是一个看得见的结构事实。
	api.GET("/items", itemH.List)
	api.POST("/items", jwt, itemH.Create)

	// #15 公开但挂 OptionalJWT：contact 的可见性规则里有「发帖人本人」和
	// 「已解锁过」两个分支，所以它必须知道当前是谁在看 —— 但没登录也绝不能 401，
	// 因为帖子内容本身对所有人开放，只有联系方式是锁着的。
	api.GET("/items/:id", middleware.OptionalJWT(signer, users), itemH.Detail)

	api.PUT("/items/:id", jwt, itemH.Update)
	api.DELETE("/items/:id", jwt, itemH.Delete)
	api.PATCH("/items/:id/status", jwt, itemH.ChangeStatus)

	// #19「我的发布」。走 /api/my/... 而不是 /api/items/mine，
	// 理由见本文件开头那条 Gin 路由树注释。
	api.GET("/my/items", jwt, itemH.ListMine)

	// #42 帖主自删单张图片。路径里没有 item id —— 图片自己的 id 已经够定位了。
	api.DELETE("/item-images/:id", jwt, itemH.DeleteImage)

	// ---- M3：匹配（#20）----
	//
	// #20 走 jwt 而不是 OptionalJWT：匹配结果里带着另一批帖子的作者昵称和
	// 「这两条可能是一个东西」的推断，§4 的鉴权列写的是「本人或 Admin」，
	// 匿名请求既不是本人也不是 Admin，那就该 401，而不是认成匿名后给一个空列表。
	api.GET("/items/:id/matches", jwt, matchH.Matches)

	// ---- M4：解锁·通知·举报（#21、#22、#30–#32、#41）----
	// ---- M5：归还确认·积分（#23–#29、#33）----
	// ---- M6：治理与管理后台（#9–#12、#34–#37、#39、#43–#50）----

	return e, nil
}
