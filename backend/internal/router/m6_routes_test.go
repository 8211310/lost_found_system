package router

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"lostfound/internal/apperr"
)

// 这一份文件是 §12 M6 那四条权限测试里**不需要数据库**的两条。
//
// 为什么这两条能在第①层跑，而另外两条（非 admin 拿真 token 遍历、admin 拿真 token
// 去点 #25/#26/#18）必须等第②层：这两条问的是「路由表长什么样」和
// 「不带身份时进得来吗」，两个答案都由 Setup 的注册结果决定，一次 SQL 都不发
// （pool 传 nil 是安全的，见 TestSetupRegistersExactlyTheExpectedRoutes 那段）。
//
// 反过来说，这两条测不到的部分要诚实承认：它们**测不出「某条 admin 路由忘了挂
// RequireAdmin」**——因为匿名请求先被 JWT 挡成 401，压根走不到后面那道中间件。
// 那一条由下面第二条测试的「组级挂载」这个结构来保证（16 条全在 /api/admin 组上，
// 少挂就得逐条写，而逐条写才是会漏的写法），真跑起来要靠第②层的
// TestNonAdminBlockedFromAdminRoutes。

// TestNoAdminCommunityRoutesExist 断言后台里**不存在**任何「以 admin 身份推进社区流程」的路由。
//
// 这是定位原则 5 的正面表述：admin 能销毁内容和账号，但不能制造归属。
// 具体禁的是三个动作 —— 代为确认归还、代为拒绝归还、替发帖人关帖、干预匹配结果。
// 它们一旦存在，平台就是在替某一方表态（「admin 认为这东西还回去了」），
// 而那件事只有当事双方能表态。
//
// ⚠ 三条正则都**精确到动词**，这不是一句省事的话，而是这条测试会不会误伤的分界线：
//   - `admin.*returns.*(confirm|reject)` —— 只禁那两个动词。
//     `DELETE /api/admin/returns/:id`（#46，销毁一条刷出来的违规归还记录）是**合法**的：
//     它删掉一行记录，不产生任何「有人同意了」的含义。
//     一刀切成 `admin.*returns` 会把 #46 判成违规，而那个误报的修法几乎必然是
//     「顺手把正则改松」，于是这条测试从此再也拦不住真的那两条。
//   - `admin.*items.*close` —— 关帖（status→closed）是「东西已归还」的表态，
//     只有发帖人有资格做（#18）。admin 让帖子消失用的是 #43 下架，那是两件事。
//   - `admin.*match` —— 后台不允许有任何匹配入口。
//     它同时禁掉了「admin 看别人的匹配结果」那种看似无害的读端点：
//     #20 的鉴权列写的是「本人或 Admin」，但那是在 /api/items/:id/matches 上，
//     而不是在 /api/admin/... 下面 —— 前者有 service 层的「本人或 admin」判断，
//     后者会变成「任何 admin 都能替任何人重算一次匹配」的入口。
func TestNoAdminCommunityRoutesExist(t *testing.T) {
	gin.SetMode(gin.TestMode)

	e, err := Setup(testConfig(t), nil)
	if err != nil {
		t.Fatalf("Setup 返回了 error：%v", err)
	}

	forbidden := []*regexp.Regexp{
		regexp.MustCompile(`admin.*returns.*(confirm|reject)`),
		regexp.MustCompile(`admin.*items.*close`),
		regexp.MustCompile(`admin.*match`),
	}

	for _, r := range e.Routes() {
		key := r.Method + " " + r.Path
		for _, re := range forbidden {
			if re.MatchString(key) {
				t.Errorf("路由 %q 命中了禁用模式 %s —— admin 不该有任何「推进社区流程」的入口（定位原则 5）",
					key, re)
			}
		}
	}

	// 反向对照：#46 那条合法的 DELETE 必须还在。
	// 少了这一段，将来有人把第一条正则改成 `admin.*returns` 时这条测试不会红，
	// 而 #46 会在某个时刻被当成违规路由「修掉」——那是功能缺失，测试却一片绿。
	if !hasRoute(e, http.MethodDelete, "/api/admin/returns/:id") {
		t.Error("#46 DELETE /api/admin/returns/:id 不见了：销毁违规归还记录是 admin 的合法权力，别把它当成社区动作删掉")
	}
}

func hasRoute(e *gin.Engine, method, path string) bool {
	for _, r := range e.Routes() {
		if r.Method == method && r.Path == path {
			return true
		}
	}
	return false
}

// TestEveryAdminRouteRejectsAnonymous 遍历路由表里所有后台端点，
// 一条都不带 token 地打一遍，断言每一条都回 401。
//
// 「遍历」而不是「挑三条测」是这条测试的全部价值：它不需要知道新增了哪些端点，
// 将来谁加一条 admin 路由而忘了挂中间件（也就是把它注册到 api 而不是 admin 组上），
// 那条路由的响应会变成 404/400/200 而不是 401，测试当场红。
//
// 为什么断言 401 而不是 403：没有 token 是「没登录」，§8 把这个口径钉死成 401，
// 前端只有一套「跳登录页」的分支要处理。「非 admin 登录用户拿到 403」是另一条测试
// （第②层的 TestNonAdminBlockedFromAdminRoutes），它需要真 token 所以需要真库。
//
// ⚠ 这里刻意把请求体和 query 都留空：测的是**能不能进门**，不是进门之后做什么。
// 任何一条 admin 路由如果在鉴权之前就去读 body 或查库，那条读库会拿着 nil pool 炸出
// 一个 panic（Recovery 兜成 500），而 500 ≠ 401，这条测试同样会红 —— 那正是我们想要的：
// 鉴权必须发生在任何业务代码之前。
func TestEveryAdminRouteRejectsAnonymous(t *testing.T) {
	gin.SetMode(gin.TestMode)

	e, err := Setup(testConfig(t), nil)
	if err != nil {
		t.Fatalf("Setup 返回了 error：%v", err)
	}

	probed := 0
	for _, r := range e.Routes() {
		// /uploads 下那条静态路由不属于后台，而 HEAD 是 gin 给 GET 自动加的兄弟节点。
		if !(strings.HasPrefix(r.Path, "/api/admin/") || strings.HasPrefix(r.Path, "/api/debug/")) ||
			r.Method == http.MethodHead {
			continue
		}
		probed++

		w := httptest.NewRecorder()
		req := httptest.NewRequest(r.Method, "https://example.com"+strings.ReplaceAll(r.Path, ":id", "1"), nil)
		e.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("%s %s 匿名访问应该 401，实际 %d，body=%s",
				r.Method, r.Path, w.Code, w.Body.String())
			continue
		}
		// 信封也要查：401 的响应体必须是那个统一形状（§8），
		// 否则前端按 code 分支的「跳登录页」逻辑就收不到信号，只能靠 HTTP 状态码猜。
		var env apperr.Envelope
		if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
			t.Errorf("%s %s 的 401 响应体不是合法信封：%v（body=%s）", r.Method, r.Path, err, w.Body.String())
			continue
		}
		if env.Code != apperr.CodeUnauthorized {
			t.Errorf("%s %s 的 401 里 code 应该是 UNAUTHORIZED，实际 %q", r.Method, r.Path, env.Code)
		}
	}

	// 这条断言守的是测试本身：如果哪天有人把 16 条 admin 路由改成了别的命名前缀，
	// 上面那个循环会一条都不测，然后安静地通过。
	if probed < 17 {
		t.Fatalf("只遍历到 %d 条后台路由（16 条 /api/admin/* + #39 /api/debug/config），"+
			"说明路由前缀和这条测试的假设不一致，这条测试正在空转", probed)
	}
}
