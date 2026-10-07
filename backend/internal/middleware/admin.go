package middleware

import (
	"github.com/gin-gonic/gin"

	"lostfound/internal/apperr"
)

// RequireAdmin 拦掉所有不是 admin 的请求。**必须挂在 JWT 之后**。
//
// 它读的是 apperr.User(c) —— 也就是 JWT 中间件刚刚从库里查出来的那一行 users，
// 不是 token 里的某个 claim。这个选择不是偷懒，是 M1 就定下的机制（见 jwt.go 顶部那条注释）：
// role 放进 JWT 的话，降权之后那个人手上的旧 token 还能继续当 24 小时的 admin，
// 而「把一个人从管理员列表里去掉」这件事的全部意义就是立刻生效。
//
// 也正因为这样，这一层**不需要**再查一次库：JWT 已经查了，身份就在 context 里。
//
// ## 为什么权限判断写在这里，而 service 层还要再判一次
//
// 这一层管的是「路由暴露面」：它让非 admin 在任何业务代码跑起来之前就被挡住，
// 所以「猜一个 admin 端点的 url 然后打过去」不会泄漏任何关于那条端点存在性的信息
// （响应只有 FORBIDDEN，和打一个不存在的 admin 路径一样）。
//
// 但**它不是唯一的一道**：#25/#26 那类「只有发帖人能点」的动作，service 层根本不看 role
// （定位原则 5「admin 能销毁内容和账号，但不能制造归属」），而 #16/#17 那种
// 「本人或 admin」的判断本来就长在 service 的 authorizeItemWrite 里。
// 一道检查对应一件事，两道不是冗余 —— 中间件忘了挂是配置错误，
// service 少判一个分支是逻辑错误，这两类错误的发生位置和发现方式都不一样。
func RequireAdmin() gin.HandlerFunc {
	return func(c *gin.Context) {
		u := apperr.User(c)
		if u == nil {
			// 走到这里说明这条路由挂了 RequireAdmin 却没挂 JWT —— 路由配置的 bug。
			// 这里给 UNAUTHORIZED 而不是 FORBIDDEN，是为了和 JWT 自己的口径一致：
			// §8 把「没带 token」定义成 401，前端只有一套「跳登录页」的分支要处理。
			// 不 panic：配置错了也不该让整个进程倒下。
			reject(c, apperr.NewMsg(apperr.CodeUnauthorized, "请先登录"))
			return
		}
		if !u.IsAdmin() {
			// 文案刻意不写「你不是管理员」以外的任何信息 —— 不透露「什么样的账号才算有权限」，
			// 免得它变成一份枚举管理员特征的地图。
			reject(c, apperr.Forbidden("这个接口只对管理员开放"))
			return
		}
		c.Next()
	}
}
