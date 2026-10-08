// src/api/notifications.ts —— 通知中心 #30 / #31 / #32。
//
// 编号以计划 §4 行 767-769 和后端代码为准：**#31 是未读数、#32 是标记已读**
// （handler/notification.go:51 的 UnreadCount 处理 #31，:61 的 MarkRead 处理 #32）。
//
// 这一族是**只读**的：NotificationStore 接口里没有 Insert/Push/Create
// （service/notification.go:40-42 明写那是「只读通知」的类型层面证据），
// 所以前端不可能造出一条通知，也不可能改别人的通知。
import { getJSON, putJSON } from './client'
import { buildQuery } from './items'
import type { NotificationView, Page } from './types'

export interface MyNotificationListQuery {
  /** 三态：不填=全部，true=只看已读，false=只看未读。
   *  ⚠ 后端只认字符串 'true'/'false'（大小写不敏感），`1`/`0`/`yes`/`no` 一律 VALIDATION
   *  （service/notification.go:141-157）。所以这里必须转成 String 再进 query，
   *  而 false **不能**被当成「没填」丢掉 —— 只看未读正是这一页的主用法。 */
  is_read?: boolean
  page?: number
  page_size?: number
}

/** #30 GET /api/my/notifications（JWT）。排序 created_at DESC, id DESC。
 *  行的跳转规则见 NotificationView 上那段：type 不足以决定点去哪，得看 return_id / item_id。 */
export function listMyNotifications(
  q: MyNotificationListQuery = {},
): Promise<Page<NotificationView>> {
  return getJSON<Page<NotificationView>>(
    '/api/my/notifications',
    buildQuery({
      is_read: q.is_read === undefined ? undefined : String(q.is_read),
      page: q.page,
      page_size: q.page_size,
    }),
  )
}

/** #31 GET /api/my/notifications/unread-count（JWT，无参数）。
 *  能出错的只有 UNAUTHORIZED / USER_BANNED / INTERNAL —— 没有 VALIDATION 可做。
 *  ⚠ 它数的是 `WHERE user_id=$1 AND is_read=false`，和 #30 的 ?is_read=false 是同一件事的
 *  两种读法；这一条没有分页，所以「99+」那种显示只能靠猜，别拿 count 去断言列表有几行。 */
export function getUnreadCount(): Promise<{ count: number }> {
  return getJSON<{ count: number }>('/api/my/notifications/unread-count')
}

/** #32 的请求体：**二选一，而且必须选一个**。
 *
 * 后端两个字段都是指针（`ids *[]int64`、`all *bool`），指针性本身就是防越权的机制：
 * 如果用值类型，`{"all": false}` 就会被读成「没填 all」而落到「全标已读」那条路上去
 * —— 那是一个人一键把别人的通知全标掉的入口。所以这里的构造函数只许产出两种 body：
 * 要么只有 ids，要么只有 {"all":true}，**永远不许发 all:false、永远不许发空 ids**。
 * 两条禁令都写在返回类型上，不靠调用方自觉。 */
export type MarkReadInput = { ids: number[] } | { all: true }

/** ids 的上限，后端 service/notification.go:36 的 maxMarkReadIDs。超过就是 VALIDATION。 */
export const MAX_MARK_READ_IDS = 200

/** #32 PUT /api/my/notifications/read（JWT）。注意是带 body 的 PUT，不是 POST /:id/read。
 *  判据顺序 ① 形状 → ② 归属 → ③ 执行：形状不对**一次库都不查**。
 *  归属那条 FORBIDDEN（「有不属于当前用户的通知」）在 UPDATE 之前，
 *  而真正的边界是 repo 里那句 WHERE user_id=$1。all=true 时跳过归属查询。
 *  ⚠ updated_count 数的是**真的从 false 翻成 true 的行数**，不是提交上去的 id 个数 ——
 *  同样一批 id 连点两次，第二次是 0。页面上「已标记 N 条」只能用这个数，别用选择数。
 *  ⚠ **已读不可逆**：整个 router.go 里没有「标为未读」这条路由，所以任何「全部已读」
 *  都得是点了才生效、且事先说清它不撤回。 */
export function markNotificationsRead(input: MarkReadInput): Promise<{ updated_count: number }> {
  return putJSON<{ updated_count: number }>('/api/my/notifications/read', input)
}
