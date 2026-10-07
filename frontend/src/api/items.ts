// src/api/items.ts —— §4 的 #14 #15 #20 #21 #41（M7 片 2：广场、详情、匹配、解锁、举报）。
//
// 只写这一片用得到的。#13/#16/#17/#18/#19/#22/#42/#6 也早就实现好了，但它们要么属于后面那片 UI
// （#19/#22 在「我的」，片 4），要么还没有对应的入口（#16/#17/#18/#42/#6 在发布编辑页，片 3）。
// 现在建函数就是建死代码 —— 加了之后没人调用，等到真用时读者无法判断它是预留还是用过。
// 每条都写清鉴权，因为前端必须知道「匿名能不能读」：#14 #15 公开，其余全要登录。
import { getJSON, postJSON } from './client'
import type {
  ItemSummary,
  ItemView,
  MatchResult,
  Page,
  ReportReasonCode,
  ReportResult,
  UnlockResult,
} from './types'

/** #14 的筛选参数。全部可选 —— 空串/undefined 一律不拼进 URL，
 *  因为后端把「空串」和「不传」当成同一件事（parseIDParam 里 TrimSpace 后 == "" 就返回 nil）。 */
export interface ItemListQuery {
  item_type?: 'lost' | 'found'
  keyword?: string
  category_id?: number
  location_id?: number
  /** 广场只允许 open / closed（后端 publicListStatus.Allowed），deleted 一律拒绝。
   *  所以这里的类型是这两个字面量而不是 string：传错会在编译期红，而不是运行时收到 VALIDATION。 */
  status?: 'open' | 'closed'
  sort?: 'created_at' | 'lost_at' | 'found_at'
  page?: number
  page_size?: number
}

/** buildQuery 把 undefined、null 和空串统一滤掉。
 *  axios 只跳 undefined，空串会被序列化成 `&keyword=`；后端能吃，但 URL 里挂一堆空参数
 *  会让「这条链接分享出去是什么筛选状态」变得没法一眼看出来，而广场的 URL 是可直接分享的。 */
function buildQuery(q: ItemListQuery): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue
    out[k] = v as string | number
  }
  return out
}

/** #14 GET /api/items（公开）。
 *  found 帖的 contact 恒为 null —— 后端**不看是谁在查**，所以这一条完全可缓存。 */
export function listItems(q: ItemListQuery = {}): Promise<Page<ItemSummary>> {
  return getJSON<Page<ItemSummary>>('/api/items', buildQuery(q))
}

/** #15 GET /api/items/:id（公开，但后端挂 OptionalJWT：认得出身份就多给一点）。
 *  contact 是否出现由后端判（本人 / 已解锁 / lost 帖公开），前端只读 contact_locked。 */
export function getItem(id: number | string): Promise<ItemView> {
  return getJSON<ItemView>(`/api/items/${id}`)
}

/** #20 GET /api/items/:id/matches（JWT，本人或 Admin）。
 *  非本人会拿到 FORBIDDEN，所以调用方（详情页）先判身份再决定要不要渲染这个入口。 */
export function getMatches(id: number | string, top?: number): Promise<MatchResult> {
  return getJSON<MatchResult>(`/api/items/${id}/matches`, top ? { top } : undefined)
}

/** #21 POST /api/items/:id/unlock-contact（JWT）。
 *  ⚠ 这是**写**操作：它往 contact_views 落一行，那是 §3.4 说的「骚扰的唯一事后证据」。
 *  所以它只能由真实点击触发，绝不能放进 useEffect、预取或路由数据加载里。 */
export function unlockContact(id: number | string): Promise<UnlockResult> {
  return postJSON<UnlockResult>(`/api/items/${id}/unlock-contact`)
}

/** #41 POST /api/items/:id/report（JWT）。
 *  后端只有一条 INSERT：不下架、不扣分、不通知被举报人。
 *  所以这里的返回类型里没有任何「处理进度」字段，前端也不许自己编一个。 */
export function reportItem(id: number | string, reason: ReportReasonCode, detail = ''): Promise<ReportResult> {
  return postJSON<ReportResult>(`/api/items/${id}/report`, { reason_code: reason, detail })
}
