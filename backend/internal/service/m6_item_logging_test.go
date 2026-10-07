package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"lostfound/internal/apperr"
	"lostfound/internal/model"
	"lostfound/internal/repo"
)

// 这份文件是那张表的最后两行：**#16 改帖 / #17 删帖的 admin 分支**。
//
// 它们不在 Moderation 上，而在 service.Item 上（§16.1 那条决定：
// 「保留 admin 改/删他人帖子的权限，但在 handler 里补写日志」）。
// 表还是同一张表，只是换一个装配点 —— 而这里刻意**不**给治理逻辑做假件：
// ItemGovernance 那个接缝的另一端接的是**真的 Moderation**。
//
// 这一点是这两条用例的全部意义。如果 gov 也拿一个假的下架实现，
// 那「admin 从帖子页删一条帖会不会写留痕、会不会通知作者」测的只是那个假件。
// 接上真件之后，#43 批量下架、#49 连带下架、#17 admin 分支三条路共用一份实现
// 这件事才有第①层的证据。下面那个 govBegin==0 就是证据的另一半：
// #17 的留痕写在 **Item 开的那个事务**里，而不是 Moderation 自己另开一个。

// seedLostItem 造一条属于 ownerID 的 lost 帖，状态 open。
//
// 时间是**库里读出来的**那种已解析值，不是字符串：Update 的第一步是 GetByID，
// 那次读拿到什么类型就必须是什么类型，否则 fake 本身就在撒谎。
func seedLostItem(id, ownerID int64) *model.ItemDetail {
	lastSeen := time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)
	lost := time.Date(2026, 10, 1, 18, 0, 0, 0, time.UTC)
	return &model.ItemDetail{
		Item: model.Item{
			ID: id, ItemType: model.ItemTypeLost, UserID: ownerID,
			Title: "黑色钱包", Description: "卡包里有两张校园卡",
			CategoryID: 21, LocationID: 31, LocationDetail: "图书馆一楼门口",
			LastSeenAt: &lastSeen, LostAt: &lost,
			Contact: "13800000000", Status: model.ItemStatusOpen,
			CreatedAt: lastSeen, UpdatedAt: lost,
		},
		CategoryName: "钱包", LocationName: "图书馆一楼", AuthorNickname: "小陈",
	}
}

// itemLostFields 是一份**能通过全部校验**的改帖请求体。
//
// lost 帖必须同时有 last_seen_at 和 lost_at，且前者不晚于后者 ——
// 用例要是输在校验上，就会把「没走到写入」误当成「留痕没写」，那是一条假绿的邻居：假红。
func itemLostFields() ItemFields {
	return ItemFields{
		Title: "黑色钱包（补一句颜色）", Description: "卡包里有两张校园卡",
		CategoryID: 21, LocationID: 31, LocationDetail: "图书馆一楼门口",
		LastSeenAt: "2026-10-01T09:00:00Z", LostAt: "2026-10-01T18:00:00Z",
		Contact: "13800000000",
	}
}

var (
	adminUser = &model.User{ID: testAdmin, Nickname: "管理员小张",
		Role: model.RoleAdmin, Status: model.UserStatusActive}
	ownerUser = &model.User{ID: 20, Nickname: "小陈",
		Role: model.RoleUser, Status: model.UserStatusActive}
)

// itemFakes 顶住 service.Item 需要的全部接缝：TxStarter + ItemStore +
// DictLookup + MatchRunner + ContactViewLookup。
//
// 三个和本次用例无关的方法（Create / ImageWithOwner / pool 版 DeleteImage）返回错误
// 而不是零值：如果哪天改帖的实现顺路调了它们，错误信息会直接指出是谁，
// 而零值会让它静默地往下走半步。OnCreated 用 panic：那条路径在 Update 上根本不该存在，
// 而这里没有任何返回值能同时表达「不该发生」和「请继续」。
type itemFakes struct {
	tx     *loggedTx
	begins int

	detail *model.ItemDetail
	// listRows 是 #14/#19 那两条列表路径的种子数据（service 只会把它转成摘要再返回）。
	// 默认 nil —— 这份文件自己的用例全是**写**路径，一次列表都不走；
	// 用它的用例是 m6plus_removal_test.go 那一组。
	listRows []model.ItemDetail

	poolUpdates int
	// poolStatuses 记下帖主自删那条路把状态改成了什么 —— 判据 ④ 要的正是「一条都没改」。
	poolStatuses  []string
	updateTxRows  []repo.UpdateItemRow
	replacedImage [][]string
	// matchedUpdate 记下 MatchRunner.OnUpdated 收到过哪几条帖子的 id。
	matchedUpdate []int64
}

func newItemFakes(d *model.ItemDetail) *itemFakes {
	return &itemFakes{tx: newLoggedTx(), detail: d}
}

func (f *itemFakes) Begin(context.Context) (pgx.Tx, error) {
	f.begins++
	return f.tx, nil
}

// ---------- ItemStore：pool 语义的那八个 ----------

func (f *itemFakes) Create(context.Context, repo.NewItemRow) (*model.ItemDetail, error) {
	return nil, errors.New("itemFakes.Create 不该被 #16/#17 的用例调用")
}

func (f *itemFakes) GetByID(context.Context, int64) (*model.ItemDetail, error) {
	if f.detail == nil {
		return nil, apperr.NewMsg(apperr.CodeNotFound, "帖子不存在")
	}
	return f.detail, nil
}

// Update 是**帖主自己**那条路（pool 版，自己 Begin/Commit）。
// 它和 UpdateTx 分开计数，因为「admin 分支有没有走错到这条路上」就是这次改动的核心风险。
func (f *itemFakes) Update(_ context.Context, _ int64, p repo.UpdateItemRow) (*model.ItemDetail, error) {
	f.poolUpdates++
	f.updateTxRows = append(f.updateTxRows, p)
	return f.detail, nil
}

func (f *itemFakes) SetStatus(_ context.Context, _ int64, status string) error {
	f.poolStatuses = append(f.poolStatuses, status)
	return nil
}

// List 返回种子行。total 就用 len —— 这两行**必须**保持一致，
// 否则 #19 的分页会算错，而 #58 那一组用例关心的是「哪几行被拿去查登记簿」，
// 不是「翻页对不对」（后者是 M2 那组列表用例的职责）。
func (f *itemFakes) List(context.Context, repo.ListFilter) ([]model.ItemDetail, int, error) {
	return f.listRows, len(f.listRows), nil
}

func (f *itemFakes) ListImages(context.Context, int64) ([]model.ItemImage, error) { return nil, nil }

func (f *itemFakes) ImageWithOwner(context.Context, int64) (model.ItemImage, int64, error) {
	return model.ItemImage{}, 0, errors.New("itemFakes.ImageWithOwner 不该被 #16/#17 的用例调用")
}

func (f *itemFakes) DeleteImage(context.Context, int64) (string, error) {
	return "", errors.New("itemFakes.DeleteImage（pool 版）不该被 #16/#17 的用例调用")
}

// ---------- ItemStore：收 pgx.Tx 的那两条（只有 #16 的 admin 分支用）----------

// UpdateTx 返回的是**库里那一行的作者**（真实现是 RETURNING user_id），
// 而留痕里那个 owner_id 就取自它。返回 f.detail.UserID 而不是一个写死的数字，
// 是为了让「admin 改帖的留痕写的到底是谁的帖子」这条断言跟着种子数据走。
func (f *itemFakes) UpdateTx(_ context.Context, _ pgx.Tx, _ int64, p repo.UpdateItemRow) (int64, error) {
	f.updateTxRows = append(f.updateTxRows, p)
	return f.detail.UserID, nil
}

func (f *itemFakes) ReplaceImagesTx(_ context.Context, _ pgx.Tx, _ int64, paths []string) error {
	f.replacedImage = append(f.replacedImage, paths)
	return nil
}

// ---------- DictLookup ----------

func (f *itemFakes) GetCategory(_ context.Context, id int64) (*model.Category, error) {
	return &model.Category{ID: id, Name: "钱包", Level: 2, IsActive: true}, nil
}

func (f *itemFakes) GetLocation(_ context.Context, id int64) (*model.Location, error) {
	return &model.Location{ID: id, Name: "图书馆一楼", Level: 3, IsActive: true}, nil
}

func (f *itemFakes) CountActiveChildren(context.Context, int64) (int, error) { return 0, nil }

// ---------- MatchRunner / ContactViewLookup ----------

func (f *itemFakes) OnCreated(context.Context, *model.ItemDetail) (*[]MatchHit, *int) {
	panic("itemFakes.OnCreated 不该被 #16/#17 的用例调用")
}

func (f *itemFakes) OnUpdated(_ context.Context, d *model.ItemDetail) {
	f.matchedUpdate = append(f.matchedUpdate, d.ID)
}

func (f *itemFakes) Viewed(context.Context, int64, int64) (bool, error) { return false, nil }

// newItemServices 把 Item 和**真的 Moderation** 装配在一起，共用一套假事务层。
func newItemServices(t *testing.T) (*Item, *itemFakes, *govFakes) {
	t.Helper()
	f := newItemFakes(seedLostItem(7, 20))
	g := newGov()
	// #17 的 admin 分支会真的走一遍下架：那条帖子属于 20 号。
	g.takedownRows = []repo.TakenRow{{ItemID: 7, UserID: 20}}

	uploads, err := NewUpload(t.TempDir(), "/uploads", testLogger)
	if err != nil {
		t.Fatalf("建临时上传目录失败：%v", err)
	}
	// takedowns 传 nil 是有意的：这三个用例走的是 #16/#17/#18 三条**写**路径，
	// 一条都没有读「为什么被下架」。传 nil 恰好把这条边界钉住 ——
	// 如果哪天 Item 服务在写路径上调了它，这里会立刻 panic 在测试里，
	// 而不是等到 #58 那个解释性读功能上线时才发现多了一条隐形的登记簿依赖。
	return NewItem(f, f, newModeration(t, g), f, uploads, f, f, nil, testLogger), f, g
}

type itemCase struct {
	name string
	run  func(it *Item) error

	want    []wantRow
	notices []noticeSpec
	// begins / commits 是 Item 自己那一侧的事务计数。
	begins int
	// commits 期望值：写留痕的那些用例是 1，只读或走 pool 版本的那些是 0。
	commits     int
	govBegin    int
	poolUpdates int
	poolStatus  int
	matchCalls  int
	// extra 装形状相关的断言（比如留痕里那个 owner_id、ids 的长度）。
	extra func(*testing.T, []recorded, *govFakes)
}

func itemCases() []itemCase {
	ctx := context.Background()

	return []itemCase{
		{
			name: "#16 admin 改他人的帖",
			run: func(it *Item) error {
				_, err := it.Update(ctx, adminUser, 7, UpdateItemInput{
					ItemFields: itemLostFields(), AdminReason: testReason})
				return err
			},
			want:    []wantRow{{model.ActionItemEdit, model.TargetItem, 7}},
			begins:  1,
			commits: 1,
			// ⚠ 这一条是 §12 那句「#16 改帖时 admin 不重跑匹配」的落点。
			// 管理员补一个错别字就触发一轮新匹配，等于平台替发帖人许诺了一次归属（定位原则 1）。
			matchCalls: 0,
			extra: func(t *testing.T, rows []recorded, _ *govFakes) {
				// owner_id 来自 UpdateTx 的 RETURNING（库里认定的作者），不是请求体、
				// 也不是事务开始前那次点查。
				if got, _ := rows[0].detail["owner_id"].(float64); got != 20 {
					t.Errorf("留痕里的 owner_id 应该是帖主 20，实际 %#v", rows[0].detail["owner_id"])
				}
			},
		},
		{
			// 对照用例：同一个方法、同一条帖子，换成帖主自己改。期望正好反过来 ——
			// 0 行留痕、0 次事务、匹配跑一次。
			// 没有这一条，上面那个 matchCalls==0 就分不清是「admin 分支不跑匹配」
			// 还是「整个改帖路径都不跑匹配」（后者是个 bug，而且会让 M3 的判据红）。
			name: "#16 帖主改自己的帖",
			run: func(it *Item) error {
				_, err := it.Update(ctx, ownerUser, 7, UpdateItemInput{ItemFields: itemLostFields()})
				return err
			},
			begins:      0,
			poolUpdates: 1,
			matchCalls:  1,
		},
		{
			name: "#17 admin 删他人的帖",
			run: func(it *Item) error {
				return it.Delete(ctx, adminUser, 7, testReason)
			},
			want:     []wantRow{{model.ActionItemTakedown, model.TargetItem, 7}},
			notices:  []noticeSpec{{20, model.NotificationAdminAction, 7}},
			begins:   1,
			commits:  1,
			govBegin: 0,
			extra: func(t *testing.T, rows []recorded, g *govFakes) {
				// 单条也走批量形状：detail.ids 恒在。§13 第 10 步那条
				// 「每个 deleted 都能追溯到一次 admin_actions」的自检 SQL
				// 靠的就是「不管单条还是批量形状都一样」这个前提。
				if ids, _ := rows[0].detail["ids"].([]any); len(ids) != 1 {
					t.Errorf("detail.ids 应该是 1 个（这一条端点只动一条帖子），实际 %#v", rows[0].detail["ids"])
				}
				// 留痕写在 Item 开的那个事务上，所以 Moderation 那条假事务上一条 SQL 都没收到。
				if len(g.tx.calls) != 0 {
					t.Errorf("Moderation 自己开事务写了 %d 条 SQL —— 那会变成两个事务，"+
						"「帖子删了、留痕没写」就又可能了", len(g.tx.calls))
				}
				if g.begins != 0 {
					t.Errorf("Moderation 侧 Begin 了 %d 次，期望 0 次", g.begins)
				}
			},
		},
		{
			name: "#17 帖主自删",
			run: func(it *Item) error {
				return it.Delete(ctx, ownerUser, 7, "")
			},
			begins:     0,
			poolStatus: 1,
		},
	}
}

// TestItemAdminWritesAreLogged 把 #16/#17 补进 m6_logging_test.go 那张表。
func TestItemAdminWritesAreLogged(t *testing.T) {
	for _, c := range itemCases() {
		t.Run(c.name, func(t *testing.T) {
			it, f, g := newItemServices(t)

			if err := c.run(it); err != nil {
				t.Fatalf("用例本身失败了：%v", err)
			}

			rows := rowsOf(t, f.tx.fakeTx)
			if len(rows) != len(c.want) {
				t.Fatalf("admin_actions 应该新增 %d 行，实际 %d 行：%+v", len(c.want), len(rows), rows)
			}
			for i, w := range c.want {
				r := rows[i]
				if r.action != w.action || r.targetType != w.targetType || r.targetID != w.targetID {
					t.Errorf("第 %d 行留痕不对，期望 %s/%s/%d，实际 %s/%s/%d",
						i+1, w.action, w.targetType, w.targetID, r.action, r.targetType, r.targetID)
				}
				if r.adminID != testAdmin {
					t.Errorf("第 %d 行留痕挂在 admin=%d 上，期望 %d", i+1, r.adminID, testAdmin)
				}
				if r.reason != testReason {
					t.Errorf("第 %d 行留痕的 reason 应该一字不改是 %q，实际 %q", i+1, testReason, r.reason)
				}
			}

			if len(g.notices) != len(c.notices) {
				t.Fatalf("应该发 %d 条通知，实际 %d 条：%+v", len(c.notices), len(g.notices), g.notices)
			}
			for i, w := range c.notices {
				n := g.notices[i]
				if n.UserID != w.user || n.Type != w.typ {
					t.Errorf("第 %d 条通知不对，期望发给 %d 的 %s，实际 %d 的 %s",
						i+1, w.user, w.typ, n.UserID, n.Type)
				}
				if !strings.Contains(n.Content, testReason) {
					t.Errorf("第 %d 条通知正文里读不到理由原文 %q：%s", i+1, testReason, n.Content)
				}
			}

			if f.begins != c.begins || f.tx.commits != c.commits {
				t.Errorf("Item 侧事务：begin=%d commit=%d，期望 %d/%d", f.begins, f.tx.commits, c.begins, c.commits)
			}
			if g.begins != c.govBegin {
				t.Errorf("治理侧 begin=%d，期望 %d（#17 的留痕必须写在 Item 开的那个事务里）", g.begins, c.govBegin)
			}
			if f.poolUpdates != c.poolUpdates {
				t.Errorf("走了 pool 版 Update %d 次，期望 %d 次 —— admin 分支必须走同事务那条路",
					f.poolUpdates, c.poolUpdates)
			}
			if len(f.poolStatuses) != c.poolStatus {
				t.Errorf("走了 pool 版 SetStatus %d 次，期望 %d 次（%v）",
					len(f.poolStatuses), c.poolStatus, f.poolStatuses)
			}
			if len(f.matchedUpdate) != c.matchCalls {
				t.Errorf("OnUpdated 跑了 %d 次，期望 %d 次（帖子 id：%v）",
					len(f.matchedUpdate), c.matchCalls, f.matchedUpdate)
			}
			if c.extra != nil {
				c.extra(t, rows, g)
			}
		})
	}
}

// TestItemAdminBlankReasonChangesNothing 是判据 ④ 在 #16/#17 上的落点：
// **admin 不填 admin_reason 时，帖子的内容、状态、图片一条都不会变**。
//
// 断言的是四个计数器全 0，而不只是返回值：只测「返回 VALIDATION」不够 ——
// 「先改完、再报留痕写不进去」那种实现给出的错误一模一样，而帖子已经改了。
//
// 第二个用例填的是「空格 + 全角空格」：那是 requireReason 和数据库 CHECK
// 两边口径的唯一交点，从表单里粘一个全角空格不该变成一次成功的治理动作。
func TestItemAdminBlankReasonChangesNothing(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name string
		run  func(it *Item) error
	}{
		{"#16 admin 改帖不带理由", func(it *Item) error {
			_, err := it.Update(ctx, adminUser, 7, UpdateItemInput{ItemFields: itemLostFields()})
			return err
		}},
		{"#16 admin 改帖理由是空白", func(it *Item) error {
			_, err := it.Update(ctx, adminUser, 7, UpdateItemInput{
				ItemFields: itemLostFields(), AdminReason: " 　"})
			return err
		}},
		{"#17 admin 删帖不带理由", func(it *Item) error {
			return it.Delete(ctx, adminUser, 7, "")
		}},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			it, f, g := newItemServices(t)

			err := c.run(it)
			if err == nil {
				t.Fatal("admin 动了别人的帖子却没填理由，竟然成功了")
			}
			if !apperr.IsCode(err, apperr.CodeValidation) {
				t.Errorf("应该是 VALIDATION，实际是 %v", err)
			}
			if f.begins != 0 || len(f.updateTxRows) != 0 || len(f.poolStatuses) != 0 || f.poolUpdates != 0 {
				t.Errorf("begin=%d UpdateTx=%d SetStatus=%d poolUpdate=%d，全都应该是 0",
					f.begins, len(f.updateTxRows), len(f.poolStatuses), f.poolUpdates)
			}
			if len(f.tx.calls) != 0 || len(g.tx.calls) != 0 || len(g.notices) != 0 {
				t.Errorf("发出了 SQL 或通知：exec=%d/%d notices=%d",
					len(f.tx.calls), len(g.tx.calls), len(g.notices))
			}
			// 校验没过的时候连匹配都不该跑：那是「什么都没发生」的一部分。
			if len(f.matchedUpdate) != 0 {
				t.Errorf("改了 %d 条帖子的匹配，期望 0 条", len(f.matchedUpdate))
			}
		})
	}
}

// TestItemAdminLogFailureRollsBack 把 #16/#17 补进判据 ④ 的后半段。
//
// #17 这一条尤其值得单列：它的留痕是**隔着两个服务**写的
// （Item 开事务 → Moderation 在那个 tx 里写）。中间那道接缝一旦被改成
// 「Moderation 自己 Begin」，就会变成「一半先提交、另一半失败时回滚不掉」。
// itemCases 里那个 govBegin==0 钉的是形状，这一条钉的是失败时的行为。
func TestItemAdminLogFailureRollsBack(t *testing.T) {
	ctx := context.Background()
	boom := errors.New("admin_actions 写不进去（假事务）")

	cases := []struct {
		name string
		run  func(it *Item) error
	}{
		{"#16 admin 改帖", func(it *Item) error {
			_, err := it.Update(ctx, adminUser, 7, UpdateItemInput{
				ItemFields: itemLostFields(), AdminReason: testReason})
			return err
		}},
		{"#17 admin 删帖", func(it *Item) error {
			return it.Delete(ctx, adminUser, 7, testReason)
		}},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			it, f, g := newItemServices(t)
			f.tx.execErr = boom

			if err := c.run(it); err == nil {
				t.Fatal("留痕写失败却返回了成功：管理员会以为这次治理动作完成了")
			}
			if f.begins == 0 {
				t.Fatal("一次事务都没开，这条用例没有覆盖到回滚")
			}
			if f.tx.commits != 0 {
				t.Errorf("留痕失败之后提交了 %d 次，业务改动会带着空的问责记录落库", f.tx.commits)
			}
			if f.tx.rollbacks == 0 {
				t.Error("一次回滚都没有：runInTx 的 defer 丢了？")
			}
			// #17 的那条通知写在**同一个 tx** 上，而留痕在它之前：
			// 留痕失败就该直接返回，InsertTx 一次都不会被调。
			if len(g.notices) != 0 {
				t.Errorf("留痕写不进去，却还是发了 %d 条通知：%+v", len(g.notices), g.notices)
			}
		})
	}
}
