package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"lostfound/internal/apperr"
	"lostfound/internal/model"
)

// ---------- 一台假的 pgx.Tx ----------

// fakeTx 是 adminlog.Record 的第①层测试用的假事务。
//
// 它实现了完整的 pgx.Tx 接口，但只有 Exec 真的做事：记下这一次调用的 SQL 和全部参数，
// 并按 execErr 返回错误。其余八个方法一律返回「不该被调用」的错误 ——
// 如果哪天 Record 里多了一句 Query，测试会以一句人能读的话红掉，
// 而不是在 nil panic 上堆一屏调用栈。
//
// 为什么用假事务而不是干脆连一次库：这一层测的是**校验规则**（空 reason 不许进库、
// 未知动作不许进库），而这些规则的正确表现恰恰是「一次 SQL 都没发出去」。
// 拿真库测的话，「没写进去」这件事既可能是校验生效了、也可能是 SQL 写坏了报错了没被发现，
// 分不开。用假 tx 就能直接断言 calls 的长度是 0。
type fakeTx struct {
	calls []fakeCall
	// execErr 非 nil 时 Exec 返回它，用来测「数据库报错时错误原样往上传」。
	execErr error
}

type fakeCall struct {
	sql  string
	args []any
}

func (f *fakeTx) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	f.calls = append(f.calls, fakeCall{sql: sql, args: args})
	if f.execErr != nil {
		return pgconn.CommandTag{}, f.execErr
	}
	return pgconn.NewCommandTag("INSERT 0 1"), nil
}

func (f *fakeTx) Begin(context.Context) (pgx.Tx, error) {
	return nil, errors.New("fakeTx.Begin 不该被调用：留痕函数只负责写自己那一行，不负责开子事务")
}

func (f *fakeTx) Commit(context.Context) error {
	return errors.New("fakeTx.Commit 不该被调用：事务的生死由调用方（moderation）决定")
}

func (f *fakeTx) Rollback(context.Context) error {
	return errors.New("fakeTx.Rollback 不该被调用：同上")
}

func (f *fakeTx) CopyFrom(context.Context, pgx.Identifier, []string, pgx.CopyFromSource) (int64, error) {
	return 0, errors.New("fakeTx.CopyFrom 不该被调用")
}

func (f *fakeTx) SendBatch(context.Context, *pgx.Batch) pgx.BatchResults {
	panic("fakeTx.SendBatch 不该被调用")
}

func (f *fakeTx) Limit() int64 { return 0 }

// Conn 是 pgx.Tx 接口在 v5 里的第十个方法（返回底层那条连接）。
// 只能返回 nil：这个签名没有 error 可以带，而 Record 从不碰它。
// 真要有人开始用它，测试会在下一行的 nil 解引用上炸出调用栈 ——
// 那也总比静默地拿到一条「真实的」连接去动开发库好。
func (f *fakeTx) Conn() *pgx.Conn { return nil }

// LargeObjects 是 pgx.Tx 接口里的 Postgres 大对象入口（返回的是同包的值类型 pgx.LargeObjects）。
// 本项目一次也不会用到：图片一律走文件系统上传（#6），库里只存路径。
// 返回零值而不是 panic，理由是这签名「有返回值没有 error」，没法把不满塞进返回值里；
// 真要有人调它，第一次用它做 lo.Create 就会炸出调用栈，位置比在这里 panic 更靠近原因。
func (f *fakeTx) LargeObjects() pgx.LargeObjects { return pgx.LargeObjects{} }

func (f *fakeTx) Prepare(context.Context, string, string) (*pgconn.StatementDescription, error) {
	return nil, errors.New("fakeTx.Prepare 不该被调用")
}

func (f *fakeTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("fakeTx.Query 不该被调用：Record 只写不读")
}

func (f *fakeTx) QueryRow(context.Context, string, ...any) pgx.Row {
	panic("fakeTx.QueryRow 不该被调用：Record 只写不读")
}

// ---------- 断言小工具 ----------

// reasonField 找出错误里 field 为 reason 的那条字段级细节。
func reasonField(t *testing.T, err error) apperr.FieldError {
	t.Helper()
	var ae *apperr.Error
	if !errors.As(err, &ae) {
		t.Fatalf("期望的是 *apperr.Error，实际是 %T：%v", err, err)
	}
	for _, f := range ae.Fields {
		if f.Field == "reason" {
			return f
		}
	}
	t.Fatalf("VALIDATION 里没带 reason 这个字段名，前端定位不到输入框：%+v", ae.Fields)
	return apperr.FieldError{}
}

// recorded 把第 i 次 Exec 的参数按 INSERT 的列顺序解释成一个小结构，
// 免得断言里全是 args[3]、args[5] 这种看不出是什么的下标。
type recorded struct {
	adminID    int64
	action     string
	targetType string
	targetID   int64
	reason     string
	detail     map[string]any
}

func mustRecorded(t *testing.T, tx *fakeTx, i int) recorded {
	t.Helper()
	if len(tx.calls) <= i {
		t.Fatalf("只有 %d 次 Exec，取不到第 %d 次", len(tx.calls), i)
	}
	a := tx.calls[i].args
	if len(a) != 6 {
		t.Fatalf("INSERT 的参数应该是 6 个（admin_id, action, target_type, target_id, reason, detail），实际 %d 个", len(a))
	}
	var detail map[string]any
	raw, ok := a[5].(string)
	if !ok {
		t.Fatalf("detail 应该是序列化好的字符串，实际类型 %T", a[5])
	}
	if err := json.Unmarshal([]byte(raw), &detail); err != nil {
		t.Fatalf("detail 不是合法 JSON（列类型是 JSONB，坏 JSON 会在库里炸）：%v", err)
	}
	return recorded{
		adminID:    a[0].(int64),
		action:     a[1].(string),
		targetType: a[2].(string),
		targetID:   a[3].(int64),
		reason:     a[4].(string),
		detail:     detail,
	}
}

// ---------- Record：什么情况下**不许**写库 ----------

// TestRecordRejectsBlankReason 是这条不变式的最直接测试：
// **空理由永远不会成为一行留痕**。
//
// 三种空白都要测，因为它们来自三个不同的地方：
//   - ""     用户压根没填
//   - "   "  用户按了一下空格
//   - "\t\u3000" 从别处粘贴带来的制表和全角空格
//
// 第三个尤其重要：迁移里那条 CHECK 用的是
// btrim(reason, E' \t\n\v\f\r' || chr(160) || chr(12288))，
// 也就是说数据库**认识**全角空格和 NBSP 并把它们当空白。
// Go 这边 strings.TrimSpace 只认 ASCII 空白和 Unicode 空白分类，
// \u3000（IDEOGRAPHIC SPACE）在 Unicode 里是 Zs，TrimSpace 会去掉它，所以两边口径一致；
// 但 chr(160) 那个 NBSP 也在 Zs 里 —— 一并测进来，是为了让「两边口径真的是一致的」
// 这件事留在这份文件里，而不是留在注释里。
func TestRecordRejectsBlankReason(t *testing.T) {
	for _, reason := range []string{"", "   ", "\t\n ", "\u3000", "\u00a0", "\u3000 \t"} {
		tx := &fakeTx{}
		err := Record(context.Background(), tx, 1, model.ActionItemTakedown, model.TargetItem, 7, reason, nil)
		if err == nil {
			t.Fatalf("reason=%q 竟然通过了校验", reason)
		}
		if !apperr.IsCode(err, apperr.CodeValidation) {
			t.Errorf("reason=%q 应该是 VALIDATION，实际是 %v", reason, err)
		}
		reasonField(t, err)
		if len(tx.calls) != 0 {
			t.Errorf("reason=%q 校验没拦住，已经发出 %d 条 SQL：%+v", reason, len(tx.calls), tx.calls)
		}
	}
}

// TestRecordTrimsReasonBeforeWriting 说明一个容易被忽略的细节：
// 进库的是**去掉首尾空白之后**的理由。
//
// 因为这一串文字会原样出现在被处置用户收到的通知里（§3.7），
// 「 刷屏广告 」和「刷屏广告」在数据库里是两行不同的 reason，
// 而在用户眼里是一模一样的 —— 排查时按 reason 分组会分成两组。
func TestRecordTrimsReasonBeforeWriting(t *testing.T) {
	tx := &fakeTx{}
	if err := Record(context.Background(), tx, 1, model.ActionItemTakedown, model.TargetItem, 7, "  刷屏广告  ", nil); err != nil {
		t.Fatalf("合法的 reason 被拒了：%v", err)
	}
	if got := mustRecorded(t, tx, 0).reason; got != "刷屏广告" {
		t.Errorf("reason 应该被 trim 成「刷屏广告」，实际 %q", got)
	}
}

// TestRecordRejectsOverlongReason 测的是 rune 计数那一段。
//
// 长度用例全部用**汉字**而不是字母：VARCHAR(500) 在 PG 里是 500 个字符，
// 用字母测的话 len(s) 和 rune 数恰好相等，写成字节计数也一样能过 ——
// 那等于这条测试什么都没测。
func TestRecordRejectsOverlongReason(t *testing.T) {
	exactly := strings.Repeat("字", maxReasonLen)
	tx := &fakeTx{}
	if err := Record(context.Background(), tx, 1, model.ActionWarningSent, model.TargetUser, 3, exactly, nil); err != nil {
		t.Errorf("%d 个汉字正好卡在边界上，应该放行：%v", maxReasonLen, err)
	}
	if len(tx.calls) != 1 {
		t.Fatalf("恰好 %d 字时应该写一行，实际 %d 行", maxReasonLen, len(tx.calls))
	}

	tx2 := &fakeTx{}
	err := Record(context.Background(), tx2, 1, model.ActionWarningSent, model.TargetUser, 3, exactly+"一", nil)
	if !apperr.IsCode(err, apperr.CodeValidation) {
		t.Errorf("超一个字符就该 VALIDATION，实际 %v", err)
	}
	if got := reasonField(t, err).Msg; !strings.Contains(got, "500") {
		t.Errorf("提示里应该写明上限是多少，实际 %q", got)
	}
	if len(tx2.calls) != 0 {
		t.Errorf("超长 reason 不许进库，却发出了 %d 条 SQL", len(tx2.calls))
	}
}

// TestRecordRejectsUnknownActionOrTarget 是那两个 IsValid 检查的用意所在：
// **拼错常量时报的是人话，不是 23514**。
//
// 两个错都归 Internal（500）而不是 VALIDATION，这个区分是有意的：
// 请求参数里确实出现了这个字符串，但没有任何用户能「改正」它 ——
// action 和 target_type 由代码写死，不接受用户传值。
// 所以那是程序员错误，响应必须是 500（并且真实原因进日志），
// 而不是骗用户说他填错了。
func TestRecordRejectsUnknownActionOrTarget(t *testing.T) {
	cases := []struct {
		name       string
		action     string
		targetType string
	}{
		{"动作少个字母", "item_takdown", model.TargetItem},
		{"动作下划线打错", "itemtakedown", model.TargetItem},
		{"对象类型写错", model.ActionItemTakedown, "items"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			tx := &fakeTx{}
			err := Record(context.Background(), tx, 1, c.action, c.targetType, 7, "刷屏广告", nil)
			if !apperr.IsCode(err, apperr.CodeInternal) {
				t.Errorf("期望 INTERNAL（那是代码写错了），实际 %v", err)
			}
			if len(tx.calls) != 0 {
				t.Errorf("非法枚举值不该发出 SQL：%+v", tx.calls)
			}
		})
	}
}

// TestRecordRejectsZeroIDs 守住两件事：留痕必须挂在真实账号上、必须指向真实对象。
//
// admin_id = 0 在数据库里会撞外键（23503）而不是撞 NOT NULL，因为 users.id 从 1 开始，
// 「0」在 SQL 里是一个完全合法的值 —— 只有这一层知道 0 在我们的约定里意味着「没登录」。
// 如果放任它进库，TranslateConstraint 会翻成 VALIDATION「引用了一个不存在的资源」，
// 一个管理员看到这句话会以为自己在跟表单搏斗，而真相是路由忘了挂 JWT。
func TestRecordRejectsZeroIDs(t *testing.T) {
	for _, c := range []struct {
		name   string
		admin  int64
		target int64
	}{
		{"没有管理员", 0, 7},
		{"管理员 id 是负数", -1, 7},
		{"没有治理对象", 1, 0},
		{"对象 id 是负数", 1, -5},
	} {
		t.Run(c.name, func(t *testing.T) {
			tx := &fakeTx{}
			err := Record(context.Background(), tx, c.admin, model.ActionItemTakedown, model.TargetItem, c.target, "刷屏广告", nil)
			if !apperr.IsCode(err, apperr.CodeInternal) {
				t.Errorf("期望 INTERNAL，实际 %v", err)
			}
			if len(tx.calls) != 0 {
				t.Errorf("非法 id 不该发出 SQL：%+v", tx.calls)
			}
		})
	}
}

// TestRecordRejectsNilTx 是把「第二参数必须是事务」这句话变成可执行的。
//
// 类型系统能挡住 *pgxpool.Pool，但挡不住一个字面量 nil。
// 这一条不是洁癖：nil tx 在 pgx 里会 panic（Tx 是个 interface，nil 没有方法表），
// 而 panic 会绕过 apperr.Respond —— 用户拿到一个空响应体的 500，日志里只有一坨调用栈，
// 连 request_id 都没有。
func TestRecordRejectsNilTx(t *testing.T) {
	err := Record(context.Background(), nil, 1, model.ActionItemTakedown, model.TargetItem, 7, "刷屏广告", nil)
	if !apperr.IsCode(err, apperr.CodeInternal) {
		t.Fatalf("nil 事务该报 INTERNAL 而不是 panic，实际 %v", err)
	}
}

// ---------- Record：写进去的那一行长什么样 ----------

// TestRecordWritesExactlyOneRow 是这条链上最重要的一条断言：**一次调用 = 一行**。
//
// 为什么盯这么死：#43 那种批量动作如果 Record 内部写了两行（比如给每个 id 都写一行），
// §12 M6 判据里那条「admin_actions 恰好 1 行、detail.ids 长度 50」就永远不成立，
// 而「按动作计数」这条规则（§4 倒数第二节）会从约定变成运气。
func TestRecordWritesExactlyOneRow(t *testing.T) {
	tx := &fakeTx{}
	if err := Record(context.Background(), tx, 9, model.ActionUserBan, model.TargetUser, 42, "持续骚扰他人", nil); err != nil {
		t.Fatalf("合法调用被拒：%v", err)
	}
	if len(tx.calls) != 1 {
		t.Fatalf("一次 Record 应该只发一条 SQL，实际 %d 条：%+v", len(tx.calls), tx.calls)
	}

	got := mustRecorded(t, tx, 0)
	if got.adminID != 9 || got.action != model.ActionUserBan ||
		got.targetType != model.TargetUser || got.targetID != 42 || got.reason != "持续骚扰他人" {
		t.Errorf("六列里有一列不对： %+v", got)
	}
	// detail 为 nil 时是**空对象**而不是 null：JSONB 列有 NOT NULL DEFAULT '{}'，
	// 而前端按 detail.ids 取值时，null 和 {} 需要两套判空。统一成永远是对象。
	raw, _ := json.Marshal(got.detail)
	if string(raw) == "null" || len(got.detail) != 0 {
		t.Errorf("detail 为 nil 时应该写成空对象 {}，实际 %s", raw)
	}
}

// TestRecordSerializesDetailAsObject 保证 detail 里能装下批量场景要的那些形状：
// 一个 id 数组、一个数字、一个嵌套的处置结论。
//
// 这里刻意用 ids + count 这两个键名 —— §13 第 9 步的核对 SQL 直接写着
// jsonb_array_length(detail->'ids')，键名拼错的那一行数据在接口上完全正常，
// 只有那条排查 SQL 会查不出东西。把它写进测试，键名就有了第二个来源。
func TestRecordSerializesDetailAsObject(t *testing.T) {
	tx := &fakeTx{}
	detail := map[string]any{
		"ids":        []int64{1, 2, 3},
		"count":      3,
		"resolution": "takedown",
	}
	if err := Record(context.Background(), tx, 9, model.ActionItemTakedown, model.TargetItem, 1, "刷屏广告", detail); err != nil {
		t.Fatalf("合法调用被拒：%v", err)
	}
	got := mustRecorded(t, tx, 0)
	ids, ok := got.detail["ids"].([]any)
	if !ok || len(ids) != 3 {
		t.Fatalf("detail.ids 应该是一个三元素数组，实际 %#v", got.detail["ids"])
	}
	if fmt.Sprint(ids[0]) != "1" {
		t.Errorf("第一个 id 应该是 1，实际 %v", ids[0])
	}
	if got.detail["count"].(float64) != 3 {
		t.Errorf("detail.count 应该是数字 3，实际 %#v", got.detail["count"])
	}
	if got.detail["resolution"] != "takedown" {
		t.Errorf("detail.resolution 丢了，实际 %#v", got.detail)
	}
}

// TestRecordRejectsUnserializableDetail 测的是有人在 detail 里塞了不能序列化的东西。
//
// 这不是假想：map 的 key 是 int、或者值是个 chan，json.Marshal 都会失败。
// 关键是**失败必须在发 SQL 之前**：如果先发再报错，那一行会以「半个 JSON」的形式
// 留在库里吗？不会（SQL 参数不完整时 pgx 自己就拦了），但错误会变成一句 pg 的报错，
// 而真实原因（哪个键装错了东西）就丢了。
func TestRecordRejectsUnserializableDetail(t *testing.T) {
	tx := &fakeTx{}
	err := Record(context.Background(), tx, 9, model.ActionWarningSent, model.TargetUser, 3, "提醒", map[string]any{"bad": make(chan int)})
	if !apperr.IsCode(err, apperr.CodeInternal) {
		t.Fatalf("期望 INTERNAL，实际 %v", err)
	}
	if len(tx.calls) != 0 {
		t.Errorf("序列化失败时不该发 SQL：%+v", tx.calls)
	}
}

// ---------- Record：数据库报错时怎么往上走 ----------

// TestRecordPropagatesDBError 用两种不同的库端错误测同一件事：**错误一定往上传**，
// 因为往上传才有回滚。「adminlog 写失败就忽略」是这个函数最危险的假想实现 ——
// 它会返回 nil，事务照常提交，业务生效而无留痕。
func TestRecordPropagatesDBError(t *testing.T) {
	t.Run("外键违规翻成 VALIDATION", func(t *testing.T) {
		tx := &fakeTx{execErr: &pgconn.PgError{Code: "23503", Message: `insert violates foreign key constraint "admin_actions_admin_id_fkey"`}}
		err := Record(context.Background(), tx, 999, model.ActionItemTakedown, model.TargetItem, 7, "刷屏广告", nil)
		if err == nil {
			t.Fatal("库端报错被吞了：调用方会以为留痕成功，事务照常提交")
		}
		if !apperr.IsCode(err, apperr.CodeValidation) {
			t.Errorf("外键违规应该走 TranslateConstraint，实际 %v", err)
		}
	})

	t.Run("普通故障包成 INTERNAL", func(t *testing.T) {
		tx := &fakeTx{execErr: errors.New("connection reset by peer")}
		err := Record(context.Background(), tx, 9, model.ActionItemTakedown, model.TargetItem, 7, "刷屏广告", nil)
		if err == nil {
			t.Fatal("库端报错被吞了")
		}
		// 这条**不能**是 apperr 类型：它是普通 error，一路往上冒到 handler，
		// 由 apperr.Respond 统一转 500。这里断言的是「没有被就地降级成一个业务码」。
		var ae *apperr.Error
		if errors.As(err, &ae) {
			t.Errorf("普通故障不该被翻译成业务错误码，实际是 %s：%v", ae.Code, err)
		}
		if !strings.Contains(err.Error(), "connection reset") {
			t.Errorf("包装后的错误应该带着原始原因（日志靠它），实际 %v", err)
		}
	})
}

// ---------- RecordBatch ----------

// TestRecordBatchShape 是 §13 第 9 步那条核对 SQL 的镜像：
// target_id 存**第一个** id，完整列表进 detail.ids，另带一个 count。
func TestRecordBatchShape(t *testing.T) {
	tx := &fakeTx{}
	if err := RecordBatch(context.Background(), tx, 9, model.ActionItemTakedown, model.TargetItem,
		[]int64{101, 7, 88}, "刷屏广告", nil); err != nil {
		t.Fatalf("批量留痕被拒：%v", err)
	}
	if len(tx.calls) != 1 {
		t.Fatalf("50 个 id 也只该写一行，实际 %d 行", len(tx.calls))
	}
	got := mustRecorded(t, tx, 0)
	if got.targetID != 101 {
		t.Errorf("target_id 应该是 ids 的第一个（101），实际 %d", got.targetID)
	}
	ids, _ := got.detail["ids"].([]any)
	if len(ids) != 3 {
		t.Fatalf("detail.ids 应该有 3 个，实际 %#v", got.detail["ids"])
	}
	if got.detail["count"].(float64) != 3 {
		t.Errorf("detail.count 应该是 3，实际 %#v", got.detail["count"])
	}
}

// TestRecordBatchExtraCannotForgeIds 守住一个具体的越权面：
// extra 是各端点自己塞的补充字段（比如 report_id、resolution），
// 它**不能**覆盖 ids / count 这两个由参数决定的键。
//
// 反过来的话，#49 只要多传一个 extra{"ids": [...]} 就能伪造出一行「批量下架了某些帖子」
// 的留痕，而那一行是排查纠纷时的第一查询目标（迁移给它专门建了索引）。
func TestRecordBatchExtraCannotForgeIds(t *testing.T) {
	tx := &fakeTx{}
	if err := RecordBatch(context.Background(), tx, 9, model.ActionItemTakedown, model.TargetItem,
		[]int64{5, 6}, "刷屏广告", map[string]any{"ids": []int64{999}, "count": 1, "report_id": 3}); err != nil {
		t.Fatalf("被拒：%v", err)
	}
	got := mustRecorded(t, tx, 0)
	ids, _ := got.detail["ids"].([]any)
	if len(ids) != 2 || fmt.Sprint(ids[0]) != "5" {
		t.Errorf("extra 覆盖了 ids：实际 %#v", got.detail["ids"])
	}
	if got.detail["count"].(float64) != 2 {
		t.Errorf("extra 覆盖了 count：实际 %#v", got.detail["count"])
	}
	if got.detail["report_id"].(float64) != 3 {
		t.Errorf("extra 自己的键应该照常保留，实际 %#v", got.detail)
	}
}

func TestRecordBatchRejectsEmptyIDs(t *testing.T) {
	tx := &fakeTx{}
	err := RecordBatch(context.Background(), tx, 9, model.ActionItemTakedown, model.TargetItem, nil, "刷屏广告", nil)
	if !apperr.IsCode(err, apperr.CodeValidation) {
		t.Fatalf("空列表应该 VALIDATION，实际 %v", err)
	}
	if len(tx.calls) != 0 {
		t.Errorf("空列表不该发出 SQL：%+v", tx.calls)
	}
}

// ---------- model 那两组枚举的自检 ----------

// TestActionAndTargetListsMatchTheirCheckConstraints 不是走过场的「常量等于自己」：
// 它断言的是**这两张表的长度和内容与迁移里的 CHECK 一致**。
//
// 492 行的那个文件（000001 迁移）里的值是唯一的真相来源，但纯单测起不了库，
// 所以这里能做的是把「加了新枚举值时必须同时更新这里」这条纪律
// 变成一个会红的数字。真要验证数据库侧，M6 的第②层有一条测试会拿一个非法 action
// 直接 INSERT 并期待 23514。
func TestActionAndTargetListsMatchTheirCheckConstraints(t *testing.T) {
	actions := model.AdminActionValues()
	if len(actions) != 12 {
		t.Errorf("迁移里 admin_actions 的 CHECK 有 12 个值，这里 %d 个：%v", len(actions), actions)
	}
	targets := model.TargetTypeValues()
	if len(targets) != 7 {
		t.Errorf("迁移里 target_type 的 CHECK 有 7 个值，这里 %d 个：%v", len(targets), targets)
	}
	for _, a := range actions {
		if !model.IsValidAdminAction(a) {
			t.Errorf("%q 在 AdminActionValues 里但 IsValidAdminAction 说它不合法（两张表长分了）", a)
		}
	}
	for _, tp := range targets {
		if !model.IsValidTargetType(tp) {
			t.Errorf("%q 在 TargetTypeValues 里但 IsValidTargetType 说它不合法", tp)
		}
	}
}

// TestAdminActionViewDetailShape 保证 #50 的 detail 在响应里是一个**对象**而不是字符串。
//
// 用 json.Marshal 而不是直接看结构体：只有真的序列化一次才知道 RawMessage 有没有被转义成
// 一段带反斜杠的文本 —— 那会让前端多写一次 JSON.parse，而计划 §4 第 50 行写的是对象。
func TestAdminActionViewDetailShape(t *testing.T) {
	row := model.AdminActionRow{
		AdminAction: model.AdminAction{
			ID: 1, AdminID: 9, Action: model.ActionItemTakedown,
			TargetType: model.TargetItem, TargetID: 101,
			Reason: "刷屏广告", Detail: `{"ids":[101,7,88],"count":3}`,
		},
		AdminNickname: "管理员小张",
	}
	raw, err := json.Marshal(row.View())
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}
	out := string(raw)
	if strings.Contains(out, `\"detail\":`) || strings.Contains(out, `"detail":"{`) {
		t.Errorf("detail 被序列化成了字符串而不是对象：%s", out)
	}
	for _, want := range []string{`"detail":{"ids":[101,7,88]`, `"admin":{"id":9,"nickname":"管理员小张"}`} {
		if !strings.Contains(out, want) {
			t.Errorf("响应里应该有 %s，实际 %s", want, out)
		}
	}
}

// TestAdminActionViewOmitsAdminWhenAccountGone 测那个指针字段：账号不在了给 null，
// 而不是整个把这行藏掉。
//
// 这一条存在的意义是「日志比账号活得久」这个设计决定：如果这里为了省一个 nil 判断
// 把 JOIN 改成 INNER，注销一个管理员就等于**抹掉他做过的所有治理记录** ——
// 而那正好是这套模型最不能接受的事。
func TestAdminActionViewOmitsAdminWhenAccountGone(t *testing.T) {
	row := model.AdminActionRow{
		AdminAction: model.AdminAction{ID: 2, AdminID: 9, Action: model.ActionUserBan,
			TargetType: model.TargetUser, TargetID: 3, Reason: "骚扰", Detail: "{}"},
		AdminMissing: true,
	}
	v := row.View()
	if v.Admin == nil {
		// AdminMissing 为 true 时给 nil —— 但 AdminID 本身还是要留在行里吗？
		// 不在：AdminBrief 只有 id 和 nickname 两个字段，账号都没了，那个 id 无处可查。
		return
	}
	t.Errorf("AdminMissing=true 时 admin 应该是 null，实际 %+v", v.Admin)
}
