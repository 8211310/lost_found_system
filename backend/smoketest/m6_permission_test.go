// 这一份文件是计划 §12 M6 那四条权限测试里**必须起真库**的两条，加上 #39 那道脱敏闸。
//
// 为什么这四条不能在第①层跑完（router/m6_routes_test.go 已经跑了两条）：
//   - 非 admin 拿到的是 403 还是 401，取决于库里那一行 users.role —— 匿名请求压根走不到
//     RequireAdmin（JWT 先把它挡成 401），所以「忘了挂中间件」这种失误在第①层是不可见的。
//   - admin 能不能点 #18/#25/#26 取决于 service 的授权分支，而那条分支要看真实的
//     items.user_id / item_returns 行。
//   - #39 的脱敏结果来自 config，而 config 来自环境 —— 只有真装配出来的那台 engine
//     才知道自己挂的是哪一份。
//
// ⚠ 四条测试共同依赖一个前提：**遍历 harness.Engine**，不是自己再 Setup 一次。
// 那份清单必须来自真正在服务请求的路由树（见 setup_test.go 里 Engine 那个字段）。
package smoketest

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"lostfound/internal/apperr"
	"lostfound/internal/model"
)

// adminProbe 是一条后台路由 + 用它拼出来的可请求路径。
type adminProbe struct {
	method string
	path   string // 原始形状，报错时用（/api/admin/users/:id/role）
	url    string // :id 换成 1 之后，真拿去请求的
}

// collectAdminRoutes 从**在服务请求的那棵树**里取出所有后台端点。
//
// 为什么按前缀筛而不是抄一份清单下来：抄清单的话，将来加一条 admin 路由而忘了
// 挂 RequireAdmin，测试那份清单不会跟着长，于是它绿着漏掉那条真正有洞的路由。
// 遍历 + 下面的数量下限，才是「新增即被覆盖」的写法。
//
// HEAD 被跳过：那是 gin 给每条 GET 自动配的兄弟节点，测一条 GET 就等于测了它。
func collectAdminRoutes(t *testing.T) []adminProbe {
	t.Helper()

	var out []adminProbe
	for _, r := range harness.Engine.Routes() {
		if r.Method == http.MethodHead {
			continue
		}
		if !(strings.HasPrefix(r.Path, "/api/admin/") || strings.HasPrefix(r.Path, "/api/debug/")) {
			continue
		}
		out = append(out, adminProbe{
			method: r.Method,
			path:   r.Path,
			url:    strings.ReplaceAll(r.Path, ":id", "1"),
		})
	}
	return out
}

// TestM6NonAdminBlockedFromEveryAdminRoute 是 §12 权限测试的第①条。
//
// 一个普通登录用户（**不是**匿名，他有合法 token）拿同一套凭证去遍历全部后台端点，
// 每一条都必须得到 FORBIDDEN。
//
// 为什么用「登录但不是 admin」而不是匿名：匿名在 JWT 那一层就 401 了，那是第①层
// TestEveryAdminRouteRejectsAnonymous 测的东西。这一条要测的是**第二道闸**——
// 一个已经通过身份验证的人，权限判断有没有把他挡住。两种失误的分界线就在这里：
// 只挂 jwt 不挂 RequireAdmin 的路由，对匿名回 401（看起来完全正常），
// 对普通用户回 200 或 400 —— 只有拿着真 token 才照得出来。
//
// 请求体和 query 一律留空：测的是能不能进门，不是进门之后做什么。
// 任何一条路由如果在鉴权之前就读 body 或查库，它给出的就不会是 403
// （读 body 失败 → VALIDATION，拿 id=1 查库 → NOT_FOUND），那正是这条测试要红的两种形状。
func TestM6NonAdminBlockedFromEveryAdminRoute(t *testing.T) {
	harness.TruncateAll(t)

	normal := harness.RegisterAndLogin(t, "m6norman", m5Password)
	admin := harness.MakeAdmin(t, harness.RegisterAndLogin(t, "m6admin", m5Password))

	probes := collectAdminRoutes(t)

	// 数量下限，理由和 tier① 那条一模一样：筛错前缀 = 一条都没测 = 安静地通过。
	// 16 条 /api/admin/* + #39 /api/debug/config。
	if len(probes) < 17 {
		t.Fatalf("只遍历到 %d 条后台路由，少于预期的 17 条 —— 要么路由前缀和这条测试的假设不一致，"+
			"要么有后台端点被挪出了 /api/admin/。这两种情况下这条测试都在空转：%v",
			len(probes), probes)
	}

	for _, p := range probes {
		resp := harness.Do(t, p.method, p.url, nil, normal.Token)
		RequireCode(t, resp, apperr.CodeForbidden)
		if resp.HTTPStatus != http.StatusForbidden {
			t.Errorf("%s %s 用普通用户 token 打，HTTP 状态应该是 403，实际 %d",
				p.method, p.path, resp.HTTPStatus)
		}
	}

	// 反向对照：同一批路由里所有 GET，换成 admin token 必须全部 OK。
	//
	// 少了这一段，「RequireAdmin 写反了，谁都进不来」会让上面那半个循环全绿。
	// 一条只有负向断言的权限测试是不完整的：它证明了门关上，没证明门会为一个合法的人打开。
	// 四条 admin GET（#34 #37 #48 #50）+ #39，正好是后台的全部只读入口。
	var reads, readOK int
	for _, p := range probes {
		if p.method != http.MethodGet {
			continue
		}
		reads++
		if harness.Get(t, p.url, admin.Token).Code == apperr.CodeOK {
			readOK++
		}
	}
	if reads < 4 {
		t.Fatalf("后台只读端点只遍历到 %d 条，预期至少 4 条（#34 #37 #48 #50）", reads)
	}
	if readOK != reads {
		t.Errorf("admin 用合法 token 打后台读端点，%d 条里有 %d 条没拿到 OK —— 反向对照失败",
			reads, readOK)
	}
}

// TestM6AdminRoleIsCheckedPerRequest 断言「降权立刻生效」。
//
// 它是 M1 那个设计决定（role / status **不进** JWT claims）在后台这一侧的验收点：
// role 进了 token，那么把一个管理员降回普通用户之后，他手上那张旧 token 还能继续
// 当满一个有效期（24 小时）的 admin —— 而「把他从管理员里去掉」这件事的全部意义
// 就是立刻去掉。
//
// 这条测试只有集成层能跑，而且刻意**只用一个 token 字符串**：
// 提权后用 MakeAdmin 新铸的那张打一次（必须 OK），然后只改库、不重新登录、不重新铸 token，
// 拿**同一张**再打一次（必须 FORBIDDEN）。
// 如果实现把 role 塞进了 claims，第二次调用会照样 OK —— 那是这条测试唯一的靶心。
func TestM6AdminRoleIsCheckedPerRequest(t *testing.T) {
	harness.TruncateAll(t)

	promoted := harness.MakeAdmin(t, harness.RegisterAndLogin(t, "m6promote", m5Password))
	RequireOK(t, harness.Get(t, "/api/admin/stats", promoted.Token), "刚提权时该能看统计")

	if _, err := harness.Pool.Exec(context.Background(),
		`UPDATE users SET role = 'user', updated_at = now() WHERE id = $1`, promoted.UserID); err != nil {
		t.Fatalf("降权失败: %v", err)
	}

	// 同一个 token、同一个端点、只改了库里那一列。
	blocked := harness.Get(t, "/api/admin/stats", promoted.Token)
	RequireCode(t, blocked, apperr.CodeForbidden)

	// 顺手确认这条断言不是「token 整个过期了」造成的假阳性：
	// 同一个 token 打普通用户接口必须还是 OK —— 降掉的是 role，不是身份。
	RequireOK(t, harness.Get(t, "/api/my/credit-logs", promoted.Token), "降权之后本人接口仍该可用")
}

// TestM6AdminBlockedFromOwnerOnlyRoutes 是 §12 权限测试的第②条。
//
// 全系统只有三个动作是「仅发帖人本人」：#18 把帖子改成 closed（= 宣布东西已归还）、
// #25 confirm、#26 reject。admin 在这三条上全部得 FORBIDDEN —— 这是定位原则 5
// 「admin 能销毁内容和账号，但不能制造归属」唯一一处的正面测法。
//
// ⚠ 和 #46 的分工别搞混：DELETE /api/admin/returns/:id（销毁一条刷出来的违规归还记录）
// 对 admin 是**合法**的，它删一行记录、不产生任何「有人同意了」的含义。
// 所以这一条测的只有 confirm / reject / 改状态三个动词，不是 returns 整个资源。
//
// body 全部按各端点最合理的形状给（#18 给 closed，两个决定给一句人话的 owner_note）。
// 这一步不能省：给空 body 的话，实现只要「先校验字段、后判权限」就能把 FORBIDDEN
// 换成 VALIDATION 而测试照样红不了 —— 但 m5 的 TestM5DecisionOrderPermissionBeforeField
// 恰好规定了那两条路由是**权限先于字段**，所以这里给合法 body 也让两条测试口径一致。
//
// 和 m5_return_confirm_test.go:319 TestM5AdminCannotDecide 的关系：那条测的是状态机
// （admin 点了之后 pending 有没有被推进），这一条测的是权限维度并且把 #18 一起扫进来。
// 两条在 #25/#26 上有意重叠 —— 一个断言落点在链、一个在角色，改坏任一侧都必须有测试红。
func TestM6AdminBlockedFromOwnerOnlyRoutes(t *testing.T) {
	st := setupM5(t)
	submitted := requireSubmitted(t, st.found.ID, st.li)
	admin := harness.MakeAdmin(t, st.stranger)

	// 基线要先抄下来再打那三次。
	//
	// 不能直接断言「发帖人的收件箱是空的」：夹具里 requireSubmitted 那一步本身就会给
	// 发帖人留一条 return_submitted，那是产品正确行为。拿空收件箱去断言，第一次跑就红，
	// 而红的原因和权限毫无关系。要测的是**增量**：三次被拒的请求之后，
	// 通知还必须是那一条，一条都没多。
	inboxBefore := notificationsOf(t, st.finder.UserID)
	creditBefore := harness.Count(t, `SELECT count(*) FROM credit_logs`)

	ownerOnly := []struct {
		name   string
		method string
		url    string
		body   any
	}{
		{"#18 替发帖人把帖子改成 closed", http.MethodPatch,
			"/api/items/" + itoa(st.found.ID) + "/status", map[string]any{"status": "closed"}},
		{"#25 代为确认归还", http.MethodPost,
			"/api/returns/" + itoa(submitted.ID) + "/confirm",
			map[string]any{"owner_note": "管理员代帖主确认"}},
		{"#26 代为拒绝归还", http.MethodPost,
			"/api/returns/" + itoa(submitted.ID) + "/reject",
			map[string]any{"owner_note": "管理员代帖主拒绝"}},
	}

	for _, c := range ownerOnly {
		t.Run(c.name, func(t *testing.T) {
			r := harness.Do(t, c.method, c.url, c.body, admin.Token)
			RequireCode(t, r, apperr.CodeForbidden)
		})
	}

	// 三次尝试必须一个字节都没留下 —— FORBIDDEN 不是「先做完再报错」。
	if got := itemStatusOf(t, st.found.ID); got != model.ItemStatusOpen {
		t.Errorf("admin 的三次尝试之后帖子变成 %q 了", got)
	}
	row := returnRow(t, submitted.ID)
	if row["status"] != "pending" {
		t.Errorf("那条归还确认变成 %v 了，admin 点不动它才对", row["status"])
	}
	if row["reviewer_id"] != nil || row["review_kind"] != nil {
		t.Errorf("审核痕迹被写进去了：reviewer_id=%v review_kind=%v",
			row["reviewer_id"], row["review_kind"])
	}
	if got := len(notificationsOf(t, st.finder.UserID)); got != len(inboxBefore) {
		t.Errorf("admin 那三次被拒的请求给发帖人多发了 %d 条通知（打之前 %d 条，现在 %d 条）",
			got-len(inboxBefore), len(inboxBefore), got)
	}
	if got := harness.Count(t, `SELECT count(*) FROM credit_logs`); got != creditBefore {
		t.Errorf("admin 那三次被拒的请求动了积分流水：从 %d 行变成 %d 行", creditBefore, got)
	}
	if got := harness.Count(t, `SELECT count(*) FROM admin_actions`); got != 0 {
		t.Errorf("被拒的 admin 请求写了 %d 行治理留痕，期望 0 行 —— 没生效的动作不该记台账", got)
	}

	// 反向对照：同一张舞台上，发帖人自己点这两个动作必须成功。
	// 没有这一段，上面那一串「什么都没变」可能只是「这三条路由对谁都失败」的另一种写法。
	t.Run("对照：拾主自己 confirm 同一条", func(t *testing.T) {
		RequireOK(t, confirmReturn(t, submitted.ID, "对上了，谢谢您", st.finder.Token), "发帖人确认归还")
		if row := returnRow(t, submitted.ID); row["status"] != "confirmed" {
			t.Errorf("发帖人自己点之后 status=%v", row["status"])
		}
	})
	t.Run("对照：失主自己关自己那条 lost 帖", func(t *testing.T) {
		r := harness.Do(t, http.MethodPatch,
			"/api/items/"+itoa(st.lost.ID)+"/status", map[string]any{"status": "closed"}, st.li.Token)
		RequireOK(t, r, "发帖人关闭自己的帖子")
	})
}

// TestM6DebugConfigIsAdminOnlyAndMasked 守住 /api/debug/config 的两件事：
// 它对非 admin 关着，而且它对 admin 也只吐脱敏后的配置。
//
// 这个端点是全系统唯一把运行时配置整体吐进 HTTP 响应体的地方，
// 所以它的失败模式不是「功能不对」，而是「把 JWT 密钥发给一个普通用户」。
//
// ⚠ 生产环境里这条路由压根没注册（router.go 那个 if !cfg.IsProd()），那是第二道闸，
// 由路由注册测试覆盖。这里测的是注册分支之外的那一半：脱敏本身。
// 测试环境的 Env 是 "test"，所以这条路由在这里确实存在 —— 也就正好可测。
func TestM6DebugConfigIsAdminOnlyAndMasked(t *testing.T) {
	harness.TruncateAll(t)

	normal := harness.RegisterAndLogin(t, "m6curious", m5Password)
	admin := harness.MakeAdmin(t, harness.RegisterAndLogin(t, "m6ops", m5Password))

	RequireCode(t, harness.Get(t, "/api/debug/config", normal.Token), apperr.CodeForbidden)
	// 匿名同理是 401，不是 403（§8 的口径）：这条路由挂的是 jwt → RequireAdmin 两道。
	RequireCode(t, harness.Get(t, "/api/debug/config", ""), apperr.CodeUnauthorized)

	r := harness.Get(t, "/api/debug/config", admin.Token)
	RequireOK(t, r, "admin 读脱敏配置")

	var data map[string]any
	r.DataInto(t, &data)

	// 逐个键检查：**按名字判断像不像密钥**，而不是只查一份写死的清单。
	// 写死清单的问题是将来在 Redacted() 里新加一个字段、忘了套 mask 时，
	// 那条清单不会跟着长（它只认得那四个键），于是测试绿着把新密钥漏出去。
	for k, v := range data {
		if !looksLikeSecret(k) {
			continue
		}
		s, ok := v.(string)
		if !ok {
			t.Errorf("敏感字段 %s 的值类型不是字符串（%T）—— 脱敏函数只可能返回字符串", k, v)
			continue
		}
		if s != "***" && s != "(未配置)" {
			t.Errorf("敏感字段 %s 没有被打码，实际值是 %q", k, s)
		}
	}

	// 那四个键必须**都在**（名字对上，而不是「长得像密钥的键碰巧都在」）。
	// 少了这一段，将来有人把 jwt_secret 改名成 jwt_token 时，上面那个循环照样通过，
	// 而 §9 承诺的「哪个字段是密钥」的口径就悄悄变了。
	for _, k := range []string{"db_password", "jwt_secret", "hduhelp_app_secret", "sso_state_key"} {
		if _, ok := data[k]; !ok {
			t.Errorf("脱敏清单里少了 %s", k)
		}
	}

	// 测试 cfg 里 JWTSecret **是有值的**，所以 jwt_secret 必须是 "***" 而不是 "(未配置)"。
	// 这一条是整个测试里最有牙的一条：它证明 mask 走的是「有值→打码」那一支。
	// 反过来说，db_password / app_secret / sso_state_key 在 smoketest 的 cfg 里是空的，
	// 它们的正确值是 "(未配置)" —— 断言写成 "***" 会红，那是夹具的问题不是产品的问题。
	if data["jwt_secret"] != "***" {
		t.Errorf("jwt_secret=%v，测试配置里那个字段是有值的，应该被遮成 ***", data["jwt_secret"])
	}
	for _, k := range []string{"db_password", "hduhelp_app_secret", "sso_state_key"} {
		if data[k] == "***" {
			t.Errorf("%s=*** 但 smoketest 的 cfg 并没有配这一项，应该是 (未配置)", k)
		}
	}

	// 兜底：整个响应体里搜一次真密钥。上面那几条查的是「字段有没有被正确打码」，
	// 这一条查的是「有没有别的地方把它带出来」（例如有人在 detail 里拼了一句
	// 「当前密钥是 xxx，请确认」，或者 upload_dir 指向的路径名里含密钥）。
	// 这是唯一一条不看键名、因此不看命名的断言 —— 它和命名循环是两种失误的互补覆盖。
	if harness.Cfg.JWTSecret == "" {
		t.Fatal("夹具的 JWTSecret 是空的，这条兜底断言正在空转（setup_test.go 的 cfg 改了？）")
	}
	if strings.Contains(string(r.Data), harness.Cfg.JWTSecret) {
		t.Errorf("响应体里出现了未打码的 JWT 密钥本体")
	}

	// 最后确认它**还能干活**：§9 造这个端点的理由是「调参前先问一句现在生效的是多少」，
	// 阈值全是 *** 的话它就是个废接口。所以这两个数字必须是 cfg 里那两个真值。
	if data["match_notify_threshold"] != 0.75 || data["match_show_threshold"] != 0.55 {
		t.Errorf("阈值没有原样吐出来：%v / %v（期望 0.75 / 0.55）",
			data["match_notify_threshold"], data["match_show_threshold"])
	}
	// 另外两个也必须原样吐出来。上面那条只点了两个阈值，而 MatchConfig 有四个字段 ——
	// 「阈值都对了」给人「匹配参数验全了」的错觉，时间容差就是这么漏掉的。
	// 和第③层那条数 `"match_` 次数的冒烟是同一件事的两层：这里锁「Redacted 和 MatchConfig 脱节」，
	// 冒烟锁「正在跑的那个进程真的读了 backend/.env」。
	// 类型分支不是多余：值如果被塞进 mask()，响应里会是 "***"，
	// 而 `float64 != "***"` 这种比较在 any 上是恒假、不会报错的 —— 所以先 switch 出类型。
	for _, tc := range []struct {
		key  string
		want float64
	}{
		{"match_time_tolerance_hours", float64(harness.Cfg.Match.TimeToleranceHours)},
		{"match_decay_days", float64(harness.Cfg.Match.DecayDays)},
	} {
		switch v := data[tc.key].(type) {
		case nil:
			t.Errorf("匹配参数里少了 %s —— config.Redacted 漏了 MatchConfig 的字段", tc.key)
		case float64:
			if v != tc.want {
				t.Errorf("%s=%v，期望夹具 cfg 里的真值 %v", tc.key, v, tc.want)
			}
		default:
			t.Errorf("%s 的值类型是 %T，期望数字 —— 匹配参数不是密钥，它不该被 mask 掉", tc.key, v)
		}
	}
	if data["env"] != "test" {
		t.Errorf("env=%v，期望 test（这个键没脱敏，也正是排查时第一眼要看的那一列）", data["env"])
	}
}

// looksLikeSecret 按键名猜「这一项该不该被打码」。
//
// 猜而不写死是故意的：它宁可误报（多要求一个字段被打码），也不能漏报。
// 误报的表现是「db_name 怎么没打码」这种一眼能看出该改哪里的失败。
func looksLikeSecret(key string) bool {
	for _, part := range []string{"secret", "password", "token", "key", "credential"} {
		if strings.Contains(strings.ToLower(key), part) {
			return true
		}
	}
	return false
}
