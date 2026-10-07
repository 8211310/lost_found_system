// 这一份补的是 M6 里**只有真库能证**的那一半：#16/#17/#44/#45/#46 这五条
// 「一条一条动」的治理路径。
//
// 第①层（service/m6_item_logging_test.go、m6_logging_test.go）已经拿 fake 证过
// 「service 调了 TakedownByAdmin、Record 收到了正确的 map」，但 fake 答不出这四个问题：
//
//   - **admin 改帖到底有没有跑匹配**？fake 里的 Match 是个计数器，
//     计数为 0 可能是不该跑，也可能是那条夹具压根匹配不上。
//     这里用「同一条帖子、同一个请求体，帖主自己改一次就会 +1 行台账」当反向对照，
//     把「匹配是好的、只是 admin 这一支刻意不跑」钉成一条能读的证明。
//   - **单条下架留下的那一行台账，形状和 #43 批量的是不是同一个**？
//     §13 第 10 步那条自检 SQL 只查 `detail->'ids'`，如果单条那种写成
//     `detail->'item_id'`，自检就会漏掉所有「管理员在帖子页里删掉的那几条」——
//     而漏掉的后果是「deleted 的行追不到是谁删的」，正是风险 14 要防的事。
//   - **图片那一行删了之后，磁盘上的文件到底还在不在**？
//     fake 连 os.Remove 都摸不到。这里用 #40 那条真实的路由去 GET 两个 URL，
//     一个 404、一个 200，这才叫「只删了这一张」。
//   - **恢复回来的帖子能不能再被广场读到**？那是列表 SQL + 状态列两件事的合取。
//
// 还有判据 ④ 在单条路径上的落点：**参数不合法时被拒的那一次一个字节都没写进库**。
// 每条负例后面都跟着「台账 0 行、通知 0 条、状态没变」三连，缺一样这条判据就立不住。
package smoketest

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"lostfound/internal/apperr"
	"lostfound/internal/model"
)

// 这一组理由各自只在本文件里出现一次，但都写成常量：
// 断言要拿它和**库里的原文**比，写成字面量散在十几处反而更容易改错一处。
const (
	adminEditReason   = "标题里带了外链广告，按平台规则清理"
	adminEditTooLong  = "这一串只是用来撞长度上限的占位文本，不该出现在任何数据里"
	singleTakedown    = "同一条拾物信息重复发布了四次"
	singleRestore     = "核实过了，这条不是重复发布，恢复展示"
	imageTakedown     = "图片里拍到了别人的手机号，涉及隐私"
	returnTakedownRsn = "对同一条帖子提交的虚假归还确认"
)

// ---------- #16 admin 改他人帖 ----------

// TestM6AdminEditIsLoggedAndDoesNotRematch 是计划 §12 那条
// 「**#16 admin 改帖不重跑匹配**」在第②层的唯一证明。
//
// 为什么这条规则值得单独立一个测试：管理员补一个错别字，如果触发了一轮新匹配，
// 一批失主就会收到「有人捡到了你的东西」——而那条帖子的主人**并没有重新表态**。
// 那等于平台替发帖人许诺了一次归属，违反定位原则 1。
//
// 测试的骨架故意和 M3 的 TestEditFoundPostRematchesAndDedups 一样：
// 同一条 0.70 分的弱文本拾物帖、同一个改成 0.88 分的请求体。唯一的变量是**操作者是谁**。
// ① 管理员改 → 台账 0 行、通知 0 条；② 帖主自己改同样的内容 → 台账 1 行、失主 +1 条通知。
// 两个 ① 和 ② 放在一起，那个 0 才只有一种解释。
func TestM6AdminEditIsLoggedAndDoesNotRematch(t *testing.T) {
	harness.TruncateAll(t)

	li := harness.RegisterAndLogin(t, "m6path-li", m5Password)
	xw := harness.RegisterAndLogin(t, "m6path-wang", m5Password)
	admin := harness.MakeAdmin(t, harness.RegisterAndLogin(t, "m6path-admin", m5Password))

	lost := createItem(t, li, lostWalletBody(walletTitleLost, walletDesc, locLibrary, detailLibrary))
	// 「钱包」+ 空描述 = 0.45 + 0.40×0.25 + 0.15 = 0.70：在展示区、在通知线以下，
	// 所以此刻台账里应当一行都没有（M3 的 ① 是同一个数）。
	sloppy := createItem(t, xw, foundWalletBody("钱包", "", locLibrary, detailLibrary))

	ledger := func() int {
		return harness.Count(t, `SELECT count(*) FROM match_pairs WHERE lost_item_id = $1`, lost.ID)
	}
	// 夹具自证：如果这一步就不为 0，下面那个「admin 改完仍是 0」是废话。
	if n := ledger(); n != 0 {
		t.Fatalf("夹具期望这条 0.70 分的拾物帖不写台账，实际 %d 行 —— 判据「admin 改帖不重跑匹配」需要一个先存在的 0", n)
	}
	if n := harness.Count(t, `SELECT count(*) FROM notifications`); n != 0 {
		t.Fatalf("夹具期望全库 0 条通知，实际 %d 条", n)
	}

	// ① admin 把它改准（0.88 分，够通知线了 —— 但这一次没人该被打扰）。
	strong := foundWalletBody(walletTitleFound, walletDesc, locLibrary, detailLibrary)
	strong["admin_reason"] = adminEditReason
	r := harness.Do(t, http.MethodPut, "/api/items/"+itoa(sloppy.ID), strong, admin.Token)
	RequireOK(t, r, "admin 改他人帖")

	var got itemView
	r.DataInto(t, &got)
	if got.Title != walletTitleFound {
		t.Errorf("admin 的修改没生效，title=%q", got.Title)
	}
	if got.Author.ID != xw.UserID {
		t.Errorf("admin 改帖改变了归属（author=%d，原本是 %d）—— 归属不可转让是定位原则 5",
			got.Author.ID, xw.UserID)
	}

	if n := harness.Count(t, `SELECT count(*) FROM match_pairs`); n != 0 {
		t.Errorf("admin 改帖之后全库台账有 %d 行，期望 0 行 —— 平台不该因为管理员改了个标题就通知失主「找到了」", n)
	}
	if n := harness.Count(t, `SELECT count(*) FROM notifications`); n != 0 {
		t.Errorf("admin 改帖发出了 %d 条通知，期望 0 条", n)
	}

	// 留痕那一行：这是 #16 的 admin 分支唯一存在的理由（否则它和帖主自改就没区别了）。
	logs := adminActionsOf(t, admin.UserID)
	if len(logs) != 1 {
		t.Fatalf("admin 改他人帖的留痕期望恰好 1 行，实际 %d 行：%+v", len(logs), logs)
	}
	if logs[0].Action != model.ActionItemEdit || logs[0].TargetType != model.TargetItem {
		t.Errorf("留痕是 %s/%s，期望 %s/%s",
			logs[0].Action, logs[0].TargetType, model.ActionItemEdit, model.TargetItem)
	}
	if logs[0].TargetID != sloppy.ID {
		t.Errorf("留痕指向的帖子是 %d，期望 %d", logs[0].TargetID, sloppy.ID)
	}
	if logs[0].Reason != adminEditReason {
		t.Errorf("reason=%q，台账里必须是原文", logs[0].Reason)
	}
	// ⚠ detail.owner_id 来自 UPDATE ... RETURNING，不是来自请求体。
	// 「谁的东西被动了」是这本账要能回答的问题，而请求体里没有这一格。
	var editDetail struct {
		OwnerID int64 `json:"owner_id"`
	}
	decodeInto(t, json.RawMessage(logs[0].Detail), &editDetail)
	if editDetail.OwnerID != xw.UserID {
		t.Errorf("detail.owner_id=%d，期望 %d（帖主的 id 必须由库里认定，不能由调用方声明）",
			editDetail.OwnerID, xw.UserID)
	}

	// ② 反向对照：**同一个改动由帖主自己做** → 台账必须 +1、失主必须收到 1 条。
	//    没有这一步，① 里那两个 0 有可能只是「这条夹具匹配不起来」的假绿。
	ownerEdit := foundWalletBody(walletTitleFound, walletDesc, locLibrary, "一楼大厅服务台")
	RequireOK(t, harness.Do(t, http.MethodPut, "/api/items/"+itoa(sloppy.ID), ownerEdit, xw.Token),
		"帖主自己改同一条拾物帖")
	if n := ledger(); n != 1 {
		t.Errorf("帖主自己改帖后端台账 %d 行，期望 1 行（M3 的规则）—— "+
			"这条不绿的话，① 里那个 0 就说不清是「admin 不跑匹配」还是「匹配本身坏了」", n)
	}
	if n := notificationsFor(t, li.UserID); n != 1 {
		t.Errorf("失主收到 %d 条通知，期望 1 条 new_match", n)
	}

	// ③ 帖主自改**不写治理留痕**：那一本账记的是「谁动了别人的数据」。
	if got := harness.Count(t, `SELECT count(*) FROM admin_actions`); got != 1 {
		t.Errorf("帖主自改之后 admin_actions 变成 %d 行，期望还是 1 行（只有 ① 那一次）", got)
	}

	// ④ 理由超长 → VALIDATION，而且**字段没被改**。
	//    这一条盯的是 updateByAdmin 里那句「长度在开事务之前查」：
	//    放在事务里查会得到一次回滚，而回滚是可能失败的步骤。
	huge := foundBody("这条标题不该被写进库", "13800000000")
	huge["admin_reason"] = adminEditTooLong + strings.Repeat("长", m6ReasonMaxChars)
	rej := harness.Do(t, http.MethodPut, "/api/items/"+itoa(sloppy.ID), huge, admin.Token)
	RequireCode(t, rej, apperr.CodeValidation)
	// 契约上该报 admin_reason：#16/#17 的请求体里那一格就叫这个名字
	// （只有 #43–#47 那批后台端点的字段名才是 reason）。
	// 后台表单靠 field_errors 里的 field 点亮红框，报成 reason 等于哪一格都不红。
	requireField(t, rej, "admin_reason")

	if st := fetchDetail(t, sloppy.ID, xw.Token); st.Title != walletTitleFound {
		t.Errorf("被拒的超长理由那次请求把标题改掉了：%q", st.Title)
	}
	if got := harness.Count(t, `SELECT count(*) FROM admin_actions`); got != 1 {
		t.Errorf("被拒的请求多写了留痕：%d 行，期望还是 1 行", got)
	}
}

// ---------- #17 admin 删帖 + #44 恢复 ----------

// TestM6AdminDeleteThenRestore 走一遍「下架一条 → 恢复一条」，重点有三个：
//
//   - **单条下架的留痕形状必须和批量一致**（detail.ids 长度 1）。
//     §13 第 10 步那条自检 SQL 靠的就是「不管单条还是批量，都查 detail->'ids'」，
//     两种形状的话自检会静默漏掉 admin 在帖子页里删掉的那一批。
//   - **通知挂不挂 item_id 取决于这次动了几条**（N==1 才挂）。
//     m6_governance_test 里断言的是批量那种为 NULL，这里正好是另一半。
//   - **恢复是一次新留痕，不是去改或删掉下架那一行**（日志只追加，它才当得了证据），
//     而且恢复**不发通知** —— 那是一条好消息，作者在自己的「我的发布」里看得见。
func TestM6AdminDeleteThenRestore(t *testing.T) {
	harness.TruncateAll(t)

	owner := harness.RegisterAndLogin(t, "m6del-owner", m5Password)
	admin := harness.MakeAdmin(t, harness.RegisterAndLogin(t, "m6del-admin", m5Password))

	// 建帖顺序沿用 M3/M4 的规矩：found 先建（此刻库里没有 lost 候选，匹配写不出东西），
	// 两条 lost 后建（lost 方向按设计只算不写）。这样下面那些「通知恰好 1 条」才是精确值。
	item := createItem(t, owner, foundBody("被管理员下架又恢复的帖子", "13800000000"))
	selfDel := createItem(t, owner, lostBody("帖主自己删掉的帖子", "13800000000"))
	adminOwn := createItem(t, admin, lostBody("管理员自己删掉的帖子", "13800000000"))

	if p := fetchSquare(t, "page_size=100", ""); p.Total != 3 {
		t.Fatalf("夹具期望广场有 3 条，实际 %d 条", p.Total)
	}

	path := "/api/items/" + itoa(item.ID)

	// ① 两种不合法的 admin_reason 都必须被拒，且**什么都没写**。
	for _, c := range []struct {
		name string
		body map[string]any
	}{
		{"不带 admin_reason", map[string]any{}},
		{"admin_reason 只有空白", map[string]any{"admin_reason": " 　 "}},
		{"admin_reason 超长", map[string]any{"admin_reason": strings.Repeat("长", m6ReasonMaxChars+1)}},
	} {
		t.Run(c.name, func(t *testing.T) {
			r := harness.Do(t, http.MethodDelete, path, c.body, admin.Token)
			RequireCode(t, r, apperr.CodeValidation)
			requireField(t, r, "admin_reason")
			if st := itemStatusOf(t, item.ID); st != model.ItemStatusOpen {
				t.Errorf("被拒的下架请求把帖子改成了 %s，期望还是 open", st)
			}
			if n := harness.Count(t, `SELECT count(*) FROM admin_actions`); n != 0 {
				t.Errorf("被拒的请求写了 %d 行留痕，期望 0 行", n)
			}
			if n := harness.Count(t, `SELECT count(*) FROM notifications`); n != 0 {
				t.Errorf("被拒的请求发了 %d 条通知，期望 0 条", n)
			}
		})
	}

	// ② 真正的 admin 下架。
	del := harness.Do(t, http.MethodDelete, path, map[string]any{"admin_reason": singleTakedown}, admin.Token)
	RequireOK(t, del, "admin 删他人帖")
	if st := itemStatusOf(t, item.ID); st != model.ItemStatusDeleted {
		t.Fatalf("status=%s，期望 deleted", st)
	}
	// 广场看不见，而帖主在 #19 里还能看见（软删对外不存在、对内还在）。
	if p := fetchSquare(t, "page_size=100", ""); p.Total != 2 || containsID(idsOf(p), item.ID) {
		t.Errorf("广场现在是 %v（total=%d），期望 2 条且不含被下架的那条", idsOf(p), p.Total)
	}
	if mine := fetchMine(t, "status=deleted&page_size=100", owner); !containsID(idsOf(mine), item.ID) {
		t.Errorf("帖主的 #19 status=deleted 里查不到自己那条被下架的帖子：%v", idsOf(mine))
	}

	// 留痕：一条，形状和批量同构。
	logs := adminActionsOf(t, admin.UserID)
	if len(logs) != 1 {
		t.Fatalf("admin 删他人帖期望恰好 1 行留痕，实际 %d 行：%+v", len(logs), logs)
	}
	if logs[0].Action != model.ActionItemTakedown || logs[0].TargetType != model.TargetItem {
		t.Errorf("留痕是 %s/%s，期望 %s/%s",
			logs[0].Action, logs[0].TargetType, model.ActionItemTakedown, model.TargetItem)
	}
	if logs[0].TargetID != item.ID {
		t.Errorf("target_id=%d，期望 %d", logs[0].TargetID, item.ID)
	}
	if logs[0].Reason != singleTakedown {
		t.Errorf("reason=%q", logs[0].Reason)
	}
	// ⚠ 这一格是整个测试里最容易写成假绿的一处：ids 键不存在时 Unmarshal 不会报错，
	//    只会留一个 nil 切片，而 len(nil)==0 也一样不等于 1 —— 靠下面那句显式判空补上。
	var tk struct {
		IDs   []int64 `json:"ids"`
		Count int     `json:"count"`
	}
	decodeInto(t, json.RawMessage(logs[0].Detail), &tk)
	if len(tk.IDs) != 1 || tk.IDs[0] != item.ID || tk.Count != 1 {
		t.Errorf("单条下架的 detail 是 %s，期望 {\"ids\":[%d],\"count\":1} —— "+
			"§13 第 10 步的自检 SQL 只认 detail->'ids'，这条写成别的键那批行就追不出来",
			logs[0].Detail, item.ID)
	}

	// 通知：作者恰好 1 条，而且**挂着 item_id**（这次只动了一条，点进去就是那张帖子）。
	ns := notificationsOf(t, owner.UserID)
	if got := findByTypeCount(t, ns, model.NotificationAdminAction); got != 1 {
		t.Fatalf("作者收到 %d 条 admin_action，期望恰好 1 条：%v", got, typesOf(ns))
	}
	n := findByType(t, ns, model.NotificationAdminAction)
	if !strings.Contains(n.Content, singleTakedown) {
		t.Errorf("通知里没有理由原文：%q", n.Content)
	}
	if n.ItemID == nil || *n.ItemID != item.ID {
		t.Errorf("单条下架的通知 item_id 是 %v，期望指向那条帖子 %d（批量那种才是 NULL）",
			n.ItemID, item.ID)
	}

	// ③ 帖主自删 / admin 删自己的帖：两条**不是治理动作**的路径。
	RequireOK(t, harness.Do(t, http.MethodDelete,
		"/api/items/"+itoa(selfDel.ID), nil, owner.Token), "帖主删自己的帖子")
	RequireOK(t, harness.Do(t, http.MethodDelete,
		"/api/items/"+itoa(adminOwn.ID), nil, admin.Token), "admin 删自己的帖子")
	// adminOwn 那一条是最有意思的：操作者是 admin，但**他是帖主**，
	// 所以走的还是帖主那条路 —— 分支的键是归属，不是角色。
	if got := harness.Count(t, `SELECT count(*) FROM admin_actions`); got != 1 {
		t.Errorf("两次自删之后留痕变成 %d 行，期望还是 1 行（自己的帖子自己删，不需要向任何人交代）", got)
	}
	if got := harness.Count(t, `SELECT count(*) FROM notifications`); got != 1 {
		t.Errorf("两次自删之后通知变成 %d 条，期望还是 1 条（只有 ② 那次下架该通知作者）", got)
	}
	if st := itemStatusOf(t, adminOwn.ID); st != model.ItemStatusDeleted {
		t.Errorf("admin 删自己的帖子没生效，status=%s", st)
	}

	// ④ #44 恢复。
	res := harness.Post(t, "/api/admin/items/"+itoa(item.ID)+"/restore",
		map[string]any{"reason": singleRestore}, admin.Token)
	RequireOK(t, res, "#44 恢复")
	var rr struct {
		ID     int64  `json:"id"`
		Status string `json:"status"`
	}
	res.DataInto(t, &rr)
	if rr.ID != item.ID || rr.Status != model.ItemStatusOpen {
		t.Errorf("#44 的 data 是 %+v，期望 {id:%d,status:open}", rr, item.ID)
	}
	if st := itemStatusOf(t, item.ID); st != model.ItemStatusOpen {
		t.Fatalf("库里 status=%s，期望 open", st)
	}
	// 广场读得到它了 —— 这条断言把「恢复」和「只是把那一列改了」区分开。
	back := fetchSquare(t, "page_size=100", "")
	if !containsID(idsOf(back), item.ID) {
		t.Errorf("恢复之后广场里查不到那条帖子：%v", idsOf(back))
	}

	logs = adminActionsOf(t, admin.UserID)
	if len(logs) != 2 {
		t.Fatalf("恢复之后留痕期望 2 行，实际 %d 行", len(logs))
	}
	restored := logs[1]
	if restored.Action != model.ActionItemRestore || restored.TargetID != item.ID {
		t.Errorf("第二行留痕是 %s/target=%d，期望 %s/target=%d",
			restored.Action, restored.TargetID, model.ActionItemRestore, item.ID)
	}
	if restored.Reason != singleRestore {
		t.Errorf("恢复的 reason=%q", restored.Reason)
	}
	// ⚠ 下架那一行**还在**：日志只追加不改写，「他先删了、后来又恢复了」这条链
	//    要能完整读出来，改掉或删掉下架那行就等于把一次误操作抹掉。
	if logs[0].Action != model.ActionItemTakedown {
		t.Errorf("第一行留痕被改成了 %q，期望还是 %s（台账只追加）", logs[0].Action, model.ActionItemTakedown)
	}
	var rsDetail struct {
		AuthorID int64 `json:"author_id"`
	}
	decodeInto(t, json.RawMessage(restored.Detail), &rsDetail)
	if rsDetail.AuthorID != owner.UserID {
		t.Errorf("detail.author_id=%d，期望 %d", rsDetail.AuthorID, owner.UserID)
	}

	// 恢复**不发通知**：§3.7 那四种 admin_action 触发里没有这一种，
	// 而它又是一条好消息 —— 为它发明一种通知等于给台账添一条只有 admin 能写的表扬。
	if got := harness.Count(t, `SELECT count(*) FROM notifications`); got != 1 {
		t.Errorf("恢复之后全库通知 %d 条，期望还是 1 条（下架那次的回执）", got)
	}

	// ⑤ #44 的三种拒绝。
	t.Run("恢复一条不是 deleted 的帖子", func(t *testing.T) {
		r := harness.Post(t, "/api/admin/items/"+itoa(item.ID)+"/restore",
			map[string]any{"reason": singleRestore}, admin.Token)
		RequireCode(t, r, apperr.CodeValidation)
		requireField(t, r, "id")
		if n := harness.Count(t, `SELECT count(*) FROM admin_actions`); n != 2 {
			t.Errorf("被拒的恢复写了留痕：%d 行，期望还是 2 行", n)
		}
	})
	t.Run("恢复一条不存在的帖子", func(t *testing.T) {
		RequireCode(t, harness.Post(t, "/api/admin/items/999999/restore",
			map[string]any{"reason": singleRestore}, admin.Token), apperr.CodeNotFound)
	})
	t.Run("恢复不带理由", func(t *testing.T) {
		// selfDel 现在是 deleted，正好当靶子：它由帖主自己删的，
		// 而恢复它是 admin 的动作 —— 没有理由必须被拒。
		r := harness.Do(t, http.MethodPost, "/api/admin/items/"+itoa(selfDel.ID)+"/restore",
			map[string]any{}, admin.Token)
		RequireCode(t, r, apperr.CodeValidation)
		requireField(t, r, "reason")
		if st := itemStatusOf(t, selfDel.ID); st != model.ItemStatusDeleted {
			t.Errorf("被拒的恢复把帖主自删的那条改成了 %s", st)
		}
	})
}

// containsID 复用 m5_return_reject_test.go 里那一个（同一个包里两份定义会打架，
// 而两份的话其中一份改了另一份不会跟着改）。

// ---------- #45 admin 删图 ----------

// TestM6AdminDeleteImage 钉住「真的捡到东西的人不该因为一张照片有问题就丢掉整条帖子」
// 这句话的四层含义：只删那一行 item_images、只删那一个磁盘文件、帖子原样、作者收到一条说法。
//
// 「只删了这一张」这件事第①层测不了：fake 里 os.Remove 是一个计数的桩，
// 桩返回 0 次和返回 2 次都证明不了什么。这里走 #40 那条真实路由，
// 拿两个 URL 各发一次 GET —— 404 / 200 是磁盘上的事实。
func TestM6AdminDeleteImage(t *testing.T) {
	harness.TruncateAll(t)

	owner := harness.RegisterAndLogin(t, "m6img-owner", m5Password)
	bystander := harness.RegisterAndLogin(t, "m6img-bystander", m5Password)
	admin := harness.MakeAdmin(t, harness.RegisterAndLogin(t, "m6img-admin", m5Password))

	first, second := upload(t, owner, 2048), upload(t, owner, 4096)
	body := foundBody("带两张图的拾物帖", "13800000000")
	body["image_paths"] = []string{first.Path, second.Path}
	item := createItem(t, owner, body)

	// 图片的**行 id** 只能从 #15 里读（#45 的路径参数就是它，和 #42 帖主自删同一条）。
	before := fetchDetail(t, item.ID, owner.Token)
	if len(before.Images) != 2 {
		t.Fatalf("夹具期望这条帖子挂着 2 张图，实际 %d 张", len(before.Images))
	}
	target, survivor := before.Images[0], before.Images[1]
	// 先证明两个文件此刻都读得到 —— 否则「删掉之后 404」有可能是「一开始就 404」。
	for _, u := range []string{target.URL, survivor.URL} {
		if status, _, _ := harness.GetRaw(t, u, ""); status != http.StatusOK {
			t.Fatalf("夹具的图 %s 现在读不到（HTTP %d），后面的 404 断言就没有意义了", u, status)
		}
	}

	// ① 没有理由 → VALIDATION，那一行图和那个文件都还在。
	rej := harness.Do(t, http.MethodDelete, "/api/admin/item-images/"+itoa(target.ID),
		map[string]any{}, admin.Token)
	RequireCode(t, rej, apperr.CodeValidation)
	requireField(t, rej, "reason")
	if n := harness.Count(t, `SELECT count(*) FROM item_images WHERE item_id = $1`, item.ID); n != 2 {
		t.Errorf("被拒的删图请求之后还有 %d 行图，期望 2 行", n)
	}
	if n := harness.Count(t, `SELECT count(*) FROM admin_actions`); n != 0 {
		t.Errorf("被拒的请求写了 %d 行留痕，期望 0 行", n)
	}

	// ② 一个不存在（或者说形状合法但从没签发过）的图片 id。
	RequireCode(t, harness.Do(t, http.MethodDelete, "/api/admin/item-images/999999",
		map[string]any{"reason": imageTakedown}, admin.Token), apperr.CodeNotFound)

	// ③ 真正的删图。
	RequireOK(t, harness.Do(t, http.MethodDelete, "/api/admin/item-images/"+itoa(target.ID),
		map[string]any{"reason": imageTakedown}, admin.Token), "#45 admin 删图")

	if n := harness.Count(t, `SELECT count(*) FROM item_images WHERE item_id = $1`, item.ID); n != 1 {
		t.Fatalf("删图之后这条帖子还有 %d 行图，期望 1 行", n)
	}
	if id := harness.QueryRow(t, `SELECT id FROM item_images WHERE item_id = $1`, item.ID)["id"]; id != survivor.ID {
		t.Errorf("活下来的那张图是 %v，期望 %d（删错了一张比删两张更糟）", id, survivor.ID)
	}
	// 磁盘：被删的那张 404，另一张 200 —— 一次删图不能连带清掉同一条帖子的其他图。
	if status, _, _ := harness.GetRaw(t, target.URL, ""); status != http.StatusNotFound {
		t.Errorf("被删的那张图还能从 %s 读到（HTTP %d），期望 404", target.URL, status)
	}
	if status, _, _ := harness.GetRaw(t, survivor.URL, ""); status != http.StatusOK {
		t.Errorf("幸存的那张图 %s 变成 HTTP %d 了，期望 200 —— 删一张图不该动别人的文件",
			survivor.URL, status)
	}

	// 帖子本身完好：状态没变、广场还在、#15 少了一张图。
	if st := itemStatusOf(t, item.ID); st != model.ItemStatusOpen {
		t.Errorf("帖子状态被改成了 %s，期望 open（「真的捡到东西的人不该因为一张照片丢掉整条帖子」）", st)
	}
	if p := fetchSquare(t, "page_size=100", ""); !containsID(idsOf(p), item.ID) {
		t.Errorf("广场里查不到那条帖子了：%v", idsOf(p))
	}
	if after := fetchDetail(t, item.ID, owner.Token); len(after.Images) != 1 {
		t.Errorf("#15 现在返回 %d 张图，期望 1 张", len(after.Images))
	}

	// ④ 留痕 + 通知。
	logs := adminActionsOf(t, admin.UserID)
	if len(logs) != 1 {
		t.Fatalf("删图期望恰好 1 行留痕，实际 %d 行：%+v", len(logs), logs)
	}
	// target_id 指向**图片自己**而不是帖子：管理员处置的对象是那张图，
	// 都记成帖子 id 的话，翻台账就看不出到底是帖子被改了还是图被删了。
	if logs[0].Action != model.ActionImageTakedown || logs[0].TargetType != model.TargetItemImage {
		t.Errorf("留痕是 %s/%s，期望 %s/%s", logs[0].Action, logs[0].TargetType,
			model.ActionImageTakedown, model.TargetItemImage)
	}
	if logs[0].TargetID != target.ID {
		t.Errorf("target_id=%d，期望图片自己的 id %d", logs[0].TargetID, target.ID)
	}
	var imgDetail struct {
		ItemID int64 `json:"item_id"`
	}
	decodeInto(t, json.RawMessage(logs[0].Detail), &imgDetail)
	if imgDetail.ItemID != item.ID {
		t.Errorf("detail.item_id=%d，期望 %d（光有图片 id 查不出它属于哪条帖子）", imgDetail.ItemID, item.ID)
	}

	ns := notificationsOf(t, owner.UserID)
	if got := findByTypeCount(t, ns, model.NotificationAdminAction); got != 1 {
		t.Fatalf("作者收到 %d 条 admin_action，期望恰好 1 条：%v", got, typesOf(ns))
	}
	own := findByType(t, ns, model.NotificationAdminAction)
	if !strings.Contains(own.Content, imageTakedown) {
		t.Errorf("通知里没有理由原文：%q", own.Content)
	}
	if own.ItemID == nil || *own.ItemID != item.ID {
		t.Errorf("删图通知的 item_id 是 %v，期望 %d —— 作者点进去得落到那条帖子", own.ItemID, item.ID)
	}
	// 和这条帖子毫无关系的旁观者一条都不该收到。
	if ns := notificationsOf(t, bystander.UserID); len(ns) != 0 {
		t.Errorf("旁观者收到了 %d 条通知：%v", len(ns), typesOf(ns))
	}

	// ⑤ 再删同一张图（行已经没了）→ NOT_FOUND，台账不增行。
	RequireCode(t, harness.Do(t, http.MethodDelete, "/api/admin/item-images/"+itoa(target.ID),
		map[string]any{"reason": imageTakedown}, admin.Token), apperr.CodeNotFound)
	if got := harness.Count(t, `SELECT count(*) FROM admin_actions`); got != 1 {
		t.Errorf("重复删图之后留痕变成 %d 行，期望还是 1 行", got)
	}
}

// ---------- #46 admin 删归还确认 ----------

// TestM6AdminDeleteReturn 是「admin 对归还流程唯一能做的事」那一句的第②层版本。
//
// 它删的是一行**记录**，不做任何确认或拒绝，所以三件事必须同时成立：
// 那一行没了、提交人被告知为什么没了、**那条帖子还是 open 还在广场上**
// （删一条刷出来的假确认不该把真拾主的家给拆了）。
//
// 通知只发给提交人，发帖人不发：见 service/moderation.go 那段——
// 「有人替你删掉了骚扰你的假确认」没有需要发帖人做的下一步。
// 这里用**增量**而不是绝对值断言：夹具自己就会给发帖人留下 1 条 return_submitted，
// 那个基线不是 bug（M5 的判据要求的），把它算成「admin 的动作的后果」才是 bug。
func TestM6AdminDeleteReturn(t *testing.T) {
	st := setupM5(t)
	admin := harness.MakeAdmin(t, st.stranger)

	sub := requireSubmitted(t, st.found.ID, st.li)

	liBefore := len(notificationsOf(t, st.li.UserID))
	finderBefore := len(notificationsOf(t, st.finder.UserID))
	creditBefore := harness.Count(t, `SELECT count(*) FROM credit_logs`)

	path := "/api/admin/returns/" + itoa(sub.ID)

	// ① 没有理由：那一行还在，什么都没写。
	rej := harness.Do(t, http.MethodDelete, path, map[string]any{}, admin.Token)
	RequireCode(t, rej, apperr.CodeValidation)
	requireField(t, rej, "reason")
	if row := returnRow(t, sub.ID); row["status"] != model.ReturnStatusPending {
		t.Fatalf("被拒的删确认请求把那一行改成了 %v，期望还是 pending", row["status"])
	}
	if n := harness.Count(t, `SELECT count(*) FROM admin_actions`); n != 0 {
		t.Errorf("被拒的请求写了 %d 行留痕，期望 0 行", n)
	}

	// ② 真的删掉它。
	RequireOK(t, harness.Do(t, http.MethodDelete, path,
		map[string]any{"reason": returnTakedownRsn}, admin.Token), "#46 admin 删归还确认")

	if n := harness.Count(t, `SELECT count(*) FROM item_returns WHERE id = $1`, sub.ID); n != 0 {
		t.Fatalf("那一行归还确认还在（%d 行），#46 是硬删", n)
	}

	// 帖子完全没被牵连：状态、广场、积分流水一个都没动。
	// （变量名刻意不叫 st —— 它会被 M5 那个舞台 st 遮住，读代码的人要在两个 st 之间换算。）
	if now := itemStatusOf(t, st.found.ID); now != model.ItemStatusOpen {
		t.Errorf("帖子状态被改成了 %s，期望 open（删假确认不该让真帖子消失）", now)
	}
	if p := fetchSquare(t, "page_size=100", ""); !containsID(idsOf(p), st.found.ID) {
		t.Errorf("广场里查不到那条拾物帖了：%v", idsOf(p))
	}
	if got := harness.Count(t, `SELECT count(*) FROM credit_logs`); got != creditBefore {
		t.Errorf("积分流水从 %d 行变成 %d 行 —— 删一条确认不加分也不扣分", creditBefore, got)
	}

	// ③ 留痕：三个 detail 键都得有。previous_status 尤其重要 ——
	// 行删掉之后「他当时提交的那条处在什么阶段」只剩这一格能回答。
	logs := adminActionsOf(t, admin.UserID)
	if len(logs) != 1 {
		t.Fatalf("删归还确认期望恰好 1 行留痕，实际 %d 行：%+v", len(logs), logs)
	}
	if logs[0].Action != model.ActionReturnTakedown || logs[0].TargetType != model.TargetItemReturn {
		t.Errorf("留痕是 %s/%s，期望 %s/%s", logs[0].Action, logs[0].TargetType,
			model.ActionReturnTakedown, model.TargetItemReturn)
	}
	if logs[0].TargetID != sub.ID {
		t.Errorf("target_id=%d，期望归还确认自己的 id %d", logs[0].TargetID, sub.ID)
	}
	var rtDetail struct {
		ItemID         int64  `json:"item_id"`
		SubmitterID    int64  `json:"submitter_id"`
		PreviousStatus string `json:"previous_status"`
	}
	decodeInto(t, json.RawMessage(logs[0].Detail), &rtDetail)
	if rtDetail.ItemID != st.found.ID || rtDetail.SubmitterID != st.li.UserID {
		t.Errorf("detail 是 %s，期望 item_id=%d / submitter_id=%d",
			logs[0].Detail, st.found.ID, st.li.UserID)
	}
	if rtDetail.PreviousStatus != model.ReturnStatusPending {
		t.Errorf("detail.previous_status=%q，期望 %q", rtDetail.PreviousStatus, model.ReturnStatusPending)
	}

	// ④ 通知：提交人 +1 且带着那两个跳转用的 id；发帖人 +0。
	liAfter := notificationsOf(t, st.li.UserID)
	if got := len(liAfter) - liBefore; got != 1 {
		t.Fatalf("提交人收到的通知增量是 %d 条，期望恰好 1 条（基线 %d 条 + 这次的动作）", got, liBefore)
	}
	notice := liAfter[len(liAfter)-1]
	if notice.Type != model.NotificationAdminAction {
		t.Errorf("那条新通知的类型是 %q，期望 %s", notice.Type, model.NotificationAdminAction)
	}
	if !strings.Contains(notice.Content, returnTakedownRsn) {
		t.Errorf("通知里没有理由原文：%q", notice.Content)
	}
	if notice.ReturnID == nil || *notice.ReturnID != sub.ID {
		t.Errorf("通知的 return_id 是 %v，期望 %d", notice.ReturnID, sub.ID)
	}
	if notice.ItemID == nil || *notice.ItemID != st.found.ID {
		t.Errorf("通知的 item_id 是 %v，期望 %d", notice.ItemID, st.found.ID)
	}
	if got := len(notificationsOf(t, st.finder.UserID)) - finderBefore; got != 0 {
		t.Errorf("发帖人因为这次删确认多收到 %d 条通知，期望 0 条", got)
	}

	// ⑤ 重复删同一条（行已经没了）→ NOT_FOUND，留痕不增行。
	RequireCode(t, harness.Do(t, http.MethodDelete, path,
		map[string]any{"reason": returnTakedownRsn}, admin.Token), apperr.CodeNotFound)
	if got := harness.Count(t, `SELECT count(*) FROM admin_actions`); got != 1 {
		t.Errorf("重复删之后留痕变成 %d 行，期望还是 1 行", got)
	}
}
