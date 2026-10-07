package repo

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"lostfound/internal/model"
)

// Notification 管 notifications 表在本里程碑需要的四件事：
// 收件箱分页读、未读数、标记已读，以及 M6 的**治理回执写入**（InsertTx）。
//
// 前三个是「读自己那张收件箱」，最后一个不一样，它值得单独解释一次。
//
// 这个文件在 M4/M5 时**一个写方法都没有**，那是刻意的：那时通知的写入方都在
// 别的表的事务里 —— M3 的 new_match 住在 repo.Match.RecordMatches（因为通知必须和
// match_pairs 那一行同生同死，那个事务属于「匹配」），M5 的归还类通知住在
// repo.ItemReturn 的 Submit/Confirm/Reject 里（通知是那次确认的后果，它必须和
// 产生它的那件事同事务）。它们的共同点是：**事务属于那件事，而那件事住在 repo**，
// 所以 INSERT 也住在那儿。如果当时这里再放一个通用 Push/Insert，就会有两个地方
// 能写通知，而「台账和通知是不是原子」这件事就变回靠自觉。
//
// M6 的前提变了：治理动作的**事务属于 service**（计划 §15：moderation 每个方法
// 第一行 BeginTx、最后一行 Commit，留痕和通知都夹在中间）。这条规则不能为了
// 保持上面的整洁而破例 —— 「SQL 只出现在 repo 层」是分层纪律里更硬的一条，
// service 里写 INSERT 是让业务层直接摸数据库。
// 所以这一层唯一的妥协是：**这个写方法收 pgx.Tx，不收自己开事务的能力**。
// 它没有 pool 版本，也就是说它**没有**「自己找一条连接顺手提交一次」这条路 ——
// 治理回执和留痕不同事务这件事在类型上就写不出来。
type Notification struct {
	pool *pgxpool.Pool
}

func NewNotification(pool *pgxpool.Pool) *Notification { return &Notification{pool: pool} }

// notificationCols 是收件箱和计数共用的列清单，抽出来是为了让两处的形状只有一个来源。
const notificationCols = `id, user_id, type, title, content, item_id, return_id, is_read, created_at`

// NotificationFilter 是 #30 的查询条件。UserID 由 service 从 JWT 里取，永远不是用户参数。
//
// IsRead 是 *bool 而不是 bool：三态 —— nil 不过滤、指向 false 只看未读、
// 指向 true 只看已读。用 bool 的话「不筛选」和「只看未读」就没法区分了，
// 而收件箱默认要显示全部（只看未读是用户主动点的一个筛选项）。
type NotificationFilter struct {
	UserID   int64
	IsRead   *bool
	Page     int
	PageSize int
}

// List 分页取某人的通知，未读的和已读的混在一起按时间倒序。
//
// total 用同一条 WHERE 再 count 一次（和 repo.Item.List 同一个理由）：
// 前端要靠 total 算总页数。
//
// 排序带 created_at DESC, id DESC 而不是只按时间：批量下架那种一次写多条通知的场景
// 里，同一事务内的行 created_at 完全相同，没有 id 这个第二排序键，
// 翻页时同一秒内的通知顺序不确定，用户会看到重复或漏掉的一条。
//
// ⚠ WHERE 里的 user_id 是**必加**条件，不是可选筛选。它不来自请求参数，
// 来自 service 传进来的 JWT 身份 —— 少这一句就是「任何人可读全站所有人的通知」。
func (n *Notification) List(ctx context.Context, f NotificationFilter) ([]model.Notification, int, error) {
	where := ` WHERE user_id = $1`
	args := []any{f.UserID}
	if f.IsRead != nil {
		where += ` AND is_read = $2`
		args = append(args, *f.IsRead)
	}

	var total int
	if err := n.pool.QueryRow(ctx, `SELECT count(*) FROM notifications`+where, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("repo.Notification.List 计数 (user=%d): %w", f.UserID, err)
	}

	limitIdx, offsetIdx := len(args)+1, len(args)+2
	args = append(args, f.PageSize, (f.Page-1)*f.PageSize)

	rows, err := n.pool.Query(ctx, fmt.Sprintf(
		`SELECT %s FROM notifications%s ORDER BY created_at DESC, id DESC LIMIT $%d OFFSET $%d`,
		notificationCols, where, limitIdx, offsetIdx), args...)
	if err != nil {
		return nil, 0, fmt.Errorf("repo.Notification.List (user=%d): %w", f.UserID, err)
	}
	defer rows.Close()

	out := []model.Notification{}
	for rows.Next() {
		var v model.Notification
		if err := rows.Scan(&v.ID, &v.UserID, &v.Type, &v.Title, &v.Content,
			&v.ItemID, &v.ReturnID, &v.IsRead, &v.CreatedAt); err != nil {
			return nil, 0, fmt.Errorf("repo.Notification.List 扫描一行: %w", err)
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("repo.Notification.List 迭代: %w", err)
	}
	return out, total, nil
}

// UnreadCount 是 #31 铃铛上的那个数字。
//
// 走 idx_notifications_user (user_id, is_read, created_at DESC)：
// user_id 和 is_read 两个等值条件正好命中索引的前两列，count 不用回表扫全量通知。
// 这也是把「未读数」单独做一个端点而不是让前端从 #30 的第一页里数的好处 ——
// 单独这一条能在用户没点开收件箱时就被轮询。
func (n *Notification) UnreadCount(ctx context.Context, userID int64) (int, error) {
	var count int
	err := n.pool.QueryRow(ctx,
		`SELECT count(*) FROM notifications WHERE user_id = $1 AND is_read = false`, userID).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("repo.Notification.UnreadCount (user=%d): %w", userID, err)
	}
	return count, nil
}

// CountForeign 数出这批 id 里有多少条**不属于**这个人。#32 用它判 FORBIDDEN。
//
// 为什么要先数一遍再改而不是「UPDATE 完看影响行数」：
// 后者会把「你动了别人的通知」和「你标了一条已经不存在的通知」混成同一个结果
// （都是影响行数变少），而这两件事的性质完全不同 —— 前者是越权，必须报错；
// 后者是幂等，必须成功。分开两次判断才能把它们区分开。
//
// ⚠ 参数一律带显式类型 `$1::bigint[]`。这是 M3 学到的教训的镜像应用：
// 不带类型的锚点参数会被 PG 猜类型，猜错时报的是「操作符不存在」这种看不懂的错。
// 这里 id 列本身是 bigint，不猜也会对上，但显式写出来不靠推断，
// 而且顺带说明转型只加在**参数**上 —— 列名一旦包进函数，主键索引就用不上了。
func (n *Notification) CountForeign(ctx context.Context, userID int64, ids []int64) (int, error) {
	var count int
	err := n.pool.QueryRow(ctx,
		`SELECT count(*) FROM notifications WHERE id = ANY($1::bigint[]) AND user_id <> $2`,
		ids, userID).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("repo.Notification.CountForeign (user=%d, ids=%d 个): %w", userID, len(ids), err)
	}
	return count, nil
}

// MarkRead 把指定通知（ids 为 nil 时是这个人全部未读）标成已读，返回**真正改动的行数**。
//
// WHERE 里永远带 user_id：这一条就是 #32 的越权防线，service 那层 CountForeign
// 是给人看的错误信息，这里是数据本身的安全边界。两层都要有，
// 因为「先检查再操作」这种模式在并发下不原子（检查完到执行完之间，
// 理论上 id 的归属不会变，但**把 WHERE 写成只信检查结果是习惯问题**）。
//
// `AND is_read = false` 决定了返回值的含义：它数的是「这次真的从未读变成已读的条数」，
// 不是「你点了多少条」。所以同一次标记连着调两次，第二次必然是 0 ——
// 这个 0 是幂等的证据，M4 的测试专门断言它。
func (n *Notification) MarkRead(ctx context.Context, userID int64, ids []int64) (int, error) {
	var (
		sql  string
		args []any
	)
	if ids == nil {
		sql = `UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false`
		args = []any{userID}
	} else {
		sql = `UPDATE notifications SET is_read = true
		       WHERE user_id = $1 AND is_read = false AND id = ANY($2::bigint[])`
		args = []any{userID, ids}
	}

	tag, err := n.pool.Exec(ctx, sql, args...)
	if err != nil {
		if ae := TranslateConstraint(err); ae != nil {
			return 0, ae
		}
		return 0, fmt.Errorf("repo.Notification.MarkRead (user=%d, all=%v, ids=%d 个): %w",
			userID, ids == nil, len(ids), err)
	}
	return int(tag.RowsAffected()), nil
}

// NewNotice 是一条要写进 notifications 的通知。
//
// ItemID / ReturnID 是指针：批量下架那条通知**不挂任何帖子**（它说的是
// 「你的 50 条帖子被下架了」，挂哪一个都是错的），必须能写成 NULL。
// 用空串或者 0 都不行 —— 0 不是合法 id，而前端拿到 0 会去请求 /items/0。
type NewNotice struct {
	UserID   int64
	Type     string
	Title    string
	Content  string
	ItemID   *int64
	ReturnID *int64
}

// InsertTx 在**调用方的事务**里写一批通知，返回写入的行数。
//
// 为什么收 tx 而不是自己用 pool：这是 §12 M6 判据 ④ 的落地方式。
// 管理员下架 50 条帖子时必须同时做到三件事 —— 帖子变 deleted、留痕一行、
// 作者收到一条含理由的通知。这三件如果不在同一个事务里，第 ② ③ 件失败时
// 第 ① 件已经生效了，于是「帖子消失了但没人知道为什么」，而那正是治理最坏的样子。
// 收 pgx.Tx 让「通知和留痕不同事务」这件事**在类型上写不出来**；
// 而它没有 pool 版本，所以也没有「service 忘了开事务」这个选项。
//
// 批量插一条 SQL 而不是循环发 N 条，理由和 repo.insertImages 完全一样：
// N 次往返，加上 debug 日志里 N 条看不出所以然的 SQL。
// 这里 N 是「这批治理动作涉及几个作者」，spam 场景下是 1，但跨作者的批量下架会用到。
//
// ⚠ type / title / content 三列的合法值域和长度**这里不校验**：
// type 的 CHECK（23514）会挡掉拼错的类型名，但 title 100、content 500 这两个长度
// 撞上是 SQLSTATE 22001（字符串截断），TranslateConstraint 不认它，会变成 500。
// 所以文案的**拼装和裁剪住在 service/moderation.go**（那边知道 reason 最长 500，
// 拼上「你的 N 条帖子因『…」被下架」必须算好总长）。这里只负责诚实地写。
func (n *Notification) InsertTx(ctx context.Context, tx pgx.Tx, notices []NewNotice) (int, error) {
	if len(notices) == 0 {
		return 0, nil
	}

	var (
		sb   strings.Builder
		args []any
	)
	sb.WriteString(`INSERT INTO notifications (user_id, type, title, content, item_id, return_id) VALUES `)
	for i, nt := range notices {
		if i > 0 {
			sb.WriteString(", ")
		}
		sb.WriteString(fmt.Sprintf("($%d, $%d, $%d, $%d, $%d, $%d)",
			len(args)+1, len(args)+2, len(args)+3, len(args)+4, len(args)+5, len(args)+6))
		args = append(args, nt.UserID, nt.Type, nt.Title, nt.Content, nt.ItemID, nt.ReturnID)
	}

	tag, err := tx.Exec(ctx, sb.String(), args...)
	if err != nil {
		if ae := TranslateConstraint(err); ae != nil {
			return 0, ae
		}
		return 0, fmt.Errorf("repo.Notification.InsertTx (%d 条通知): %w", len(notices), err)
	}
	// 用 RowsAffected 而不是 len(notices) 当返回值：这张表没有任何触发器或
	// ON CONFLICT，两者正常永远相等，但相等是**假设**，而返回值是**观测**。
	// 调用方拿它当「实际通知了几个人」，将来真出现不等，冒烟测试会红在这里，
	// 而不是让 service 抱着一个自己算的数写进响应。
	return int(tag.RowsAffected()), nil
}
