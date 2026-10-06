package middleware

import (
	"context"
	"strings"

	"github.com/gin-gonic/gin"

	"lostfound/internal/apperr"
	"lostfound/internal/auth"
	"lostfound/internal/model"
)

// UserByID 是 JWT 中间件需要的**全部**数据库能力：按主键取一行 users。
//
// 和 auth.UserLookup 同一个套路 —— 定成窄接口而不是直接依赖 *repo.User：
// 中间件的单元测试可以塞一个内存实现，不用起数据库；同时「中间件到底碰了
// repo 的哪些方法」被写在类型上，将来 repo 长大也不会悄悄扩大依赖面。
type UserByID interface {
	GetByID(ctx context.Context, id int64) (*model.User, error)
}

// headerAuthorization 是承载 token 的标准请求头。
const headerAuthorization = "Authorization"

// bearerPrefix 是 RFC 6750 定义的 token 前缀。
const bearerPrefix = "Bearer "

// JWT 校验登录态，通过后把用户塞进 context，不通过就直接写错误响应并中止。
//
// ⚠ 每个请求都拿 sub 去库里读一遍 users，**不是**从 token 的 claims 里读 role/status。
// 这是刻意的，理由写在 auth.TokenSigner.Issue 的注释里，一句话版本：
// JWT 签出去就改不了，把 role 放进 claims 意味着 admin 降权/封号之后，
// 那个人手上的旧 token 还能继续用满 24 小时 —— 而封号的整个意义就是立刻生效。
// 代价是每个已登录请求多一次主键查询（走 PK 索引，微秒级）。
func JWT(signer auth.TokenSigner, users UserByID) gin.HandlerFunc {
	return func(c *gin.Context) {
		raw, ok := bearerToken(c)
		if !ok {
			// 没带 token 和 token 无效都是 UNAUTHORIZED（§8）：
			// 对前端来说处理方式完全一样（跳登录页），分成两个码只会让它多写一套分支。
			reject(c, apperr.NewMsg(apperr.CodeUnauthorized, "请先登录"))
			return
		}

		userID, err := signer.Parse(raw)
		if err != nil {
			// Parse 已经把内部原因包在 apperr.Error.Err 里，访问日志会打出来，
			// 但响应体只有「登录已过期」/「凭证无效」这类通用文案（§8）。
			reject(c, err)
			return
		}

		u, err := users.GetByID(c.Request.Context(), userID)
		if err != nil {
			if apperr.IsCode(err, apperr.CodeNotFound) {
				// token 签名有效，但对应的用户已经不在库里了。
				// 现实成因：admin 从 Adminer 里删了这行（§3.4 允许），或者测试库被 truncate 过。
				// 对用户表现为 401 让他重新登录，比 500 合理 —— 他确实没有有效身份了。
				reject(c, apperr.WrapMsg(err, apperr.CodeUnauthorized, "账号不存在，请重新登录"))
				return
			}
			// 数据库故障 → 让 apperr.Respond 转成 INTERNAL 500。
			// 绝不能伪装成 401：那会把一次宕机表现成「所有人都登录失效」，
			// 排查时会去查 JWT 密钥是不是换了，而真正的原因是连接断了。
			reject(c, err)
			return
		}

		// 封禁拦截。§8 对 USER_BANNED 的定义是「被封禁用户登录/**操作**」——
		// 登录那一半在 auth.LocalProvider 里，操作这一半就在这里。
		// 少了这里，admin 封号之后那个人手上的旧 token 还能继续发帖、删帖、解锁联系方式。
		if u.IsBanned() {
			reject(c, apperr.NewMsg(apperr.CodeUserBanned, "账号已被封禁，请联系管理员"))
			return
		}

		apperr.SetUserID(c, u.ID)
		apperr.SetUser(c, u)

		// ⚠ 这里**不要**把 user_id 再预绑定进 logger（apperr.SetLogger(c, log.With(...))）。
		// AccessLog 已经把 user_id 作为一个显式字段打进 http.request 那行了，
		// 而它在 c.Next() 之后才执行，那时 UserID(c) 已经被上面这行设好。
		// 再绑定一次会让同一条日志里出现两个 user_id 键 —— 这正是 accesslog.go
		// 里对 request_id 特别注明「不在这里写，因为已经预绑定过了」的同一个坑。
		//
		// 业务日志（比如 service 里的 auth.login）需要 user_id 时自己显式带上，
		// 那样每条日志的字段是写出来的、看得见的，不依赖中间件的绑定顺序。

		c.Next()
	}
}

// bearerToken 从 Authorization 头里取出 token。
//
// 接受的形状：`Bearer <token>`。scheme 大小写不敏感（RFC 7235 规定 auth-scheme
// 是大小写不敏感的），所以 `bearer xxx` 也放行 —— 严格按大小写匹配会让
// 某些 HTTP 客户端（和历史上的 curl 脚本）莫名其妙地拿到 401，而放行它没有任何安全代价。
func bearerToken(c *gin.Context) (string, bool) {
	h := c.GetHeader(headerAuthorization)
	if len(h) < len(bearerPrefix) {
		return "", false
	}
	if !strings.EqualFold(h[:len(bearerPrefix)], bearerPrefix) {
		return "", false
	}
	tok := strings.TrimSpace(h[len(bearerPrefix):])
	if tok == "" {
		return "", false
	}
	return tok, true
}

// reject 写错误响应并中止链路。
//
// c.Abort() 是必须的，而且漏掉它不会立刻出错 —— gin 会继续调用后续的 handler，
// 于是客户端收到两个响应体拼在一起的畸形 JSON，或者 handler 在一个
// 「其实没登录」的 context 上继续跑（UserID(c) 是 0）。这类 bug 的现象
// 离原因很远，所以这里把它和写响应绑成一个函数，不给「忘了 Abort」留机会。
func reject(c *gin.Context, err error) {
	apperr.Respond(c, err)
	c.Abort()
}
