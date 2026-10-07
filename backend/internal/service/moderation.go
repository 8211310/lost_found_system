package service

import (
	"context"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"lostfound/internal/apperr"
	"lostfound/internal/model"
	"lostfound/internal/repo"
)

// 这个文件是 M6 的心脏：**所有治理写入动作**（#9–#12、#35、#36、#43–#47、#49）。
//
// ## 为什么事务住在 service 而不是 repo
//
// M2–M5 的每一个事务都在 repo 里面（`repo.ItemReturn.Confirm` 那种），
// 因为那些事务属于「一件事」，而那件事就是一条 SQL 或两条紧挨着的 SQL。
// M6 不一样：一次下架要做**四件事**——改 N 行 items、写 1 行 admin_actions、
// 按作者分组合并成 N 条通知、再 INSERT 那几条通知。把它们塞进 repo 的某一个方法，
// 就等于让 `repo.Item` 同时会写 items、admin_actions 和 notifications，
// 而「哪个 repo 能写哪张表」这条边界一旦糊掉，§10 第①层那些
// 「fake 只实现三个方法就能顶住整个服务」的测试就再也写不出来了。
//
// 所以计划 §15 定的是：**每个治理方法第一行 BeginTx、最后一行 Commit，
// 留痕和通知都夹在中间**。repo 只提供收 `pgx.Tx` 的写入原语
// （`TakedownTx` / `SetStatusTx` / `InsertTx` …），谁都不自己开事务。
//
// ## 为什么留痕和通知必须在同一个事务里（§12 判据 ④）
//
// `adminlog.Record` 的第二个参数是 `pgx.Tx`，`repo.Notification.InsertTx` 也是 ——
// 两个都不是 pool。也就是说「帖子删了、留痕没写」和「帖子删了、没人被通知」
// 这两种状态在**类型上写不出来**。这不是形式主义：那条链子的终点是
// 「谁删的那 50 条帖子、为什么删」，查不出来这一整套治理就归零了（风险 14）。
//
// ## 为什么通知文案的拼装住在这里
//
// `notifications.content` 是 VARCHAR(500)，而 §3.7 要求 reason **原文**出现在通知里。
// 撞上限时得到的是 SQLSTATE 22001，而 `TranslateConstraint` 不认它 —— 那会变成一次 500，
// 并且因为 22001 出现在事务中间，**整个下架操作会被回滚**：管理员看到报错，
// 以为什么都没做，而通知可能已经写进去了一半。所以长度必须在这里算清楚，
// 让数据库那一趟只负责「写已经确定的字符串」（repo 那边那段注释指的就是这一句）。

// TxStarter 是「开一个事务」这一件事需要的全部能力。
//
// `*pgxpool.Pool` 天然满足它（`Begin(ctx) (pgx.Tx, error)`），装配时直接把 pool 传进来。
// 单独定一个一方法接口的理由和 §10 说的所有接缝一样：第①层的 fake 只要能返回一个
// 假 tx 就能让整个 Moderation 跑起来，不需要真的连数据库。
type TxStarter interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// ModerationItems 是治理动作对 items / item_images 需要的写入原语。
//
// ⚠ 四条全部收 pgx.Tx，没有一条有 pool 版本 —— 这个接口形状本身就是
// 「治理写入不可能绕过事务」的证据。
type ModerationItems interface {
	TakedownTx(ctx context.Context, tx pgx.Tx, ids []int64) ([]repo.TakenRow, error)
	RestoreTx(ctx context.Context, tx pgx.Tx, id int64) (int64, error)
	DeleteImageTx(ctx context.Context, tx pgx.Tx, imageID int64) (*repo.DeletedImage, error)
	OwnerTx(ctx context.Context, tx pgx.Tx, itemID int64) (int64, error)
}

// ModerationDict 是字典增删（#9–#12）需要的写入原语。
type ModerationDict interface {
	CreateCategoryTx(ctx context.Context, tx pgx.Tx, p repo.NewDictRow) (*model.Category, error)
	CreateLocationTx(ctx context.Context, tx pgx.Tx, p repo.NewDictRow) (*model.Location, error)
	DeleteCategoryTx(ctx context.Context, tx pgx.Tx, id int64) (*model.Category, error)
	DeleteLocationTx(ctx context.Context, tx pgx.Tx, id int64) (*model.Location, error)
}

// ModerationUsers 是账号治理需要的能力：列表页读（#34）、两条改（#35/#36）、
// 以及一条**在事务外**的点查 GetByID。
//
// GetByID 只被 #47 警告用，而且只用来判「这个人存在吗」。为什么不在事务里查：
// 那一条 UPDATE 都不做，只是提前把「查无此人」变成 NOT_FOUND 而不是让
// notifications.user_id 的外键（23503）去报一次看不懂的错。
// 事务内读一次、事务外读一次在这里没有区别，因为 users 行的 user_id 永远不会变。
type ModerationUsers interface {
	UserLookup
	ListByFilter(ctx context.Context, f repo.UserFilter) ([]model.User, int, error)
	SetRoleTx(ctx context.Context, tx pgx.Tx, id int64, role string) (*model.User, error)
	SetStatusTx(ctx context.Context, tx pgx.Tx, id int64, status string) (*model.User, error)
}

// ModerationReturns 是 #46 需要的唯一一条原语。
//
// ⚠ 只有删除，没有任何「确认/拒绝」的权力 —— 那是 §1 原则 5 的形状：
// admin 能销毁一条违规的归还记录，但永远不能替发帖人确认归还。
// TestNoAdminCommunityRoutesExist 守的是路由层面，这个接口守的是实现层面。
type ModerationReturns interface {
	DeleteTx(ctx context.Context, tx pgx.Tx, id int64) (*repo.DeletedReturn, error)
}

// ModerationReports 是举报待办（#48）和处置（#49）。
type ModerationReports interface {
	List(ctx context.Context, f repo.ReportListFilter) ([]model.ReportRow, int, error)
	ResolveTx(ctx context.Context, tx pgx.Tx, id, resolvedBy int64, status, note string) (*repo.Resolve, error)
}

// ModerationNotices 只有 InsertTx 一条，而且是**整个治理服务能通知用户的唯一出口**。
//
// 为什么不给一个 pool 版本：那样「处置完成了但回执发出去失败了」就是可写的
// （发通知的 INSERT 落在事务外，回滚不了已下架的帖子）。§3.7 那句
// 「治理动作没有后果，等于没治理」在这里的落点就是这一条接口签名。
type ModerationNotices interface {
	InsertTx(ctx context.Context, tx pgx.Tx, notices []repo.NewNotice) (int, error)
}

// ModerationStats 是 #37 那一页统计。只读，所以收的是 pool 语义的方法。
type ModerationStats interface {
	Snapshot(ctx context.Context) (*model.Stats, error)
}

// ModerationActions 是 #50 操作日志页。
//
// ⚠ 只有 List。写这一张表的路径只有 service/adminlog.Record 那一个函数，
// 这里连「顺手补一行日志」的能力都不提供，免得出现第二个写入方。
type ModerationActions interface {
	List(ctx context.Context, f repo.AdminActionFilter) ([]model.AdminActionRow, int, error)
}

// Moderation 是治理动作的业务对象。
type Moderation struct {
	tx      TxStarter
	items   ModerationItems
	dict    ModerationDict
	users   ModerationUsers
	returns ModerationReturns
	reports ModerationReports
	notices ModerationNotices
	stats   ModerationStats
	logs    ModerationActions

	// uploads 用来在事务**提交之后**删掉磁盘上的图片文件。
	// 只有 #45 和 #46 用得到，而那两条的删文件失败只记 WARN，见下面那两段注释。
	uploads *Upload

	logger *slog.Logger
}

func NewModeration(tx TxStarter, items ModerationItems, dict ModerationDict, users ModerationUsers,
	returns ModerationReturns, reports ModerationReports, notices ModerationNotices,
	stats ModerationStats, logs ModerationActions, uploads *Upload, logger *slog.Logger) *Moderation {

	if logger == nil {
		logger = slog.Default()
	}
	return &Moderation{
		tx: tx, items: items, dict: dict, users: users, returns: returns,
		reports: reports, notices: notices, stats: stats, logs: logs,
		uploads: uploads, logger: logger,
	}
}

// ---------- 事务骨架 ----------

// runInTx 是「一个方法里所有写入必须同生同死」这个外壳的唯一实现。
//
// 为什么包成函数而不是在每个方法里手写五遍：那五遍里最容易写错的是
// 「fn 报错之后有没有真的回滚」和「commit 失败还返不返回错误」。
// 收在一处，这两件事只被证明一次。
//
// `where` 只出现在那两条 Internal 的错误文本里（"service.Moderation 开事务失败"），
// 它不是给逻辑用的：本函数被 Moderation 和 Item 两个服务共用（§12 M6 要给 #16/#17 的
// admin 分支补留痕，那两条路径也必须开事务），而日志里分清是谁开的值是排查的前提。
//
// `defer tx.Rollback` 在 commit 成功之后也会跑，那是安全的：pgx 对已提交的 tx
// 调 Rollback 返回 ErrTxClosed，而这里刻意不看它的返回值 —— 事务已经结束了，
// 此时唯一可能存在的问题（连接已经断了）我们既无法补救也不该补救，
// 把它报成一次 500 反而会让用户以为「操作没成功」，而它成功了。
func runInTx(ctx context.Context, starter TxStarter, where string, fn func(pgx.Tx) error) error {
	tx, err := starter.Begin(ctx)
	if err != nil {
		return apperr.Internal(fmt.Errorf("%s 开事务失败: %w", where, err))
	}
	defer tx.Rollback(ctx) //nolint:errcheck // 见上面那段

	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return apperr.Internal(fmt.Errorf("%s 提交失败: %w", where, err))
	}
	return nil
}

func (s *Moderation) withTx(ctx context.Context, fn func(pgx.Tx) error) error {
	return runInTx(ctx, s.tx, "service.Moderation", fn)
}

// logAction 打一条治理动作的日志。每个写方法成功之后打一条。
//
// ⚠ 日志**不是**留痕。留痕在 admin_actions 表里，日志会滚动、会被清掉；
// 所以这里打的字段只为排查方便（request_id + 是谁 + 动了什么），
// 一条都不能少进表的内容 —— 反过来不成立，表里有的这里不必都有。
func (s *Moderation) logAction(ctx context.Context, action string, adminID int64, extra ...slog.Attr) {
	attrs := append([]slog.Attr{slog.String("action", action), slog.Int64("admin_id", adminID)}, extra...)
	s.logger.LogAttrs(ctx, slog.LevelInfo, "admin."+action, attrs...)
}

// ---------- 入参校验 ----------

// maxTakedownIDs 是一次批量下架能带多少个 id。
//
// 数据库没有这个限制，它是**我们自己加的**（同 maxMarkReadIDs 那条理由）：
// 后台一页最多 100 条（maxPageSize），全选也就 100；200 是它的两倍，正常 UI 碰不到。
// 碰得到的是脚本：middleware.MaxBodySize 放行 1MB 的 body，那能塞几万个 id，
// 而 `id = ANY($1::bigint[])` 的代价随数组长度线性涨。
const maxTakedownIDs = 200

// requireReason 把「理由必填」这条纪律落成一句人能读的 VALIDATION。
//
// 这一步必须在 BeginTx **之前**做完，而且每个写方法开头都要做一次调用：
// §12 M6 判据 ④ 断言的是「不带 reason → VALIDATION，**且帖子一条都没被删**」。
// `adminlog.Record` 里那一道同样的检查是**第二道**防线（它保证将来新增的治理路径
// 哪怕忘了查参数也写不进空理由），但它已经在事务中间了 ——
// 靠它拦会留下一次「开了事务又回滚」的浪费，而且报不出是哪个字段。
func requireReason(raw string) (string, error) {
	return requireReasonField("reason", raw)
}

// adminReasonField 是 #16/#17 请求体里那个理由的字段名，和 handler 的 JSON tag 必须一致。
const adminReasonField = "admin_reason"

// requireReasonField 是 requireReason 那两条检查，只是把 field 交给调用方。
//
// 存在的理由只有一个：**#16/#17 的请求体里那一格不叫 reason，叫 admin_reason**
// （handler/item.go 的 AdminReason；帖子表单本身已经有一个叫 reason 的字段了，
// 同名会撞）。而这两条路径上还有另一道检查 authorizeItemWrite，它报的
// 就是 admin_reason —— 如果这里继续写死 reason，同一个表单同一个输入框，
// 「没填」指向 admin_reason、「填太长」指向 reason，前端的高亮会跳到不存在的字段上。
//
// 其余十条 admin 端点的 JSON key 确实叫 reason，所以它们走 requireReason 那个默认值。
func requireReasonField(field, raw string) (string, error) {
	r := strings.TrimSpace(raw)
	if r == "" {
		return "", apperr.Validation("必须填写理由",
			apperr.FieldError{Field: field, Msg: "这个理由会原样出现在被处置用户收到的通知里，也是治理留痕中唯一说明「为什么」的一列"})
	}
	if utf8.RuneCountInString(r) > maxReasonLen {
		return "", apperr.Validation("理由太长了",
			apperr.FieldError{Field: field, Msg: fmt.Sprintf("最多 %d 个字", maxReasonLen)})
	}
	return r, nil
}

// validateDictName 校验 #9/#11 的 name：非空、不超列宽。
//
// 上限来自迁移：categories.name 是 VARCHAR(32)，locations.name 是 VARCHAR(64)。
// 两张表不一样，所以做成参数而不是取个共同的 64 —— 取 64 的话建分类会撞 22001，
// 而那是TranslateConstraint 不认的 SQLSTATE，用户看到的是 500。
// 32 对「学生证、校园卡、水杯、雨伞」这些分类名绰绰有余，卡住的一定是误输入。
func validateDictName(field, name string, max int) (string, error) {
	n := strings.TrimSpace(name)
	if n == "" {
		return "", apperr.Validation(field+" 不能为空",
			apperr.FieldError{Field: field, Msg: "字典条目的名字会直接出现在发帖表单的下拉框里"})
	}
	if utf8.RuneCountInString(n) > max {
		return "", apperr.Validation("名字太长了",
			apperr.FieldError{Field: field, Msg: fmt.Sprintf("最多 %d 个字，当前是 %d 个", max, utf8.RuneCountInString(n))})
	}
	return n, nil
}

// normalizeIDs 把 #43 传来的 id 数组收拾成能进 SQL 的形状：
// 非空、每个都是正整数、**去重**、不超上限。
//
// 去重必须在这里做而不是留给 repo：`repo.Item.TakedownTx` 的存在性预检是拿
// `count(*)` 和 `len(ids)` 比大小的，数组里一个重复的 id 只会命中一行，
// 比出来就是「有帖子不存在」—— 一个假错，而且是最难查的那种（管理员会坚持 id 是对的）。
// 顺带一提，留痕里的 detail.ids 也应当是去重后的那份：§12 判据 ③ 数的是 50，
// 而不是「管理员手滑多点了一次之后的 51」。
func normalizeIDs(ids []int64) ([]int64, error) {
	if len(ids) == 0 {
		return nil, apperr.Validation("没有选择要处理的内容",
			apperr.FieldError{Field: "ids", Msg: "至少要选一条帖子"})
	}
	if len(ids) > maxTakedownIDs {
		return nil, apperr.Validation("一次处理的条数太多了",
			apperr.FieldError{Field: "ids", Msg: fmt.Sprintf("最多 %d 条，当前是 %d 条", maxTakedownIDs, len(ids))})
	}

	out := make([]int64, 0, len(ids))
	seen := make(map[int64]bool, len(ids))
	for _, id := range ids {
		if id <= 0 {
			return nil, apperr.Validation("ids 里有不合法的 id",
				apperr.FieldError{Field: "ids", Msg: fmt.Sprintf("id 必须是正整数，当前有 %d", id)})
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out, nil
}

// oneOf 校验请求体里的枚举字段（role / status / resolution）。
//
// 空串在这里**是错的**：那三个字段都是必填，缺了得报 VALIDATION 并且说清能填什么。
// 查询参数那一类（可选筛选）走 parseEnumParam，别混用。
func oneOf(field, raw string, allowed []string) (string, error) {
	if !slices.Contains(allowed, raw) {
		return "", apperr.Validation(field+" 不对",
			apperr.FieldError{Field: field, Msg: "只能是 " + strings.Join(allowed, " / ") + "，当前是 " + raw})
	}
	return raw, nil
}

var (
	adminRoles   = []string{model.RoleUser, model.RoleAdmin}
	userStatuses = []string{model.UserStatusActive, model.UserStatusBanned}
)

// parseEnumParam 校验**可选**的查询筛选参数：空串 = 不加这条筛选。
//
// 非法值必须报错而不是当成「没有筛选」：管理员在待办页加了 `?status=open ` （尾部一个空格），
// 后端如果宽容地忽略它，他看到的就是一次「筛选生效了」的假象，
// 而真实情况是全表分页。这正是 §10 里那句「看起来 work 的 bug 最难查」。
func parseEnumParam(field, raw string, allowed []string) (string, error) {
	if raw == "" {
		return "", nil
	}
	if !slices.Contains(allowed, raw) {
		return "", apperr.Validation(field+" 不对",
			apperr.FieldError{Field: field, Msg: "只能是 " + strings.Join(allowed, " / ") + "，当前是 " + raw})
	}
	return raw, nil
}

// ---------- 通知文案 ----------

// 通知标题：全部是固定短句，不含任何用户可控文本，所以永远不会撞 VARCHAR(100)。
//
// reason 一律只进 content（VARCHAR(500)），因为 §3.7 要求的是「content 里带原文」，
// 而标题越短越能在手机通知栏里读完 —— 把 500 字的理由塞标题只会得到一句被截断的话。
const (
	noticeTitleTakedown       = "你的帖子被管理员下架"
	noticeTitleImage          = "你的帖子有一张图片被删除"
	noticeTitleReturn         = "你提交的归还确认被删除"
	noticeTitleWarning        = "管理员提醒你"
	noticeTitleBan            = "你的账号已被封禁"
	noticeTitleUnban          = "你的账号已解除封禁"
	noticeTitleReportResolved = "你举报的内容已处理"
)

const (
	maxNoticeTitle   = 100
	maxNoticeContent = 500
)

// noticeAround 把 reason 原文夹在 head 和 tail 之间，并保证整条 content 不超 500 字。
//
// 超长时裁的是 reason，不是句式：head/tail 是「你的 N 条帖子因『…』被下架」里那几个
// 固定的字，裁掉它们会让通知读起来像坏掉了一句半截话；而 reason 少尾巴几个字，
// 读者至少知道「这是那个理由被截断了」。clipRunes 补的那个省略号就是这件事的记号。
//
// 能这么裁的前提是 admin_actions.reason **永远存着全文**（VARCHAR(500)，
// 和 content 同一上限，而 requireReason 已经把 >500 挡成 VALIDATION 了）。
// 也就是说：通知里看不全时，查那一条留痕就看得全 —— 这两处加起来才是完整的。
func noticeAround(head, reason, tail string) string {
	s := head + reason + tail
	if utf8.RuneCountInString(s) <= maxNoticeContent {
		return s
	}
	over := utf8.RuneCountInString(s) - maxNoticeContent
	if utf8.RuneCountInString(reason) > over {
		return head + clipRunes(reason, utf8.RuneCountInString(reason)-over) + tail
	}
	// 走到这里说明 head+tail 本身就把 500 字占满了 —— 现在的四句文案不可能这样，
	// 留着这一支是为了将来谁改文案时不会静默写出一条超长的通知。
	return clipRunes(s, maxNoticeContent)
}

// reportResolvedNotice 拼给举报人的回执。
//
// 措辞纪律（§3.7）：只说**结论**（已下架 / 已封号 / 未采纳），
// 不说被举报人是谁、不给出封号的细节 —— 那两个信息一旦从这条路出去，
// 「举报不会变成互相攻击的工具」这件事就再也没法保证了。
//
// note 是管理员自己填的处置说明（reports.resolved_note），它排在句子最尾，
// 所以超长时整句裁的做法是安全的：先被裁掉的必然是补充说明，
// 而「已处理：已下架」这个结论永远留在句首。
func reportResolvedNotice(outcome, note string) string {
	s := "你举报的内容已处理：" + outcome
	if note != "" {
		s += "。处理说明：" + note
	}
	return clipRunes(s, maxNoticeContent)
}

// ---------- 合并通知的分组 ----------

// authorBatch 是「同一个作者在这次动作里被处置的那几条形」归成一组。
type authorBatch struct {
	UserID  int64
	ItemIDs []int64
}

// groupByAuthor 把批量下架的结果按作者分组，**保持首次出现的顺序**。
//
// 保顺序不是为了好看：一次下架返回的通知条数要能被冒烟测试数出来，
// 而 map 遍历顺序是随机的，用 map 拼出来的 notices 切片每次都不一样，
// 「第一个人是张三」这种断言就会偶发失败。测试偶发失败的结局是有人把它删掉，
// 于是这条测试就不再守 §12 判据 ② 了。
func groupByAuthor(rows []repo.TakenRow) []authorBatch {
	out := []authorBatch{}
	at := make(map[int64]int, len(rows))
	for _, t := range rows {
		i, ok := at[t.UserID]
		if !ok {
			at[t.UserID] = len(out)
			out = append(out, authorBatch{UserID: t.UserID, ItemIDs: []int64{t.ItemID}})
			continue
		}
		out[i].ItemIDs = append(out[i].ItemIDs, t.ItemID)
	}
	return out
}

// takedownNotices 按 §3.7 的合并规则出通知：一个作者一条，不是帖子一条。
//
// ⚠ item_id 只在「这位作者这次只掉了一条」时填。那一条通知说的确实是那张帖子，
// 点进去就该落到那张帖子上；批量那种（「你的 50 条帖子被下架」）挂哪一条都是错的，
// 所以留 NULL —— 前端因此要能处理「admin_action 没有 item_id」这一种，
// 这也是 NotificationView 那两个指针字段的由来。
func takedownNotices(reason string, batches []authorBatch) []repo.NewNotice {
	notices := make([]repo.NewNotice, 0, len(batches))
	for _, b := range batches {
		n := repo.NewNotice{
			UserID:  b.UserID,
			Type:    model.NotificationAdminAction,
			Title:   noticeTitleTakedown,
			Content: noticeAround(fmt.Sprintf("你的 %d 条帖子因『", len(b.ItemIDs)), reason, "』被下架。"),
		}
		if len(b.ItemIDs) == 1 {
			id := b.ItemIDs[0]
			n.ItemID = &id
		}
		notices = append(notices, n)
	}
	return notices
}

// ---------- #9 #11 建字典条目 ----------

// DictInput 是 #9/#11 的请求体（原始值，校验在下面）。
//
// Level 不在这里：那一列由 parent_id 现推（见 repo.resolveLevel），
// 让调用方传它等于给他一个「传一个和 parent_id 互相矛盾的值」的机会。
type DictInput struct {
	Name       string
	ParentID   *int64
	SortOrder  int
	IsFreeform bool
	Reason     string
}

// DictResult 是 #9/#11 的 data：{id, name, level, parent_id}。
//
// ParentID 是指针，JSON 里是 null —— 一级条目**没有**父节点，
// 和「父节点 id 是 0」是两件事，后者会被前端当成一个可以点进去的 id。
type DictResult struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Level    int    `json:"level"`
	ParentID *int64 `json:"parent_id"`
}

// CreateCategory 建一条分类（#9）。#11 同形，只差表名和一列 is_freeform。
//
// 分类名最长 32：那是 categories.name 的列宽（见 validateDictName 那段）。
// sort_order 不设范围校验：那一列是 INT，而它的含义是「同级之间的先后」，
// 由管理员自己排；越界只在有人填了 30 亿的时候才会发生，那时 22003 兜得住。
func (s *Moderation) CreateCategory(ctx context.Context, adminID int64, in DictInput) (*DictResult, error) {
	reason, err := requireReason(in.Reason)
	if err != nil {
		return nil, err
	}
	name, err := validateDictName("name", in.Name, 32)
	if err != nil {
		return nil, err
	}

	var created *model.Category
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		created, err = s.dict.CreateCategoryTx(ctx, tx, repo.NewDictRow{
			ParentID: in.ParentID, Name: name, SortOrder: in.SortOrder,
		})
		if err != nil {
			return err
		}
		return Record(ctx, tx, adminID, model.ActionDictCreate, model.TargetCategory,
			created.ID, reason, dictCreateDetail(name, created.Level, in.ParentID))
	})
	if err != nil {
		return nil, err
	}

	s.logAction(ctx, model.ActionDictCreate, adminID,
		slog.String("target_type", model.TargetCategory),
		slog.Int64("category_id", created.ID))

	return &DictResult{ID: created.ID, Name: created.Name, Level: created.Level, ParentID: created.ParentID}, nil
}

// CreateLocation 建一条地点（#11）。
func (s *Moderation) CreateLocation(ctx context.Context, adminID int64, in DictInput) (*DictResult, error) {
	reason, err := requireReason(in.Reason)
	if err != nil {
		return nil, err
	}
	name, err := validateDictName("name", in.Name, 64)
	if err != nil {
		return nil, err
	}

	var created *model.Location
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		created, err = s.dict.CreateLocationTx(ctx, tx, repo.NewDictRow{
			ParentID: in.ParentID, Name: name, SortOrder: in.SortOrder, IsFreeform: in.IsFreeform,
		})
		if err != nil {
			return err
		}
		return Record(ctx, tx, adminID, model.ActionDictCreate, model.TargetLocation,
			created.ID, reason, dictCreateDetail(name, created.Level, in.ParentID))
	})
	if err != nil {
		return nil, err
	}

	s.logAction(ctx, model.ActionDictCreate, adminID,
		slog.String("target_type", model.TargetLocation),
		slog.Int64("location_id", created.ID))

	return &DictResult{ID: created.ID, Name: created.Name, Level: created.Level, ParentID: created.ParentID}, nil
}

// dictCreateDetail 是 #9/#11 留痕里的 detail。
//
// 带 name 和 level 是因为这一行**后来可能被删掉**，而「他当年建过一个叫什么的大类」
// 是操作日志页要能回答的问题。字典条目不像帖子那样有 is_active 可以留着看。
func dictCreateDetail(name string, level int, parentID *int64) map[string]any {
	d := map[string]any{"name": name, "level": level}
	if parentID != nil {
		d["parent_id"] = *parentID
	}
	return d
}

// DeleteCategory 删一条分类（#10）。#12 同形。
//
// 被挡住的那些情况（还有子节点 / 还被帖子引用）都在 repo 里变成 409 CATEGORY_IN_USE，
// 并且那一句会具体说清是几个子节点、几条帖子 —— 因为管理员接下来要做的事
// 在两种情况下是**相反的**（先删子节点 vs 先处理帖子）。
//
// 留痕必须在删除**之后**、同一个事务里：DeleteTx 用 RETURNING 把被删的那一行交回来，
// 名字只有在那一刻还查得到。
func (s *Moderation) DeleteCategory(ctx context.Context, adminID, id int64, rawReason string) error {
	reason, err := requireReason(rawReason)
	if err != nil {
		return err
	}

	var deleted *model.Category
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		deleted, err = s.dict.DeleteCategoryTx(ctx, tx, id)
		if err != nil {
			return err
		}
		return Record(ctx, tx, adminID, model.ActionDictDelete, model.TargetCategory,
			id, reason, map[string]any{"name": deleted.Name, "level": deleted.Level})
	})
	if err != nil {
		return err
	}

	s.logAction(ctx, model.ActionDictDelete, adminID,
		slog.String("target_type", model.TargetCategory),
		slog.Int64("category_id", id),
		slog.String("name", deleted.Name))
	return nil
}

// DeleteLocation 删一条地点（#12）。
func (s *Moderation) DeleteLocation(ctx context.Context, adminID, id int64, rawReason string) error {
	reason, err := requireReason(rawReason)
	if err != nil {
		return err
	}

	var deleted *model.Location
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		deleted, err = s.dict.DeleteLocationTx(ctx, tx, id)
		if err != nil {
			return err
		}
		return Record(ctx, tx, adminID, model.ActionDictDelete, model.TargetLocation,
			id, reason, map[string]any{"name": deleted.Name, "level": deleted.Level})
	})
	if err != nil {
		return err
	}

	s.logAction(ctx, model.ActionDictDelete, adminID,
		slog.String("target_type", model.TargetLocation),
		slog.Int64("location_id", id),
		slog.String("name", deleted.Name))
	return nil
}

// ---------- #34 #35 #36 账号治理 ----------

// UserListQuery 是 #34 的原始查询参数。
//
// Keyword 对应的 URL 参数是 `?q=`（计划 §4 第 34 行），字段名却写全称：
// handler 那层负责把 q 映射进来，这里保持和 repo.UserFilter 一样的读法，
// 免得看代码的人要在两个名字之间来回换算。
type UserListQuery struct {
	Keyword  string
	Role     string
	Status   string
	Page     string
	PageSize string
}

// ListUsers 是 #34 的用户列表（只读，所以没有事务、没有留痕）。
//
// 返回的是 model.AdminUserView 而不是 UserView：那一页要 status、而**不要**手机号/邮箱
// （见 model/user.go 里那两个结构体的对比注释）。
func (s *Moderation) ListUsers(ctx context.Context, q UserListQuery) (*Page[model.AdminUserView], error) {
	role, err := parseEnumParam("role", q.Role, adminRoles)
	if err != nil {
		return nil, err
	}
	status, err := parseEnumParam("status", q.Status, userStatuses)
	if err != nil {
		return nil, err
	}
	page, pageSize, err := parsePageQuery(PageQuery{Page: q.Page, PageSize: q.PageSize})
	if err != nil {
		return nil, err
	}

	rows, total, err := s.users.ListByFilter(ctx, repo.UserFilter{
		Keyword: strings.TrimSpace(q.Keyword), Role: role, Status: status,
		Page: page, PageSize: pageSize,
	})
	if err != nil {
		return nil, err
	}

	list := make([]model.AdminUserView, 0, len(rows))
	for i := range rows {
		list = append(list, rows[i].AdminView())
	}
	return &Page[model.AdminUserView]{List: list, Total: total, Page: page, PageSize: pageSize}, nil
}

// SetRoleResult 是 #35 的 data：{id, role}。
type SetRoleResult struct {
	ID   int64  `json:"id"`
	Role string `json:"role"`
}

// SetUserRole 改一个人的角色（#35）。
//
// 为什么没有通知：§3.7 把 admin_action 的触发列成四种（下架帖子、删图、删归还确认、警告），
// 封号是 §13 第 9 步额外断言的一种，改 role 不在其中。
// 他也确实不需要通知就知道：#3 GET /api/auth/me 返回的 role 会变，
// 后台入口因此出现或消失 —— 那是他立刻看得见的后果，而通知说的应当是「为什么」。
// 这里刻意**不**为了「对称好看」多发明一种通知：治理文案每多一种就多一处要维护的措辞。
//
// 为什么 detail 里只记改完之后的 role、不记「从什么改成什么」：
// from 只能在事务**外**读到（repo 没有 GetByIDTx），那就不是「这次改动发生的那一刻」
// 的值，而是一个可能已经被另一个 admin 改过的旧快照 —— 写进唯一那本问责台账里比不写更糟。
// 而只记 to 就已经是完整的历史：把同一个人身上几条 user_role_change 按时间排开，
// 上一条的 to 就是下一条的 from。
func (s *Moderation) SetUserRole(ctx context.Context, adminID, userID int64, rawRole, rawReason string) (*SetRoleResult, error) {
	reason, err := requireReason(rawReason)
	if err != nil {
		return nil, err
	}
	role, err := oneOf("role", rawRole, adminRoles)
	if err != nil {
		return nil, err
	}
	// 不能把自己降成普通用户。
	//
	// 这一条不是防 admin 手滑，是防一个**不可恢复**的状态：全站只剩一个 admin 的人
	// 把自己降下去之后，没有任何账号还能调 #35 把自己提回来 —— 那个端点本身要求 admin。
	// 数据库里没有任何别的接口能改 role（风险 14 说的「唯一防线是事后可追责」正是这个意思），
	// 于是只能手工进库改，而那件事对一个不懂 SQL 的维护者来说等于系统坏了。
	if userID == adminID && role != model.RoleAdmin {
		return nil, apperr.Forbidden("不能把自己降为普通用户：降完之后没有人再能把你提回来")
	}

	var updated *model.User
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		updated, err = s.users.SetRoleTx(ctx, tx, userID, role)
		if err != nil {
			return err
		}
		return Record(ctx, tx, adminID, model.ActionUserRoleChange, model.TargetUser,
			userID, reason, map[string]any{"role": updated.Role})
	})
	if err != nil {
		return nil, err
	}

	s.logAction(ctx, model.ActionUserRoleChange, adminID,
		slog.Int64("target_user_id", userID),
		slog.String("role", updated.Role))
	return &SetRoleResult{ID: updated.ID, Role: updated.Role}, nil
}

// SetStatusResult 是 #36 的 data：{id, status}。
type SetStatusResult struct {
	ID     int64  `json:"id"`
	Status string `json:"status"`
}

// SetUserStatus 封号 / 解封（#36）。
//
// 封号之后那个人手上的旧 token 立刻失效，靠的不是这里做了什么，
// 而是 middleware.JWT 每个请求都重读一行 users —— 这里只负责写下那个事实。
//
// 两种方向**都发通知**：
//   - 封号发（§13 第 9 步专门断言「小陈收到第 2 条 admin_action 通知」）。
//     他确实一时读不到 —— 登录就被拦 —— 但那一行必须写下：等他某天能登录时（申诉、
//     或 admin 解封之后）他看到的是一句「你因为『刷屏』被封过」，而不是莫名其妙的一段空窗期。
//   - 解封也发：他收到的那条通知是「你的账号已解除封禁」，而**同时**他当初被禁的理由
//     也在那条链里（上一条就是）。只发 ban 不发 unban 的话，解封这件事的说明只能靠 admin 另发一次 #47。
func (s *Moderation) SetUserStatus(ctx context.Context, adminID, userID int64, rawStatus, rawReason string) (*SetStatusResult, error) {
	reason, err := requireReason(rawReason)
	if err != nil {
		return nil, err
	}
	status, err := oneOf("status", rawStatus, userStatuses)
	if err != nil {
		return nil, err
	}
	// 和 #35 同一条不可恢复论证：被封的人自己解不开，旧 token 也进不来（中间件按 status 拦），
	// 所以「封自己」一旦发生就没有任何 admin 路径能挽回。
	if userID == adminID {
		return nil, apperr.Forbidden("不能修改自己的账号状态：封掉自己之后没有人能把你解封")
	}

	ban := status == model.UserStatusBanned
	action := model.ActionUserUnban
	if ban {
		action = model.ActionUserBan
	}

	err = s.withTx(ctx, func(tx pgx.Tx) error {
		updated, err := s.users.SetStatusTx(ctx, tx, userID, status)
		if err != nil {
			return err
		}
		if err := Record(ctx, tx, adminID, action, model.TargetUser,
			userID, reason, map[string]any{"status": updated.Status}); err != nil {
			return err
		}
		notice := repo.NewNotice{
			UserID:  userID,
			Type:    model.NotificationAdminAction,
			Title:   noticeTitleBan,
			Content: noticeAround("你的账号因『", reason, "』被封禁。"),
		}
		if !ban {
			notice.Title = noticeTitleUnban
			notice.Content = noticeAround("你的账号已解除封禁。管理员留下的说明：『", reason, "』")
		}
		_, err = s.notices.InsertTx(ctx, tx, []repo.NewNotice{notice})
		return err
	})
	if err != nil {
		return nil, err
	}

	s.logAction(ctx, action, adminID,
		slog.Int64("target_user_id", userID),
		slog.String("status", status))
	return &SetStatusResult{ID: userID, Status: status}, nil
}

// ---------- #37 统计 ----------

// Stats 是 #37 那一页全站计数（只读，一条 SQL）。
func (s *Moderation) Stats(ctx context.Context) (*model.StatsView, error) {
	st, err := s.stats.Snapshot(ctx)
	if err != nil {
		return nil, err
	}
	v := st.View()
	return &v, nil
}

// ---------- #43 批量下架 ----------

// TakedownResult 是 #43 的 data：{taken_down, notified_users}。
//
// 两个数**可以不相等**，而且相等反而是巧合：taken_down 是「有多少条帖子从非 deleted
// 变成了 deleted」，notified_users 是「有多少个作者收到了一条合并后的通知」。
// 五个作者的五十条 spam → 50 / 5。这两个数分开返回，管理员才知道
// 「我删的东西」和「被告知的人」各是多少（只返回一个的话，另一半只能猜）。
type TakedownResult struct {
	TakenDown     int `json:"taken_down"`
	NotifiedUsers int `json:"notified_users"`
}

// TakedownItems 批量下架（#43）。
//
// 「批量」这个词在这里有两处落点，都不是顺手为之：
//   - **一条 SQL** 改完所有行（repo.TakedownTx 用 `id = ANY($1::bigint[])`），
//     而不是循环发 50 条 UPDATE —— 50 次往返之外，debug 日志里那 50 行 SQL
//     会让看的人分不清哪一条对应哪个失败。
//   - **一个作者一条通知**（§3.7 的合并规则），50 条 spam 帖给 50 条通知
//     等于把治理动作变成对那个人的二次骚扰，而且他会立刻学会「举报没用」。
//
// taken_down 是 0 也是成功：那意味着这批 id 全都已经是 deleted（比如管理员刷新了
// 待办页又点了一次）。这里不报「没有可下架的内容」那种错，因为它是幂等，不是失败。
func (s *Moderation) TakedownItems(ctx context.Context, adminID int64, rawIDs []int64, rawReason string) (*TakedownResult, error) {
	reason, err := requireReason(rawReason)
	if err != nil {
		return nil, err
	}
	ids, err := normalizeIDs(rawIDs)
	if err != nil {
		return nil, err
	}

	var taken, notified int
	if err := s.withTx(ctx, func(tx pgx.Tx) error {
		var err error
		taken, notified, err = s.takedownInTx(ctx, tx, adminID, ids, reason, nil)
		return err
	}); err != nil {
		return nil, err
	}

	s.logAction(ctx, model.ActionItemTakedown, adminID,
		slog.Int("requested", len(ids)),
		slog.Int("taken_down", taken),
		slog.Int("notified_users", notified))

	return &TakedownResult{TakenDown: taken, NotifiedUsers: notified}, nil
}

// takedownInTx 是「下架这批帖子」这件事的**唯一**实现，被 #43 和 #49 的 takedown 分支共用。
//
// 计划 §4 第 793 行那句「`resolution=takedown` → 连带下架被举报的帖子（等于调 #43 的逻辑）」
// 在这里是字面意义的同一段代码：两条路径的留痕形状（RecordBatch → detail.ids）、
// 通知文案、按作者合并的规则全都一样。写成两份的话，
// §13 第 10 步那条 `a.detail->'ids' @> to_jsonbe(i.id)` 自检 SQL 就只有一半的 deleted 行能被追溯到。
//
// detail 是给留痕的补充字段（#49 用它写下「这次下架是由举报 id=… 触发的」），
// 它可以为空但不能包含 ids/count —— RecordBatch 把那两个键写在 extra 之后，
// 就是为了这个参数伪造不出批量形状。
func (s *Moderation) takedownInTx(ctx context.Context, tx pgx.Tx, adminID int64,
	ids []int64, reason string, detail map[string]any) (taken, notified int, err error) {

	rows, err := s.items.TakedownTx(ctx, tx, ids)
	if err != nil {
		return 0, 0, err
	}
	if err := RecordBatch(ctx, tx, adminID, model.ActionItemTakedown, model.TargetItem,
		ids, reason, detail); err != nil {
		return 0, 0, err
	}

	// 一条都没改动时**不发通知、也不数进响应**：这批 id 可能早就被作者自己删了，
	// 那种情况下发「你的帖子被下架了」是一条假通知（他根本没有被这次动作处置）。
	// 留痕还是要写 —— 「管理员点了下架、结果是 0 条」这件事本身也要能被追责。
	if len(rows) == 0 {
		return 0, 0, nil
	}

	n, err := s.notices.InsertTx(ctx, tx, takedownNotices(reason, groupByAuthor(rows)))
	if err != nil {
		return 0, 0, err
	}
	return len(rows), n, nil
}

// TakedownByAdmin 是 #17（DELETE /api/items/:id）那条 admin 分支用的下架入口。
//
// 它只是 takedownInTx 的一层薄壳，存在的意义和那层壳一样：**「admin 让一条帖子消失」
// 这件事只该有一份实现**。#43 批量下架、#49 的连带下架、#17 的 admin 分支三处各写一份的话，
// 就会出现「从后台点的会收到通知、从帖子页点的不会」这种只有用户能发现的差别 ——
// 而 §3.7 那条「被处置的人必须知道为什么」对三处的要求是一模一样的。
//
// 走 #17 而不是只用 #43，是因为前端那条「删除」按钮本来就打在这里，
// 而 admin 在帖子详情页删一条帖子的语义就是「用管理员身份删」，不是「另外开一个后台动作」。
//
// ⚠ 事务由**调用方**开、由调用方提交，所以这个方法收 pgx.Tx。
// 这不是方便，是这一条端点唯一的正确形状：帖子的状态改动、留痕那一行、通知那一行
// 必须一起提交（§12 判据 ④）。它自己 Begin 的话，调用方那半边就在另一个事务里了。
//
// ids 只有一条时也走 RecordBatch，因此 `detail.ids` 恒在 ——
// §13 第 10 步那条「每个 deleted 都能追溯到一次 admin_actions」的自检 SQL
// 靠的就是「不管是单条还是批量，形状都一样」这个前提。
func (s *Moderation) TakedownByAdmin(ctx context.Context, tx pgx.Tx, adminID, itemID int64,
	reason string) (taken, notified int, err error) {
	return s.takedownInTx(ctx, tx, adminID, []int64{itemID}, reason, nil)
}

// ---------- #44 恢复 ----------

// RestoreResult 是 #44 的 data：{id, status}。
type RestoreResult struct {
	ID     int64  `json:"id"`
	Status string `json:"status"`
}

// RestoreItem 把一条被下架的帖子放回广场（#44）。
//
// status 一律回到 open，不是「回到下架之前」—— 库里没存下架之前的状态，
// 那个取舍写在 repo.Item.RestoreTx 的注释里。
//
// 不发通知：§3.7 那四种 admin_action 触发里没有恢复，而且这是**好消息**，
// 作者从 #19「我的发布」里看得见它回来了。为它加一种通知类型等于
// 给治理台账添一条只有 admin 能写的「表扬」。
func (s *Moderation) RestoreItem(ctx context.Context, adminID, itemID int64, rawReason string) (*RestoreResult, error) {
	reason, err := requireReason(rawReason)
	if err != nil {
		return nil, err
	}

	var ownerID int64
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		ownerID, err = s.items.RestoreTx(ctx, tx, itemID)
		if err != nil {
			return err
		}
		return Record(ctx, tx, adminID, model.ActionItemRestore, model.TargetItem,
			itemID, reason, map[string]any{"author_id": ownerID})
	})
	if err != nil {
		return nil, err
	}

	s.logAction(ctx, model.ActionItemRestore, adminID,
		slog.Int64("item_id", itemID),
		slog.Int64("author_id", ownerID))
	return &RestoreResult{ID: itemID, Status: model.ItemStatusOpen}, nil
}

// ---------- #45 删图 ----------

// DeleteImage 删掉别人帖子上的一张图（#45）。
//
// 和 #42（帖主自删）的区别只有两点：这一条要理由、要留痕、要通知帖主，
// 而且**鉴权在路由上**（RequireAdmin）而不是在 service 里比 id。
// 两者都是「只删一行 item_images + 磁盘一个文件，绝不动帖子本身」——
// §4 第 799 行那条：真的捡到东西的人不该因为一张照片有问题就丢掉整条帖子。
//
// 磁盘文件在事务**提交之后**才删，失败只记 WARN（和 #42 同一个取舍）：
// 先删文件后删库会留下「库里有行、文件没了」的碎图，那比一个没人看得见的孤儿文件糟糕得多。
func (s *Moderation) DeleteImage(ctx context.Context, adminID, imageID int64, rawReason string) error {
	reason, err := requireReason(rawReason)
	if err != nil {
		return err
	}

	var d *repo.DeletedImage
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		d, err = s.items.DeleteImageTx(ctx, tx, imageID)
		if err != nil {
			return err
		}
		if err := Record(ctx, tx, adminID, model.ActionImageTakedown, model.TargetItemImage,
			imageID, reason, map[string]any{"item_id": d.ItemID}); err != nil {
			return err
		}
		_, err = s.notices.InsertTx(ctx, tx, []repo.NewNotice{{
			UserID:  d.UserID,
			Type:    model.NotificationAdminAction,
			Title:   noticeTitleImage,
			Content: noticeAround("你一条帖子里的 1 张图片因『", reason, "』被管理员删除。帖子本身没有被下架。"),
			ItemID:  &d.ItemID,
		}})
		return err
	})
	if err != nil {
		return err
	}

	if err := s.uploads.Remove(d.Path); err != nil {
		s.logger.WarnContext(ctx, "admin.image_orphaned",
			slog.Int64("image_id", imageID),
			slog.String("path", d.Path),
			slog.String("err", err.Error()))
	}

	s.logAction(ctx, model.ActionImageTakedown, adminID,
		slog.Int64("image_id", imageID),
		slog.Int64("item_id", d.ItemID),
		slog.Int64("author_id", d.UserID))
	return nil
}

// ---------- #46 删归还确认 ----------

// DeleteReturn 删掉一条刷出来的归还确认（#46）。
//
// ⚠ 这是「admin 对归还流程唯一能做的事」。它删除一行**违规记录**，
// 而确认/拒绝那两种动作（#25/#26）对 admin 一律 FORBIDDEN，
// 而且拦住它们的不是这个文件，是 service/item_return.go 里那个只看 id 相等、
// 一次都不读 role 的 authorizeReturnDecision。
//
// 被删的人有两种：提交人（他的确认没了）—— 通知发给他，见 §3.7 那句
// 「admin_action 发给被处置的那个人」。发帖人不发：那条待办在他列表里凭空消失
// 确实有点奇怪，但「有人替你删掉了骚扰你的假确认」这件事没有需要他做的下一步，
// 而 §3.7 的四种触发里也没有这一种。
func (s *Moderation) DeleteReturn(ctx context.Context, adminID, returnID int64, rawReason string) error {
	reason, err := requireReason(rawReason)
	if err != nil {
		return err
	}

	var d *repo.DeletedReturn
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		d, err = s.returns.DeleteTx(ctx, tx, returnID)
		if err != nil {
			return err
		}
		if err := Record(ctx, tx, adminID, model.ActionReturnTakedown, model.TargetItemReturn,
			returnID, reason, map[string]any{
				"item_id":         d.ItemID,
				"submitter_id":    d.SubmitterID,
				"previous_status": d.Status,
			}); err != nil {
			return err
		}
		_, err = s.notices.InsertTx(ctx, tx, []repo.NewNotice{{
			UserID:   d.SubmitterID,
			Type:     model.NotificationAdminAction,
			Title:    noticeTitleReturn,
			Content:  noticeAround("你提交的一条归还确认因『", reason, "』被管理员删除。"),
			ItemID:   &d.ItemID,
			ReturnID: &d.ID,
		}})
		return err
	})
	if err != nil {
		return err
	}

	// 凭证图同样在提交之后删：那一行没了，路径就再也查不出来了（repo 那边
	// 特意 RETURNING 了它）。空串要跳过 —— 它是 item_returns.proof_image_path 的合法值，
	// 而 os.Remove("") 报的不是 ErrNotExist 而是一个看不懂的 EINVAL。
	if d.ProofImagePath != "" {
		if err := s.uploads.Remove(d.ProofImagePath); err != nil {
			s.logger.WarnContext(ctx, "admin.return_proof_orphaned",
				slog.Int64("return_id", returnID),
				slog.String("path", d.ProofImagePath),
				slog.String("err", err.Error()))
		}
	}

	s.logAction(ctx, model.ActionReturnTakedown, adminID,
		slog.Int64("return_id", returnID),
		slog.Int64("item_id", d.ItemID),
		slog.Int64("submitter_id", d.SubmitterID),
		slog.String("previous_status", d.Status))
	return nil
}

// ---------- #47 警告 ----------

// WarnResult 是 #47 的 data：{id, notified}。
//
// notified 是**恒为 true 的字面量**，不是「真的发出去了」的观测。这一点必须说清，
// 否则它会给人一种虚假的安全感。为什么可以这样：通知的 INSERT 就在同一个事务里，
// 它失败整个请求就报错，于是「返回了 200」和「那一行写进去了」是同一件事。
// 留着这个字段而不是只返回 {id}，是因为前端需要一个成功标记来点亮那条提示，
// 而让前端猜「200 就是送到了」不如后端明说一句。
type WarnResult struct {
	ID       int64 `json:"id"`
	Notified bool  `json:"notified"`
}

// WarnUser 给一个人发一条警告通知（#47）。
//
// 它是「封号之前那一步」：§12 那句「警告要真的送到」。除了 notifications 一行
// 和 admin_actions 一行之外**什么都不做** —— 不扣分、不改状态、不限制任何功能。
// 这个「零自动后果」和举报（#41）是同一条纪律：平台记录事实，不替人做判定，
// 警告的全部力量在于那句话被送达到，而不是在于它挂着一个小鞭子。
func (s *Moderation) WarnUser(ctx context.Context, adminID, userID int64, rawReason string) (*WarnResult, error) {
	reason, err := requireReason(rawReason)
	if err != nil {
		return nil, err
	}

	// 存在性检查在事务外：这一条读不改任何东西，而它能提前把「查无此人」变成
	// NOT_FOUND。少了它，那个不存在的 id 会撞上 notifications.user_id 的外键（23503），
	// 报出来是一句和「用户」有关的约束名，而调用方填错的是 URL 里的 :id。
	if _, err := s.users.GetByID(ctx, userID); err != nil {
		return nil, err
	}
	// 警告自己不拦「admin 给自己发」：那是一件无害的事（他自己看得见），
	// 而且封号/降权那两种不可逆的自我伤害已经在 #35/#36 各拦了一次，
	// 把同一条判断机械地抄到每一条治理端点上，只会让将来真要放宽时找不到是哪一条。

	if err := s.withTx(ctx, func(tx pgx.Tx) error {
		if err := Record(ctx, tx, adminID, model.ActionWarningSent, model.TargetUser,
			userID, reason, nil); err != nil {
			return err
		}
		_, err := s.notices.InsertTx(ctx, tx, []repo.NewNotice{{
			UserID:  userID,
			Type:    model.NotificationAdminAction,
			Title:   noticeTitleWarning,
			Content: noticeAround("管理员提醒你：『", reason, "』"),
		}})
		return err
	}); err != nil {
		return nil, err
	}

	s.logAction(ctx, model.ActionWarningSent, adminID, slog.Int64("target_user_id", userID))
	return &WarnResult{ID: userID, Notified: true}, nil
}

// ---------- #48 举报待办 ----------

// ReportListQuery 是 #48 的原始查询参数。
type ReportListQuery struct {
	Status     string
	ReasonCode string
	Page       string
	PageSize   string
}

// ListReports 是 #48 待办列表（只读）。
//
// 这一页是全系统唯一能看到 reporter_id 的地方（§4 第 48 行只给昵称），
// 而它挂在 RequireAdmin 上：被举报人永远不知道自己被举报过这件事（风险 13 的 ②），
// 靠的就是「除了这一页，没有任何接口读得出 reports 表」。
func (s *Moderation) ListReports(ctx context.Context, q ReportListQuery) (*Page[model.ReportView], error) {
	status, err := parseEnumParam("status", q.Status, model.ReportStatuses)
	if err != nil {
		return nil, err
	}
	reasonCode, err := parseEnumParam("reason_code", q.ReasonCode, model.ReportReasonCodes)
	if err != nil {
		return nil, err
	}
	page, pageSize, err := parsePageQuery(PageQuery{Page: q.Page, PageSize: q.PageSize})
	if err != nil {
		return nil, err
	}

	rows, total, err := s.reports.List(ctx, repo.ReportListFilter{
		Status: status, ReasonCode: reasonCode, Page: page, PageSize: pageSize,
	})
	if err != nil {
		return nil, err
	}

	list := make([]model.ReportView, 0, len(rows))
	for i := range rows {
		list = append(list, rows[i].View())
	}
	return &Page[model.ReportView]{List: list, Total: total, Page: page, PageSize: pageSize}, nil
}

// ---------- #49 处置举报 ----------

// ResolveInput 是 #49 的请求体。
type ResolveInput struct {
	Resolution string
	Reason     string
	Note       string
}

// ResolveResult 是 #49 的 data：{id, status, resolved_at}。
//
// status 是 resolved / dismissed 而不是回显 resolution：那两个词回答的是不同的问题 ——
// resolution 是「管理员决定怎么做」，status 是「那一行现在是什么」。
// 前端待办页要按后者决定这条还显不显示，所以必须给后者。
type ResolveResult struct {
	ID         int64  `json:"id"`
	Status     string `json:"status"`
	ResolvedAt string `json:"resolved_at"`
}

// ResolveReport 处置一条举报（#49）。
//
// ## resolution 决定顺手做了什么，但**不决定平台是否认定举报成立**
//
// 三种都会：关掉同帖所有 open 举报 + 给每个举报人发一条回执 + 写留痕。
// 区别只在动不动内容：
//   - takedown → 连带下架那条帖子（走 takedownInTx，和 #43 同一段代码）
//   - ban      → 连带封那条帖子的作者（和 #36 同一句文案，但不走 #36 那个方法，
//     因为它有自己的 reason 语义）
//   - dismiss  → 什么都不动。它**照样**给举报人发回执：§4 第 793 行那句
//     「哪怕结论是『没问题』也要回话，否则用户下次不再举报」。
//
// ## 留痕为什么是 2 行而不是 1 行
//
// §4 第 795 行：takedown / ban 各写 2 行（report_resolved + item_takedown/user_ban），
// dismiss 写 1 行。「谁驳回了这条举报」和「谁删了那条帖子」是两个能分别被追责的问题，
// 合成一行就答不出第二个。TestEveryAdminWriteIsLogged 那张表数的就是这两种。
//
// ## 顺序
//
// 先 ResolveTx：它 WHERE status='open'，重复处置会在那里就失败并回滚，
// 所以「两个人同时点下架」不会把帖子删两次、也不会发两轮通知。
// 这一步必须在所有连带动作**之前**，这是那条规则唯一的保证点。
func (s *Moderation) ResolveReport(ctx context.Context, adminID, reportID int64, in ResolveInput) (*ResolveResult, error) {
	reason, err := requireReason(in.Reason)
	if err != nil {
		return nil, err
	}
	resolution, err := oneOf("resolution", in.Resolution, model.ReportResolutions)
	if err != nil {
		return nil, err
	}
	note := strings.TrimSpace(in.Note)
	if utf8.RuneCountInString(note) > maxReasonLen {
		return nil, apperr.Validation("处置说明太长了",
			apperr.FieldError{Field: "note", Msg: fmt.Sprintf("最多 %d 个字，它会原样出现在举报人收到的通知里", maxReasonLen)})
	}

	status := model.ReportStatusResolved
	if resolution == model.ReportResolutionDismiss {
		status = model.ReportStatusDismissed
	}

	var resolved *repo.Resolve
	var taken, notified int
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		var err error
		resolved, err = s.reports.ResolveTx(ctx, tx, reportID, adminID, status, note)
		if err != nil {
			return err
		}

		// 连带的那件事先做、先留痕：帖子先没了，或者号先封了，
		// 然后才是「谁处置了这条举报」。反过来读起来更像因果，但两行的
		// created_at 在同一个事务里本来就相同，顺序只影响人眼扫过台账时的感受。
		switch resolution {
		case model.ReportResolutionTakedown:
			taken, notified, err = s.takedownInTx(ctx, tx, adminID,
				[]int64{resolved.ItemID}, reason,
				map[string]any{"report_id": resolved.ID, "resolution": resolution})
			if err != nil {
				return err
			}
		case model.ReportResolutionBan:
			ownerID, err := s.items.OwnerTx(ctx, tx, resolved.ItemID)
			if err != nil {
				return err
			}
			banned, err := s.users.SetStatusTx(ctx, tx, ownerID, model.UserStatusBanned)
			if err != nil {
				return err
			}
			if err := Record(ctx, tx, adminID, model.ActionUserBan, model.TargetUser,
				ownerID, reason, map[string]any{
					"status":    banned.Status,
					"report_id": resolved.ID,
					"item_id":   resolved.ItemID,
				}); err != nil {
				return err
			}
			if _, err := s.notices.InsertTx(ctx, tx, []repo.NewNotice{{
				UserID:  ownerID,
				Type:    model.NotificationAdminAction,
				Title:   noticeTitleBan,
				Content: noticeAround("你的账号因『", reason, "』被封禁。"),
			}}); err != nil {
				return err
			}
		}

		closed := make([]int64, 0, len(resolved.AlsoClosed))
		for _, c := range resolved.AlsoClosed {
			closed = append(closed, c.ID)
		}
		if err := Record(ctx, tx, adminID, model.ActionReportResolved, model.TargetReport,
			reportID, reason, map[string]any{
				"report_id":   resolved.ID,
				"resolution":  resolution,
				"also_closed": closed,
			}); err != nil {
			return err
		}

		n, err := s.notices.InsertTx(ctx, tx, reporterNotices(resolved, resolution, note))
		if err != nil {
			return err
		}
		notified += n
		return nil
	})
	if err != nil {
		return nil, err
	}

	s.logAction(ctx, model.ActionReportResolved, adminID,
		slog.Int64("report_id", resolved.ID),
		slog.Int64("item_id", resolved.ItemID),
		slog.String("resolution", resolution),
		slog.Int("also_closed", len(resolved.AlsoClosed)),
		slog.Int("taken_down", taken),
		slog.Int("notified_users", notified))

	return &ResolveResult{
		ID:         resolved.ID,
		Status:     resolved.Status,
		ResolvedAt: resolved.ResolvedAt.UTC().Format(timeLayout),
	}, nil
}

// reporterNotices 给每一个举报人（锚点那条 + 被连带关掉的那些）发一条回执。
//
// ⚠ 这里**没有**被举报人。那条帖子被下架时他收到的是 admin_action（#43 那一路径发的），
// 说的是「你的帖子被下架，理由是…」，而不是「有人举报了你」——
// 后者会把举报变成互相攻击的工具（风险 13）。
//
// 收件人不会重复：同一个人对同一条帖子只能有一条 open 举报（那个部分唯一索引），
// 而锚点行在第一条 UPDATE 之后就不再是 open 了，所以它不会出现在 AlsoClosed 里。
func reporterNotices(r *repo.Resolve, resolution, note string) []repo.NewNotice {
	outcome := "未采纳"
	switch resolution {
	case model.ReportResolutionTakedown:
		outcome = "已下架相关内容"
	case model.ReportResolutionBan:
		outcome = "已封禁发布该内容的账号"
	}
	body := reportResolvedNotice(outcome, note)

	out := make([]repo.NewNotice, 0, 1+len(r.AlsoClosed))
	notice := func(to int64) {
		out = append(out, repo.NewNotice{
			UserID:  to,
			Type:    model.NotificationReportResolved,
			Title:   noticeTitleReportResolved,
			Content: body,
			ItemID:  &r.ItemID,
		})
	}
	notice(r.ReporterID)
	for _, c := range r.AlsoClosed {
		notice(c.ReporterID)
	}
	return out
}

// ---------- #50 操作日志 ----------

// ActionListQuery 是 #50 的原始查询参数。四个筛选全可选。
type ActionListQuery struct {
	AdminID    string
	TargetType string
	TargetID   string
	Action     string
	Page       string
	PageSize   string
}

// ListActions 是 #50 治理留痕页（只读）。
//
// 它是「剩下的唯一防线是事后可追责」（风险 14）那一句话的界面：
// 每一个 admin 都能看见其他 admin 做过什么。**没有任何行被藏起来** ——
// 不筛就是全部，包括做那些动作的账号已经不在了的那些（model.AdminActionView 里
// admin 那一格会是 null，而不是整行消失）。
func (s *Moderation) ListActions(ctx context.Context, q ActionListQuery) (*Page[model.AdminActionView], error) {
	adminID, err := parseIDParam("admin_id", q.AdminID)
	if err != nil {
		return nil, err
	}
	targetID, err := parseIDParam("target_id", q.TargetID)
	if err != nil {
		return nil, err
	}
	targetType, err := parseEnumParam("target_type", q.TargetType, model.TargetTypeValues())
	if err != nil {
		return nil, err
	}
	action, err := parseEnumParam("action", q.Action, model.AdminActionValues())
	if err != nil {
		return nil, err
	}
	page, pageSize, err := parsePageQuery(PageQuery{Page: q.Page, PageSize: q.PageSize})
	if err != nil {
		return nil, err
	}

	f := repo.AdminActionFilter{
		TargetType: targetType,
		Action:     action,
		Page:       page,
		PageSize:   pageSize,
	}
	// repo 那两侧用 0 表示「不加这条 WHERE」，而 parseIDParam 给的是三态指针
	//（nil = 没带参数）。折成 0 而不是把 filter 的字段也改成指针：
	// 这一列不存在 id=0 的行，0 和「没有筛选」在这张表上永远不会混。
	if adminID != nil {
		f.AdminID = *adminID
	}
	if targetID != nil {
		f.TargetID = *targetID
	}

	rows, total, err := s.logs.List(ctx, f)
	if err != nil {
		return nil, err
	}

	list := make([]model.AdminActionView, 0, len(rows))
	for i := range rows {
		list = append(list, rows[i].View())
	}
	return &Page[model.AdminActionView]{List: list, Total: total, Page: page, PageSize: pageSize}, nil
}
