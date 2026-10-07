package service

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"lostfound/internal/model"
	"lostfound/internal/repo"
)

// 这一组用例测的是「为什么不见了」这句话**什么时候出现、什么时候不出现、
// 以及它出现的时候里面装了什么**。全部不起数据库（§10 第①层）。
//
// 为什么这件事值得单独一层：#58 的对外形状只有三个字段，但它背后是四条
// 「不该出现」的纪律 —— 不该对非作者出现、不该对 admin 出现、不该对 open 的帖子
// 出现（顺带不该对 #14 广场那一页出现），以及**不该带出操作者的身份和举报信息**。
// 四条全是「没有发生什么」型的断言，只能拿一个会记下自己收到过什么请求的 fake 来测。
//
// ⚠ 「没有发生什么」这类断言最容易写成永远绿的东西 —— 如果 fake 收到调用却什么都不返回，
// 而判据只看「响应里有没有 removal」，那么「根本不该查」和「查了但没查到」就分不出来。
// 所以这里断言的是**调用次数和收到的 id 列表**，不是返回值。

// removalFakes 顶住 TakedownLookup：记下每一次收到的 id 列表，返回预设的那本「说法」。
type removalFakes struct {
	calls [][]int64
	// give 就是 repo.LatestTakedowns 返回的那个 map —— 没有的 id 表示「没有留痕」。
	give map[int64]repo.TakedownInfo
	// err 非空时模拟**查询本身坏了**（连不上库、SQL 写错），和「查到了但没有」是两件事。
	err error
}

func (r *removalFakes) LatestTakedowns(_ context.Context, ids []int64) (map[int64]repo.TakedownInfo, error) {
	// 存一份副本：调用方传进来的切片是 service 里 make 出来的，
	// 它之后如果复用同一个底层数组，fake 里记下的就会变成最后一批 —— 那这条断言就废了。
	r.calls = append(r.calls, append([]int64(nil), ids...))
	if r.err != nil {
		return nil, r.err
	}
	return r.give, nil
}

func (r *removalFakes) asks() int { return len(r.calls) }

// askedIDs 把多次调用摊平成一份排序后的 id 清单，方便直接比内容而不是比顺序。
func (r *removalFakes) askedIDs() []int64 {
	var all []int64
	for _, c := range r.calls {
		all = append(all, c...)
	}
	slices.Sort(all)
	return all
}

// removalSeed 是那条「有说法」的下架留痕。
//
// ⚠ 时间刻意带 **+08:00 的偏移**（数据库会话时区就是这种形状）：
// 这样「出口一律转成 UTC」那条纪律才真的被测到 —— 传一个本来就 UTC 的值进去，
// 格式化那一步写错了也看不出差别。
func removalSeed(actionID int64, reason string) repo.TakedownInfo {
	at := time.Date(2026, 10, 8, 10, 11, 12, 0, time.FixedZone("CST", 8*3600))
	return repo.TakedownInfo{ActionID: actionID, Reason: reason, CreatedAt: at}
}

// newItemWithRemoval 装配一个只用来读帖子的 Item 服务。
//
// gov 接的是**真的 Moderation**（和 m6_item_logging_test.go 一样）：
// 这里没有任何用例调用它，但传 nil 会让「读路径顺手调了治理逻辑」这种改动
// 一路静默通过 —— 而那是这一组用例最想防的事。
func newItemWithRemoval(t *testing.T, f *itemFakes, rem TakedownLookup) *Item {
	t.Helper()
	uploads, err := NewUpload(t.TempDir(), "/uploads", testLogger)
	if err != nil {
		t.Fatalf("建临时上传目录失败：%v", err)
	}
	g := newGov()
	return NewItem(f, f, newModeration(t, g), f, uploads, f, f, rem, testLogger)
}

func seedWithStatus(id, ownerID int64, status string) model.ItemDetail {
	d := *seedLostItem(id, ownerID)
	d.Status = status
	return d
}

// seedPtrWithStatus 是上面那个的指针版：GetByID 那条接缝返回的就是指针
// （真实现从库里读一行出来，不可能返回值），所以 newItemFakes 收的是指针。
func seedPtrWithStatus(id, ownerID int64, status string) *model.ItemDetail {
	d := seedWithStatus(id, ownerID, status)
	return &d
}

// ---------- 判据 ①：只有「作者读自己那条 deleted 帖」才去查登记簿 ----------

func TestRemovalAskedOnlyByAuthorOfDeletedItem(t *testing.T) {
	deleted := seedWithStatus(7, 20, model.ItemStatusDeleted)
	open := seedWithStatus(7, 20, model.ItemStatusOpen)
	deletedOthers := seedWithStatus(7, 21, model.ItemStatusDeleted)

	cases := []struct {
		name    string
		detail  *model.ItemDetail
		viewer  *model.User
		wantAsk int
		wantHas bool
	}{
		// 唯一该查的那一格。
		{"作者读自己被下架的帖子", &deleted, ownerUser, 1, true},
		// ⚠ 这三格是「不该查」的全部形状，少测一格就会留一个静默的多余查询：
		// admin 看得见 deleted（canSeeDeleted 放行），但他**不需要**一个说法 ——
		// 他要的完整版在 #50，那里连操作者昵称都有。两处都给就会有两份。
		{"admin 读同一条被下架的帖子", &deleted, adminUser, 0, false},
		// open 的帖子读得最多（广场点进详情是全站最热的一条路径），一次都不该扫登记簿。
		{"作者读自己还开着的帖子", &open, ownerUser, 0, false},
		// 别人读**自己那条**：canSeeDeleted 先一步报 NOT_FOUND，根本走不到这里。
		// 这一格断言的是「连查询都没发出去」—— 错误分支里不该藏着一次登记簿扫描。
		{"别人读一条被下架的帖子（404）", &deletedOthers, ownerUser, 0, false},
		{"匿名读一条被下架的帖子（404）", &deletedOthers, nil, 0, false},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newItemFakes(c.detail)
			rem := &removalFakes{give: map[int64]repo.TakedownInfo{7: removalSeed(123, "刷屏广告")}}
			it := newItemWithRemoval(t, f, rem)

			v, err := it.Detail(context.Background(), c.viewer, 7)
			if err != nil {
				// 404 的两格是预期分支：断言完「没查」就走。
				if c.wantAsk != 0 || c.wantHas {
					t.Fatalf("不该失败：%v", err)
				}
				if !strings.Contains(err.Error(), "不存在") {
					t.Fatalf("期望 NOT_FOUND，实际 %v", err)
				}
				if rem.asks() != 0 {
					t.Fatalf("404 的分支里竟然发了 %d 次登记簿查询：%v", rem.asks(), rem.calls)
				}
				return
			}

			if rem.asks() != c.wantAsk {
				t.Fatalf("登记簿被查了 %d 次（期望 %d 次），收到的 id：%v", rem.asks(), c.wantAsk, rem.calls)
			}
			if c.wantAsk == 1 && !slices.Equal(rem.calls[0], []int64{7}) {
				t.Fatalf("那一次查询收到的 id 应该恰好是 {7}，实际 %v", rem.calls[0])
			}
			if got := v.Removal != nil; got != c.wantHas {
				if got {
					t.Fatalf("不该有 removal，实际带上了 %+v", v.Removal)
				}
				t.Fatalf("该有 removal，实际是 nil")
			}
		})
	}
}

// ---------- 判据 ②：一页只查一次，而且只收集 deleted 的行 ----------

func TestListMineAsksOnceWithOnlyDeletedIDs(t *testing.T) {
	f := newItemFakes(seedLostItem(7, 20))
	f.listRows = []model.ItemDetail{
		seedWithStatus(1, 20, model.ItemStatusOpen),
		seedWithStatus(2, 20, model.ItemStatusDeleted),
		seedWithStatus(3, 20, model.ItemStatusClosed),
		seedWithStatus(4, 20, model.ItemStatusDeleted),
		seedWithStatus(5, 20, model.ItemStatusOpen),
		seedWithStatus(6, 20, model.ItemStatusDeleted),
	}
	rem := &removalFakes{give: map[int64]repo.TakedownInfo{
		2: removalSeed(201, "刷屏广告"),
		6: removalSeed(202, "重复发布"),
		// ⚠ 4 **故意不在这里**：它就是「帖主自己删的」那一格 ——
		// 状态一样是 deleted，但登记簿里没有对应的一行，所以不该有任何说法。
	}}
	it := newItemWithRemoval(t, f, rem)

	// fake 的 List 不看筛选条件、把种子全吐回来，所以这一页里混着三种状态。
	// （状态白名单本身是 #14/#19 的 M2 用例在测的，这里不管。）
	page, err := it.ListMine(context.Background(), 20, ListQuery{})
	if err != nil {
		t.Fatalf("ListMine 失败：%v", err)
	}

	if rem.asks() != 1 {
		t.Fatalf("一页查了 %d 次登记簿（期望 1 次）：%v", rem.asks(), rem.calls)
	}
	want := []int64{2, 4, 6}
	if !slices.Equal(rem.calls[0], want) {
		t.Fatalf("收到的 id 应该恰好是 %v（只有 deleted 那三行），实际 %v", want, rem.calls[0])
	}

	// 三行都该按各自的 id 挂回说法，而且**只有这三行**。
	for _, row := range page.List {
		switch row.ID {
		case 2:
			if row.Removal == nil || row.Removal.Reason != "刷屏广告" || row.Removal.ActionID != 201 {
				t.Fatalf("id=2 该挂上第一条说法，实际 %+v", row.Removal)
			}
		case 6:
			if row.Removal == nil || row.Removal.Reason != "重复发布" || row.Removal.ActionID != 202 {
				t.Fatalf("id=6 该挂上第二条说法，实际 %+v", row.Removal)
			}
		case 4:
			if row.Removal != nil {
				t.Fatalf("id=4 没有留痕（自己删的），不该有任何说法，实际 %+v", row.Removal)
			}
		default:
			if row.Removal != nil {
				t.Fatalf("id=%d 是 open/closed，压根不该有 removal，实际 %+v", row.ID, row.Removal)
			}
		}
	}
}

func TestListMineWithoutDeletedAsksNothing(t *testing.T) {
	f := newItemFakes(seedLostItem(7, 20))
	f.listRows = []model.ItemDetail{
		seedWithStatus(1, 20, model.ItemStatusOpen),
		seedWithStatus(2, 20, model.ItemStatusClosed),
	}
	rem := &removalFakes{give: map[int64]repo.TakedownInfo{1: removalSeed(9, "不该被用到")}}
	it := newItemWithRemoval(t, f, rem)

	if _, err := it.ListMine(context.Background(), 20, ListQuery{}); err != nil {
		t.Fatalf("ListMine 失败：%v", err)
	}
	// 这是「作者默认打开我的发布」那一格 —— 绝大多数时候页面里一条 deleted 都没有，
	// 这时候整条登记簿路径应该是**零次往返**，而不是「查了个空」。
	if rem.asks() != 0 {
		t.Fatalf("一页里没有 deleted，却还是查了 %d 次：%v", rem.asks(), rem.calls)
	}
}

// ---------- 判据 ③：#14 广场永远不查、永远不带 ----------

func TestListPublicNeverTouchesTheLedger(t *testing.T) {
	f := newItemFakes(seedLostItem(7, 20))
	// 哪怕 fake 硬吐一条 deleted 出来（真库里 publicListStatus 不允许），
	// 广场那条路径也必须既不查也不带 —— 它挂的是 OptionalJWT，是全站唯一的公开列表。
	f.listRows = []model.ItemDetail{
		seedWithStatus(1, 20, model.ItemStatusOpen),
		seedWithStatus(2, 21, model.ItemStatusDeleted),
	}
	rem := &removalFakes{give: map[int64]repo.TakedownInfo{2: removalSeed(9, "刷屏广告")}}
	it := newItemWithRemoval(t, f, rem)

	page, err := it.ListPublic(context.Background(), ListQuery{})
	if err != nil {
		t.Fatalf("ListPublic 失败：%v", err)
	}
	if rem.asks() != 0 {
		t.Fatalf("公开列表查了登记簿 %d 次：%v", rem.asks(), rem.calls)
	}
	for _, row := range page.List {
		if row.Removal != nil {
			t.Fatalf("公开响应里出现了治理信息（id=%d 带着 %+v）", row.ID, row.Removal)
		}
	}
}

// ---------- 判据 ④：序列化后的形状 ----------

func TestRemovalJSONShapeAndLeaks(t *testing.T) {
	f := newItemFakes(seedPtrWithStatus(7, 20, model.ItemStatusDeleted))
	rem := &removalFakes{give: map[int64]repo.TakedownInfo{7: removalSeed(123, "刷屏广告")}}
	it := newItemWithRemoval(t, f, rem)

	v, err := it.Detail(context.Background(), ownerUser, 7)
	if err != nil {
		t.Fatalf("Detail 失败：%v", err)
	}
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}
	got := string(raw)

	// 该有的三样。
	for _, want := range []string{`"removal"`, `"action_id":123`, `"reason":"刷屏广告"`} {
		if !strings.Contains(got, want) {
			t.Fatalf("响应里缺 %s，实际 %s", want, got)
		}
	}
	// ⚠ 时间必须是 Z 结尾的 UTC：种子给的是 +08:00，这里能过才说明转了。
	if !strings.Contains(got, `"created_at":"2026-10-08T02:11:12Z"`) {
		t.Fatalf("removal.created_at 没转成 UTC（+08:00 的 10:11:12 应该是 02:11:12Z），实际 %s", got)
	}

	// 不该有的几样 —— 这四条就是「作者看到的说法只是一句话，不是一份档案」的实现。
	// 逐个点名而不是「除了三个字段以外都不许有」，是因为将来真加字段的人需要知道
	// 哪几个名字是**明确被禁**的，而不是撞上一条通用规则再猜为什么。
	for _, forbidden := range []string{"admin", "report", "real_name", "credit"} {
		if strings.Contains(strings.ToLower(got), forbidden) {
			t.Fatalf("响应里出现了 %q：这句话只该回答「为什么」，不该带上操作者、举报、真实姓名或信用分。\n实际 %s", forbidden, got)
		}
	}
}

func TestNoLedgerRowMeansNoKeyAtAll(t *testing.T) {
	// 帖主自己删的帖子：状态是 deleted，登记簿里没有对应行。
	f := newItemFakes(seedPtrWithStatus(7, 20, model.ItemStatusDeleted))
	f.listRows = []model.ItemDetail{seedWithStatus(7, 20, model.ItemStatusDeleted)}
	rem := &removalFakes{give: map[int64]repo.TakedownInfo{}}
	it := newItemWithRemoval(t, f, rem)

	v, err := it.Detail(context.Background(), ownerUser, 7)
	if err != nil {
		t.Fatalf("Detail 失败：%v", err)
	}
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}
	// ⚠ 断言的是**键不存在**，不是 `"removal":null`。这是 omitempty 存在的全部理由：
	// 「平台没动过它」和「平台动了它但说不清为什么」是两种完全不同的状态，
	// 而一个 null 会让前端必须再去猜后者的含义。
	if strings.Contains(string(raw), "removal") {
		t.Fatalf("没有留痕时 removal 这个键根本不该出现，实际 %s", raw)
	}

	// #19 同一件事，另一条路径（列表用的是 ItemSummary，不是 ItemView）。
	page, err := it.ListMine(context.Background(), 20, ListQuery{})
	if err != nil {
		t.Fatalf("ListMine 失败：%v", err)
	}
	raw2, err := json.Marshal(page)
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}
	if strings.Contains(string(raw2), "removal") {
		t.Fatalf("列表里同样不该出现 removal，实际 %s", raw2)
	}
}

// ---------- 判据 ⑤：装配漏了它只是「少一句话」，不是 500 ----------

func TestNilTakedownLookupIsHarmless(t *testing.T) {
	f := newItemFakes(seedPtrWithStatus(7, 20, model.ItemStatusDeleted))
	f.listRows = []model.ItemDetail{seedWithStatus(7, 20, model.ItemStatusDeleted)}
	it := newItemWithRemoval(t, f, nil)

	v, err := it.Detail(context.Background(), ownerUser, 7)
	if err != nil {
		t.Fatalf("Detail 失败：%v", err)
	}
	if v.Removal != nil {
		t.Fatalf("没有登记簿接缝时不该凭空造出说法，实际 %+v", v.Removal)
	}
	page, err := it.ListMine(context.Background(), 20, ListQuery{})
	if err != nil {
		t.Fatalf("ListMine 失败：%v", err)
	}
	if len(page.List) != 1 {
		t.Fatalf("列表本身坏了：%+v", page.List)
	}
}

// ---------- 判据 ⑥：查坏了不能静默变成「没有说法」 ----------

func TestLedgerFailurePropagates(t *testing.T) {
	boom := errors.New("connection reset by peer")

	for _, c := range []struct {
		name string
		run  func(it *Item) error
	}{
		{"#15 详情", func(it *Item) error {
			_, err := it.Detail(context.Background(), ownerUser, 7)
			return err
		}},
		{"#19 列表", func(it *Item) error {
			_, err := it.ListMine(context.Background(), 20, ListQuery{})
			return err
		}},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newItemFakes(seedPtrWithStatus(7, 20, model.ItemStatusDeleted))
			f.listRows = []model.ItemDetail{seedWithStatus(7, 20, model.ItemStatusDeleted)}
			it := newItemWithRemoval(t, f, &removalFakes{err: boom})

			err := c.run(it)
			// 「查不到」和「没查成功」必须分开：前者返回空 map、这句话不出现；
			// 后者必须报错。吞掉它的话，登记簿坏掉的那天，所有作者都会看到
			// 一条「被删了但没有任何解释」的帖子 —— 那正是这个功能要避免的状态。
			if !errors.Is(err, boom) {
				t.Fatalf("登记簿查询失败必须原样往上抛（handler 会翻成 INTERNAL），实际 %v", err)
			}
		})
	}
}
