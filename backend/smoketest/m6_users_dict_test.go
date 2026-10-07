// 本文件是 M6 第②层的最后一段：#34/#35/#36（用户列表与账号处置）
// 和 #9–#12（两本字典的增删）。
//
// 对照 §12 的 M6 判据和 §4 那几行的契约：
//
//	① 封号 / 解封 / 改 role 每一次都写一行留痕，而且只有做这件事的那个 admin 那一行
//	② 封号立刻生效：同一只手里的同一个 token，下一个请求就是 USER_BANNED；
//	   解封之后同一个 token 又能用 —— 中间没有任何「踢下线」的动作
//	③ 改 role **不发通知**（§3.7 那四种触发里没有它），封号和解封各发一条
//	④ 「封自己」「把自己降成普通用户」必须是 FORBIDDEN，而且什么都没写
//	⑤ #34 那四个筛选参数逐个落在 SQL 的 WHERE 上，分页落在 LIMIT / OFFSET 上
//	⑥ 建一条字典条目 → #7/#8 那棵公开树里立刻读得到；还有子节点 / 被帖子引用 → 删不掉
//	⑦ 字典增删**一条通知都不发**，留痕各一行，detail 里带着当年的名字和层级
//
// 为什么这一段非打真库不可：
//   - ② 的全部机制是 middleware.JWT 每个请求重读一行 users。fake 里没有任何东西可读，
//     而「写对了那句 UPDATE、但读路径不回库」这种实现，响应码照样全是 200。
//   - ⑤ 是本文件最直白的一条：筛选条件拼的是字符串 WHERE，占位符编号是手算的。
//     repo.Report.List 刚刚因为「算好了 $4/$5 却没把 where 拼进分页那条 SQL」红过一次
//     （症状是 42P18 → HTTP 500；不崩的那一种是 total 筛了、list 没筛）。
//     同一个错误出现在这里，只有真的按 status / role / q / page 各打一次才看得见。
//   - ⑥ 的「删不掉」来自两条 count(*) 子查询加上 items 那两个外键，
//     而第①层那个 fake store 里压根没有外键这件事。
package smoketest

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"lostfound/internal/apperr"
	"lostfound/internal/model"
)

// ---------- 判据 ①–⑤：账号治理 ----------

const (
	m6UserBanReason   = "换用七个账号反复发布同一张收款码"
	m6UserUnbanReason = "本人已清空全部内容并书面承诺不再发布"
	m6UserRoleUpRes   = "上一任管理员毕业了，需要有人接手待办"
	m6UserRoleDownRes = "该同学不再担任管理员"
	// m6SelfLockReason 只用在「封自己 / 降自己」那两条被拒的请求里。
	// 它必须是一句**合法**的理由：那两条的验收点是「不可恢复性检查」，
	// 理由不合格会先撞上 VALIDATION，测试就什么都没证明。
	m6SelfLockReason = "手滑，想看看会发生什么"
)

// m6UserView 是 #34 一页里的一行。**重新声明**而不是 import model.AdminUserView，
// 理由和 m2_items_test.go 顶部那条一样：两边共用一个 struct 时，
// 「多返回了一列手机号」这种事故两边一起错，测试绿着泄漏。
type m6UserView struct {
	ID          int64  `json:"id"`
	Username    string `json:"username"`
	Nickname    string `json:"nickname"`
	RealName    string `json:"real_name"`
	AuthSource  string `json:"auth_source"`
	Role        string `json:"role"`
	Status      string `json:"status"`
	CreditScore int    `json:"credit_score"`
	CreatedAt   string `json:"created_at"`
}

type m6UserPage struct {
	List     []m6UserView `json:"list"`
	Total    int          `json:"total"`
	Page     int          `json:"page"`
	PageSize int          `json:"page_size"`
}

func m6UsersRaw(t *testing.T, admin Session, query string) Response {
	t.Helper()
	path := "/api/admin/users"
	if query != "" {
		path += "?" + query
	}
	r := harness.Get(t, path, admin.Token)
	RequireOK(t, r, "GET "+path)
	return r
}

func m6Users(t *testing.T, admin Session, query string) m6UserPage {
	t.Helper()
	var p m6UserPage
	m6UsersRaw(t, admin, query).DataInto(t, &p)
	return p
}

func m6UserIDs(p m6UserPage) []int64 {
	out := make([]int64, 0, len(p.List))
	for _, u := range p.List {
		out = append(out, u.ID)
	}
	return out
}

func m6UserStatus(t *testing.T, userID int64) string {
	t.Helper()
	return harness.QueryRow(t, `SELECT status FROM users WHERE id = $1`, userID)["status"].(string)
}

func m6UserRole(t *testing.T, userID int64) string {
	t.Helper()
	return harness.QueryRow(t, `SELECT role FROM users WHERE id = $1`, userID)["role"].(string)
}

// m6DetailOf 把留痕的 detail（JSONB 读出来是一段文本）解成 map，
// 好让每条测试只挑自己那几格。
//
// 用 map 而不是给十二种 action 各声明一个结构体：这一层要证的只是
// 「那一格里写的是这次决定的值」，而各分支的字段名都不同 —— 声明十二个结构体
// 只会把「detail 写坏了」的失败变成「解不出来」而不是「值不对」。
// 需要数组的地方（detail.ids）另说，见 m6_report_resolve_test.go 的 resolveDetail。
func m6DetailOf(t *testing.T, raw string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatalf("留痕的 detail 不是合法 JSON（列类型是 JSONB，这不可能）：%v / %s", err, raw)
	}
	return m
}

func TestM6BanUnbanAndRoleAreLoggedAndTakeEffect(t *testing.T) {
	harness.TruncateAll(t)

	admin := harness.MakeAdmin(t, harness.RegisterAndLogin(t, "m6usr-admin", m5Password))
	victim := harness.RegisterAndLogin(t, "m6usr-victim", m5Password)
	bystander := harness.RegisterAndLogin(t, "m6usr-bystander", m5Password)

	statusURL := func(uid int64) string { return "/api/admin/users/" + itoa(uid) + "/status" }
	roleURL := func(uid int64) string { return "/api/admin/users/" + itoa(uid) + "/role" }

	// ① 八种必须被拒的请求。它们全部排在任何状态变化**之前**，
	//    所以下面那段「什么都没写」的基线（0 行留痕、0 条通知）是一个干净的可数对象。
	cases := []struct {
		name  string
		url   string
		body  map[string]any
		code  string
		field string // 只在 VALIDATION 时检查具体指向哪一格
	}{
		{"封号不填理由", statusURL(victim.UserID),
			map[string]any{"status": model.UserStatusBanned}, apperr.CodeValidation, "reason"},
		{"解封不填理由", statusURL(victim.UserID),
			map[string]any{"status": model.UserStatusActive}, apperr.CodeValidation, "reason"},
		{"理由 501 个字", statusURL(victim.UserID),
			map[string]any{"status": model.UserStatusBanned, "reason": strings.Repeat("长", m6ReasonMaxChars+1)},
			apperr.CodeValidation, "reason"},
		{"status 不在枚举里", statusURL(victim.UserID),
			map[string]any{"status": "ghost", "reason": m6UserBanReason}, apperr.CodeValidation, "status"},
		{"role 不在枚举里", roleURL(victim.UserID),
			map[string]any{"role": "moderator", "reason": m6UserRoleUpRes}, apperr.CodeValidation, "role"},
		{"URL 里的 id 查无此人", statusURL(999999),
			map[string]any{"status": model.UserStatusBanned, "reason": m6UserBanReason}, apperr.CodeNotFound, ""},
		{"封自己的号", statusURL(admin.UserID),
			map[string]any{"status": model.UserStatusBanned, "reason": m6SelfLockReason}, apperr.CodeForbidden, ""},
		{"把自己降成普通用户", roleURL(admin.UserID),
			map[string]any{"role": model.RoleUser, "reason": m6SelfLockReason}, apperr.CodeForbidden, ""},
	}
	for _, tc := range cases {
		r := harness.Do(t, http.MethodPut, tc.url, tc.body, admin.Token)
		if r.Code != tc.code {
			t.Fatalf("%s：期望 code=%s，实际 %s（HTTP %d）\nmessage: %s\ndata: %s",
				tc.name, tc.code, r.Code, r.HTTPStatus, r.Message, truncate(string(r.Data)))
		}
		if tc.field != "" {
			requireField(t, r, tc.field)
		}
	}

	// ② 八条被拒之后库里必须**一个字都没动**。
	//
	// 这一段是本文件唯一的 anti-noop：少了它，「封自己」那条只要**最后**失败就算通过，
	// 而它完全可以是「先 UPDATE 成功、再补一句 FORBIDDEN」—— 那种实现会把全站
	// 唯一的管理员封掉，然后返回一个漂亮的 403。
	if got := harness.Count(t, `SELECT count(*) FROM admin_actions`); got != 0 {
		t.Errorf("被拒的请求之后台账有 %d 行，期望 0 行", got)
	}
	if got := harness.Count(t, `SELECT count(*) FROM notifications`); got != 0 {
		t.Errorf("被拒的请求之后通知有 %d 条，期望 0 条", got)
	}
	for _, s := range []Session{admin, victim, bystander} {
		if got := m6UserStatus(t, s.UserID); got != model.UserStatusActive {
			t.Errorf("用户 %d 的状态写成了 %q，期望仍是 %q", s.UserID, got, model.UserStatusActive)
		}
		// Session.Role 是注册/提权那一刻记下来的值（admin 是 "admin"，另两个是 "user"），
		// 所以这句不是恒真的：它证的正是「被拒的 #35 没把谁的角色改掉」。
		if got := m6UserRole(t, s.UserID); got != s.Role {
			t.Errorf("用户 %d 的角色从 %q 变成了 %q", s.UserID, s.Role, got)
		}
	}
	RequireOK(t, harness.Get(t, "/api/auth/me", victim.Token), "被拒的封号请求之后，本人当然还能读自己")

	// ③ 封号。响应里的 status 来自 UPDATE ... RETURNING 而不是请求参数 ——
	//    所以下面那句直接读库不是在重复响应，是在证明响应没撒谎。
	r := harness.Do(t, http.MethodPut, statusURL(victim.UserID),
		map[string]any{"status": model.UserStatusBanned, "reason": m6UserBanReason}, admin.Token)
	RequireOK(t, r, "封号")
	var banRes struct {
		ID     int64  `json:"id"`
		Status string `json:"status"`
	}
	r.DataInto(t, &banRes)
	if banRes.ID != victim.UserID || banRes.Status != model.UserStatusBanned {
		t.Errorf("#36 的 data 是 %+v，期望 {id:%d,status:%s}", banRes, victim.UserID, model.UserStatusBanned)
	}
	if got := m6UserStatus(t, victim.UserID); got != model.UserStatusBanned {
		t.Fatalf("库里那一行是 %q", got)
	}

	// 同一个 token、没有重新登录 —— 这一句就是「status 不进 JWT」那个设计决定的验收点。
	RequireCode(t, harness.Get(t, "/api/auth/me", victim.Token), apperr.CodeUserBanned)
	RequireCode(t, harness.Post(t, "/api/auth/login",
		map[string]any{"username": victim.Username, "password": m5Password}, ""), apperr.CodeUserBanned)
	// 正向对照：封一个人不该顺手把别人也挡住。
	RequireOK(t, harness.Get(t, "/api/auth/me", bystander.Token), "被封的是 victim，路人不该受影响")

	// ④ 台账一行、通知一条。
	rows := adminActionsOf(t, admin.UserID)
	if len(rows) != 1 {
		t.Fatalf("封号之后台账期望 1 行，实际 %v", m6ActionsBrief(rows))
	}
	if rows[0].Action != model.ActionUserBan || rows[0].TargetType != model.TargetUser ||
		rows[0].TargetID != victim.UserID || rows[0].Reason != m6UserBanReason {
		t.Errorf("那一行是 %+v，期望 {user_ban,user,%d,reason=%s}",
			rows[0], victim.UserID, m6UserBanReason)
	}
	if got := m6DetailOf(t, rows[0].Detail)["status"]; got != model.UserStatusBanned {
		t.Errorf("detail.status 是 %v，期望 %q", got, model.UserStatusBanned)
	}

	ns := notificationsOf(t, victim.UserID)
	if len(ns) != 1 {
		t.Fatalf("被封的人期望恰好 1 条通知，实际 %d 条（类型 %v）", len(ns), typesOf(ns))
	}
	if ns[0].Type != model.NotificationAdminAction {
		t.Errorf("通知类型是 %q，期望 %q", ns[0].Type, model.NotificationAdminAction)
	}
	if !strings.Contains(ns[0].Content, m6UserBanReason) {
		t.Errorf("通知 content 里没有理由原文（§3.7）：%q", ns[0].Content)
	}
	// 封号作用于账号，不作用于某一条帖子 —— item_id 必须是空。
	// 这一格前端会拿去跳帖子详情页，填错了就是一句「该帖子不存在」。
	if ns[0].ItemID != nil {
		t.Errorf("封号通知带着 item_id=%d，期望 NULL", *ns[0].ItemID)
	}
	if got := notificationsFor(t, bystander.UserID); got != 0 {
		t.Errorf("路人收到了 %d 条通知", got)
	}

	// ⑤ #34 那一页：筛选参数逐个落到 SQL 上。
	//
	// 每条断言都成对写：「筛出来的是谁」+「被筛掉的是谁」。只有前半段的话，
	// 一条把 WHERE 整个忽略的 SQL 也能全绿（它返回全部三个人，而那三个人里确实有 victim）。
	banned := m6Users(t, admin, "status="+model.UserStatusBanned)
	if banned.Total != 1 || len(banned.List) != 1 || banned.List[0].ID != victim.UserID {
		t.Errorf("?status=banned 得到 %v（total=%d），期望恰好 victim 一人", m6UserIDs(banned), banned.Total)
	}
	if containsID(m6UserIDs(banned), admin.UserID) || containsID(m6UserIDs(banned), bystander.UserID) {
		t.Errorf("?status=banned 把没被封的人也列出来了：%v", m6UserIDs(banned))
	}
	active := m6Users(t, admin, "status="+model.UserStatusActive)
	if active.Total != 2 || containsID(m6UserIDs(active), victim.UserID) {
		t.Errorf("?status=active 期望恰好 2 人且不含 victim，实际 %v（total=%d）",
			m6UserIDs(active), active.Total)
	}
	if p := m6Users(t, admin, "role="+model.RoleAdmin); p.Total != 1 || p.List[0].ID != admin.UserID {
		t.Errorf("?role=admin 期望恰好做这件事的那个 admin，实际 %v（total=%d）", m6UserIDs(p), p.Total)
	}
	if p := m6Users(t, admin, "q=victim"); p.Total != 1 || p.List[0].ID != victim.UserID {
		t.Errorf("?q=victim 期望模糊命中 1 人，实际 %v（total=%d）", m6UserIDs(p), p.Total)
	}
	// 关键字和状态同时给：两个条件必须是 AND。写成 OR 的话「筛出被封的人」会把
	// 所有 active 用户一起放进来，而那正是管理员最想筛掉的那一批。
	if p := m6Users(t, admin, "q=m6usr&status="+model.UserStatusBanned); p.Total != 1 {
		t.Errorf("?q=m6usr&status=banned 期望 1 人，实际 %d 人", p.Total)
	}
	// 分页参数：page=2 必须真的 OFFSET 到第二条，而不是回到第一页。
	// 排序是 created_at DESC, id DESC，并列时按 id 倒序，所以第二页那条是**最早**注册的 admin。
	if p := m6Users(t, admin, "status="+model.UserStatusActive+"&page=2&page_size=1"); p.Total != 2 ||
		len(p.List) != 1 || p.List[0].ID != admin.UserID {
		t.Errorf("?status=active&page=2&page_size=1 期望 total=2 且第二页是 admin，实际 %v（total=%d）",
			m6UserIDs(p), p.Total)
	}
	// 表外的筛选值必须报错，不能被宽容地当成「没筛选」—— 那会让管理员看见一次
	// 「筛选生效了」的假象，而真实情况是全表分页。
	for _, q := range []string{"status=ghost", "role=moderator", "page_size=0", "page=abc"} {
		RequireCode(t, harness.Get(t, "/api/admin/users?"+q, admin.Token), apperr.CodeValidation)
	}

	// 一行的字段清单：手机号 / 邮箱 / 密码哈希**不在其中**。
	// 这一条比看起来重要 —— #34 用的那条 SQL 刻意没 SELECT 那三列，
	// 而「没查」是唯一能证明「没泄漏」的东西（repo/user.go 里那行注释说的就是这件事）。
	var rawPage struct {
		List []json.RawMessage `json:"list"`
	}
	m6UsersRaw(t, admin, "").DataInto(t, &rawPage)
	if len(rawPage.List) == 0 {
		t.Fatal("#34 一行都没返回，字段清单没法检查")
	}
	assertSameSet(t, "#34 一行的字段（绝不该出现 phone / email / password_hash）",
		[]string{"id", "username", "nickname", "real_name", "auth_source",
			"role", "status", "credit_score", "created_at"},
		jsonKeys(t, rawPage.List[0]))

	// ⑥ 解封：第二条通知、第二行留痕、同一个 token 立刻重新可用。
	r = harness.Do(t, http.MethodPut, statusURL(victim.UserID),
		map[string]any{"status": model.UserStatusActive, "reason": m6UserUnbanReason}, admin.Token)
	RequireOK(t, r, "解封")
	if p := m6Users(t, admin, "status="+model.UserStatusBanned); p.Total != 0 {
		t.Errorf("解封之后 ?status=banned 还剩 %d 人，期望 0 人", p.Total)
	}
	RequireOK(t, harness.Get(t, "/api/auth/me", victim.Token),
		"解封后**同一个** token 就该能用（我们手里没有会话表，下线与上线都靠每次重读那一行 users）")

	ns = notificationsOf(t, victim.UserID)
	if len(ns) != 2 {
		t.Fatalf("解封之后他期望有 2 条通知（封 + 解），实际 %d 条", len(ns))
	}
	// 两句标题必须不同：都叫「账号状态变更」的话，他分不清自己是被封还是被放出来。
	if ns[1].Title == ns[0].Title {
		t.Errorf("解封那条的标题和封号那条一样（%q）", ns[1].Title)
	}
	if !strings.Contains(ns[1].Content, m6UserUnbanReason) {
		t.Errorf("解封那条里没有说明：content=%q", ns[1].Content)
	}
	// 第一条一个字都没改 —— 这类通知是只追加的，后来的那句不该覆盖当初的理由。
	if !strings.Contains(ns[0].Content, m6UserBanReason) {
		t.Errorf("解封之后当初那条封号通知被改写了：content=%q", ns[0].Content)
	}

	rows = adminActionsOf(t, admin.UserID)
	if len(rows) != 2 {
		t.Fatalf("解封后台账期望 2 行，实际 %v", m6ActionsBrief(rows))
	}
	if rows[1].Action != model.ActionUserUnban {
		t.Errorf("第二行是 %q，期望 %q（封与解是两种动作，不能都记成 user_ban）",
			rows[1].Action, model.ActionUserUnban)
	}
	if got := m6DetailOf(t, rows[1].Detail)["status"]; got != model.UserStatusActive {
		t.Errorf("解封那行的 detail.status 是 %v", got)
	}

	// ⑦ 改 role：留痕照写，通知**一条都不发**。
	//
	// 这不是漏了，是 §3.7 那张触发表里压根没有 role_change（理由见 service 那段注释）：
	// 他被提/被降之后 #3 返回的 role 就变了，后台入口出现或消失 —— 那是他立刻看得见的后果，
	// 而通知要说的应该是「为什么」。为了「对称好看」多发明一种文案，就多一处要维护的措辞。
	r = harness.Do(t, http.MethodPut, roleURL(victim.UserID),
		map[string]any{"role": model.RoleAdmin, "reason": m6UserRoleUpRes}, admin.Token)
	RequireOK(t, r, "把 victim 提为管理员")
	var roleRes struct {
		ID   int64  `json:"id"`
		Role string `json:"role"`
	}
	r.DataInto(t, &roleRes)
	if roleRes.ID != victim.UserID || roleRes.Role != model.RoleAdmin {
		t.Errorf("#35 的 data 是 %+v，期望 {id:%d,role:%s}", roleRes, victim.UserID, model.RoleAdmin)
	}
	if got := m6UserRole(t, victim.UserID); got != model.RoleAdmin {
		t.Fatalf("库里 role 是 %q", got)
	}
	// victim.Token 是他还是普通用户时 #2 登录发的**那一个** token。
	// 它能调 #37 才证明 role 真的没在 token 里 —— 降权那一半就在下面。
	RequireOK(t, harness.Get(t, "/api/admin/stats", victim.Token),
		"提为管理员之后，手上那个旧 token 就该立刻能用")
	if got := notificationsFor(t, victim.UserID); got != 2 {
		t.Errorf("改 role 多发了通知：期望仍是 2 条，实际 %d 条", got)
	}

	rows = adminActionsOf(t, admin.UserID)
	if len(rows) != 3 {
		t.Fatalf("改 role 后台账期望 3 行，实际 %v", m6ActionsBrief(rows))
	}
	if rows[2].Action != model.ActionUserRoleChange || rows[2].TargetID != victim.UserID ||
		rows[2].Reason != m6UserRoleUpRes {
		t.Errorf("第三行是 %+v，期望 {user_role_change,user,%d}", rows[2], victim.UserID)
	}
	// detail 只记**改完之后**的 role，不记「从什么改成什么」（理由见 service 那段：
	// from 只能在事务外读到，那是一个可能已被另一个 admin 改过的旧快照）。
	if got := m6DetailOf(t, rows[2].Detail)["role"]; got != model.RoleAdmin {
		t.Errorf("第三行的 detail.role 是 %v", got)
	}

	// 降回去：这一次是**新写一行**，而不是把第三行改掉 —— 日志只追加。
	// 把同一个人身上几条 user_role_change 按时间排开，上一条的 to 就是下一条的 from，
	// 所以只记 to 已经是完整的历史（第三、四两行摆在一起就是在证这件事）。
	r = harness.Do(t, http.MethodPut, roleURL(victim.UserID),
		map[string]any{"role": model.RoleUser, "reason": m6UserRoleDownRes}, admin.Token)
	RequireOK(t, r, "把 victim 降回普通用户")
	RequireCode(t, harness.Get(t, "/api/admin/stats", victim.Token), apperr.CodeForbidden)

	rows = adminActionsOf(t, admin.UserID)
	if len(rows) != 4 {
		t.Fatalf("降权后台账期望 4 行，实际 %v", m6ActionsBrief(rows))
	}
	if got := m6DetailOf(t, rows[3].Detail)["role"]; got != model.RoleUser {
		t.Errorf("第四行的 detail.role 是 %v，期望 %q", got, model.RoleUser)
	}
	if want := []string{
		model.ActionUserBan + "/" + model.TargetUser + "/" + itoa(victim.UserID),
		model.ActionUserUnban + "/" + model.TargetUser + "/" + itoa(victim.UserID),
		model.ActionUserRoleChange + "/" + model.TargetUser + "/" + itoa(victim.UserID),
		model.ActionUserRoleChange + "/" + model.TargetUser + "/" + itoa(victim.UserID),
	}; strings.Join(m6ActionsBrief(rows), ",") != strings.Join(want, ",") {
		t.Errorf("四行留痕的顺序或形状不对：\n got=%v\nwant=%v", m6ActionsBrief(rows), want)
	}
	// 全程只有那两条封/解的通知，role 两次改动一条都没发。
	if got := notificationsFor(t, victim.UserID); got != 2 {
		t.Errorf("通知总数是 %d，期望 2（只有封号和解封各一条）", got)
	}
	if got := harness.Count(t, `SELECT count(*) FROM notifications`); got != 2 {
		t.Errorf("全局通知 %d 条，期望 2 条（谁都不该因为改 role 收到东西）", got)
	}
}

// ---------- 判据 ⑥⑦：两本字典 ----------

// m6DictContract 是两张字典表之间那几处差别。
//
// 把它们写成一张表而不是复制两遍流程，理由和 repo/dict.go 里把表名做成参数一模一样：
// 「分类能建到第三级而地点不能」这种不一致是最难发现的 bug，
// 因为两个端点各自看起来都很正常。共用一条流程 = 共用一套判据。
//
// ⚠ table / itemCol 会拼进 SQL。它们的值**只可能来自本文件下面那两个常量**，
// 永远不是用户输入 —— 拼进 SQL 的标识符必须过这种「值域是我自己写的」检查。
type m6DictContract struct {
	what        string // 「分类」/「地点」，只出现在失败消息里
	table       string // categories / locations：既是 URL 的一段，也是 SQL 里的表名
	itemCol     string // category_id / location_id：items 那一头指着字典的列
	targetType  string // 留痕的 target_type
	prefix      string // 测试条目的名字前缀，用来只数自己插的那几行
	nameMax     int    // 列宽：32 / 64
	levelMax    int    // 层级上限：2 / 3
	hasFreeform bool   // categories 表没有 is_freeform 这一列，请求体里也不该带
}

var (
	m6CatContract = m6DictContract{
		what: "分类", table: "categories", itemCol: "category_id",
		targetType: model.TargetCategory, prefix: "M6测试分类",
		nameMax: 32, levelMax: 2, hasFreeform: false,
	}
	m6LocContract = m6DictContract{
		what: "地点", table: "locations", itemCol: "location_id",
		targetType: model.TargetLocation, prefix: "M6测试地点",
		nameMax: 64, levelMax: 3, hasFreeform: true,
	}
)

const (
	m6DictCreateReason = "开学季新增一批常用条目"
	m6DictDeleteReason = "这一条和别处那条重复了，合并掉"
	m6DictItemTitle    = "M6 字典测试用的招领帖"
)

// m6DictResult 是 #9/#11 的 data：{id,name,level,parent_id}。
// ParentID 是指针：JSON 里 null 和 0 是两件事，而这一条测试正好要同时验到它们。
type m6DictResult struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Level    int    `json:"level"`
	ParentID *int64 `json:"parent_id"`
}

// m6DictNode 是 #7/#8 那棵树的一个节点。两张表共用一个形状：
// 分类节点没有 is_freeform 那一格，解出来就是零值 false，正好当「false 一定是 false」的对照。
type m6DictNode struct {
	ID         int64
	Name       string
	Level      int
	IsFreeform bool `json:"is_freeform"`
	SortOrder  int  `json:"sort_order"`
	Children   []*m6DictNode
}

type m6DictStage struct {
	c           m6DictContract
	admin       Session
	author      Session
	seededNodes int     // 本次开始前公开树里的节点数（见 m6SetupDict 里那句注释）
	ids         []int64 // 建出来的条目 id，按创建顺序（父一定在子之前）
	items       []int64 // 建出来的帖子 id
}

func m6SetupDict(t *testing.T, c m6DictContract) *m6DictStage {
	t.Helper()
	harness.TruncateAll(t)

	st := &m6DictStage{
		c:      c,
		admin:  harness.MakeAdmin(t, harness.RegisterAndLogin(t, "m6dict-"+c.table+"-admin", m5Password)),
		author: harness.RegisterAndLogin(t, "m6dict-"+c.table+"-author", m5Password),
	}
	// ⚠ 这一句 t.Cleanup 不是礼貌，是这条测试**能存在**的前提。
	// TruncateAll 故意不清 categories / locations（那里面是迁移种下的 55 + 91 行，
	// 清了所有测试都发不出帖子），所以这里插进去的每一行都会活到下一次运行，
	// 而 m2_dict_test.go 断言的是那棵树的**确切**形状（9 个根、46 个叶子）。
	// 少了这一句，本文件每跑一次就给那棵树的形状加一层灰尘，直到那条测试永久变红。
	t.Cleanup(func() { st.cleanup(t) })
	// 基线在这里现读，而不是写死 55 / 91：那两个数字是 m2_dict_test.go 的判据，
	// 这一条测试要的只是「我插的都删干净了」，把别人的常量抄到这里只会在我自己
	// 漏删一行时给出一个和项目契约无关的数字。
	st.seededNodes = m6CountNodes(st.tree(t))
	return st
}

// cleanup 硬删这次测试写下的行：先帖子（它是外键的那一头），再字典条目，
// 而条目按创建顺序**倒着**删 —— 创建顺序是父在前，倒过来就是子在前，
// 一条自引用链就这样解开了。
//
// 这里绕过 #17/#10 直接 DELETE 是有意的：清理不是被测对象，
// 而 #10 在有子节点时**本来就该**拒绝（那正是下面要测的行为）。
func (st *m6DictStage) cleanup(t *testing.T) {
	for i := len(st.items) - 1; i >= 0; i-- {
		if _, err := harness.Pool.Exec(context.Background(),
			`DELETE FROM items WHERE id = $1`, st.items[i]); err != nil {
			t.Errorf("清理帖子 %d 失败（它会用外键挡住字典条目）: %v", st.items[i], err)
			return
		}
	}
	for i := len(st.ids) - 1; i >= 0; i-- {
		if _, err := harness.Pool.Exec(context.Background(),
			fmt.Sprintf(`DELETE FROM %s WHERE id = $1`, st.c.table), st.ids[i]); err != nil {
			t.Errorf("清理 %s 条目 %d 失败: %v", st.c.table, st.ids[i], err)
			return
		}
	}
}

func (st *m6DictStage) createRaw(t *testing.T, name string, parentID *int64, freeform bool, reason string) Response {
	t.Helper()
	body := map[string]any{"name": name, "reason": reason}
	if parentID != nil {
		body["parent_id"] = *parentID
	}
	// 分类那条路径**不带**这个键：categories 表没这一列，传了也会被 handler 丢掉。
	// 只有地点表才构造它，这样「两个端点收同一种请求体」这个假设不会溜进测试。
	if st.c.hasFreeform {
		body["is_freeform"] = freeform
	}
	return harness.Post(t, "/api/admin/"+st.c.table, body, st.admin.Token)
}

// create 建一条并立刻把它记进 ids —— 这样 cleanup 一定认得它，
// 哪怕后面的断言当场 t.Fatalf 了。
func (st *m6DictStage) create(t *testing.T, name string, parentID *int64, freeform bool) m6DictResult {
	t.Helper()
	r := st.createRaw(t, name, parentID, freeform, m6DictCreateReason)
	RequireOK(t, r, "建一条"+st.c.what+"「"+name+"」")
	var out m6DictResult
	r.DataInto(t, &out)
	if out.ID == 0 {
		t.Fatalf("#9/#11 返回的 id 是 0：%s", truncate(string(r.Data)))
	}
	st.ids = append(st.ids, out.ID)
	return out
}

func (st *m6DictStage) deleteRaw(t *testing.T, id int64, reason string) Response {
	t.Helper()
	// DELETE 带请求体（只有 reason）是刻意的：§4 第 10/12 行的请求体列就写着 {reason}。
	return harness.Do(t, http.MethodDelete, "/api/admin/"+st.c.table+"/"+itoa(id),
		map[string]any{"reason": reason}, st.admin.Token)
}

func (st *m6DictStage) delete(t *testing.T, id int64) {
	t.Helper()
	r := st.deleteRaw(t, id, m6DictDeleteReason)
	RequireOK(t, r, "删一条"+st.c.what+" "+itoa(id))
	// §4 那两行的响应列是 null。顺手钉住它，因为「删除响应里回半行数据」
	// 会让前端多写一个它其实不需要的分支。
	if len(r.Data) != 0 && string(r.Data) != "null" {
		t.Errorf("删除 %s=%d 的 data 是 %s，期望 null", st.c.table, id, truncate(string(r.Data)))
	}
	// 从 ids 里摘掉：删成功的条目已经不存在，cleanup 不该再去找它。
	for i, tracked := range st.ids {
		if tracked == id {
			st.ids = append(st.ids[:i], st.ids[i+1:]...)
			return
		}
	}
}

// countHere 只数这次测试插进字典表的行（按名字前缀），不碰迁移种下的那些。
func (st *m6DictStage) countHere(t *testing.T) int {
	t.Helper()
	// 前缀是本文件里的常量，不含 LIKE 的通配符，所以这里不需要 escapeLike。
	return harness.Count(t, fmt.Sprintf(`SELECT count(*) FROM %s WHERE name LIKE $1`, st.c.table),
		st.c.prefix+"%")
}

// tree 读那张表对外公开的那棵树（#7/#8，匿名请求 —— 它本来就是公开接口）。
func (st *m6DictStage) tree(t *testing.T) []*m6DictNode {
	t.Helper()
	path := "/api/" + st.c.table
	r := harness.Get(t, path, "")
	RequireOK(t, r, "GET "+path)
	var nodes []*m6DictNode
	r.DataInto(t, &nodes)
	return nodes
}

// createItem 用刚建出来的那条叶子发一条 found 帖。
// 它就是 repo/dict.go 里 dictBlockers 那句「有 N 条帖子正在引用它」的挡路石。
// 另一列用迁移里已知的那一行（#13 两个都必填）。
func (st *m6DictStage) createItem(t *testing.T, dictID int64) itemView {
	t.Helper()
	body := foundBody(m6DictItemTitle, "13800007777")
	if st.c.table == "categories" {
		body["category_id"] = dictID
	} else {
		body["location_id"] = dictID
	}
	it := createItem(t, st.author, body)
	st.items = append(st.items, it.ID)
	return it
}

// hardDelete 从库里真正抹掉一条帖子。#17 做不到这件事（它是软删），
// 而「软删之后外键还牵着」正是下面要断言的一条，所以这里必须能硬删。
func (st *m6DictStage) hardDelete(t *testing.T, itemID int64) {
	t.Helper()
	if _, err := harness.Pool.Exec(context.Background(), `DELETE FROM items WHERE id = $1`, itemID); err != nil {
		t.Fatalf("硬删帖子 %d 失败: %v", itemID, err)
	}
	for i, tracked := range st.items {
		if tracked == itemID {
			st.items = append(st.items[:i], st.items[i+1:]...)
			return
		}
	}
}

func m6FindNode(nodes []*m6DictNode, id int64) *m6DictNode {
	for _, n := range nodes {
		if n.ID == id {
			return n
		}
		if got := m6FindNode(n.Children, id); got != nil {
			return got
		}
	}
	return nil
}

func m6CountNodes(nodes []*m6DictNode) int {
	total := 0
	for _, n := range nodes {
		total += 1 + m6CountNodes(n.Children)
	}
	return total
}

// runM6DictRoundTrip 是一张字典表从建到删的完整一趟。两张表跑同一条流程。
func runM6DictRoundTrip(t *testing.T, st *m6DictStage) {
	t.Helper()
	c := st.c

	// ① 一条层级链，从根建到这张表允许的最里层。
	//    level 不是输入（DictInput 里根本没有这个字段，它由 parent_id 现推），
	//    所以这里断言的是**响应里的 level**，不是我传了什么。
	chain := make([]m6DictResult, 0, c.levelMax)
	for level := 1; level <= c.levelMax; level++ {
		var parentID *int64
		if level > 1 {
			id := chain[level-2].ID
			parentID = &id
		}
		got := st.create(t, fmt.Sprintf("%sL%d", c.prefix, level), parentID, false)
		if got.Level != level {
			t.Fatalf("建第 %d 层返回的 level 是 %d —— 那一列是 parent_id 的函数，不是输入", level, got.Level)
		}
		if level == 1 {
			// 一级条目的 parent_id 必须是 JSON 里的 null 而不是 0：
			// 前端会把 0 当成一个可以点进去的 id（handler 那个 *int64 的注释说的就是这件事）。
			if got.ParentID != nil {
				t.Fatalf("一级条目的 parent_id 是 %d，期望 null", *got.ParentID)
			}
		} else if got.ParentID == nil || *got.ParentID != *parentID {
			t.Fatalf("第 %d 层的 parent_id 是 %+v，期望 %d", level, got.ParentID, *parentID)
		}
		chain = append(chain, got)
	}
	deepestID := chain[c.levelMax-1].ID

	// ② 公开树里读得到：这一条是 #9/#11 存在的全部意义 ——
	//    管理员建完条目，用户在下拉框里就该看见它。
	nodes := st.tree(t)
	for i, n := range chain {
		got := m6FindNode(nodes, n.ID)
		if got == nil {
			t.Fatalf("GET /api/%s 的树里找不到刚建的 id=%d（第 %d 层）—— 建树或那句 WHERE is_active 把它丢了",
				c.table, n.ID, i+1)
		}
		if got.Level != i+1 {
			t.Errorf("树里那个节点的 level 是 %d，期望 %d", got.Level, i+1)
		}
	}

	// ③ 六种必须被拒的请求。全部排在任何删除之前，所以「什么都没插」是一个干净的可数对象。
	pending := st.countHere(t)
	if pending != c.levelMax {
		t.Fatalf("夹具期望表里有 %d 行测试条目，实际 %d 行 —— 后面的每个计数都建在这个基线上", c.levelMax, pending)
	}
	if got := harness.Count(t, `SELECT count(*) FROM admin_actions`); got != c.levelMax {
		t.Fatalf("台账期望 %d 行（每次成功建一条），实际 %d 行", c.levelMax, got)
	}

	tooDeepName := c.prefix + "越界"
	rejects := []struct {
		name   string
		node   string
		parent *int64
		reason string
		code   string
		field  string
	}{
		{"同一个上级下面已有同名", chain[0].Name, nil, m6DictCreateReason, apperr.CodeConflict, ""},
		{"名字只有空格", "   ", nil, m6DictCreateReason, apperr.CodeValidation, "name"},
		{fmt.Sprintf("名字超列宽（%d+1）", c.nameMax), strings.Repeat("长", c.nameMax+1), nil,
			m6DictCreateReason, apperr.CodeValidation, "name"},
		{"不填 reason", c.prefix + "无理由", nil, "", apperr.CodeValidation, "reason"},
		{"parent_id 在那张表里不存在", tooDeepName, ptr(int64(999999)), m6DictCreateReason,
			apperr.CodeValidation, "parent_id"},
		{fmt.Sprintf("第 %d 层下面不能再挂", c.levelMax), tooDeepName, &deepestID, m6DictCreateReason,
			apperr.CodeValidation, "parent_id"},
	}
	for _, tc := range rejects {
		r := st.createRaw(t, tc.node, tc.parent, false, tc.reason)
		if r.Code != tc.code {
			t.Fatalf("%s：期望 code=%s，实际 %s（HTTP %d）\nmessage: %s\ndata: %s",
				tc.name, tc.code, r.Code, r.HTTPStatus, r.Message, truncate(string(r.Data)))
		}
		if tc.field != "" {
			requireField(t, r, tc.field)
		}
	}
	// 六种被拒 = 一行都没插、一行留痕都没多。少了这两句，上面那六条只证了**响应码**对，
	// 而「先插进去再把错误返回」那种实现（留痕或插入跑在 pool 而不是那个 tx 上）
	// 恰好在响应码上看不出来。
	if got := st.countHere(t); got != pending {
		t.Errorf("被拒的建条目请求之后，测试条目从 %d 行涨到了 %d 行", pending, got)
	}
	if got := harness.Count(t, `SELECT count(*) FROM admin_actions`); got != c.levelMax {
		t.Errorf("被拒的建条目请求多写了留痕：期望 %d 行，实际 %d 行", c.levelMax, got)
	}

	// ④ 两种「删不掉」，各走 repo 里那两条 count 的一个分支：
	//    「下面还有子节点」管父节点（这一条），「有 N 条帖子正在引用它」管叶子（⑤）。
	//    两条挡路的是同一个 409，而管理员接下来要做的事**完全相反**
	//    （先删子节点 vs 先处理帖子），所以两条都得被测到，一条都不能只靠 message 分辨。
	RequireCode(t, st.deleteRaw(t, chain[0].ID, m6DictDeleteReason), apperr.CodeCategoryInUse)
	if st.countHere(t) != pending {
		t.Errorf("被挡住的那次删除还是把行删掉了：期望仍 %d 行", pending)
	}

	// ⑤ 一条引用它的帖子。这一条帖子的存在是这一段的全部意义：
	//    items.category_id / location_id 那两个外键**没有 ON DELETE CASCADE**，
	//    「能不能删」这件事由那一列引用着谁决定，而那在第①层的 fake 里不存在。
	it := st.createItem(t, deepestID)
	// 夹具自证：先证明「确实有一条帖子指着它」。少了这一段，
	// 下面那句「删不掉」可能是因为帖子压根没建成功而蒙对的。
	if got := harness.Count(t,
		fmt.Sprintf(`SELECT count(*) FROM items WHERE %s = $1`, c.itemCol), deepestID); got != 1 {
		t.Fatalf("夹具期望 1 条帖子引用条目 %d，实际 %d 条", deepestID, got)
	}
	// 全局通知必须是 0：这一句同时是「字典增删绝不发通知」的基线和
	// 「建这条 found 帖没惊动任何人」的夹具自证（舞台上一条 lost 帖都没有，
	// 匹配扫不到候选 —— 和 m6_report_resolve_test.go 用的是同一手法）。
	if got := harness.Count(t, `SELECT count(*) FROM notifications`); got != 0 {
		t.Fatalf("夹具基线不该有任何通知，实际 %d 条 —— 后面那句「零通知」会失去意义", got)
	}
	RequireCode(t, st.deleteRaw(t, deepestID, m6DictDeleteReason), apperr.CodeCategoryInUse)

	// ⑥ 软删之后**照样**删不掉。这不是 bug，是刻意的：dictBlockers 那句
	//    `count(*) FROM items WHERE category_id = $1` 不带 status 条件，
	//    因为软删的帖子还能被 #44 恢复，它对那一行字典的外键一分一秒都没松开过。
	//    「删掉一个仍被软删帖子引用的条目」的后果是恢复按钮按下去得到一个
	//    指向不存在条目的帖子 —— 那比多留一行字典数据糟得多。
	harness.SetItemStatus(t, it.ID, "deleted")
	RequireCode(t, st.deleteRaw(t, deepestID, m6DictDeleteReason), apperr.CodeCategoryInUse)

	// ⑦ 硬删之后才放行。
	st.hardDelete(t, it.ID)
	st.delete(t, deepestID)
	if got := m6FindNode(st.tree(t), deepestID); got != nil {
		t.Errorf("删掉的条目还在公开树里：%+v", got)
	}

	// ⑧ 剩下的按里层往外删。每一层此刻都已经没有子节点了（它下面那层刚被删掉）。
	for level := c.levelMax - 1; level >= 1; level-- {
		st.delete(t, chain[level-1].ID)
	}
	if got := st.countHere(t); got != 0 {
		t.Errorf("删完一轮之后表里还剩 %d 行测试条目，期望 0 行", got)
	}
	if got := m6CountNodes(st.tree(t)); got != st.seededNodes {
		t.Errorf("公开树现在有 %d 个节点，本次开始时有 %d 个 —— 有测试条目没删干净", got, st.seededNodes)
	}

	// ⑨ 一个不存在的 id：NOT_FOUND，而且没有留痕。
	//    repo 里那条 DELETE 用 RETURNING 拿被删的那一行，拿不到行就是查无此值 ——
	//    它和「存在但有东西挡着」是两种必须分开的结局（409 vs 404）。
	RequireCode(t, st.deleteRaw(t, 999999, m6DictDeleteReason), apperr.CodeNotFound)

	// ⑩ 留痕：建 N 行 + 删 N 行，顺序就是动作顺序（只追加、不改写）。
	//     被拒的那六次建条目和三次删除一行都没写，所以这里是 2×levelMax 而不是更多。
	rows := adminActionsOf(t, st.admin.UserID)
	if len(rows) != 2*c.levelMax {
		t.Fatalf("台账期望 %d 行（建 %d + 删 %d），实际 %v",
			2*c.levelMax, c.levelMax, c.levelMax, m6ActionsBrief(rows))
	}
	for i, n := range chain {
		row := rows[i]
		if row.Action != model.ActionDictCreate || row.TargetType != c.targetType ||
			row.TargetID != n.ID || row.Reason != m6DictCreateReason {
			t.Errorf("建那一段第 %d 行是 %+v，期望 {dict_create,%s,%d}", i+1, row, c.targetType, n.ID)
		}
		d := m6DetailOf(t, row.Detail)
		// detail 里带 name 和 level，是因为这一行**后来被删掉了**，
		// 而「他当年建过一个叫什么的大类」是 #50 那一页要能回答的问题。
		if d["name"] != n.Name || d["level"] != float64(n.Level) {
			t.Errorf("建那行的 detail 是 %v，期望 name=%q level=%d", d, n.Name, n.Level)
		}
		if n.Level == 1 {
			if _, ok := d["parent_id"]; ok {
				t.Errorf("一级条目的 detail 里出现了 parent_id：%v", d)
			}
		} else if d["parent_id"] != float64(chain[n.Level-2].ID) {
			t.Errorf("第 %d 层那行的 detail.parent_id 是 %v，期望 %d",
				n.Level, d["parent_id"], chain[n.Level-2].ID)
		}
	}
	// 删除的顺序是 ⑦⑧ 那个顺序（最里层最先走），所以这里要**倒着**对 chain，
	// 不能按建那一段的下标直接对 —— 按错了下标只会让两条断言互相抵消。
	for j := 0; j < c.levelMax; j++ {
		deleted := chain[c.levelMax-1-j]
		row := rows[c.levelMax+j]
		if row.Action != model.ActionDictDelete || row.TargetType != c.targetType ||
			row.TargetID != deleted.ID || row.Reason != m6DictDeleteReason {
			t.Errorf("删那一段第 %d 行是 %+v，期望 {dict_delete,%s,%d}",
				j+1, row, c.targetType, deleted.ID)
		}
		if d := m6DetailOf(t, row.Detail); d["name"] != deleted.Name || d["level"] != float64(deleted.Level) {
			t.Errorf("删那行的 detail 是 %v，期望 name=%q level=%d（条目已经没了，这两格是唯一线索）",
				d, deleted.Name, deleted.Level)
		}
	}

	// ⑪ 全程零通知。这一句是判据 ⑦ 的第②层版本：字典是**表结构**，不是**某个人的东西**，
	//     它变动时没有任何一个人需要被通知。
	if got := harness.Count(t, `SELECT count(*) FROM notifications`); got != 0 {
		t.Errorf("字典增删发了 %d 条通知，期望 0 条", got)
	}
}

func TestM6CategoryRoundTrip(t *testing.T) {
	st := m6SetupDict(t, m6CatContract)
	runM6DictRoundTrip(t, st)
}

// TestM6LocationRoundTripAndFreeform 先跑那张共用的流程（含「最多三级」那道闸），
// 再单独测 is_freeform —— 那一列只有地点表有。
func TestM6LocationRoundTripAndFreeform(t *testing.T) {
	st := m6SetupDict(t, m6LocContract)
	runM6DictRoundTrip(t, st)

	// ⑫ is_freeform 必须**活着走完**「建 → 公开树读回来」这一趟。
	//
	// 那一列决定两件事：#8 的树里 is_freeform=true 时前端强制填「最近的建筑」并弹红字警告
	// （§3.6），匹配算法直接跳过 Tier 1 进 Tier 2（§5.5）。两件事读的都是这一格。
	// 如果插入时写了 true、读回来是 false，那两处行为会**同时**悄悄失效，
	// 而两个接口的响应码都还是 200 —— 这是只有把值读回来才能发现的那类失效。
	free := st.create(t, st.c.prefix+"自由输入", nil, true)
	node := m6FindNode(st.tree(t), free.ID)
	if node == nil {
		t.Fatal("自由输入的条目没出现在公开树里")
	}
	if !node.IsFreeform {
		t.Errorf("树里那一格 is_freeform 是 false，期望 true（建的时候传的是 true）")
	}
	// 对照的另一半：同一趟读回来的普通条目那一格必须是 false。
	// 少了这一句，「所有节点都返回 true」那种实现（比如序列化时写反了）
	// 能让上面那句跟着一起绿。
	plain := st.create(t, st.c.prefix+"普通叶子", nil, false)
	if got := m6FindNode(st.tree(t), plain.ID); got == nil || got.IsFreeform {
		t.Errorf("普通条目的 is_freeform 读回来是 %+v，期望 false", got)
	}

	// 「其他」那一行是 level=1 却没有子节点，用户直接选它（§3.6 的特例）。
	// 这条帖子证的是：一级不等于不可选，「叶子」的准确定义是「没有子节点」。
	it := st.createItem(t, free.ID)
	if got := harness.Count(t, `SELECT count(*) FROM items WHERE location_id = $1`, free.ID); got != 1 {
		t.Fatalf("夹具期望 1 条帖子挂在自由输入条目上，实际 %d 条", got)
	}
	RequireCode(t, st.deleteRaw(t, free.ID, m6DictDeleteReason), apperr.CodeCategoryInUse)
	st.hardDelete(t, it.ID)
	st.delete(t, free.ID)
	st.delete(t, plain.ID)

	if got := st.countHere(t); got != 0 {
		t.Errorf("最后还剩 %d 行测试条目，期望 0 行", got)
	}
	if got := m6CountNodes(st.tree(t)); got != st.seededNodes {
		t.Errorf("公开树有 %d 个节点，本次开始时有 %d 个", got, st.seededNodes)
	}
	if got := harness.Count(t, `SELECT count(*) FROM notifications`); got != 0 {
		t.Errorf("这一整趟发了 %d 条通知，期望 0 条", got)
	}
}

// ptr 取一个值的地址。表驱动用例里传 *int64 时少一行临时变量。
func ptr(v int64) *int64 { return &v }
