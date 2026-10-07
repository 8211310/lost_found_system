package repo

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"lostfound/internal/apperr"
	"lostfound/internal/model"
)

// Dict 是字典表（categories / locations）的数据访问对象。
//
// M2 只需要**读**：两张表的内容是 000001 迁移种进去的 55 + 91 行，
// 增删端点（#9–#12）在 M6，改名压根没有端点（走 Adminer，计划 §4）。
type Dict struct {
	pool *pgxpool.Pool
}

func NewDict(pool *pgxpool.Pool) *Dict { return &Dict{pool: pool} }

// CategoryRows 取全部**启用中**的分类，按 (level, sort_order, id) 排好序。
//
// 排序里的 level 是建树的前提：父节点的 level 一定比子节点小，
// 所以「父行先出现」这件事由 ORDER BY 保证，model.BuildCategoryTree 才能
// 一遍扫过去就把子节点挂到已经建好的父节点上。
//
// 只取 is_active=true：停用一个小类之后它就不该再出现在发帖的下拉框里。
// 已经引用了它的老帖子不受影响 —— items 那边是 JOIN categories 而不是
// 「JOIN 且要求 active」，所以老帖子的分类名照样显示得出来。
func (r *Dict) CategoryRows(ctx context.Context) ([]model.Category, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, parent_id, name, level, sort_order, is_active
		  FROM categories
		 WHERE is_active
	  ORDER BY level, sort_order, id`)
	if err != nil {
		return nil, fmt.Errorf("repo.Dict.CategoryRows: %w", err)
	}
	defer rows.Close()

	out := []model.Category{}
	for rows.Next() {
		var c model.Category
		if err := rows.Scan(&c.ID, &c.ParentID, &c.Name, &c.Level, &c.SortOrder, &c.IsActive); err != nil {
			return nil, fmt.Errorf("repo.Dict.CategoryRows 扫描一行: %w", err)
		}
		out = append(out, c)
	}
	// rows.Err() 必须查：迭代中途连接断了的话，Next() 只是返回 false，
	// 不检查就会把「半份数据」当成「完整数据」交上去 —— 前端表现为
	// 「分类少了一半」，而日志里一片绿。
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("repo.Dict.CategoryRows 迭代: %w", err)
	}
	return out, nil
}

// LocationRows 取全部启用中的地点，规则同 CategoryRows。
func (r *Dict) LocationRows(ctx context.Context) ([]model.Location, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, parent_id, name, level, sort_order, is_active, is_freeform
		  FROM locations
		 WHERE is_active
	  ORDER BY level, sort_order, id`)
	if err != nil {
		return nil, fmt.Errorf("repo.Dict.LocationRows: %w", err)
	}
	defer rows.Close()

	out := []model.Location{}
	for rows.Next() {
		var l model.Location
		if err := rows.Scan(&l.ID, &l.ParentID, &l.Name, &l.Level, &l.SortOrder, &l.IsActive, &l.IsFreeform); err != nil {
			return nil, fmt.Errorf("repo.Dict.LocationRows 扫描一行: %w", err)
		}
		out = append(out, l)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("repo.Dict.LocationRows 迭代: %w", err)
	}
	return out, nil
}

// GetCategory 按主键取一行分类，**不管 is_active** —— 判断「这个分类还能不能用」
// 是 service 的业务规则，repo 只负责诚实地把行取回来。
func (r *Dict) GetCategory(ctx context.Context, id int64) (*model.Category, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT id, parent_id, name, level, sort_order, is_active
		  FROM categories WHERE id = $1`, id)

	var c model.Category
	err := row.Scan(&c.ID, &c.ParentID, &c.Name, &c.Level, &c.SortOrder, &c.IsActive)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apperr.WrapMsg(err, apperr.CodeNotFound, "分类不存在")
		}
		return nil, fmt.Errorf("repo.Dict.GetCategory(%d): %w", id, err)
	}
	return &c, nil
}

// GetLocation 按主键取一行地点，规则同 GetCategory。
func (r *Dict) GetLocation(ctx context.Context, id int64) (*model.Location, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT id, parent_id, name, level, sort_order, is_active, is_freeform
		  FROM locations WHERE id = $1`, id)

	var l model.Location
	err := row.Scan(&l.ID, &l.ParentID, &l.Name, &l.Level, &l.SortOrder, &l.IsActive, &l.IsFreeform)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apperr.WrapMsg(err, apperr.CodeNotFound, "地点不存在")
		}
		return nil, fmt.Errorf("repo.Dict.GetLocation(%d): %w", id, err)
	}
	return &l, nil
}

// CountActiveChildren 数一个地点下面还有几个启用中的子节点。
//
// 发帖时校验「location_id 必须是叶子」用的就是它（计划 §3.2）。
// 为什么不直接判 level=3：「其他」是 level=1 且 is_freeform=true 的**一级叶子**，
// 它没有子节点、用户直接选它。所以「叶子」的准确定义是「没有子节点」，
// 不是「level 最大」—— 按 level 判会把「其他」整个拒掉，而它恰恰是必须能选的。
func (r *Dict) CountActiveChildren(ctx context.Context, id int64) (int, error) {
	var n int
	err := r.pool.QueryRow(ctx, `
		SELECT count(*) FROM locations WHERE parent_id = $1 AND is_active`, id).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("repo.Dict.CountActiveChildren(%d): %w", id, err)
	}
	return n, nil
}

// ============================================================
// M6：字典的增删（#9–#12）
//
// 这一段全部收在事务里，理由是 §4 表头那条统一规则：
// 「reason 是每一个 admin 写操作的必填字段，包括字典增删 #9–#12」。
// 而留痕（admin_actions）和这次增删必须同生同死，所以这里全部收 tx。
//
// 字典是**外键的靶子**：items.category_id / items.location_id / 自己的 parent_id
// 都指着它，所以「删一行」从来不是无副作用的操作，它是一个必须被拦住的操作。
// ============================================================

// 两张字典表各自的层级上限（categories CHECK level IN (1,2)、locations CHECK level IN (1,2,3)）。
const (
	maxCategoryLevel = 2
	maxLocationLevel = 3
)

// 两张表上那条「同名兄弟」唯一索引的名字，分开写。
//
// 本来想用一个常量把两处糊在一起（两条索引结构相同：COALESCE(parent_id,0), name），
// 但索引名是带表名的（uq_categories_sibling / uq_locations_sibling），
// 拿一个常量去比另一张表的冲突就是**永远比不中** —— 症状是同名冲突时
// 用户收到一句通用的「内容和已有的记录冲突了」，而我们知道原因，不该藏。
const (
	uqCategoriesSibling = "uq_categories_sibling"
	uqLocationsSibling  = "uq_locations_sibling"
)

// NewDictRow 是 #9/#11 要写入的一行字典。
//
// 没有 Level 字段：这一列**不是输入**。两张表的 CHECK 都把
// 「level=1 ⇔ parent_id IS NULL」钉死了，也就是说 level 是 parent_id 的函数，
// 让调用方传它等于给调用方一个「传一个和 parent_id 矛盾的值」的机会。
// 于是它在这里由 parent_id 现推（见 resolveLevel）。
//
// IsFreeform 只对地点有意义；分类那边传进来会被忽略（categories 表没这一列）。
type NewDictRow struct {
	ParentID   *int64
	Name       string
	SortOrder  int
	IsFreeform bool
}

// resolveLevel 由 parent_id 现推 level，顺带确认父节点真的存在、还塞得下。
//
// 表名和层级上限做成参数而不是写死两遍：categories 和 locations 这段逻辑除了
// 这两处差别以外一模一样，写两遍就得维护两遍，而「两个字典端点行为悄悄不一致」
// 是最难发现的那类 bug（分类能建到第三级而地点不能 —— 没人会把这当回事，
// 直到有人真的建出一个三级分类）。
//
// 父节点不存在返回 VALIDATION 而不是 NOT_FOUND：那是 #9 请求体里一个字段值不对，
// 而 NOT_FOUND 在这个语境里说的是「你要删的那条字典不存在」。两种 4xx 不混用。
func resolveLevel(ctx context.Context, tx pgx.Tx, table string, maxLevel int, parentID *int64) (int, error) {
	if parentID == nil {
		return 1, nil
	}

	var parentLevel int
	err := tx.QueryRow(ctx,
		fmt.Sprintf(`SELECT level FROM %s WHERE id = $1`, table), *parentID).Scan(&parentLevel)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, apperr.Validation("上级不存在",
				apperr.FieldError{Field: "parent_id", Msg: "这个 id 在那张字典表里查不到，请从 #7/#8 返回的树里选"})
		}
		return 0, fmt.Errorf("repo.Dict.resolveLevel(%s, parent=%d): %w", table, *parentID, err)
	}
	if parentLevel >= maxLevel {
		return 0, apperr.Validation(
			fmt.Sprintf("这张字典最多 %d 级，第 %d 级下面不能再挂子节点", maxLevel, maxLevel),
			apperr.FieldError{Field: "parent_id", Msg: "要挂的父节点已经是最里层了"})
	}
	return parentLevel + 1, nil
}

// CreateCategoryTx 插一行分类（#9），返回新行。
func (r *Dict) CreateCategoryTx(ctx context.Context, tx pgx.Tx, p NewDictRow) (*model.Category, error) {
	level, err := resolveLevel(ctx, tx, "categories", maxCategoryLevel, p.ParentID)
	if err != nil {
		return nil, err
	}

	var c model.Category
	err = tx.QueryRow(ctx, `
		INSERT INTO categories (parent_id, name, level, sort_order)
		VALUES ($1, $2, $3, $4)
		RETURNING id, parent_id, name, level, sort_order, is_active`,
		p.ParentID, p.Name, level, p.SortOrder).
		Scan(&c.ID, &c.ParentID, &c.Name, &c.Level, &c.SortOrder, &c.IsActive)
	if err != nil {
		if isSiblingConflict(err, uqCategoriesSibling) {
			return nil, apperr.WrapMsg(err, apperr.CodeConflict, "同一个上级下面已经有一个同名的分类了")
		}
		if ae := TranslateConstraint(err); ae != nil {
			return nil, ae
		}
		return nil, fmt.Errorf("repo.Dict.CreateCategoryTx(%q): %w", p.Name, err)
	}
	return &c, nil
}

// CreateLocationTx 插一行地点（#11），规则和 CreateCategoryTx 一模一样，多一列 is_freeform。
func (r *Dict) CreateLocationTx(ctx context.Context, tx pgx.Tx, p NewDictRow) (*model.Location, error) {
	level, err := resolveLevel(ctx, tx, "locations", maxLocationLevel, p.ParentID)
	if err != nil {
		return nil, err
	}

	var l model.Location
	err = tx.QueryRow(ctx, `
		INSERT INTO locations (parent_id, name, level, sort_order, is_freeform)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, parent_id, name, level, sort_order, is_active, is_freeform`,
		p.ParentID, p.Name, level, p.SortOrder, p.IsFreeform).
		Scan(&l.ID, &l.ParentID, &l.Name, &l.Level, &l.SortOrder, &l.IsActive, &l.IsFreeform)
	if err != nil {
		if isSiblingConflict(err, uqLocationsSibling) {
			return nil, apperr.WrapMsg(err, apperr.CodeConflict, "同一个上级下面已经有一个同名的地点了")
		}
		if ae := TranslateConstraint(err); ae != nil {
			return nil, ae
		}
		return nil, fmt.Errorf("repo.Dict.CreateLocationTx(%q): %w", p.Name, err)
	}
	return &l, nil
}

// isSiblingConflict 判这次唯一索引冲突是不是「撞了同名兄弟」。
//
// 必须**先**判它再交给 TranslateConstraint：后者把所有 23505 一律翻成
// 「内容和已有的记录冲突了」，而那句对这个场景是废话 —— 管理员需要知道的是
// 「同一个大类下面已经有『钱包』了」，否则他会一遍遍重试同一个名字。
func isSiblingConflict(err error, index string) bool {
	var pge *pgconn.PgError
	return errors.As(err, &pge) && pge.Code == pgUniqueViolation && pge.ConstraintName == index
}

// DeleteCategoryTx 删一行分类（#10），返回被删掉的那一行。
//
// 返回旧行不是顺手：调用方要把它写进留痕的 detail（「删了 id=37 的『钱包』」），
// 而行删掉之后那个名字**再也查不出来**。和 repo.Item.DeleteImage 为磁盘路径
// 做_RETURNING 是完全同一件事。
//
// 两条 SQL，先数后删，**没有**写成一条带子查询的 DELETE。
// 本来可以写成 `DELETE ... RETURNING ..., (SELECT count(*) ...) AS children` 一条搞定，
// 但那要求「RETURNING 里的标量子查询看到的是删除前还是删除后的引用」这件事有一个
// 我能说清楚的确定答案，而我更不愿意让一个 409/404 的判定建在
// 「我记得 PG 在这个位置是这么求值的」上面。分两步的代价只是同一个事务里多一次往返，
// 换来的是每一步的语义都能单独讲出来。
//
// 预检有两个，都撞成 409 CATEGORY_IN_USE：
//   - 还有子节点：删掉大类会让它下面所有小类变孤儿，而那些小类正是帖子引用的对象
//   - 还被帖子引用：items.category_id 这个外键**没有 ON DELETE CASCADE**，
//     真删了直接 23503，用户看到 500
//
// ⚠ 这两条预检是**兜底说明**，不是防线。防线在数据库自己身上：
// items.category_id 和 categories.parent_id 两个外键都指向这一行，
// 所以就算这个预检整个漏掉，DELETE 也只会以 23503 失败（TranslateConstraint
// 把它兜成 4xx），绝不会删掉一个仍被引用的条目。预检存在的意义是**把那句 23503
// 翻译成人能看懂的话**：到底是「下面还有 3 个子节点」还是「有 12 条帖子在用」。
// 这两件事管理员下一步要做的是**相反的**（先删子节点 vs 先处理帖子），
// 所以分辨出来比笼统报「被引用」有用得多。
func (r *Dict) DeleteCategoryTx(ctx context.Context, tx pgx.Tx, id int64) (*model.Category, error) {
	children, used, err := dictBlockers(ctx, tx, "categories", "category_id", id)
	if err != nil {
		return nil, err
	}
	if err := dictNotInUse(children, used); err != nil {
		return nil, err
	}

	var c model.Category
	err = tx.QueryRow(ctx, `
		DELETE FROM categories WHERE id = $1
		RETURNING id, parent_id, name, level, sort_order, is_active`, id).
		Scan(&c.ID, &c.ParentID, &c.Name, &c.Level, &c.SortOrder, &c.IsActive)
	if err != nil {
		return nil, dictDeleteError(err, "categories", id, "分类")
	}
	return &c, nil
}

// DeleteLocationTx 删一行地点（#12），规则同 DeleteCategoryTx。
//
// 多查的一列 is_freeform 让「其他」这一行也能被删掉 —— 它确实删得掉：
// 它没有子节点，而被它引用的帖子会被 used 那一支挡住。
func (r *Dict) DeleteLocationTx(ctx context.Context, tx pgx.Tx, id int64) (*model.Location, error) {
	children, used, err := dictBlockers(ctx, tx, "locations", "location_id", id)
	if err != nil {
		return nil, err
	}
	if err := dictNotInUse(children, used); err != nil {
		return nil, err
	}

	var l model.Location
	err = tx.QueryRow(ctx, `
		DELETE FROM locations WHERE id = $1
		RETURNING id, parent_id, name, level, sort_order, is_active, is_freeform`, id).
		Scan(&l.ID, &l.ParentID, &l.Name, &l.Level, &l.SortOrder, &l.IsActive, &l.IsFreeform)
	if err != nil {
		return nil, dictDeleteError(err, "locations", id, "地点")
	}
	return &l, nil
}

// dictBlockers 数出一个字典条目的两个删除障碍：子节点数、被多少条帖子引用。
//
// 两张表的帖子引用列名不同（category_id / location_id），做成参数。
// ⚠ 这两个列名**只可能来自本文件里那两个调用点**，永远不是用户输入 ——
// 拼进 SQL 的标识符必须过这种「值域是我自己写的」检查。
//
// 第一条 SQL 里 `WHERE id = $1` 拿不到行时两个 count 也是 0，
// 所以「这一行不存在」不能靠这里的返回值判 —— 那件事交给后面的 DELETE（它
// 拿不到行就是 NOT_FOUND）。这里只负责「存在的话，是什么在挡着」。
func dictBlockers(ctx context.Context, tx pgx.Tx, table, itemCol string, id int64) (children, used int, err error) {
	err = tx.QueryRow(ctx, fmt.Sprintf(`
		SELECT (SELECT count(*) FROM %s  ch WHERE ch.parent_id   = $1),
		       (SELECT count(*) FROM items i  WHERE i.%s = $1)`, table, itemCol), id).
		Scan(&children, &used)
	if err != nil {
		return 0, 0, fmt.Errorf("repo.Dict.dictBlockers(%s, %d): %w", table, id, err)
	}
	return children, used, nil
}

// dictNotInUse 把两个计数变成一个 409，或者 nil（可以删）。
//
// 用 NewMsg 而不是 WrapMsg：这里底下**没有**一个数据库错误可包 ——
// 这是我们自己数出来的两个数做的判断，硬塞一个 Err 只会让日志里多一条
// 与原因无关的错误文本。
func dictNotInUse(children, used int) error {
	if children == 0 && used == 0 {
		return nil
	}
	var why []string
	if children > 0 {
		why = append(why, fmt.Sprintf("下面还有 %d 个子节点", children))
	}
	if used > 0 {
		why = append(why, fmt.Sprintf("有 %d 条帖子正在引用它", used))
	}
	return apperr.NewMsg(apperr.CodeCategoryInUse, "这个条目删不掉："+strings.Join(why, "，并且 "))
}

// dictDeleteError 收 DELETE 那一步的三种结局。
//
// ErrNoRows 在这里**只有一种含义**：那一行不存在（或被并发的另一个管理员先删了）。
// 预检里那两种「存在但有东西挡着」的情况已经在上面变成 409 走了。
func dictDeleteError(err error, table string, id int64, what string) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.WrapMsg(err, apperr.CodeNotFound, what+"不存在")
	}
	if ae := TranslateConstraint(err); ae != nil {
		return ae
	}
	return fmt.Errorf("repo.Dict.DeleteTx(%s, %d): %w", table, id, err)
}
