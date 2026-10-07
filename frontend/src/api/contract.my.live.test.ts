// src/api/contract.my.live.test.ts —— 片 4 那五条端点：#19 #22 #33 #4 #5。
//
// 这一节为什么必须真打而不是 msw：这四件事全都是「后端不说谎、前端就别猜」的判断，
// 而猜的部分正是页面能不能成立的前提：
//   ① #19 的 status 白名单**比广场多一个 deleted**（item_validate.go 的 publicListStatus
//      只放 open/closed）——「我自己删掉的那些只有这一页能列出来」这条 UI 卖点全靠它；
//   ② #22 的读者是发帖人或 admin，而且**帖子被删之后仍然读得到**（contact.go 里那句
//      「作者被下架之后仍然有权知道在被下架之前谁来看过」）—— 所以详情页那个入口
//      在 deleted 上不跟着操作栏一起消失；
//   ③ #33 的 data **不是 Page[T]**，多带一个现读的 credit_score；
//   ④ #4 的三个字段是指针：不传 = 不动，空串 = 清空。这条是这一片最危险的契约，
//      因为「把三个框一起发过去」这种写法在 msw 上测不出来（假响应是照着前端类型写的），
//      只有真后端会在用户不知情时把那两列抹掉。
//
// 跑法同其它 live 文件：`npm run test:live`（需要后端已在 8080 起）。
// 它会在开发库里留下两个用户、两条帖子、一行 contact_views、一行 item_deletions 级别的软删 ——
// 不复用固定账号的理由和 contract.write.live.test.ts 里写的那两条一样
// （#21 的解锁记录删不掉、#5 改过密码后原密码就失效了）。
import { beforeAll, describe, expect, it } from 'vitest'
import { ApiError, createHttp } from './client'
import { Code } from './codes'
import type {
  ContactViewEntry,
  CreditHistory,
  ItemSummary,
  ItemView,
  Page,
  UserView,
} from './types'

const BASE = process.env.LIVE_API_BASE ?? 'http://localhost:8080'
const live = createHttp(BASE)

function expectFields(obj: object, keys: string[]): void {
  const missing = keys.filter((k) => !(k in obj))
  expect(missing, `缺失字段：${missing.join(', ')}`).toEqual([])
}

async function call<T>(method: string, path: string, token?: string, body?: unknown): Promise<T> {
  const res = await live.request<T>({
    method,
    url: path,
    data: body,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  })
  return res.data
}

async function expectCode(code: string, action: () => Promise<unknown>): Promise<ApiError> {
  try {
    await action()
  } catch (err) {
    expect(err, `期望 ${code}，实际抛的不是 ApiError`).toBeInstanceOf(ApiError)
    const e = err as ApiError
    expect(e.code, `期望 ${code}，实际 ${e.code}（request_id=${e.requestId}）`).toBe(code)
    return e
  }
  throw new Error(`期望 ${code}，结果请求成功了`)
}

const TAG = `my${Date.now()}`
const PASSWORD = 'correct-horse-battery'

const seed = {
  /** 作者：两条 found 帖的发布者，也是 #5 那条改密码的账号 */
  tokenAuthor: '',
  authorId: 0,
  /** 访客：各解锁一次，制造两行 contact_views */
  tokenViewer: '',
  viewerId: 0,
  /** 一直留在架上的那条：#22 的读者鉴权要用它（删掉之后访客会先吃 NOT_FOUND，判据就混了） */
  foundId: 0,
  /** 会被作者 #17 软删的那条：#19 的 deleted 一档和「删帖之后名单仍可读」都用它 */
  goneId: 0,
  contact: `wx_${TAG}_author`,
}

beforeAll(async () => {
  await call('GET', '/api/health')

  const register = async (who: string, nickname: string): Promise<{ token: string; id: number }> => {
    const username = `${who}${TAG}`
    const r = await call<{ id: number }>('POST', '/api/auth/register', undefined, {
      username,
      password: PASSWORD,
      nickname,
    })
    const login = await call<{ token: string }>('POST', '/api/auth/login', undefined, {
      username,
      password: PASSWORD,
    })
    return { token: login.token, id: r.id }
  }
  const author = await register('mypost', '契约发帖人')
  const viewer = await register('myview', '契约访客')
  seed.tokenAuthor = author.token
  seed.authorId = author.id
  seed.tokenViewer = viewer.token
  seed.viewerId = viewer.id

  // 分类和地点现取，理由和 contract.write.live.test.ts 一致：这一节跑在开发库上，
  // M6 之后 admin 能删字典行，硬编码 id 会红得让人以为是匹配坏了。
  const cats = await call<Array<{ id: number; children: Array<{ id: number }> }>>('GET', '/api/categories')
  const locs = await call<Array<{ id: number; children: Array<{ id: number; children: Array<{ id: number }> }> }>>(
    'GET',
    '/api/locations',
  )
  const category = cats[0]?.children[0]
  const location = locs[0]?.children[0]?.children[0]
  if (!category || !location) throw new Error('字典种子数据拿不到可用的叶子节点，这一节没法造帖子')

  const post = async (title: string): Promise<number> => {
    const created = await call<{ item: ItemView }>('POST', '/api/items', seed.tokenAuthor, {
      item_type: 'found',
      title: `${TAG} ${title}`,
      description: `${TAG} 杯身有卡通贴纸，杯盖有划痕`,
      category_id: category.id,
      location_id: location.id,
      location_detail: '一楼服务台',
      found_at: new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      contact: seed.contact,
    })
    return created.item.id
  }
  // 两条，而不是一条：#22 的访客鉴权必须在**还在架上**的那条上测，
  // 否则后端先按软删规则给 NOT_FOUND，那条断言测到的就不是「谁是读者」这件事了。
  seed.foundId = await post('捡到一只保温杯')
  seed.goneId = await post('捡到一把雨伞')

  // 访客各解锁一次：#22 那些行只能由真实解锁产生（它是日志，不是能预置的数据）。
  await call('POST', `/api/items/${seed.foundId}/unlock-contact`, seed.tokenViewer)
  await call('POST', `/api/items/${seed.goneId}/unlock-contact`, seed.tokenViewer)
})

describe('#19 GET /api/my/items', () => {
  it('自己的 found 帖把联系方式直接给出来，contact 不是 null', async () => {
    const p = await call<Page<ItemSummary>>('GET', '/api/my/items', seed.tokenAuthor)
    expectFields(p, ['list', 'total', 'page', 'page_size'])
    // list 一律是数组（后端刻意返回空切片而不是 nil），前端可以不加判空地 map。
    expect(Array.isArray(p.list)).toBe(true)

    const mine = p.list.find((i) => i.id === seed.foundId)
    expect(mine, '刚发的那条应该出现在我的发布里').toBeDefined()
    // 这一条是 #19 区别于 #14 的地方：广场对 found 帖恒为 null，
    // 而自己的帖子必须给出来，否则这一页连「我留的是哪个号」都回答不了。
    expect(mine!.contact, '自己的帖子不该被联系方式锁挡住').toBe(seed.contact)
  })

  it('status=deleted 是这一族允许的取值，而广场那个端点拒绝它', async () => {
    // 先证明 #19 接受：返回的应该是这一档的行（空也算通过，判据是「没吃 VALIDATION」）。
    const p = await call<Page<ItemSummary>>('GET', '/api/my/items?status=deleted', seed.tokenAuthor)
    expect(p.list.every((i) => i.status === 'deleted'), 'status=deleted 里混进了别的状态').toBe(true)

    // 再证明 #14 不接受：这一对是「广场答不了的问题」的全部理由。
    await expectCode(Code.VALIDATION, () => call('GET', '/api/items?status=deleted'))
  })

  it('匿名读 → UNAUTHORIZED，而不是当成某个匿名人给一个空列表', async () => {
    await expectCode(Code.UNAUTHORIZED, () => call('GET', '/api/my/items'))
  })

  it('软删之后它从广场消失、但仍在我的发布里，而且没有 removal', async () => {
    await call('DELETE', `/api/items/${seed.goneId}`, seed.tokenAuthor)

    const mine = await call<Page<ItemSummary>>(
      'GET',
      `/api/my/items?status=deleted&keyword=${encodeURIComponent(TAG)}`,
      seed.tokenAuthor,
    )
    const row = mine.list.find((i) => i.id === seed.goneId)
    expect(row, '自己删掉的帖子应该还在自己的列表里').toBeDefined()
    expect(row!.status).toBe('deleted')
    // removal 是给「被 admin 下架」那种行用的（从 admin_actions 现查）。
    // 作者自己动手删的那条没有那次操作，所以这个键不该出现 —— 前端那句
    // 「已被管理员下架」的文案必须绑在这个键上，而不是绑在 status=deleted 上。
    expect(row!.removal, '自己删的帖子不该带下架原因').toBeUndefined()

    const plaza = await call<Page<ItemSummary>>('GET', `/api/items?keyword=${encodeURIComponent(TAG)}`)
    expect(
      plaza.list.some((i) => i.id === seed.goneId),
      'deleted 的帖子不该出现在广场上（#14 的 publicListStatus 挡的就是它）',
    ).toBe(false)
    // 另一条还在架上的必须还在，否则上面那个「不在」只是因为整页都空了。
    expect(plaza.list.some((i) => i.id === seed.foundId)).toBe(true)
  })
})

describe('#22 GET /api/items/:id/contact-views', () => {
  it('发帖人读得到自己那条的名单，字段逐个都在', async () => {
    const p = await call<Page<ContactViewEntry>>(
      'GET',
      `/api/items/${seed.foundId}/contact-views`,
      seed.tokenAuthor,
    )
    expectFields(p, ['list', 'total', 'page', 'page_size'])
    const hit = p.list.find((e) => e.user.id === seed.viewerId)
    expect(hit, '访客那次真实解锁应该出现在名单里').toBeDefined()
    expectFields(hit!, ['id', 'user', 'created_at'])
    expectFields(hit!.user, ['id', 'nickname', 'real_name'])
    // real_name 在这一族响应里是 string 而不是 null（repo 那层 COALESCE 成空串）：
    // 本地账号没填过真名，所以这里是空串 —— 前端「没有真名就不显示括号」那条分支的依据。
    expect(typeof hit!.user.real_name).toBe('string')
    // 解锁时刻必须是真时间而不是空串：空串在本项目里是「这个时间为 NULL」的形状。
    expect(hit!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('已经不在架上的那条，发帖人仍然读得到自己的名单', async () => {
    // 判据来自后端 contact.go：名单和 #15 的软删规则不是同一条 ——
    // 作者和 admin 在帖子被删之后依然可读，「谁在被删之前来看过」正是治理场景要的证据。
    // 所以前端把这一页的入口在 deleted 上也留着（见 ItemDetailPage 里那段注释）。
    const p = await call<Page<ContactViewEntry>>(
      'GET',
      `/api/items/${seed.goneId}/contact-views`,
      seed.tokenAuthor,
    )
    expect(p.total, '被删的帖子的解锁记录不该跟着消失').toBeGreaterThanOrEqual(1)
  })

  it('不是发帖人的登录用户读 → FORBIDDEN（前端因此对这种人根本不发请求）', async () => {
    await expectCode(Code.FORBIDDEN, () =>
      call('GET', `/api/items/${seed.foundId}/contact-views`, seed.tokenViewer),
    )
  })

  it('匿名读 → UNAUTHORIZED', async () => {
    await expectCode(Code.UNAUTHORIZED, () =>
      call('GET', `/api/items/${seed.foundId}/contact-views`),
    )
  })
})

describe('#33 GET /api/my/credit-logs', () => {
  it('data 不是 Page[T]：分页四键之外多一个现读的 credit_score', async () => {
    const h = await call<CreditHistory>('GET', '/api/my/credit-logs', seed.tokenAuthor)
    expectFields(h, ['credit_score', 'list', 'total', 'page', 'page_size'])
    expect(typeof h.credit_score).toBe('number')
    // 新注册的账号没有流水。后端这里给的是 []（空切片）而不是 null ——
    // 页面直接 map 的依据就是这一条。
    expect(Array.isArray(h.list), 'list 应该是 []，不该是 null').toBe(true)
    expect(h.list.length, '刚注册的账号不该有积分流水').toBe(0)
  })

  it('没有带 user_id 这条路：这一族的收件人只来自 JWT', async () => {
    // 多带的 ?user_id= 后端根本不读（handler 只绑分页参数）。这条断言要钉的是
    // 「塞一个别人的 id 也只会拿到自己的东西」，而不是它会报错。
    const me = await call<UserView>('GET', '/api/auth/me', seed.tokenAuthor)
    const h = await call<CreditHistory>(
      'GET',
      `/api/my/credit-logs?user_id=${seed.viewerId}`,
      seed.tokenAuthor,
    )
    expect(h.credit_score, '带了别人的 user_id 也只会拿到自己的当前分').toBe(me.credit_score)
  })
})

describe('#4 PUT /api/auth/me 的指针语义', () => {
  const phone = `139${TAG.replace(/\D/g, '').slice(-8)}`
  const email = `${TAG}@example.test`

  it('先填上手机号和邮箱，作为后面那次「只改昵称」的对照', async () => {
    const u = await call<UserView>('PUT', '/api/auth/me', seed.tokenAuthor, { phone, email })
    expect(u.phone).toBe(phone)
    expect(u.email).toBe(email)
  })

  it('只提交 nickname 时，另外两列原样还在 —— 这就是前端只发改动字段的原因', async () => {
    const u = await call<UserView>('PUT', '/api/auth/me', seed.tokenAuthor, { nickname: '只改了昵称' })
    expect(u.nickname).toBe('只改了昵称')
    // 如果前端把三个框一起发（其中两个是空的），这两行断言就红了，
    // 而用户在屏幕上看到的是「保存成功」—— 那才是这条契约可怕的地方。
    expect(u.phone, '没提交 phone 时它不该被动').toBe(phone)
    expect(u.email, '没提交 email 时它不该被动').toBe(email)
  })

  it('空串是真的清空，而且只有 nickname 不许清空', async () => {
    const cleared = await call<UserView>('PUT', '/api/auth/me', seed.tokenAuthor, { email: '' })
    expect(cleared.email, 'email 传空串就是清空').toBe('')

    const e = await expectCode(Code.VALIDATION, () =>
      call('PUT', '/api/auth/me', seed.tokenAuthor, { nickname: '   ' }),
    )
    expect(e.errorFor('nickname'), `字段错误没报在 nickname 上：${JSON.stringify(e.fieldErrors)}`).toBeTruthy()
  })

  it('UserView 是那 11 个字段，一个都不多', async () => {
    const u = await call<UserView>('GET', '/api/auth/me', seed.tokenAuthor)
    expectFields(u, [
      'id',
      'username',
      'nickname',
      'real_name',
      'role',
      'auth_source',
      'phone',
      'email',
      'avatar_url',
      'credit_score',
      'created_at',
    ])
    expect(u.auth_source, '这一节用的应该是本地账号，否则 #5 那两条没法测').toBe('local')
  })
})

describe('#5 POST /api/auth/change-password', () => {
  it('新密码太弱 → WEAK_PASSWORD，旧密码没被改动', async () => {
    await expectCode(Code.WEAK_PASSWORD, () =>
      call('POST', '/api/auth/change-password', seed.tokenAuthor, {
        old_password: PASSWORD,
        new_password: '12345',
      }),
    )
    // 弱密码那次必须**没有生效**，否则下面的正确密码就登不进去了。
    await call('GET', '/api/auth/me', seed.tokenAuthor)
  })

  it('原密码不对 → OLD_PASSWORD_WRONG，并且报在 old_password 这一格上', async () => {
    const e = await expectCode(Code.OLD_PASSWORD_WRONG, () =>
      call('POST', '/api/auth/change-password', seed.tokenAuthor, {
        old_password: '不是这一个',
        new_password: 'another-good-pass',
      }),
    )
    expect(e.errorFor('old_password')).toBeTruthy()
  })

  it('改成功后旧密码失效、新密码可登录', async () => {
    const NEW = `${TAG}-new-pass`
    await call('POST', '/api/auth/change-password', seed.tokenAuthor, {
      old_password: PASSWORD,
      new_password: NEW,
    })

    await expectCode(Code.INVALID_CREDENTIALS, () =>
      call('POST', '/api/auth/login', undefined, {
        username: `mypost${TAG}`,
        password: PASSWORD,
      }),
    )
    const re = await call<{ token: string }>('POST', '/api/auth/login', undefined, {
      username: `mypost${TAG}`,
      password: NEW,
    })
    expect(re.token).toBeTruthy()
    seed.tokenAuthor = re.token
  })
})
