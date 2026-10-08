// src/api/contract.admin.live.test.ts —— 片 6 的四条只读端点：#34 #37 #48 #50。
//
// 这一族为什么必须真打，三条各有各的理由：
//   ① 那道门挂在**路由组**上（router.go 的 admin 组 = jwt + RequireAdmin），不在每个 handler 里。
//      msw 测不出「某条路由少挂了一个中间件」，因为它根本没有中间件；
//      只有真实 router 能证明「这十七条路径共用一道门，包括那条写操作」。
//   ② #37 的两条等式是 SQL 的产物（local+hduhelp = total，lost+found = open+closed+deleted）。
//      假响应是照着前端类型手写的，等式会永远成立，于是那条断言什么都测不到。
//   ③ 三个枚举筛选参数进的是 WHERE 而不是 INSERT：**拼错一个字母不报错，只是列表空了**，
//      而管理员会以为「没人做过这件事」。后端到底回 VALIDATION 还是回空页，
//      决定了这一页出错时人看见的是哪一种假象 —— 这一条只能问真后端。
//
// 跑法：
//   第一节（门 + 分页上限）常驻：后端起在 8080，然后
//     npx vitest run --config vitest.live.config.ts src/api/contract.admin.live.test.ts
//   第二节需要开发库里有一个 admin 账号：
//     LIVE_ADMIN_USER=…… LIVE_ADMIN_PASS=…… npx vitest run --config vitest.live.config.ts 同上
//   ⚠ 那两个环境变量是这个文件唯一的凭据来源 —— 真实口令绝不写进来（这个文件是要提交的）。
//      缺省时第二节整节以「跳过」的形式留在报告里，而不是变成一片假绿。
//
// 它会在开发库里留下一个本地用户（第一节那个用来撞 FORBIDDEN 的），
// 理由和另外几个 live 文件一样：不复用固定账号，免得两次跑互相踩。
import { beforeAll, describe, expect, it } from 'vitest'
import { ApiError, createHttp } from './client'
import { Code } from './codes'
import type {
  AdminActionRow,
  AdminReportRow,
  AdminStats,
  AdminUserRow,
  Page,
  UserView,
} from './types'

const BASE = process.env.LIVE_API_BASE ?? 'http://localhost:8080'
const live = createHttp(BASE)

const ADMIN_USER = process.env.LIVE_ADMIN_USER ?? ''
const ADMIN_PASS = process.env.LIVE_ADMIN_PASS ?? ''
const hasAdmin = ADMIN_USER !== '' && ADMIN_PASS !== ''

/** 和 expectExactKeys 配对用的那一半：形状断言要的是「不多不少」，只查缺字段的话，
 *  后端多泄漏一列（比如 #34 的 phone）正好是这一族最需要发现的问题。 */
function expectAbsent(obj: object, keys: string[]): void {
  const leaked = keys.filter((k) => k in obj)
  expect(leaked, `不该出现的字段：${leaked.join(', ')}`).toEqual([])
}

/** 键集合精确比对：排序之后逐个比，多一个少一个都算不同。 */
function expectExactKeys(obj: object, keys: string[]): void {
  expect(Object.keys(obj).sort()).toEqual([...keys].sort())
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

const TAG = `adm${Date.now()}`
const PASSWORD = 'correct-horse-battery'

/** 把一条分页端点**读满**。只在核对「这个数是怎么算出来的」那一类断言时用：
 *  拿一页里的行数当全表，是一条会在数据变多那天悄悄失效的断言。 */
async function listAll<T>(token: string, path: string): Promise<T[]> {
  const out: T[] = []
  const sep = path.includes('?') ? '&' : '?'
  for (let page = 1; page <= 20; page++) {
    const res = await call<Page<T>>('GET', `${path}${sep}page=${page}&page_size=100`, token)
    out.push(...res.list)
    if (out.length >= res.total) return out
  }
  throw new Error(`${path} 读了 20 页还没读满（已经 ${out.length} 行），开发库不该大到需要这里翻页`)
}

/** 四条只读路径 + 一条写路径。写路径也在这一族里过门：#43 即使请求体是空的，
 *  也必须先被 RequireAdmin 拦下来，而不是先掉进 reason/ids 的校验里 ——
 *  「门在组上」的意思就是不合法的普通请求连校验层都到不了。 */
const READ_PATHS = ['/api/admin/users', '/api/admin/stats', '/api/admin/reports', '/api/admin/actions']

const seed = {
  /** 本地注册的普通用户：有 token、role=user，专门用来撞 FORBIDDEN */
  tokenUser: '',
  userId: 0,
  /** 第二节才填 */
  tokenAdmin: '',
  /** 第一节之后抓住的当前留痕行数，用来钉「这几条路径上一个字都没写」 */
  actionsBefore: 0,
}

beforeAll(async () => {
  await call('GET', '/api/health')

  // 前置条件：这一族的路由是 M6 才有的。打到 M6 之前的二进制上时，四条路径全是
  // NOT_FOUND（gin 的 NoRoute），于是九条断言一起红，报出来的是「期望 UNAUTHORIZED，
  // 实际 NOT_FOUND」—— 看着像鉴权坏了，其实是那个进程没带这些路由（本机实测：8080 上
  // 那个 10/7 起的 go run 子进程就是 M6 之前的）。这里先探一次，把真原因一句话说清楚。
  // ⚠ 不能用 expectCode 来探：它撞见 NOT_FOUND 时抛的是断言失败，拿不到那个码。
  try {
    await call('GET', '/api/admin/stats')
    throw new Error('/api/admin/stats 匿名就读到了数据，这一族后面的断言都不用跑了')
  } catch (e) {
    if (e instanceof ApiError && e.code === Code.NOT_FOUND) {
      throw new Error(
        `${BASE} 上的后端没有 /api/admin/*（NOT_FOUND）—— 那是 M6 之前的二进制。` +
          '重启后端，或用 PORT=8081 go run ./cmd/server 起一个新的，再把 LIVE_API_BASE 指过去。',
      )
    }
    if (!(e instanceof ApiError) || e.code !== Code.UNAUTHORIZED) throw e
  }

  const reg = await call<{ id: number }>('POST', '/api/auth/register', undefined, {
    username: `${TAG}probe`,
    password: PASSWORD,
    nickname: `${TAG} 普通用户`,
  })
  const login = await call<{ token: string }>('POST', '/api/auth/login', undefined, {
    username: `${TAG}probe`,
    password: PASSWORD,
  })
  seed.tokenUser = login.token
  seed.userId = reg.id
})

describe('没有 admin 身份时这一族整族关门（不需要凭据，永远真打）', () => {
  it.each(READ_PATHS)('匿名 GET %s 是 401 那一款：UNAUTHORIZED', async (path) => {
    const e = await expectCode(Code.UNAUTHORIZED, () => call('GET', path))
    expect(e.httpStatus).toBe(401)
    // 没登录时 data 里不该有任何统计碎片 —— 这一族的每一格都是全站数据。
    expect(e.fieldErrors).toEqual([])
  })

  it.each(READ_PATHS)('普通用户 GET %s 是 FORBIDDEN，而且不是 UNAUTHORIZED', async (path) => {
    const e = await expectCode(Code.FORBIDDEN, () => call('GET', path, seed.tokenUser))
    expect(e.httpStatus).toBe(403)
  })

  it('FORBIDDEN 不是「token 坏了」：同一个 token 打 #3 是通的', async () => {
    const me = await call<UserView>('GET', '/api/auth/me', seed.tokenUser)
    expect(me.id).toBe(seed.userId)
    // 这一条是整个 describe 的对照：少了它，四个 FORBIDDEN 可能被读成鉴权整体失败，
    // 而真实情况是「登录成功、角色不够」，这两种故障要处理的东西完全不同。
    expect(me.role).toBe('user')
  })

  it('那条写操作也吃 FORBIDDEN，而且拦在它自己的校验之前', async () => {
    // 请求体是空的：如果门不在组上，后端会先报 VALIDATION/reason。
    // 拿到 FORBIDDEN 就证明 RequireAdmin 在 reason 校验之前跑过。
    const e = await expectCode(Code.FORBIDDEN, () =>
      call('POST', '/api/admin/items/takedown', seed.tokenUser, { ids: [], reason: '' }),
    )
    expect(e.httpStatus).toBe(403)
  })

  it('批量下架那一页向 #14 要的 page_size=100 在后端允许的范围内', async () => {
    // TakedownTab 一次拉 100 条候选（一个人五十条 spam 摊在三页里就聚不齐）。
    // 如果后端的 maxPageSize 其实小于 100，这一页打开就是 VALIDATION，
    // 而它在 msw 上永远测不出来 —— 假响应不会拒收 100。
    const page = await call<Page<never>>('GET', '/api/items?page=1&page_size=100')
    expect(page.page_size).toBe(100)

    const e = await expectCode(Code.VALIDATION, () => call('GET', '/api/items?page_size=101'))
    expect(e.errorFor('page_size'), `字段级错误没落在 page_size 上：${JSON.stringify(e.fieldErrors)}`).toBeDefined()
  })
})

it(`admin 凭据：${hasAdmin ? '已提供，第二节真打' : '未提供 —— 第二节整节跳过（这是跳过，不是通过）'}`, () => {
  if (!hasAdmin) {
    console.warn(
      '⚠ 未设置 LIVE_ADMIN_USER / LIVE_ADMIN_PASS：#34 #37 #48 #50 的形状、排序、枚举校验一行都没真打。' +
        ' 开发库里现成的 admin 可以直接用，或在 pgAdmin 里把某个本地账号的 role 提成 admin。',
    )
  }
  expect(hasAdmin).toBe(ADMIN_USER !== '' && ADMIN_PASS !== '')
})

describe.skipIf(!hasAdmin)('#34 GET /api/admin/users（admin 真打）', () => {
  beforeAll(async () => {
    // vitest 4 的 describe.skipIf 只跳测试、不跳钩子：没有凭据时这里照跑，
    // 报出来的是「登不上」，看着像 admin 门坏了，其实只是没人给 LIVE_ADMIN_USER。
    if (!hasAdmin) return
    let token = ''
    try {
      const r = await call<{ token: string }>('POST', '/api/auth/login', undefined, {
        username: ADMIN_USER,
        password: ADMIN_PASS,
      })
      token = r.token
    } catch (err) {
      throw new Error(
        `LIVE_ADMIN_USER/LIVE_ADMIN_PASS 登不上（${err instanceof ApiError ? err.code : '?'}）。` +
          ' 这一节需要的是一个**本地账号**（auth_source=hduhelp 的没有口令）。',
      )
    }
    const me = await call<UserView>('GET', '/api/auth/me', token)
    if (me.role !== 'admin') {
      throw new Error(
        `账号 ${ADMIN_USER}（id=${me.id}）的 role 是 ${me.role}，不是 admin。` +
          ' 第二节要的是能进后台的账号：在 pgAdmin 里把这一个账号提成 admin 再跑，别拿口令猜。',
      )
    }
    seed.tokenAdmin = token

    const stats = await call<AdminStats>('GET', '/api/admin/stats', token)
    seed.actionsBefore = stats.admin_actions_count
  })

  it('一行的键是九个，而且没有 phone / email / password_hash', async () => {
    const page = await call<Page<AdminUserRow>>('GET', '/api/admin/users?page_size=5', seed.tokenAdmin)
    expectExactKeys(page, ['list', 'total', 'page', 'page_size'])
    if (page.list.length === 0) throw new Error('开发库里一个用户都没有，这一节的形状断言没法做')
    expectExactKeys(page.list[0], [
      'id',
      'username',
      'nickname',
      'real_name',
      'auth_source',
      'role',
      'status',
      'credit_score',
      'created_at',
    ])
    expectAbsent(page.list[0], ['phone', 'email', 'password_hash', 'sso_user_id'])
  })

  it('默认包含被封禁的账号（治理的起点不能把人藏起来）', async () => {
    // 用 total 相加而不是在首页里找 banned：库里超过 100 个账号时「这一页碰巧没有」
    // 和「后端默认把人筛掉了」长得一模一样，那种断言会在数据变多那天变成假故障。
    const all = await call<Page<AdminUserRow>>('GET', '/api/admin/users?page_size=1', seed.tokenAdmin)
    const active = await call<Page<AdminUserRow>>('GET', '/api/admin/users?status=active&page_size=1', seed.tokenAdmin)
    const banned = await call<Page<AdminUserRow>>('GET', '/api/admin/users?status=banned&page_size=1', seed.tokenAdmin)
    expect(active.total + banned.total, '不筛的 total 不等于两种 status 之和：要么有隐式默认筛，要么 status 没筛对').toBe(
      all.total,
    )

    // 我们自己刚注册的那个账号，在不筛的那一页里必须查得到（它是 active）。
    const found = await call<Page<AdminUserRow>>('GET', `/api/admin/users?q=${TAG}`, seed.tokenAdmin)
    expect(found.list.find((r) => r.id === seed.userId)?.status).toBe('active')
  })

  it('最新注册的在最上面：created_at 不递增', async () => {
    const page = await call<Page<AdminUserRow>>('GET', '/api/admin/users?page_size=20', seed.tokenAdmin)
    const times = page.list.map((r) => Date.parse(r.created_at))
    for (let i = 1; i < times.length; i++) {
      expect(times[i - 1], `第 ${i} 行比第 ${i - 1} 行新，排序不是 created_at DESC`).toBeGreaterThanOrEqual(times[i])
    }
  })

  it('q 命中我们刚注册的那个账号，而且命中的每一行都对得上', async () => {
    const page = await call<Page<AdminUserRow>>('GET', `/api/admin/users?q=${TAG}`, seed.tokenAdmin)
    expect(page.total).toBeGreaterThanOrEqual(1)
    const hit = page.list.find((r) => r.id === seed.userId)
    if (!hit) throw new Error(`q=${TAG} 没搜到刚注册的 #${seed.userId}，keyword 那一支没打中 username/nickname`)
    expect(hit.nickname).toContain(TAG)
  })

  it('role / status 拼错是 VALIDATION，不是安静地给一个空列表', async () => {
    const e1 = await expectCode(Code.VALIDATION, () => call('GET', '/api/admin/users?role=admins', seed.tokenAdmin))
    expect(e1.errorFor('role'), `字段级错误没落在 role 上：${JSON.stringify(e1.fieldErrors)}`).toBeDefined()

    const e2 = await expectCode(Code.VALIDATION, () => call('GET', '/api/admin/users?status=banded', seed.tokenAdmin))
    expect(e2.errorFor('status'), `字段级错误没落在 status 上：${JSON.stringify(e2.fieldErrors)}`).toBeDefined()
  })

  it('做这四条只读请求之后，留痕行数一点没变', async () => {
    for (const p of READ_PATHS) await call('GET', p, seed.tokenAdmin)
    const after = await call<AdminStats>('GET', '/api/admin/stats', seed.tokenAdmin)
    // #50 那本账是「唯一的防线是事后可追责」的证据，所以读它不能产生新的账。
    // ⚠ 这条判据的前提是**整个 live 套件串行**（vitest.live.config.ts 的 fileParallelism: false）：
    //   字典那一份文件每建/删一条就写一行 admin_actions，并行时会把这里踩成「多了两行」的假红。
    expect(after.admin_actions_count).toBe(seed.actionsBefore)
  })
})

describe.skipIf(!hasAdmin)('#37 #48 #50（admin 真打）', () => {
  let token = ''

  beforeAll(async () => {
    if (!hasAdmin) return
    const r = await call<{ token: string }>('POST', '/api/auth/login', undefined, {
      username: ADMIN_USER,
      password: ADMIN_PASS,
    })
    token = r.token
  })

  it('#37 是七个键的两层对象，而且两条等式成立', async () => {
    const s = await call<AdminStats>('GET', '/api/admin/stats', token)
    expectExactKeys(s, [
      'users_count',
      'items_count',
      'returns_count',
      'contact_views_count',
      'reports_count',
      'admin_actions_count',
      'today_items_count',
    ])
    expectExactKeys(s.users_count, ['total', 'local', 'hduhelp', 'banned'])
    expectExactKeys(s.items_count, ['lost', 'found', 'open', 'closed', 'deleted'])
    expectExactKeys(s.returns_count, ['pending', 'confirmed', 'rejected'])
    expectExactKeys(s.reports_count, ['open', 'resolved', 'dismissed'])

    // auth_source 的 CHECK 只有 local / hduhelp 两个值，所以这一条是恒等式而不是巧合。
    expect(s.users_count.local + s.users_count.hduhelp).toBe(s.users_count.total)
    // items 没有第三类、也没有第四种状态：两组数各自等于同一个 total（JSON 里没给出 total，
    // 所以这一页想显示总量只能取其中一组之和 —— StatsTab 的文案就是照这个写的）。
    expect(s.items_count.lost + s.items_count.found).toBe(
      s.items_count.open + s.items_count.closed + s.items_count.deleted,
    )
  })

  it('#48 一行的键是八个，item 三格、reporter 两格', async () => {
    const page = await call<Page<AdminReportRow>>('GET', '/api/admin/reports?page_size=20', token)
    expectExactKeys(page, ['list', 'total', 'page', 'page_size'])
    if (page.list.length === 0) throw new Error('开发库里一条举报都没有：这一节的形状断言没法做')

    const row = page.list[0]
    expectExactKeys(row, [
      'id',
      'item',
      'reporter',
      'reason_code',
      'detail',
      'status',
      'report_count_on_item',
      'created_at',
    ])
    expectExactKeys(row.item, ['id', 'title', 'status'])
    expectExactKeys(row.reporter, ['id', 'nickname'])
    // 计划 §4 那一行只给昵称：reporter_id 不在对外形状里，
    // 少一列比多一列好修，所以这一条是「不许顺手加」的哨兵。
    expectAbsent(row.reporter, ['username', 'real_name', 'phone'])

    const times = page.list.map((r) => Date.parse(r.created_at))
    for (let i = 1; i < times.length; i++) {
      expect(times[i - 1], `第 ${i} 行比第 ${i - 1} 行新：排序不是按时间`).toBeGreaterThanOrEqual(times[i])
    }
  })

  it('report_count_on_item 数的是这条帖子上**当前待处理**的举报条数（全表，不受分页影响）', async () => {
    // 这条断言是这一节里唯一一处会**改变文案**的：后端那支相关子查询的别名就叫
    // open_count_on_item（WHERE r2.item_id = r.item_id AND r2.status = 'open'），
    // 所以它既不是「本页几条」也不是「被举报过几次」—— 一条已处置的行上它可以是 0。
    // 这里把整表读完，用「按 item_id 数 open 行」这个公式逐条对上，而不是猜一个数。
    const open = await listAll<AdminReportRow>(token, '/api/admin/reports?status=open')
    const expected = new Map<number, number>()
    for (const r of open) expected.set(r.item.id, (expected.get(r.item.id) ?? 0) + 1)

    // ① 同一个 item 的所有行必须是同一个数（子查询只按 item_id 走，与这一行自己无关）。
    const all = await listAll<AdminReportRow>(token, '/api/admin/reports')
    const seen = new Map<number, number>()
    for (const r of all) {
      const prev = seen.get(r.item.id)
      if (prev !== undefined) expect(r.report_count_on_item, `#${r.id} 和同一条帖子上的另一行给了不同的数`).toBe(prev)
      seen.set(r.item.id, r.report_count_on_item)
    }
    // ② open 行至少数得到自己。
    for (const r of open) expect(r.report_count_on_item).toBeGreaterThanOrEqual(1)
    // ③ 那个数就等于「这条帖子上 open 行的条数」—— 公式核对，不是巧合。
    for (const r of open) expect(r.report_count_on_item, `#${r.id} 所在帖子的 open 行数对不上`).toBe(expected.get(r.item.id))
  })

  it('#48 的 status / reason_code 拼错也是 VALIDATION', async () => {
    const e1 = await expectCode(Code.VALIDATION, () => call('GET', '/api/admin/reports?status=all', token))
    expect(e1.errorFor('status')).toBeDefined()

    const e2 = await expectCode(Code.VALIDATION, () => call('GET', '/api/admin/reports?reason_code=spamming', token))
    expect(e2.errorFor('reason_code')).toBeDefined()
  })

  it('#48 的 status=open 那一筛筛出来的全是 open（筛选真的进了 WHERE）', async () => {
    const page = await call<Page<AdminReportRow>>('GET', '/api/admin/reports?status=open&page_size=100', token)
    for (const r of page.list) expect(r.status).toBe('open')
  })

  it('#50 一行的键是八个：detail 恒为对象，admin 可能为 null', async () => {
    const page = await call<Page<AdminActionRow>>('GET', '/api/admin/actions?page_size=50', token)
    expectExactKeys(page, ['list', 'total', 'page', 'page_size'])
    if (page.list.length === 0) throw new Error('开发库里一行留痕都没有：这一节的形状断言没法做')

    for (const row of page.list) {
      expectExactKeys(row, ['id', 'admin', 'action', 'target_type', 'target_id', 'reason', 'detail', 'created_at'])
      // detail 是 JSONB 折成对象，不是「一串没解析的 JSON 文本」，也不是 null：
      // ActionsTab 那段解析代码只在拿到对象时才成立。
      expect(typeof row.detail, `#${row.id} 的 detail 不是对象：${JSON.stringify(row.detail)}`).toBe('object')
      expect(Array.isArray(row.detail)).toBe(false)
      if (row.admin) expectExactKeys(row.admin, ['id', 'nickname'])
    }
    // 白名单外的一种都不该出现：action 的十二个取值是迁移里那条 CHECK 的镜像。
    const allowed = new Set<string>([
      'item_takedown',
      'item_restore',
      'image_takedown',
      'return_takedown',
      'item_edit',
      'user_ban',
      'user_unban',
      'user_role_change',
      'warning_sent',
      'report_resolved',
      'dict_create',
      'dict_delete',
    ])
    for (const row of page.list) expect(allowed.has(row.action), `没见过的 action：${row.action}`).toBe(true)
  })

  it('#50 按 action 筛之后只剩那一种', async () => {
    const page = await call<Page<AdminActionRow>>('GET', '/api/admin/actions?action=item_takedown&page_size=100', token)
    for (const row of page.list) expect(row.action).toBe('item_takedown')
  })

  it('#50 的 admin_id / target_id 传 0 或非数字是 VALIDATION，而不是「不筛」', async () => {
    // 前端把空串折成「不带这个键」，所以 0 只能来自人真的输了个 0。
    const e1 = await expectCode(Code.VALIDATION, () => call('GET', '/api/admin/actions?target_id=0', token))
    expect(e1.errorFor('target_id')).toBeDefined()

    const e2 = await expectCode(Code.VALIDATION, () => call('GET', '/api/admin/actions?admin_id=abc', token))
    expect(e2.errorFor('admin_id')).toBeDefined()
  })

  it('#50 筛不到不等于 404：给一个不存在的 id 得到的是空列表', async () => {
    const page = await call<Page<AdminActionRow>>('GET', '/api/admin/actions?admin_id=9223372036854775807', token)
    expect(page.list).toEqual([])
    expect(page.total).toBe(0)
  })

  it('#50 的 action / target_type 拼错是 VALIDATION', async () => {
    const e1 = await expectCode(Code.VALIDATION, () => call('GET', '/api/admin/actions?action=item_delete', token))
    expect(e1.errorFor('action')).toBeDefined()

    const e2 = await expectCode(Code.VALIDATION, () => call('GET', '/api/admin/actions?target_type=posts', token))
    expect(e2.errorFor('target_type')).toBeDefined()
  })
})
