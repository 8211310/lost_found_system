package repo

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"lostfound/internal/apperr"
	"lostfound/internal/model"
)

// Item 是 items + item_images 两张表的数据访问对象。
//
// 两张表放一个 repo：item_images 是 items 的从属子表（外键 ON DELETE CASCADE），
// 从来没有「脱离帖子单独操作图片」的业务，拆成两个文件只会让
// 「建帖时要同时插图片」这件事跨两个包协调。
type Item struct {
	pool *pgxpool.Pool
}

func NewItem(pool *pgxpool.Pool) *Item { return &Item{pool: pool} }

// itemDetailCols 是「帖子 + 展示所需连表字段」的取列清单。
//
// 抽成一个常量而不是每条 SQL 各写一遍：SELECT 的列顺序必须和 scanItemDetail 里的
// Scan 参数顺序严格一致，写四遍就意味着改一处要记得改四处 —— 而漏改的症状是
// 「扫描类型不匹配」，或者更糟的「两个同为 string 的列悄悄对调」，编译期一声不响。
const itemDetailCols = `i.id, i.item_type, i.user_id, i.title, i.description, i.category_id,
	i.location_id, i.location_detail, i.last_seen_at, i.lost_at, i.found_at, i.contact,
	i.status, i.view_count, i.created_at, i.updated_at,
	c.name, l.name, u.nickname, COALESCE(cover.path, ''),
	COALESCE(c.parent_id, 0)  AS category_parent_id,
	COALESCE(lp.id, 0)        AS location_parent_id,
	COALESCE(lt.id, 0)        AS location_top_id,
	l.is_freeform`

// itemDetailFrom 是配套的 FROM 子句。
//
// 三个 INNER JOIN 都是安全的（不会因为对端缺行而丢帖子）：
// items.category_id / location_id / user_id 三个外键都没有 ON DELETE CASCADE，
// 所以只要帖子还在，被引用的字典行和用户行就一定还在。
// 字典的增删端点（#10/#12）另外还有 CATEGORY_IN_USE 挡着「仍被引用就不许删」。
//
// LEFT JOIN LATERAL 取封面图：
//   - LATERAL 让子查询能引用外层的 i.id，这是「每个帖子取它自己的第一张图」的标准写法。
//   - 用它而不是「查完列表再对每个 id 查一次图片」：后者是 N+1，20 行的列表变 21 次往返，
//     而每次往返都会在 LOG_LEVEL=debug 下打一条 SQL —— 真正想看的那条会被淹掉。
//   - 用它而不是 `min(sort_order)` 再自连接：那样拿不到图片 id，而且写起来长得多。
//   - ORDER BY sort_order, id 里的 id 是为了让「同一 sort_order 的多张图」也有确定顺序，
//     否则分页翻页时同一张图可能在两页都出现（PG 不保证等值行的稳定顺序）。
//
// 最后两个 LEFT JOIN locations（lp = 父、lt = 祖父）是 M3 加进来的，为的是打分要能比较祖先：
// 「同大类不同小类给 0.5」和「同二级子类 0.6 / 同一级区 0.3」都要拿父节点比，
// 而 items 表里只有叶子 id。不做这两次 JOIN 的话，匹配就得对每个候选再发两次字典点查，
// 那正是上面 LATERAL 要避免的 N+1。
// 用 LEFT JOIN 而不是 INNER：地点树里的「其他」是 level=1 的叶子，它没有父节点，
// INNER 会把选了这个地点的帖子整条变隐形（帖子从广场上消失，而原因是一条字典行）。
// COALESCE 成 0 之后 matcher 拿 0 当「没有这一级」，比较时一句 != 0 就挡掉。
const itemDetailFrom = ` FROM items i
	 JOIN categories c ON c.id = i.category_id
	 JOIN locations  l ON l.id = i.location_id
	 JOIN users      u ON u.id = i.user_id
	 LEFT JOIN locations lp ON lp.id = l.parent_id
	 LEFT JOIN locations lt ON lt.id = lp.parent_id
	 LEFT JOIN LATERAL (
	     SELECT path FROM item_images im
	      WHERE im.item_id = i.id
	      ORDER BY im.sort_order, im.id
	      LIMIT 1
	 ) cover ON true`

// itemSortColumns 是 #14 的 sort 参数白名单 → 真实 SQL 表达式。
//
// ⚠ 排序列**不能**用占位符传（$1 只能替值，不能替标识符），所以这里必须自己保证
// 拼进 SQL 的字符串只可能来自这张表的右边。map 查找失败就回落到 created_at ——
// service 层已经把非法值挡成 VALIDATION 了，这一步是「万一 service 漏了也不会被注入」
// 的最后一道防线，不是业务逻辑。
//
// NULLS LAST：lost 帖的 found_at 恒为 NULL，found 帖的 lost_at 恒为 NULL，
// 而 PG 的 DESC 默认把 NULL 排在**最前**。不加这四个字，按 found_at 排序的
// 广场第一屏会全是失物帖 —— 用户看到的是「排序坏了」，而代码看起来完全正确。
var itemSortColumns = map[string]string{
	"created_at": "i.created_at",
	"lost_at":    "i.lost_at",
	"found_at":   "i.found_at",
}

// NewItemRow 是建帖要写入的字段。
type NewItemRow struct {
	ItemType       string
	UserID         int64
	Title          string
	Description    string
	CategoryID     int64
	LocationID     int64
	LocationDetail string
	LastSeenAt     *time.Time
	LostAt         *time.Time
	FoundAt        *time.Time
	Contact        string
	ImagePaths     []string
}

// UpdateItemRow 是改帖要写入的字段。
//
// 没有 ItemType 和 UserID：#16 的请求体明确「同 #13（不含 item_type）」，
// 而作者永远不变 —— 改帖能改作者的话，「归属」就成了可以转让的东西，
// 那是定位原则 5 里 admin 都不该有的权力，普通用户更不该有。
//
// ImagePaths 是**指针切片**，用来区分两种完全不同的意图：
//   - nil      → 请求里没带这个字段，图片保持原样
//   - 空切片   → 请求里带了 `"image_paths": []`，把图片全部删掉
//
// 用值切片分不清这两者（都是 len==0），而「我没动图片」和「我把图片删光了」
// 对用户是两件事。encoding/json 的行为正好对得上：字段缺失或 null → nil，[] → 空切片。
type UpdateItemRow struct {
	Title          string
	Description    string
	CategoryID     int64
	LocationID     int64
	LocationDetail string
	LastSeenAt     *time.Time
	LostAt         *time.Time
	FoundAt        *time.Time
	Contact        string
	ImagePaths     *[]string
}

// Create 在一个事务里插入帖子和它的图片，返回连好表的完整一行。
//
// 为什么必须同事务：先插 items 再插 item_images，如果第二步失败而第一步没回滚，
// 库里就会留下一条「说自己有图但一张都没有」的帖子。用户看到的是一个空图位，
// 而日志里那次错误已经过去了 —— 这种残留数据没人会发现，也没人会去清。
//
// 返回前再查一次 GetByID 而不是把 INSERT 的结果直接拼成 ItemDetail：
// 详情形状需要分类名、地点名、作者名和封面图，那些都得连表才有，
// 而 INSERT ... RETURNING 拿不到连表字段。多一次主键查询（走 PK 索引，微秒级），
// 换来的是「Create 和 GetByID 返回的形状一定一致」—— 否则两处各写一遍列清单，
// 早晚会对不上，而症状是「刚发的帖子和刷新之后的帖子字段不一样」。
func (r *Item) Create(ctx context.Context, p NewItemRow) (*model.ItemDetail, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("repo.Item.Create 开事务: %w", err)
	}
	// 用 defer 而不是在每个 return 前手写 Rollback：漏一个分支就会泄漏一个连接，
	// 而连接池被占满的表现是「过一会儿所有请求都卡住」，离原因很远。
	// Commit 成功之后再 Rollback 是无害的（pgx 返回 ErrTxClosed，这里忽略）。
	defer func() { _ = tx.Rollback(ctx) }()

	var id int64
	err = tx.QueryRow(ctx, `
		INSERT INTO items (item_type, user_id, title, description, category_id, location_id,
		                   location_detail, last_seen_at, lost_at, found_at, contact)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
		RETURNING id`,
		p.ItemType, p.UserID, p.Title, p.Description, p.CategoryID, p.LocationID,
		p.LocationDetail, p.LastSeenAt, p.LostAt, p.FoundAt, p.Contact).Scan(&id)
	if err != nil {
		if ae := TranslateConstraint(err); ae != nil {
			return nil, ae
		}
		return nil, fmt.Errorf("repo.Item.Create: %w", err)
	}

	if err := insertImages(ctx, tx, id, p.ImagePaths); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("repo.Item.Create 提交事务: %w", err)
	}

	out, err := r.GetByID(ctx, id)
	if err != nil {
		// 事务已经提交了，帖子确实在库里，只是回读失败（连接在这一步断了）。
		// 这时候报 INTERNAL 是诚实的：不能假装建帖失败，否则用户会再发一次，
		// 广场上就多出一条重复帖子。
		return nil, fmt.Errorf("repo.Item.Create(%d) 已提交但回读失败: %w", id, err)
	}
	return out, nil
}

// GetByID 按主键取一条帖子的完整详情形状。查无此行返回 apperr NOT_FOUND。
//
// 这里**不按 status 过滤**：能不能看一条已软删的帖子是业务规则
// （service 的判断是「只有作者本人和 admin 能看」），repo 只负责把行取回来。
func (r *Item) GetByID(ctx context.Context, id int64) (*model.ItemDetail, error) {
	row := r.pool.QueryRow(ctx, `SELECT `+itemDetailCols+itemDetailFrom+` WHERE i.id = $1`, id)
	d, err := scanItemDetail(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apperr.WrapMsg(err, apperr.CodeNotFound, "帖子不存在")
		}
		return nil, fmt.Errorf("repo.Item.GetByID(%d): %w", id, err)
	}
	return d, nil
}

// Update 覆写帖子的可编辑字段，返回改完之后的完整一行。
//
// 和 repo.User.UpdateProfile 同一个套路：**无条件覆写**，不用 COALESCE($n, col)
// 那种「传 NULL 就不改」的写法 —— COALESCE 分不清「没传」和「要清空」，
// 而 description 和 location_detail 恰恰是用户会想清空的。
// 「没传就保持原值」的合并逻辑放在 service 层用 Go 代码做，到这里所有值都已经是最终值。
//
// updated_at 必须显式写 now()：这个库一个 trigger 都没有（000001 迁移里没有），
// 漏写的话这一列会永远停在发帖时间。
func (r *Item) Update(ctx context.Context, id int64, p UpdateItemRow) (*model.ItemDetail, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("repo.Item.Update 开事务: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var got int64
	err = tx.QueryRow(ctx, `
		UPDATE items
		   SET title = $2, description = $3, category_id = $4, location_id = $5,
		       location_detail = $6, last_seen_at = $7, lost_at = $8, found_at = $9,
		       contact = $10, updated_at = now()
		 WHERE id = $1
		RETURNING id`,
		id, p.Title, p.Description, p.CategoryID, p.LocationID, p.LocationDetail,
		p.LastSeenAt, p.LostAt, p.FoundAt, p.Contact).Scan(&got)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apperr.WrapMsg(err, apperr.CodeNotFound, "帖子不存在")
		}
		if ae := TranslateConstraint(err); ae != nil {
			return nil, ae
		}
		return nil, fmt.Errorf("repo.Item.Update(%d): %w", id, err)
	}

	// ImagePaths == nil 表示「这次不改图片」，连 DELETE 都不发。
	if p.ImagePaths != nil {
		if _, err := tx.Exec(ctx, `DELETE FROM item_images WHERE item_id = $1`, id); err != nil {
			return nil, fmt.Errorf("repo.Item.Update(%d) 清空旧图片: %w", id, err)
		}
		if err := insertImages(ctx, tx, id, *p.ImagePaths); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("repo.Item.Update 提交事务: %w", err)
	}

	out, err := r.GetByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("repo.Item.Update(%d) 已提交但回读失败: %w", id, err)
	}
	return out, nil
}

// SetStatus 改帖子状态（#18 开/关帖、#17 软删）。返回是否真的改到了一行。
//
// 不返回整行：调用方要的就是「改成功了没」，而状态值是它自己传进来的。
// 影响 0 行 = id 不存在，翻译成 NOT_FOUND 而不是当成成功放过 ——
// 否则用户以为帖子关了，广场上却还挂着，而日志里一片绿。
func (r *Item) SetStatus(ctx context.Context, id int64, status string) error {
	tag, err := r.pool.Exec(ctx, `
		UPDATE items SET status = $2, updated_at = now() WHERE id = $1`, id, status)
	if err != nil {
		if ae := TranslateConstraint(err); ae != nil {
			return ae
		}
		return fmt.Errorf("repo.Item.SetStatus(%d, %q): %w", id, status, err)
	}
	if tag.RowsAffected() == 0 {
		return apperr.WrapMsg(pgx.ErrNoRows, apperr.CodeNotFound, "帖子不存在")
	}
	return nil
}

// ListFilter 是 #14 / #19 的查询条件。
//
// 全部字段都是「零值 = 不加这个条件」，除了 Page/PageSize（零值由 service 填成默认值）。
// 这样 repo 不需要知道「广场默认排除 deleted、我的发布默认不排除」这类业务规则 ——
// 那些住在 service，到这里条件已经确定了。
type ListFilter struct {
	ItemType   string   // "" | "lost" | "found"
	Keyword    string   // "" = 不搜
	CategoryID *int64   // nil = 不限
	LocationID *int64   // nil = 不限
	Statuses   []string // 空 = 不限；#14 传 ["open","closed"]，#19 可能传 ["deleted"]
	UserID     *int64   // nil = 不限；#19 用它锁定「我的」
	Sort       string   // 必须是 itemSortColumns 的键
	Page       int
	PageSize   int
}

// List 按条件分页查帖子，同时返回不分页的总行数。
//
// total 用**同一条 WHERE** 再 count 一次，而不是「查完看返回了几行」：
// 前端要靠 total 算总页数，只给当前页的行数的话，翻到第二页就再也算不出还有多少页。
// 代价是两次查询，但 count(*) 走的是 idx_items_type_status_created，很便宜。
func (r *Item) List(ctx context.Context, f ListFilter) ([]model.ItemDetail, int, error) {
	where, args := buildItemWhere(f)

	var total int
	if err := r.pool.QueryRow(ctx, `SELECT count(*) FROM items i`+where, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("repo.Item.List 计数: %w", err)
	}

	sortCol, ok := itemSortColumns[f.Sort]
	if !ok {
		// 见 itemSortColumns 的注释：这是防注入的兜底，不是业务分支
		sortCol = itemSortColumns["created_at"]
	}

	// 占位符编号要接着 where 用掉的那些往下排，所以先算个数再拼
	limitIdx := len(args) + 1
	offsetIdx := len(args) + 2
	args = append(args, f.PageSize, (f.Page-1)*f.PageSize)

	q := fmt.Sprintf(`SELECT %s %s %s ORDER BY %s DESC NULLS LAST, i.id DESC LIMIT $%d OFFSET $%d`,
		itemDetailCols, itemDetailFrom, where, sortCol, limitIdx, offsetIdx)

	rows, err := r.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("repo.Item.List: %w", err)
	}
	defer rows.Close()

	out := []model.ItemDetail{}
	for rows.Next() {
		var d model.ItemDetail
		if err := scanItemDetailRows(rows, &d); err != nil {
			return nil, 0, fmt.Errorf("repo.Item.List 扫描一行: %w", err)
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("repo.Item.List 迭代: %w", err)
	}
	return out, total, nil
}

// buildItemWhere 拼 WHERE 子句和它的参数。
//
// ⚠ 所有值一律走占位符，**没有任何一处把用户输入拼进 SQL 字符串**。
// 唯一被拼进去的是 itemSortColumns 右边的常量表达式（在 List 里，且过了白名单）。
// 这是这个函数存在的全部意义：把「动态 SQL」这件危险的事收在一处，
// 而不是散落在五个 handler 里各拼一遍。
func buildItemWhere(f ListFilter) (string, []any) {
	var (
		conds []string
		args  []any
	)
	add := func(sql string, v any) {
		args = append(args, v)
		conds = append(conds, fmt.Sprintf(sql, len(args)))
	}

	if f.ItemType != "" {
		add("i.item_type = $%d", f.ItemType)
	}
	if f.Keyword != "" {
		// escapeLike 必须先做：用户搜 "100%" 时那个 % 是**字面量**，
		// 不转义它就变成通配符，搜索结果会是「几乎所有帖子」。
		// 这既是正确性问题也是可用性问题 —— 而且它不会被任何测试发现，
		// 除非有人真的去搜一个百分号。
		kw := "%" + escapeLike(f.Keyword) + "%"
		args = append(args, kw, kw)
		conds = append(conds, fmt.Sprintf(
			`(i.title ILIKE $%d ESCAPE '\' OR i.description ILIKE $%d ESCAPE '\')`, len(args)-1, len(args)))
	}
	if f.CategoryID != nil {
		add("i.category_id = $%d", *f.CategoryID)
	}
	if f.LocationID != nil {
		add("i.location_id = $%d", *f.LocationID)
	}
	if len(f.Statuses) > 0 {
		// 用 = ANY($n) 而不是 IN ($n,$m,...)：数组只占一个占位符，
		// 不用为「状态可能有几个」动态生成编号。
		add("i.status = ANY($%d)", f.Statuses)
	}
	if f.UserID != nil {
		add("i.user_id = $%d", *f.UserID)
	}

	if len(conds) == 0 {
		return "", args
	}
	return " WHERE " + strings.Join(conds, " AND "), args
}

// escapeLike 转义 LIKE/ILIKE 模式里的三个特殊字符。
//
// 反斜杠自己也要转义，而且必须**第一个**处理 —— 后加的两个替换会引入新的反斜杠，
// 如果先转义 % 再转义 \，那 `\%` 里的反斜杠会被再转一次变成 `\\%`，
// 匹配的就完全是另一个东西了。strings.NewReplacer 是一次扫描同时替换，
// 天然没有这个顺序问题（它不会把替换结果再拿去匹配一遍）。
func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// ListImages 取一个帖子的全部图片，按展示顺序。
func (r *Item) ListImages(ctx context.Context, itemID int64) ([]model.ItemImage, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, item_id, path, sort_order, created_at
		  FROM item_images
		 WHERE item_id = $1
	  ORDER BY sort_order, id`, itemID)
	if err != nil {
		return nil, fmt.Errorf("repo.Item.ListImages(%d): %w", itemID, err)
	}
	defer rows.Close()

	out := []model.ItemImage{}
	for rows.Next() {
		var im model.ItemImage
		if err := rows.Scan(&im.ID, &im.ItemID, &im.Path, &im.SortOrder, &im.CreatedAt); err != nil {
			return nil, fmt.Errorf("repo.Item.ListImages(%d) 扫描一行: %w", itemID, err)
		}
		out = append(out, im)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("repo.Item.ListImages(%d) 迭代: %w", itemID, err)
	}
	return out, nil
}

// ImageWithOwner 取一行图片，**连它所属帖子的作者一起**。
//
// 为 #42（帖主自删单张图片）准备的：那个端点要判断「操作者是不是帖主」，
// 而图片行里只有 item_id。分两次查也能做，但那意味着两次往返和一次
// 「图片查到了、帖子在这两步之间被删了」的竞态。一条 JOIN 查询没有这个问题。
func (r *Item) ImageWithOwner(ctx context.Context, imageID int64) (model.ItemImage, int64, error) {
	var (
		im      model.ItemImage
		ownerID int64
	)
	err := r.pool.QueryRow(ctx, `
		SELECT im.id, im.item_id, im.path, im.sort_order, im.created_at, i.user_id
		  FROM item_images im
		  JOIN items i ON i.id = im.item_id
		 WHERE im.id = $1`, imageID).
		Scan(&im.ID, &im.ItemID, &im.Path, &im.SortOrder, &im.CreatedAt, &ownerID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return im, 0, apperr.WrapMsg(err, apperr.CodeNotFound, "图片不存在")
		}
		return im, 0, fmt.Errorf("repo.Item.ImageWithOwner(%d): %w", imageID, err)
	}
	return im, ownerID, nil
}

// DeleteImage 删一行图片，返回它原来的磁盘相对路径。
//
// 用 DELETE ... RETURNING 而不是「先 SELECT 拿到 path 再 DELETE」：
// 后者是两步，中间那一下如果另一个请求也删了同一行，第二步就会静默影响 0 行，
// 而调用方以为自己删掉了。RETURNING 是原子的，且「没有返回行」直接等价于
// 「这行本来就不存在」→ NOT_FOUND。
//
// 返回 path 是为了让 service 接着删磁盘文件 —— 数据库里那行没了之后，
// 那个路径就再也查不出来了，所以必须在同一步里带出来。
func (r *Item) DeleteImage(ctx context.Context, imageID int64) (string, error) {
	var path string
	err := r.pool.QueryRow(ctx, `
		DELETE FROM item_images WHERE id = $1 RETURNING path`, imageID).Scan(&path)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", apperr.WrapMsg(err, apperr.CodeNotFound, "图片不存在")
		}
		return "", fmt.Errorf("repo.Item.DeleteImage(%d): %w", imageID, err)
	}
	return path, nil
}

// UpdateTx 覆写帖子的可编辑字段，**在调用方的事务里**，并带出作者 id。
//
// 存在的唯一理由就是 #16 的 admin 分支：管理员改别人的帖子必须留痕（§4 表头那条
// 「admin 调用时 admin_reason 必填且写 admin_actions」），而留痕和这次改动必须同事务。
// 上面那个 Update 自己 Begin/Commit，套不进去。
//
// 中间那步「取作者 id」单独发一条 SQL，而不是像 ImageWithOwner 那样 JOIN：
// UPDATE ... RETURNING user_id 看着更省，但改帖的 WHERE 只有 id，
// 一条**没改动任何列**的更新（管理员提交了和原来一模一样的标题）在 PG 里
// 照样会返回一行，所以这条 SQL 省不掉，加了 JOIN 反而把 UPDATE 变复杂。
// 真正的省法是让它和 UPDATE 在同一个事务里 —— 现在就是了。
func (r *Item) UpdateTx(ctx context.Context, tx pgx.Tx, id int64, p UpdateItemRow) (int64, error) {
	var ownerID int64
	err := tx.QueryRow(ctx, `
		UPDATE items
		   SET title = $2, description = $3, category_id = $4, location_id = $5,
		       location_detail = $6, last_seen_at = $7, lost_at = $8, found_at = $9,
		       contact = $10, updated_at = now()
		 WHERE id = $1
		RETURNING user_id`,
		id, p.Title, p.Description, p.CategoryID, p.LocationID, p.LocationDetail,
		p.LastSeenAt, p.LostAt, p.FoundAt, p.Contact).Scan(&ownerID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, apperr.WrapMsg(err, apperr.CodeNotFound, "帖子不存在")
		}
		if ae := TranslateConstraint(err); ae != nil {
			return 0, ae
		}
		return 0, fmt.Errorf("repo.Item.UpdateTx(%d): %w", id, err)
	}
	return ownerID, nil
}

// ReplaceImagesTx 重建一条帖子的图片列表，**在调用方的事务里**。
//
// 它是上面那个 Update 里那两步（DELETE 旧行 + 多值 INSERT）的独立版本，存在的理由
// 只有一个：#16 的 admin 分支要在**一个事务里**做完「改字段 + 改图片 + 写留痕」，
// 而 Update 自己 Begin/Commit，套不进去。图片不放进这个事务会留下一种很难解释的状态 ——
// 文字改了、留痕写了、图还是旧的，而留痕里那句「管理员改过这条帖子」指的其实是全部字段。
//
// ⚠ 和 `UpdateItemRow.ImagePaths == nil` 那条规矩一样，本函数**不接受 nil**：
// 调用方只在「请求体里确实带了 images」时才该调它。这里收的是 []string 而不是 *[]string，
// 因为「传一个空切片」在这里有明确含义（把图全删掉），而 nil 会被 insertImages
// 当成「什么都不做」，于是一次「清空图片」的改帖会变成「图片一张没删、留痕却说改了」。
// 两者混淆的代价是数据，不是报错，所以在这一层就把形状钉死。
func (r *Item) ReplaceImagesTx(ctx context.Context, tx pgx.Tx, itemID int64, paths []string) error {
	if _, err := tx.Exec(ctx, `DELETE FROM item_images WHERE item_id = $1`, itemID); err != nil {
		if ae := TranslateConstraint(err); ae != nil {
			return ae
		}
		return fmt.Errorf("repo.Item.ReplaceImagesTx(%d) 清空旧图片: %w", itemID, err)
	}
	return insertImages(ctx, tx, itemID, paths)
}

// TakenRow 是批量下架里**真的被动过一行**的那个帖子。
type TakenRow struct {
	ItemID int64
	UserID int64
}

// TakedownTx 批量下架（#43）：把这批帖子的 status 改成 deleted，返回**实际被改掉**的那些行。
//
// 两条 SQL，顺序不能反：
//
//	① 预检存在性 —— 有一个 id 压根不存在就整批失败，返回 NOT_FOUND，一条都不改。
//	② UPDATE ... WHERE status <> 'deleted' —— 已经是 deleted 的跳过。
//
// 为什么要有 ① ：没有它，「50 个 id 里有一个是打错的」会表现为「下架了 49 条」，
// 而管理员以为处理干净了。宁可整批失败让人把 id 改对。
// 为什么要有 ② 那个 `status <> 'deleted'`：作者自己早就删过的帖子不该再算进
// taken_down，更不该因为它给作者再发一条「你的帖子被下架了」的通知 ——
// 那条通知是假的，他根本没被处置。
//
// 为什么两条不合成一条：PG 里 `UPDATE ... WHERE id = ANY(...)` 影响不到不存在的主键，
// 而「少了几个」既可能是「不存在」也可能是「已经是 deleted」，一条 SQL 分不出这两种，
// 分不出就给不出正确的错误码。
//
// ⚠ 调用方传的 ids 必须**已经去重**。① 是拿 `count(*)` 和 len(ids) 比大小的，
// 数组里重复的 id 只会命中一行，比出来就是「有帖子不存在」—— 一个假错。
// 去重放在 service：那是「一次请求的意图」层面的规范化，而且留痕里的 detail.ids
// 也要的是去重之后的那份（§12 M6 判据 ③：detail.ids 长度 50）。
func (r *Item) TakedownTx(ctx context.Context, tx pgx.Tx, ids []int64) ([]TakenRow, error) {
	var exist int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM items WHERE id = ANY($1::bigint[])`, ids).Scan(&exist); err != nil {
		return nil, fmt.Errorf("repo.Item.TakedownTx 预检存在性 (%d 个 id): %w", len(ids), err)
	}
	if exist != len(ids) {
		return nil, apperr.WrapMsg(pgx.ErrNoRows, apperr.CodeNotFound,
			fmt.Sprintf("这批 id 里有 %d 条帖子不存在", len(ids)-exist))
	}

	rows, err := tx.Query(ctx, `
		UPDATE items SET status = 'deleted', updated_at = now()
		 WHERE id = ANY($1::bigint[]) AND status <> 'deleted'
		RETURNING id, user_id`, ids)
	if err != nil {
		if ae := TranslateConstraint(err); ae != nil {
			return nil, ae
		}
		return nil, fmt.Errorf("repo.Item.TakedownTx (%d 个 id): %w", len(ids), err)
	}
	defer rows.Close()

	out := []TakenRow{}
	for rows.Next() {
		var t TakenRow
		if err := rows.Scan(&t.ItemID, &t.UserID); err != nil {
			return nil, fmt.Errorf("repo.Item.TakedownTx 扫描一行: %w", err)
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("repo.Item.TakedownTx 迭代: %w", err)
	}
	return out, nil
}

// RestoreTx 恢复一条被下架的帖子（#44）：status 从 deleted 回到 open，返回作者 id。
//
// 影响 0 行时**必须再查一次**才知道该报哪个错，而这两种情况的文案完全不同：
//   - id 压根不存在 → NOT_FOUND
//   - 存在但当前不是 deleted → VALIDATION（「这条帖子现在不是被下架的状态」）
//
// 都报 NOT_FOUND 的话，管理员对着一条 open 的帖子点恢复，看到的是「帖子不存在」——
// 他会以为数据丢了，然后去翻数据库。这就是为什么这里多发一条 SELECT：
// 错误信息得说对。这条 SELECT 也在同一个事务里，读到的就是刚才那一次判断的依据。
//
// ⚠ 恢复的目标状态写死 'open'，不是「恢复成下架之前那个状态」。理由是这个库没有存
// 下架之前的状态（items 只有一列 status），而 #43 的留痕里存的是 id 列表不是状态快照。
// 真要精确恢复就得给 items 加一列 `pre_takedown_status`，为一年发生不了几次的
// 「下架了一条已归还的帖」加一列不值当。代价写在注释里：
// 一条本来 closed（已确认归还）的帖子被下架又被恢复之后，它会变回 open。
func (r *Item) RestoreTx(ctx context.Context, tx pgx.Tx, id int64) (int64, error) {
	var ownerID int64
	err := tx.QueryRow(ctx, `
		UPDATE items SET status = 'open', updated_at = now()
		 WHERE id = $1 AND status = 'deleted'
		RETURNING user_id`, id).Scan(&ownerID)
	if !errors.Is(err, pgx.ErrNoRows) {
		if err != nil {
			if ae := TranslateConstraint(err); ae != nil {
				return 0, ae
			}
			return 0, fmt.Errorf("repo.Item.RestoreTx(%d): %w", id, err)
		}
		return ownerID, nil
	}

	var current string
	switch err := tx.QueryRow(ctx, `SELECT status FROM items WHERE id = $1`, id).Scan(&current); {
	case errors.Is(err, pgx.ErrNoRows):
		return 0, apperr.WrapMsg(err, apperr.CodeNotFound, "帖子不存在")
	case err != nil:
		return 0, fmt.Errorf("repo.Item.RestoreTx(%d) 复核当前状态: %w", id, err)
	}
	return 0, apperr.Validation(fmt.Sprintf("这条帖子现在是 %s，不是被下架的帖子，没什么可恢复的", current),
		apperr.FieldError{Field: "id", Msg: "只有 status='deleted' 的帖子能被恢复"})
}

// DeletedImage 是 #45 删掉一张图片时**从被删的那一行里**带出来的事实。
//
// 为什么图片自己的 id 和它所属帖子的 id 都要带出来（看起来只要一个就能定位）：
//   - image_id → 留痕的 target_id。管理员处置的对象是这张图，留痕就该指向它；
//     指到帖子那儿，事后翻 admin_actions 就看不出到底是帖子被改了还是图被删了
//   - item_id → 通知要带跳转目标（§4 的 notifications.item_id），作者点进去
//     得落到那张图所在的帖子
//   - path → 磁盘上那个文件。行删掉之后这个路径**再也查不出来**，
//     不在 RETURNING 里带出来就只能留一个没人认领的文件，而里面可能是别人的照片
//   - user_id → 帖子作者，通知发给谁
type DeletedImage struct {
	ImageID int64
	ItemID  int64
	UserID  int64
	Path    string
}

// DeleteImageTx 删一行图片，**在调用方的事务里**，返回磁盘路径和这条帖子作者的 id。
//
// 和上面那个 DeleteImage（#42，帖主自删）的区别只有一个：这一条要 JOIN 出作者。
// 因为 #45 是管理员删**别人**的图，删完必须给他发一条「你帖子的一张图被删了」的通知，
// 而 item_images 表里只有 item_id —— 没有作者这一列可给。
//
// DELETE ... USING ... RETURNING 一条搞定，而不是「先 SELECT 拿 path 和作者，再 DELETE」：
// 两条之间那一瞬间，帖子可能已经被删了（items 被删会级联删掉图片行），
// 那条 DELETE 就会静默影响 0 行，而调用方以为自己删掉了、还顺手给一个已经不存在的
// 作者发了一条通知。RETURNING 没有这个缝。
func (r *Item) DeleteImageTx(ctx context.Context, tx pgx.Tx, imageID int64) (*DeletedImage, error) {
	var d DeletedImage
	err := tx.QueryRow(ctx, `
		DELETE FROM item_images im
		     USING items i
		 WHERE im.id = $1 AND i.id = im.item_id
		RETURNING im.id, im.item_id, im.path, i.user_id`, imageID).
		Scan(&d.ImageID, &d.ItemID, &d.Path, &d.UserID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apperr.WrapMsg(err, apperr.CodeNotFound, "图片不存在")
		}
		if ae := TranslateConstraint(err); ae != nil {
			return nil, ae
		}
		return nil, fmt.Errorf("repo.Item.DeleteImageTx(%d): %w", imageID, err)
	}
	return &d, nil
}

// OwnerTx 在调用方的事务里取一条帖子的作者 id。
//
// 为什么单独有这一条这么短的 SQL：#49 的 `resolution=ban` 要封的是**被举报帖子的作者**，
// 而 reports 表里没有那一列（只有 item_id），处置举报又必须在同一个事务里做完 ——
// 用 pool 版本的 GetByID 去查就落在事务外面了，那中间帖子可能已经换了作者（不可能，
// user_id 不可改）或整行被 admin 删了（可能）。更重要的是**分层**：
// service 不该为了拿一列而自己写 SQL。
//
// 返回 NOT_FOUND 而不是 0：0 不是合法 id，让它一路走到 users 表的外键上，
// 得到的是「用户不存在」这种指错对象的报错。
func (r *Item) OwnerTx(ctx context.Context, tx pgx.Tx, itemID int64) (int64, error) {
	var ownerID int64
	err := tx.QueryRow(ctx, `SELECT user_id FROM items WHERE id = $1`, itemID).Scan(&ownerID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, apperr.WrapMsg(err, apperr.CodeNotFound, "帖子不存在")
		}
		return 0, fmt.Errorf("repo.Item.OwnerTx(%d): %w", itemID, err)
	}
	return ownerID, nil
}

// insertImages 批量插入图片行，sort_order 按传入顺序从 0 递增。
//
// 传入顺序 = 前端表单里的顺序 = 用户心里的「第一张图」，所以直接拿数组下标当
// sort_order，不让用户另填一个序号（那正是定位原则 6 要避免的：让用户填他不知道的信息）。
func insertImages(ctx context.Context, tx pgx.Tx, itemID int64, paths []string) error {
	if len(paths) == 0 {
		return nil
	}
	// 一条多值 INSERT 而不是循环里发 N 条：N 条就意味着 N 次往返，
	// 在 LOG_LEVEL=debug 下还会打 N 条 SQL 日志，看的人根本分不清哪条是哪张图。
	var (
		sb   strings.Builder
		args []any
	)
	sb.WriteString(`INSERT INTO item_images (item_id, path, sort_order) VALUES `)
	for i, p := range paths {
		if i > 0 {
			sb.WriteString(", ")
		}
		sb.WriteString(fmt.Sprintf("($%d, $%d, $%d)", len(args)+1, len(args)+2, len(args)+3))
		args = append(args, itemID, p, i)
	}
	if _, err := tx.Exec(ctx, sb.String(), args...); err != nil {
		if ae := TranslateConstraint(err); ae != nil {
			return ae
		}
		return fmt.Errorf("repo.Item.insertImages(%d): %w", itemID, err)
	}
	return nil
}

// scanItemDetail 从单行查询里扫一条 ItemDetail。
func scanItemDetail(row pgx.Row) (*model.ItemDetail, error) {
	var d model.ItemDetail
	if err := scanItemDetailRows(row, &d); err != nil {
		return nil, err
	}
	return &d, nil
}

// scanItemDetailRows 按 itemDetailCols 的顺序扫一行。
//
// 参数类型是 pgx.Row（接口）而不是 *pgx.Rows：pgx.Rows 本身就实现了 pgx.Row，
// 所以单行查询和结果集迭代共用这一个函数 —— 列顺序只在这里写一遍。
func scanItemDetailRows(row pgx.Row, d *model.ItemDetail) error {
	return row.Scan(
		&d.ID, &d.ItemType, &d.UserID, &d.Title, &d.Description, &d.CategoryID,
		&d.LocationID, &d.LocationDetail, &d.LastSeenAt, &d.LostAt, &d.FoundAt, &d.Contact,
		&d.Status, &d.ViewCount, &d.CreatedAt, &d.UpdatedAt,
		&d.CategoryName, &d.LocationName, &d.AuthorNickname, &d.CoverPath,
		&d.CategoryParentID, &d.LocationParentID, &d.LocationTopID, &d.LocationIsFreeform,
	)
}
