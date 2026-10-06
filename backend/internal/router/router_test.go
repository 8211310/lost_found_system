package router

import (
	"testing"

	"github.com/gin-gonic/gin"

	"lostfound/internal/config"
)

// expectedRoutes 是「当前里程碑应有的全部路由」。
//
// 为什么断言确切集合而不是只断言数量：数量对不上时你还得自己去找是哪条多了或少了；
// 集合对不上时测试直接告诉你是哪条。加了路由却忘了更新这个列表也会红 —— 这正是我们想要的摩擦。
//
// 到 M6 收尾时这个列表必须恰好有 50 条（§4：49 个 JSON API + 1 个 /uploads 静态路由）。
var expectedRoutes = []string{
	"GET /api/health", // #38
}

// planComplete 在 M6 收尾时改成 true，TestFinalRouteCount 就开始要求 50 条。
//
// 现在用 skip 而不是删掉这条测试，是为了让「最终必须 50 条」这个要求一直看得见，
// 而不是等到 M6 才想起来还要补一条测试。
const planComplete = false

func TestSetupRegistersExactlyTheExpectedRoutes(t *testing.T) {
	gin.SetMode(gin.TestMode)

	// pool 传 nil 是安全的：本测试只检查路由注册结果，从不真正调用 handler。
	// 这也是这条测试不需要数据库的原因 —— 它属于 §10 的第①层（纯单元测试）。
	e := Setup(config.Config{}, nil)

	want := make(map[string]bool, len(expectedRoutes))
	for _, r := range expectedRoutes {
		if want[r] {
			t.Fatalf("expectedRoutes 里有重复项 %q，请删掉一个", r)
		}
		want[r] = true
	}

	got := make(map[string]int)
	for _, r := range e.Routes() {
		got[r.Method+" "+r.Path]++
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
		t.Skip("M0 只有 1 条路由；M6 收尾时把本文件的 planComplete 改成 true，这条测试就会开始要求 50 条")
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
	Setup(config.Config{}, nil)
}
