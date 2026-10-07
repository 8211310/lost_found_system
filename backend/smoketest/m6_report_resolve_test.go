package smoketest

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"lostfound/internal/apperr"
	"lostfound/internal/model"
)

// 本文件是 M6 第②层的第三段：#49 处置举报（POST /api/admin/reports/:id/resolve）。
// 对照 §12 的 M6 判据和 §4 第 793/795/797 行那三句契约：
//
//	① resolution=dismiss：举报关掉、**帖子一条都没动**，但举报人照样收到回执
//	   （§4 第 793 行「哪怕结论是『没问题』也要回话，否则用户下次不再举报」）
//	② resolution=takedown：帖子没了、同帖另一条 open 举报被连带关掉、
//	   **别帖的举报仍然是 open**（连带只关同帖），留痕 **2 行**
//	③ resolution=ban：作者被封、**帖子还在广场**（封号不删内容），留痕 2 行
//	④ 三种都只给举报人发 report_resolved；被举报人收到的那条说的是「帖子被下架」，
//	   里面**没有出现「举报」两个字**（风险 13：举报者身份永久不被泄露）
//	⑤ 重复处置 → REPORT_ALREADY_RESOLVED，而且第二次什么都没多写
//
// 为什么这一段必须打真库而不是 fake：② 里「同帖另一条被关掉、别帖那条没被关掉」
// 是 repo.ResolveTx 第二句 UPDATE 的 `WHERE item_id = $1 AND status='open'` ——
// 一个只有两个条件的 UPDATE 语句。fake store 只能证明「service 调了这个方法」，
// 证明不了这条 WHERE 写对了；而它写错的后果（把别人的待办一起关掉）在响应里看不见。

const (
	m6DismissReason = "看了原帖和举报说明，这条内容不违规"
	m6DismissNote   = "联系方式是校园卡号，不构成隐私泄露"
	m6TakenReason   = "同一句广告文案在广场连发了五条"
	m6BanReason     = "同一个账号一小时内发了七条收款码诈骗帖"
	m6NoteMaxProbe  = "这段说明只是用来撞长度上限的占位文本，不该落到任何一行数据里"
)

// ---------- 夹具 ----------

// resolveStage 是三种处置共用的现场：两条帖子、三条举报、四个当事人。
//
// 三条举报的分布是这张夹具唯一的意义：
//   - repX1：本文件每条测试**点进去处置的那一条（锚点）**，作者 itemX、举报人 r1
//   - repX2：**同帖的第二个人**举报同一条 itemX，举报人 r2 —— 它必须被连带关掉
//   - repY1：r1 举报的**另一条帖子** itemY —— 它必须**不被关掉**
//
// 后两条是一正一反的对照组。只放 repX2 的话，「连带关闭」写成
// `WHERE reporter_id = $2`（把这个人所有举报都关掉）也照样全绿 ——
// 因为 r1 的另一条举报不存在。只放 repY1 的话，「只关锚点」那种实现也全绿。
// 两个都在，两条错误的 UPDATE 各撞一边。
type resolveStage struct {
	admin, author, other, r1, r2 Session
	itemX, itemY                 itemView
	repX1, repX2, repY1          int64
}

func setupResolve(t *testing.T) resolveStage {
	t.Helper()
	harness.TruncateAll(t)

	const pwd = "correct-horse-battery"
	author := harness.RegisterAndLogin(t, "m6rep-author", pwd)
	other := harness.RegisterAndLogin(t, "m6rep-other", pwd)
	r1 := harness.RegisterAndLogin(t, "m6rep-r1", pwd)
	r2 := harness.RegisterAndLogin(t, "m6rep-r2", pwd)
	admin := harness.MakeAdmin(t, harness.RegisterAndLogin(t, "m6rep-admin", pwd))

	// 两条都发 found 帖、标题弱、描述空：这样 found_created 那一次匹配读到的
	// 候选集是空的（库里没有 lost 帖），**基线 0 条通知**才是夹具保证的事实，
	// 而不是我猜的。后面每条断言数的是「处置这一次动作产生了几条」，
	// 基线不干净的话所有 +1 都会变成 +2 或者反过来被抵消掉。
	itemX := createItem(t, author, foundWalletBody("钱包", "", locLibrary, detailLibrary))
	itemY := createItem(t, other, foundWalletBody("钥匙串", "", locLibrary, detailLibrary))

	st := resolveStage{admin: admin, author: author, other: other, r1: r1, r2: r2,
		itemX: itemX, itemY: itemY}
	st.repX1 = reportCreated(t, r1, itemX.ID, m6ReportBody(model.ReportReasonSpam, "同一句广告发了五条"))
	st.repX2 = reportCreated(t, r2, itemX.ID, m6ReportBody(model.ReportReasonPrivacy, "把我的手机号写进描述了"))
	st.repY1 = reportCreated(t, r1, itemY.ID, m6ReportBody(model.ReportReasonSpam, "也是广告"))

	// 夹具自证：三行都是 open、两个人的举报挂在同一条帖上、通知全 0。
	// 这一步红了就不要往下读断言 —— 下面的每个「恰好 N 条」都建立在这上面。
	for _, id := range []int64{st.repX1, st.repX2, st.repY1} {
		if reportsRow(t, id)["status"] != "open" {
			t.Fatalf("夹具里的举报 %d 不是 open，整条链的基线不成立", id)
		}
	}
	if reportsCountFor(t, itemX.ID) != 2 || reportsCountFor(t, itemY.ID) != 1 {
		t.Fatalf("夹具的举报分布应该是 itemX 两条 / itemY 一条，实际 %d / %d",
			reportsCountFor(t, itemX.ID), reportsCountFor(t, itemY.ID))
	}
	for _, s := range []Session{author, other, r1, r2} {
		if n := notificationsFor(t, s.UserID); n != 0 {
			t.Fatalf("夹具基线不该有任何通知，用户 %d 已经有 %d 条", s.UserID, n)
		}
	}
	return st
}

func m6ReportBody(code, detail string) map[string]any {
	return map[string]any{"reason_code": code, "detail": detail}
}

// reportCreated 走 #41 举报一条帖子并返回那一行的 id。
func reportCreated(t *testing.T, s Session, itemID int64, body map[string]any) int64 {
	t.Helper()
	r := reportItem(t, itemID, body, s.Token)
	RequireOK(t, r, "举报帖子 "+itoa(itemID))
	var res struct {
		ID     int64  `json:"id"`
		Status string `json:"status"`
	}
	r.DataInto(t, &res)
	if res.ID == 0 {
		t.Fatalf("#41 没有返回 id：%s", truncate(string(r.Data)))
	}
	return res.ID
}

func resolveURL(reportID int64) string {
	return "/api/admin/reports/" + itoa(reportID) + "/resolve"
}

// resolveAs 用夹具里那个 admin 的身份处置一条举报。
func resolveAs(t *testing.T, st resolveStage, reportID int64, body map[string]any) Response {
	t.Helper()
	return harness.Do(t, http.MethodPost, resolveURL(reportID), body, st.admin.Token)
}

func m6ResolveBody(resolution, reason, note string) map[string]any {
	return map[string]any{"resolution": resolution, "reason": reason, "note": note}
}

// resolveRow 读回处置之后的那一行。
//
// resolved_by 用 int64 而不是 *int64：这一列在处置过之后一定有值，
// 而 QueryRow 遇到 NULL 会给 nil —— 类型断言当场 panic，
// 那个 panic 说的就是「处置没写进去」这件我们正在查的事，比读到 0 更直白。
func resolveRow(t *testing.T, reportID int64) map[string]any {
	t.Helper()
	return harness.QueryRow(t, `SELECT item_id, status, resolved_by, resolved_note,
	                              (resolved_at IS NOT NULL) AS has_resolved_at
	                           FROM reports WHERE id = $1`, reportID)
}

// reportQueueIDs 是 #48 某一筛选条件下的举报 id 集合（用来验待办队列真的变短了）。
func reportQueueIDs(t *testing.T, admin Session, query string) []int64 {
	t.Helper()
	r := harness.Get(t, "/api/admin/reports?"+query, admin.Token)
	RequireOK(t, r, "GET /api/admin/reports?"+query)
	var page struct {
		List []struct {
			ID int64 `json:"id"`
		} `json:"list"`
	}
	r.DataInto(t, &page)
	out := make([]int64, 0, len(page.List))
	for _, row := range page.List {
		out = append(out, row.ID)
	}
	return out
}

// resolveDetail 是留痕里那份 detail 的结构。三个分支各读自己那部分。
type resolveDetail struct {
	ReportID   int64   `json:"report_id"`
	Resolution string  `json:"resolution"`
	AlsoClosed []int64 `json:"also_closed"`
	ItemID     int64   `json:"item_id"`
	Status     string  `json:"status"`
	Count      int     `json:"count"`
	IDs        []int64 `json:"ids"`
}

func mustDetail(t *testing.T, raw string) resolveDetail {
	t.Helper()
	var d resolveDetail
	if err := json.Unmarshal([]byte(raw), &d); err != nil {
		t.Fatalf("留痕的 detail 不是合法 JSON（列类型是 JSONB，这不可能）：%v / %s", err, raw)
	}
	return d
}

// ---------- 判据 ①：dismiss ----------

// TestM6ResolveDismissRepliesButTouchesNothing 是「举报 ≠ 仲裁」在处置端的另一半。
//
// M4 那一段证的是「举报**进来**时平台什么都不做」；这里证的是
// 「管理员**判定没问题**时平台照样什么都不做，但仍然要回话」。
//
// 顺序按「先参数、后动作、再读回」排：所有被拒的请求都发生在状态变化之前，
// 所以那一段的基线（3 条 open、0 留痕、0 通知）是干净的可数对象。
func TestM6ResolveDismissRepliesButTouchesNothing(t *testing.T) {
	st := setupResolve(t)
	creditBefore := creditOf(t, st.author.UserID)

	// ①-0 四种非法参数：每一种都必须**什么都没写**。
	//
	// 注意字段名分别是 reason / resolution / note —— 三个都在同一个表单里，
	// 前端要靠 field 高亮告诉用户改哪一格。这条也顺带证明了 service 里
	// 那三段校验的顺序（reason 最先）：{} 空体报的是 reason，不是 resolution。
	cases := []struct {
		name  string
		url   func() string
		body  map[string]any
		field string
	}{
		{"不带 reason", func() string { return resolveURL(st.repX1) },
			map[string]any{"resolution": "dismiss"}, "reason"},
		{"resolution 是表外的值", func() string { return resolveURL(st.repX1) },
			m6ResolveBody("delete_it", m6DismissReason, ""), "resolution"},
		{"note 超长", func() string { return resolveURL(st.repX1) },
			m6ResolveBody("dismiss", m6DismissReason, m6NoteMaxProbe+strings.Repeat("长", m6ReasonMaxChars)), "note"},
		{"举报不存在", func() string { return resolveURL(999999) },
			m6ResolveBody("dismiss", m6DismissReason, m6DismissNote), ""},
	}
	for _, c := range cases {
		r := harness.Do(t, http.MethodPost, c.url(), c.body, st.admin.Token)
		if c.field == "" {
			RequireCode(t, r, apperr.CodeNotFound)
		} else {
			requireField(t, r, c.field)
		}
	}
	// 四条全被拒 → 库里一根毛都没动。数的是**全表**而不是某一行：
	// 「先改完再报错」那种实现，按 repX1 那一行去查照样是 open。
	if n := harness.Count(t, `SELECT count(*) FROM reports WHERE status = 'open'`); n != 3 {
		t.Errorf("非法参数之后 open 举报期望仍 3 条，实际 %d", n)
	}
	assertCount(t, "admin_actions", 0)
	assertCount(t, "notifications", 0)

	// ①-1 正常的 dismiss。
	r := resolveAs(t, st, st.repX1, m6ResolveBody(model.ReportResolutionDismiss, m6DismissReason, m6DismissNote))
	RequireOK(t, r, "dismiss 那条举报")
	var got struct {
		ID         int64  `json:"id"`
		Status     string `json:"status"`
		ResolvedAt string `json:"resolved_at"`
	}
	r.DataInto(t, &got)
	// 响应回的是 status 而不是回显 resolution：前端待办页按前者决定这条还显不显示。
	if got.ID != st.repX1 || got.Status != model.ReportStatusDismissed || got.ResolvedAt == "" {
		t.Errorf("#49 的 data 应该是 {id:%d,status:dismissed,resolved_at 非空}，实际 %+v", st.repX1, got)
	}

	// ①-2 库里：锚点和同帖那条都 dismissed，别帖那条**还是 open**；帖子没动。
	for _, id := range []int64{st.repX1, st.repX2} {
		row := resolveRow(t, id)
		if row["status"] != model.ReportStatusDismissed {
			t.Errorf("举报 %d 应该是 dismissed，实际 %v", id, row["status"])
		}
		if asInt64(t, row["resolved_by"]) != st.admin.UserID {
			t.Errorf("举报 %d 的 resolved_by 应该是处置人 %d，实际 %v", id, st.admin.UserID, row["resolved_by"])
		}
		if row["resolved_note"] != m6DismissNote {
			t.Errorf("举报 %d 的 resolved_note 没存下来：实际 %v", id, row["resolved_note"])
		}
		if row["has_resolved_at"] != true {
			t.Errorf("举报 %d 的 resolved_at 是 NULL —— 回执写了时间却没落库", id)
		}
	}
	if resolveRow(t, st.repY1)["status"] != "open" {
		t.Errorf("另一条帖子上的举报 %d 被连带关掉了（它说的不是同一条内容）", st.repY1)
	}
	if itemStatusOf(t, st.itemX.ID) != "open" {
		t.Errorf("dismiss 把帖子 %d 的状态改掉了 —— 「举报没问题」不该变成删内容", st.itemX.ID)
	}
	if p := fetchSquare(t, "page_size=100", ""); p.Total != 2 || !containsID(idsOf(p), st.itemX.ID) {
		t.Errorf("dismiss 之后广场期望仍 2 条且含 %d，实际 total=%d ids=%v", st.itemX.ID, p.Total, idsOf(p))
	}
	if creditOf(t, st.author.UserID) != creditBefore {
		t.Errorf("dismiss 动过作者的积分：%d → %d —— 举报处置不该有任何经济后果",
			creditBefore, creditOf(t, st.author.UserID))
	}

	// ①-3 回执：两个举报人各 1 条，被举报人 0 条。
	//
	// r1 有两份举报（repX1 锚点、repY1 仍 open），他收到的是**恰好 1 条**：
	// 这同时证了两件事 —— 被关掉的那条才发回执、还 open 的那条不发。
	for _, who := range []Session{st.r1, st.r2} {
		ns := notificationsOf(t, who.UserID)
		if len(ns) != 1 {
			t.Fatalf("%s 期望恰好 1 条回执，实际 %d 条（%v）", who.Username, len(ns), typesOf(ns))
		}
		n := findByType(t, ns, model.NotificationReportResolved)
		if !strings.Contains(n.Content, "未采纳") {
			t.Errorf("dismiss 的回执里应该写结论「未采纳」，实际：%s", truncate(n.Content))
		}
		if !strings.Contains(n.Content, m6DismissNote) {
			t.Errorf("管理员写的处理说明没原样进通知：%s", truncate(n.Content))
		}
		if n.ItemID == nil || *n.ItemID != st.itemX.ID {
			t.Errorf("回执挂的 item 应该是 %d，实际 %v", st.itemX.ID, n.ItemID)
		}
	}
	if n := notificationsFor(t, st.author.UserID); n != 0 {
		t.Errorf("被举报人收到了 %d 条通知 —— dismiss 没有动他的内容，就不该打扰他", n)
	}

	// ①-4 留痕：恰好 1 行（§4 第 795 行：dismiss 只写 1 行）。
	rows := adminActionsOf(t, st.admin.UserID)
	if len(rows) != 1 {
		t.Fatalf("dismiss 期望 1 行留痕，实际 %d 行：%v", len(rows), m6ActionsBrief(rows))
	}
	a := rows[0]
	if a.Action != model.ActionReportResolved || a.TargetType != model.TargetReport || a.TargetID != st.repX1 {
		t.Errorf("留痕应该是 report_resolved/report/%d，实际 %s/%s/%d", st.repX1, a.Action, a.TargetType, a.TargetID)
	}
	if a.Reason != m6DismissReason {
		t.Errorf("留痕里的 reason 应该是原文，实际：%s", a.Reason)
	}
	d := mustDetail(t, a.Detail)
	if d.ReportID != st.repX1 || d.Resolution != model.ReportResolutionDismiss {
		t.Errorf("detail 的 report_id/resolution 不对：%s", a.Detail)
	}
	// also_closed 是「这一次顺手关掉了哪些」的凭据。它必须是**数组**而不是个数：
	// 将来有人问「那条被关掉的是哪一条」时，只有个数答不出（风险 14 要的是对得上）。
	if len(d.AlsoClosed) != 1 || d.AlsoClosed[0] != st.repX2 {
		t.Errorf("also_closed 期望 [%d]，实际 %v（detail=%s）", st.repX2, d.AlsoClosed, a.Detail)
	}

	// ①-5 #48 的待办队列：两条都没了，第三条还在。
	if ids := reportQueueIDs(t, st.admin, "status=open&page_size=100"); containsID(ids, st.repX1) ||
		containsID(ids, st.repX2) || !containsID(ids, st.repY1) {
		t.Errorf("处置后 open 队列应该是 [%d]，实际 %v", st.repY1, ids)
	}

	// ①-6 **判据⑤**：重复处置报 REPORT_ALREADY_RESOLVED，且什么都没多写。
	//
	// 这里重复的是**被连带关掉的那一条**（repX2），不是锚点：
	// 两个管理员各自开着待办页时，点了不同行也走到同一条 SQL 门槛上。
	again := resolveAs(t, st, st.repX2, m6ResolveBody(model.ReportResolutionDismiss, m6DismissReason, ""))
	RequireCode(t, again, apperr.CodeReportAlreadyResolved)
	assertCount(t, "admin_actions", 1)
	if n := harness.Count(t, `SELECT count(*) FROM notifications`); n != 2 {
		t.Errorf("重复处置又发了通知，全局期望仍 2 条，实际 %d", n)
	}
}

func m6ActionsBrief(rows []adminActionRow) []string {
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.Action+"/"+r.TargetType+"/"+itoa(r.TargetID))
	}
	return out
}

// ---------- 判据 ②③④：takedown ----------

// TestM6ResolveTakedownRemovesItemAndNotifiesBothSides 是判据 ② 和 ④ 的合流点。
//
// 一次处置要同时满足三件互相拉扯的事：
//   - 举报人要知道结论（发了）
//   - 作者要知道**自己的帖子为什么没了**（也发了）
//   - 但作者**永远不能知道是有人举报了他**（措辞纪律）
//
// 第三条只能靠比字符串证：所以这里把两侧的通知都读出来，
// 断言举报人那条**有**「举报」两个字、作者那条**没有**。
// 这是正向对照和反向断言成对写的最直白的一例 —— 只写后者，
// 某天有人把两句文案都去掉「举报」，测试会跟着一起绿。
func TestM6ResolveTakedownRemovesItemAndNotifiesBothSides(t *testing.T) {
	st := setupResolve(t)
	r := resolveAs(t, st, st.repX1, m6ResolveBody(model.ReportResolutionTakedown, m6TakenReason, "已按社区规范处理"))
	RequireOK(t, r, "takedown 那条举报")

	// ① 内容真的没了：库里 deleted，广场不出现。
	if itemStatusOf(t, st.itemX.ID) != "deleted" {
		t.Errorf("takedown 之后 item %d 应该是 deleted，实际 %s", st.itemX.ID, itemStatusOf(t, st.itemX.ID))
	}
	p := fetchSquare(t, "page_size=100", "")
	if containsID(idsOf(p), st.itemX.ID) {
		t.Errorf("广场里还能看见被下架的那条：%v", idsOf(p))
	}
	if !containsID(idsOf(p), st.itemY.ID) {
		t.Errorf("广场里连**没被处置**的那条都没了 —— 下架写错了 WHERE？%v", idsOf(p))
	}

	// ② 两条同帖举报都变成 resolved；别帖那条仍 open。
	//    这里要的是 resolved 而不是 dismissed：§4 说 takedown/ban 走 resolved。
	for _, id := range []int64{st.repX1, st.repX2} {
		if resolveRow(t, id)["status"] != model.ReportStatusResolved {
			t.Errorf("举报 %d 应该是 resolved，实际 %v", id, resolveRow(t, id)["status"])
		}
	}
	if resolveRow(t, st.repY1)["status"] != "open" {
		t.Errorf("另一条帖子上的举报被连带处置了，它是**另一件事**")
	}

	// ③ 作者那条通知：有理由原文，没有「举报」。
	authorNS := notificationsOf(t, st.author.UserID)
	if len(authorNS) != 1 {
		t.Fatalf("作者期望恰好 1 条通知，实际 %d 条：%v", len(authorNS), typesOf(authorNS))
	}
	an := findByType(t, authorNS, model.NotificationAdminAction)
	if !strings.Contains(an.Content, m6TakenReason) {
		t.Errorf("作者的通知里应该原样带着下架理由，实际：%s", truncate(an.Content))
	}
	if strings.Contains(an.Content, "举报") {
		t.Errorf("作者的通知里出现了「举报」二字 —— 举报人会知道是谁干的（风险 13）：%s", truncate(an.Content))
	}
	if an.ItemID == nil || *an.ItemID != st.itemX.ID {
		t.Errorf("作者的通知没挂上被下架的那条帖子（item_id=%v）—— 他点不开自己那条帖子看状态", an.ItemID)
	}

	// ④ 两个举报人各 1 条 report_resolved，结论是「已下架相关内容」。
	for _, who := range []Session{st.r1, st.r2} {
		ns := notificationsOf(t, who.UserID)
		if len(ns) != 1 {
			t.Fatalf("%s 期望恰好 1 条回执，实际 %d", who.Username, len(ns))
		}
		n := findByType(t, ns, model.NotificationReportResolved)
		if !strings.Contains(n.Content, "已下架相关内容") {
			t.Errorf("回执没写结论：实际 %s", truncate(n.Content))
		}
		// 正向对照：同一次动作、同一段文案生成器，举报人这条**应该**含「举报」。
		if !strings.Contains(n.Content, "举报") {
			t.Errorf("举报人的回执里连「举报」都没有了，那 ③ 那条「不含举报」的断言就永远绿： %s", truncate(n.Content))
		}
	}
	// 另一条帖子的作者**什么都没收到**：他的内容没被动过。
	if n := notificationsFor(t, st.other.UserID); n != 0 {
		t.Errorf("无关作者收到了 %d 条通知", n)
	}

	// ⑤ 留痕 2 行，顺序是先下架后处置（§4 第 795 行「按动作计数」）。
	rows := adminActionsOf(t, st.admin.UserID)
	if len(rows) != 2 {
		t.Fatalf("takedown 期望 2 行留痕（item_takedown + report_resolved），实际 %d：%v",
			len(rows), m6ActionsBrief(rows))
	}
	if rows[0].Action != model.ActionItemTakedown || rows[1].Action != model.ActionReportResolved {
		t.Errorf("留痕顺序或动作名不对：%v", m6ActionsBrief(rows))
	}
	if rows[0].TargetType != model.TargetItem || rows[0].TargetID != st.itemX.ID {
		t.Errorf("item_takedown 指向的不是那条帖子：%s/%d", rows[0].TargetType, rows[0].TargetID)
	}
	d := mustDetail(t, rows[0].Detail)
	// detail.ids 恒在（单条也走 RecordBatch），§13 第 10 步的自检 SQL 依赖这个形状。
	if len(d.IDs) != 1 || d.IDs[0] != st.itemX.ID || d.Count != 1 {
		t.Errorf("单条连带下架的 detail 也应该是 {ids:[x],count:1}，实际 %s", rows[0].Detail)
	}
	if d.ReportID != st.repX1 || d.Resolution != model.ReportResolutionTakedown {
		t.Errorf("item_takedown 的 detail 没带上它是**因为哪条举报**发生的：%s", rows[0].Detail)
	}
	if rows[0].Reason != m6TakenReason || rows[1].Reason != m6TakenReason {
		t.Errorf("两行留痕的 reason 应该是同一句原文，实际 %q / %q", rows[0].Reason, rows[1].Reason)
	}
	if rd := mustDetail(t, rows[1].Detail); rd.ReportID != st.repX1 || len(rd.AlsoClosed) != 1 ||
		rd.AlsoClosed[0] != st.repX2 {
		t.Errorf("report_resolved 那行的 detail 不对：%s", rows[1].Detail)
	}

	// ⑥ 换一种 resolution 再处置同一条（已经 resolved）→ 报错，且不重复下架。
	//    这里刻意试的是 ban：如果实现只判「是不是同一个 resolution」而没判 status，
	//    第二次会把作者也封了，而帖子的 deleted 会被写第二遍留痕。
	again := resolveAs(t, st, st.repX1, m6ResolveBody(model.ReportResolutionBan, m6BanReason, ""))
	RequireCode(t, again, apperr.CodeReportAlreadyResolved)
	assertCount(t, "admin_actions", 2)
	if n := harness.Count(t, `SELECT count(*) FROM notifications`); n != 3 {
		t.Errorf("重复处置又发了通知，全局期望仍 3 条（作者 1 + 举报人 2），实际 %d", n)
	}
	if s := harness.QueryRow(t, `SELECT status FROM users WHERE id = $1`, st.author.UserID)["status"]; s != "active" {
		t.Errorf("一条已经处置过的举报被拿去 ban，作者竟然被封了（status=%v）", s)
	}
}

// ---------- 判据 ③：ban ----------

// TestM6ResolveBanFreezesAuthorNotContent 证的是 ban 分支的两条边界。
//
// 一是**作用对象**：封的是那条帖子的作者，不是举报里写的人、也不是同一次动作里
// 出现的其它人。夹具里 itemY 的作者 other 和 r1/r2 都在同一批数据里活着，
// 处置完之后只有 author 一个人变 banned —— 这个「别人都没变」是 OwnerTx
// 那一步（从 resolved.ItemID 反查作者）唯一的证明方式。
//
// 二是**封号不删内容**：§2 那条「平台只记录事实」延伸到这里 ——
// 账号被冻住是他作恶的后果，但那几条帖子可能正有人等着认领，
// 把它们一起抹掉会惩罚到第三方。所以 itemX 必须还在广场上。
func TestM6ResolveBanFreezesAuthorNotContent(t *testing.T) {
	st := setupResolve(t)
	r := resolveAs(t, st, st.repX1, m6ResolveBody(model.ReportResolutionBan, m6BanReason, ""))
	RequireOK(t, r, "ban 那条举报")

	// ① 库里：作者 banned，帖子仍 open 且仍在广场。
	if s := harness.QueryRow(t, `SELECT status FROM users WHERE id = $1`, st.author.UserID)["status"]; s != "banned" {
		t.Errorf("作者应该被这次处置封禁，实际 status=%v", s)
	}
	if itemStatusOf(t, st.itemX.ID) != "open" {
		t.Errorf("ban 把帖子也改了（%s）—— 封账号不该顺手删掉可能有人等着认领的内容", itemStatusOf(t, st.itemX.ID))
	}
	if p := fetchSquare(t, "page_size=100", ""); !containsID(idsOf(p), st.itemX.ID) {
		t.Errorf("ban 之后那条帖子从广场消失了：%v", idsOf(p))
	}
	// 无关的人一个都没被牵连（正向对照：他们仨的 status 都还是 active）。
	for _, who := range []Session{st.other, st.r1, st.r2, st.admin} {
		if s := harness.QueryRow(t, `SELECT status FROM users WHERE id = $1`, who.UserID)["status"]; s != "active" {
			t.Errorf("%s 不该被这次处置碰到，实际 status=%v", who.Username, s)
		}
	}

	// ② 封禁立刻生效，用的还是他手里那个未过期的 token。
	//    role/status 不在 JWT 载荷里（§7），所以「下一次请求重新读用户行」就是生效点。
	RequireCode(t, harness.Get(t, "/api/my/notifications", st.author.Token), apperr.CodeUserBanned)
	RequireCode(t, harness.Post(t, "/api/auth/login",
		map[string]any{"username": st.author.Username, "password": reportPassword()}, ""),
		apperr.CodeUserBanned)

	// ③ 通知：作者 1 条 admin_action（含封禁措辞 + 理由原文），举报人 1 条回执（含「已封禁」）。
	an := findByType(t, notificationsOf(t, st.author.UserID), model.NotificationAdminAction)
	if !strings.Contains(an.Content, "封禁") || !strings.Contains(an.Content, m6BanReason) {
		t.Errorf("作者的封禁通知少了措辞或理由原文：%s", truncate(an.Content))
	}
	// 封禁那条通知**不挂 item**：封的是账号，不是某一条内容。
	// 断言它的 item_id 是 NULL，而不是「随便挂一条」—— 前端据此决定点不点开帖子详情。
	if an.ItemID != nil {
		t.Errorf("封账号的通知挂在了帖子 %v 上，点开会让人以为是一条帖子的问题", an.ItemID)
	}
	rn := findByType(t, notificationsOf(t, st.r1.UserID), model.NotificationReportResolved)
	if !strings.Contains(rn.Content, "已封禁发布该内容的账号") {
		t.Errorf("举报人的回执结论不对：%s", truncate(rn.Content))
	}

	// ④ 留痕 2 行：user_ban（指向人）+ report_resolved（指向举报）。
	rows := adminActionsOf(t, st.admin.UserID)
	if len(rows) != 2 {
		t.Fatalf("ban 期望 2 行留痕，实际 %d：%v", len(rows), m6ActionsBrief(rows))
	}
	if rows[0].Action != model.ActionUserBan || rows[0].TargetType != model.TargetUser ||
		rows[0].TargetID != st.author.UserID {
		t.Errorf("第一行应该是 user_ban/user/%d，实际 %s/%s/%d",
			st.author.UserID, rows[0].Action, rows[0].TargetType, rows[0].TargetID)
	}
	bd := mustDetail(t, rows[0].Detail)
	if bd.Status != "banned" || bd.ReportID != st.repX1 || bd.ItemID != st.itemX.ID {
		t.Errorf("user_ban 的 detail 应该同时说清 status/report_id/item_id：%s", rows[0].Detail)
	}
	if rows[1].Action != model.ActionReportResolved || rows[1].TargetID != st.repX1 {
		t.Errorf("第二行应该是 report_resolved/report/%d，实际 %s/%d", st.repX1, rows[1].Action, rows[1].TargetID)
	}

	// ⑤ 重复处置：报错，封禁状态不再变一遍、留痕不多一行。
	RequireCode(t, resolveAs(t, st, st.repX1,
		m6ResolveBody(model.ReportResolutionBan, m6BanReason, "")), apperr.CodeReportAlreadyResolved)
	assertCount(t, "admin_actions", 2)
}
