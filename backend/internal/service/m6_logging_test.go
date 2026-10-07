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

// 这份文件是 §12 M6 判据里那四条「不留痕就等于没治理」的第①层证明。
//
// 计划要的是**一张表**：全部 admin 写路由（#9–#12、#16、#17、#35、#36、#43–#47、#49）
// 逐条列出「这次调用应当在 admin_actions 里多出几行、每行是什么动作、
// 应当发出几条什么类型的通知」，然后一条一条真的调一遍。
// 绝大多数是 1 行，只有 #49 传 takedown/ban 时是 2 行（§4 第 795 行）。
//
// ## 为什么用假事务而不是真库
//
// 因为要断言的东西全是**计数**：留痕几行、通知几条、事务提交了几次。
// 拿真库测这些当然更「真实」，但第②层（httptest + 真库）和第③层（smoke.sh）
// 已经把真实那一面覆盖了；第①层的价值恰恰在于它能免费回答两个别处答不了的问题：
//   - 「留痕 INSERT 失败时事务有没有回滚」—— 真库很难制造这种失败，
//     而判据 ④ 要求的就是这一种失败。
//   - 「空理由有没有在开事务**之前**被拦住」—— 只有假的 Begin 能记下自己被调用了几次。
//
// 所以这里的 fake 全部围绕「记录发生了什么」而不是「模拟数据库行为」。

const (
	testAdmin  = int64(9)
	testTarget = int64(42)
	// testReason 是所有用例共用的理由原文。§3.7 要求它**一字不改**地出现在
	// 留痕的 reason 列和被处置人收到的通知正文里，所以每一行都拿它比对一次。
	testReason = "刷屏广告"
)

// ---------- 假事务：在 adminlog_test.go 的 fakeTx 上补上事务的生死 ----------

// loggedTx 是 fakeTx 加两个计数器。
//
// 为什么用嵌入而不是重写一遍：fakeTx 那十一个方法里只有 Exec 真的做事，
// 其余九个「不该被调用」的守卫正是这一层想要的（Moderation 不该用 tx 去 Query）。
// 而 Commit/Rollback 在 adminlog 那一层确实不该被调（留痕函数不拥有事务），
// 到了 Moderation 这一层它们**必须**被调 —— 于是给它们换成会计数的实现。
//
// 这两个计数器就是判据 ④ 的落点：
//   - 成功路径：commits == 1
//   - 留痕写不进去：commits == 0（一次都没提交，业务跟着回滚）
type loggedTx struct {
	*fakeTx
	commits   int
	rollbacks int
}

func newLoggedTx() *loggedTx { return &loggedTx{fakeTx: &fakeTx{}} }

func (l *loggedTx) Commit(context.Context) error {
	l.commits++
	return nil
}

func (l *loggedTx) Rollback(context.Context) error {
	l.rollbacks++
	return nil
}

// ---------- 假依赖：一个结构体顶住 Moderation 的九个接缝 ----------

// govFakes 实现 TxStarter 和 ModerationItems/Dict/Users/Returns/Reports/Notices/Stats。
//
// ⚠ 它**不**实现 ModerationActions：那个接口的 List(ctx, repo.AdminActionFilter)
// 和 ModerationReports 的 List(ctx, repo.ReportListFilter) 同名不同参，
// Go 里一个方法名只能有一个签名。所以 #50 的日志读接缝单独用一个 actionLogs 包装
// （见下面那三行），这不算妥协：它恰好证明了「读日志的那条路写不进任何东西」——
// 那个类型除了 List 什么都没有。
type govFakes struct {
	tx     *loggedTx
	begins int

	// 每条写原语返回什么，由用例通过 tweak 改；没改的就是 newGov 里的默认值。
	takedownRows []repo.TakenRow
	// takedownIDs 记下每次 TakedownTx 收到的 id 数组，用来验「一条 SQL 改完所有行」。
	takedownIDs  [][]int64
	restoreOwner int64
	itemOwner    int64
	deletedImage *repo.DeletedImage
	deletedRet   *repo.DeletedReturn
	resolve      *repo.Resolve

	notices []repo.NewNotice
}

func newGov() *govFakes {
	return &govFakes{
		tx: newLoggedTx(),
		// 默认这批是「三个作者两篇文章」的最小形状：101/102 同属 20 号，103 属 21 号。
		// §3.7 的合并规则要求这一批只出**两条**通知，而且第一条的 item_id 必须是 NULL。
		takedownRows: []repo.TakenRow{
			{ItemID: 101, UserID: 20},
			{ItemID: 102, UserID: 20},
			{ItemID: 103, UserID: 21},
		},
		restoreOwner: 20,
		itemOwner:    20,
		deletedImage: &repo.DeletedImage{ImageID: 5, ItemID: 7, UserID: 20, Path: "2026/10/不存在.jpg"},
		deletedRet: &repo.DeletedReturn{
			ID: 3, ItemID: 7, SubmitterID: 21, Status: model.ReturnStatusPending,
			ProofImagePath: "2026/10/不存在-凭证.jpg",
		},
		resolve: &repo.Resolve{
			ID: 5, Status: model.ReportStatusResolved, ReporterID: 11, ItemID: 7,
			ResolvedAt: time.Date(2026, 10, 8, 10, 0, 0, 0, time.UTC),
			AlsoClosed: []repo.ClosedReport{{ID: 6, ReporterID: 12}},
		},
	}
}

func (g *govFakes) Begin(context.Context) (pgx.Tx, error) {
	g.begins++
	return g.tx, nil
}

// ----- ModerationItems -----

func (g *govFakes) TakedownTx(_ context.Context, _ pgx.Tx, ids []int64) ([]repo.TakenRow, error) {
	g.takedownIDs = append(g.takedownIDs, ids)
	return g.takedownRows, nil
}

func (g *govFakes) RestoreTx(context.Context, pgx.Tx, int64) (int64, error) {
	return g.restoreOwner, nil
}

func (g *govFakes) DeleteImageTx(context.Context, pgx.Tx, int64) (*repo.DeletedImage, error) {
	return g.deletedImage, nil
}

func (g *govFakes) OwnerTx(context.Context, pgx.Tx, int64) (int64, error) { return g.itemOwner, nil }

// ----- ModerationDict -----
//
// 返回的 Level 由 parent_id 现推（和 repo.resolveLevel 同一个规则），
// 因为 dictCreateDetail 把 created.Level 写进留痕，用例要看那一格是不是真跟着值走。

func (g *govFakes) CreateCategoryTx(_ context.Context, _ pgx.Tx, p repo.NewDictRow) (*model.Category, error) {
	level := 1
	if p.ParentID != nil {
		level = 2
	}
	return &model.Category{ID: 90, ParentID: p.ParentID, Name: p.Name, Level: level, IsActive: true}, nil
}

func (g *govFakes) CreateLocationTx(_ context.Context, _ pgx.Tx, p repo.NewDictRow) (*model.Location, error) {
	level := 1
	if p.ParentID != nil {
		level = 2
	}
	return &model.Location{ID: 95, ParentID: p.ParentID, Name: p.Name, Level: level,
		IsActive: true, IsFreeform: p.IsFreeform}, nil
}

func (g *govFakes) DeleteCategoryTx(_ context.Context, _ pgx.Tx, id int64) (*model.Category, error) {
	return &model.Category{ID: id, Name: "电子设备", Level: 1}, nil
}

func (g *govFakes) DeleteLocationTx(_ context.Context, _ pgx.Tx, id int64) (*model.Location, error) {
	return &model.Location{ID: id, Name: "图书馆一楼", Level: 2}, nil
}

// ----- ModerationUsers -----

func (g *govFakes) GetByID(_ context.Context, id int64) (*model.User, error) {
	return &model.User{ID: id, Nickname: "小陈", Role: model.RoleUser, Status: model.UserStatusActive}, nil
}

func (g *govFakes) ListByFilter(context.Context, repo.UserFilter) ([]model.User, int, error) {
	return nil, 0, nil
}

func (g *govFakes) SetRoleTx(_ context.Context, _ pgx.Tx, id int64, role string) (*model.User, error) {
	return &model.User{ID: id, Nickname: "小陈", Role: role, Status: model.UserStatusActive}, nil
}

func (g *govFakes) SetStatusTx(_ context.Context, _ pgx.Tx, id int64, status string) (*model.User, error) {
	return &model.User{ID: id, Nickname: "小陈", Role: model.RoleUser, Status: status}, nil
}

// ----- ModerationReturns / Reports / Notices / Stats -----

func (g *govFakes) DeleteTx(context.Context, pgx.Tx, int64) (*repo.DeletedReturn, error) {
	return g.deletedRet, nil
}

func (g *govFakes) List(context.Context, repo.ReportListFilter) ([]model.ReportRow, int, error) {
	return nil, 0, nil
}

// ResolveTx 按入参回填 ID 和 Status：#49 之后读的每个字段都必须来自这一步的返回值，
// 包括那个「重复处置会在 WHERE status='open' 就失败」的 status。
func (g *govFakes) ResolveTx(_ context.Context, _ pgx.Tx, id, _ int64, status, _ string) (*repo.Resolve, error) {
	r := *g.resolve
	r.ID = id
	r.Status = status
	return &r, nil
}

// InsertTx 是全站唯一的通知出口（ModerationNotices 只有这一条方法）。
// 这里**累加**而不是覆盖：#49 会调两次（先作者/封号那条，再举报人回执），
// 而「两次加起来一共几条、各发给谁」正是这张表要数的那个东西。
func (g *govFakes) InsertTx(_ context.Context, _ pgx.Tx, ns []repo.NewNotice) (int, error) {
	g.notices = append(g.notices, ns...)
	return len(ns), nil
}

func (g *govFakes) Snapshot(context.Context) (*model.Stats, error) { return &model.Stats{}, nil }

// actionLogs 是 ModerationActions（#50 的读接缝）。
//
// 它专门和 govFakes 分开，除了上面说的「List 同名不能重载」，还有一层：
// 这个类型上**没有任何写方法**。操作日志页想往 admin_actions 里补一行，
// 得先给它加一个方法 —— 而加那一个方法会立刻在这份文件外面被看见。
type actionLogs struct{}

func (actionLogs) List(context.Context, repo.AdminActionFilter) ([]model.AdminActionRow, int, error) {
	return nil, 0, nil
}

// newModeration 用同一份 fake 装配出一个完整的治理服务。
//
// uploads 传的是**真的** *Upload（落在 t.TempDir()）而不是又一个 fake：
// #45/#46 在事务提交之后要删磁盘文件，拿真实实现才能顺便证明
// 「文件本来就不存在」不会把一次已经成功的治理动作报成失败（Upload.Remove 那条注释）。
func newModeration(t *testing.T, g *govFakes) *Moderation {
	t.Helper()
	uploads, err := NewUpload(t.TempDir(), "/uploads", testLogger)
	if err != nil {
		t.Fatalf("建临时上传目录失败：%v", err)
	}
	return NewModeration(g, g, g, g, g, g, g, g, actionLogs{}, uploads, testLogger)
}

// ---------- 断言小工具 ----------

// rowsOf 把假事务上收到过的每一次 Exec 解释成一行留痕。
//
// 途中顺手断言 SQL 里带 admin_actions：这个 fake 上只有 Record 会发 Exec，
// 所以「出现了一条别的 SQL」只可能是有人把写操作塞进了留痕函数以外的地方 ——
// 那正是这张表想拦的事，不能靠下标默认它是什么。
func rowsOf(t *testing.T, tx *fakeTx) []recorded {
	t.Helper()
	out := make([]recorded, 0, len(tx.calls))
	for i, c := range tx.calls {
		if !strings.Contains(c.sql, "admin_actions") {
			t.Fatalf("第 %d 条 SQL 不是往 admin_actions 写：%s", i, c.sql)
		}
		out = append(out, mustRecorded(t, tx, i))
	}
	return out
}

// noticeSpec 是一条通知的期望形状。
//
// item 用 0 表示「期望 notifications.item_id 是 NULL」：那不是一个可选值，
// 那是 §3.7 合并规则的另一半 —— 一个作者这次掉了两条以上时，
// 那条通知说的是「你的 2 条帖子被下架」，挂任何一条帖子都是错的。
// 不把它写成期望，就等于只数了条数、没数对内容。
type noticeSpec struct {
	user int64
	typ  string
	item int64
}

// wantRow 是一行留痕的期望。
type wantRow struct {
	action     string
	targetType string
	targetID   int64
}

type writeCase struct {
	name  string
	tweak func(g *govFakes)
	run   func(s *Moderation) error
	// want 是期望新增的留痕行，**按写入顺序**。空切片 = 这是一条只读路由。
	want []wantRow
	// notices 是期望新增的通知，同样按顺序。
	notices []noticeSpec
	// idsLen 非 0 时断言**那一条 item_takedown 留痕**的 detail.ids 长度
	// （批量形状，§13 第 9 步数的那个数字）。它只对下架那一行成立，见下面用例里的注释。
	idsLen int
}

// writeCases 就是计划要的那张表。
//
// 名字里的 #号直接对着 §4 的路由表读，这样「漏了一条路由」这件事
// 在这份文件里是看得出形状缺失的（#9 #10 #11 #12 #35 #36 #37 #43…#50 一段不落），
// 而不是只剩一串意义不明的字符串。
func writeCases() []writeCase {
	ctx := context.Background()
	id := func(v int64) *int64 { return &v }

	return []writeCase{
		// ----- 字典 #9–#12：改的是配置，没有受害者，所以一律 0 条通知 -----
		{
			name: "#9 建分类",
			run: func(s *Moderation) error {
				_, err := s.CreateCategory(ctx, testAdmin, DictInput{Name: "电子设备", Reason: testReason})
				return err
			},
			want: []wantRow{{model.ActionDictCreate, model.TargetCategory, 90}},
		},
		{
			name: "#10 删分类",
			run: func(s *Moderation) error {
				return s.DeleteCategory(ctx, testAdmin, 91, testReason)
			},
			want: []wantRow{{model.ActionDictDelete, model.TargetCategory, 91}},
		},
		{
			name: "#11 建地点",
			run: func(s *Moderation) error {
				_, err := s.CreateLocation(ctx, testAdmin, DictInput{Name: "图书馆一楼", ParentID: id(94), Reason: testReason})
				return err
			},
			want: []wantRow{{model.ActionDictCreate, model.TargetLocation, 95}},
		},
		{
			name: "#12 删地点",
			run: func(s *Moderation) error {
				return s.DeleteLocation(ctx, testAdmin, 96, testReason)
			},
			want: []wantRow{{model.ActionDictDelete, model.TargetLocation, 96}},
		},

		// ----- 只读的三条：一条 SQL 都不该发，一个事务都不该开 -----
		{
			name: "#34 用户列表（只读）",
			run: func(s *Moderation) error {
				_, err := s.ListUsers(ctx, UserListQuery{Page: "1", PageSize: "20"})
				return err
			},
		},
		{
			name: "#37 统计（只读）",
			run: func(s *Moderation) error {
				_, err := s.Stats(ctx)
				return err
			},
		},
		{
			name: "#48 举报待办（只读）",
			run: func(s *Moderation) error {
				_, err := s.ListReports(ctx, ReportListQuery{Page: "1", PageSize: "20"})
				return err
			},
		},
		{
			name: "#50 操作日志（只读）",
			run: func(s *Moderation) error {
				_, err := s.ListActions(ctx, ActionListQuery{Page: "1", PageSize: "20"})
				return err
			},
		},

		// ----- 账号治理 -----
		{
			// 改 role **不发通知**（§3.7 那四种触发里没有它）。
			// 这一条值得写进表而不是只在注释里说：它拦的是「将来有人为了对称好看补一条」。
			name: "#35 改角色",
			run: func(s *Moderation) error {
				_, err := s.SetUserRole(ctx, testAdmin, testTarget, model.RoleAdmin, testReason)
				return err
			},
			want: []wantRow{{model.ActionUserRoleChange, model.TargetUser, testTarget}},
		},
		{
			name: "#36 封号",
			run: func(s *Moderation) error {
				_, err := s.SetUserStatus(ctx, testAdmin, testTarget, model.UserStatusBanned, testReason)
				return err
			},
			want:    []wantRow{{model.ActionUserBan, model.TargetUser, testTarget}},
			notices: []noticeSpec{{testTarget, model.NotificationAdminAction, 0}},
		},
		{
			name: "#36 解封",
			run: func(s *Moderation) error {
				_, err := s.SetUserStatus(ctx, testAdmin, testTarget, model.UserStatusActive, testReason)
				return err
			},
			want:    []wantRow{{model.ActionUserUnban, model.TargetUser, testTarget}},
			notices: []noticeSpec{{testTarget, model.NotificationAdminAction, 0}},
		},
		{
			name: "#47 警告",
			run: func(s *Moderation) error {
				_, err := s.WarnUser(ctx, testAdmin, testTarget, testReason)
				return err
			},
			want:    []wantRow{{model.ActionWarningSent, model.TargetUser, testTarget}},
			notices: []noticeSpec{{testTarget, model.NotificationAdminAction, 0}},
		},

		// ----- 内容治理 -----
		{
			// 三条帖子两个作者 → **1 行**留痕（批量不是一 id 一行）+ **2 条**通知（合并不是一帖一条）。
			// 这两个数字一个是 3 就说明其中一条规则被写歪了。
			name: "#43 批量下架 3 条（2 个作者）",
			run: func(s *Moderation) error {
				_, err := s.TakedownItems(ctx, testAdmin, []int64{101, 102, 103}, testReason)
				return err
			},
			want:    []wantRow{{model.ActionItemTakedown, model.TargetItem, 101}},
			notices: []noticeSpec{{20, model.NotificationAdminAction, 0}, {21, model.NotificationAdminAction, 103}},
			idsLen:  3,
		},
		{
			// 幂等那一支：库里 0 行被改动时留痕**照写**，通知**不发**。
			// 「管理员点了下架、结果什么都没有」这件事也要能被追责，
			// 而给他发一条「你的帖子被下架了」的假通知是不可接受的。
			name:  "#43 批量下架（全部已经是 deleted）",
			tweak: func(g *govFakes) { g.takedownRows = nil },
			run: func(s *Moderation) error {
				_, err := s.TakedownItems(ctx, testAdmin, []int64{101, 102, 103}, testReason)
				return err
			},
			want:    []wantRow{{model.ActionItemTakedown, model.TargetItem, 101}},
			notices: nil,
			idsLen:  3,
		},
		{
			// 恢复**不发通知**（§3.7 四种触发里没有它，而且那是好消息）。
			name: "#44 恢复帖子",
			run: func(s *Moderation) error {
				_, err := s.RestoreItem(ctx, testAdmin, 101, testReason)
				return err
			},
			want: []wantRow{{model.ActionItemRestore, model.TargetItem, 101}},
		},
		{
			name: "#45 删图",
			run: func(s *Moderation) error {
				return s.DeleteImage(ctx, testAdmin, 5, testReason)
			},
			want:    []wantRow{{model.ActionImageTakedown, model.TargetItemImage, 5}},
			notices: []noticeSpec{{20, model.NotificationAdminAction, 7}},
		},
		{
			// 通知只发**提交人**（他是被处置的那个人），发帖人不发。
			// 期望列表里没有 21 号之外的收件人，这一点是写死的。
			name: "#46 删归还确认",
			run: func(s *Moderation) error {
				return s.DeleteReturn(ctx, testAdmin, 3, testReason)
			},
			want:    []wantRow{{model.ActionReturnTakedown, model.TargetItemReturn, 3}},
			notices: []noticeSpec{{21, model.NotificationAdminAction, 7}},
		},

		// ----- #49 处置举报：三种 resolution 的留痕条数不同，这张表存在的最大理由 -----
		{
			// 2 行：连带下架的 item_takedown + 这次处置本身的 report_resolved。
			// 顺序是先连带后处置（moderation.go 里那个 switch 在 Record 之前）。
			name: "#49 处置举报（takedown，2 行）",
			tweak: func(g *govFakes) {
				g.takedownRows = []repo.TakenRow{{ItemID: 7, UserID: 20}}
			},
			run: func(s *Moderation) error {
				_, err := s.ResolveReport(ctx, testAdmin, 5, ResolveInput{
					Resolution: model.ReportResolutionTakedown, Reason: testReason, Note: "已核实是广告"})
				return err
			},
			want: []wantRow{
				{model.ActionItemTakedown, model.TargetItem, 7},
				{model.ActionReportResolved, model.TargetReport, 5},
			},
			// 作者那条在前（admin_action，挂在那条帖子上），两个举报人各一条回执在后。
			// ⚠ 这一列里**没有**被举报人以外的任何人，也没有「被举报」这个动作的收件人 ——
			// 回执只发给举报人，被举报人收到的那条是 admin_action（说的是帖子没了，不是有人举报了他）。
			notices: []noticeSpec{
				{20, model.NotificationAdminAction, 7},
				{11, model.NotificationReportResolved, 7},
				{12, model.NotificationReportResolved, 7},
			},
			idsLen: 1,
		},
		{
			// 2 行：user_ban + report_resolved。封的是那条帖子的作者（OwnerTx 给的 20 号），
			// 不是举报人、也不是被举报的那个 report 行。
			name: "#49 处置举报（ban，2 行）",
			run: func(s *Moderation) error {
				_, err := s.ResolveReport(ctx, testAdmin, 5, ResolveInput{
					Resolution: model.ReportResolutionBan, Reason: testReason})
				return err
			},
			want: []wantRow{
				{model.ActionUserBan, model.TargetUser, 20},
				{model.ActionReportResolved, model.TargetReport, 5},
			},
			notices: []noticeSpec{
				{20, model.NotificationAdminAction, 0},
				{11, model.NotificationReportResolved, 7},
				{12, model.NotificationReportResolved, 7},
			},
		},
		{
			// 1 行：dismiss **什么都不动**，但照样回话。
			// 这一条是这个系统里最容易写坏的地方 —— 「未采纳」看起来像没做事，
			// 于是有人会顺手把回执也省掉；省掉的那次，用户下次就不举报了。
			name: "#49 处置举报（dismiss，1 行）",
			run: func(s *Moderation) error {
				_, err := s.ResolveReport(ctx, testAdmin, 5, ResolveInput{
					Resolution: model.ReportResolutionDismiss, Reason: testReason})
				return err
			},
			want: []wantRow{{model.ActionReportResolved, model.TargetReport, 5}},
			notices: []noticeSpec{
				{11, model.NotificationReportResolved, 7},
				{12, model.NotificationReportResolved, 7},
			},
		},
	}
}

// TestEveryAdminWriteIsLogged 是那张表的执行体。
//
// 每个用例查五件事，缺一件都可能让这张表变成走过场：
//  1. admin_actions 新增的**行数**和内容（动作、对象类型、对象 id、挂在哪个 admin、理由原文）；
//  2. 通知的条数和**收件人 + 类型 + item_id**；
//  3. 事务恰好开一次、提交一次（写两次的批量动作和「一次调用一行留痕」是同一件事的两面）；
//  4. 只读那几条：一次 Begin 都没有；
//  5. 每一条 admin_action 通知的正文里都能读到 reason 原文（§3.7）。
func TestEveryAdminWriteIsLogged(t *testing.T) {
	cases := writeCases()

	writes := 0
	for _, c := range cases {
		if len(c.want) > 0 {
			writes++
		}
	}
	// 反空转：这张表如果哪天被改成只剩几条只读用例，它会 100% 绿。
	// 14 是「当前有留痕期望的写路由条数」的下界，新增写路由时这里只会更宽松不会更紧。
	if writes < 14 {
		t.Fatalf("表里只剩 %d 条写用例，这张表已经不起作用了", writes)
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			g := newGov()
			if c.tweak != nil {
				c.tweak(g)
			}
			s := newModeration(t, g)

			if err := c.run(s); err != nil {
				t.Fatalf("用例本身失败了：%v", err)
			}

			got := rowsOf(t, g.tx.fakeTx)
			if len(got) != len(c.want) {
				t.Fatalf("admin_actions 应该新增 %d 行，实际 %d 行：%+v", len(c.want), len(got), got)
			}
			for i, w := range c.want {
				r := got[i]
				if r.action != w.action || r.targetType != w.targetType || r.targetID != w.targetID {
					t.Errorf("第 %d 行留痕不对，期望 %s/%s/%d，实际 %s/%s/%d",
						i+1, w.action, w.targetType, w.targetID, r.action, r.targetType, r.targetID)
				}
				if r.adminID != testAdmin {
					t.Errorf("第 %d 行留痕挂在 admin=%d 上，期望 %d", i+1, r.adminID, testAdmin)
				}
				if len(c.want) > 0 && r.reason != testReason {
					t.Errorf("第 %d 行留痕的 reason 应该一字不改是 %q，实际 %q", i+1, testReason, r.reason)
				}
				// ⚠ detail.ids 只属于**批量下架那一行**。#49 的 takedown 会写两行，
				// 第二行 report_resolved 的补充字段是 report_id / resolution / also_closed，
				// 它没有 ids —— 给它配一个 ids 数组等于把「这次处置动了哪些对象」
				// 写成「这次下架动了哪些对象」，§13 第 10 步那条自检 SQL 会查出假的成功。
				_, hasIDs := r.detail["ids"]
				if r.action != model.ActionItemTakedown && hasIDs {
					t.Errorf("第 %d 行留痕（%s）不该带 detail.ids", i+1, r.action)
				}
				if c.idsLen > 0 && r.action == model.ActionItemTakedown {
					ids, ok := r.detail["ids"].([]any)
					if !ok || len(ids) != c.idsLen {
						t.Errorf("第 %d 行留痕的 detail.ids 应该是 %d 个，实际 %#v", i+1, c.idsLen, r.detail["ids"])
					}
					if cnt, _ := r.detail["count"].(float64); int(cnt) != c.idsLen {
						t.Errorf("第 %d 行留痕的 detail.count 应该是 %d，实际 %#v", i+1, c.idsLen, r.detail["count"])
					}
				}
			}

			// 通知：条数、收件人、类型、item_id 四项一起对。
			if len(g.notices) != len(c.notices) {
				t.Fatalf("应该发 %d 条通知，实际 %d 条：%+v", len(c.notices), len(g.notices), g.notices)
			}
			for i, w := range c.notices {
				n := g.notices[i]
				if n.UserID != w.user || n.Type != w.typ {
					t.Errorf("第 %d 条通知不对，期望 发给 %d 的 %s，实际 %d 的 %s",
						i+1, w.user, w.typ, n.UserID, n.Type)
				}
				switch {
				case w.item == 0 && n.ItemID != nil:
					t.Errorf("第 %d 条通知的 item_id 应该是 NULL（合并通知不挂在任何一张帖子上），实际 %d", i+1, *n.ItemID)
				case w.item > 0 && (n.ItemID == nil || *n.ItemID != w.item):
					t.Errorf("第 %d 条通知应该挂帖子 %d，实际 %+v", i+1, w.item, n.ItemID)
				}
				// §3.7：admin_action 那条通知的全部意义就是「告诉他为什么」，
				// 而那个为什么就是 reason 原文。
				if n.Type == model.NotificationAdminAction && !strings.Contains(n.Content, testReason) {
					t.Errorf("第 %d 条 admin_action 通知正文里读不到理由原文 %q：%s", i+1, testReason, n.Content)
				}
			}

			// 事务：写路由一次 Begin + 一次 Commit；只读路由一次都不开。
			wantTx := 0
			if len(c.want) > 0 {
				wantTx = 1
			}
			if g.begins != wantTx {
				t.Errorf("开了 %d 次事务，期望 %d 次", g.begins, wantTx)
			}
			if g.tx.commits != wantTx {
				t.Errorf("提交了 %d 次，期望 %d 次", g.tx.commits, wantTx)
			}
		})
	}
}

// TestTakedownUsesOneSQLForAllIDs 单独存在，因为「一条 SQL 改完所有行」是
// 判据 ① 的实现前提，而上面那张表只数了留痕和通知。
//
// 如果 TakedownTx 被改成循环调用，这张表**不会红**（留痕还是一行、通知还是两条），
// 但日志里会出现 50 条 UPDATE，而其中一条失败时的回滚半径和一次完全不同。
func TestTakedownUsesOneSQLForAllIDs(t *testing.T) {
	g := newGov()
	s := newModeration(t, g)

	ids := make([]int64, 50)
	rows := make([]repo.TakenRow, 50)
	for i := range ids {
		ids[i] = int64(1000 + i)
		// 十个作者，每人五条 —— 通知条数应当是 10 而不是 50。
		rows[i] = repo.TakenRow{ItemID: ids[i], UserID: int64(20 + i%10)}
	}
	g.takedownRows = rows

	res, err := s.TakedownItems(context.Background(), testAdmin, ids, testReason)
	if err != nil {
		t.Fatalf("批量下架失败：%v", err)
	}

	if len(g.takedownIDs) != 1 {
		t.Fatalf("TakedownTx 被调了 %d 次，应该是一次拿到整个数组", len(g.takedownIDs))
	}
	if len(g.takedownIDs[0]) != 50 {
		t.Errorf("那一次调用应该带上全部 50 个 id，实际 %d 个", len(g.takedownIDs[0]))
	}
	if res.TakenDown != 50 {
		t.Errorf("taken_down 应该是 50，实际 %d", res.TakenDown)
	}
	if res.NotifiedUsers != 10 {
		t.Errorf("五十条帖子十个作者，notified_users 应该是 10（§3.7 的合并规则），实际 %d", res.NotifiedUsers)
	}
	if len(g.notices) != 10 {
		t.Errorf("应该只发 10 条通知，实际 %d 条", len(g.notices))
	}
	// 每个作者都是五条，所以**每一条**的 item_id 都必须是 NULL。
	for i, n := range g.notices {
		if n.ItemID != nil {
			t.Errorf("第 %d 条合并通知挂了 item_id=%d，一个作者这次掉了五条，挂哪一条都是错的", i+1, *n.ItemID)
		}
	}
	if got := rowsOf(t, g.tx.fakeTx); len(got) != 1 {
		t.Errorf("五十条帖子也只该有一行留痕，实际 %d 行", len(got))
	}
}

// TestBlankReasonNeverOpensTransaction 是 §12 判据 ④ 的前半段：
// **不填理由时什么都不会发生**，而且「不会发生」要精确到「连事务都没开」。
//
// 为什么盯 Begin 的次数而不是只看返回值：在事务里拦住空理由也能返回同一个 VALIDATION，
// 但那条路的成本是「改了业务行、写不进留痕、再回滚」。对管理员来说响应是一样的，
// 对数据库和排查的人来说完全不一样。
//
// ⚠ #16/#17 那两条走的是 admin_reason 这个字段名（帖子表单里已经有一个叫 reason 的
// 举报理由字段，不能撞），所以它们的用例在 item 那份表里单独测。
func TestBlankReasonNeverOpensTransaction(t *testing.T) {
	cases := []struct {
		name string
		run  func(s *Moderation) error
	}{
		{"#9 建分类", func(s *Moderation) error {
			_, err := s.CreateCategory(context.Background(), testAdmin, DictInput{Name: "电子设备"})
			return err
		}},
		{"#10 删分类", func(s *Moderation) error {
			return s.DeleteCategory(context.Background(), testAdmin, 91, "   ")
		}},
		{"#11 建地点", func(s *Moderation) error {
			_, err := s.CreateLocation(context.Background(), testAdmin, DictInput{Name: "图书馆"})
			return err
		}},
		{"#12 删地点", func(s *Moderation) error {
			return s.DeleteLocation(context.Background(), testAdmin, 96, "\t\u3000")
		}},
		{"#35 改角色", func(s *Moderation) error {
			_, err := s.SetUserRole(context.Background(), testAdmin, testTarget, model.RoleAdmin, "")
			return err
		}},
		{"#36 封号", func(s *Moderation) error {
			_, err := s.SetUserStatus(context.Background(), testAdmin, testTarget, model.UserStatusBanned, "")
			return err
		}},
		{"#43 批量下架", func(s *Moderation) error {
			_, err := s.TakedownItems(context.Background(), testAdmin, []int64{101, 102, 103}, "")
			return err
		}},
		{"#44 恢复", func(s *Moderation) error {
			_, err := s.RestoreItem(context.Background(), testAdmin, 101, "")
			return err
		}},
		{"#45 删图", func(s *Moderation) error {
			return s.DeleteImage(context.Background(), testAdmin, 5, "")
		}},
		{"#46 删归还确认", func(s *Moderation) error {
			return s.DeleteReturn(context.Background(), testAdmin, 3, "")
		}},
		{"#47 警告", func(s *Moderation) error {
			_, err := s.WarnUser(context.Background(), testAdmin, testTarget, "")
			return err
		}},
		{"#49 处置举报", func(s *Moderation) error {
			_, err := s.ResolveReport(context.Background(), testAdmin, 5,
				ResolveInput{Resolution: model.ReportResolutionTakedown})
			return err
		}},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			g := newGov()
			s := newModeration(t, g)

			err := c.run(s)
			if err == nil {
				t.Fatal("空理由竟然通过了校验")
			}
			if !apperr.IsCode(err, apperr.CodeValidation) {
				t.Errorf("应该是 VALIDATION，实际是 %v", err)
			}
			if g.begins != 0 {
				t.Errorf("空理由不该开事务，实际 Begin 了 %d 次", g.begins)
			}
			if len(g.tx.calls) != 0 {
				t.Errorf("空理由不该发出任何 SQL：%+v", g.tx.calls)
			}
			if len(g.notices) != 0 {
				t.Errorf("空理由的情况下发出了 %d 条通知", len(g.notices))
			}
		})
	}
}

// TestLogFailureRollsBackEverything 是判据 ④ 的后半段，也是整个 M6 最该有的一条测试：
// **留痕写不进去，业务就必须不生效**。
//
// 做法是拿上面那张表跑一遍每个写方法，只把假事务的 Exec 换成永远报错。
// 期望三件事同时成立：返回 error、一次 Commit 都没有、Begin 过（说明失败真的发生在事务内部，
// 而不是被入参校验提前挡住了 —— 那种「绿了但什么都没测到」的假阳性靠 Begin 计数区分）。
//
// 这条测试防的实现是真实存在过的诱惑：adminlog 写失败就打个 WARN 然后返回 nil。
// 那样一来每个端点都 200，帖子照删，账号照封，而 admin_actions 永远是空的 ——
// 「唯一防线是事后可追责」会变成一个看起来完好、实际上什么都不追得着的表。
func TestLogFailureRollsBackEverything(t *testing.T) {
	boom := errors.New("admin_actions 写不进去（假事务）")

	for _, c := range writeCases() {
		if len(c.want) == 0 {
			continue
		}
		t.Run(c.name, func(t *testing.T) {
			g := newGov()
			if c.tweak != nil {
				c.tweak(g)
			}
			g.tx.execErr = boom
			s := newModeration(t, g)

			if err := c.run(s); err == nil {
				t.Fatal("留痕写失败却返回了成功：调用方会以为这次治理动作完成了")
			}
			if g.begins == 0 {
				t.Fatal("一次事务都没开，说明这次调用什么都没做就返回了错误 —— 这条用例没有覆盖到回滚")
			}
			if g.tx.commits != 0 {
				t.Errorf("留痕失败之后提交了 %d 次，业务改动会带着空的问责记录落库", g.tx.commits)
			}
			// 通知和留痕在同一个事务里：没提交就等于一条都没发出去。
			// 这里查的是「发过几条」这个累计值，所以它还活着 —— 真正的保证来自
			// 上面那句 commits==0，这一句只是把那件事在通知上也确认一遍。
			if g.tx.rollbacks == 0 {
				t.Errorf("一次回滚都没有：runInTx 的 defer 丢了？")
			}
		})
	}
}

// TestReadRoutesWriteNothing 把表里那四条只读用例单独再钉一遍。
//
// 为什么不嫌重复：上面那张表对只读用例只断言了「留痕 0 行」，
// 而 #50 那条路上真正的风险是**有人在读日志的接缝上顺手补写一行**
// （比如给每次查看加一条浏览记录）。这一条把「SQL 都没发过」写成期望。
func TestReadRoutesWriteNothing(t *testing.T) {
	for _, c := range writeCases() {
		if len(c.want) > 0 {
			continue
		}
		t.Run(c.name, func(t *testing.T) {
			g := newGov()
			if err := c.run(newModeration(t, g)); err != nil {
				t.Fatalf("只读路由返回了错误：%v", err)
			}
			if g.begins != 0 || len(g.tx.calls) != 0 || len(g.notices) != 0 {
				t.Errorf("只读路由动了写路径：begin=%d exec=%d notices=%d", g.begins, len(g.tx.calls), len(g.notices))
			}
		})
	}
}

// TestReportedUserIsNeverNotifiedByResolve 单独把风险 13 的那半句钉住：
// **被举报的人永远不知道自己被举报过**。
//
// 上面那张表用「通知列表里只有作者 + 两个举报人」这个形状覆盖了它，
// 但形状对了不代表措辞安全：如果回执文案里写了「有人举报了你」或者
// 「你的帖子因被举报而下架」，那条通知就从「事实」变成了「指控」，
// 而举报会变成互相攻击的工具。这里断言的是正文里的字。
//
// 三种 resolution 都要测：dismiss 那条尤其容易写坏，
// 因为「未采纳」的补充说明（note）是管理员自由文本，最容易被写成「查过了没问题，下次别乱举报」。
func TestReportedUserIsNeverNotifiedByResolve(t *testing.T) {
	resolutions := []string{
		model.ReportResolutionTakedown, model.ReportResolutionBan, model.ReportResolutionDismiss,
	}
	for _, res := range resolutions {
		t.Run(res, func(t *testing.T) {
			g := newGov()
			g.takedownRows = []repo.TakenRow{{ItemID: 7, UserID: 20}}
			s := newModeration(t, g)

			_, err := s.ResolveReport(context.Background(), testAdmin, 5,
				ResolveInput{Resolution: res, Reason: testReason, Note: "已核实"})
			if err != nil {
				t.Fatalf("处置失败：%v", err)
			}

			for i, n := range g.notices {
				if strings.Contains(n.Content, "举报了你") || strings.Contains(n.Content, "被人举报") {
					t.Errorf("第 %d 条通知把「被举报」这件事说给了不该知道的人：%s", i+1, n.Content)
				}
				// 作者（20 号）只能收到 admin_action；举报人才是 report_resolved。
				// 这一句拦的是「顺手给被处置的人也发一条回执」那一次的改动。
				if n.UserID == 20 && n.Type == model.NotificationReportResolved {
					t.Errorf("给被处置的人（20 号）发了 report_resolved：%s", n.Content)
				}
				if n.UserID == 11 || n.UserID == 12 {
					if n.Type != model.NotificationReportResolved {
						t.Errorf("给举报人（%d 号）发的类型应该是 report_resolved，实际 %s", n.UserID, n.Type)
					}
					if !strings.Contains(n.Content, "已处理") {
						t.Errorf("回执里没有把结论说清楚：%s", n.Content)
					}
				}
			}
		})
	}
}
