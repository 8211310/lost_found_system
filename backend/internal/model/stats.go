package model

// Stats 是 #37 GET /api/admin/stats 的 data 形状（计划 §4 第 37 行）。
//
// 这一页的全部用途是「admin 打开后台第一屏就知道这个系统现在有多大、
// 有什么问题在堆积」。所以它数的是**状态分布**而不是流水账：
// 一个 total 数字看不出「广场是不是被 spam 淹了」，
// 而 open=1200 / deleted=800 一眼就看出来了。
//
// 七组数字分别对应七张表（或一张表里的几个状态），
// 每个 count 都必须能写成「一句 SQL、一个索引」，否则这一页会变成一个慢查询列表。
//
// ⚠ ReturnsCount 里**没有 cancelled**：计划 §4 那一行写的是
// `{pending, confirmed, rejected}` 三个。少掉 cancelled 不是漏了，是那一类
// 「用户自己撤的、什么都没发生」的记录对治理没有信息量 ——
// 管理员想知道的是「有多少条待办」「有多少条被拒了（可能被刷）」。
// 要补的话补一个字段，别去改那三个的含义。
type Stats struct {
	Users   UsersCount
	Items   ItemsCount
	Returns ReturnsCount
	Reports ReportsCount
	// ContactViews 是整个表行数：它是「骚扰的唯一事后证据」（§3.4），
	// admin 看的是量级，出事了再去 pgAdmin 里按人查。
	ContactViews int
	AdminActions int
	TodayItems   int
}

type UsersCount struct {
	Total  int
	Local  int // auth_source='local'：本地账号密码
	SSO    int // auth_source='hduhelp'：杭电助手来的
	Banned int
}

type ItemsCount struct {
	Total   int
	Lost    int
	Found   int
	Open    int
	Closed  int
	Deleted int
}

type ReturnsCount struct {
	Pending   int
	Confirmed int
	Rejected  int
}

type ReportsCount struct {
	Open      int
	Resolved  int
	Dismissed int
}

// StatsView 是 #37 的对外形状。
//
// 存在的理由和 UsersCount 那层嵌套一样：JSON 里要的是
// `users_count: {total, local, hduhelp, banned}` 这样的两层对象（§4 原话），
// 而不是 20 个平铺的键。键名 `hduhelp` 而不是 Go 那边的 `SSO`：
// 那是那个第三方服务的名字，前端和后端都得以它为准，不能叫「第三方」这种自指的名。
type StatsView struct {
	UsersCount        UsersCountView   `json:"users_count"`
	ItemsCount        ItemsCountView   `json:"items_count"`
	ReturnsCount      ReturnsCountView `json:"returns_count"`
	ContactViewsCount int              `json:"contact_views_count"`
	ReportsCount      ReportsCountView `json:"reports_count"`
	AdminActionsCount int              `json:"admin_actions_count"`
	TodayItemsCount   int              `json:"today_items_count"`
}

type UsersCountView struct {
	Total   int `json:"total"`
	Local   int `json:"local"`
	HDUHelp int `json:"hduhelp"`
	Banned  int `json:"banned"`
}

// ItemsCountView 把「按类型」和「按状态」两组数并列放在一起，
// 而这两个维度**加起来都各自等于 total**（lost+found = total，open+closed+deleted = total）。
// 所以拿某一组的两个数当全量看是错的 —— 这不是这个形状能表达的东西，
// 前端要算总量就用 total 那一列。
type ItemsCountView struct {
	Lost    int `json:"lost"`
	Found   int `json:"found"`
	Open    int `json:"open"`
	Closed  int `json:"closed"`
	Deleted int `json:"deleted"`
}

type ReturnsCountView struct {
	Pending   int `json:"pending"`
	Confirmed int `json:"confirmed"`
	Rejected  int `json:"rejected"`
}

type ReportsCountView struct {
	Open      int `json:"open"`
	Resolved  int `json:"resolved"`
	Dismissed int `json:"dismissed"`
}

// View 把统计转成对外形状。
//
// 这个函数唯一的存在价值是把 `SSO` 这个 Go 内部叫法翻成 `hduhelp` 这个对外契约名，
// 顺便把 items.total 摘掉（§4 那一行没有它）。两者都不值为此多发一次查询，
// 所以放在这里做一次字段拷贝。
func (s *Stats) View() StatsView {
	return StatsView{
		UsersCount: UsersCountView{
			Total:   s.Users.Total,
			Local:   s.Users.Local,
			HDUHelp: s.Users.SSO,
			Banned:  s.Users.Banned,
		},
		ItemsCount: ItemsCountView{
			Lost:    s.Items.Lost,
			Found:   s.Items.Found,
			Open:    s.Items.Open,
			Closed:  s.Items.Closed,
			Deleted: s.Items.Deleted,
		},
		ReturnsCount: ReturnsCountView{
			Pending:   s.Returns.Pending,
			Confirmed: s.Returns.Confirmed,
			Rejected:  s.Returns.Rejected,
		},
		ContactViewsCount: s.ContactViews,
		ReportsCount: ReportsCountView{
			Open:      s.Reports.Open,
			Resolved:  s.Reports.Resolved,
			Dismissed: s.Reports.Dismissed,
		},
		AdminActionsCount: s.AdminActions,
		TodayItemsCount:   s.TodayItems,
	}
}
