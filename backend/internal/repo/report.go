package repo

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"lostfound/internal/apperr"
	"lostfound/internal/model"
)

// Report 管 reports 表。M4 只写了「插一行」（#41 用户提交举报），
// M6 补上读和推进的那一半（#48 待办列表、#49 处置）。
//
// 这两半分开写不是省事，是 §3.7 的边界：M4 的时候这一层**只有 Create**，
// 所以用户端的 service 无论怎么写都不可能把一条举报标成已处置 ——
// 少一个方法就少一种越权写法。现在 List / ResolveTx 存在了，
// 拦住越权的换成路由上那道 middleware.RequireAdmin。
//
// ⚠ ResolveTx 只收 pgx.Tx、没有 pool 版本，这是刻意的：处置一条举报要同时
// 写 reports、admin_actions、通知（可能还有 items），§15 要求这些要么全成要么全无。
// 如果这里留一个「自己开事务」的版本，service 就有机会把留痕写到事务外面去。
type Report struct {
	pool *pgxpool.Pool
}

func NewReport(pool *pgxpool.Pool) *Report { return &Report{pool: pool} }

// uqReportsOpen 是 000001 迁移第 12 节里那条**部分唯一索引**的名字：
//
//	CREATE UNIQUE INDEX uq_reports_open ON reports(item_id, reporter_id) WHERE status = 'open'
//
// 它是「防刷举报」的全部实现（§14-13 的第 ① 层）：同一个人对同一条帖子
// 只能有一条待处理的举报，反复点不产生第二行。
// 注意是「部分」唯一 —— 处置完（status 变成 resolved/dismissed）之后
// 同一个人可以再举报同一条帖子，这是对的：那条帖子又出问题了。
const uqReportsOpen = "uq_reports_open"

// Create 插入一条 open 举报，返回新行的 id 和 created_at。
//
// status 不在参数里：这一列只有一个合法值（open），由 service 决定而不是由调用方传 ——
// 传了 status 就等于给了任何调用方「直接把举报标成已处置」的能力。
//
// ⚠ 撞 uq_reports_open 时返回 **REPORT_DUPLICATE**，而且这个判断必须排在
// TranslateConstraint 之前：那个函数把所有 23505 一律翻成 CONFLICT，
// 而 CONFLICT 是「内容和已有记录冲突」这种通用文案，用户看了不知道该怎么办。
// REPORT_DUPLICATE 是 §8 里给举报专门留的码，前端据此显示「你已经举报过了」。
//
// reason_code 的 CHECK（23514）也在这里兜底，但那是兜底不是主检查 ——
// service 会先按 model.ReportReasonCodes 校验一遍，好给出带字段名的中文提示。
func (r *Report) Create(ctx context.Context, itemID, reporterID int64, reasonCode, detail string) (int64, time.Time, error) {
	var (
		id        int64
		createdAt time.Time
	)
	err := r.pool.QueryRow(ctx, `
		INSERT INTO reports (item_id, reporter_id, reason_code, detail)
		VALUES ($1, $2, $3, $4)
		RETURNING id, created_at`,
		itemID, reporterID, reasonCode, detail).Scan(&id, &createdAt)
	if err != nil {
		var pge *pgconn.PgError
		if errors.As(err, &pge) && pge.Code == pgUniqueViolation && pge.ConstraintName == uqReportsOpen {
			return 0, time.Time{}, apperr.WrapMsg(err, apperr.CodeReportDuplicate,
				"你已经举报过这条帖子了，管理员的处理中")
		}
		if ae := TranslateConstraint(err); ae != nil {
			return 0, time.Time{}, ae
		}
		return 0, time.Time{}, fmt.Errorf("repo.Report.Create (item=%d, reporter=%d): %w", itemID, reporterID, err)
	}
	return id, createdAt, nil
}

// ---------- M6：admin 的那一半（#48 待办列表、#49 处置）----------

// ReportListFilter 是 #48 的查询条件。
//
// Status 和 ReasonCode 都是「空 = 不加这个条件」。注意默认**不限状态**：
// 待办页默认给的是 open（那是 service 填的默认值），但这一层不替他填 ——
// 「默认只看没处理的」是一条业务规则，写进 repo 就没法用同一个函数列出
// 「这个人举报过的所有条目」（将来做不做不知道，但混在一层里一定会后悔）。
type ReportListFilter struct {
	Status     string
	ReasonCode string
	Page       int
	PageSize   int
}

// reportListCols 是 #48 那一页的取列清单。列顺序和 scanReportListRow 是一对。
//
// ⚠ `report_count_on_item` 用相关子查询而不是 JOIN + GROUP BY：
// 后者要在这条分页查询里同时做「按 item 聚合」和「按 reports 行分页」两件事，
// 而分页的单位是**举报行**不是**帖子**（同一条帖子的三条举报要占三行）。
// GROUP BY 会把它们压成一行，翻页数就对不上了。相关子查询逐行算一次计数，
// 有 idx_reports_item 撑着，20 行就是 20 次索引查找。
const reportListCols = `r.id, r.item_id, i.title, i.status, i.user_id,
	r.reporter_id, u.nickname, r.reason_code, r.detail, r.status, r.created_at,
	(SELECT count(*) FROM reports r2
	  WHERE r2.item_id = r.item_id AND r2.status = 'open')  AS open_count_on_item`

const reportListFrom = ` FROM reports r
		 JOIN items i ON i.id = r.item_id
		 JOIN users u ON u.id = r.reporter_id`

// List 分页取举报，最新在前，同时返回不分页的总行数。
//
// 排序是 created_at DESC（新的先看）而不是「被举报次数多的先看」：
// 后者听起来更像「优先级」，但它会把一条挂了 5 次的老举报永远顶在最上面，
// 新来的那条**永远翻不到** —— 而治理里最贵的是时间（一条挂着色情内容的帖子
// 排在哪一页，决定了它还能挂多久）。优先级交给 #48 响应里那个
// report_count_on_item 字段，让前端自己排序、让 admin 自己决定。
func (r *Report) List(ctx context.Context, f ReportListFilter) ([]model.ReportRow, int, error) {
	var (
		conds []string
		args  []any
	)
	if f.Status != "" {
		args = append(args, f.Status)
		conds = append(conds, fmt.Sprintf("r.status = $%d", len(args)))
	}
	if f.ReasonCode != "" {
		args = append(args, f.ReasonCode)
		conds = append(conds, fmt.Sprintf("r.reason_code = $%d", len(args)))
	}
	where := ""
	if len(conds) > 0 {
		where = " WHERE " + strings.Join(conds, " AND ")
	}

	var total int
	if err := r.pool.QueryRow(ctx, `SELECT count(*)`+reportListFrom+where, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("repo.Report.List 计数: %w", err)
	}

	limitIdx, offsetIdx := len(args)+1, len(args)+2
	args = append(args, f.PageSize, (f.Page-1)*f.PageSize)

	// ⚠ 这三样必须**一起**变：where（带着它引用的 $1…）、limitIdx/offsetIdx、args 的尾部。
	// 少插一个 %s 把 where 漏掉，占位符编号并不会跟着变小 —— 于是 LIMIT 写成 $2，
	// 而语句里根本没有 $1。PostgreSQL 在 Parse 阶段就说「could not determine data type
	// of parameter $1」（42P18），报的是一句和筛选无关的话。
	// 更坏的一种可能是它**不报错**：那条查询会返回全站举报，而上面的 count 查询
	// 带着筛选回一个对不上的 total —— 翻页数错、待办队列骗人，还没有任何报错。
	// 所以这一条端点的筛选参数在集成测试里必须**逐条**跑（m6_report_resolve_test.go 的
	// reportQueueIDs），只测「带筛选返回 200」不够。
	rows, err := r.pool.Query(ctx, fmt.Sprintf(
		`SELECT %s%s%s ORDER BY r.created_at DESC, r.id DESC LIMIT $%d OFFSET $%d`,
		reportListCols, reportListFrom, where, limitIdx, offsetIdx), args...)
	if err != nil {
		return nil, 0, fmt.Errorf("repo.Report.List: %w", err)
	}
	defer rows.Close()

	out := []model.ReportRow{}
	for rows.Next() {
		var v model.ReportRow
		if err := scanReportListRow(rows, &v); err != nil {
			return nil, 0, fmt.Errorf("repo.Report.List 扫描一行: %w", err)
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("repo.Report.List 迭代: %w", err)
	}
	return out, total, nil
}

// scanReportListRow 按 reportListCols 的顺序扫一行。
//
// 参数是 pgx.Row 接口而不是 *pgx.Rows：和 scanItemDetailRows 同一个理由 ——
// 列顺序只在这里写一遍，单行查询和结果集迭代共用。
func scanReportListRow(row pgx.Row, v *model.ReportRow) error {
	return row.Scan(&v.ID, &v.ItemID, &v.ItemTitle, &v.ItemStatus, &v.ItemUserID,
		&v.ReporterID, &v.ReporterNickname, &v.ReasonCode, &v.Detail, &v.Status,
		&v.CreatedAt, &v.OpenCountOnItem)
}

// Resolve 是处置一条举报之后从那一行带出来的事实。
//
// 带着 item_id 和 reporter_id 是因为处置**必然**要接着做两件事：
//   - 通知举报人（report_resolved，§3.7：得不到回音的举报人下次就不举报了）
//   - 如果 resolution 是 takedown/ban，被处置的对象挂在**帖子**上，
//     而 ban 的对象是**帖子的作者**，两个都不是 reporter
//
// 这三列都在 UPDATE 的 RETURNING 里一次带出，而不是处置完再 SELECT 一遍：
// 「再查一次」查到的可能已经不是刚才那一行（并发下另一个 admin 也点了处置），
// 而我们写通知要的是**这次处置**对应的那条举报。
type Resolve struct {
	ID         int64
	Status     string
	ReporterID int64
	ItemID     int64
	ResolvedAt time.Time

	// AlsoClosed 是同一条帖子上**被这次处置连带关掉**的其它举报。
	// 计划 §4 第 797 行：「处置一条举报会连带关掉同帖的所有 open 举报，
	// 所有举报人都收到 report_resolved」。因为它们说的是同一条内容，处置一次就够了；
	// 不这么做的话待办队列里会一直挂着已经被处理掉的条目。
	//
	// 这一列必须存在而不是「service 再去查一遍同帖的举报」：service 拿不到那些
	// reporter_id 就没法给每个举报人发回执，而它自己不该写 SQL。
	AlsoClosed []ClosedReport
}

// ClosedReport 是被连带关掉的那一条举报里，service 唯一需要的两列。
type ClosedReport struct {
	ID         int64
	ReporterID int64
}

// ResolveTx 把一条 open 举报推进到 resolved / dismissed，**在调用方的事务里**。
//
// WHERE 里那个 `status = 'open'` 是这一整条端点的灵魂：它让「两个人同时处置同一条举报」
// 变成其中一个人影响 0 行，而 0 行在这里是有名字的（REPORT_ALREADY_RESOLVED）。
// 少了这个条件，两个人各点一次「下架」，帖子会被下架两次（第二次是空操作但留痕写了），
// 举报人收到两条通知，而管理员台账上出现两条指向同一个对象的处置 ——
// 那本台账的全部用途就是「能对得上」，这样它就对不上了。
//
// status 由调用方传而不是函数内部定：这一列有两个合法值
// （takedown/ban → resolved，dismiss → dismissed），选哪个是 #49 的 resolution 参数决定的。
//
// ⚠ 影响 0 行之后**必须再查一次**才知道该报哪个错，而这两种情况的文案完全不同：
//   - 那一行压根不存在 → NOT_FOUND（管理员点了一个已经消失的待办）
//   - 存在但已经不是 open → REPORT_ALREADY_RESOLVED（有人先处理了，
//     他需要知道的是「已经有人处理过了」，不是「这条举报没了」）
//
// 都报 NOT_FOUND 的话，两个管理员同时开着待办页会看到互相矛盾的结论，
// 而这条端点存在的意义就是让他们对同一件事有一致的视图。
// 这条复核 SELECT 也在同一个事务里，读到的就是刚才那一次判断的依据。
//
// resolved_by 是外键指向 users(id)，不做级联：处置人后来注销了，
// 「这条是谁处理的」必须还查得到（和 admin_actions.admin_id 同一条理由）。
//
// ## 第二条 UPDATE：连带关掉同帖的其它 open 举报
//
// 见 §4 第 797 行。它**必须紧跟在第一条后面、在同一个事务里**，两个理由：
//   - 锚点那条 UPDATE 影响 0 行时整个函数已经报错返回了，第二条根本不会执行 ——
//     也就是说「重复处置」绝不会把同帖的其它举报顺手关掉。这个顺序就是这条规则的保证。
//   - 拆成两个 UPDATE 而不是一条 `WHERE id = $1 OR item_id = (...)` ：
//     那样锚点行和连带行会混在一个 RETURNING 里，service 分不清「点进来的那一条」
//     是哪一个（而它的 reporter 要在响应里当主角）。两条 SQL 换来的是两个清晰的角色。
//
// 第二条的 WHERE 里**不需要** `id <> $1`：第一条 UPDATE 已经把锚点行的 status 改掉了，
// 它此刻已经不满足 `status = 'open'`。这不是「顺手省一个条件」，而是这条 SQL 正确性的
// 关键点 —— 所以它一旦被改成「先查同帖列表再关掉」就会开始重复通知锚点举报人。
//
// resolved_at 用的是**第二次** now() 调用。PG 里 now() 在一个事务内返回同一个值
// （事务开始时刻），所以这五条连带行和锚点行的 resolved_at 一定相等，
// 而「同一次处置」在数据上就该表现为同一个时间戳。
func (r *Report) ResolveTx(ctx context.Context, tx pgx.Tx, id, resolvedBy int64, status, note string) (*Resolve, error) {
	var out Resolve
	err := tx.QueryRow(ctx, `
		UPDATE reports
		   SET status = $2, resolved_by = $3, resolved_note = $4, resolved_at = now()
		 WHERE id = $1 AND status = 'open'
		RETURNING id, status, reporter_id, item_id, resolved_at`,
		id, status, resolvedBy, note).
		Scan(&out.ID, &out.Status, &out.ReporterID, &out.ItemID, &out.ResolvedAt)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		if ae := TranslateConstraint(err); ae != nil {
			return nil, ae
		}
		return nil, fmt.Errorf("repo.Report.ResolveTx(%d, %s): %w", id, status, err)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		// 0 行：分「不存在」和「已经被处置」两种。
		var current string
		switch err := tx.QueryRow(ctx, `SELECT status FROM reports WHERE id = $1`, id).Scan(&current); {
		case errors.Is(err, pgx.ErrNoRows):
			return nil, apperr.WrapMsg(err, apperr.CodeNotFound, "举报不存在")
		case err != nil:
			return nil, fmt.Errorf("repo.Report.ResolveTx(%d) 复核当前状态: %w", id, err)
		}
		return nil, apperr.WrapMsg(pgx.ErrNoRows, apperr.CodeReportAlreadyResolved,
			fmt.Sprintf("这条举报已经是 %s 状态，不用重复处置", current))
	}

	// 锚点行已经关掉，剩下的是同帖其它 open 的举报。
	siblings, err := tx.Query(ctx, `
		UPDATE reports
		   SET status = $2, resolved_by = $3, resolved_note = $4, resolved_at = now()
		 WHERE item_id = $1 AND status = 'open'
		RETURNING id, reporter_id`,
		out.ItemID, status, resolvedBy, note)
	if err != nil {
		if ae := TranslateConstraint(err); ae != nil {
			return nil, ae
		}
		return nil, fmt.Errorf("repo.Report.ResolveTx(%d) 连带关闭同帖举报: %w", id, err)
	}
	defer siblings.Close()

	out.AlsoClosed = []ClosedReport{}
	for siblings.Next() {
		var c ClosedReport
		if err := siblings.Scan(&c.ID, &c.ReporterID); err != nil {
			return nil, fmt.Errorf("repo.Report.ResolveTx(%d) 扫描连带行: %w", id, err)
		}
		out.AlsoClosed = append(out.AlsoClosed, c)
	}
	if err := siblings.Err(); err != nil {
		return nil, fmt.Errorf("repo.Report.ResolveTx(%d) 迭代连带行: %w", id, err)
	}
	return &out, nil
}
