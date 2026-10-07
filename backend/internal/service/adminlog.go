package service

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"lostfound/internal/apperr"
	"lostfound/internal/model"
	"lostfound/internal/repo"
)

// adminlog 是整个 M6 的承重墙，也是这个仓库里**唯一**允许写 admin_actions 的地方。
//
// 它只有一个导出函数，而且刻意不是某个结构体的方法 —— 没有状态、没有构造函数、
// 不能「先 New 一个再说」，所以「忘记埋点」这件事在代码形态上没有藏身之处：
// 要么调了 Record，要么就没调，grep 一遍全知道。
//
// ## 为什么第二个参数是 pgx.Tx 而不是 *pgxpool.Pool
//
// 这是这个函数**全部的价值所在**，计划 §3.7 和 §15 两处都在强调它，因为它把一条
// 纪律变成了编译期性质：
//
//   - 如果签名收 pool，那么「业务改完了，另外开一条连接补一行日志」这种写法是合法的，
//     而它会在崩溃/超时时留下「帖子删了、日志没有」的状态 —— 那条链子的终点是
//     「谁删的那 50 条帖子」查不出来，整个治理模型当场归零。
//   - 收 pgx.Tx 之后，调用方**必须已经开了事务才编译得过**。业务和日志共用一个 tx，
//     日志 INSERT 失败 → 整个事务回滚 → 业务也没生效。
//     「漏了留痕而业务已生效」这一类事故在类型层面就不存在了。
//
// 反过来说它也有一个必须承认的局限：**类型只保证「同事务」，不保证「一定会调」**。
// 有人写了一个新的 admin 写端点、一次 Record 都没调，编译是过的。
// 那一半由表驱动的 TestEveryAdminWriteIsLogged 守（它拿着动作清单逐条调用、
// 数 admin_actions 的增量）。两道加起来才叫「不靠人记」。
//
// ## 为什么这里不打日志
//
// 日志由调用方（service/moderation.go 的各方法）用**自己那条带 request_id 的 logger** 打。
// 这个函数拿不到 gin.Context，硬塞一个 slog.Default() 进去，打出来的行没有 request_id，
// 排查时按 id 捞链路会捞不到 —— 与其给一条残缺的，不如把打日志留在有上下文的那一层。

// maxReasonLen 对齐 admin_actions.reason 的 VARCHAR(500)。
//
// 用 rune 计数而不是字节：那个 500 是 PG 的字符数语义，一个汉字算 1。
// 让超长串走到数据库去报 22001 也能拦下来，但报出来的是 INTERNAL + 一句英文约束名，
// 而在这一层判就能给出带 field 的 VALIDATION。
const maxReasonLen = 500

// Record 往 admin_actions 插一行治理留痕。
//
// 参数顺序按计划 §15 那句签名原样落地：
//
//	Record(ctx, tx, adminID, action, targetType, targetID, reason, detail)
//
// detail 是 map 而不是「已经序列化好的 JSON 字符串」，理由是**全站只有一个序列化点**：
// 如果各处自己 json.Marshal 再传字符串进来，就会有「某处传了非法 JSON」这种格子，
// 而那一格坏了要等到 INSERT 时才炸。放在这里，调用方只能交出 Go 的值。
//
// target_id：批量动作（#43）存**第一个** id，完整列表交给 detail 里的 ids 数组 ——
// 这是迁移注释里定下的约定，不是这里发明的。
//
// 返回的 error 一律由调用方往上传：它就在事务中间，返回错误 = 回滚 = 业务不生效。
// 这里没有「记不下来就算了」那条分支，那条分支就是这个函数存在的反面。
func Record(ctx context.Context, tx pgx.Tx, adminID int64, action, targetType string,
	targetID int64, reason string, detail map[string]any) error {

	if tx == nil {
		// 走到这里只能是调用方自己写了 `Record(ctx, nil, ...)`。
		// 不 panic 是因为 panic 会绕过 apperr.Respond 变成一条 500 空响应；
		// 包成 Internal 之后响应里有 request_id，日志里有这句人能读的原因。
		return apperr.Internal(fmt.Errorf("adminlog.Record: 传入了 nil 事务 (action=%s, admin=%d)", action, adminID))
	}

	// reason 的这一道校验是**第二道**，第一道在每个端点的入参校验里（缺 reason → VALIDATION）。
	// 两道都要，因为它们的对象不同：第一道服务用户（要给出「哪个字段没填」），
	// 第二道服务代码（保证将来任何一条新的 admin 路径，哪怕忘了查参数，
	// 也不可能往这张唯一的问责表里写进一条空理由 —— 空理由的留痕等于没有留痕）。
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return apperr.Validation("管理员操作必须填写理由",
			apperr.FieldError{Field: "reason", Msg: "这个理由会原样出现在被处置用户收到的通知里"})
	}
	if utf8.RuneCountInString(reason) > maxReasonLen {
		return apperr.Validation("理由太长了",
			apperr.FieldError{Field: "reason", Msg: fmt.Sprintf("最多 %d 个字", maxReasonLen)})
	}

	// 两组枚举值都在这里校验，理由和 model/notification.go 顶部那条一样：
	// 写错常量名如果放任它进库，得到的是 23514（check_violation），
	// 报成 INTERNAL，而排查的人会先去怀疑数据库是不是坏了。
	// 提前判之后错误信息直接指出「未知动作 item_takdown」，一眼看出是拼错了。
	if !model.IsValidAdminAction(action) {
		return apperr.Internal(fmt.Errorf("adminlog.Record: 未知的治理动作 %q（不在迁移的 CHECK 里，多半是常量拼错了）", action))
	}
	if !model.IsValidTargetType(targetType) {
		return apperr.Internal(fmt.Errorf("adminlog.Record: 未知的治理对象类型 %q", targetType))
	}
	if adminID <= 0 {
		return apperr.Internal(fmt.Errorf("adminlog.Record: adminID=%d 不合法，留痕必须挂在一个真实账号上", adminID))
	}
	if targetID <= 0 {
		return apperr.Internal(fmt.Errorf("adminlog.Record: targetID=%d 不合法 (action=%s)", targetID, action))
	}

	payload := []byte("{}")
	if len(detail) > 0 {
		raw, err := json.Marshal(detail)
		if err != nil {
			// 序列化失败只可能是有人在 detail 里塞了 chan / func 这类东西 ——
			// 那是程序员错误，不是用户错误，所以是 Internal 而不是 Validation。
			return apperr.Internal(fmt.Errorf("adminlog.Record 序列化 detail (action=%s): %w", action, err))
		}
		payload = raw
	}

	// $6::jsonb 那句显式转型照 repo/match.go 写 breakdown 的同一处理：
	// 参数是文本，不写 ::jsonb 时 PG 对它的类型推断要靠列，显式写出来不靠推断，
	// 而且报错时能一眼看出这一格该是什么。
	if _, err := tx.Exec(ctx, `
		INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason, detail)
		VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
		adminID, action, targetType, targetID, reason, string(payload)); err != nil {
		if ae := repo.TranslateConstraint(err); ae != nil {
			return ae
		}
		return fmt.Errorf("adminlog.Record 写留痕 (admin=%d, action=%s, target=%s/%d): %w",
			adminID, action, targetType, targetID, err)
	}
	return nil
}

// RecordBatch 是 #43 那种「一次动作作用于 N 个对象」的写法糖。
//
// 它单独存在是为了让「target_id 存第一个 id、完整列表进 detail.ids」这条约定
// **只写在一个地方**。#43 批量下架和 #49 的连带下架都要用它，
// 两处各抄一遍的话，将来谁改了其中一处，另一处的 detail 形状就和 §13 的核对 SQL 不符了。
func RecordBatch(ctx context.Context, tx pgx.Tx, adminID int64, action, targetType string,
	ids []int64, reason string, extra map[string]any) error {

	if len(ids) == 0 {
		return apperr.Validation("没有要处理的对象",
			apperr.FieldError{Field: "ids", Msg: "至少要有 id 才能记一条批量留痕"})
	}

	detail := make(map[string]any, len(extra)+2)
	for k, v := range extra {
		detail[k] = v
	}
	// ids 和 count 在 extra **之后**写：这两个键的形状由本函数的参数决定，
	// 不允许被补充字段覆盖。反过来的话 #49 只要多塞一个 extra{"ids": [...]}
	// 就能伪造出一行「批量下架了某些帖子」的留痕，而那一行是排查纠纷时的第一查询目标
	// （迁移给它专门建了 idx_admin_actions_target）。
	detail["ids"] = ids
	detail["count"] = len(ids)
	return Record(ctx, tx, adminID, action, targetType, ids[0], reason, detail)
}
