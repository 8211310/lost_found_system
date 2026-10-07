package model

// 通知的七种 type。**这七个字面量不是我们自己定的**，它是 000001 迁移里
// notifications_type_check 那条 CHECK 约束的内容，写错一个字母会得到 23514
// 而不是一个能看出问题的报错。所以这里一次列全七个，当作那条约束的镜像。
//
// M3 只有 NotificationNewMatch 有写入方（found 帖创建时给 lost 作者发一条，§3.7）。
// 其余六个在 M4（举报、解锁相关）和 M5（归还状态机）里才有触发点。
//
// ⚠ 方向是这一整张表最容易搞错的地方，所以逐条写清「发给谁」：
//   - new_match：**仅那条 lost 帖的作者**。found 帖作者永远收不到匹配通知
//     （§2.3、§5.8 的不对称：他是被动方，发完帖义务就完成了）
//   - item_returned_hint：反查台账后告诉 lost 方「你联系过的那条帖子已被确认归还」
//   - admin_action / report_resolved：治理动作的**回执**，不发通知就等于没治理
const (
	NotificationNewMatch         = "new_match"
	NotificationReturnSubmitted  = "return_submitted"
	NotificationReturnConfirmed  = "return_confirmed"
	NotificationReturnRejected   = "return_rejected"
	NotificationItemReturnedHint = "item_returned_hint"
	NotificationAdminAction      = "admin_action"
	NotificationReportResolved   = "report_resolved"
)
