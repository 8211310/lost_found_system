// src/api/types.ts —— 后端响应的形状。
//
// 每个 interface 的字段名都逐个照抄 backend/internal/model/*.go 里的 `json:"..."` tag，
// 而不是照计划正文的转述 —— 正文是给人读的，会滞后；tag 是真实出口。
// 对不上的情况由 src/api/contract.live.test.ts（打通着后端）发现。

/** §8 统一信封。成功和失败共用这一个形状，所有成功都是 HTTP 200。 */
export interface Envelope<T> {
  code: string
  message: string
  data: T
  request_id: string
}

/** apperr.FieldError：校验失败时放在 data.errors 里，是数组不是 map。 */
export interface FieldError {
  field: string
  msg: string
}

/** model.UserView —— #3 GET /api/auth/me 的 data，**11 个字段，不多不少**。
 * 后端把 NULL 一律折成空串，所以这里全是 string，不需要判 null。 */
export interface UserView {
  id: number
  username: string
  nickname: string
  real_name: string
  role: string
  auth_source: string
  phone: string
  email: string
  avatar_url: string
  credit_score: number
  created_at: string
}

/** #2 POST /api/auth/login 的 data */
export interface LoginResult {
  token: string
  expires_at: string
  user: UserView
}

/** #1 POST /api/auth/register 的 data —— 只有 4 个字段，而且**不含 token**，
 * 所以注册完必须再走一次登录，前端不要指望这里能直接进登录态。 */
export interface RegisterResult {
  id: number
  username: string
  nickname: string
  role: string
}

/** #38 GET /api/health 的 data */
export interface Health {
  status: string
  db: string
  version: string
  time: string
}

/** §4 分页约定：?page=1&page_size=20 → {list,total,page,page_size} */
export interface Page<T> {
  list: T[]
  total: number
  page: number
  page_size: number
}

/** #7 GET /api/categories 的树节点（两级） */
export interface CategoryNode {
  id: number
  name: string
  level: number
  sort_order: number
  children: CategoryNode[]
}

/** #8 GET /api/locations 的树节点（三级），比分类多一个 is_freeform */
export interface LocationNode {
  id: number
  name: string
  level: number
  is_freeform: boolean
  sort_order: number
  children: LocationNode[]
}

/** #9/#11 的 data：刚建出来的那一行（service.DictResult）。
 *  ⚠ 没有 sort_order，也没有「第几级以下不能再挂」以外的任何回显 —— 想立刻看到新条目
 *  只能重读 #7/#8，而这一片就是靠重读刷新的。
 *  parent_id 是 null 而不是缺键：一级条目**没有**父节点，和「父节点 id 是 0」是两件事。 */
export interface DictResult {
  id: number
  name: string
  level: number
  parent_id: number | null
}

/** #39 GET /api/debug/config 的 data —— 后端 config.Redacted() 那份打码后的运行时配置。
 *  ⚠ 敏感那几列到这里时已经是 `"***"` 或 `"(未配置)"`，前端**不需要**也不该再打码，
 *  但也不许把整包原样打印到控制台或写进任何日志：打码只有一份出口，多一份就多一份失误机会。
 *  ⚠ 匹配那四个参数**全都在**这份 map 里（时间容差是 2026-10-08 后端补上的第 18 个键）。
 *  所以这一页少显示一个数，就是前端这张表的漏项，不是后端没吐 —— DebugTab 的
 *  「还没归组」那一栏就是用来兜住这件事的。 */
export interface DebugConfig {
  env: string
  port: string
  log_level: string
  db_host: string
  db_port: string
  db_user: string
  db_name: string
  db_password: string
  jwt_secret: string
  jwt_expire_hours: number
  upload_dir: string
  match_time_tolerance_hours: number
  match_notify_threshold: number
  match_show_threshold: number
  match_decay_days: number
  hduhelp_app_id: string
  hduhelp_app_secret: string
  sso_state_key: string
}

/** model.RefView —— 详情里字典条目的嵌套形状（{id, name}），不是平铺两列。 */
export interface RefView {
  id: number
  name: string
}

/** model.AuthorView —— ⚠ 只有 id 和 nickname。
 *  后端刻意不带 real_name 和 credit_score：#15 是公开接口，未登录也能读。 */
export interface AuthorView {
  id: number
  nickname: string
}

/** model.ImageView。id 必须在：#42 帖主自删单张图片走的就是它。 */
export interface ImageView {
  id: number
  url: string
  sort_order: number
}

/** model.RemovalView —— 「这条帖子为什么不见了」里**能给作者看**的那部分。
 *
 * 它不是 items 表上的列，是读的时候从 admin_actions 那本登记簿现查的（所以只有 #19
 * 和作者本人的 #15 会填，#14 广场永远不带）。三个键之外后端刻意不放三样东西：
 * **操作者的身份**（把具体的人暴露给被处置者，治理纠纷就变成私人恩怨）、
 * **举报条数**（会被拿去猜是谁举报的）、**举报人是谁**（举报对被举报者匿名是前提）。
 * 所以前端在这里连「是谁下架的」都无从显示 —— 那不是漏做，是那条禁令。
 * action_id 是给作者报修用的编号，页面上要原样给出来。 */
export interface RemovalView {
  action_id: number
  reason: string
  created_at: string
}

/** #6 POST /api/uploads 的 data —— 也是发帖时 image_paths 里该放的东西。
 *
 * ⚠ 提交给 #13/#16 的是 **path**，不是 url。后端 service.IsUploadPath 只对 path 那种
 * `2026/10/<随机>.jpg` 形状做白名单，把 `/uploads/...` 原样传过去会被判 FILE 路径不合法。
 * url 只用来显示（它由 baseURL + path 现拼，_item_images 里存的是 path_）。 */
export interface StoredImage {
  path: string
  url: string
}

/** ItemFields —— #13 和 #16 共用的那 9 个字段，键名照抄 handler 那两个请求体。
 *  时间一律 RFC3339：`<input type="datetime-local">` 给的是「2026-10-07T15:04」，
 *  缺秒和时区，直接送后端会吃 VALIDATION（后端注释里明确拒绝宽容解析，见 lib/time.ts）。 */
export interface ItemFields {
  title: string
  description: string
  category_id: number
  location_id: number
  location_detail: string
  last_seen_at: string
  lost_at: string
  found_at: string
  contact: string
}

/** #13 POST /api/items 的请求体 = 那 9 个字段 + 类型 + 可选图片。 */
export interface CreateItemPayload extends ItemFields {
  item_type: 'lost' | 'found'
  image_paths?: string[]
}

/** #16 PUT /api/items/:id 的请求体 = 同 #13 但**没有 item_type**（改帖不能改类型）。
 *
 * ⚠ image_paths 在这里是「整组替换」：字段缺失 = 不动图片，传 [] = 全删。
 * 而 #15 的 ImageView 只有 {id,url,sort_order}，**不把 path 告诉前端**，
 * 所以客户端无法重建「原有那几张 + 新加一张」这个完整集合 —— 一改就会把已有的图删掉。
 * 结论：编辑模式一律不发这个字段，删单张走 #42（它认 id），加图只能重新发帖。 */
export interface UpdateItemPayload extends ItemFields {
  image_paths?: string[]
  /** 仅 admin 改别人的帖子时必填；帖主改自己的什么都不用带。片 3 的入口只给帖主，所以不会出现。 */
  admin_reason?: string
}

/** #13 的 data。两个键按 item_type **互斥**（service 里是指针 + omitempty）：
 *  lost 只带 matches_preview（哪怕空数组也必须出现），found 只带 notified_count。
 *  所以成功页该显示哪一套由「我刚发的是哪种帖」决定，不需要去猜响应里有没有某个键。 */
export interface CreateItemResult {
  item: ItemView
  matches_preview?: MatchHit[]
  notified_count?: number
}

/** #18 PATCH /api/items/:id/status 的 data。 */
export interface StatusResult {
  id: number
  status: string
}

/** #15 GET /api/items/:id 的 data，也是 #13/#16 响应里 item 字段的形状。
 *
 * contact 是 `string | null` 而不是空串：后端用指针表示「锁着」，
 * null 就是没给。前端只靠 contact_locked 一个字段决定这块 UI 长什么样。 */
export interface ItemView {
  id: number
  item_type: string
  title: string
  description: string
  status: string
  category: RefView
  location: RefView
  location_detail: string
  last_seen_at: string
  lost_at: string
  found_at: string
  contact: string | null
  contact_locked: boolean
  images: ImageView[]
  author: AuthorView
  created_at: string
  updated_at: string
  /** 同 ItemSummary.removal：后端 omitempty，只有**作者本人**读到已下架的帖子时才有。
   *  外人读同一条拿到的是 NOT_FOUND，所以详情页不需要考虑「别人看到这块」。 */
  removal?: RemovalView
}

/** model.ItemSummary —— #14 广场、#19 我的发布、#20 匹配结果、#24/#28/#29 共用的摘要形状。
 *  和 ItemView 的区别：没有 description、没有 images 数组（只有 cover_image 一张）、没有 updated_at。
 *  「列表页拿不到 description」本身就是契约，不要在列表里补一次详情请求来绕开它。 */
export interface ItemSummary {
  id: number
  item_type: string
  title: string
  status: string
  category_id: number
  category_name: string
  location_id: number
  location_name: string
  lost_at: string
  found_at: string
  contact: string | null
  cover_image: string
  author_id: number
  author_name: string
  created_at: string
  /** 只有 #19 我的发布在 status=deleted 的那几行上出现（后端 omitempty）。
   *  判据是「这条已经被下架了，作者有权知道为什么」，不是「列表刚好顺手带了」——
   *  所以广场（#14）的筛选白名单里压根没有 deleted，那个响应永远不带这个键。 */
  removal?: RemovalView
}

/** matcher.CategorySignal —— #20 breakdown 里的分类那一路。
 *  same_leaf 是「连小类都一样」，false 而 score 仍 >0 就是「同大类不同小类给的那半分」。 */
export interface CategorySignal {
  weight: number
  score: number
  same_leaf: boolean
}

/** matcher.TextSignal。两个 dice 单独摊开是这套 breakdown 作为「调试器」的核心价值：
 *  分数低的时候一眼能看出是标题不像还是描述没写。 */
export interface TextSignal {
  weight: number
  score: number
  title_dice: number
  desc_dice: number
}

/** matcher.TimeSignal。
 *  ⚠ days_after_lost_at 单独看不足以判断方向：matcher 在「捡到时间早于 last_seen_at」
 *  （重罚那一档）和「晚于 lost_at 但不到一天」（几乎不罚）两种相反的情况下都会回
 *  in_loss_window=false + days=0。所以展示这句话要看 score 之外的字段组合，
 *  只有 days>0 才敢说是「晚于」—— 见 components/MatchPanel.tsx 的 timeNote。 */
export interface TimeSignal {
  weight: number
  score: number
  in_loss_window: boolean
  days_after_lost_at: number
}

/** matcher.LocationSignal。matched_by 说清是哪一档命中的：
 *  same_leaf / same_second / same_top / detail_text。 */
export interface LocationSignal {
  weight: number
  score: number
  matched_by: string
}

/** matcher.Signals。
 *  ⚠ location 是**可选**的，而且原因不是「后端可能忘了给」：
 *  Tier 1 里地点是 SQL 层的硬条件（叶子必须能比），不进打分，所以 breakdown 只有三个信号；
 *  Tier 2（地点选了「其他」那类没有叶子可比的情况）地点降级成排序信号，才多出一路 0.15。
 *  于是「有没有 location 这一路」本身就是「这次是哪一档匹配」的可见证据，别用它做兜底判断。 */
export interface Signals {
  category: CategorySignal
  text: TextSignal
  time: TimeSignal
  location?: LocationSignal
}

/** matcher.Breakdown —— §5.7 那个对象，「响应里看到的分数」和「台账里记的分数」同源。 */
export interface Breakdown {
  score: number
  tier: number
  signals: Signals
}

/** service.MatchHit —— #20 列表的元素，也是 #13 响应里 matches_preview 的元素。 */
export interface MatchHit {
  item: ItemSummary
  score: number
  breakdown: Breakdown
}

/** #20 GET /api/items/:id/matches 的 data。
 *  notice 只在 Tier 2 出现（后端 omitempty），那是「为什么这次只能宽松匹配」的人话解释。 */
export interface MatchResult {
  tier: number
  notice?: string
  list: MatchHit[]
}

/** #21 POST /api/items/:id/unlock-contact 的 data。
 *  already_unlocked=true 表示这次没有新增记录，只是把他已经看过的东西再给他一次。 */
export interface UnlockResult {
  contact: string
  unlocked_at: string
  already_unlocked: boolean
}

/** #41 POST /api/items/:id/report 的 data。
 *  status 恒为 "open"：它是「这条举报现在等着 admin 看」这个事实，不是处置进度。
 *  前端**不要**把它渲染成「处理中」之类的进度条 —— 平台没有承诺任何后续。 */
export interface ReportResult {
  id: number
  status: string
  created_at: string
}

/** model.ReportReasonCodes 的镜像，顺序和迁移里的 CHECK 一致。
 *  值是机器码（发给后端），label 才是给人看的中文 —— 两者永远分开设，
 *  这样后端改文案不会改到请求体。 */
export const REPORT_REASONS = [
  { value: 'spam', label: '刷屏广告' },
  { value: 'privacy', label: '泄露他人隐私' },
  { value: 'fraud', label: '冒领或虚假信息' },
  { value: 'harassment', label: '骚扰' },
  { value: 'illegal', label: '违法违规内容' },
  { value: 'other', label: '其他' },
] as const

export type ReportReasonCode = (typeof REPORT_REASONS)[number]['value']

/** model.UnlockerView —— #22 名单里「一个人」的形状。
 *
 * ⚠ `real_name` 是**全项目唯一**出现在对外响应里的地方，就这一份，而且读者被限死成
 * 发帖人和 admin（`contact.go` 那句 `actor.ID != d.UserID && !actor.IsAdmin()` 就挡这个）。
 * AuthorView 刻意没有它，因为 #15 是公开接口；这里能带是因为「谁解锁过我的联系方式」
 * 本来就是「你确实需要知道对方是谁」的场合。前端不许把它抄到别的地方去显示。 */
export interface UnlockerView {
  id: number
  nickname: string
  real_name: string
}

/** #22 GET /api/items/:id/contact-views 的 list 元素。
 *  外层 id 是 contact_views 的行 id，不是用户 id —— 留着是为了让这份名单可引用
 *  （「第 37 行那次」比「第三个人」精确），不是为了跳转。 */
export interface ContactViewEntry {
  id: number
  user: UnlockerView
  created_at: string
}

/** model.CreditLogView —— #33 流水里的一条。
 *  ref_type / ref_id 是 `string | null` / `number | null`：早期流水可以在没有任何
 *  对应业务行的情况下被写进来（admin 手工调分那种），所以这两列在库里可空，
 *  前端不许假设「有 delta 就一定点得开一条归还记录」。 */
export interface CreditLogView {
  id: number
  delta: number
  reason: string
  ref_type: string | null
  ref_id: number | null
  created_at: string
}

/** #33 GET /api/my/credit-logs 的 data —— ⚠ **不是** Page[T]：它在分页四键之外多带一个
 *  credit_score（后端直接从 JWT 用户上取，不是从流水累加出来的）。
 *  所以「当前分数」和「流水加起来的总和」是两件事，页面上不许写成「以下合计 X 分」——
 *  真有历史归档或对账差额时那句话就会和数字打架。 */
export interface CreditHistory {
  credit_score: number
  list: CreditLogView[]
  total: number
  page: number
  page_size: number
}

/** item_returns.status 的全部四种取值（model/item_return.go 的白名单，DB 有 CHECK 钉着）。
 *  状态机只有四条边：pending → confirmed / rejected / cancelled，都是**单向不可逆**；
 *  rejected 和 cancelled 之后同一个人**可以重新提交**一条新的（后端明写「这是设计不是漏洞」）。 */
export type ReturnStatus = 'pending' | 'confirmed' | 'rejected' | 'cancelled'

/** #24 里的提交人那一块。⚠ **没有 real_name**（model/item_return.go 刻意去掉），
 *  带 credit_score 是为了让发帖人在「要不要确认」之前多看一眼对方的记录 ——
 *  它是判断的**输入**，不是平台的结论。 */
export interface SubmitterView {
  id: number
  nickname: string
  credit_score: number
}

/** #25 confirm 的 data。credit_delta 是**调用者自己**那一份的封顶后增量（已经 200 分就是 0），
 *  提交人的 +2 不在这个响应里 —— 别拿它当「双方各加了几分」显示。 */
export interface ConfirmReturnResult {
  id: number
  status: string
  reviewed_at: string
  credit_delta: number
}

/** #26 reject 的 data：**根本没有 credit_delta 这个键**，连 0 都没有。
 *  拒绝不扣分是这套系统的立场（拒绝只是「我没同意」，不是「你在撒谎」）。 */
export interface DecideReturnResult {
  id: number
  status: string
  reviewed_at: string
}

/** #23 的 data。status 恒为 'pending'，所以这个类型里没什么可判的。 */
export interface SubmitReturnResult {
  id: number
  item_id: number
  status: string
  submitted_at: string
}

/** #27 的 data —— 只有两个键：后端**刻意不给** reviewed_at，
 *  虽然库里那列填了值（撤销不是「处理」，给它一个处理时间就等于把它当成处理）。 */
export interface CancelReturnResult {
  id: number
  status: string
}

/** #28 / #29 列表里的一行。
 *  ⚠ 这一行**没有 message、没有 proof_image_path、没有 submitter**，
 *  后端的理由是「列表是索引，详情才是判断现场」（model/item_return.go:156-161）。
 *  所以列表页不许试着渲染证据，也不该在列表上放确认/拒绝按钮 —— 那是 #24 的活。
 *  另外 cancelled 的行在这里**会带**非空 reviewed_at（和 #27 的响应不一致，以这里为准）。 */
export interface ReturnEntry {
  id: number
  item: ItemSummary
  status: ReturnStatus
  owner_note: string
  submitted_at: string
  reviewed_at: string
}

/** #24 GET /api/returns/:id 的 data。
 *
 * 三个只有读源码才知道的点：
 * ① `reviewed_at` 为空时是**空串**不是 null（后端 formatTime 把 NULL 折成 ""）；
 *    `reviewer_id` / `review_kind` 才是真 null。两种「还没有」的表示法不一样，别写反。
 * ② `review_kind` 只有 'owner' 和 'admin_data_fix' 两个值：前者是社区里真实发生过的判断，
 *    后者是 admin 改数据、**没有任何社区含义**。页面上不许把两者显示成同一句「已处理」——
 *    那等于替平台把「管理员改了库」说成「发帖人同意了」，正是定位原则 5 禁止的那件事。
 * ③ `item.contact` 在这条路上恒为 null，`item.removal` 恒不出现；
 *    而**帖子被删或被下架都不会让这条读不到**（记录是事实，item.status 只是回 'deleted'）。 */
export interface ReturnDetailView {
  id: number
  item: ItemSummary
  submitter: SubmitterView
  message: string
  proof_image_url: string
  status: ReturnStatus
  owner_note: string
  reviewer_id: number | null
  review_kind: 'owner' | 'admin_data_fix' | null
  submitted_at: string
  reviewed_at: string
}

/** notifications.type 的七种取值（model/notification.go 里那条 DB CHECK 的镜像）。
 *  `contact_unlocked` 已经不存在了（§16 删的），别再为它写分支。 */
export type NotificationType =
  | 'new_match'
  | 'return_submitted'
  | 'return_confirmed'
  | 'return_rejected'
  | 'item_returned_hint'
  | 'admin_action'
  | 'report_resolved'

/** #30 列表里的一条通知。
 *
 * ⚠ **不能只按 type 决定点去哪儿**：`item_id` 和 `return_id` 都可能是 null，
 *  而且 `admin_action` 一种 type 底下藏着五种完全不同的事（下架、封号、警告、删图、删归还记录），
 *  其中只有 #46 那条会带 return_id。所以跳转顺序是先看 return_id、再看 item_id、都没有就不给链接。
 *  ⚠ 这两个 id **不是外键**，指向的东西可能已经没了 —— 点进去拿到 NOT_FOUND 是预期内的，
 *  页面上要写「该内容已不存在」，不是「出错了」。 */
export interface NotificationView {
  id: number
  type: NotificationType
  title: string
  content: string
  item_id: number | null
  return_id: number | null
  is_read: boolean
  created_at: string
}

/* ---------- 片 6：管理后台（#34–#37、#43–#44、#47–#50） ---------- */

/** #34 的 status / #36 的取值，和 model.UserStatus* 两个常量一一对应。
 *  ⚠ 库里只有这两种，**没有**「封禁到某年某月」这种东西：整个 schema 里没有任何封号到期列，
 *  封号就是 indefinite，直到另一个 admin 调 #36 解封。所以页面上不许出现「封 7 天」这种选项，
 *  也不许在通知文案里承诺「N 天后自动恢复」。 */
export type UserStatus = 'active' | 'banned'

/** #34 列表里的一行 —— **9 个键，和 UserView 不是同一个形状**。
 *
 * 比 #3 多一个 status（管理员找人的一个目的就是核对这个人被封了没有），
 * 少 phone / email / avatar_url（model/user.go:119-131 那段注释是权威说法：
 * 一页 20 行铺满手机号等于把 §3.4 的解锁纪律从后台绕过去）。
 * 所以这一页不许出现「复制他的联系方式」那种便利小动作 —— 数据根本就没给，
 * 而「给不出来」正是这条契约的防线本身。
 * username / real_name 是 string（后端把 NULL 折成空串），SSO 用户的 username 就是空的。 */
export interface AdminUserRow {
  id: number
  username: string
  nickname: string
  real_name: string
  auth_source: string
  role: string
  status: UserStatus
  credit_score: number
  created_at: string
}

/** #35 的 data。 */
export interface SetRoleResult {
  id: number
  role: string
}

/** #36 的 data。 */
export interface SetStatusResult {
  id: number
  status: UserStatus
}

/** #47 的 data。
 *  ⚠ `notified` 是后端写死的 true（service/moderation.go:1082-1090），
 *  它的含义是「 INSERT 和这次 200 是同一个事务」，不是「他真的看到了这条通知」。
 *  页面上可以写「已发送」，不许写「他已收到」。 */
export interface WarnResult {
  id: number
  notified: boolean
}

/** #37 的 data，七组计数。三个键名只有读过后端才会想到：
 *  ① `hduhelp` 是 JSON 键，Go 那边那个字段叫 SSO（model/stats.go:60-63 明写「以后端为准」）；
 *  ② `items_count` **没有 total**（View() 里刻意摘掉的），所以这一组里不许显示「总共多少条帖」；
 *  ③ `returns_count` **没有 cancelled**：用户自己撤掉的那一类对治理没有信息量。
 * `today_items_count` 的「今天」用的是 `date_trunc('day', now())`，按**数据库会话时区**切，
 *  不是 UTC 也不是浏览器时区 —— 所以那一格的标签必须带上「按数据库时区」，
 *  否则凌晨跨界时会出现「统计页说今日 3 条、日志页三条都不是今天」这种看着像 bug 的事。 */
export interface AdminStats {
  users_count: { total: number; local: number; hduhelp: number; banned: number }
  items_count: { lost: number; found: number; open: number; closed: number; deleted: number }
  returns_count: { pending: number; confirmed: number; rejected: number }
  contact_views_count: number
  reports_count: { open: number; resolved: number; dismissed: number }
  admin_actions_count: number
  today_items_count: number
}

/** #43 的 data。两个数**可以不相等，相等反而是巧合**：
 *  taken_down 是「真的从非 deleted 翻成 deleted 的条数」，notified_users 是「几位作者收到合并通知」。
 *  同一批 id 连点两次，第二次是 0/0 且**仍然写一行留痕** —— 那是幂等，不是失败，
 *  所以这一页拿到 0 的时候不许报错，要说明「这批都已经是下架状态了」。 */
export interface TakedownResult {
  taken_down: number
  notified_users: number
}

/** #44 的 data。status **恒为 "open"**：恢复只回 open，不会因为下架前是 closed 就回 closed。
 *  零通知（被下架的人不会因为帖子被放回而收到任何消息）。 */
export interface RestoreResult {
  id: number
  status: string
}

/** reports.status 的三种取值（迁移里那条 CHECK 的镜像）。
 *  注意它和 #49 请求体里的 `resolution` 是两套值，别混：takedown 和 ban 都让行变 resolved。 */
export type ReportStatus = 'open' | 'resolved' | 'dismissed'

/** #49 的三种处置结论。它只决定**管理员做了什么动作**，不代表平台认定举报成立（§3.7 的措辞纪律）。 */
export type ReportResolution = 'takedown' | 'ban' | 'dismiss'

/** #48 列表里的一行。
 *  ⚠ `reporter` 只在这一条端点上存在（reports.reporter_id 那一列的注释是「除 admin 外对任何人不可见」），
 *  所以这个类型只能用在管理后台里，一旦被抄进 #15/#22 那类页面的响应类型就是越权设计。
 *  ⚠ `report_count_on_item` 数的是**这条帖子当前待处理（status=open）的举报条数**，
 *  而且那一支相关子查询不受分页影响（SQL 里的别名就叫 open_count_on_item），所以它不是「本页几条」；
 *  「含这一条自己」只在**这一行本身还是 open** 时成立 —— 一条已处置的行上它可以是 0。
 *  Go 那个字段叫 OpenCountOnItem，键名不一样。它不等于「被举报过几次」（那种历史在 reports_count 里），
 *  而且次数高的排前面这件事**只能在前端做**（后端按 created_at DESC 排，不是按热度）。
 *  `detail` 是举报人自己填的补充，**空串而不是 null**。 */
export interface AdminReportRow {
  id: number
  item: { id: number; title: string; status: string }
  reporter: { id: number; nickname: string }
  reason_code: ReportReasonCode
  detail: string
  status: ReportStatus
  report_count_on_item: number
  created_at: string
}

/** #49 的 data。`resolved_at` 是**非空字符串**（RFC3339 UTC）。 */
export interface ResolveReportResult {
  id: number
  status: ReportStatus
  resolved_at: string
}

/** admin_actions.action 的十二种取值：那是迁移里一条 CHECK 的内容，
 *  写错一个字母在查询参数上只会安静地返回空列表，所以这一份镜像同时当白名单用。 */
export type AdminActionName =
  | 'item_takedown'
  | 'item_restore'
  | 'image_takedown'
  | 'return_takedown'
  | 'item_edit'
  | 'user_ban'
  | 'user_unban'
  | 'user_role_change'
  | 'warning_sent'
  | 'report_resolved'
  | 'dict_create'
  | 'dict_delete'

/** admin_actions.target_type 的七种取值。⚠ 没有 "admin_action"：留痕不作用于留痕，
 *  所以「撤销一次下架」这件事在系统里表现为**新写一行 item_restore**，而不是改掉原来那行。 */
export type AdminTargetType = 'item' | 'item_image' | 'item_return' | 'user' | 'report' | 'category' | 'location'

/** #50 里那个 detail。
 *
 * 后端给的是 `json.RawMessage`，并且约定**永远是一个 JSON 对象**（列是 JSONB NOT NULL DEFAULT '{}'，
 * 空的时候 View() 补 "{}"，model/admin_action.go:165-177）—— 所以这里不会是字符串也不会是 null，
 * axios 解出来就是对象。键随 action 不同，全部标可选：
 * item_takedown 用 ids/count（#49 触发时多 report_id/resolution），
 * item_restore 用 author_id，image_takedown 用 item_id，
 * return_takedown 用 item_id/submitter_id/previous_status，
 * user_role_change 用 role，user_ban/user_unban 用 status（经 #49 时多 report_id/item_id），
 * warning_sent 是**空对象**，report_resolved 用 report_id/resolution/also_closed，
 * dict_create 用 name/level（一级的 parent_id 这个键**压根不出现**），dict_delete 用 name/level。 */
export interface AdminActionDetail {
  ids?: number[]
  count?: number
  report_id?: number
  resolution?: ReportResolution
  also_closed?: number[]
  item_id?: number
  author_id?: number
  submitter_id?: number
  previous_status?: string
  status?: string
  role?: string
  name?: string
  level?: number
  parent_id?: number | null
}

/** #50 日志里的一条留痕。
 *  ⚠ `admin` 是**指针**：做这件事的那个账号已经被删掉时给 null（SQL 用 LEFT JOIN +
 *  `(u.id IS NULL) AS admin_missing` 判，不是靠昵称空串猜）。那一行**不会被藏掉** ——
 *  「留痕还在、做它的人已注销」本身就是其他 admin 需要看到的信息。
 *  ⚠ 排序是 `created_at DESC, id DESC`，那个 id 兜底是必需的：#49 一次处置在同一个事务里
 *  写两行、created_at 完全相同，少了它就分不清「先下架、再记处置」。 */
export interface AdminActionRow {
  id: number
  admin: { id: number; nickname: string } | null
  action: AdminActionName
  target_type: AdminTargetType
  target_id: number
  reason: string
  detail: AdminActionDetail
  created_at: string
}
