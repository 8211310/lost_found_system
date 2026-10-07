package handler

import (
	"github.com/gin-gonic/gin"

	"lostfound/internal/apperr"
	"lostfound/internal/config"
)

// Debug 对应 §4 #39 GET /api/debug/config。
//
// 这个端点存在的理由很具体：§9 那条「调参先看是哪个信号不对」要求
// 「现在跑的阈值到底是 0.75 还是 0.80」能在浏览器里一句话问到，
// 而不是去翻容器环境变量或者猜 .env 到底加载了哪一份。
// 匹配阈值、日志级别、上传目录都属于这一类「配置到底生效了没有」的事实。
//
// ⚠ 它同时也是全系统唯一会把运行时配置整体吐到 HTTP 响应里的端点，
// 所以它的形状只有一条纪律：**脱敏由 config.Redacted() 负责，这里一个字都不重新拼**。
// 那个函数（config.go）是这份配置唯一一处被打码的出口，
// jwt_secret / db_password / app_secret / sso_state_key 在那里变成 "***" 或 "(未配置)"。
// 如果在这里再手写一个 map，就会同时存在两份「哪些键算敏感」的答案，
// 而将来新增一个密钥的人只会记得改其中一份。
type Debug struct {
	Cfg config.Config
}

// Get 返回打码后的运行时配置。
//
// 鉴权是两条：Admin（由路由上的 RequireAdmin 保证）且 ENV=dev。
// ENV 这一条在这里判而不是只写在 router.go 的注册分支里，是刻意的两道闸：
//   - router.go 那道让生产环境**压根没有这条路由**（404），攻击面是零；
//   - 这道闸管的是「注册那行被改坏」这种情况 —— 少写一个 if 是配置文件里
//     最典型的一行失误，而它的后果是把密钥的打码结果摊给任何一个登录用户看。
//     那一行失误如果只由注册表挡着，发现它的人得先去看路由源码；
//     有这一行在，它的表现是「生产环境返回 FORBIDDEN」，那是一个能被冒烟测试抓住的症状。
//
// 两道闸的口径要一致，所以这里对 prod 返回 FORBIDDEN 而不是 NOT_FOUND：
// 一个「存在但你不该看」和「不存在」在响应上不该有区别（§4 那一行的错误码列写的就是 FORBIDDEN）。
func (h Debug) Get(c *gin.Context) {
	if h.Cfg.IsProd() {
		apperr.Respond(c, apperr.Forbidden("这个端点在生产环境已关闭"))
		return
	}
	u := apperr.User(c)
	if u == nil {
		apperr.Respond(c, apperr.NewMsg(apperr.CodeUnauthorized, "请先登录"))
		return
	}
	if !u.IsAdmin() {
		apperr.Respond(c, apperr.Forbidden("这个接口只对管理员开放"))
		return
	}
	apperr.OK(c, h.Cfg.Redacted())
}
