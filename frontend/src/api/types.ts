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
