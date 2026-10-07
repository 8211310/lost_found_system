// src/api/contract.write.live.test.ts —— 片 2 那三条「要登录、而且会写库」的端点：#20 #21 #41。
//
// 为什么不并进 contract.live.test.ts：那个文件通篇只 GET，跑一百遍库里的行数都不变；
// 而 breakdown、already_unlocked、举报的 status 这三个形状，只有在
// 「这个人真的匹配上了一条帖、真的解锁过、真的举报过」之后才存在 —— 想断言就得先制造。
//
// 手抄类型的风险恰恰全在这三条上：matcher 那三个信号结构体是照 json tag 抄的，
// 后端哪天把 same_leaf 改成 sameLeaf，msw 的假响应是照着前端类型写的，两边一起错、测试全绿，
// 只有真打才红。这一层的唯一用处就是把「红」提前到没人受影响的时候。
//
// 跑法同 contract.live.test.ts：`npm run test:live`（需要后端已在 8080 起）。
// 它会在开发库里留下 2 个用户、3 条帖子、1 行 contact_views、1 行 reports ——
// 这是刻意的，不复用固定账号的理由见下面 seed 那段注释。
import { beforeAll, describe, expect, it } from 'vitest'
import { ApiError, createHttp } from './client'
import { Code } from './codes'
import type { CategoryNode, ItemView, LocationNode, MatchResult, UnlockResult, ReportResult } from './types'

const BASE = process.env.LIVE_API_BASE ?? 'http://localhost:8080'
const live = createHttp(BASE)

/** 断言字段名逐个存在。缺一个就红，并且直接说是哪个。 */
function expectFields(obj: object, keys: string[]): void {
  const missing = keys.filter((k) => !(k in obj))
  expect(missing, `缺失字段：${missing.join(', ')}`).toEqual([])
}

/** 带 token 打一条请求，返回解过信封的 data。
 *  token 走 per-request header 而不是 session.setToken：这一节里三个身份（A / B / 匿名）
 *  交替出现，用全局存储会写成「先 set 再调」那种顺序依赖，读的人得回头数谁在什么时候是登录态。 */
async function call<T>(method: string, path: string, token?: string, body?: unknown): Promise<T> {
  const res = await live.request<T>({
    method,
    url: path,
    data: body,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  })
  return res.data
}

/** 期望这条请求以某个 code 失败，并把错误对象拿回来。
 *  「按 code 断言」而不是「按 message 断言」是 §8 的契约，也是这个文件里所有负向断言的写法。 */
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

function hoursAgo(h: number): string {
  // 后端按 RFC3339 解析，而 new Date().toISOString() 带毫秒（...:00.000Z）。
  // Gin 那侧的时间校验对毫秒是能解析的，但冒烟脚本统一用不带毫秒的形状，
  // 这里跟着一致 —— 免得哪天比对字符串时因为多出 .000 而红。
  return new Date(Date.now() - h * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** matcher.round4：四舍五入到四位小数。
 *  照抄它不是为了在前端重算分数，而是为了**断言后端的重算规则**：
 *  分量先舍、总分再从舍过的分量加权和得出（matcher.go 里 round4 的注释交代了原因 ——
 *  NUMERIC(5,4) 落库 + 「breakdown 是给人手算的」）。
 *  MatchPanel 把 weight × score 原样摊在屏幕上、自己不写任何系数，靠的就是这条规则；
 *  哪天改成用未舍入的分量算总分，用户手加出来的数和总分就对不上了，这里先红。 */
function round4(x: number): number {
  return Math.round(x * 10000) / 10000
}

function flatten<N extends { children: N[] }>(nodes: N[]): N[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)])
}

const TAG = `live${Date.now()}`
const PASSWORD = 'correct-horse-battery'

/** 本轮造的三条帖子。id 在 beforeAll 里填，测试之间共享。 */
const seed = {
  tokenA: '',
  tokenB: '',
  /** A 的失物帖：钱包 @ 图书馆，时间按 §5.3 夹成「捡到早于意识到丢失」 */
  lostId: 0,
  /** A 的第二条失物帖：地点选「其他」，用来走 Tier 2 */
  looseId: 0,
  /** B 的拾物帖：和 lostId 同分类同地点，创建时由后端写台账并通知 A */
  foundId: 0,
  contactOfFound: 'wx_live_finder',
}

beforeAll(async () => {
  // 后端不可达一律算失败，不静默跳过（和被跳过的冒烟测试等于没有冒烟测试同一条理由）。
  await call('GET', '/api/health')

  // 字典放在注册**前面**：这两个账号是为这一节服务的，
  // 如果字典那边就先炸了，库里会留下两个什么都没发过的孤儿账号。
  // 分类和地点的 id 也是现取而不是硬编码 36 / 70：冒烟脚本硬编码是因为它的库是自己种的，
  // 而这个文件跑在**开发库**上，M6 之后 admin 能删字典行（#10/#12），
  // 硬编码会红得让人以为是匹配算法坏了。
  const cats = await call<CategoryNode[]>('GET', '/api/categories')
  const locs = await call<LocationNode[]>('GET', '/api/locations')
  const wallet = flatten(cats).find((c) => c.name === '钱包')
  // 图书馆是 level 3 的叶子（1 校区 / 2 区域 / 3 楼栋）。Tier 1 要求两边都能比叶子，
  // 所以这里必须取到叶子；万一哪天种子改了名，这条报错比一次诡异的 tier=2 好读。
  const library = flatten(locs).find((l) => l.name === '图书馆' && l.level === 3)
  const freeform = flatten(locs).find((l) => l.is_freeform)
  if (!wallet || !library || !freeform) {
    throw new Error(
      `字典里找不到种子数据需要的节点：钱包=${!!wallet} 图书馆=${!!library} 其他(freeform)=${!!freeform}`,
    )
  }

  const register = async (who: 'loser' | 'finder', nickname: string): Promise<string> => {
    const username = `${who}${TAG}`
    await call('POST', '/api/auth/register', undefined, {
      username,
      password: PASSWORD,
      nickname,
    })
    const r = await call<{ token: string }>('POST', '/api/auth/login', undefined, {
      username,
      password: PASSWORD,
    })
    return r.token
  }
  // ⚠ 每轮都注册新账号，而不是复用 fedemo01 那种固定账号，有两个硬理由：
  //   ① #41 同一人对同一帖只许有一条待处理举报（部分唯一索引），复用账号的第二轮会拿到
  //      REPORT_DUPLICATE —— 那这条测试就变成了在测「上一轮跑干净没有」，而不是测契约。
  //   ② #21 的 already_unlocked 第一次必须是 false，而解锁记录是删不掉的（它是审计日志）。
  //   复用账号就永远只能测到 true 那一半，正好是 UI 上那句「你之前已经查看过」的分支。
  seed.tokenA = await register('loser', '契约失主')
  seed.tokenB = await register('finder', '契约拾主')

  // 标题和描述都带本轮编号，理由和冒烟脚本一样：这两条是文本相似度的全部输入，
  // 上一轮留下的帖子如果不带编号，会和这一轮的几乎完全一样（dice≈1），
  // 匹配列表里就会混进别的轮次的帖子，「命中本轮那条 found」就不再是一个能钉住的断言。
  const title = `${TAG} 黑色长款钱包`
  const desc = `${TAG} 夹层角落有磨损，内有校园卡一张`

  // 三个时刻：last_seen 3 小时前 → **found 2.5 小时前** → lost_at 2 小时前。
  // 顺序必须是这个：matcher.timeScore 里 in_loss_window 的定义是
  // last_seen_at ≤ found_at ≤ lost_at（右端就是 lost_at），也就是 §5.3 那个
  // 「在你意识到丢之前就被捡到了」，此时 S_time 恰好 1.0。
  // ⚠ 冒烟脚本 m3 的注释写的是同一件事，但它的 T_FOUND 用的是 -90 分钟，
  //   落在 lost_at（-120 分钟）**之后** —— 那里拿到的其实是衰减分而不是 1.0，
  //   只是它断言的是权重之和，没断言 in_loss_window，所以一直没红。
  const lostBody = {
    item_type: 'lost',
    title,
    description: desc,
    category_id: wallet.id,
    location_id: library.id,
    location_detail: '三楼自习室B区',
    last_seen_at: hoursAgo(3),
    lost_at: hoursAgo(2),
    contact: '13800000000',
  }

  // 顺序是刻意的：先建 A 的失物帖，再建 B 的拾物帖 ——
  // 台账和通知只在 found 那一侧写（§5 的不对称），反过来建的话 A 什么也收不到，
  // 而 #20 查的还是同一对，只是这一节就不再证明「谁被写进台账」这件事了。
  //
  // #13 的 data 不是裸的 {id}，而是 {item: ItemView, 再加上一个按类型互斥的可选键}。
  // 这一条在这里顺手断言，是因为它是**这一段 fixture 自己的正确性**：
  // 那两个可选键正是片 3 那两个长得不一样的发布成功页的唯一输入。
  type CreateData = {
    item: { id: number }
    matches_preview?: unknown
    notified_count?: number
  }

  const lost = await call<CreateData>('POST', '/api/items', seed.tokenA, lostBody)
  seed.lostId = lost.item.id
  expect('matches_preview' in lost, 'lost 帖的响应必须带 matches_preview，一条都没匹配上也要是 [] —— 键消失了片 3 的发布成功页就只能渲染一个空白区块').toBe(true)
  expect(lost.notified_count, 'lost 方向谁都不通知，所以 notified_count 这个键不该出现').toBeUndefined()

  const found = await call<CreateData>('POST', '/api/items', seed.tokenB, {
    item_type: 'found',
    title,
    description: desc,
    category_id: wallet.id,
    location_id: library.id,
    location_detail: '一楼服务台',
    found_at: hoursAgo(2.5),
    contact: seed.contactOfFound,
  })
  seed.foundId = found.item.id
  expect(found.notified_count, 'found 帖必须带 notified_count，哪怕是 0 —— 那是去重的证据').toBeTypeOf('number')
  // 至少 1：A 这一轮那条失物帖必须被通知到。不钉死成恰好 1，是因为这个文件打的是**开发库**，
  // 上一轮留下的同分类同地点帖子也可能跨过通知线，那会让 notified_count 一轮比一轮大
  // （冒烟脚本 m3 顶部交代过同一件事）。「恰好 1」由 backend/smoketest 在干净库上钉。
  expect(found.notified_count, '这一对应该至少匹配上 A 刚建的那条失物帖').toBeGreaterThanOrEqual(1)
  expect('matches_preview' in found, 'found 帖的响应里不该出现 matches_preview（平台不会通知 found 任何东西）').toBe(false)

  // Tier 2 那条：地点选「其他」（is_freeform 的叶子），Tier 1 的硬前提不成立，
  // 后端于是把地点从硬筛选降级成打分项，breakdown 多出一路 location 并带 notice。
  const loose = await call<CreateData>('POST', '/api/items', seed.tokenA, {
    ...lostBody,
    location_id: freeform.id,
    location_detail: '食堂门口的路边',
  })
  seed.looseId = loose.item.id
})

describe('#15 found 帖的 contact 三态（解锁之前）', () => {
  // contact_locked 决定按钮出不出现，contact 决定出现的是字符串还是空 ——
  // 详情页那块 UI 的全部输入就是这两个字段，前端不自己判类型。
  it('匿名读 → contact 是 null，contact_locked 是 true', async () => {
    const v = await call<ItemView>('GET', `/api/items/${seed.foundId}`)
    expectFields(v, ['contact', 'contact_locked'])
    expect(v.contact).toBeNull()
    expect(v.contact_locked).toBe(true)
  })

  it('拾主本人读自己那条 → 不锁（他不需要解锁自己的帖子）', async () => {
    const v = await call<ItemView>('GET', `/api/items/${seed.foundId}`, seed.tokenB)
    expect(v.contact_locked, '作者看自己的 found 帖应该直接看到联系方式').toBe(false)
    expect(v.contact).toBe(seed.contactOfFound)
  })
})

describe('#21 解锁联系方式', () => {
  it('三个字段都在，第二次调 already_unlocked 翻成 true 且 unlocked_at 不变', async () => {
    const path = `/api/items/${seed.foundId}/unlock-contact`
    const first = await call<UnlockResult>('POST', path, seed.tokenA)
    expectFields(first, ['contact', 'unlocked_at', 'already_unlocked'])
    expect(first.contact).toBe(seed.contactOfFound)
    expect(first.already_unlocked, '这一轮的第一次必须是 false，否则 true 那一半没法测').toBe(false)
    // 解锁时刻必须是一个真时间而不是空串：空串是本项目「这个时间为 NULL」的形状，
    // 而帖主本人那条分支才给空串（service/contact.go 的 ③）。A 是外人，走的是真插入。
    expect(first.unlocked_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)

    const second = await call<UnlockResult>('POST', path, seed.tokenA)
    expect(second.already_unlocked).toBe(true)
    // ⚠ 幂等的判据不是「第二次也成功」，而是「第二次报的是第一次的时刻」。
    // 后端 ON CONFLICT DO NOTHING + 回读第一次那一行；哪天改成刷新时间，
    // #22 那份名单就会变成「谁最后来过」而不是「谁来看过」，审计意义全变。
    expect(second.unlocked_at).toBe(first.unlocked_at)
    expect(second.contact).toBe(first.contact)
  })

  it('A 解锁之后重读 → contact 出来了，而且锁标记跟着松开', async () => {
    // 这条排在 #21 后面不是巧合：解锁是一次性的事实记录，
    // 「解锁前 locked=true」和「解锁后 locked=false」必须隔着一次真实调用，
    // 所以本文件的 describe 是一条顺序而不是一堆独立用例。
    const v = await call<ItemView>('GET', `/api/items/${seed.foundId}`, seed.tokenA)
    expect(v.contact, '解锁记录已经有了，#15 就该把 contact 给出去').toBe(seed.contactOfFound)
    expect(v.contact_locked).toBe(false)
  })

  it('对 lost 帖调解锁 → VALIDATION（详情页不给这个按钮，但契约钉在这）', async () => {
    await expectCode(Code.VALIDATION, () =>
      call('POST', `/api/items/${seed.lostId}/unlock-contact`, seed.tokenB),
    )
  })

  it('匿名调解锁 → UNAUTHORIZED，而不是当作某个匿名人给成功', async () => {
    await expectCode(Code.UNAUTHORIZED, () =>
      call('POST', `/api/items/${seed.foundId}/unlock-contact`),
    )
  })
})

describe('#20 匹配结果的 breakdown', () => {
  it('本人查自己的失物帖：tier=1、命中本轮那条 found、恰好三个信号', async () => {
    const r = await call<MatchResult>('GET', `/api/items/${seed.lostId}/matches`, seed.tokenA)
    expectFields(r, ['tier', 'list'])
    expect(r.tier).toBe(1)
    // notice 只在 Tier 2 出现（后端 omitempty）。Tier 1 里它必须整个不存在，
    // 因为 MatchPanel 是「有 notice 就渲染那条横幅」，后端哪天在 Tier 1 也发，
    // 用户就会看到一句「这次匹配放宽了条件」而事实并非如此。
    expect(r.notice, 'Tier 1 不该有放宽筛选的横幅文案').toBeUndefined()

    const hit = r.list.find((h) => h.item.id === seed.foundId)
    expect(hit, `本轮那条 found（id=${seed.foundId}）没出现在匹配列表里`).toBeDefined()
    expectFields(hit!, ['item', 'score', 'breakdown'])
    expect(hit!.item.item_type).toBe('found')
    // 命中项里的 item 就是 ItemSummary，所以广场卡片那套字段在这里同样成立 ——
    // MatchPanel 直接复用卡片渲染，靠的就是这一点。
    expect('description' in hit!.item, '列表元素里不该有 description').toBe(false)

    const b = hit!.breakdown
    expectFields(b, ['score', 'tier', 'signals'])
    expect(b.tier).toBe(1)
    expectFields(b.signals, ['category', 'text', 'time'])
    // Tier 1 里地点是 SQL 层的硬筛选条件、不进打分，所以这一路**整个不存在**。
    // 「存在但 weight 为 0」是另一种实现，它让 breakdown 的加权和对不上总分。
    expect('location' in b.signals, 'Tier 1 的 breakdown 里有 location 信号').toBe(false)
    expect('attr' in b.signals, 'S_attr 已经随 color/brand 两列一起删掉了').toBe(false)

    expectFields(b.signals.category, ['weight', 'score', 'same_leaf'])
    expectFields(b.signals.text, ['weight', 'score', 'title_dice', 'desc_dice'])
    expectFields(b.signals.time, ['weight', 'score', 'in_loss_window', 'days_after_lost_at'])

    // 权重之和是 1.0，且总分等于加权和 —— 这两条是 MatchPanel 敢把 weight/score
    // 原样摊在屏幕上、自己不写任何系数的依据。哪天后端把权重调成 0.5/0.3/0.2，
    // 这里不红；哪天加第四路信号而权重没归一，这里红。
    const s = b.signals
    const weights = s.category.weight + s.text.weight + s.time.weight
    expect(weights, `三路权重之和是 ${weights}，不是 1`).toBeCloseTo(1, 6)
    // 分量本身也必须是四位小数（round4 先作用在分量上），否则下面的加权和等式不可能成立。
    for (const [name, sig] of [
      ['category', s.category],
      ['text', s.text],
      ['time', s.time],
    ] as const) {
      expect(sig.score, `${name}.score 不是四位小数`).toBe(round4(sig.score))
    }
    const weighted =
      s.category.weight * s.category.score +
      s.text.weight * s.text.score +
      s.time.weight * s.time.score
    expect(b.score, `总分应等于三路加权和再 round4（${weighted} → ${round4(weighted)}），实际 ${b.score}`).toBe(
      round4(weighted),
    )
    expect(hit!.score).toBe(b.score)

    // 这一对是照 §5.3 的时间关系造的，所以分数应该过通知线。
    // 断言它而不是断言某个具体小数：阈值是配置项（/api/debug/config 看得见），
    // 但「这一对算不算匹配上」是这一节存在的前提。
    expect(s.time.in_loss_window).toBe(true)
    expect(s.time.score, 'found_at 落在丢失窗口内时 S_time 应该是满的 1.0').toBe(1)
    expect(s.time.days_after_lost_at).toBe(0)
    expect(b.score).toBeGreaterThanOrEqual(0.75)
    expect(s.category.same_leaf).toBe(true)
    expect(s.text.title_dice).toBe(1)
  })

  it('不是作者的人查 → FORBIDDEN（详情页因此对别人根本不渲染这个入口）', async () => {
    await expectCode(Code.FORBIDDEN, () =>
      call('GET', `/api/items/${seed.lostId}/matches`, seed.tokenB),
    )
  })

  it('匿名查 → UNAUTHORIZED，而不是认成匿名后给一个空列表', async () => {
    await expectCode(Code.UNAUTHORIZED, () => call('GET', `/api/items/${seed.lostId}/matches`))
  })

  it('地点选「其他」的那条 → tier=2 + notice + 多出第四路 location', async () => {
    const r = await call<MatchResult>('GET', `/api/items/${seed.looseId}/matches`, seed.tokenA)
    // Tier 2 的**判据是 tier 这个数字本身**，不是「有没有 location」。
    // MatchPanel 里那句「有 location 就渲染第四行」是渲染层的巧合，
    // 而 tier=2 时地点降级成打分项才是原因 —— 两边都要钉住，所以两条都断言。
    expect(r.tier).toBe(2)
    expect(typeof r.notice, 'Tier 2 必须带一句人话解释为什么只能宽松匹配').toBe('string')
    expect(r.notice!.length).toBeGreaterThan(0)

    // 先证明这一次宽松匹配**真的拿到了结果**，再断言结果的形状。
    // 少了这一句，下面的 if 在空列表上就是永久绿灯 ——
    // 「断言一个不存在的东西长什么样」是这类脚本最容易写错的形状。
    expect(r.list.length, 'Tier 2 一条都没匹配上，下面的形状断言会落空').toBeGreaterThan(0)

    const s = r.list[0].breakdown.signals
    expectFields(s, ['category', 'text', 'time'])
    expect('location' in s, 'Tier 2 的 breakdown 少了 location 这一路').toBe(true)
    expectFields(s.location!, ['weight', 'score', 'matched_by'])
    const weights = s.category.weight + s.text.weight + s.time.weight + s.location!.weight
    expect(weights, `四路权重之和是 ${weights}，不是 1`).toBeCloseTo(1, 6)

    // 加权和那条等式在 Tier 2 同样成立 —— 这条值得单独写一遍：
    // MatchPanel 里第四行是**条件渲染**的，如果后端在 Tier 2 忘了把 location 计进总分，
    // 用户会在屏幕上看到四行、加起来的数却和总分差 0.15。
    const b = r.list[0].breakdown
    const weighted =
      s.category.weight * s.category.score +
      s.text.weight * s.text.score +
      s.time.weight * s.time.score +
      s.location!.weight * s.location!.score
    expect(b.score, `Tier 2 总分应等于四路加权和再 round4（${weighted} → ${round4(weighted)}），实际 ${b.score}`).toBe(
      round4(weighted),
    )
  })
})

describe('#41 举报', () => {
  it('举报成功只返回一条 open 记录，被举报的帖子什么都没发生', async () => {
    // 匿名读：要看的是「这条帖子对外还是不是原来那条」，
    // 而作者视角会直接看到 contact，把 contact_locked 变成 false —— 那和举报无关。
    const before = await call<ItemView>('GET', `/api/items/${seed.foundId}`)
    const r = await call<ReportResult>(
      'POST',
      `/api/items/${seed.foundId}/report`,
      seed.tokenA,
      { reason_code: 'spam', detail: `${TAG} 前端契约检查` },
    )
    expectFields(r, ['id', 'status', 'created_at'])
    expect(r.status, '举报的 status 恒为 open：它是「等 admin 看」这个事实，不是处置进度').toBe('open')
    // 举报没有自动后果（定位原则 1）。前端那句「已记录，管理员会看到」承诺的就是这一条：
    // 帖子状态不变、作者不会因此收到任何通知。这里能查的是前者，后者要数库，归冒烟脚本。
    const after = await call<ItemView>('GET', `/api/items/${seed.foundId}`)
    expect(after.status).toBe(before.status)
    expect(after.contact_locked, '举报之后联系方式的可见性不该有任何变化').toBe(true)
  })

  it('同一人对同一帖重复举报 → REPORT_DUPLICATE（ReportDialog 的重复分支就靠这个码）', async () => {
    await expectCode(Code.REPORT_DUPLICATE, () =>
      call('POST', `/api/items/${seed.foundId}/report`, seed.tokenA, { reason_code: 'spam' }),
    )
  })

  it('换一个理由重复举报，同样被拒 —— 去重看的是人+帖，不是人+帖+理由', async () => {
    await expectCode(Code.REPORT_DUPLICATE, () =>
      call('POST', `/api/items/${seed.foundId}/report`, seed.tokenA, {
        reason_code: 'harassment',
        detail: '换个理由再试一次',
      }),
    )
  })

  it('理由码不在六个之内 → VALIDATION，并把字段名报在 reason_code 上', async () => {
    const e = await expectCode(Code.VALIDATION, () =>
      call('POST', `/api/items/${seed.foundId}/report`, seed.tokenB, { reason_code: 'nonsense' }),
    )
    // 这一条是 ReportDialog 用 REPORT_REASONS 常量而不是自由文本框的原因：
    // 六个码是迁移里的 CHECK，写错一个就是整条举报进不了库。
    expect(e.errorFor('reason_code'), `字段错误没报在 reason_code 上：${JSON.stringify(e.fieldErrors)}`).toBeTruthy()
  })
})
