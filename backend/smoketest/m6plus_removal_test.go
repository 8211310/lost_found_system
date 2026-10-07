// 这一份是「作者能看见自己的帖子为什么不见了」（#58）的第②层。
//
// 第①层（service/m6plus_removal_test.go）数的是**调用次数和传进去的 id 列表** ——
// 它能证明「open 的帖子一次登记簿都不扫」「整页只查一次」，但它证不了：
//
//   - **批量那一支真的接得上**。一次 #43 批量下架只写 **1 行**台账，
//     `target_id` 只是那批 id 里的第一个，剩下 49 个藏在 `detail -> 'ids'` 这个 JSONB 数组里。
//     「作者每帖都看得到理由」要求 SQL 把数组**摊平**回一行一个 id
//     （`CROSS JOIN LATERAL jsonb_array_elements_text`）。这件事在 fake 里是
//     一个返回 map 的方法，只有 PostgreSQL 能证明那个 LATERAL 写对了。
//     所以下面第一条测试断言的是**三条帖子都有理由，而且 action_id 是同一个**。
//   - `created_at` 那个时间戳从 timestamptz 一路走到 JSON 字符串，中间过了一次
//     pgx 解码和一次 formatTimeValue —— 两端都在真库上才连得起来。
//   - 恢复（#44）之后**理由跟着消失**。这不是「查不到」，是「这一行不再是 deleted，
//     所以根本不该去查」—— 只有真实的状态列能区分这两件事。
//   - 由举报触发的下架（#49），它的台账行 detail 里**同时**有 report_id、ids、count 三个键。
//     多一个键就多出「把治理内部信息带到作者面前」的风险，而作者侧的响应
//     必须和纯批量下架**一模一样**。
//
// 断言纪律照旧：只比 code 不比 message；但 removal 的**键集**要比，
// 因为「哪些字段出现在作者面前」本身就是这条功能的全部契约。
package smoketest

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"testing"
	"time"

	"lostfound/internal/apperr"
	"lostfound/internal/model"
)

const (
	m6pPassword  = "correct-horse-battery"
	m6pBatchWhy  = "同一个账号连发三条一样的代办广告"
	m6pSingleWhy = "描述里带了无关人的手机号"
	m6pSelfTitle = "拾到一张校园卡"
	m6pRestored  = "复核确认内容合规，恢复展示"
	m6pAgainWhy  = "恢复之后又发了一遍广告"
	// m6pReportWhy 刻意**不含**「举报」两个字。
	//
	// 理由原文是 admin 写的，而这一句会**逐字**出现在作者面前 —— 这是设计。
	// 所以下面那条「作者侧不许出现『举报』」的断言只能扫系统自己写的话：
	// 如果我在这里把「举报」写进理由，那这条断言测的就是我的措辞而不是行为了。
	m6pReportWhy = "核实为刷屏广告，同一条文案连发了五条"
)

// ---------- 原始形状 ----------

// m6pRemoval 是 removal 那个键的完整形状。
//
// 刻意**不用** model.RemovalView 来解：测试要能发现「多了一个字段」。
// 用产品自己的结构体解码，多余字段会被 json 静默丢掉，
// 于是「把 admin_id 也塞进 removal」这种破坏第②层就看不见。
type m6pRemoval struct {
	ActionID  int64  `json:"action_id"`
	Reason    string `json:"reason"`
	CreatedAt string `json:"created_at"`
}

// m6pNode 是「一条帖子」里本文件关心的那三个字段，#15 的 data 和 #19 的 list 元素都能用它解。
type m6pNode struct {
	ID      int64           `json:"id"`
	Status  string          `json:"status"`
	Removal json.RawMessage `json:"removal"`
}

type m6pPage struct {
	List  []m6pNode `json:"list"`
	Total int       `json:"total"`
}

// m6pDecode 把一段原始 JSON 解成 T，失败时把原文打出来。
func m6pDecode[T any](t *testing.T, raw json.RawMessage, what string) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("解析 %s 失败: %v\n原文: %s", what, err, truncate(string(raw)))
	}
	return v
}

// m6pParseRemoval 解 removal 的值。键不存在返回 nil。
//
// 「值是 null」单独报一次错：契约是**键不存在**（omitempty），不是键在而值为 null。
// 这两者在 Go 里都是 nil，在前端却是两种判断 —— `data.removal` 为 null 时
// `if (data.removal)` 恰好也为假，所以一个「改成输出 null」的实现能活到前端渲染
// 那一句 `data.removal.reason` 才炸。宁可在这里红一次。
func m6pParseRemoval(t *testing.T, raw json.RawMessage, where string) *m6pRemoval {
	t.Helper()
	if len(raw) == 0 {
		return nil
	}
	if string(raw) == "null" {
		t.Errorf("%s：removal 这个键在，但值是 null —— 契约是「没有理由时这个键整个不出现」", where)
		return nil
	}
	r := m6pDecode[m6pRemoval](t, raw, where+" 的 removal")
	return &r
}

// m6pWantRemoval 断言「这里必须有一句理由」并把它交出来。
func m6pWantRemoval(t *testing.T, raw json.RawMessage, where string) m6pRemoval {
	t.Helper()
	r := m6pParseRemoval(t, raw, where)
	if r == nil {
		t.Fatalf("%s：期望带 removal（作者应当知道为什么不见了），实际这个键不存在", where)
	}
	return *r
}

// m6pWantNoRemoval 断言「这里不该有理由」。
func m6pWantNoRemoval(t *testing.T, raw json.RawMessage, where string) {
	t.Helper()
	if len(raw) != 0 {
		t.Errorf("%s：不该出现 removal，实际是 %s", where, string(raw))
	}
}

// m6pKeys 返回 removal 对象的键名（排序后）。
//
// 用它而不是逐个断言字段，是因为要防的方向是「多一个」而不是「少一个」：
// 少一个字段第①层的 JSON 形状测试就红了，而那一步已经钉过完整字段清单。
func m6pKeys(t *testing.T, raw json.RawMessage) []string {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("removal 不是一个 JSON 对象：%s", string(raw))
	}
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func m6pWantKeys(t *testing.T, raw json.RawMessage, where string) {
	t.Helper()
	const want = "action_id,created_at,reason"
	if got := strings.Join(m6pKeys(t, raw), ","); got != want {
		t.Errorf("%s：removal 的键是 [%s]，期望恰好 [%s]（多一个就是多泄露一个治理内部字段）",
			where, got, want)
	}
}

// ---------- 取数夹具 ----------

// m6pDetailRaw 走 #15 并把 data 原样带回来（既要解形状，也要扫泄露）。
func m6pDetailRaw(t *testing.T, id int64, token string) Response {
	t.Helper()
	return harness.Get(t, "/api/items/"+itoa(id), token)
}

func m6pMineRaw(t *testing.T, query string, s Session) Response {
	t.Helper()
	path := "/api/my/items"
	if query != "" {
		path += "?" + query
	}
	r := harness.Get(t, path, s.Token)
	RequireOK(t, r, "GET "+path)
	return r
}

func m6pMine(t *testing.T, query string, s Session) m6pPage {
	t.Helper()
	return m6pDecode[m6pPage](t, m6pMineRaw(t, query, s).Data, "#19 "+query)
}

// m6pByIndex 按 id 在 #19 那一页里找到对应的那一行。
//
// 用 id 找而不是用下标找：列表默认排序是 created_at DESC，
// 「第 2 行就是第 2 条帖子」这种假设将来改排序就会静默错位 ——
// 而错位的后果正好是批量那支最容易出的事（把 ids[0] 的理由安到 ids[1] 头上）。
func m6pByIndex(t *testing.T, p m6pPage, id int64) m6pNode {
	t.Helper()
	for _, n := range p.List {
		if n.ID == id {
			return n
		}
	}
	t.Fatalf("#19 那一页里没有帖子 %d（这一页的 id：%v）", id, m6pIDs(p))
	return m6pNode{}
}

func m6pIDs(p m6pPage) []int64 {
	out := make([]int64, 0, len(p.List))
	for _, n := range p.List {
		out = append(out, n.ID)
	}
	return out
}

// m6pLedgerRow 读最近一行台账的 id 和 reason。
//
// admin_id 一律显式 ::bigint：QueryRow 给的是 map[string]any，
// pgx 把 int8 扫成 int64、把 serial(int4) 扫成 int32，
// 而少写一次转型的失败信息只有「interface conversion」。
func m6pLedgerRow(t *testing.T, action string) (int64, string) {
	t.Helper()
	row := harness.QueryRow(t,
		`SELECT id::bigint AS action_id, reason FROM admin_actions WHERE action = $1 ORDER BY id DESC LIMIT 1`,
		action)
	return row["action_id"].(int64), row["reason"].(string)
}

// m6pPosts 用同一个作者发 n 条 found 帖。
//
// 全是 found 而不是混 lost：匹配只在 found 落库时扫 lost 候选（§3.3 的不对称），
// 库里没有 lost 帖就不会产生任何台账/通知噪声，也不会有别人的帖子混进广场那一页。
func m6pPosts(t *testing.T, author Session, n int) []int64 {
	t.Helper()
	ids := make([]int64, 0, n)
	for i := 0; i < n; i++ {
		it := createItem(t, author, foundBody(fmt.Sprintf("低价代办证书 %02d", i), "13800000000"))
		ids = append(ids, it.ID)
	}
	return ids
}

func m6pStage(t *testing.T, name string) (author, admin, other Session) {
	t.Helper()
	harness.TruncateAll(t)
	author = harness.RegisterAndLogin(t, "m6p-"+name+"-author", m6pPassword)
	admin = harness.MakeAdmin(t, harness.RegisterAndLogin(t, "m6p-"+name+"-admin", m6pPassword))
	other = harness.RegisterAndLogin(t, "m6p-"+name+"-other", m6pPassword)
	return author, admin, other
}

// ---------- ①：批量下架 —— 三条都要有同一句理由 ----------

// TestM6PlusReasonReachesEveryPostInABatch 是本功能存在的理由，也是那份 SQL
// 里 `detail -> 'ids'` 那一条 UNION 支线的唯一守卫。
//
// 一次下架写 **1 行**台账，target_id 只是 ids[0]。如果实现只 JOIN target_id，
// 后果是「作者只有第一条帖子看得到理由，剩下两条无声消失」——
// 而这恰恰是运营里最常见的批量处置场景，也是最需要理由的场景。
// 所以这里断言的不只是「有 removal」，还有「三条的 action_id 相同、理由逐字相同」：
// 相同 action_id 才证明它们来自同一行台账（而不是各自被安了一句现造的话）。
func TestM6PlusReasonReachesEveryPostInABatch(t *testing.T) {
	author, admin, _ := m6pStage(t, "batch")
	ids := m6pPosts(t, author, 3)

	RequireOK(t, harness.Post(t, "/api/admin/items/takedown",
		map[string]any{"ids": ids, "reason": m6pBatchWhy}, admin.Token), "批量下架 3 条")

	// 夹具的另一半：确实只有 1 行台账，而 target_id 只是第一个 id。
	// 少了这两句，「三个 removal 的 action_id 相同」就可能只是「台账恰好只有一行」的巧合。
	if got := harness.Count(t, `SELECT count(*) FROM admin_actions`); got != 1 {
		t.Fatalf("批量下架写了 %d 行台账，期望 1 行（一次动作一行）", got)
	}
	actionID, ledgerReason := m6pLedgerRow(t, model.ActionItemTakedown)
	row := harness.QueryRow(t, `SELECT target_id::bigint AS tid FROM admin_actions`)
	if row["tid"].(int64) != ids[0] {
		t.Fatalf("target_id=%v 不是 ids[0]=%d，本测试对「另外两条只能靠 detail.ids 找回来」的前提不成立",
			row["tid"], ids[0])
	}

	page := m6pMine(t, "status=deleted&page_size=100", author)
	if page.Total != 3 {
		t.Fatalf("#19 status=deleted 期望 3 条，实际 %d 条", page.Total)
	}
	for i, id := range ids {
		n := m6pByIndex(t, page, id)
		r := m6pWantRemoval(t, n.Removal, fmt.Sprintf("#19 第 %d 条（id=%d）", i+1, id))
		if r.Reason != ledgerReason {
			t.Errorf("第 %d 条的理由是 %q，台账里是 %q（必须是原文）", i+1, r.Reason, ledgerReason)
		}
		if r.ActionID != actionID {
			t.Errorf("第 %d 条的 action_id=%d，期望 %d（同一批的同一次动作）", i+1, r.ActionID, actionID)
		}
		if ts, err := time.Parse(time.RFC3339, r.CreatedAt); err != nil {
			t.Errorf("第 %d 条的 created_at=%q 不是 RFC3339：%v", i+1, r.CreatedAt, err)
		} else if time.Since(ts) > time.Minute {
			t.Errorf("第 %d 条的 created_at=%q 离现在太久（刚下架的帖子应该是几分钟内）", i+1, r.CreatedAt)
		}
		m6pWantKeys(t, n.Removal, fmt.Sprintf("#19 第 %d 条", i+1))
	}

	// 反面对照：默认那页（open+closed）里这一条都不出现，也就一个 removal 都不该有。
	// 没有这一段，「列表接口把所有行都挂上理由」这种实现能同时通过上面的全部断言。
	def := m6pMine(t, "page_size=100", author)
	if def.Total != 0 {
		t.Errorf("#19 默认查询里出现 %d 条已下架的帖子，期望 0 条", def.Total)
	}
	for _, n := range def.List {
		m6pWantNoRemoval(t, n.Removal, "#19 默认页")
	}
}

// ---------- ②：单条下架、以及 admin 从帖子页删别人的帖子 ----------

// TestM6PlusSingleTakedownExplainsToo 覆盖两条**不是批量**的治理入口：
// #43 只传一个 id、#18 由 admin 删别人的帖子（走的是 deleteByAdmin 那条分支）。
//
// 它们和批量的区别只在于 detail 的形状（一个 id 也照样写进 ids 数组），
// 而作者看到的东西必须完全一致 —— 否则「从后台删的有解释、从帖子页删的没有」
// 这种只有用户能发现的差别就回来了。
func TestM6PlusSingleTakedownExplainsToo(t *testing.T) {
	t.Run("#43 只下架一条", func(t *testing.T) {
		author, admin, _ := m6pStage(t, "single")
		id := m6pPosts(t, author, 1)[0]

		RequireOK(t, harness.Post(t, "/api/admin/items/takedown",
			map[string]any{"ids": []int64{id}, "reason": m6pSingleWhy}, admin.Token), "下架一条")

		n := m6pByIndex(t, m6pMine(t, "status=deleted", author), id)
		if got := m6pWantRemoval(t, n.Removal, "#19 单条下架").Reason; got != m6pSingleWhy {
			t.Errorf("reason=%q，期望 %q", got, m6pSingleWhy)
		}

		d := m6pDetailRaw(t, id, author.Token)
		RequireOK(t, d, "作者读自己那条已下架的帖子")
		if got := m6pWantRemoval(t, m6pDecode[m6pNode](t, d.Data, "#15 详情").Removal, "#15 详情").Reason; got != m6pSingleWhy {
			t.Errorf("#15 的 reason=%q，期望 %q", got, m6pSingleWhy)
		}
	})

	t.Run("#18 admin 删别人的帖子", func(t *testing.T) {
		author, admin, _ := m6pStage(t, "admindel")
		id := m6pPosts(t, author, 1)[0]

		RequireOK(t, harness.Do(t, http.MethodDelete, "/api/items/"+itoa(id),
			map[string]any{"admin_reason": m6pSingleWhy}, admin.Token), "admin 删他人帖子")

		n := m6pByIndex(t, m6pMine(t, "status=deleted", author), id)
		m6pWantRemoval(t, n.Removal, "#19 admin 删的帖子")
		if itemStatusOf(t, id) != model.ItemStatusDeleted {
			t.Errorf("库里状态是 %s，期望 deleted", itemStatusOf(t, id))
		}
	})
}

// ---------- ③：恢复之后理由跟着消失 ----------

// TestM6PlusRestoreTakesTheReasonAway 钉的是「removal 跟着状态走，不跟着台账走」。
//
// 恢复之后台账里那行 item_takedown **仍然在**（治理历史不能抹掉，§12 判据 ③），
// 所以如果实现是「查一下这个人有没有被下架过」，这条测试会红 ——
// 而它红的正是我们想要的：一条已经重新公开的帖子不该还挂着「因为广告被下架过」的标签。
func TestM6PlusRestoreTakesTheReasonAway(t *testing.T) {
	author, admin, _ := m6pStage(t, "restore")
	id := m6pPosts(t, author, 1)[0]

	RequireOK(t, harness.Post(t, "/api/admin/items/takedown",
		map[string]any{"ids": []int64{id}, "reason": m6pBatchWhy}, admin.Token), "下架")
	if len(m6pWantRemoval(t, m6pByIndex(t, m6pMine(t, "status=deleted", author), id).Removal,
		"下架后的 #19").Reason) == 0 {
		t.Fatal("下架后的理由是空串")
	}

	RequireOK(t, harness.Post(t, "/api/admin/items/"+itoa(id)+"/restore",
		map[string]any{"reason": m6pRestored}, admin.Token), "#44 恢复")

	if st := itemStatusOf(t, id); st != model.ItemStatusOpen {
		t.Fatalf("恢复之后状态是 %s，期望 open", st)
	}

	// #19：帖子回到默认页（open），而且不带 removal。
	page := m6pMine(t, "page_size=100", author)
	if page.Total != 1 {
		t.Fatalf("恢复后 #19 默认页有 %d 条，期望 1 条", page.Total)
	}
	n := m6pByIndex(t, page, id)
	if n.Status != model.ItemStatusOpen {
		t.Errorf("#19 里状态是 %s，期望 open", n.Status)
	}
	m6pWantNoRemoval(t, n.Removal, "恢复后的 #19")

	// #15：同样不带。
	d := m6pDetailRaw(t, id, author.Token)
	RequireOK(t, d, "恢复后作者读 #15")
	m6pWantNoRemoval(t, m6pDecode[m6pNode](t, d.Data, "#15").Removal, "恢复后的 #15")

	// 「不带」必须是因为状态，而不是因为台账空了 —— 现在有两行：下架 + 恢复。
	if got := harness.Count(t, `SELECT count(*) FROM admin_actions`); got != 2 {
		t.Errorf("台账有 %d 行，期望 2 行（下架和恢复都留痕，历史不能被恢复动作抹掉）", got)
	}
	if got := harness.Count(t,
		`SELECT count(*) FROM admin_actions WHERE action = 'item_takedown' AND target_id = $1`, id); got != 1 {
		t.Errorf("那条下架台账不见了（%d 行）—— 那 removal 消失的原因就错了", got)
	}
}

// TestM6PlusReTakedownShowsTheNewestReason 钉 LatestTakedowns 里那个「最新」：
// 下架 → 恢复 → 再次下架（换一个理由），作者看到的必须是第二次那句。
//
// `ORDER BY h.created_at DESC, h.action_id DESC` 那两行是这个测试的全部动机。
// 只按 created_at 排的话，同一秒内发生的两次动作会并列，PostgreSQL 返回哪一行没有定义 ——
// 那正是 action_id 这个第二排序键存在的理由，所以这里造出两行台账并断言取的是 id 大的那个。
func TestM6PlusReTakedownShowsTheNewestReason(t *testing.T) {
	author, admin, _ := m6pStage(t, "again")
	id := m6pPosts(t, author, 1)[0]

	RequireOK(t, harness.Post(t, "/api/admin/items/takedown",
		map[string]any{"ids": []int64{id}, "reason": m6pBatchWhy}, admin.Token), "第一次下架")
	RequireOK(t, harness.Post(t, "/api/admin/items/"+itoa(id)+"/restore",
		map[string]any{"reason": m6pRestored}, admin.Token), "恢复")
	RequireOK(t, harness.Post(t, "/api/admin/items/takedown",
		map[string]any{"ids": []int64{id}, "reason": m6pAgainWhy}, admin.Token), "第二次下架")

	latestID, _ := m6pLedgerRow(t, model.ActionItemTakedown) // DESC LIMIT 1 → 第二次那一行
	r := m6pWantRemoval(t, m6pByIndex(t, m6pMine(t, "status=deleted", author), id).Removal, "再下架后的 #19")
	if r.Reason != m6pAgainWhy {
		t.Errorf("reason=%q，期望第二次那句 %q（第一次的是 %q 不该再顶着）", r.Reason, m6pAgainWhy, m6pBatchWhy)
	}
	if r.ActionID != latestID {
		t.Errorf("action_id=%d，期望最近那一行 %d", r.ActionID, latestID)
	}
}

// ---------- ④：帖主自己删的，没有理由可给 ----------

// TestM6PlusSelfDeleteHasNothingToExplain 是那条「查不到」和「不该查」的分界。
//
// 帖主自己 #18 删帖不写台账（他删自己的东西不需要向任何人交代），
// 所以 #19 里那一行是 deleted、而 removal 不存在。
// 少了这一条，「deleted 就填一句理由」那种实现也能通过上面所有测试
// —— 它会去查登记簿，然后要么挂一个空对象，要么挂一句编出来的话。
func TestM6PlusSelfDeleteHasNothingToExplain(t *testing.T) {
	author, _, _ := m6pStage(t, "self")
	id := createItem(t, author, foundBody(m6pSelfTitle, "13800000000")).ID

	RequireOK(t, harness.Do(t, http.MethodDelete, "/api/items/"+itoa(id), nil, author.Token), "帖主自删")

	if got := harness.Count(t, `SELECT count(*) FROM admin_actions`); got != 0 {
		t.Fatalf("帖主自删写了 %d 行台账，期望 0 行（那不是治理动作）", got)
	}

	n := m6pByIndex(t, m6pMine(t, "status=deleted", author), id)
	if n.Status != model.ItemStatusDeleted {
		t.Errorf("状态是 %s，期望 deleted", n.Status)
	}
	m6pWantNoRemoval(t, n.Removal, "自删的 #19")

	d := m6pDetailRaw(t, id, author.Token)
	RequireOK(t, d, "作者读自己删掉的帖子")
	m6pWantNoRemoval(t, m6pDecode[m6pNode](t, d.Data, "#15").Removal, "自删的 #15")
}

// ---------- ⑤：谁能看见这句理由 ----------

// TestM6PlusWhoSeesTheReason 是 2026-10-07 那个决定（「只有本人」）的验收点。
//
// 四类读者逐个跑，而且每一类都断言**两次**：一次状态码、一次 removal 的有无。
// 只断言状态码的话，「给所有人都挂上理由」是绿的；只断言 removal 的话，
// 「别人一律 403」也是绿的（403 的响应里当然没有 removal）。
//
// 特别注意 admin 那一档：他**能读**这条帖子（软删对治理者可见，M2 的规矩），
// 但**看不到** removal —— 他要的说法在 #50 那本完整登记簿里，两处都给将来必漂移。
func TestM6PlusWhoSeesTheReason(t *testing.T) {
	author, admin, other := m6pStage(t, "who")
	id := m6pPosts(t, author, 1)[0]
	RequireOK(t, harness.Post(t, "/api/admin/items/takedown",
		map[string]any{"ids": []int64{id}, "reason": m6pBatchWhy}, admin.Token), "下架")

	t.Run("本人 #15 带理由", func(t *testing.T) {
		d := m6pDetailRaw(t, id, author.Token)
		RequireOK(t, d, "本人读 #15")
		m6pWantRemoval(t, m6pDecode[m6pNode](t, d.Data, "#15").Removal, "本人的 #15")
	})

	t.Run("admin #15 能读但不带理由", func(t *testing.T) {
		d := m6pDetailRaw(t, id, admin.Token)
		RequireOK(t, d, "admin 读已下架的帖子（他必须有这个可见性，否则 #44 没法复核）")
		m6pWantNoRemoval(t, m6pDecode[m6pNode](t, d.Data, "#15").Removal, "admin 的 #15")
	})

	t.Run("别人和匿名 404", func(t *testing.T) {
		// 软删对外是「不存在」，所以连响应的 data 都必须是空的 ——
		// 没有 data，也就没有「从 404 的响应体里顺走 removal」这条路。
		for _, tok := range []string{other.Token, ""} {
			d := m6pDetailRaw(t, id, tok)
			RequireCode(t, d, apperr.CodeNotFound)
			if s := string(d.Data); s != "" && s != "null" {
				t.Errorf("404 的 data 不是空的：%s", s)
			}
		}
	})

	t.Run("admin 自己看不到别人的 removal", func(t *testing.T) {
		// #19 是按 JWT 认人的，admin 走它只能看见**自己**的帖子 ——
		// 这一条挡的是「把 admin 当成一个可以批量读别人下架理由的口子」。
		page := m6pMine(t, "status=deleted&page_size=100", admin)
		if page.Total != 0 {
			t.Errorf("admin 的 #19 里有 %d 条 deleted（含 %+v），期望 0 条 —— 那条帖子属于别人",
				page.Total, m6pIDs(page))
		}
	})

	t.Run("广场永远不带", func(t *testing.T) {
		square := fetchSquare(t, "page_size=100", "")
		if square.Total != 0 {
			t.Errorf("广场还有 %d 条，期望 0 条", square.Total)
		}
		// 作者想用 #14 的 status=deleted 把理由捞出来 → 参数级就挡掉
		// （publicListStatus 只允许 open/closed，这一条是 removal 不进公开响应的守门人）。
		RequireCode(t, harness.Get(t, "/api/items?status=deleted", author.Token), apperr.CodeValidation)
	})
}

// ---------- ⑥：由举报触发的下架 ----------

// TestM6PlusReportLinkedTakedownReason 走 #41 → #49 那条连带下架。
//
// 它值得单独一条，因为那一行台账的 detail 里**多了 report_id 和 resolution 这些键**
// （见 takedownInTx 的 detail 参数）。作者侧的响应必须和第①条测试**逐键相同**：
// 「这条帖子是被谁举报的」「有几个人举报过」一旦顺着 removal 漏出去，
// 举报人的身份就永久不安全了（风险 13）。
// 所以这里除了理由原文，还把 removal 的键集钉成恰好三个。
func TestM6PlusReportLinkedTakedownReason(t *testing.T) {
	harness.TruncateAll(t)
	author := harness.RegisterAndLogin(t, "m6p-rep-author", m6pPassword)
	reporter := harness.RegisterAndLogin(t, "m6p-rep-r1", m6pPassword)
	admin := harness.MakeAdmin(t, harness.RegisterAndLogin(t, "m6p-rep-admin", m6pPassword))

	item := createItem(t, author, foundBody("低价代办各类证书", "13800000000"))
	repID := reportCreated(t, reporter, item.ID, m6ReportBody(model.ReportReasonSpam, "连着发了五条一样"))

	RequireOK(t, harness.Post(t, resolveURL(repID),
		m6ResolveBody("takedown", m6pReportWhy, "核实为广告"), admin.Token), "#49 连带下架")

	// 夹具自证：这一行的 detail 确实比批量那行多键 —— 否则本测试什么都没测。
	row := harness.QueryRow(t, `SELECT (detail ? 'report_id') AS has_report
	                       FROM admin_actions WHERE action = 'item_takedown'`)
	if row["has_report"] != true {
		t.Fatalf("这条下架台账的 detail 里没有 report_id（%+v），本测试的前提不成立", row)
	}

	n := m6pByIndex(t, m6pMine(t, "status=deleted", author), item.ID)
	r := m6pWantRemoval(t, n.Removal, "#19（举报触发）")
	if r.Reason != m6pReportWhy {
		t.Errorf("reason=%q，期望 admin 填的那句 %q", r.Reason, m6pReportWhy)
	}
	m6pWantKeys(t, n.Removal, "#19（举报触发）")

	// 整页原始响应扫一遍：举报人相关的一切都不能在里面。
	// 举报人的显示名来自夹具本身（#1 注册不传 nickname 时回落到用户名），
	// 用变量而不是字面量，改用户名时这条保护不会静默失效。
	raw := string(m6pMineRaw(t, "status=deleted&page_size=100", author).Data)
	for _, banned := range []string{"report_id", "resolution", "reporter",
		reporter.Username, reporter.Nickname, "举报"} {
		if strings.Contains(raw, banned) {
			t.Errorf("作者侧的 #19 响应里出现了 %q —— 治理内部信息泄露了\n%s", banned, truncate(raw))
		}
	}

	// 举报人自己**不该**收到「你的举报已处置」之外的东西，而作者收到的那条也不提举报 ——
	// 这条纪律 M6 已经钉过（m6_report_resolve_test 判据 ④），这里只补一句：
	// removal 这条新路径没有把「举报」两个字带进帖子列表。
}

// ---------- ⑦：不泄露操作者 ----------

// TestM6PlusNeverNamesTheAdmin 是本功能唯一的安全断言，值得单独一条而不是塞进形状测试：
// 第①层的 JSON 形状测试是在**内存里**拼对象（不存在泄露源），
// 而这一层的数据真的来自 admin_actions 那一行，那一行里**确实存着 admin_id**。
//
// 所以这里读的是真响应，查的是「泄露得最彻底的三种写法」：
// 把整行台账原样返回（admin_id / detail）、把 JOIN 出来的管理员昵称带上（real_name / nickname / m6p-…-admin）。
func TestM6PlusNeverNamesTheAdmin(t *testing.T) {
	author, admin, _ := m6pStage(t, "leak")
	id := m6pPosts(t, author, 2)[0]
	RequireOK(t, harness.Post(t, "/api/admin/items/takedown",
		map[string]any{"ids": []int64{id}, "reason": m6pBatchWhy}, admin.Token), "下架")

	// 先证明 admin 的昵称/用户名确实长这样，否则下面的「不含它」是空的。
	if admin.Nickname == "" || admin.Username == "" {
		t.Fatalf("夹具里 admin 的显示名是空的（nickname=%q username=%q），泄露检测会变成空断言",
			admin.Nickname, admin.Username)
	}

	// 泄露的是**这次动作的操作者**，不是「任何带名字的对象」：#15 的 author 块里本来就有昵称，
	// 而那是作者自己的显示名。把 nickname 这个键也列进来，这条测试会永远红、
	// 然后被人整条删掉 —— 那才是真的失去保护。所以守的是「admin 这个人的名字出现在响应里」。
	banned := []string{"admin_id", "admin_name", "operator", "real_name",
		"report_id", "resolution", "\"detail\"", "resolved_by",
		admin.Nickname, admin.Username}

	mine := string(m6pMineRaw(t, "status=deleted&page_size=100", author).Data)
	if !strings.Contains(mine, m6pBatchWhy) {
		t.Fatalf("作者侧连理由都没有（%s），泄露检测无从谈起", truncate(mine))
	}
	for _, b := range banned {
		if strings.Contains(mine, b) {
			t.Errorf("#19 的响应里出现了 %q", b)
		}
	}

	d := string(m6pDetailRaw(t, id, author.Token).Data)
	if !strings.Contains(d, m6pBatchWhy) {
		t.Fatalf("#15 的响应里没有理由（%s）", truncate(d))
	}
	for _, b := range banned {
		if strings.Contains(d, b) {
			t.Errorf("#15 的响应里出现了 %q", b)
		}
	}
}
