package model

import (
	"encoding/json"
	"time"
)

// 治理动作的十二种 action。**这十二个字面量不是我们自己定的**，它是 000001 迁移第 11 节
// admin_actions_action_check 那条约束的内容，写错一个字母会得到 23514 而不是一个
// 能看出问题的报错 —— 和 notifications 那七种 type 完全同一条理由（见 notification.go 顶部）。
//
// 一次列全，并且把它们做成**可以被遍历的值**（AdminActionValues），因为 M6 有一条
// 表驱动的 TestEveryAdminWriteIsLogged：它要拿着「哪些动作必须留痕」这张表逐条调用端点。
// 那张表如果只能靠人翻代码凑，它就会漏，而漏掉的后果是「admin 做了一件事却没留下记录」——
// 正是这套治理模型唯一要防的那件事。
//
// 读法说明：item_edit / item_takedown 是**同一张表上的两种动作**而不是两种权限 ——
// #16（admin 改他人帖）写 item_edit，#17（admin 删他人帖）和 #43（批量下架）都写 item_takedown，
// #44（恢复）写 item_restore。区别只在 detail：批量那条把完整 id 列表放进 detail.ids。
const (
	ActionItemTakedown   = "item_takedown"
	ActionItemRestore    = "item_restore"
	ActionImageTakedown  = "image_takedown"
	ActionReturnTakedown = "return_takedown"
	ActionItemEdit       = "item_edit"
	ActionUserBan        = "user_ban"
	ActionUserUnban      = "user_unban"
	ActionUserRoleChange = "user_role_change"
	ActionWarningSent    = "warning_sent"
	ActionReportResolved = "report_resolved"
	ActionDictCreate     = "dict_create"
	ActionDictDelete     = "dict_delete"
)

// 治理对象的七种 target_type，同样是那条 CHECK 的镜像。
//
// ⚠ 这里没有 "admin_action" 自己：治理动作不作用于治理动作。
// 也就是说没有「撤销一次下架」这个动作 —— #44 item_restore 恢复的是**帖子**，
// 它自己会新写一行留痕，而不是去改或删掉 #43 那一行。
// 日志只追加、不改写，这是它能当证据的前提。
const (
	TargetItem       = "item"
	TargetItemImage  = "item_image"
	TargetItemReturn = "item_return"
	TargetUser       = "user"
	TargetReport     = "report"
	TargetCategory   = "category"
	TargetLocation   = "location"
)

// AdminActionValues / TargetTypeValues 是上面两组常量的完整列表。
//
// 它们存在的唯一理由是 service/adminlog.go 的那两道校验：把「迁移里允许哪些值」这件事
// 写成一个可以遍历的表，而不是写成一堆 if 里散落的字面量。加新值时必须同时改这里和迁移，
// 漏改的报错是那句人能看懂的「未知的治理动作」，不是 23514。
func AdminActionValues() []string {
	return []string{
		ActionItemTakedown, ActionItemRestore, ActionImageTakedown, ActionReturnTakedown,
		ActionItemEdit, ActionUserBan, ActionUserUnban, ActionUserRoleChange,
		ActionWarningSent, ActionReportResolved, ActionDictCreate, ActionDictDelete,
	}
}

func TargetTypeValues() []string {
	return []string{
		TargetItem, TargetItemImage, TargetItemReturn, TargetUser, TargetReport,
		TargetCategory, TargetLocation,
	}
}

// IsValidAdminAction / IsValidTargetType 供 adminlog.Record 做写前的自检。
func IsValidAdminAction(a string) bool {
	for _, v := range AdminActionValues() {
		if v == a {
			return true
		}
	}
	return false
}

func IsValidTargetType(t string) bool {
	for _, v := range TargetTypeValues() {
		if v == t {
			return true
		}
	}
	return false
}

// AdminAction 对应 admin_actions 表的一行。
//
// Detail 是**序列化之后的 JSON 文本**而不是 map：和 repo/match.go 的 Breakdown 同一取舍 ——
// 从库里读出来就是一段文本，谁要理解它的结构谁自己解（#50 的响应要原样吐回一个 JSON 对象，
// 所以 AdminActionView 那里用 json.RawMessage，免掉「解成 map 再序列化回来」这一趟
// 会把 key 顺序和数字精度都改掉）。
//
// AdminID 是外键指向 users(id)，但**不做级联删除**：账号注销了，他当 admin 时
// 做过什么必须还在。#50 那条 JOIN 用 LEFT JOIN 而不是 INNER，就是为了这种行还能列出来
// （读出来 AdminMissing=true，响应里的 admin 是 null）。
type AdminAction struct {
	ID         int64
	AdminID    int64
	Action     string
	TargetType string
	TargetID   int64
	Reason     string
	Detail     string
	CreatedAt  time.Time
}

// AdminActionRow 是 #50 一页里的完整一行：日志本身 + 是谁做的。
//
// 为什么不直接把 model.AdminAction 返回出去：#50 的响应形状要求 admin 是一个
// `{id, nickname}` 的内嵌对象（计划 §4 第 50 行），而 nickname 不在 admin_actions 表里，
// 是 JOIN users 读出来的。把它们放在一个扁平结构里，比让 service 为了拼响应
// 再逐个去查一遍用户（N+1）好。
//
// AdminMissing 是 SQL 里那句 `(u.id IS NULL) AS admin_missing` 直接扫进来的，
// 不是靠「nickname 是空串就猜账号没了」推出来的 —— users.nickname 是
// NOT NULL DEFAULT ”，一个从没填过昵称的真实用户也会给出空串，
// 那种推断会把「他还没填昵称」显示成「他已经注销」。
type AdminActionRow struct {
	AdminAction

	AdminNickname string
	AdminMissing  bool
}

// AdminActionView 是 #50 GET /api/admin/actions 的 list 元素。
//
// Detail 用 json.RawMessage：前端拿到的是一个 JSON 对象（`{"ids":[1,2,...]}`），
// 而不是一段还得再 JSON.parse 一遍的字符串。这是安全的，因为列类型是 JSONB ——
// PostgreSQL 只接受合法 JSON，所以从库里读出来的那段文本一定是合法的，
// 不存在「原样转发了一段坏 JSON 把响应炸掉」的情况。
//
// Admin 是指针而不是内嵌值：那一行对应的 admin 账号可能已经不在了
// （§3.4 允许从 Adminer 里删 users 行）。那种情况下这里是 null ——
// 「这条留痕还在，但做它的那个账号已被删除」本身就是其它 admin 需要看到的信息，
// 所以宁可给 null 也不把这行藏掉。
type AdminActionView struct {
	ID         int64           `json:"id"`
	Admin      *AdminBrief     `json:"admin"`
	Action     string          `json:"action"`
	TargetType string          `json:"target_type"`
	TargetID   int64           `json:"target_id"`
	Reason     string          `json:"reason"`
	Detail     json.RawMessage `json:"detail"`
	CreatedAt  string          `json:"created_at"`
}

// AdminBrief 是 #50 里那个 {id, nickname}。
//
// 只有两列：这里不需要 username/role/credit_score，而多给一列就多一份「admin 列表页
// 泄漏了普通用户的更多信息」的风险面。日志页要回答的问题是「谁做的」，一个昵称够了。
type AdminBrief struct {
	ID       int64  `json:"id"`
	Nickname string `json:"nickname"`
}

// View 把 #50 的一行转成对外形状。
//
// Detail 为空串时补 "{}" 而不是让它变成 JSON 里的 null：
// json.Marshal(json.RawMessage("")) 会输出 null，而「没有细节」和「detail 这个键没有值」
// 在前端是两套分支。约定是 detail 永远是对象，所以这里兜住那个空。
func (a *AdminActionRow) View() AdminActionView {
	v := AdminActionView{
		ID:         a.ID,
		Action:     a.Action,
		TargetType: a.TargetType,
		TargetID:   a.TargetID,
		Reason:     a.Reason,
		Detail:     json.RawMessage(a.Detail),
		CreatedAt:  formatTimeValue(a.CreatedAt),
	}
	if len(a.Detail) == 0 {
		v.Detail = json.RawMessage("{}")
	}
	// AdminMissing 是 SQL 里那句 (u.id IS NULL) 读出来的：账号已经被删掉了。
	// 那种情况下整个 admin 给 null —— 那个 id 无处可查（用户行没了），
	// 而「这条留痕还在、做它的人已注销」这件事本身就在那一格里说完了。
	// 判断只看 AdminMissing，不看 nickname 是否为空串：真实用户可以有一个从没填过的昵称。
	if !a.AdminMissing {
		v.Admin = &AdminBrief{ID: a.AdminID, Nickname: a.AdminNickname}
	}
	return v
}
