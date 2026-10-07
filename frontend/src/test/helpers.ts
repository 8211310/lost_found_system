// src/test/helpers.ts —— 造 §8 信封的助手。字段名和后端 apperr.Envelope 逐个对齐。
//
// 一律返回**对象**而不是字符串：msw 的 HttpResponse.json(value) 自己会序列化，
// 这里如果再返回 JSON 字符串，body 会变成一层带引号的字符串，
// 于是 isEnvelope 判 false，测试表现出「解包器把成功当成透传」这种很难猜的假象。
import type {
  CategoryNode,
  ItemSummary,
  ItemView,
  LocationNode,
  LoginResult,
  Page,
  RegisterResult,
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
