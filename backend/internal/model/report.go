package model

import "time"

// 举报的六个 reason_code 和三种状态。
//
// ⚠ 这两组字面量不是我们自己定的，它们是 000001 迁移第 12 节里 reports 表
// 两条 CHECK 约束的内容。写错一个字母不会编译报错，也不会有一个清楚的运行时提示，
// 得到的是 SQLSTATE 23514（check_violation）—— 那是 §10 里最难查的一类失败：
// 看起来是数据库坏了，实际是代码里少了一个字母。
// 所以这里一次列全，当作那两条 CHECK 的镜像，service 按它做**前置**校验。
//
// 状态机只有三个值，而且**没有任何自动转移**：
//   - open     —— #41 写入时唯一的取值
//   - resolved —— admin 采纳了（#49，M6）
//   - dismissed —— admin 没采纳（#49，M6）
//
// M4 只产生 open。之所以把后两个也列在这里，是因为 #41 的响应形状里有 `status` 字段，
// 而它的值域是这三者之一 —— 少列一个，将来读响应的人就会以为只有两种。
const (
	ReportReasonSpam       = "spam"
	ReportReasonPrivacy    = "privacy"
	ReportReasonFraud      = "fraud"
	ReportReasonHarassment = "harassment"
	ReportReasonIllegal    = "illegal"
	ReportReasonOther      = "other"

	ReportStatusOpen      = "open"
	ReportStatusResolved  = "resolved"
	ReportStatusDismissed = "dismissed"
)

// ReportReasonCodes 是 reason_code 的合法值集合，顺序和迁移里的 CHECK 一致。
//
// 用它做校验而不是写六个 case：校验点和错误文案（「只能是 …」）都要列一遍合法值，
// 两处各写一遍的话，将来 CHECK 加一个码就得记得改两处。
// 这个切片是那条 CHECK 的第二镜像，而**镜像只该有一份**。
var ReportReasonCodes = []string{
	ReportReasonSpam,
	ReportReasonPrivacy,
	ReportReasonFraud,
	ReportReasonHarassment,
	ReportReasonIllegal,
	ReportReasonOther,
}

// IsValidReportReason 判一个 reason_code 是否在合法值里。
//
// 和 admin_actions 那两个 IsValid 一样：给 service 做**前置**校验用，
// 让撞 CHECK（23514）变成永远不该发生的兜底，而不是用户看到的报错。
func IsValidReportReason(code string) bool {
	for _, c := range ReportReasonCodes {
		if c == code {
			return true
		}
	}
	return false
}

// ReportStatuses 是 reports.status 的合法值集合，顺序和迁移里的 CHECK 一致。
//
// 它存在的理由是 #48 那条 `?status=` 筛选参数：那是**用户输入**，
// 拼错一个字母不会撞 CHECK（它进的是 WHERE，不是 INSERT），只会安静地返回空列表 ——
// 管理员会以为「没有待处理的举报」，而真实情况是他的 URL 里多了一个空格。
// 所以 service 拿它做前置白名单，和 reason_code 那条同一处理方式。
var ReportStatuses = []string{ReportStatusOpen, ReportStatusResolved, ReportStatusDismissed}

func IsValidReportStatus(s string) bool {
	for _, v := range ReportStatuses {
		if v == s {
			return true
		}
	}
	return false
}

// #49 的三种处置结论。这三个值**不是数据库里的列值**，而是请求体里的 resolution 字段
// （§4 第 49 行：`{resolution:"takedown"|"ban"|"dismiss"}`），
// 所以迁移里没有对应的 CHECK，镜像也只存在于这一处。
//
// 它们和 reports.status 的三种值不是一回事，别混：
//   - takedown / ban 都让那一行变成 resolved（采纳了这条举报），
//     区别只在于**连带做了什么**（下架那条帖子 / 封了发帖人）
//   - dismiss 让那一行变成 dismissed（看了，没采纳）
//
// 这也是为什么留痕的行数是 2、2、1 而不是 1、1、1（§12 M6）：
// takedown 和 ban 各写两行 admin_actions（一条 report_resolved + 一条 item_takedown/user_ban），
// 因为「处置了这条举报」和「下架了那条帖子」是两件事，混成一行就没法回答
// 「到底是有人举报，还是 admin 自己巡查看见的」。
const (
	ReportResolutionTakedown = "takedown"
	ReportResolutionBan      = "ban"
	ReportResolutionDismiss  = "dismiss"
)

// ReportResolutions 是 resolution 的合法值集合。
var ReportResolutions = []string{ReportResolutionTakedown, ReportResolutionBan, ReportResolutionDismiss}

func IsValidReportResolution(r string) bool {
	for _, v := range ReportResolutions {
		if v == r {
			return true
		}
	}
	return false
}

// ReportRow 是 #48 一页里的完整一行：举报本身 + 连表读来的帖子摘要和举报人昵称。
//
// 之所以有这个东西而不是 model.Report：#48 的响应要求把 item 和 reporter
// 各做成一个内嵌对象（§4 第 48 行），那四列压根不在 reports 表里。
// 一次 JOIN 扫进一个扁平结构，比让 service 拿着 20 条举报去发 40 次点查好得多。
type ReportRow struct {
	ID         int64
	ItemID     int64
	ItemTitle  string
	ItemStatus string
	// 被举报那条帖子的作者。#49 选 ban 的时候，被封的人就是他 ——
	// 而不是举报人（那是 §14-13 里最刺眼的一种攻击：举报别人把自己的号封掉）。
	ItemUserID       int64
	ReporterID       int64
	ReporterNickname string
	ReasonCode       string
	Detail           string
	Status           string
	CreatedAt        time.Time
	// OpenCountOnItem 是这条帖子**当前待处理**的举报总数（含这一条自己）。
	OpenCountOnItem int
}

// ReporterBrief 是 #48 里那个 {id, nickname}。
//
// 形状和 AuthorView、AdminBrief 一模一样（这个系统里「只要知道是谁」的地方
// 就只需要这两列），但名字保留三个而不是合并成一个：每一处调用点写出来的类型名
// 正好说出「这一格是谁」——`Reporter: ReporterBrief{...}` 和
// `Reporter: AuthorView{...}` 读起来第二种会以为填错了。
// 三处各两列的重复是**便宜的**；一处改名影响三个端点才是贵的。
type ReporterBrief struct {
	ID       int64  `json:"id"`
	Nickname string `json:"nickname"`
}

// ReportItemBrief 是 #48 里那个帖子摘要。
//
// 只有四列：待办页要回答的是「哪条帖子、什么状态、值不值得先处理」。
// 完整详情点进 #15 看（那个端点 admin 本来就能读）。
// status 必须在：一条已经被下架的帖子还挂着三条待处理举报，
// 那正是管理员需要一眼看到的「这事已经处理过了，剩下的可以一键驳回」。
type ReportItemBrief struct {
	ID     int64  `json:"id"`
	Title  string `json:"title"`
	Status string `json:"status"`
}

// ReportView 是 #48 GET /api/admin/reports 的 list 元素。
//
// ⚠ 这里**有** reporter.id / nickname，但它只在这一个端点上成立。
// reports.reporter_id 那一列在迁移里的注释是「除 admin 外对任何人不可见」（§3.7），
// 所以将来谁给 #15 或 #22 加一个「显示谁举报的」，那就是把整个举报机制反转成互相攻击的工具。
type ReportView struct {
	ID                int64           `json:"id"`
	Item              ReportItemBrief `json:"item"`
	Reporter          ReporterBrief   `json:"reporter"`
	ReasonCode        string          `json:"reason_code"`
	Detail            string          `json:"detail"`
	Status            string          `json:"status"`
	ReportCountOnItem int             `json:"report_count_on_item"`
	CreatedAt         string          `json:"created_at"`
}

// View 把 #48 的一行转成对外形状。
func (r *ReportRow) View() ReportView {
	return ReportView{
		ID:                r.ID,
		Item:              ReportItemBrief{ID: r.ItemID, Title: r.ItemTitle, Status: r.ItemStatus},
		Reporter:          ReporterBrief{ID: r.ReporterID, Nickname: r.ReporterNickname},
		ReasonCode:        r.ReasonCode,
		Detail:            r.Detail,
		Status:            r.Status,
		ReportCountOnItem: r.OpenCountOnItem,
		CreatedAt:         formatTimeValue(r.CreatedAt),
	}
}
