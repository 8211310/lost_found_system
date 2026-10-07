// src/api/items.ts —— §4 的 items 一族。
//
// 片 2：#14 广场 #15 详情 #20 匹配 #21 解锁 #41 举报。
// 片 3：#13 发帖 #16 改帖 #17 删帖 #18 开关状态 #42 删单张图（发布/编辑页 + 详情页的作者操作）。
// 还没人调用所以还没写：#19 #22（在「我的」，片 4）。
// 「用到才建」不是为了少写代码，而是因为没人调用的函数会被读者当成预留，
// 等后面那片真要用时，没人能确定它是死的还是活的。
//
// 每条都写清鉴权，因为前端必须知道「匿名能不能读」：#14 #15 公开，其余全要登录。
import { deleteJSON, getJSON, patchJSON, postJSON, putJSON } from './client'
import type {
  ContactViewEntry,
  CreateItemPayload,
  CreateItemResult,
  ItemSummary,
  ItemView,
  MatchResult,
  Page,
  ReportReasonCode,
  ReportResult,
  StatusResult,
  UnlockResult,
  UpdateItemPayload,
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
 *  会让「这条链接分享出去是什么筛选状态」变得没法一眼看出来，而广场的 URL 是可直接分享的。
 *  导出来给 my.ts 用：#19 和 #14 走的是后端同一个 listQueryFrom，参数清洗必须同一份代码，
 *  两边各写一遍就会有一边漏掉空串。 */
export function buildQuery(q: object): Record<string, string | number> {
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

/** #13 POST /api/items（JWT）。
 *  ⚠ 写操作，而且它同时在后端触发匹配：lost 只算不写，found 会写台账并通知失主。
 *  所以它只能由「点提交」触发，绝不能出现在 useEffect 里。
 *  响应里的 matches_preview / notified_count 是**这一次**算出来的，没有任何 GET 能再取到，
 *  成功页必须把这份数据接过去（见 pages/PostResultPage.tsx 顶部那段）。 */
export function createItem(payload: CreateItemPayload): Promise<CreateItemResult> {
  return postJSON<CreateItemResult>('/api/items', payload)
}

/** #16 PUT /api/items/:id（JWT，本人或 Admin）。
 *  image_paths 一律不传（见 UpdateItemPayload 上那段：整组替换 + 响应不给 path = 客户端重建不出完整集合）。
 *  帖主改一条 found 帖会**重新触发匹配**（§3.7 那个「先随手发一条、后来改准」的例子），
 *  改一条 closed 的也一样，只是后端不会再叫醒任何人。 */
export function updateItem(id: number | string, payload: UpdateItemPayload): Promise<ItemView> {
  return putJSON<ItemView>(`/api/items/${id}`, payload)
}

/** #17 DELETE /api/items/:id（JWT，本人或 Admin）—— 软删，status→deleted，行还在库里。
 *  帖主删自己的帖子请求体可空，所以这里什么都不发。 */
export function deleteItem(id: number | string): Promise<null> {
  return deleteJSON<null>(`/api/items/${id}`)
}

/** #18 PATCH /api/items/:id/status（JWT，**仅帖主**，admin 也不行）。
 *  只有 open / closed 两个值：deleted 是治理动作（#43），不是社区表态。
 *  后端对「已经是这个状态」幂等返回成功，所以连点两次不该收到错误。 */
export function changeItemStatus(id: number | string, status: 'open' | 'closed'): Promise<StatusResult> {
  return patchJSON<StatusResult>(`/api/items/${id}/status`, { status })
}

/** #42 DELETE /api/item-images/:id（JWT，**仅帖主本人**）。
 *  这一条是**立刻生效**的：库里那行删了、磁盘文件也删了，和表单里其他字段保不保存无关。
 *  所以调用它的地方（编辑页）要在点下去之前就说清这一点，而不是等用户回去才发现图没了。 */
export function deleteItemImage(id: number): Promise<null> {
  return deleteJSON<null>(`/api/item-images/${id}`)
}

/** #22 GET /api/items/:id/contact-views（JWT，**发帖人 + admin**）—— 谁解锁过我的联系方式。
 *
 * 这一页存在的理由是定位原则 3：解锁**不是**认领，任何人都能来看、能来联系，
 * 所以平台能给发帖人的不是「锁」而是一份事后证据 —— contact_views 那行就是它。
 * 后端那条判据在 service/contact.go（`actor.ID != d.UserID && !actor.IsAdmin()` → FORBIDDEN），
 * 所以调用方必须先用 #15 的 author.id 判过身份，不该让普通访客点进一个必然 403 的地址。
 *
 * ⚠ 这是**读**操作，不写任何东西：读十次不会多出十行解锁记录（那是 #21 干的）。 */
export function getContactViews(
  id: number | string,
  page?: number,
  pageSize?: number,
): Promise<Page<ContactViewEntry>> {
  return getJSON<Page<ContactViewEntry>>(
    `/api/items/${id}/contact-views`,
    buildQuery({ page, page_size: pageSize }),
  )
}
