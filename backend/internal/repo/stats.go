package repo

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"lostfound/internal/model"
)

// Stats 是 #37 那一页七组数字的唯一来源。
//
// 它不收事务、不收条件，就是**一次**查询。这个仓库里其它 repo 都按表分
// （User / Item / Report / Dict…），只有这一个不是：因为它跨七张表，
// 而那些表各自都不该为了一个后台统计页在自己的 repo 里长出一个 CountAll 方法 ——
// 那七个方法一旦存在，「谁在什么时候会调用它们」就没有答案了。
// 统计页要的是「全站此刻的快照」，这是一个独立的用途，配一个独立的文件。
type Stats struct {
	pool *pgxpool.Pool
}

func NewStats(pool *pgxpool.Pool) *Stats { return &Stats{pool: pool} }

// snapshotSQL 是一次拿全七组数字的那条查询。
//
// 为什么用**一条** SQL 里的标量子查询而不是发八次查询：
// 八次查询之间没有一致性 —— 第 1 次查 users 的时候有 100 人，
// 第 8 次查 today_items 的时候已经有人注册并发了帖，那一页上两组数字就对不上了。
// 单条 SELECT 跑在一个快照里，八个数字**必然**来自同一个瞬间，
// 而这一页存在的意义就是那几个数能互相对上（lost+found 该等于 open+closed+deleted）。
// 代价是八个子查询，但它们全是 count(*)，规模上（几千行）根本不值得优化。
//
// items 那一支用 FILTER 一次扫表出五个数，而不是五个子查询：
// 同一张表扫五遍和扫一遍的差别在这个规模上是 5 倍 vs 1 倍 IO，
// 而且这一支正好能走 idx_items_type_status_created 的前导列。
// 其余的表各自只数一两个状态，FILTER 反而写得长，所以留在外层子查询里。
//
// ⚠ today_items 用的是 `created_at >= date_trunc('day', now())`，
// 也就是**数据库会话时区**里的「今天零点」，不是 UTC 也不是应用服务器时区。
// 本机 PG 装在中国时区的 Windows 上，会话时区就是 +08，正好是「北京今天」。
// 但如果哪天把库挪到 UTC 机器上，这一栏会在北京时间早上 8 点才清零而不是 0 点 ——
// 症状是「今天的新帖数」这个数字在凌晨怪异地偏一天。这里不做任何补偿：
// 这一栏给人看的是趋势，不是账，写清楚比做对更值。
const snapshotSQL = `
	SELECT
		(SELECT count(*) FROM users WHERE auth_source = 'local'),
		(SELECT count(*) FROM users WHERE auth_source = 'hduhelp'),
		(SELECT count(*) FROM users WHERE status    = 'banned'),
		(SELECT count(*) FROM users),
		(SELECT count(*) FILTER (WHERE item_type = 'lost') FROM items),
		(SELECT count(*) FILTER (WHERE item_type = 'found') FROM items),
		(SELECT count(*) FILTER (WHERE status = 'open') FROM items),
		(SELECT count(*) FILTER (WHERE status = 'closed') FROM items),
		(SELECT count(*) FILTER (WHERE status = 'deleted') FROM items),
		(SELECT count(*) FROM item_returns    WHERE status = 'pending'),
		(SELECT count(*) FROM item_returns    WHERE status = 'confirmed'),
		(SELECT count(*) FROM item_returns    WHERE status = 'rejected'),
		(SELECT count(*) FROM contact_views),
		(SELECT count(*) FROM reports         WHERE status = 'open'),
		(SELECT count(*) FROM reports         WHERE status = 'resolved'),
		(SELECT count(*) FROM reports         WHERE status = 'dismissed'),
		(SELECT count(*) FROM admin_actions),
		(SELECT count(*) FROM items WHERE created_at >= date_trunc('day', now()))`

// Snapshot 取一次全站计数快照。
//
// 下面 Scan 的十八个目标按这个顺序排，和 snapshotSQL 的 SELECT 列表一一对应：
//
//	users_local, users_hduhelp, users_banned, users_total,
//	items_lost, items_found, items_open, items_closed, items_deleted,
//	returns_pending, returns_confirmed, returns_rejected,
//	contact_views,
//	reports_open, reports_resolved, reports_dismissed,
//	admin_actions, today_items
//
// 这份清单不参与执行，写的理由是：这十八个目标全是 int，改错了顺序**不会有报错**，
// 症状只是「某个数字莫名其妙偏了一点」，而那正是没人会去查的现象。
// 有名字可对，比让人数十七个逗号可靠。
//
// count(*) 在 PG 里返回 bigint，这里一律扫进 int：这个系统的量级（一个校园）
// 离 int 上限差着十几个数量级，真到需要 int64 的那天该改的是预聚合而不是这两个类型。
func (s *Stats) Snapshot(ctx context.Context) (*model.Stats, error) {
	var (
		usersLocal, usersSSO, usersBanned, usersTotal           int
		itemsLost, itemsFound, itemsOpen, itemsClosed, itemsDel int
		retPending, retConfirmed, retRejected                   int
		contactViews                                            int
		repOpen, repResolved, repDismissed                      int
		adminActions, todayItems                                int
	)

	err := s.pool.QueryRow(ctx, snapshotSQL).Scan(
		&usersLocal, &usersSSO, &usersBanned, &usersTotal,
		&itemsLost, &itemsFound, &itemsOpen, &itemsClosed, &itemsDel,
		&retPending, &retConfirmed, &retRejected,
		&contactViews,
		&repOpen, &repResolved, &repDismissed,
		&adminActions, &todayItems,
	)
	if err != nil {
		return nil, fmt.Errorf("repo.Stats.Snapshot: %w", err)
	}

	st := &model.Stats{}
	st.Users = model.UsersCount{Total: usersTotal, Local: usersLocal, SSO: usersSSO, Banned: usersBanned}
	// items.total 是 lost+found 现加的而不是第十九个 count(*)：
	// 那一列在 SQL 里写的话，同一条查询就有两种「数 items」的方式，
	// 而它们必须相等这件事没人检查。Go 这边加法则一目了然。
	st.Items = model.ItemsCount{Total: itemsLost + itemsFound, Lost: itemsLost, Found: itemsFound,
		Open: itemsOpen, Closed: itemsClosed, Deleted: itemsDel}
	st.Returns = model.ReturnsCount{Pending: retPending, Confirmed: retConfirmed, Rejected: retRejected}
	st.Reports = model.ReportsCount{Open: repOpen, Resolved: repResolved, Dismissed: repDismissed}
	st.ContactViews = contactViews
	st.AdminActions = adminActions
	st.TodayItems = todayItems
	return st, nil
}
