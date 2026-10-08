// src/test/helpers.ts —— 造 §8 信封的助手。字段名和后端 apperr.Envelope 逐个对齐。
//
// 一律返回**对象**而不是字符串：msw 的 HttpResponse.json(value) 自己会序列化，
// 这里如果再返回 JSON 字符串，body 会变成一层带引号的字符串，
// 于是 isEnvelope 判 false，测试表现出「解包器把成功当成透传」这种很难猜的假象。
import type {
  AdminActionRow,
  AdminReportRow,
  AdminStats,
  AdminUserRow,
  CategoryNode,
  ContactViewEntry,
  CreditHistory,
  CreditLogView,
  ItemSummary,
  ItemView,
  LocationNode,
  LoginResult,
  NotificationView,
  Page,
  RegisterResult,
  RemovalView,
  ReturnDetailView,
  ReturnEntry,
  SubmitterView,
  UnlockerView,
  UserView,
} from '../api/types'

export const BASE = 'http://backend.test'

export interface RawEnvelope {
  code: string
  message: string
  data: unknown
  request_id: string
}

export function ok(data: unknown): RawEnvelope {
  return { code: 'OK', message: 'ok', data, request_id: 'test-req-ok' }
}

export function envelope(
  code: string,
  message: string,
  httpStatus: number,
  data: unknown = null,
): { body: RawEnvelope; status: number } {
  return {
    body: { code, message, data, request_id: `test-req-${code.toLowerCase()}` },
    status: httpStatus,
  }
}

export function sampleUser(overrides: Partial<UserView> = {}): UserView {
  return {
    id: 7,
    username: 'xiaoli',
    nickname: '小李',
    real_name: '',
    role: 'user',
    auth_source: 'local',
    phone: '',
    email: '',
    avatar_url: '',
    credit_score: 100,
    created_at: '2026-10-07T00:00:00Z',
    ...overrides,
  }
}

export function sampleLogin(token = 'jwt.test.token'): LoginResult {
  return { token, expires_at: '2026-10-08T00:00:00Z', user: sampleUser() }
}

export function sampleRegister(): RegisterResult {
  return { id: 8, username: 'xiaowang', nickname: '小王', role: 'user' }
}

/** #14 列表里的摘要。字段和 model.ItemSummary 逐个对齐 —— 少一个就是契约漂移，
 *  而漂移只有在 fixture 也少的时候才看不见，所以这里**写满 15 个**。 */
export function sampleSummary(overrides: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id: 101,
    item_type: 'lost',
    title: '黑色钱包',
    status: 'open',
    category_id: 21,
    category_name: '衣物箱包',
    location_id: 31,
    location_name: '图书馆',
    lost_at: '2026-10-06T07:00:00Z',
    found_at: '',
    contact: '微信 aaa',
    cover_image: '/uploads/2026/10/wallet.jpg',
    author_id: 7,
    author_name: '小李',
    created_at: '2026-10-06T08:00:00Z',
    ...overrides,
  }
}

/** #15 的详情。默认是一支 **锁着的 found 帖**：这一片最难验的就是 contact/locked 那三种组合，
 *  而把默认设成「锁着的」能让每个忘记覆盖 contact 的测试都落在最需要断言的那条分支上。 */
export function sampleItemView(overrides: Partial<ItemView> = {}): ItemView {
  return {
    id: 202,
    item_type: 'found',
    title: '捡到黑色长款钱包',
    description: '夹层角落有磨损\n内有校园卡一张',
    status: 'open',
    category: { id: 21, name: '衣物箱包' },
    location: { id: 31, name: '图书馆' },
    location_detail: '三楼自习区靠窗',
    last_seen_at: '',
    lost_at: '',
    found_at: '2026-10-06T04:00:00Z',
    contact: null,
    contact_locked: true,
    images: [{ id: 5, url: '/uploads/2026/10/wallet.jpg', sort_order: 0 }],
    author: { id: 8, nickname: '小王' },
    created_at: '2026-10-06T05:00:00Z',
    updated_at: '2026-10-06T05:00:00Z',
    ...overrides,
  }
}

export function samplePage<T>(list: T[], overrides: Partial<Omit<Page<T>, 'list'>> = {}): Page<T> {
  return { list, total: list.length, page: 1, page_size: 20, ...overrides }
}

/** 分类树：两级，两个大类，其中「衣物箱包」有两个小类。
 *  「证件卡类」故意没有小类 —— 叶子可以出现在第一层吗？不能（后端种子数据里一级都有二级），
 *  但级联组件必须能优雅处理，所以留一个空的在这儿逼它处理。 */
export function sampleCategories(): CategoryNode[] {
  return [
    {
      id: 20,
      name: '衣物箱包',
      level: 1,
      sort_order: 1,
      children: [
        { id: 21, name: '钱包', level: 2, sort_order: 1, children: [] },
        { id: 22, name: '外套', level: 2, sort_order: 2, children: [] },
      ],
    },
    { id: 30, name: '电子设备', level: 1, sort_order: 2, children: [] },
  ]
}

/** 地点树：三级 + 一个 level=1 的 freeform 叶子「其他」。
 *  「其他」这一条是这片夹具里最重要的一个节点：它验证级联组件在只有一层时也能出值，
 *  而不是一律要求选到第三层（那就永远选不中「其他」）。 */
export function sampleLocations(): LocationNode[] {
  return [
    {
      id: 10,
      name: '教学区',
      level: 1,
      is_freeform: false,
      sort_order: 1,
      children: [
        {
          id: 30,
          name: '图书馆',
          level: 2,
          is_freeform: false,
          sort_order: 1,
          children: [
            { id: 31, name: '三楼自习区', level: 3, is_freeform: false, sort_order: 1, children: [] },
          ],
        },
      ],
    },
    { id: 99, name: '其他', level: 1, is_freeform: true, sort_order: 99, children: [] },
  ]
}

/** #19 里 deleted 那几行挂的 removal。reason 是后端给的那句人话，
 *  夹具刻意写成「像 admin 会写的话」而不是占位串，好让文案断言不至于断言成「含有一个 x」。 */
export function sampleRemoval(overrides: Partial<RemovalView> = {}): RemovalView {
  return {
    action_id: 4801,
    reason: '帖子中的联系方式为他人手机号，已泄露隐私',
    created_at: '2026-10-07T02:00:00Z',
    ...overrides,
  }
}

/** #22 名单里的「一个人」。real_name 默认**有值**：
 *  这一列是全项目唯一出现在对外响应里的真实姓名，漏测它的那条分支（空串时不该显示括号）最没底。 */
export function sampleUnlocker(overrides: Partial<UnlockerView> = {}): UnlockerView {
  return { id: 12, nickname: '小李', real_name: '李雷', ...overrides }
}

export function sampleContactEntry(
  user: Partial<UnlockerView> = {},
  overrides: Partial<Omit<ContactViewEntry, 'user'>> = {},
): ContactViewEntry {
  return { id: 37, user: sampleUnlocker(user), created_at: '2026-10-07T01:30:00Z', ...overrides }
}

/** #33 流水的一条。默认是加分那条，扣分在测试里显式写出来更好读。 */
export function sampleCreditLog(overrides: Partial<CreditLogView> = {}): CreditLogView {
  return {
    id: 61,
    delta: 2,
    reason: '归还确认通过',
    ref_type: 'item_return',
    ref_id: 9,
    created_at: '2026-10-07T03:00:00Z',
    ...overrides,
  }
}

/** #33 的整个响应。⚠ 不是 Page[T]：credit_score 是现读的当前分，和 list 加起来没有等式关系，
 *  所以夹具默认给一个**对不上流水总和**的数（+2 的流水配 105 分），
 *  这样任何「合计」式文案都会在这一页上被自己的断言抓住。 */
export function sampleCreditHistory(
  list: CreditLogView[] = [sampleCreditLog()],
  overrides: Partial<Omit<CreditHistory, 'list'>> = {},
): CreditHistory {
  return { credit_score: 105, list, total: list.length, page: 1, page_size: 20, ...overrides }
}

/* ---------- 片 5：归还确认流 + 通知中心 ---------- */

/** #24 里的提交人。默认**带 credit_score**：提交人要看的正是「这个人的信用分是多少」，
 *  而这一族里唯一带 real_name 的是 #22 的 UnlockerView，这里没有那一列 —— 别在页面上显示真名。 */
export function sampleSubmitter(overrides: Partial<SubmitterView> = {}): SubmitterView {
  return { id: 12, nickname: '小李', credit_score: 103, ...overrides }
}

/** #28 / #29 列表里的一条。
 *  默认是 **pending**：这一页的主用法就是「还欠几个判断」，忘了覆盖的测试会落在主分支上。
 *  ⚠ 列表行里没有 message / proof_image_url / submitter —— 夹具也不能给，
 *  给了就会掩盖「判断必须进 #24」这条约束。 */
export function sampleReturnEntry(overrides: Partial<ReturnEntry> = {}): ReturnEntry {
  return {
    id: 501,
    item: sampleSummary({ id: 202, item_type: 'found', title: '捡到黑色长款钱包', author_id: 8, author_name: '小王' }),
    status: 'pending',
    owner_note: '',
    submitted_at: '2026-10-07T06:00:00Z',
    reviewed_at: '',
    ...overrides,
  }
}

/** #24 的详情。默认 pending、还没人定过：reviewer_id / review_kind 是**真 null**，
 *  而 reviewed_at 是空串不是 null —— 这两个「还没有」在后端是两种表示法，夹具必须照抄。 */
export function sampleReturnDetail(overrides: Partial<ReturnDetailView> = {}): ReturnDetailView {
  return {
    id: 501,
    item: sampleSummary({ id: 202, item_type: 'found', title: '捡到黑色长款钱包', author_id: 8, author_name: '小王' }),
    submitter: sampleSubmitter(),
    message: '钱包夹层里有一张校园卡，卡面右下角磨掉了一块，里面有校园卡和两百现金',
    proof_image_url: '/uploads/2026/10/proof-a.jpg',
    status: 'pending',
    owner_note: '',
    reviewer_id: null,
    review_kind: null,
    submitted_at: '2026-10-07T06:00:00Z',
    reviewed_at: '',
    ...overrides,
  }
}

/** #30 里的一条通知。默认 item_id=202、return_id=null（能点进帖子的那种）。
 *  ⚠ 两个 id 都可能为 null，而 type 决定不了落点，所以「不给链接」那条分支必须单独测。
 *  title 刻意写成「后端会生成的那种具体句子」而不是类型名：这一页同时显示 type 的名字和 title，
 *  两者同名会让任何按文字找元素的测试都变成「找到两个」。 */
export function sampleNotification(overrides: Partial<NotificationView> = {}): NotificationView {
  return {
    id: 701,
    type: 'return_submitted',
    title: '小李向《捡到黑色长款钱包》提交了一次归还确认',
    content: '他写了一句说明，并上传了一张凭证图。等你给出答复。',
    item_id: 202,
    return_id: null,
    is_read: false,
    created_at: '2026-10-07T06:00:00Z',
    ...overrides,
  }
}

/* ---------- 片 6：管理后台 ---------- */

/** #34 的一行：**9 个键，和 UserView 不是同一个形状**。
 *  夹具刻意**没有** phone / email / avatar_url 那三列可给 ——
 *  给了就等于允许「后台顺手显示联系方式」那种页面在测试里也过得了。 */
export function sampleAdminUser(overrides: Partial<AdminUserRow> = {}): AdminUserRow {
  return {
    id: 12,
    username: 'xiaoli',
    nickname: '小李',
    real_name: '李雷',
    auth_source: 'local',
    role: 'user',
    status: 'active',
    credit_score: 100,
    created_at: '2026-10-05T01:00:00Z',
    ...overrides,
  }
}

/** #37 的七组计数。两组数字之间是有等式的，夹具按等式给，所以「把一组当总量」那种错读
 *  在断言里就撞得上：users 的 local 28 + hduhelp 13 = total 41，
 *  items 的 lost 50 + found 37 = open 60 + closed 17 + deleted 10 = 87。
 *  ⚠ 这里**没有** items_count.total 和 returns_count.cancelled 那两个键：
 *  后端 View() 刻意摘掉了它们（model/stats.go:82-91），夹具补上就会掩盖那条契约。 */
export function sampleAdminStats(overrides: Partial<AdminStats> = {}): AdminStats {
  return {
    users_count: { total: 41, local: 28, hduhelp: 13, banned: 2 },
    items_count: { lost: 50, found: 37, open: 60, closed: 17, deleted: 10 },
    returns_count: { pending: 6, confirmed: 12, rejected: 4 },
    contact_views_count: 33,
    reports_count: { open: 5, resolved: 9, dismissed: 3 },
    admin_actions_count: 21,
    today_items_count: 3,
    ...overrides,
  }
}

/** #48 的一行。默认是 **待处理、且这条帖子上还有 2 条待处理举报**：
 *  这一页的主用法就是「哪条积得最多」，忘覆盖的测试会落在那条分支上。
 *  ⚠ 那个数是「当前 open 的条数」（含这一条自己，仅限它自己还 open），不是「被举报过的总次数」。
 *  detail 是空串而不是 null（举报人没填补充），reporter 只在这条端点上有。 */
export function sampleAdminReport(overrides: Partial<AdminReportRow> = {}): AdminReportRow {
  return {
    id: 901,
    item: { id: 202, title: '捡到黑色长款钱包', status: 'open' },
    reporter: { id: 12, nickname: '小李' },
    reason_code: 'spam',
    detail: '',
    status: 'open',
    report_count_on_item: 2,
    created_at: '2026-10-07T07:00:00Z',
    ...overrides,
  }
}

/** #50 的一条留痕。默认是批量下架那一种（detail 带 ids），admin 是有值的那种。
 *  ⚠ detail 永远是对象：列是 JSONB NOT NULL DEFAULT '{}'，空的时候后端补 "{}"，
 *  所以这一族里「没有细节」长的是 `{}` 而不是 null —— 夹具必须照抄那个空对象而不是给 null。 */
export function sampleAdminAction(overrides: Partial<AdminActionRow> = {}): AdminActionRow {
  return {
    id: 5001,
    admin: { id: 7, nickname: '管理员' },
    action: 'item_takedown',
    target_type: 'item',
    target_id: 202,
    reason: '同一账号批量发布广告帖',
    detail: { ids: [202], count: 1 },
    created_at: '2026-10-07T08:00:00Z',
    ...overrides,
  }
}

