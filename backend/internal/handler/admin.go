package handler

import (
	"github.com/gin-gonic/gin"

	"lostfound/internal/apperr"
	"lostfound/internal/service"
)

// Admin 对应 §4 里 M6 的 16 条治理端点：#9–#12（字典）、#34–#37（用户与统计）、
// #43–#50（下架 / 恢复 / 删图 / 删归还确认 / 警告 / 举报处置 / 操作日志）。
//
// 它们全部住在同一个结构体里，理由不是「都是 admin 的所以放一起」，而是
// **这一层的职责本来就只有一条**：把 HTTP 的形状（路径参数、请求体、查询串）
// 翻译成 service.Moderation 的入参。这里没有任何业务判断 ——
// 「理由必填」在 service 里，「能不能封自己」在 service 里，「留痕怎么写」也在 service 里。
//
// 所以这个文件应该被读成一张**对照表**：§4 那 16 行的「鉴权 / 请求体 / 响应」列，
// 一行对应下面一个方法。看代码的人要能在十秒内确认
// 「这条路由收哪些字段、返回什么形状」，多一层抽象就把这件事变难了。
//
// ⚠ 这里**没有**任何 confirm / reject / 关帖 / 匹配的方法。
// 那四种「以社区成员身份做决定」的动作，admin 一个都拿不到（定位原则 5）。
// 拦住它们的是三道东西：路由表（压根没有那几条 URL）、
// service.Moderation 的依赖接口（ModerationReturns 只有 DeleteTx）、
// 以及归还服务里那个一次都不读 role 的 authorizeReturnDecision。
type Admin struct {
	Svc *service.Moderation
}

// adminID 取出这次请求那个管理员的 id。
//
// id 一律来自 JWT 已经查出来的那一行 users，**永远不是请求参数**。
// 这一句是本文件最重要的纪律：留痕表里那个 admin_id 是整个治理模型唯一的问责入口，
// 而它要是能从 body 里传，「把责任写到别人头上」就只是一次请求体的修改。
//
// 中间件 RequireAdmin 已经保证了这里非 nil 且是 admin，所以正常路径不会走到那两个分支。
// 留着它们不是为了「再判一遍」，是因为**返回错误比 nil 解引用好一点**：
// 少挂一道中间件是路由配置的 bug，那种 bug 应该表现为一句 FORBIDDEN，
// 而不是一个 panic（Recovery 会兜住，但响应里就只剩 500 了）。
// 两道检查各自的分工见 middleware/admin.go 顶部那段。
func adminID(c *gin.Context) (int64, error) {
	u := apperr.User(c)
	if u == nil {
		return 0, apperr.NewMsg(apperr.CodeUnauthorized, "请先登录")
	}
	if !u.IsAdmin() {
		return 0, apperr.Forbidden("这个接口只对管理员开放")
	}
	return u.ID, nil
}

// reasonReq 是「请求体里只有 reason」那五条端点共用的形状（#10、#12、#44、#45、#46、#47）。
//
// 为什么不共用一个 map 或者干脆从 body 里 raw 取字符串：必填和长度校验都在 service 做，
// 这里只负责把 JSON 里那一格取出来。字段名写在这里，
// 是因为 §4 那几行的请求体列就是 `{reason}` —— 结构体和契约一一对应，
// 将来契约加字段时这里加一行，而不是在 map 里加一个 `body["reason"]` 的字符串键。
type reasonReq struct {
	Reason string `json:"reason"`
}

// ---------- #9–#12 字典 ----------

// dictReq 是 #9/#11 的请求体。#11 比 #9 多一个 is_freeform。
//
// ParentID 是指针而不是 int64：JSON 里「没有这个键」和「它是 0」必须分得开。
// 用 int64 的话，建一级大类那种**本来就没有父节点**的请求会被读成 parent_id=0，
// 而 0 不是任何一行 categories 的 id —— 它会在 repo 的父节点点查那里变成
// 「上级不存在」这种把正确请求判错的报错。
type dictReq struct {
	Name       string `json:"name"`
	ParentID   *int64 `json:"parent_id"`
	SortOrder  int    `json:"sort_order"`
	IsFreeform bool   `json:"is_freeform"`
	Reason     string `json:"reason"`
}

// CreateCategory 处理 #9 POST /api/admin/categories。
func (h Admin) CreateCategory(c *gin.Context) {
	aid, err := adminID(c)
	if err != nil {
		apperr.Respond(c, err)
		return
	}

	var req dictReq
	if err := bindJSON(c, &req); err != nil {
		apperr.Respond(c, err)
		return
	}

	res, err := h.Svc.CreateCategory(c.Request.Context(), aid, service.DictInput{
		Name: req.Name, ParentID: req.ParentID, SortOrder: req.SortOrder, Reason: req.Reason,
	})
	if err != nil {
		apperr.Respond(c, err)
		return
	}
	apperr.OK(c, res)
}

// DeleteCategory 处理 #10 DELETE /api/admin/categories/:id。
//
// DELETE 带请求体（只有 reason）是刻意的：§4 第 10 行的请求体列就写着 `{reason}`。
// 一个「删掉 id=37」的 DELETE 如果没有理由，就没有任何东西能说明
// 「为什么这个条目消失了」，而那正是治理要留下的东西。
// 它因此不走 bindJSONOptional（那个把空 body 当成功），空 body 会得到 VALIDATION。
func (h Admin) DeleteCategory(c *gin.Context) {
	aid, err := adminID(c)
	if err != nil {
		apperr.Respond(c, err)
		return
	}
	id, err := pathID(c, "id", "分类")
	if err != nil {
		apperr.Respond(c, err)
		return
	}

	var req reasonReq
	if err := bindJSON(c, &req); err != nil {
		apperr.Respond(c, err)
		return
	}

	if err := h.Svc.DeleteCategory(c.Request.Context(), aid, id, req.Reason); err != nil {
		apperr.Respond(c, err)
		return
	}
	apperr.OK(c, nil)
}

// CreateLocation 处理 #11 POST /api/admin/locations。
func (h Admin) CreateLocation(c *gin.Context) {
	aid, err := adminID(c)
	if err != nil {
		apperr.Respond(c, err)
		return
	}

	var req dictReq
	if err := bindJSON(c, &req); err != nil {
		apperr.Respond(c, err)
		return
	}

	res, err := h.Svc.CreateLocation(c.Request.Context(), aid, service.DictInput{
		Name: req.Name, ParentID: req.ParentID, SortOrder: req.SortOrder,
		IsFreeform: req.IsFreeform, Reason: req.Reason,
	})
	if err != nil {
		apperr.Respond(c, err)
		return
	}
	apperr.OK(c, res)
}

// DeleteLocation 处理 #12 DELETE /api/admin/locations/:id。
func (h Admin) DeleteLocation(c *gin.Context) {
	aid, err := adminID(c)
	if err != nil {
		apperr.Respond(c, err)
		return
	}
	id, err := pathID(c, "id", "地点")
	if err != nil {
		apperr.Respond(c, err)
		return
	}

	var req reasonReq
	if err := bindJSON(c, &req); err != nil {
		apperr.Respond(c, err)
		return
	}

	if err := h.Svc.DeleteLocation(c.Request.Context(), aid, id, req.Reason); err != nil {
		apperr.Respond(c, err)
		return
	}
	apperr.OK(c, nil)
}

// ---------- #34–#37 用户与统计 ----------

// ListUsers 处理 #34 GET /api/admin/users。
func (h Admin) ListUsers(c *gin.Context) {
	res, err := h.Svc.ListUsers(c.Request.Context(), service.UserListQuery{
		Keyword:  c.Query("q"),
		Role:     c.Query("role"),
		Status:   c.Query("status"),
		Page:     c.Query("page"),
		PageSize: c.Query("page_size"),
	})
	if err != nil {
		apperr.Respond(c, err)
		return
	}
	apperr.OK(c, res)
}

// setRoleReq 是 #35 的请求体。
type setRoleReq struct {
	Role   string `json:"role"`
	Reason string `json:"reason"`
}

// SetUserRole 处理 #35 PUT /api/admin/users/:id/role。
func (h Admin) SetUserRole(c *gin.Context) {
	aid, err := adminID(c)
	if err != nil {
		apperr.Respond(c, err)
		return
	}
	// 「用户」而不是「账号」：#35 的 :id 指的是 users 表的一行，
	// 而 pathID 的文案会直接出现在 NOT_FOUND 的 message 里。
	uid, err := pathID(c, "id", "用户")
	if err != nil {
		apperr.Respond(c, err)
		return
	}

	var req setRoleReq
	if err := bindJSON(c, &req); err != nil {
		apperr.Respond(c, err)
		return
	}

	res, err := h.Svc.SetUserRole(c.Request.Context(), aid, uid, req.Role, req.Reason)
	if err != nil {
		apperr.Respond(c, err)
		return
	}
	apperr.OK(c, res)
}

// setUserStatusReq 是 #36 的请求体。
type setUserStatusReq struct {
	Status string `json:"status"`
	Reason string `json:"reason"`
}

// SetUserStatus 处理 #36 PUT /api/admin/users/:id/status。
//
// 封号之后那个人的**下一个请求**就会被 JWT 中间件挡成 USER_BANNED，
// 这里不需要做任何「踢下线」的动作 —— 我们手里没有会话表，token 是无状态的，
// 而每个请求都重读一行 users 就是那台「下线机器」。
func (h Admin) SetUserStatus(c *gin.Context) {
	aid, err := adminID(c)
	if err != nil {
		apperr.Respond(c, err)
		return
	}
	uid, err := pathID(c, "id", "用户")
	if err != nil {
		apperr.Respond(c, err)
		return
	}

	var req setUserStatusReq
	if err := bindJSON(c, &req); err != nil {
		apperr.Respond(c, err)
		return
	}

	res, err := h.Svc.SetUserStatus(c.Request.Context(), aid, uid, req.Status, req.Reason)
	if err != nil {
		apperr.Respond(c, err)
		return
	}
	apperr.OK(c, res)
}

// Stats 处理 #37 GET /api/admin/stats。没有参数：那一页要回答的是
// 「全站现在有多少」，任何筛选都会让它变成另一件事，而那条自检需要的是总数。
func (h Admin) Stats(c *gin.Context) {
	res, err := h.Svc.Stats(c.Request.Context())
	if err != nil {
		apperr.Respond(c, err)
		return
	}
	apperr.OK(c, res)
}

// ---------- #43–#47 内容处置 ----------

// takedownReq 是 #43 的请求体。
//
// ids 用指针切片吗？**不用**，而且是这里唯一一处不需要指针的可选语义：
// 「没带 ids 这个键」和「带了一个空数组」在业务上是同一件事（一条都没选），
// 而 service.normalizeIDs 对两种都回同一句 VALIDATION。
// 反过来说，如果把它做成 *[]int64，就会出现一个没有任何意义的第三种状态。
type takedownReq struct {
	IDs    []int64 `json:"ids"`
	Reason string  `json:"reason"`
}

// TakedownItems 处理 #43 POST /api/admin/items/takedown。
//
// ⚠ 路径以静态的 `takedown` 结尾而不是 `/items/:id/takedown`：这是一次**批量**动作，
// 对象的列表在 body 里。做成 :id 就只有两种坏处 —— 五十条 spam 要点五十次，
// 而且那五十次是五十个独立事务，第 37 次失败时前三十六次已经生效了。
func (h Admin) TakedownItems(c *gin.Context) {
	aid, err := adminID(c)
	if err != nil {
		apperr.Respond(c, err)
		return
	}

	var req takedownReq
	if err := bindJSON(c, &req); err != nil {
		apperr.Respond(c, err)
		return
	}

	res, err := h.Svc.TakedownItems(c.Request.Context(), aid, req.IDs, req.Reason)
	if err != nil {
		apperr.Respond(c, err)
		return
	}
	apperr.OK(c, res)
}

// RestoreItem 处理 #44 POST /api/admin/items/:id/restore。
func (h Admin) RestoreItem(c *gin.Context) {
	aid, err := adminID(c)
	if err != nil {
		apperr.Respond(c, err)
		return
	}
	id, err := pathID(c, "id", "帖子")
	if err != nil {
		apperr.Respond(c, err)
		return
	}

	var req reasonReq
	if err := bindJSON(c, &req); err != nil {
		apperr.Respond(c, err)
		return
	}

	res, err := h.Svc.RestoreItem(c.Request.Context(), aid, id, req.Reason)
	if err != nil {
		apperr.Respond(c, err)
		return
	}
	apperr.OK(c, res)
}

// DeleteImage 处理 #45 DELETE /api/admin/item-images/:id。
//
// 路径里**只有图片自己的 id**，没有 item id —— 那个 id 已经够定位了，
// 而多带一层 /items/:id/item-images/:id 就多一个「两个 id 对不上」的失败模式
// （它和 #42 帖主自删那条是同一种形状，见 router.go 里那行注释）。
func (h Admin) DeleteImage(c *gin.Context) {
	aid, err := adminID(c)
	if err != nil {
		apperr.Respond(c, err)
		return
	}
	id, err := pathID(c, "id", "图片")
	if err != nil {
		apperr.Respond(c, err)
		return
	}

	var req reasonReq
	if err := bindJSON(c, &req); err != nil {
		apperr.Respond(c, err)
		return
	}

	if err := h.Svc.DeleteImage(c.Request.Context(), aid, id, req.Reason); err != nil {
		apperr.Respond(c, err)
		return
	}
	apperr.OK(c, nil)
}

// DeleteReturn 处理 #46 DELETE /api/admin/returns/:id。
//
// 这一条是 #46 而不是某种「admin 代为处理归还确认」：它**销毁一行记录**，
// 不做任何确认或拒绝。那两个动作对 admin 一律关闭（#25/#26），
// 而 TestNoAdminCommunityRoutesExist 那条正则精确到动词就是为了盯着这里 ——
// 出现 `/api/admin/returns/:id/confirm` 这种路径的那一刻就是它该红的时候。
func (h Admin) DeleteReturn(c *gin.Context) {
	aid, err := adminID(c)
	if err != nil {
		apperr.Respond(c, err)
		return
	}
	id, err := pathID(c, "id", "归还确认")
	if err != nil {
		apperr.Respond(c, err)
		return
	}

	var req reasonReq
	if err := bindJSON(c, &req); err != nil {
		apperr.Respond(c, err)
		return
	}

	if err := h.Svc.DeleteReturn(c.Request.Context(), aid, id, req.Reason); err != nil {
		apperr.Respond(c, err)
		return
	}
	apperr.OK(c, nil)
}

// WarnUser 处理 #47 POST /api/admin/users/:id/warn。
//
// 它是 POST 而不是 PUT：一次警告是「新增一条通知」这件事，不修改任何状态。
// 做成 PUT /users/:id/warning 的话，「他收到过几条警告」就得变成一个能覆盖的值，
// 而警告的历史恰恰是要一条条留着的（那一列压根不存在，事实只写在 notifications 里）。
func (h Admin) WarnUser(c *gin.Context) {
	aid, err := adminID(c)
	if err != nil {
		apperr.Respond(c, err)
		return
	}
	uid, err := pathID(c, "id", "用户")
	if err != nil {
		apperr.Respond(c, err)
		return
	}

	var req reasonReq
	if err := bindJSON(c, &req); err != nil {
		apperr.Respond(c, err)
		return
	}

	res, err := h.Svc.WarnUser(c.Request.Context(), aid, uid, req.Reason)
	if err != nil {
		apperr.Respond(c, err)
		return
	}
	apperr.OK(c, res)
}

// ---------- #48–#50 举报与日志 ----------

// ListReports 处理 #48 GET /api/admin/reports。
func (h Admin) ListReports(c *gin.Context) {
	res, err := h.Svc.ListReports(c.Request.Context(), service.ReportListQuery{
		Status:     c.Query("status"),
		ReasonCode: c.Query("reason_code"),
		Page:       c.Query("page"),
		PageSize:   c.Query("page_size"),
	})
	if err != nil {
		apperr.Respond(c, err)
		return
	}
	apperr.OK(c, res)
}

// resolveReportReq 是 #49 的请求体。
//
// note 是选填的处置说明，它会进举报人收到的那条回执（§3.5 那列 resolved_note 的用途）。
// reason 和它的分工是：reason 对**被处置的人**和留痕说话，note 对**举报人**说话 ——
// 后者不能包含「被举报人是谁」这种信息，而 §3.7 那条禁令只能靠措辞和这一层的字段分开来体现。
type resolveReportReq struct {
	Resolution string `json:"resolution"`
	Reason     string `json:"reason"`
	Note       string `json:"note"`
}

// ResolveReport 处理 #49 POST /api/admin/reports/:id/resolve。
func (h Admin) ResolveReport(c *gin.Context) {
	aid, err := adminID(c)
	if err != nil {
		apperr.Respond(c, err)
		return
	}
	id, err := pathID(c, "id", "举报")
	if err != nil {
		apperr.Respond(c, err)
		return
	}

	var req resolveReportReq
	if err := bindJSON(c, &req); err != nil {
		apperr.Respond(c, err)
		return
	}

	res, err := h.Svc.ResolveReport(c.Request.Context(), aid, id, service.ResolveInput{
		Resolution: req.Resolution, Reason: req.Reason, Note: req.Note,
	})
	if err != nil {
		apperr.Respond(c, err)
		return
	}
	apperr.OK(c, res)
}

// ListActions 处理 #50 GET /api/admin/actions。
//
// 四个筛选参数都是可选的，而**一个都不筛就是全站所有治理动作**。
// 这一页存在的意义是「每一个 admin 都能查其他 admin 做过什么」（风险 14），
// 所以这里没有任何「只看自己做的」那种默认值 —— 那种默认会让它变成一份自我备忘，
// 而不是那本对所有人摊开的账。
func (h Admin) ListActions(c *gin.Context) {
	res, err := h.Svc.ListActions(c.Request.Context(), service.ActionListQuery{
		AdminID:    c.Query("admin_id"),
		TargetType: c.Query("target_type"),
		TargetID:   c.Query("target_id"),
		Action:     c.Query("action"),
		Page:       c.Query("page"),
		PageSize:   c.Query("page_size"),
	})
	if err != nil {
		apperr.Respond(c, err)
		return
	}
	apperr.OK(c, res)
}
