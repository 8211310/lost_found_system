// src/api/admin.ts —— 管理后台用到的十二条端点：#34–#37、#43–#46、#47–#50。
//
// 这一族的边界（定位原则 5 + §12 M6 那条 TestNoAdminCommunityRoutesExist）：
// **admin 能销毁内容和账号，但不能制造归属。** 所以这里没有、也永远不该出现
// 「admin 替发帖人确认归还」「admin 关帖」「admin 改匹配结果」那种函数 ——
// #46 删除一条归还确认是销毁，#25/#26 那两个推进流程的端点对 admin 一律 FORBIDDEN。
// 页面上任何「顺手帮 ta 点了吧」的冲动都会在这里变成一次编译期检查失败（因为函数根本不存在）。
//
// 鉴权全部由后端 router.go 的那个组兜住（jwt → RequireAdmin，role 每请求回库读一次），
// 所以前端这一层不判权限、不缓存身份，只做「把请求发对形状」。
//
// ⚠ 后端还有五条能力当前**没有** UI：#9–#12（字典增删，计划 §M7 只钉了五个页签，
// 而字典改名压根没有端点、走 Adminer）和 #39（GET /api/debug/config，
// 且它在生产环境里**这条路由压根不注册**，不是「返回 403 的端点」）。
// 按 items.ts 头上那条「用到才建」的约定，这里不给它们写没人调用的预留函数 ——
// 死函数会被读者当成活的契约，将来它悄悄改了也没人发现。
import { deleteJSON, getJSON, postJSON, putJSON } from './client'
import { buildQuery } from './items'
import { runeLen } from '../lib/runes'
import type {
  AdminActionName,
  AdminActionRow,
  AdminReportRow,
  AdminStats,
  AdminTargetType,
  AdminUserRow,
  Page,
  ReportReasonCode,
  ReportResolution,
  ReportStatus,
  ResolveReportResult,
  RestoreResult,
  SetRoleResult,
  SetStatusResult,
  TakedownResult,
  UserStatus,
  WarnResult,
} from './types'

/** 后端 service/adminlog.go:51 的 maxReasonLen。#35/#36/#43/#44/#47/#49 的 reason、
 *  #49 的 note 全都是这一个数，而且**数的是 trim 之后的 rune**。
 *  留痕那一列和通知内容那一列共用这个上限，所以「理由太长」永远不可能以「通知被截了」的形态出现。 */
export const MAX_REASON_RUNES = 500

/** #43 一次能提交多少条：后端 normalizeIDs 用的是**去重之前的原始长度**，
 *  所以前端这一关也必须按「我即将发出去几个 id」来算，不能先 Set 去重再比。 */
export const MAX_TAKEDOWN_IDS = 200

/** reason 的三道前端预检合成一句话：非空（trim 后）、不超 500 rune。
 *  返回空串表示可以发出去。后端对纯空白给的是 VALIDATION/reason，
 *  而这一页的按钮在理由为空时**必须先是禁用的**（计划 §M7 钉的那条），所以这个函数主要用来
 *  显示「还差什么」和拦超长，不是用来在点击之后弹错。 */
export function reasonProblem(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return '必须填写理由'
  const len = runeLen(trimmed)
  if (len > MAX_REASON_RUNES) return `理由最多 ${MAX_REASON_RUNES} 个字，当前 ${len} 个`
  return ''
}

export const ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: 'user', label: '普通用户' },
  { value: 'admin', label: '管理员' },
]

export const STATUS_OPTIONS: { value: UserStatus; label: string }[] = [
  { value: 'active', label: '正常' },
  { value: 'banned', label: '已封禁' },
]

/** #50 的两个筛选下拉用的表。值必须和后端 model.AdminActionValues() / TargetTypeValues() 逐个一致：
 *  这两个参数进的是 WHERE 而不是 INSERT，**拼错一个字母不报错，只是列表空了** ——
 *  管理员会以为「没人做过这件事」，而真实情况是他选了个不存在的选项。
 *  所以这里用白名单下拉而不是自由输入框，把这个坑变成选不出来。 */
export const ACTION_OPTIONS: { value: AdminActionName; label: string }[] = [
  { value: 'item_takedown', label: '下架帖子' },
  { value: 'item_restore', label: '恢复帖子' },
  { value: 'image_takedown', label: '删图片' },
  { value: 'return_takedown', label: '删归还确认' },
  { value: 'item_edit', label: '改他人帖子' },
  { value: 'user_ban', label: '封号' },
  { value: 'user_unban', label: '解封' },
  { value: 'user_role_change', label: '改角色' },
  { value: 'warning_sent', label: '发警告' },
  { value: 'report_resolved', label: '处置举报' },
  { value: 'dict_create', label: '新建字典条目' },
  { value: 'dict_delete', label: '删除字典条目' },
]

export const TARGET_TYPE_OPTIONS: { value: AdminTargetType; label: string }[] = [
  { value: 'item', label: '帖子' },
  { value: 'item_image', label: '图片' },
  { value: 'item_return', label: '归还确认' },
  { value: 'user', label: '用户' },
  { value: 'report', label: '举报' },
  { value: 'category', label: '分类' },
  { value: 'location', label: '地点' },
]

export const RESOLUTION_OPTIONS: { value: ReportResolution; label: string }[] = [
  { value: 'takedown', label: '下架这条帖子' },
  { value: 'ban', label: '封禁发帖的账号' },
  { value: 'dismiss', label: '驳回这条举报' },
]

/** #48 的三个举报状态。label 用「采纳 / 未采纳」而不是「成功 / 失败」——
 *  平台没有认定谁对谁错，只记录了管理员做了哪个动作。 */
export const REPORT_STATUS_LABEL: Record<ReportStatus, string> = {
  open: '待处理',
  resolved: '已采纳',
  dismissed: '未采纳',
}

/* ---------- #34–#37 用户与统计 ---------- */

/** #34 的筛选参数。四个都可选，空串一律不进 URL。
 *  ⚠ **默认包含被封禁的人**：后端没有「只看正常账号」那种默认值，
 *  所以这一页刚打开时看到的人里就可能有 banned —— 那是设计（找人时不能默认把人藏掉）。
 *  role / status 传不认识的枚举值给的是 VALIDATION（不是空列表），拼错能立刻知道。 */
export interface AdminUserListQuery {
  q?: string
  role?: string
  status?: UserStatus
  page?: number
  page_size?: number
}

/** #34 GET /api/admin/users（Admin）。排序 created_at DESC, id DESC（最新注册的人在最上面）。 */
export function listAdminUsers(q: AdminUserListQuery = {}): Promise<Page<AdminUserRow>> {
  return getJSON<Page<AdminUserRow>>('/api/admin/users', buildQuery(q))
}

/** #35 PUT /api/admin/users/:id/role。判据顺序是 reason → role → 「不能自降」。
 *  ⚠ 成功之后**零通知**（后端明写：改 role 不在 §3.7 那四种触发里，
 *  而他从后台入口消失/出现这件事本身就看得见）。页面上别写「已通知对方」。 */
export function setUserRole(id: number, role: string, reason: string): Promise<SetRoleResult> {
  return putJSON<SetRoleResult>(`/api/admin/users/${id}/role`, { role, reason })
}

/** #36 PUT /api/admin/users/:id/status。
 *  ⚠ 封号**立刻**让他手上那张旧 token 失效（middleware.JWT 每请求回库读 status），
 *  所以「先警告再封号」的顺序不能反着来 —— 封了之后他的 token 连读都读不到。
 *  ⚠ 没有封禁时长这个概念：整张 users 表没有任何到期列，封号 indefinite，只能由另一个 admin 解。
 *  ⚠ 两种方向都写一行 admin_action 通知，且**自己的账号状态改不了**（两个方向都是 FORBIDDEN）。 */
export function setUserStatus(id: number, status: UserStatus, reason: string): Promise<SetStatusResult> {
  return putJSON<SetStatusResult>(`/api/admin/users/${id}/status`, { status, reason })
}

/** #47 POST /api/admin/users/:id/warn。
 *  它是「封号之前那一步」：对他本人**零自动后果**（不扣分、不设限制），
 *  改变只有两样 —— notifications 多一行、admin_actions 多一行 `warning_sent`（§13 第 9 步在真实库里数出来的）。
 *  schema 里压根没有警告计数字段，所以页面上不许出现「已警告 3 次」。 */
export function warnUser(id: number, reason: string): Promise<WarnResult> {
  return postJSON<WarnResult>(`/api/admin/users/${id}/warn`, { reason })
}

/** #37 GET /api/admin/stats（无参数）。可能出错的只有鉴权三种 + INTERNAL。 */
export function getStats(): Promise<AdminStats> {
  return getJSON<AdminStats>('/api/admin/stats')
}

/* ---------- #43–#44 下架与恢复 ---------- */

/** #43 POST /api/admin/items/takedown（批量，ids 在**请求体**里）。
 *  判据顺序：reason → ids → 开事务 → 这批 id 是否都存在（有缺席的整批回滚，NOT_FOUND）。
 *  ⚠ 「一条都不许漏」和「一条都不许多」都靠这一条事务：挂在 /:id 下面逐条点 = 五十个独立事务，
 *  第 37 次失败时前三十六次已经生效了，所以这个端点的形状不会是单条。
 *  ⚠ taken_down=0 是幂等成功，不是错误。 */
export function takedownItems(ids: number[], reason: string): Promise<TakedownResult> {
  return postJSON<TakedownResult>('/api/admin/items/takedown', { ids, reason })
}

/** #44 POST /api/admin/items/:id/restore。
 *  ⚠ 状态不对（比如这条压根没被下架）给的 VALIDATION **字段名是 id**，不是 status ——
 *  后端把这一格当成「你指的那条帖子不对」来报，页面按 id 显示那句提示。
 *  ⚠ 恢复**不发任何通知**：被下架的人不会收到「你的帖子回来了」，
 *  所以这一页的成功提示不能写「已通知作者」。 */
export function restoreItem(id: number, reason: string): Promise<RestoreResult> {
  return postJSON<RestoreResult>(`/api/admin/items/${id}/restore`, { reason })
}

/* ---------- #48–#49 举报 ---------- */

/** #48 的筛选参数。
 *  ⚠ **后端没有「默认只看待处理」这一条**：不传 status 就是三种状态全给你。
 *  所以举报待办页必须自己带上 `status=open`，否则「待办」这个标题当天就成了假的。 */
export interface AdminReportListQuery {
  status?: ReportStatus
  reason_code?: ReportReasonCode
  page?: number
  page_size?: number
}

/** #48 GET /api/admin/reports（Admin）。排序 created_at DESC, id DESC ——
 *  ⚠ 那是**按时间**，不是按 `report_count_on_item`（那条帖子上还有几条待处理）。
 *  计划要求的「热度高的排前面」只能在拿到一页之后自己排，而且只在页内成立。 */
export function listAdminReports(q: AdminReportListQuery = {}): Promise<Page<AdminReportRow>> {
  return getJSON<Page<AdminReportRow>>('/api/admin/reports', buildQuery(q))
}

/** #49 的请求体：resolution + reason（必填）+ note（选填）。
 *  三者的分工是后端注释里说清的那件事：**reason 对被处置的人和留痕说话，note 对举报人说话**。
 *  所以 note 里不该有「被举报人是谁」，而 reason 会原样出现在对方收到的通知里。 */
export interface ResolveReportInput {
  resolution: ReportResolution
  reason: string
  note?: string
}

/** #49 POST /api/admin/reports/:id/resolve。校验顺序 reason → resolution → note。
 *  状态映射：takedown / ban → resolved，dismiss → dismissed（resolution 和 status 是两件事）。
 *  ⚠ 一次处置会**顺手关掉同一条帖子上其他所有待处理的举报**（detail.also_closed 列出它们），
 *  所以处置完一条，待办页少的不止一行 —— 提示文案要能容纳这个差数。
 *  ⚠ 留痕按动作数：takedown 2 行、ban 2 行、dismiss 1 行（连带的那件事排在前面）。
 *  ⚠ 已经处置过的再点一次是 409 REPORT_ALREADY_RESOLVED，**什么都不会再发生**。 */
export function resolveReport(id: number, input: ResolveReportInput): Promise<ResolveReportResult> {
  return postJSON<ResolveReportResult>(`/api/admin/reports/${id}/resolve`, input)
}

/* ---------- #50 操作日志 ---------- */

/** #50 的筛选参数。四个都可填可填不填。
 *  ⚠ **一个都不筛就是全站所有治理动作**，这里没有「只看我自己做的」那种默认值
 *  （handler/admin.go:501-506 明写：那种默认会把这本账变成自我备忘）。
 *  ⚠ admin_id / target_id 传 `0` 是 VALIDATION 而不是「不筛」：后端 parseIDParam 要求 n>0；
 *  想不筛就**别把这个键放进 query**（buildQuery 会丢掉空串，所以页面用空串表示不筛）。 */
export interface AdminActionListQuery {
  admin_id?: number
  target_id?: number
  target_type?: AdminTargetType
  action?: AdminActionName
  page?: number
  page_size?: number
}

/** #50 GET /api/admin/actions（只读：这条路径上没有 tx、没有留痕的留痕、没有通知）。
 *  整个 repo 对这个表**只有读方法**，唯一的写入点是 service/adminlog.Record ——
 *  「日志只追加、不改写」是它能当证据的前提。 */
export function listAdminActions(q: AdminActionListQuery = {}): Promise<Page<AdminActionRow>> {
  return getJSON<Page<AdminActionRow>>('/api/admin/actions', buildQuery(q))
}

/** #45 DELETE /api/admin/item-images/:id（请求体带 reason，空 body 会被 bindJSON 判 VALIDATION）。
 *  ⚠ 这是**硬删除**：库里那行没了、磁盘上那张文件也删了，而且**帖子本身还在广场上**。
 *  所以它不是「下架的轻量版」，是「图片没了但这条帖子还有效」。通知发给帖子作者，
 *  文案明说了「帖子本身没有被下架」；前端不许把它显示成一种可逆操作。 */
export function adminDeleteItemImage(id: number, reason: string): Promise<null> {
  return deleteJSON<null>(`/api/admin/item-images/${id}`, { reason })
}

/** #46 DELETE /api/admin/returns/:id —— 销毁一条归还确认记录。
 *  ⚠ **这条路径上没有 confirm / reject**：admin 能删掉这一行，但推进不了社区流程，
 *  这正是「能销毁、不能制造归属」在接口层的样子，别在这里加任何按 role 的分支去「方便管理员」。
 *  硬删除 + 通知**只发给提交人**（发帖人不收，因为他那条记录本来就是他自己的判断范围）；
 *  积分一点不动，帖子状态也一点不动。第二次删同一条是 NOT_FOUND。 */
export function adminDeleteReturn(id: number, reason: string): Promise<null> {
  return deleteJSON<null>(`/api/admin/returns/${id}`, { reason })
}
