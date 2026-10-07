package repo

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"lostfound/internal/model"
)

// AdminAction 管 admin_actions 这张表的**读**。
//
// 写不在这里 —— 整个仓库只有 service/adminlog.Record 一个地方能写这张表（见那个文件的说明）。
// 所以这个结构体天生只读，也就没有「从两个地方写同一张表，哪个才是真的」那种问题。
//
// 它有且只有两个方法，各自对应一件只有 admin_actions 能回答的事：
//   - List：#50 操作日志页 ——「任何 admin 都能看见其他 admin 干了什么」（§12 M6）
//   - LatestTakedowns：给作者解释「我这条帖子为什么不见了」，见那个方法的注释
type AdminAction struct {
	pool *pgxpool.Pool
}

func NewAdminAction(pool *pgxpool.Pool) *AdminAction { return &AdminAction{pool: pool} }

// AdminActionFilter 是 #50 的查询条件。
//
// 四个筛选项全部**可选**（零值 = 不加这一条 WHERE）：这一页是排查工具，
// 排查时手里有什么线索是不确定的 —— 可能是「某个 admin 最近干了什么」（admin_id），
// 可能是「这条帖子被动过几次」（target_type + target_id），也可能是
// 「最近所有下架动作」（action）。缺任何一个入口都会逼人退回去翻全表。
type AdminActionFilter struct {
	AdminID    int64
	TargetType string
	TargetID   int64
	Action     string
	Page       int
	PageSize   int
}

// adminActionCols 里最后两列是这一页唯一的「连表」：
// LEFT JOIN users 拿到操作者的昵称，而 (u.id IS NULL) 把「那个账号已经不在了」
// 读成一个布尔而不是靠 nickname 是空串去猜。
//
// a.detail 后面那句 ::text 不是类型洁癖：这一列是 JSONB，
// 直接扫进 Go 的 string 依赖 pgx 给 jsonb→string 准备的扫描计划，
// 而显式转 text 之后 SQL 自己保证拿到的是那段 JSON 文本，
// 到 View() 再原样交给 json.RawMessage（前端因此看到的是对象而不是字符串）。
const adminActionCols = `a.id, a.admin_id, a.action, a.target_type, a.target_id,
	a.reason, a.detail::text, a.created_at,
	COALESCE(u.nickname, ''), (u.id IS NULL)`

const adminActionFrom = ` FROM admin_actions a
		 LEFT JOIN users u ON u.id = a.admin_id`

func scanAdminActionRow(row pgx.Row, v *model.AdminActionRow) error {
	return row.Scan(
		&v.ID, &v.AdminID, &v.Action, &v.TargetType, &v.TargetID,
		&v.Reason, &v.Detail, &v.CreatedAt,
		&v.AdminNickname, &v.AdminMissing,
	)
}

// buildAdminActionWhere 拼出 #50 的 WHERE，并返回对应的参数。
//
// 参数下标是**算出来**的（len(args)+1）而不是写死的 $1/$2：
// 四个可选条件任意组合都会让后面的 LIMIT/OFFSET 下标移动，
// 手写死的话每加一个筛选项都要重数一遍占位符 —— 数错一次就是一次
// 「按 admin 筛却筛出了别人的记录」，而那正是这一页最不该出错的地方。
func buildAdminActionWhere(f AdminActionFilter) (string, []any) {
	var (
		conds []string
		args  []any
	)
	if f.AdminID != 0 {
		args = append(args, f.AdminID)
		conds = append(conds, fmt.Sprintf(`a.admin_id = $%d`, len(args)))
	}
	if f.TargetType != "" {
		args = append(args, f.TargetType)
		conds = append(conds, fmt.Sprintf(`a.target_type = $%d`, len(args)))
	}
	if f.TargetID != 0 {
		args = append(args, f.TargetID)
		conds = append(conds, fmt.Sprintf(`a.target_id = $%d`, len(args)))
	}
	if f.Action != "" {
		args = append(args, f.Action)
		conds = append(conds, fmt.Sprintf(`a.action = $%d`, len(args)))
	}
	if len(conds) == 0 {
		return "", args
	}
	return " WHERE " + strings.Join(conds, " AND "), args
}

// List 分页取治理留痕，最新在前。
//
// 排序带 id DESC 作第二键的理由和 Notification.List 完全一样：
// 一次批量动作在同一个事务里可能连着写多行（#49 的 takedown 就是两行），
// 它们的 created_at 到微秒都相同，只按时间排的话翻页顺序不稳定。
//
// ⚠ 这一页**没有任何行级过滤**：不像 #19/#28 那样必须带一个「只能看自己的」条件，
// 因为它的语义就是全站治理日志（§12 M6「任何 admin 都能看见其他 admin 干了什么」）。
// 它的边界完全由鉴权决定 —— 挂 RequireAdmin。少了那道中间件，这里就是全站操作日志公开页。
func (r *AdminAction) List(ctx context.Context, f AdminActionFilter) ([]model.AdminActionRow, int, error) {
	where, args := buildAdminActionWhere(f)

	var total int
	if err := r.pool.QueryRow(ctx, `SELECT count(*)`+adminActionFrom+where, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("repo.AdminAction.List 计数: %w", err)
	}

	limitIdx, offsetIdx := len(args)+1, len(args)+2
	args = append(args, f.PageSize, (f.Page-1)*f.PageSize)

	rows, err := r.pool.Query(ctx, fmt.Sprintf(
		`SELECT %s%s ORDER BY a.created_at DESC, a.id DESC LIMIT $%d OFFSET $%d`,
		adminActionCols, adminActionFrom+where, limitIdx, offsetIdx), args...)
	if err != nil {
		return nil, 0, fmt.Errorf("repo.AdminAction.List: %w", err)
	}
	defer rows.Close()

	out := []model.AdminActionRow{}
	for rows.Next() {
		var v model.AdminActionRow
		if err := scanAdminActionRow(rows, &v); err != nil {
			return nil, 0, fmt.Errorf("repo.AdminAction.List 扫描一行: %w", err)
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("repo.AdminAction.List 迭代: %w", err)
	}
	return out, total, nil
}

// TakedownInfo 是「这条帖子是被谁在什么时候因为什么下架的」里能给作者看的那部分。
//
// 刻意**没有 admin 的身份和昵称**：作者需要知道的是「我的帖子为什么不见了」，
// 不是「哪个管理员删了我」。把具体的人暴露给被处置者，治理纠纷就变成私人恩怨，
// 而这套模型里唯一能安全地看「哪个 admin 干了什么」的地方是 #50（给其他 admin 看的）。
//
// ActionID 是那一行留痕的 id：用户来问「我帖子怎么没了」时，他报这个数，
// 我们一步就能定位到那条记录；没有它就得靠时间和标题去猜是哪一次。
type TakedownInfo struct {
	ItemID    int64
	ActionID  int64
	Reason    string
	CreatedAt time.Time
}

// LatestTakedowns 给一批帖子各找回**最近一次**下架留痕，用来在「我的发布」里
// 向作者解释这条 deleted 的帖子是被谁因为什么下架的（2026-10-07 用户新增的需求）。
//
// ## ⚠ 那条谓词为什么长这样，以及为什么不能用最自然的写法
//
// 最自然的实现是 `target_id = ANY($1)`。它对 #17（单条删）和 #44（恢复）成立，
// 但对 #43 **批量下架永远不成立**：一次下架 50 条只写**一行**留痕，
// target_id 存的是**第一个** id，另外 49 个只出现在 detail.ids 里
// （这是迁移注释和 §13 第 9 步的核对 SQL 定下的形状，不是这里能改的）。
// 于是那 49 个作者永远看不到原因 —— 而这个方法存在的全部意义就是让他们看到。
//
// 更要命的是这个 bug 的形状：单条下架的用例全绿，批量那条只有第 1 条能查到，
// 而批量恰好是它最主要的使用场景（spam 一次就是 50 条）。
// 所以谓词必须同时命中两种形状，实现成 UNION ALL 的两支（见函数体里那段 SQL 的注释）。
//
// ## 为什么读时派生而不是给 items 加一列 takedown_reason
//
// admin_actions 是这件事的**唯一事实来源**，而 reason 一旦能出现在两个地方，
// 就会出现「日志被 Adminer 改过、帖子上那列还是旧的」这种对不上的状态 ——
// 而那一列的用途恰恰是给用户一个说法，说法错了比没有说法更糟。
//
// ⚠ 代价说清楚：这条查询**不走** idx_admin_actions_target，因为那条索引的前导列是
// target_type，而这里按 action 筛、按 id 找。所以它是 admin_actions 的一次顺序扫。
// 现在接受它，理由有两层：这张表的增长速度等于「管理员动手的频率」，不是一个会被刷的量级；
// 而且它只在作者翻「我的发布」时跑，不在广场那条热路径上。
// 真到了痛的时候，补一条 (action, target_id) 索引就行，**不要现在预建** ——
// 一张写少读也少的表上多一条索引，换来的是每一次治理动作都要多维护一个 B 树。
//
// ## 为什么返回 map 而不是切片
//
// 调用方要按 item_id 挂回每一行帖子。返回切片的话 service 还得自己建这个索引，
// 而「哪个 id 没查到」这件事在两种形状下的可读性差别很大：map 上直接 len 就知道。
// 查不到的 id 不会出现在 map 里 —— 那表示「这条帖子的 deleted 不是 admin 造成的」
// （绝大多数情况就是作者自己删的），service 据此不显示这一栏，而不是显示一句「原因未知」。
func (r *AdminAction) LatestTakedowns(ctx context.Context, itemIDs []int64) (map[int64]TakedownInfo, error) {
	out := map[int64]TakedownInfo{}
	if len(itemIDs) == 0 {
		return out, nil
	}

	// 里层那个 UNION ALL 是这条查询的全部难点：一支管单条形状，一支管批量形状，
	// 两个形状的 id 住在不同的地方（一列在 target_id，一列藏在 detail->'ids' 那个数组里），
	// 而调用方给的是**一批帖子 id**，要的是「每个帖子它自己那一条原因」。
	//
	// 外层 DISTINCT ON (h.item_id) + 组内按时间倒序，就是「每个帖子取最近那一次」。
	// 不能用 ORDER BY ... LIMIT 1：那整个批量只回一行，而不是每个帖子一行。
	//
	// 两支的排序键都写全（created_at DESC, action_id DESC）：同一个事务里写下的两行
	// created_at 完全相同，少了第二排序键，「最近那次」在并列时会取到任意一行。
	//
	// 第二支里的 CROSS JOIN LATERAL 只在**该行的 ids 数组命中目标 id** 时才展开，
	// 而且它天然把「detail 里没有 ids 键」的单条留痕整行丢掉（数组为空 → 0 行），
	// 那种行由第一支负责，所以两支不会漏、重叠的那一条（批量行的 target_id 恰好等于 ids[0]）
	// 内容完全相同，DISTINCT ON 取哪一条结果都一样。
	rows, err := r.pool.Query(ctx, `
		SELECT DISTINCT ON (h.item_id) h.item_id, h.action_id, h.reason, h.created_at
		  FROM (
			SELECT a.target_id AS item_id, a.id AS action_id, a.reason, a.created_at
			  FROM admin_actions a
			 WHERE a.action = 'item_takedown'
			   AND a.target_id = ANY($1::bigint[])
			UNION ALL
			SELECT e.elem::bigint, a.id, a.reason, a.created_at
			  FROM admin_actions a
			  CROSS JOIN LATERAL jsonb_array_elements_text(a.detail -> 'ids') AS e(elem)
			 WHERE a.action = 'item_takedown'
			   AND e.elem::bigint = ANY($1::bigint[])
		  ) h
		 ORDER BY h.item_id, h.created_at DESC, h.action_id DESC`, itemIDs)
	if err != nil {
		return nil, fmt.Errorf("repo.AdminAction.LatestTakedowns (%d 条帖子): %w", len(itemIDs), err)
	}
	defer rows.Close()

	for rows.Next() {
		var v TakedownInfo
		if err := rows.Scan(&v.ItemID, &v.ActionID, &v.Reason, &v.CreatedAt); err != nil {
			return nil, fmt.Errorf("repo.AdminAction.LatestTakedowns 扫描一行: %w", err)
		}
		out[v.ItemID] = v
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("repo.AdminAction.LatestTakedowns 迭代: %w", err)
	}
	return out, nil
}
