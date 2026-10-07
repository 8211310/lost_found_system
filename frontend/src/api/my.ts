// src/api/my.ts —— 「我的」那一族：路径全在 /api/my/ 下面，全部要 JWT。
//
// 这一族的共同点是**收件人永远来自 JWT，不来自参数**：#19 不能 ?user_id=、
// #33 也一样（后端 credit.go 的注释把这条写成「这张表里躺着的是谁在什么时候
// 因为哪条归还确认加了几分，让它能被 ?user_id= 指定就是全站最大的个人记录泄漏面」）。
// 所以这里没有任何一个函数接受 userId —— 不是没想到，是那条纪律。
//
// 本片只用得上 #19 和 #33。#30/#31/#32（通知）在片 5 和归还确认流一起做：
// 通知里带 return_id 的那几条，点开的目标是归还详情页，那一页还没有的时候
// 先把通知列表建出来等于给用户一堆点不开的条目。
import { getJSON } from './client'
import { buildQuery } from './items'
import type { CreditHistory, ItemSummary, Page } from './types'

/** #19 GET /api/my/items 的筛选参数。
 *  和 #14 是同一套键，**但 status 多一个 'deleted'**：广场的状态白名单
 *  （item_validate.go 的 publicListStatus）只允许 open/closed，治理信息不进公开响应；
 *  而「我自己删掉的、以及被下架的那些」正是这一页要回答的问题。 */
export interface MyItemListQuery {
  item_type?: 'lost' | 'found'
  keyword?: string
  category_id?: number
  location_id?: number
  status?: 'open' | 'closed' | 'deleted'
  sort?: 'created_at' | 'lost_at' | 'found_at'
  page?: number
  page_size?: number
}

/** #19 GET /api/my/items（JWT）。
 *  两条和 #14 的可见差别，都由后端保证：
 *  ① 这里的 contact **一律有值**（都是自己的帖子，#14 那种「found 帖恒为 null」不适用）；
 *  ② 只有这一个列表会带 `removal` —— 「为什么不见了」那句话需要一个不会被新消息
 *     翻过去的落点，见 ItemSummary.removal 上那段。 */
export function listMyItems(q: MyItemListQuery = {}): Promise<Page<ItemSummary>> {
  return getJSON<Page<ItemSummary>>('/api/my/items', buildQuery(q))
}

/** #33 GET /api/my/credit-logs（JWT）。
 *  返回的不是 Page[T]，是多带一个 credit_score 的 CreditHistory；那个数是**现读**的当前分，
 *  不是流水求和（见 CreditHistory 上那段：所以页面不许写「以下合计」）。 */
export function getCreditLogs(page?: number, pageSize?: number): Promise<CreditHistory> {
  return getJSON<CreditHistory>('/api/my/credit-logs', buildQuery({ page, page_size: pageSize }))
}
