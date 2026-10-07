// Package repo 是唯一允许出现 SQL 的一层（计划 §6 分层规则）。
//
// 约定：一个函数 ≈ 一条 SQL。不 import gin，不写业务 if ——
// 「密码错三次要不要锁」这种规则住在 service，这里只负责把行取出来、写进去。
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

// userCols 是 users 表的取列清单。
//
// 抽成一个常量而不是每条 SQL 各写一遍：SELECT 的列顺序必须和 scanUser 里的
// Scan 参数顺序严格一致，写三遍就意味着改一处要记得改三处 —— 而漏改的症状是
// 「扫描类型不匹配」或者更糟的「两个同为 string 的列悄悄对调」，编译期一声不响。
const userCols = `id, username, password_hash, auth_source, sso_user_id, real_name,
	student_id, avatar_url, nickname, role, status, phone, email, credit_score,
	created_at, updated_at`

// User 是 users 表的数据访问对象。
type User struct {
	pool *pgxpool.Pool
}

// NewUser 造一个 User repo。依赖在 main.go 里手工 new（§6：不用 wire/fx）。
func NewUser(pool *pgxpool.Pool) *User { return &User{pool: pool} }

// NewLocalUser 是注册时要写入的字段。
//
// 刻意只包含本地注册需要的三样，不预留 SSO 参数：M8 接杭电助手时会加一个
// 兄弟方法（CreateFromSSO），而不是把这里撑成一堆永远传 nil 的可选字段。
// 预留用不上的参数等于让每个调用点都要回答「这个我是不是该填」。
type NewLocalUser struct {
	Username     string
	PasswordHash string // bcrypt 哈希，永不是明文
	Nickname     string
}

// CreateLocal 插入一个本地账号并返回完整的一行。
//
// 用户名撞车（部分唯一索引 uq_users_username）转成 USER_ALREADY_EXISTS。
// 这件事在 repo 做而不是在 service 先 SELECT 一次再 INSERT：先查后插是竞态的，
// 两个请求同时通过检查就会有一个在 INSERT 时炸掉，而那条错误如果没被翻译，
// 用户会收到一个 INTERNAL 500 —— 明明只是重名。让唯一索引当裁判才是原子的。
func (r *User) CreateLocal(ctx context.Context, p NewLocalUser) (*model.User, error) {
	row := r.pool.QueryRow(ctx, `
		INSERT INTO users (username, password_hash, nickname, auth_source)
		VALUES ($1, $2, $3, $4)
		RETURNING `+userCols,
		p.Username, p.PasswordHash, p.Nickname, model.AuthSourceLocal)

	u, err := scanUser(row)
	if err != nil {
		var pge *pgconn.PgError
		if errors.As(err, &pge) && pge.Code == pgUniqueViolation {
			// Err 保留原始错误供日志用，但响应体里只会出现「用户名已被占用」
			return nil, apperr.WrapMsg(err, apperr.CodeUserAlreadyExists, "用户名已被占用")
		}
		return nil, fmt.Errorf("repo.User.CreateLocal(%q): %w", p.Username, err)
	}
	return u, nil
}

// GetByID 按主键取一行。查无此行返回 apperr NOT_FOUND（Err 里仍是 pgx.ErrNoRows，
// 上层可以用 errors.Is 继续穿透判断）。
func (r *User) GetByID(ctx context.Context, id int64) (*model.User, error) {
	row := r.pool.QueryRow(ctx, `SELECT `+userCols+` FROM users WHERE id = $1`, id)
	u, err := scanUser(row)
	if err != nil {
		return nil, r.wrapNotFound(err, "GetByID", fmt.Sprint(id))
	}
	return u, nil
}

// GetByUsername 按用户名取一行，登录走的就是它（uq_users_username 是唯一索引）。
//
// ⚠ 调用方注意：登录路径上「查无此人」绝不能原样变成 NOT_FOUND 返给用户 ——
// 那等于开了一个账号枚举接口（挨个试用户名，看谁返回 404 谁返回 401，就能把
// 全部注册用户名爬出来）。auth.LocalProvider 会把它和「密码错」合并成同一个
// INVALID_CREDENTIALS。这里保持诚实返回 NOT_FOUND，翻译的责任在认得语境的那一层。
func (r *User) GetByUsername(ctx context.Context, username string) (*model.User, error) {
	row := r.pool.QueryRow(ctx, `SELECT `+userCols+` FROM users WHERE username = $1`, username)
	u, err := scanUser(row)
	if err != nil {
		return nil, r.wrapNotFound(err, "GetByUsername", username)
	}
	return u, nil
}

// UpdateProfile 覆写资料三件套并返回新的一行。
//
// 这里是**无条件覆写**，不用 COALESCE($2, nickname) 那种「传 NULL 就不改」的写法。
// 因为 COALESCE 分不清「我没传这个字段」和「我要把它清空」—— 而 phone/email
// 恰恰是用户会想清空的（填错了、换号了）。所以「没传就保持原值」的合并逻辑放在
// service 层用 Go 代码做（那里能区分 *string 的 nil 和指向空串的指针），
// 到 repo 时三个值都已经是最终值了。
//
// updated_at 必须显式写 now()：这个库没有 trigger（000001 迁移里一个都没有），
// 漏写的话这一列会永远停在注册时间，而它唯一的用途就是「这行最后被动过是什么时候」。
func (r *User) UpdateProfile(ctx context.Context, id int64, nickname string, phone, email *string) (*model.User, error) {
	row := r.pool.QueryRow(ctx, `
		UPDATE users
		   SET nickname = $2, phone = $3, email = $4, updated_at = now()
		 WHERE id = $1
		RETURNING `+userCols,
		id, nickname, phone, email)

	u, err := scanUser(row)
	if err != nil {
		return nil, r.wrapNotFound(err, "UpdateProfile", fmt.Sprint(id))
	}
	return u, nil
}

// UpdatePasswordHash 换密码哈希。旧哈希直接丢弃，不留历史 ——
// 密码历史对这个系统没有任何用途，留着只是一份泄漏面。
func (r *User) UpdatePasswordHash(ctx context.Context, id int64, hash string) error {
	tag, err := r.pool.Exec(ctx, `
		UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, id, hash)
	if err != nil {
		return fmt.Errorf("repo.User.UpdatePasswordHash(%d): %w", id, err)
	}
	// 影响 0 行说明 id 不存在。不当成成功放过：调用方以为改好了，用户下次登录却失败，
	// 而日志里一片绿 —— 这种「静默没生效」是最难查的一类 bug。
	if tag.RowsAffected() == 0 {
		return apperr.WrapMsg(pgx.ErrNoRows, apperr.CodeNotFound, "用户不存在")
	}
	return nil
}

// wrapNotFound 把 pgx.ErrNoRows 翻译成 apperr NOT_FOUND，其它错误原样包装。
//
// 这个区分很重要：连接断了不该报「用户不存在」，那会把一次数据库故障
// 伪装成一个正常的业务结果，排查时会一路往「数据是不是没了」的方向查。
func (r *User) wrapNotFound(err error, fn, arg string) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.WrapMsg(err, apperr.CodeNotFound, "用户不存在")
	}
	return fmt.Errorf("repo.User.%s(%s): %w", fn, arg, err)
}

// scanUser 按 userCols 的顺序扫一行。列顺序改动时这里必须同步改 ——
// 这也是为什么 userCols 只写一遍：它和这个函数是同一个约定的两半。
func scanUser(row pgx.Row) (*model.User, error) {
	var u model.User
	err := row.Scan(
		&u.ID, &u.Username, &u.PasswordHash, &u.AuthSource, &u.SSOUserID, &u.RealName,
		&u.StudentID, &u.AvatarURL, &u.Nickname, &u.Role, &u.Status, &u.Phone, &u.Email,
		&u.CreditScore, &u.CreatedAt, &u.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// ---------- M6：管理员要的那三件事 ----------

// UserFilter 是 #34 GET /api/admin/users 的查询条件。
//
// 三个条件全可选，但**语义和 #14 广场那个 ListFilter 不一样**，所以不复用：
// 广场的默认是「只给 open 的帖子」，这里的默认是**全站所有人**（含 banned）——
// 「找出这个人」是治理的起点，把被封的人藏起来的话，这一页就不能用来核对封禁记录。
//
// Keyword 匹配三个字段（用户名 / 昵称 / 真实姓名）而不是一个：管理员手里的线索
// 取决于他是在哪看到这个名字的，而这三列在系统里都真实存在、都可能就是他手上那个。
type UserFilter struct {
	Keyword  string
	Role     string
	Status   string
	Page     int
	PageSize int
}

// ListByFilter 分页取用户，最新注册在前。
//
// ⚠ 这一条**没有**行级归属过滤（不像 #19「只看自己的」），因为它返回的正是全站用户，
// 边界完全由 middleware.RequireAdmin 那道鉴权决定。
// 所以这里的 SQL 只允许被 #34 那条挂了 RequireAdmin 的路由调用链触达 ——
// 将来如果有人把 ListByFilter 接到一个普通端点上，那才是要拦的事，
// 而不是在这里加一个「只有 admin 能调」的参数：repo 不知道调用者是谁，那是分层的纪律。
//
// Keyword 走 escapeLike：那个函数是 repo 包里的（M2 给 #14 写的），
// 它处理的是「用户输入里带 % 或 _」——不转义的话管理员搜「100%」会命中一大片。
// ILIKE 而不是 LIKE：昵称和真实姓名里可能有大小写混排，管理员不会在意大小写。
func (r *User) ListByFilter(ctx context.Context, f UserFilter) ([]model.User, int, error) {
	var (
		conds []string
		args  []any
	)
	if f.Keyword != "" {
		args = append(args, "%"+escapeLike(f.Keyword)+"%")
		k := fmt.Sprintf("$%d", len(args))
		conds = append(conds, fmt.Sprintf(`(username ILIKE %s OR nickname ILIKE %s OR real_name ILIKE %s)`, k, k, k))
	}
	if f.Role != "" {
		args = append(args, f.Role)
		conds = append(conds, fmt.Sprintf(`role = $%d`, len(args)))
	}
	if f.Status != "" {
		args = append(args, f.Status)
		conds = append(conds, fmt.Sprintf(`status = $%d`, len(args)))
	}
	where := ""
	if len(conds) > 0 {
		where = " WHERE " + strings.Join(conds, " AND ")
	}

	var total int
	if err := r.pool.QueryRow(ctx, `SELECT count(*) FROM users`+where, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("repo.User.ListByFilter 计数: %w", err)
	}

	limitIdx, offsetIdx := len(args)+1, len(args)+2
	args = append(args, f.PageSize, (f.Page-1)*f.PageSize)

	// 这里**不带** password_hash：userCols 是给认证路径用的完整行，
	// 拿它跑这一条会把哈希一起捞进内存，而 #34 一个都不返回。
	// 单独列一遍清单不是重复，是「这一条查询能泄漏什么」的显式声明。
	rows, err := r.pool.Query(ctx, fmt.Sprintf(
		`SELECT id, username, nickname, real_name, auth_source, role, status, credit_score, created_at
		   FROM users%s ORDER BY created_at DESC, id DESC LIMIT $%d OFFSET $%d`,
		where, limitIdx, offsetIdx), args...)
	if err != nil {
		return nil, 0, fmt.Errorf("repo.User.ListByFilter: %w", err)
	}
	defer rows.Close()

	out := []model.User{}
	for rows.Next() {
		var u model.User
		if err := rows.Scan(&u.ID, &u.Username, &u.Nickname, &u.RealName,
			&u.AuthSource, &u.Role, &u.Status, &u.CreditScore, &u.CreatedAt); err != nil {
			return nil, 0, fmt.Errorf("repo.User.ListByFilter 扫描一行: %w", err)
		}
		out = append(out, u)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("repo.User.ListByFilter 迭代: %w", err)
	}
	return out, total, nil
}

// SetRoleTx 改一个人的角色（#35）。
//
// 名字带 Tx、第一个数据参数是 pgx.Tx：这是 M6 整条治理写路径的约定 ——
// **所有治理写入都必须跑在调用方那个已经开了的事务里**，
// 因为 service/adminlog.Record 要的正是同一个 tx（那个函数拒绝 nil tx，
// 也没有第二条路能让留痕和业务分开提交）。
// 如果这里收 *pgxpool.Pool，「先改库、再另开一条连接补日志」就是可写的，
// 而那正是风险 14 里唯一防线被拆掉的方式。
//
// 返回改完的那一行，而不是只返回 error：#35 的响应要 {id, role}，
// 而「响应里的 role 来自 UPDATE ... RETURNING」比「来自请求参数」强 ——
// 前者是数据库真的存下来的值。
func (r *User) SetRoleTx(ctx context.Context, tx pgx.Tx, id int64, role string) (*model.User, error) {
	row := tx.QueryRow(ctx, `
		UPDATE users SET role = $2, updated_at = now() WHERE id = $1
		RETURNING `+userCols, id, role)

	u, err := scanUser(row)
	if err != nil {
		return nil, wrapUserNotFound(err, "SetRoleTx", id)
	}
	return u, nil
}

// SetStatusTx 改一个人的状态（#36，active / banned）。形状和理由同 SetRoleTx。
//
// 封号之后那个人的**旧 token 立刻失效**，这件事不在这里做，靠的是
// middleware.JWT 每个请求都重新读一行 users（见那个文件的注释）。
// 这一条 UPDATE 只负责写下那个事实， enforcement 是读路径上天然发生的。
// 把「封号」理解成「让事务里的一次 UPDATE 加上一次即时的 token 撤销」是多余的：
// 我们这里没有签发任何东西可撤销。
func (r *User) SetStatusTx(ctx context.Context, tx pgx.Tx, id int64, status string) (*model.User, error) {
	row := tx.QueryRow(ctx, `
		UPDATE users SET status = $2, updated_at = now() WHERE id = $1
		RETURNING `+userCols, id, status)

	u, err := scanUser(row)
	if err != nil {
		return nil, wrapUserNotFound(err, "SetStatusTx", id)
	}
	return u, nil
}

// wrapUserNotFound 只在「确实查无此人」时给 NOT_FOUND，其它错误原样包装。
//
// 从 r.wrapNotFound 抽成包级函数的原因是 Tx 版本的方法收不到 *User 接收者
// （它们不碰 pool），而三条治理写路径都要同一句「用户不存在」。
// 保持和原来一样的判断顺序：连接故障绝不能伪装成 404。
func wrapUserNotFound(err error, fn string, id int64) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.WrapMsg(err, apperr.CodeNotFound, "用户不存在")
	}
	return fmt.Errorf("repo.User.%s(%d): %w", fn, id, err)
}
