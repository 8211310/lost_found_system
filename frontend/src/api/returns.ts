// src/api/returns.ts —— 归还确认流 #23–#29。
//
// 这一族是全系统立场最强的一段：**归属只能由发帖人产生，admin 也不行**
// （#25/#26 上 admin 拿到的是 FORBIDDEN，router.go:252-255 写明这是「全系统唯一 admin 也不行」
// 的两条，并且不许在这里加任何按 role 的分支去「方便管理员」）。
// 所以前端在这一族的职责不是帮谁判断真假，而是：把事实摆给发帖人看，然后记下他做了什么。
//
// 措辞纪律（后端 TestNoticeCopyMakesNoPlatformPromise 用禁词表钉着：归还成功 / 已归还给你 /
// 已关闭 / 这就是 / 判定）同样约束前端的每一句文案。我们只说「某人做了某事」。
import { getJSON, postJSON } from './client'
import { buildQuery } from './items'
import type {
  CancelReturnResult,
  ConfirmReturnResult,
  DecideReturnResult,
  Page,
  ReturnDetailView,
  ReturnEntry,
  ReturnStatus,
  SubmitReturnResult,
} from './types'

/** #23 的请求体。两个键都是必填。
 *
 * ⚠ `proof_image_path` 要的是 #6 响应里的 **path**（形如 `2026/10/<32位hex>.jpg`），
 *  不是页面上那个以 /uploads 开头的 url —— 和发帖时 image_paths 同一条规则、同一个后端校验函数
 *  （service.IsUploadPath）。填错的话后端给 VALIDATION，字段名就写着 proof_image_path。
 * ⚠ `message` 的长度是**按字（rune）数**算的 5–1000，一个汉字算一个；
 *  用 JS 的 `str.length` 预检会把中文算成 1，虽然结果一样，但代理对（emoji）会算成 2 ——
 *  所以这里的前端预检故意只做「非空」，长度交给后端判，避免两边算法不一致时前端先拦错。 */
export interface SubmitReturnPayload {
  message: string
  proof_image_path: string
}

/** #28 / #29 的筛选参数。
 *  ⚠ 这里**没有** userId / itemId：后端明写收件人永远取自 JWT（handler/item_return.go:192-200
 *  连 ?user_id= 都不读）。#29 过滤的是「我发的帖子收到的确认」，条件在 items.user_id 上，
 *  不是 item_returns 上的某一列 —— 这解释了为什么我提交的和我收到的是两套完全不同的行。 */
export interface MyReturnListQuery {
  status?: ReturnStatus
  page?: number
  page_size?: number
}

/** #23 POST /api/items/:id/returns（JWT，**任何登录用户**，不需要先解锁过联系方式）。
 *
 * 三条只有读源码才知道的判据顺序（service/item_return.go:204-210 自己列了①–⑤）：
 * ① 字段校验 → ② 帖子存在且**没被软删**（deleted 给 NOT_FOUND）→ ③ 必须是 found 帖
 * （对 lost 帖调用给的是 **VALIDATION** 而不是 NOT_FOUND）→ ④ 不能给自己（RETURN_SELF，
 * 判在 open 之前）→ ⑤ 帖子必须 open（ITEM_CLOSED）。
 * ⚠ RETURN_DUPLICATE 的唯一索引是 (item_id, submitter_id) WHERE status='pending'，
 * **不是按帖子**：同一条帖子可以同时有好几个人各自一条 pending。所以「有人提交了」
 * 不等于「我提交不了了」，列表上出现多条 pending 是正常状态。 */
export function submitReturn(itemId: number | string, payload: SubmitReturnPayload): Promise<SubmitReturnResult> {
  return postJSON<SubmitReturnResult>(`/api/items/${itemId}/returns`, payload)
}

/** #24 GET /api/returns/:id（JWT，读者=提交人 / 发帖人 / admin，外人拿 FORBIDDEN 而不是 NOT_FOUND）。
 *
 * 这是**唯一**能拿到 message 和 proof_image_url 的地方（列表行里没有），
 * 所以发帖人要判断就得先进这一页 —— 那不是啰嗦，是「列表是索引，详情才是判断现场」。
 * 帖子被删/被下架**不影响**这一页读到。 */
export function getReturn(id: number | string): Promise<ReturnDetailView> {
  return getJSON<ReturnDetailView>(`/api/returns/${id}`)
}

/** #25 POST /api/returns/:id/confirm（**仅发帖人，admin 也 FORBIDDEN**）。
 *
 * `owner_note` 可选：后端用 bindJSONOptional 解析，空 body、缺键、空串都合法（全项目就这一处非 DELETE 用它）。
 * 判据顺序是 记录 → 帖子 → **权限 → 状态迁移 → 字段**，权限排在字段之前，
 * 所以一个非发帖人写了超长备注时拿到的是 FORBIDDEN，不是 VALIDATION。
 * 副作用（同一事务）：pending→confirmed、帖子 open→closed、发帖人 +10 / 提交人 +2（封顶 200）、
 * 给提交人插 return_confirmed、给匹配台账里每个失物作者插 item_returned_hint。 */
export function confirmReturn(id: number | string, ownerNote = ''): Promise<ConfirmReturnResult> {
  return postJSON<ConfirmReturnResult>(`/api/returns/${id}/confirm`, { owner_note: ownerNote })
}

/** #26 POST /api/returns/:id/reject（**仅发帖人，admin 也 FORBIDDEN**）。
 *
 * ⚠ 和 #25 相反的必填：这条用严格 bindJSON，**空 body 就是 VALIDATION**，
 * 纯空白的备注也一样被拒（service 里 normalizeOwnerNote(raw, true)）。
 *  asymmetry 是故意的 —— 「我不同意」这句话必须留下为什么。
 * 副作用：**只有**一行记录状态 + 给提交人一条 return_rejected。
 * 不关帖子、不扣分、不拦着对方重新提交。页面上任何「拒绝之后会怎样」的承诺都得停在这个范围里。 */
export function rejectReturn(id: number | string, ownerNote: string): Promise<DecideReturnResult> {
  return postJSON<DecideReturnResult>(`/api/returns/${id}/reject`, { owner_note: ownerNote })
}

/** #27 POST /api/returns/:id/cancel（**仅提交人**）。
 *
 * 后端连 body 都不读（对比 #25 的 bindJSONOptional），所以这里第二个参数都没有。
 * 它**不查 items 表**，所以帖子被下架、被关掉都拦不住我撤销自己那条 ——
 * 「我不再主张了」这件事不需要帖子还在。零副作用、零通知。 */
export function cancelReturn(id: number | string): Promise<CancelReturnResult> {
  return postJSON<CancelReturnResult>(`/api/returns/${id}/cancel`)
}

/** #28 GET /api/my/returns/submitted —— 我提交给别人的那些。 */
export function listMySubmittedReturns(q: MyReturnListQuery = {}): Promise<Page<ReturnEntry>> {
  return getJSON<Page<ReturnEntry>>('/api/my/returns/submitted', buildQuery(q))
}

/** #29 GET /api/my/returns/received —— 别人提交给我的、需要我判断的那些。
 *  pending 的条数就是「我还欠几个判断」，这一页是发帖人的待办清单。 */
export function listMyReceivedReturns(q: MyReturnListQuery = {}): Promise<Page<ReturnEntry>> {
  return getJSON<Page<ReturnEntry>>('/api/my/returns/received', buildQuery(q))
}
