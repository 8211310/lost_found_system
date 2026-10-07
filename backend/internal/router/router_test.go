package router

import (
	"net/http"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"lostfound/internal/config"
)

// expectedRoutes 是「当前里程碑应有的全部路由」。
//
// 为什么断言确切集合而不是只断言数量：数量对不上时你还得自己去找是哪条多了或少了；
// 集合对不上时测试直接告诉你是哪条。加了路由却忘了更新这个列表也会红 —— 这正是我们想要的摩擦。
//
// 到 M6 收尾时这个列表必须恰好有 50 条（§4：49 个 JSON API + 1 个 /uploads 静态路由）。
// 现在就是 50 条，而 TestFinalRouteCount 已经开始逐条比对。
var expectedRoutes = []string{
	"GET /api/health",                // #38
	"POST /api/auth/register",        // #1
	"POST /api/auth/login",           // #2
	"GET /api/auth/me",               // #3
	"PUT /api/auth/me",               // #4
	"POST /api/auth/change-password", // #5
	"POST /api/uploads",              // #6
	"GET /api/categories",            // #7
	"GET /api/locations",             // #8
	"POST /api/items",                // #13
	"GET /api/items",                 // #14
	"GET /api/items/:id",             // #15
	"PUT /api/items/:id",             // #16
	"DELETE /api/items/:id",          // #17
	"PATCH /api/items/:id/status",    // #18
	"GET /api/my/items",              // #19
	"GET /uploads/*filepath",         // #40
	"DELETE /api/item-images/:id",    // #42
	"GET /api/items/:id/matches",     // #20
	// ---- M4 ----
	"POST /api/items/:id/unlock-contact",     // #21
	"GET /api/items/:id/contact-views",       // #22
	"GET /api/my/notifications",              // #30
	"GET /api/my/notifications/unread-count", // #31
	"PUT /api/my/notifications/read",         // #32
	"POST /api/items/:id/report",             // #41
	// ---- M5 ----
	"POST /api/items/:id/returns",   // #23
	"GET /api/returns/:id",          // #24
	"POST /api/returns/:id/confirm", // #25
	"POST /api/returns/:id/reject",  // #26
	"POST /api/returns/:id/cancel",  // #27
	"GET /api/my/returns/submitted", // #28
	"GET /api/my/returns/received",  // #29
	"GET /api/my/credit-logs",       // #33
	// ---- M6 ----
	//
	// 这 17 条是「治理能力」的封闭集合，它有多重要看两条测试就够：
	// TestNoAdminCommunityRoutesExist 断言这个集合里**没有** confirm / reject / 关帖 / 干预匹配，
	// TestNonAdminBlockedFromAdminRoutes 断言集合外的普通用户一条都进不来。
	// 所以将来谁想往后台加一个动作，改的应该是这两条测试的期望，而不是悄悄加一行路由。
	"POST /api/admin/categories",          // #9
	"DELETE /api/admin/categories/:id",    // #10
	"POST /api/admin/locations",           // #11
	"DELETE /api/admin/locations/:id",     // #12
	"GET /api/admin/users",                // #34
	"PUT /api/admin/users/:id/role",       // #35
	"PUT /api/admin/users/:id/status",     // #36
	"GET /api/admin/stats",                // #37
	"GET /api/debug/config",               // #39（ENV=dev 才注册；testConfig 用的是 test，所以在这里）
	"POST /api/admin/items/takedown",      // #43
	"POST /api/admin/items/:id/restore",   // #44
	"DELETE /api/admin/item-images/:id",   // #45
	"DELETE /api/admin/returns/:id",       // #46
	"POST /api/admin/users/:id/warn",      // #47
	"GET /api/admin/reports",              // #48
	"POST /api/admin/reports/:id/resolve", // #49
	"GET /api/admin/actions",              // #50
}

// testConfig 给 Setup 一份**能通过校验**的最小配置。
//
// 不能用 config.Config{} 零值：M1 起 Setup 内部会真的 new 一个 auth.TokenSigner，
// 而它拒绝空密钥和非正的有效期（这是启动期就该拦住的配置错误，见 jwt.go）。
// 这里的密钥只存在于测试进程内，不是任何环境的真密钥 —— 但刻意写满 32 字节以上，
// 免得将来有人复制这一行去当 .env 的模板。
//
// M2 起还需要 UploadDir：NewUpload 会 MkdirAll，留空的话它会落到「当前工作目录」
// （也就是 internal/router/），于是跑一次测试就在源码树里留下一个 uploads 目录。
// t.TempDir() 由测试框架自动清理，而且每个测试各自一份，互不干扰。
func testConfig(t *testing.T) config.Config {
	t.Helper()
	return config.Config{
		Env:           "test",
		JWTSecret:     "router-test-secret-0123456789abcdef0123456789abcdef",
		JWTExpire:     time.Hour,
		UploadDir:     t.TempDir(),
		UploadBaseURL: "/uploads",
	}
}

// planComplete 在 M6 收尾时改成 true，TestFinalRouteCount 就开始要求 50 条。
//
// 之前用 skip 而不是删掉这条测试，是为了让「最终必须 50 条」这个要求一直看得见，
// 而不是等到 M6 才想起来还要补一条测试。M6 走完了，所以现在它是真话：
// §4 那 50 条全部注册完，列表里少一条、多一条都会红。
const planComplete = true

func TestSetupRegistersExactlyTheExpectedRoutes(t *testing.T) {
	gin.SetMode(gin.TestMode)

	// pool 传 nil 是安全的：本测试只检查路由注册结果，从不真正调用 handler。
	// repo.NewUser(nil) 只是把 nil 存进结构体，不建连接；auth.NewLocalProvider
	// 也只在 Authenticate 时才碰库。这也是这条测试不需要数据库的原因 ——
	// 它属于 §10 的第①层（纯单元测试）。
	e, err := Setup(testConfig(t), nil)
	if err != nil {
		t.Fatalf("Setup 返回了 error：%v", err)
	}

	want := make(map[string]bool, len(expectedRoutes))
	for _, r := range expectedRoutes {
		if want[r] {
			t.Fatalf("expectedRoutes 里有重复项 %q，请删掉一个", r)
		}
		want[r] = true
	}

	got := make(map[string]int)
	for _, r := range e.Routes() {
		key := r.Method + " " + r.Path
		// gin 的 Static() 会**自动**给同一条路径再注册一个 HEAD
		// （HEAD 的语义就是「GET 但不要 body」，浏览器和图片预加载会用到）。
		// 那不是我们写的路由，所以不算进 §4 的 50 条 —— 但它必须有一条对应的 GET，
		// 否则就是「凭空多出一个 HEAD」，那才是要报出来的。
		if r.Method == http.MethodHead && want["GET "+r.Path] {
			continue
		}
		got[key]++
	}

	for key, n := range got {
		if n > 1 {
			t.Errorf("路由 %q 被注册了 %d 次", key, n)
		}
		if !want[key] {
			t.Errorf("出现了 expectedRoutes 里没有的路由 %q —— 如果是有意新增的，请把它加进上面的列表", key)
		}
	}
	for key := range want {
		if got[key] == 0 {
			t.Errorf("expectedRoutes 里的 %q 没有被注册", key)
		}
	}
}

// TestFinalRouteCount 是计划 §10 那条「断言条数 == 50」的落点。
func TestFinalRouteCount(t *testing.T) {
	if !planComplete {
		// 条数用 len() 而不是写死：这条信息每个里程碑都要变，写死的那一份迟早会过期，
		// 而过期的注释比没有注释更坏（M3 就因为 README 里一个过期数字被更正过一次）。
		t.Skipf("计划还没走完（当前 %d 条）；M6 收尾时把本文件的 planComplete 改成 true，这条测试就会开始要求 50 条",
			len(expectedRoutes))
	}
	if len(expectedRoutes) != 50 {
		t.Fatalf("§4 规定最终是 50 条路由，expectedRoutes 里现在有 %d 条", len(expectedRoutes))
	}
}

// TestNoPanicOnSetup 单独存在，因为 Gin 的路由树冲突是在 Setup 时 panic 的，
// 而 panic 会让上面那条测试的失败信息淹没在堆栈里，看不出真正原因。
func TestNoPanicOnSetup(t *testing.T) {
	gin.SetMode(gin.TestMode)
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Setup 时 panic 了，极可能是 Gin 路由树冲突（同一层混用静态段和 :id 参数段）：%v", r)
		}
	}()
	if _, err := Setup(testConfig(t), nil); err != nil {
		t.Fatalf("Setup 返回了 error：%v", err)
	}
}

// TestDebugConfigRouteAbsentInProd 锁住「ENV=prod 时 /api/debug/config 压根不存在」。
//
// 这条测试测的是**注册**，不是 handler 里那一道 ENV 判断：
// 生产环境里一个「返回 403 的调试端点」仍然在告诉探测者「这个路径是有的，只是你不该看」，
// 而少注册一条路由的响应是 404，和任何别的不存在的路径没有区别。
// 两道闸各管一种失误（路由表管「这行 if 被删了」，handler 管「路由被无条件注册了」），
// 见 handler/debug.go 顶部那段。
//
// ⚠ gin.SetMode 改的是**全局**状态（本包每条测试第一行都设 TestMode，所以约定状态就是它），
// 而 Setup 在 Env=prod 时会把它切成 ReleaseMode。这里 defer 还原，
// 免得本测试跑完后同包的其他测试跑在另一个模式里。
func TestDebugConfigRouteAbsentInProd(t *testing.T) {
	gin.SetMode(gin.TestMode)
	defer gin.SetMode(gin.TestMode)

	prod := testConfig(t)
	prod.Env = "prod"
	e, err := Setup(prod, nil)
	if err != nil {
		t.Fatalf("Setup 返回了 error：%v", err)
	}

	for _, r := range e.Routes() {
		if r.Method == http.MethodGet && r.Path == "/api/debug/config" {
			t.Fatal("ENV=prod 时 /api/debug/config 不该被注册（它会把运行时配置吐到 HTTP 响应里）")
		}
	}

	// 反向也要成立：dev/test 环境里它必须在，否则上面那个循环是在空转。
	// 少这一句的话，将来有人把注册那行整个删掉，这条测试反而变绿。
	dev, err := Setup(testConfig(t), nil)
	if err != nil {
		t.Fatalf("Setup(testConfig) 返回了 error：%v", err)
	}
	var found bool
	for _, r := range dev.Routes() {
		if r.Method == http.MethodGet && r.Path == "/api/debug/config" {
			found = true
		}
	}
	if !found {
		t.Error("ENV=test 时 /api/debug/config 应该注册，否则本测试测的是空气")
	}
}

// TestSetupRejectsBadJWTConfig 锁住「配置错了就在启动时失败」这个行为。
//
// 为什么值得单独测：Setup 现在会 new 一个真的 TokenSigner，于是它有了一条
// 新的失败路径。如果这条路径悄悄退化成「密钥太短也能启动」，
// 后果不是崩溃而是**任何人都能伪造 admin token** —— 而这类退化不会让
// 任何一条业务测试变红，因为业务测试用的都是合法密钥。
func TestSetupRejectsBadJWTConfig(t *testing.T) {
	gin.SetMode(gin.TestMode)

	cases := []struct {
		name string
		cfg  config.Config
	}{
		{"密钥为空（零值 Config）", config.Config{JWTExpire: time.Hour}},
		{"密钥太短", config.Config{JWTSecret: "abc123", JWTExpire: time.Hour}},
		{"有效期为 0", config.Config{JWTSecret: testConfig(t).JWTSecret}},
		{"有效期为负", config.Config{JWTSecret: testConfig(t).JWTSecret, JWTExpire: -time.Hour}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e, err := Setup(tc.cfg, nil)
			if err == nil {
				t.Fatalf("期望 Setup 报错，但它成功了（engine=%v）", e != nil)
			}
			if e != nil {
				t.Errorf("返回 error 时 engine 应该是 nil，实际不是")
			}
		})
	}
}
