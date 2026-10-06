// Package smoketest 是计划 §10 的第②层：API 冒烟测试。
//
// 它用 httptest + 真实测试库跑完整链路。关键是 router.Setup 和 main.go 调的是同一个函数，
// 所以「测试过了但线上不行」这类事故不会发生。
//
// 断言纪律：只断言 code，不断言 message —— message 是给人看的中文，随时可以改措辞（§8）。
package smoketest

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"

	"lostfound/internal/apperr"
	"lostfound/internal/auth"
	"lostfound/internal/config"
	"lostfound/internal/database"
	"lostfound/internal/router"
)

// testDBName 是集成测试专用的库名。它和开发库 lostfound 完全隔离 ——
// 测试里 TRUNCATE 一切，绝不能误伤开发数据。
const testDBName = "lostfound_test"

// harness 在 TestMain 里建一次，全包共享。
// 测试之间靠 TruncateAll 清场，不靠重建整个环境（重建一次要跑完整迁移，太慢）。
var harness *Harness

func TestMain(m *testing.M) {
	dsn := strings.TrimSpace(os.Getenv("TEST_DB_DSN"))

	if dsn == "" {
		// REQUIRE_INTEGRATION=1 时「没配 DSN」直接算失败，而不是静默跳过。
		// 这条兜底存在的唯一理由：防止「全绿但其实一条集成测试都没跑」这种最坏的假象。
		if os.Getenv("REQUIRE_INTEGRATION") == "1" {
			fmt.Fprint(os.Stderr, `
================================================================================
 集成测试被要求必须运行（REQUIRE_INTEGRATION=1），但 TEST_DB_DSN 是空的。
 这是失败，不是跳过 —— 否则「全绿」可能意味着一条集成测试都没跑。

 先确认 docker compose up -d 已经起了 postgres，然后：

   cd backend
   TEST_DB_DSN="postgres://lf:lf@localhost:5432/postgres?sslmode=disable" \
   REQUIRE_INTEGRATION=1 go test ./...

 注意 DSN 指向的是维护库 postgres，测试代码会自己创建并使用 lostfound_test。
================================================================================
`)
			os.Exit(1)
		}

		fmt.Print(`
--------------------------------------------------------------------------------
 跳过 smoketest 包：TEST_DB_DSN 未设置，所以集成测试一条都没跑。
 这不算失败（纯单元测试仍然会跑），但也不代表功能被验证过。

 要真正跑集成测试：
   docker compose up -d
   cd backend
   TEST_DB_DSN="postgres://lf:lf@localhost:5432/postgres?sslmode=disable" go test ./...
--------------------------------------------------------------------------------
`)
		os.Exit(0)
	}

	h, err := setup(dsn)
	if err != nil {
		fmt.Fprintf(os.Stderr, "\n集成测试环境搭建失败: %v\n\n", err)
		os.Exit(1)
	}
	harness = h
	defer h.Close()

	os.Exit(m.Run())
}

// setup 建库 → 迁移 → 装配和生产完全相同的路由 → 起一个 httptest server。
func setup(dsn string) (*Harness, error) {
	ctx := context.Background()

	if err := ensureTestDatabase(ctx, dsn); err != nil {
		return nil, err
	}

	poolCfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("解析 TEST_DB_DSN 失败: %w", err)
	}
	poolCfg.ConnConfig.Database = testDBName
	poolCfg.MaxConns = 5

	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return nil, fmt.Errorf("连不上测试库 %s: %w", testDBName, err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	// 先 down 到 0 再 up：保证 schema 是干净的，不会被上一次跑剩的结构污染。
	// 尤其是改过迁移文件之后，只有 down-up 才能暴露「迁移不可重入」这种问题。
	if err := database.MigrateDown(pool, logger); err != nil {
		pool.Close()
		return nil, err
	}
	if err := database.Migrate(pool, logger); err != nil {
		pool.Close()
		return nil, err
	}

	gin.SetMode(gin.TestMode) // 否则 gin 会把路由表打进测试输出，淹没真正的失败信息

	// cfg 必须是**能通过 Setup 内部校验**的：M1 起 Setup 会真的 new 一个
	// auth.TokenSigner，它拒绝空密钥和非正有效期。
	// 密钥只活在这个测试进程里，和任何环境的真密钥无关。
	cfg := config.Config{
		Env:       "test",
		JWTSecret: "smoketest-secret-0123456789abcdef0123456789abcdef",
		JWTExpire: time.Hour,
	}

	engine, err := router.Setup(cfg, pool)
	if err != nil {
		pool.Close()
		return nil, fmt.Errorf("装配路由失败: %w", err)
	}

	return &Harness{
		Pool:   pool,
		Server: httptest.NewServer(engine),
		Cfg:    cfg,
	}, nil
}

// ensureTestDatabase 用 Go 代码建库。
//
// 为什么不用 createdb 命令：本机没有安装任何 postgres 客户端工具（§1.2），
// 唯一能连上数据库的东西就是我们自己程序里的 pgx。所以建库也只能自己来。
func ensureTestDatabase(ctx context.Context, dsn string) error {
	// 先连到 DSN 里写的那个库（通常是 postgres 维护库），因为 CREATE DATABASE
	// 不能连着「正要被创建的那个库」执行
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return fmt.Errorf("连不上 TEST_DB_DSN 指向的维护库（docker compose up -d 起了吗？）: %w", err)
	}
	defer pool.Close()

	var exists bool
	err = pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1)`, testDBName).Scan(&exists)
	if err != nil {
		return fmt.Errorf("查询 %s 是否存在时失败: %w", testDBName, err)
	}
	if exists {
		return nil
	}

	// CREATE DATABASE 不能用占位符传库名（它是标识符不是值），只能拼字符串。
	// testDBName 是本文件里的常量、不来自任何外部输入，所以这里没有注入风险。
	// 不加 ENCODING / TEMPLATE 选项，让它继承和开发库 lostfound 完全一样的编码与排序规则。
	if _, err := pool.Exec(ctx, `CREATE DATABASE `+testDBName); err != nil {
		return fmt.Errorf("创建测试库 %s 失败: %w", testDBName, err)
	}
	return nil
}

// ---------- Harness ----------

// Harness 是一次集成测试的完整环境：真实测试库 + 真实路由 + 真实 HTTP。
type Harness struct {
	Pool   *pgxpool.Pool
	Server *httptest.Server
	Cfg    config.Config
}

func (h *Harness) Close() {
	h.Server.Close()
	h.Pool.Close()
}

// TruncateAll 清空全部业务表并重置自增 id，让每个测试从干净状态开始、测试之间零串扰。
//
// ⚠ 这里是 10 张表，不是 12 张 —— categories 和 locations 故意不列。
// 它们装的是迁移种进去的 55 + 91 行字典数据，truncate 掉之后所有测试都建不出帖子
// （items.category_id / location_id 外键找不到目标）。别「补全」这两张表。
//
// 反过来，业务表少列一张就会串味：像 TestEveryAdminWriteIsLogged 那种
// 「断言行数恰好 +N」的测试会被上一个用例留下的行污染。
func (h *Harness) TruncateAll(t *testing.T) {
	t.Helper()
	const q = `TRUNCATE users, items, item_images, contact_views, item_returns,
	                   credit_logs, notifications, match_pairs, reports, admin_actions
	           RESTART IDENTITY CASCADE`
	if _, err := h.Pool.Exec(context.Background(), q); err != nil {
		t.Fatalf("TruncateAll 失败（表名和 §10 的清单对不上？加了新表却忘了往这里加？）: %v", err)
	}
}

// QueryRow 是测试里直接查库的快捷方式 —— 很多断言必须落到数据行上，
// 光看 HTTP 响应是不够的（例如「reject 之后 items.status 仍然是 open」）。
func (h *Harness) QueryRow(t *testing.T, sql string, args ...any) map[string]any {
	t.Helper()
	rows, err := h.Pool.Query(context.Background(), sql, args...)
	if err != nil {
		t.Fatalf("查询失败 %q: %v", sql, err)
	}
	defer rows.Close()

	fields := rows.FieldDescriptions()
	if !rows.Next() {
		t.Fatalf("查询没有返回任何行 %q（args=%v）", sql, args)
	}
	raw, err := rows.Values()
	if err != nil {
		t.Fatalf("读取行失败 %q: %v", sql, err)
	}

	out := make(map[string]any, len(fields))
	for i, f := range fields {
		out[string(f.Name)] = raw[i]
	}
	return out
}

// Count 返回一条 SELECT count(*) 的结果。
func (h *Harness) Count(t *testing.T, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := h.Pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatalf("计数查询失败 %q: %v", sql, err)
	}
	return n
}

// ---------- HTTP 调用 ----------

// Response 是 §8 统一信封解码后的结果。
type Response struct {
	HTTPStatus int
	Code       string
	Message    string
	RequestID  string
	Data       json.RawMessage

	// Header 留着给需要检查响应头的测试用（例如 X-Request-ID 是否回写）
	Header http.Header
}

// DataInto 把 data 字段解进 v。
func (r Response) DataInto(t *testing.T, v any) {
	t.Helper()
	if len(r.Data) == 0 || string(r.Data) == "null" {
		t.Fatalf("响应的 data 是空的，无法解进 %T；code=%s message=%s", v, r.Code, r.Message)
	}
	if err := json.Unmarshal(r.Data, v); err != nil {
		t.Fatalf("解析 data 失败: %v\n原始 data: %s", err, string(r.Data))
	}
}

// Do 发一个请求并解信封。body 为 nil 时不带请求体；token 非空时加 Authorization 头。
func (h *Harness) Do(t *testing.T, method, path string, body any, token string) Response {
	t.Helper()

	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("序列化请求体失败: %v", err)
		}
		reader = bytes.NewReader(raw)
	}

	req, err := http.NewRequest(method, h.Server.URL+path, reader)
	if err != nil {
		t.Fatalf("构造请求失败: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	resp, err := h.Server.Client().Do(req)
	if err != nil {
		t.Fatalf("%s %s 请求失败: %v", method, path, err)
	}
	defer resp.Body.Close()

	rawBody, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("读取响应体失败: %v", err)
	}

	var env struct {
		Code      string          `json:"code"`
		Message   string          `json:"message"`
		Data      json.RawMessage `json:"data"`
		RequestID string          `json:"request_id"`
	}
	// 信封解不开就是契约被破坏了 —— 这时候必须把原始响应体打出来，否则没法定位
	if err := json.Unmarshal(rawBody, &env); err != nil {
		t.Fatalf("%s %s 返回的不是统一信封（§8 被破坏了？）: %v\nHTTP %d\n原始响应: %s",
			method, path, err, resp.StatusCode, truncate(string(rawBody)))
	}

	return Response{
		HTTPStatus: resp.StatusCode,
		Code:       env.Code,
		Message:    env.Message,
		RequestID:  env.RequestID,
		Data:       env.Data,
		Header:     resp.Header,
	}
}

// Get / Post 是两个最常用的快捷方式。
func (h *Harness) Get(t *testing.T, path, token string) Response {
	t.Helper()
	return h.Do(t, http.MethodGet, path, nil, token)
}

func (h *Harness) Post(t *testing.T, path string, body any, token string) Response {
	t.Helper()
	return h.Do(t, http.MethodPost, path, body, token)
}

// RequireCode 断言响应码，失败时把整条响应打出来。
//
// 只比 code 不比 message：message 是给人看的中文，改措辞不该让测试红（§8）。
func RequireCode(t *testing.T, r Response, want string) {
	t.Helper()
	if r.Code != want {
		t.Fatalf("期望 code=%s，实际 code=%s（HTTP %d）\nmessage: %s\nrequest_id: %s\ndata: %s",
			want, r.Code, r.HTTPStatus, r.Message, r.RequestID, truncate(string(r.Data)))
	}
}

// RequireOK 是 RequireCode 的常用特例。
func RequireOK(t *testing.T, r Response, what string) {
	t.Helper()
	if r.Code != apperr.CodeOK {
		t.Fatalf("%s 失败：code=%s message=%s（HTTP %d）\nrequest_id: %s\ndata: %s",
			what, r.Code, r.Message, r.HTTPStatus, r.RequestID, truncate(string(r.Data)))
	}
}

// ---------- 登录态夹具 ----------

// Session 是一个「已登录用户」。M2 之后几乎每条测试都要先有登录态，
// 所以它和 RegisterAndLogin 放在这个共享文件里，而不是塞进 m1 的测试文件。
type Session struct {
	Token    string
	UserID   int64
	Username string
	Nickname string
	Role     string
}

// RegisterAndLogin 走完 #1 注册 + #2 登录，返回一个可用的登录态。
//
// 它刻意**不断言**这两个端点的契约（那是 m1_auth_test.go 的职责），
// 只在出问题时 fatal 并打出完整响应。作为夹具，它的任务是「给我一个能用的 token」；
// 把断言混进夹具的后果是：注册接口一坏，几十条本来在测别的东西的测试全部变红，
// 而红的那一条真正的原因被埋在第一个失败里。
func (h *Harness) RegisterAndLogin(t *testing.T, username, password string) Session {
	t.Helper()

	RequireOK(t, h.Post(t, "/api/auth/register", map[string]any{
		"username": username,
		"password": password,
	}, ""), "夹具注册 "+username)

	r := h.Post(t, "/api/auth/login", map[string]any{
		"username": username,
		"password": password,
	}, "")
	RequireOK(t, r, "夹具登录 "+username)

	var data struct {
		Token string `json:"token"`
		User  struct {
			ID       int64  `json:"id"`
			Username string `json:"username"`
			Nickname string `json:"nickname"`
			Role     string `json:"role"`
		} `json:"user"`
	}
	r.DataInto(t, &data)
	if data.Token == "" {
		t.Fatalf("夹具登录 %s 成功了，但 token 是空的", username)
	}
	return Session{
		Token:    data.Token,
		UserID:   data.User.ID,
		Username: data.User.Username,
		Nickname: data.User.Nickname,
		Role:     data.User.Role,
	}
}

// TokenFor 给任意 user id 铸一个有效 token，不走 #2 登录接口。
//
// 需要它的场合是「这个用户没法登录，但测试必须让他带着 token 发请求」：
// SSO 账号（没有密码）、已被封禁的账号（登录会被拒）、admin（计划里没有
// 「注册成 admin」的端点）。铸出来的 token 和生产签发的完全同源 ——
// 同一个密钥、同一个 auth.TokenSigner 实现，所以中间件分不出区别，
// 这正是「测的是真链路」的意思。
func (h *Harness) TokenFor(t *testing.T, userID int64) string {
	t.Helper()
	signer, err := auth.NewTokenSigner(h.Cfg.JWTSecret, h.Cfg.JWTExpire)
	if err != nil {
		t.Fatalf("铸 token 失败（建 signer 出错）: %v", err)
	}
	tok, err := signer.Issue(userID)
	if err != nil {
		t.Fatalf("铸 token 失败: %v", err)
	}
	return tok.Value
}

// Ban 把一个用户封禁。
//
// 直接改库而不是走接口：M6 才有封禁端点，而 M1 就必须验证「封号立刻生效」
// （role/status 不进 JWT claims 那个设计决定的验收点）。
func (h *Harness) Ban(t *testing.T, userID int64) {
	t.Helper()
	if _, err := h.Pool.Exec(context.Background(),
		`UPDATE users SET status = 'banned', updated_at = now() WHERE id = $1`, userID); err != nil {
		t.Fatalf("封禁用户 %d 失败: %v", userID, err)
	}
}

// truncate 防止一段长响应把测试输出淹掉。
func truncate(s string) string {
	const max = 800
	if len(s) <= max {
		return s
	}
	return s[:max] + fmt.Sprintf("...(截断，共 %d 字节)", len(s))
}
