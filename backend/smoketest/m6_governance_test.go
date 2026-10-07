// 这一份是计划 §12 M6 判据那四条的第②层版本：
//
//	① 50 条 spam 被下架后广场看不见；
//	② 每个作者恰好收到 **1** 条 admin_action 通知，且 content 里带着 reason 原文；
//	③ admin_actions 恰好 1 行，detail.ids 的长度是 50；
//	④ 不带 reason → VALIDATION，并且帖子一条都没被删。
//
// 为什么这四条非要在真库上跑（第①层那张表已经把每个动作的留痕形状测过了）：
//   - 「广场看不见」是 items.status 那一列 + 列表 SQL 的 WHERE 一起决定的，
//     fake 只能证明 service 调了 TakedownTx，证不了那 50 行真的变了、也证不了
//     列表那条 SQL 真的把它们排除了。
//   - 「恰好 1 条通知」是 §3.7 那条合并规则**唯一有意义的场合**：50 条帖子 2 个作者
//     出 2 条通知。第①层用它测的是分组算法，而真库测的是那条 INSERT 真的只发了两行。
//   - detail.ids 长度 50 是 JSONB 列的形状，第①层只能验到 map，
//     而「序列化之后是不是一个数组」这件事只有 PostgreSQL 能回答。
//   - 判据 ④ 测的是「校验发生在 BeginTx 之前」—— 那需要真的有一条事务，
//     回滚这件事在 fake 里是一个数字（begins==0），在真库里是一句 SELECT count(*)。
package smoketest

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"lostfound/internal/apperr"
	"lostfound/internal/model"
)

// spamReason 是一次下架的理由。它必须**原样**出现在作者收到的那条通知里（§3.7）。
const spamReason = "批量发布代办证书广告，刷屏"

// m6ReasonMaxChars 镜像两处上限：admin_actions.reason 的 VARCHAR(500)，
// 和 service 里那个未导出的 maxReasonLen。
//
// 测试里重复这个数字是有意的：契约（列宽）属于产品，而「超长的请求必须被挡成
// VALIDATION 而不是 22001」属于要被测的行为。把它写成 500+1 而不是引用一个内部常量，
// 将来有人放宽列宽时这条会红 —— 那正是我们想要的一次提醒，而不是一次静默的过期。
const m6ReasonMaxChars = 500

// spamAuthor 是一位 spam 发帖人 + 他名下那批帖子的 id。
type spamAuthor struct {
	session Session
	ids     []int64
}

// spamStage 是 50 条 spam 帖的舞台：两位作者，各 25 条。
//
// 为什么是两个作者而不是一个：判据 ② 说的是「每个作者恰好 1 条」。只有一个作者时，
// 「一条都没发」和「只发了 1 条」这两种实现都能通过；两个作者才把**合并的分组键**
// 测出来 —— 按人分组是对的（2 条），按帖子分组是错的（50 条），
// 而全都塞进一个人也测不出分组写错了。
//
// 为什么帖子全是 found：匹配只在 found 落库时去扫 lost 候选（§3.3 的不对称）。
// 舞台上一条 lost 帖都没有，于是这 50 次创建**一次候选都扫不到**，
// 不会留下台账、也不会给谁发 new_match —— 下面那些「通知恰好 1 条」的断言
// 才有一个干净的基线，而不是得先从一堆匹配通知里把人挑出来。
type spamStage struct {
	admin     Session
	bystander Session // 一个没被牵连的普通用户，用来证明通知没有发错人
	spammers  []spamAuthor
}

func setupSpam(t *testing.T) spamStage {
	t.Helper()
	harness.TruncateAll(t)

	st := spamStage{
		admin:     harness.MakeAdmin(t, harness.RegisterAndLogin(t, "m6spam-admin", m5Password)),
		bystander: harness.RegisterAndLogin(t, "m6spam-bystander", m5Password),
	}

	const perAuthor = 25
	for i := 0; i < 2; i++ {
		s := harness.RegisterAndLogin(t, fmt.Sprintf("m6spam-%d", i), m5Password)
		author := spamAuthor{session: s}
		for j := 0; j < perAuthor; j++ {
			it := createItem(t, s, foundBody(fmt.Sprintf("低价代办各类证书 %02d%02d", i, j), "13800000000"))
			author.ids = append(author.ids, it.ID)
		}
		st.spammers = append(st.spammers, author)
	}

	// 夹具自证：判据 ① 断言的是「50 条从广场上消失了」，
	// 所以必须先证明它们**曾经**在广场上。少了这一段，
	// 「创建 50 条」因为某个夹具错误而变成「创建了 0 条」时，
	// 判据 ① 会以一种非常令人满意的方式通过 —— 而实际上什么都没测。
	if got := harness.Count(t, `SELECT count(*) FROM items`); got != 50 {
		t.Fatalf("夹具期望 50 条帖子，实际 %d 条", got)
	}
	if got := harness.Count(t, `SELECT count(*) FROM items WHERE status = 'open'`); got != 50 {
		t.Fatalf("夹具期望 50 条都是 open，实际 %d 条", got)
	}
	if p := fetchSquare(t, "page_size=100", ""); p.Total != 50 {
		t.Fatalf("夹具期望广场有 50 条，实际 %d 条 —— 判据① 的「消失」需要一个先存在的基线", p.Total)
	}
	if got := harness.Count(t, `SELECT count(*) FROM admin_actions`); got != 0 {
		t.Fatalf("夹具期望后台台账是空的，实际 %d 行", got)
	}
	return st
}

func allIDs(st spamStage) []int64 {
	var out []int64
	for _, a := range st.spammers {
		out = append(out, a.ids...)
	}
	return out
}

// TestM6BatchTakedownChain 是 M6 的主判据（①②③ 三条在同一条测试里，
// 因为它们描述的是**同一次请求**的三个后果，拆开就测不到「同生同死」）。
func TestM6BatchTakedownChain(t *testing.T) {
	st := setupSpam(t)
	ids := allIDs(st)

	r := harness.Post(t, "/api/admin/items/takedown",
		map[string]any{"ids": ids, "reason": spamReason}, st.admin.Token)
	RequireOK(t, r, "批量下架 50 条 spam")

	var res TakedownResultView
	r.DataInto(t, &res)
	if res.TakenDown != 50 {
		t.Errorf("taken_down=%d，期望 50", res.TakenDown)
	}
	if res.NotifiedUsers != 2 {
		t.Errorf("notified_users=%d，期望 2（两个作者各一条合并通知，不是 50 条）", res.NotifiedUsers)
	}

	// ---- 判据 ①：库里那 50 行成了 deleted，而广场看不见它们 ----
	if got := harness.Count(t, `SELECT count(*) FROM items WHERE status = 'deleted'`); got != 50 {
		t.Errorf("items 里 status=deleted 的有 %d 行，期望 50", got)
	}
	if got := harness.Count(t, `SELECT count(*) FROM items WHERE status = 'open'`); got != 0 {
		t.Errorf("还剩下 %d 行 open，批量下架没有改完那 50 行", got)
	}
	// 广场（默认只看 open）必须一条都不给，匿名和登录两种都查：
	// 列表那条 SQL 的 WHERE 对两种身份走的是不同分支（本人能看见自己的 deleted 是 M2 的规矩，
	// 它长在 /api/items/mine 上，不是长在广场上）。
	for _, q := range []string{"", "status=open", "page_size=100"} {
		p := fetchSquare(t, q, "")
		if p.Total != 0 {
			t.Errorf("广场（query=%q）还有 %d 条，期望 0 条", q, p.Total)
		}
	}
	if p := fetchSquare(t, "page_size=100", st.bystander.Token); len(p.List) != 0 {
		t.Errorf("普通登录用户在广场上看见 %d 条，期望 0 条", len(p.List))
	}
	// 反过来，作者自己在 #19 里还能看见自己那 25 条，并且状态是 deleted（M2 §4 的可见性）。
	// 少了这一段，「广场清空」就可能只是「列表接口坏了」。
	for _, a := range st.spammers {
		mine := fetchMine(t, "status=deleted&page_size=100", a.session)
		if mine.Total != 25 {
			t.Errorf("%s 的 #19 status=deleted 有 %d 条，期望 25 条（软删对外不存在，对本人必须还在）",
				a.session.Username, mine.Total)
		}
	}

	// ---- 判据 ②：每个作者恰好 1 条 admin_action，content 带 reason 原文 ----
	for _, a := range st.spammers {
		ns := notificationsOf(t, a.session.UserID)
		if got := findByTypeCount(t, ns, model.NotificationAdminAction); got != 1 {
			t.Fatalf("%s 收到 %d 条 admin_action，期望恰好 1 条（§3.7 合并规则）"+
				"—— 全部通知类型：%v", a.session.Username, got, typesOf(ns))
		}
		n := findByType(t, ns, model.NotificationAdminAction)
		if n.Type != model.NotificationAdminAction {
			t.Errorf("类型成了 %q", n.Type)
		}
		if !strings.Contains(n.Content, spamReason) {
			t.Errorf("通知里没有那句理由的**原文**：%q", n.Content)
		}
		if !strings.Contains(n.Content, "25") {
			t.Errorf("合并通知该说明是几条帖子，content=%q", n.Content)
		}
		// 批量那种 item_id 必须是 NULL：50 条挂哪一条都是错的（见 takedownNotices 那段注释）。
		if n.ItemID != nil {
			t.Errorf("批量下架的通知挂了 item_id=%d，N>1 时应当留 NULL", *n.ItemID)
		}
	}
	// 通知总数 = 2：既没有多发给第三方，也没有重复发。
	if got := harness.Count(t, `SELECT count(*) FROM notifications WHERE type = 'admin_action'`); got != 2 {
		t.Errorf("全库 admin_action 通知 %d 条，期望 2 条（两个作者各一条）", got)
	}
	if ns := notificationsOf(t, st.bystander.UserID); len(ns) != 0 {
		t.Errorf("和一个帖子都没关系的旁观者收到了 %d 条通知：%v", len(ns), typesOf(ns))
	}

	// ---- 判据 ③：台账恰好 1 行，detail.ids 是 50 个 ----
	if got := harness.Count(t, `SELECT count(*) FROM admin_actions`); got != 1 {
		t.Fatalf("admin_actions 有 %d 行，期望恰好 1 行（一次批量动作 = 一行，不是五十行）", got)
	}
	// 那一行台账读回来的每一列都要**显式定类型**（::bigint / ::text），
	// 理由和 returnRow 那条一样：QueryRow 返回的是 map[string]any，
	// 而 pgx 会把 jsonb_array_length 的 int4 扫成 int32 —— 断言写 .(int64) 时
	// panic 的报错只会说「interface conversion」，完全看不出「只是 SQL 少写了一次转型」。
	row := harness.QueryRow(t, `SELECT admin_id, action, target_type, target_id, reason,
	                              jsonb_array_length(detail -> 'ids')::bigint AS ids_len,
	                              detail ->> 'count' AS cnt,
	                              (detail ? 'report_id') AS has_report_key
	                       FROM admin_actions ORDER BY id DESC LIMIT 1`)
	if row["action"] != model.ActionItemTakedown {
		t.Errorf("action=%v", row["action"])
	}
	if row["target_type"] != model.TargetItem {
		t.Errorf("target_type=%v", row["target_type"])
	}
	if row["reason"] != spamReason {
		t.Errorf("reason=%q，台账里存的必须是原文", row["reason"])
	}
	if row["admin_id"].(int64) != st.admin.UserID {
		t.Errorf("admin_id=%v，期望 %d —— 留痕挂在**这次请求的 token 那个人**身上，不是 body 里传的",
			row["admin_id"], st.admin.UserID)
	}
	// target_id 是批量约定里的那个「第一个 id」，完整列表在 detail.ids。
	if row["target_id"].(int64) != ids[0] {
		t.Errorf("target_id=%v，期望批量动作存第一个 id %d（迁移注释里定下的约定）",
			row["target_id"], ids[0])
	}
	if row["ids_len"].(int64) != 50 {
		t.Errorf("detail->'ids' 的长度是 %v，期望 50", row["ids_len"])
	}
	if row["cnt"] != "50" {
		t.Errorf("detail->>'count' = %v，期望 \"50\"", row["cnt"])
	}
	// 纯批量下架不该带 report_id（那是 #49 的连带分支才有的键）。
	// 这一条盯的是 RecordBatch 那句「extra 先写、ids/count 后写」的顺序：
	// 反过来的话调用方传的 extra 能覆盖掉 ids，而那正是 §13 核对 SQL 要数的那一列。
	if row["has_report_key"] == true {
		t.Errorf("一次纯批量下架的 detail 里出现了 report_id 键：%v", row)
	}

	// ---- 那 50 条帖子还在（软删），而归还/举报那些外键引用不会因为下架而消失 ----
	// 这里只查一个数字，完整含义在 M2 的 TestM2DeleteIsSoft 里钉着：
	// 治理动作**销毁的是可见性**，不是历史。
	if got := harness.Count(t, `SELECT count(*) FROM items`); got != 50 {
		t.Errorf("items 表一共 %d 行，期望 50 行（软删不删行）", got)
	}
}

// TestM6TakedownWithoutReasonChangesNothing 是判据 ④。
//
// 它测的不是「少传一个字段会不会报错」—— 那太容易通过了。它测的是**顺序**：
// requireReason 必须跑在 BeginTx 之前。如果实现是「先开事务、改完 50 行、
// 写留痕时才发现理由空」，那得到 VALIDATION 的同时会留下一次回滚，
// 而回滚在真库上是一个可能失败的步骤（连接断了就真的留下了半批帖子）。
// 所以这里断言的是**副作用为零**：状态、台账、通知一个都没动。
func TestM6TakedownWithoutReasonChangesNothing(t *testing.T) {
	st := setupSpam(t)
	ids := allIDs(st)

	bodies := []struct {
		name      string
		body      map[string]any
		wantField string
	}{
		{"完全没有 reason 这个键", map[string]any{"ids": ids}, "reason"},
		{"reason 是空串", map[string]any{"ids": ids, "reason": ""}, "reason"},
		{"reason 只有空格", map[string]any{"ids": ids, "reason": "   "}, "reason"},
		{"reason 是全角空格", map[string]any{"ids": ids, "reason": "　"}, "reason"},
		{"reason 超过 500 个字",
			map[string]any{"ids": ids, "reason": strings.Repeat("长", m6ReasonMaxChars+1)}, "reason"},
		{"ids 是空数组（另一种什么都没提交）",
			map[string]any{"ids": []int64{}, "reason": spamReason}, "ids"},
		{"ids 这个键整个没给", map[string]any{"reason": spamReason}, "ids"},
		// reason 和 ids 都没给：期望报的是 reason。
		// 这一条盯的就是**顺序**本身 —— TakedownItems 第一行是 requireReason，
		// 第二行才是 normalizeIDs。反过来的话两个键都缺的请求会先报 ids，
		// 而那个请求真正的问题是「没说为什么」，管理员补了 ids 还是过不了。
		{"两个键都没给", map[string]any{}, "reason"},
	}

	for _, c := range bodies {
		t.Run(c.name, func(t *testing.T) {
			r := harness.Post(t, "/api/admin/items/takedown", c.body, st.admin.Token)
			RequireCode(t, r, apperr.CodeValidation)
			// 报得出**是哪个字段**才算能用：后台那个表单要红框标到具体一格。
			requireField(t, r, c.wantField)

			if got := harness.Count(t, `SELECT count(*) FROM items WHERE status = 'open'`); got != 50 {
				t.Errorf("被拒的请求之后还有 %d 行 open，期望 50 行（一条都不该被动）", got)
			}
			if got := harness.Count(t, `SELECT count(*) FROM admin_actions`); got != 0 {
				t.Errorf("被拒的请求写了 %d 行台账，期望 0 行", got)
			}
			if got := harness.Count(t, `SELECT count(*) FROM notifications`); got != 0 {
				t.Errorf("被拒的请求发了 %d 条通知，期望 0 条", got)
			}
		})
	}
}

// TestM6RepeatTakedownIsANotifiedNoOpButStillLogged 钉住 takedownInTx 里
// 那个 `len(rows) == 0` 分支。
//
// 它是真实运营里一定会发生的一幕：管理员刷新了页面、或者两个人同时在看同一批待办。
// 三种实现都可能，而只有一种是对的：
//   - 「再发一遍通知」= 对同一个人二次骚扰（§3.7 反对的那件事）；
//   - 「报错」= 管理员以为后台坏了，而实际上什么都没发生；
//   - 「静默什么都不写」= 有人点了一次下架而台账上查不到 —— 追责链断在这里。
//
// 正确的形状是：**taken_down=0、零通知、台账照写一行**。
// 只有真库能测这一条，因为它依赖第一次下架真的把那 50 行改成了 deleted。
func TestM6RepeatTakedownIsANotifiedNoOpButStillLogged(t *testing.T) {
	st := setupSpam(t)
	ids := allIDs(st)

	first := harness.Post(t, "/api/admin/items/takedown",
		map[string]any{"ids": ids, "reason": spamReason}, st.admin.Token)
	RequireOK(t, first, "第一次下架")

	second := harness.Post(t, "/api/admin/items/takedown",
		map[string]any{"ids": ids, "reason": spamReason}, st.admin.Token)
	RequireOK(t, second, "对同一批再点一次不该报错")
	var res TakedownResultView
	second.DataInto(t, &res)
	if res.TakenDown != 0 {
		t.Errorf("第二次的 taken_down=%d，期望 0（那 50 行早就是 deleted 了）", res.TakenDown)
	}
	if res.NotifiedUsers != 0 {
		t.Errorf("第二次的 notified_users=%d，期望 0 —— 同一个作者不该被同一件事骚扰两次", res.NotifiedUsers)
	}

	if got := harness.Count(t, `SELECT count(*) FROM notifications WHERE type = 'admin_action'`); got != 2 {
		t.Errorf("admin_action 通知现在有 %d 条，期望还是 2 条", got)
	}
	// 台账变成 2 行：一次动作一行，「点了但没改动任何帖子」这件事也要能被追责。
	if got := harness.Count(t, `SELECT count(*) FROM admin_actions`); got != 2 {
		t.Errorf("admin_actions 有 %d 行，期望 2 行（第二次也要留痕）", got)
	}
}

// ---------- #50 操作日志页：把上面写进库的那一行读回来 ----------

// TestM6ActionLogReadBack 是 #50 的第②层测试。
//
// 第①层测的是「每条写路径都调了 Record」，而这一层测的是**读**：
// detail 那一格必须以 JSON 对象（不是字符串）出现在响应里，四个筛选参数必须真的
// 落在 SQL 的 WHERE 上，而 JOIN 出来的 admin 是那个做了动作的人。
// 这三件事都只有真库 + 真 SQL 能证 —— 尤其是第一条，
// 把 detail 当成 TEXT 原样吐回字符串在前端要 JSON.parse 一遍才能用，
// 而那正是 AdminActionView 用 json.RawMessage 要防的事。
func TestM6ActionLogReadBack(t *testing.T) {
	st := setupSpam(t)
	ids := allIDs(st)

	RequireOK(t, harness.Post(t, "/api/admin/items/takedown",
		map[string]any{"ids": ids, "reason": spamReason}, st.admin.Token), "下架")
	// 再写一条形状不同的动作（#47 警告），让筛选参数有东西可以筛掉。
	victim := st.spammers[0].session
	RequireOK(t, harness.Post(t, "/api/admin/users/"+itoa(victim.UserID)+"/warn",
		map[string]any{"reason": "请勿发布广告内容"}, st.admin.Token), "警告")

	// ① 不带任何筛选：两行都在，而且倒序（最新的在前）。
	all := fetchActions(t, "", st.admin)
	if all.Total != 2 {
		t.Fatalf("#50 不带筛选期望 2 行，实际 %d 行", all.Total)
	}
	if all.List[0].Action != model.ActionWarningSent {
		t.Errorf("第一行是 %q，期望最新的那条（warning_sent）—— #50 是待办页，倒序才有人看",
			all.List[0].Action)
	}
	if all.List[1].Action != model.ActionItemTakedown {
		t.Errorf("第二行是 %q，期望 item_takedown", all.List[1].Action)
	}

	// ② 那行批量下架的 detail 必须是**对象**，里面 ids 数组长度 50。
	var takedown *actionView
	for i := range all.List {
		if all.List[i].Action == model.ActionItemTakedown {
			takedown = &all.List[i]
		}
	}
	if takedown == nil {
		t.Fatal("遍历两行没找到 item_takedown")
	}
	if len(takedown.Detail) == 0 || takedown.Detail[0] != '{' {
		t.Errorf("detail 原样是 %s，期望一个 JSON 对象（不是字符串、不是 null）", string(takedown.Detail))
	}
	var detail struct {
		IDs   []int64 `json:"ids"`
		Count int     `json:"count"`
	}
	if err := json.Unmarshal(takedown.Detail, &detail); err != nil {
		t.Fatalf("detail 解不开成 {ids,count}：%v（原文 %s）", err, string(takedown.Detail))
	}
	if len(detail.IDs) != 50 || detail.Count != 50 {
		t.Errorf("detail 里 ids=%d 个、count=%d，期望都是 50", len(detail.IDs), detail.Count)
	}
	if takedown.Reason != spamReason {
		t.Errorf("reason 读回来成了 %q", takedown.Reason)
	}
	if takedown.Admin == nil || takedown.Admin.ID != st.admin.UserID {
		t.Errorf("admin 那一格是 %+v，期望 {id:%d,...}", takedown.Admin, st.admin.UserID)
	}

	// ③ 四个筛选参数逐个生效。每个都断言「筛掉了另一条」，
	//    否则一条把 WHERE 整个忽略的实现也能全绿。
	for _, q := range []string{
		"action=" + model.ActionItemTakedown,
		"target_type=" + model.TargetItem,
		"target_id=" + itoa(ids[0]),
		"action=" + model.ActionItemTakedown + "&target_type=" + model.TargetItem,
	} {
		p := fetchActions(t, q, st.admin)
		if p.Total != 1 || p.List[0].Action != model.ActionItemTakedown {
			t.Errorf("按 %q 筛期望恰好 1 行 item_takedown，实际 %d 行", q, p.Total)
		}
	}
	for _, q := range []string{
		"action=" + model.ActionWarningSent,
		"target_type=" + model.TargetUser,
		"target_id=" + itoa(victim.UserID),
	} {
		p := fetchActions(t, q, st.admin)
		if p.Total != 1 || p.List[0].Action != model.ActionWarningSent {
			t.Errorf("按 %q 筛期望恰好 1 行 warning_sent，实际 %d 行", q, p.Total)
		}
	}
	// admin_id 单独筛的是「这个人做过的全部事」，两行都是他做的，所以是 2 行。
	// 它真正的验收点是另一半：换一个 id 就必须是 0 行 ——
	// 那一格决定的是「哪个 admin 被追责」，筛错人的日志页等于没有。
	if p := fetchActions(t, "admin_id="+itoa(st.admin.UserID), st.admin); p.Total != 2 {
		t.Errorf("按 admin_id 筛期望 2 行（下架 + 警告都是他做的），实际 %d 行", p.Total)
	}
	if p := fetchActions(t, "admin_id="+itoa(st.bystander.UserID), st.admin); p.Total != 0 {
		t.Errorf("按一个什么都没做的用户的 id 筛出了 %d 行，期望 0 行", p.Total)
	}
	// 一个合法但没用过的筛选值：必须是 0 行，不能是「忽略筛选返回全部」。
	if p := fetchActions(t, "action="+model.ActionDictCreate, st.admin); p.Total != 0 {
		t.Errorf("按没用过的 action=dict_create 筛出了 %d 行，期望 0 行", p.Total)
	}

	// ④ 表外的筛选值必须 VALIDATION（而不是当成「没筛选」返回全表）。
	//    §10 那句「看起来 work 的 bug 最难查」在这里的落点。
	for _, q := range []string{"action=item_takdown", "target_type=posts", "admin_id=abc", "target_id=0"} {
		RequireCode(t, harness.Get(t, "/api/admin/actions?"+q, st.admin.Token), apperr.CodeValidation)
	}
}

// TestM6StatsCountsTheGovernanceResult 用 #37 复核一次治理结果。
//
// 这一条的价值不在统计本身（那几个 count 是纯 SQL），而在**它和 #43 用的是同一张表**：
// 下架之后 items_count.deleted 应当等于 50、open 应当等于 0、
// admin_actions_count 应当等于台账行数。三个数字来自三条 SQL，
// 而它们必须互相自洽 —— 任何一处状态列写错，这里就会对不上。
func TestM6StatsCountsTheGovernanceResult(t *testing.T) {
	st := setupSpam(t)
	ids := allIDs(st)

	RequireOK(t, harness.Post(t, "/api/admin/items/takedown",
		map[string]any{"ids": ids, "reason": spamReason}, st.admin.Token), "下架")

	r := harness.Get(t, "/api/admin/stats", st.admin.Token)
	RequireOK(t, r, "#37 统计")
	var s struct {
		ItemsCount struct {
			Lost    int `json:"lost"`
			Found   int `json:"found"`
			Open    int `json:"open"`
			Closed  int `json:"closed"`
			Deleted int `json:"deleted"`
		} `json:"items_count"`
		UsersCount struct {
			Total   int `json:"total"`
			Local   int `json:"local"`
			HDUHelp int `json:"hduhelp"`
			Banned  int `json:"banned"`
		} `json:"users_count"`
		AdminActionsCount int `json:"admin_actions_count"`
	}
	r.DataInto(t, &s)

	if s.ItemsCount.Deleted != 50 || s.ItemsCount.Open != 0 {
		t.Errorf("items_count 是 deleted=%d open=%d，期望 50 / 0", s.ItemsCount.Deleted, s.ItemsCount.Open)
	}
	if s.ItemsCount.Found != 50 || s.ItemsCount.Lost != 0 {
		t.Errorf("items_count 是 lost=%d found=%d，期望 0 / 50（夹具发的全是拾物帖）",
			s.ItemsCount.Lost, s.ItemsCount.Found)
	}
	if s.ItemsCount.Closed != 0 {
		t.Errorf("closed=%d，下架不该把帖子写成 closed（那是「已归还」的表态，只有发帖人能做）",
			s.ItemsCount.Closed)
	}
	if got := s.AdminActionsCount; got != harness.Count(t, `SELECT count(*) FROM admin_actions`) {
		t.Errorf("admin_actions_count=%d 而表里实际 %d 行 —— 统计页和台账对不上",
			got, harness.Count(t, `SELECT count(*) FROM admin_actions`))
	}
	// 人数：2 位 spam 作者 + 1 个 admin + 1 个旁观者 = 4，全是本地账号
	// （setupSpam 只走 #1/#2，一个 SSO 账号都没有，所以 hduhelp 必须是 0 ——
	//  这一格如果跟着 auth_source 的默认值走，它是这条统计里最容易写错的一个）。
	if s.UsersCount.Total != 4 || s.UsersCount.Local != 4 || s.UsersCount.HDUHelp != 0 {
		t.Errorf("users_count 是 %+v，期望 total=4 / local=4 / hduhelp=0", s.UsersCount)
	}
}

// ---------- 这一份文件用到的夹具 ----------

// TakedownResultView 是 #43 的 data 形状。
type TakedownResultView struct {
	TakenDown     int `json:"taken_down"`
	NotifiedUsers int `json:"notified_users"`
}

type actionPage struct {
	List     []actionView `json:"list"`
	Total    int          `json:"total"`
	Page     int          `json:"page"`
	PageSize int          `json:"page_size"`
}

type actionView struct {
	ID         int64           `json:"id"`
	Admin      *adminBriefView `json:"admin"`
	Action     string          `json:"action"`
	TargetType string          `json:"target_type"`
	TargetID   int64           `json:"target_id"`
	Reason     string          `json:"reason"`
	Detail     json.RawMessage `json:"detail"`
	CreatedAt  string          `json:"created_at"`
}

type adminBriefView struct {
	ID       int64  `json:"id"`
	Nickname string `json:"nickname"`
}

func fetchActions(t *testing.T, query string, admin Session) actionPage {
	t.Helper()
	path := "/api/admin/actions"
	if query != "" {
		path += "?" + query
	}
	r := harness.Get(t, path, admin.Token)
	RequireOK(t, r, "GET "+path)
	var p actionPage
	r.DataInto(t, &p)
	return p
}

// adminActionsOf 读某人做过的全部留痕（#16/#17 那两条 admin 分支要用它数增量）。
func adminActionsOf(t *testing.T, adminID int64) []adminActionRow {
	t.Helper()
	rows, err := harness.Pool.Query(context.Background(),
		`SELECT id, action, target_type, target_id, reason, detail::text AS detail
		 FROM admin_actions WHERE admin_id = $1 ORDER BY id`, adminID)
	if err != nil {
		t.Fatalf("查询留痕失败: %v", err)
	}
	defer rows.Close()

	var out []adminActionRow
	for rows.Next() {
		var r adminActionRow
		if err := rows.Scan(&r.ID, &r.Action, &r.TargetType, &r.TargetID, &r.Reason, &r.Detail); err != nil {
			t.Fatalf("扫描留痕失败: %v", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("读取留痕失败: %v", err)
	}
	return out
}

type adminActionRow struct {
	ID         int64
	Action     string
	TargetType string
	TargetID   int64
	Reason     string
	Detail     string
}
