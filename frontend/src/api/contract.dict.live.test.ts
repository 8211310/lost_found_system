// src/api/contract.dict.live.test.ts —— 片 7d：#9–#12 那四条写字典的操作 + #39 那一条读配置的。
//
// 这一族为什么必须真打，三条各占一个别处占不到的面：
// ① #39 **不在** /api/admin 那个组里（router.go 把它挂在 api 上、自带 jwt + RequireAdmin，
//    外面还套着 `if !cfg.IsProd()`）。msw 里没有中间件，所以「这条路由到底挂没挂门」
//    在前端单测里永远是绿的；而 DebugTab 那两段不同的文案（404=这条路由在这个环境压根不存在、
//    403=路由在但这一关没过）就建在这个分别上 —— 只有真实 router 能给得出这个分别。
// ② #9–#12 是全系统唯一会**改别人下拉框**的写操作。建错一条不是这一页报错，
//    是全站每个人发帖时多一个错选项、少一个正确选项，而且没人知道是谁改的。
// ③ level 是 parent_id 的函数、分类两级 / 地点三级、同名撞的是那个 partial unique index、
//    删不掉的两种障碍各数各的（子节点数 vs 帖子引用数）—— 这些全是 SQL 和 CHECK 的产物。
//    手写假响应只会照抄前端自己期望的形状，于是等式和上限都永远成立。
//
// ⚠ 这个文件会写开发库，所以它自己收拾自己：每一条建出来的条目都在同一个文件里删掉 ——
//   beforeAll 建、afterAll 删，中间某个断言红了也照样删（afterAll 不看前面的结果）。
//   唯一收不回来的是留痕：#9–#12 每执行一次就往 admin_actions 追加一行，而那张表按设计只进不出
//   （那是它存在的唯一理由）。跑一次多出十几行 dict_create / dict_delete 是预期，不是没打扫干净。
//   所以这一族的 E 节直接去 #50 里查那两行，并把「detail 里带着那个已经删掉的名字」当成一条契约。
//
// 跑法（和 contract.admin.live.test.ts 一样两节）：
//   第一节只需要后端在跑：
//     npx vitest run --config vitest.live.config.ts src/api/contract.dict.live.test.ts
//   第二节需要开发库里有一个**本地** admin 账号（auth_source=hduhelp 的那种没有口令）：
//     LIVE_ADMIN_USER=…… LIVE_ADMIN_PASS=…… npx vitest run --config vitest.live.config.ts 同上
//   ⚠ 那两个环境变量是这个文件唯一的凭据来源，真实口令绝不写进来（这个文件是要提交的）。
//     缺省时第二节整节以「跳过」的形式留在报告里，而不是变成一片假绿。
import axios from 'axios'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ApiError, createHttp } from './client'
import { Code } from './codes'
import { MAX_CATEGORY_NAME_RUNES, MAX_LOCATION_NAME_RUNES, MAX_REASON_RUNES } from './admin'
import type { AdminActionRow, CategoryNode, DebugConfig, DictResult, LocationNode, Page, UserView } from './types'

const BASE = process.env.LIVE_API_BASE ?? 'http://localhost:8080'
const live = createHttp(BASE)

const ADMIN_USER = process.env.LIVE_ADMIN_USER ?? ''
const ADMIN_PASS = process.env.LIVE_ADMIN_PASS ?? ''
const hasAdmin = ADMIN_USER !== '' && ADMIN_PASS !== ''

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

function expectExactKeys(obj: object, keys: string[]): void {
  expect(Object.keys(obj).sort()).toEqual([...keys].sort())
}

function expectAbsent(obj: object, keys: string[]): void {
  const leaked = keys.filter((k) => k in obj)
  expect(leaked, `不该出现的字段：${leaked.join(', ')}`).toEqual([])
}

/** 绕过 client.ts 那层解包，直接看**线上的信封**。
 *  「未授权时响应体里到底有没有配置」这件事只能在 wire 层问：ApiError 只留下 code / message /
 *  字段级错误，一个 data 里塞了整份打码配置的 401，从 ApiError 上是看不出任何异常的。
 *  而 #39 是全系统唯一把运行时配置整体吐到 HTTP 上的端点，这一条正是要看的。 */
async function rawCall(method: string, path: string, token?: string) {
  return axios.request({
    baseURL: BASE,
    method,
    url: path,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    validateStatus: () => true,
  })
}

/** #7 / #8 是递归树，而我们要找的条目藏在第二、三层里。 */
function findById<T extends { id: number; children: T[] }>(nodes: T[], id: number): T | null {
  for (const n of nodes) {
    if (n.id === id) return n
    const hit = findById(n.children, id)
    if (hit) return hit
  }
  return null
}

const TAG = `dict${Date.now()}`
const PASSWORD = 'correct-horse-battery'
/** 一个绝对不可能是字典 id 的 id，用来打「这一行不存在」那两条。
 *  取 `Number.MAX_SAFE_INTEGER` 而不是 int64 的上界：后者在 JS 里是个会**悄悄变形**的字面量
 *  （写下来的和发出去的不是同一个数），而 oxlint 会把它报成 no-loss-of-precision ——
 *  一个「不存在的 id」测试如果发的是一个被四舍五入过的 id，它测的东西就没人说得清了。 */
const MISSING_ID = Number.MAX_SAFE_INTEGER
/** 建条目时那个必填的理由。留痕会原样存下它，所以这一句写得像人话一点，
 *  别到时候在 #50 里翻到一排「test test test」。 */
const REASON = `${TAG}：live 契约建的测试条目，跑完就删`

/** 名字长度那两条断言用的两个长度：一个是「分类的列宽装不下、地点的装得下」，
 *  一个是「连地点都装不下」。TAG 打头，保证两次跑不会撞同名兄弟。 */
function runes(n: number): string {
  return (TAG + '测'.repeat(120)).slice(0, n)
}

const seed = {
  tokenUser: '',
  userId: 0,
  tokenAdmin: '',
}

/** 第二节的每一页都要一个 admin token，而登录只该判一次：
 *  「登不上」和「这个角色不是 admin」是两种完全不同的修法，报错必须先把那一句说清楚。 */
let adminToken: Promise<string> | null = null
function loginAdmin(): Promise<string> {
  if (!adminToken) {
    adminToken = (async () => {
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
            ' 迁移里没有种子 admin，所以只能拿 pgAdmin 把一个本地账号提成 admin 再来跑。',
        )
      }
      seed.tokenAdmin = token
      return token
    })()
  }
  return adminToken
}

/** ⚠ vitest 4 里 `describe.skipIf(true)` 只跳测试、**不跳 beforeAll**（实测：本机 4.1.11，
 *  没设凭据时每一节的登录钩子照跑，报出来的是「用户名或密码错误」，
 *  看着像后端把 admin 门弄坏了，其实只是没人给凭据）。所以第二节每一个 beforeAll
 *  的第一行都是这句 —— 少了它，这个文件在没凭据的机器上是红的，而红色会让人开始忽略红色。 */
function skipAdmin(): boolean {
  return !hasAdmin
}

beforeAll(async () => {
  await call('GET', '/api/health')

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

describe('没有 admin 身份时这五条路径关门（不需要凭据，永远真打）', () => {
  // 四条写字典的路径 + 那条读配置的。前四条的请求体一律给**空的** {}：
  // 如果门不在组上，后端会先撞进 reason/name 的校验里报 VALIDATION —— 那时这一节全红，
  // 而报出来的「VALIDATION」看着像后端在校验参数，其实是有人在 handler 里漏了鉴权。
  const GATED: { method: string; path: string }[] = [
    { method: 'POST', path: '/api/admin/categories' },
    { method: 'DELETE', path: '/api/admin/categories/1' },
    { method: 'POST', path: '/api/admin/locations' },
    { method: 'DELETE', path: '/api/admin/locations/1' },
  ]

  it.each(GATED)('匿名 $method $path 是 401 那一款：UNAUTHORIZED', async ({ method, path }) => {
    const e = await expectCode(Code.UNAUTHORIZED, () => call(method, path, undefined, {}))
    expect(e.httpStatus).toBe(401)
    expect(e.fieldErrors, '关门那种错不该带字段级错误').toEqual([])
  })

  it.each(GATED)('普通用户 $method $path 是 FORBIDDEN，而且校验根本没跑到', async ({ method, path }) => {
    const e = await expectCode(Code.FORBIDDEN, () => call(method, path, seed.tokenUser, {}))
    expect(e.httpStatus).toBe(403)
  })

  it('FORBIDDEN 不是「token 坏了」：同一个 token 打 #3 是通的', async () => {
    const me = await call<UserView>('GET', '/api/auth/me', seed.tokenUser)
    expect(me.id).toBe(seed.userId)
    expect(me.role).toBe('user')
  })

  it('#39 匿名是 401，而且 wire 层的 data 里一个字都没有', async () => {
    const res = await rawCall('GET', '/api/debug/config')
    // 404 只有一种解释：这个后端要么跑的是 prod 配置（router.go 那句 if !cfg.IsProd() 没注册它），
    // 要么是个还没有这条路由的旧二进制。两种都不是「门坏了」，但都需要先把进程弄对再跑这一节。
    if (res.status === 404) {
      throw new Error(
        `${BASE} 上 GET /api/debug/config 返回 404 —— 这条路由没被注册。` +
          '要么那个进程是 M7 之前的旧二进制，要么它跑的是 prod 配置（生产环境本来就不注册这一条）。' +
          '这一节的其余断言需要的是一个 ENV=dev 的后端。',
      )
    }
    expect(res.status).toBe(401)
    expect(res.data.code).toBe(Code.UNAUTHORIZED)
    expect(res.data.data, `未授权时 data 里不该有任何东西：${JSON.stringify(res.data.data)}`).toBeNull()
    // 「敏感列已经打过码」不够 —— 未授权时要的是**整包都不该出现**。
    // 所以这里查的是键名本身：Redacted() 那一份的键一个都不该出现在响应体的任何一层里。
    const wire = JSON.stringify(res.data)
    for (const key of ['jwt_secret', 'db_password', 'hduhelp_app_secret', 'sso_state_key', 'match_show_threshold']) {
      expect(wire, `未授权的响应体里出现了 ${key}`).not.toContain(key)
    }
  })

  it('#39 普通用户是 FORBIDDEN（它挂在 api 上、不在 admin 组里，但门照样在）', async () => {
    const e = await expectCode(Code.FORBIDDEN, () => call('GET', '/api/debug/config', seed.tokenUser))
    expect(e.httpStatus).toBe(403)
    // 这一条是这一族里唯一一处「门是手写的而不是组给的」，所以它最容易被改漏：
    // router.go 那行是 `api.GET("/debug/config", jwt, middleware.RequireAdmin(), debugH.Get)`，
    // 少了 RequireAdmin 的话这里会从 403 变成 200 —— 一个登录了的普通用户拿到全站配置。
    const res = await rawCall('GET', '/api/debug/config', seed.tokenUser)
    expect(res.data.data).toBeNull()
  })

  it('公开那两棵树不需要身份：#7 / #8 匿名就读得到（字典页签打开时发的就是这两条）', async () => {
    // 这一条看着像废话，但它钉的是「哪几条该开门」的另一半：
    // 同一个文件里五条关门路径全绿的时候，也可能是有人把 #7/#8 一起挂进了 admin 组 ——
    // 那会让发帖表单的下拉框整体变空，而管理后台一切正常。
    const cats = await call<CategoryNode[]>('GET', '/api/categories')
    const locs = await call<LocationNode[]>('GET', '/api/locations')
    expect(Array.isArray(cats)).toBe(true)
    expect(cats.length).toBeGreaterThan(0)
    expect(locs.length).toBeGreaterThan(0)
  })
})

it(`admin 凭据：${hasAdmin ? '已提供，第二节真打' : '未提供 —— 第二节整节跳过（这是跳过，不是通过）'}`, () => {
  if (!hasAdmin) {
    console.warn(
      '⚠ 未设置 LIVE_ADMIN_USER / LIVE_ADMIN_PASS：#9–#12 的形状、两级/三级上限、同名冲突、' +
        '两种删不掉的障碍，以及 #39 那 18 个键，一行都没真打。',
    )
  }
  expect(hasAdmin).toBe(ADMIN_USER !== '' && ADMIN_PASS !== '')
})

describe.skipIf(!hasAdmin)('#9 #10 分类：建 → 公开树里看得见 → 删 → 消失（admin 真打）', () => {
  const L1 = `${TAG}大类`
  const L2 = `${TAG}小类`
  let id1 = 0
  let id2 = 0
  let res1: DictResult | null = null
  let res2: DictResult | null = null

  beforeAll(async () => {
    if (skipAdmin()) return
    const token = await loginAdmin()

    res1 = await call<DictResult>('POST', '/api/admin/categories', token, {
      name: L1,
      sort_order: 900,
      reason: REASON,
    })
    id1 = res1.id
    res2 = await call<DictResult>('POST', '/api/admin/categories', token, {
      name: L2,
      parent_id: id1,
      sort_order: 1,
      reason: REASON,
    })
    id2 = res2.id
  })

  afterAll(async () => {
    // 只打扫剩下的：中间某个断言红了也要删，否则开发库里会攒出一排同名大类，
    // 而下一次跑的「同名冲突」那条就会因为「已经有了」而以另一种原因失败。
    // 已经删掉的再删一次是 409/NOT_FOUND，这里一律吞掉，不掩盖前面真正的失败。
    if (!seed.tokenAdmin) return
    for (const id of [id2, id1]) {
      if (!id) continue
      try {
        await call('DELETE', `/api/admin/categories/${id}`, seed.tokenAdmin, { reason: `${TAG}：收尾` })
      } catch {
        /* 前面那条测试已经删过了 */
      }
    }
  })

  it('一级条目：data 恰好四个键，level=1，而 parent_id 是 null 不是 0', async () => {
    expect(res1).not.toBeNull()
    expectExactKeys(res1!, ['id', 'name', 'level', 'parent_id'])
    expect(res1!.name).toBe(L1)
    expect(res1!.level).toBe(1)
    // 「这个键不存在」「它是 0」「它是 null」是三件事，而后端选的是 null：
    // 0 会被前端当成一个可以点进去的父节点 id。
    expect(res1!.parent_id, '一级条目的 parent_id 必须是 null').toBeNull()
    expect('sort_order' in res1!, 'DictResult 回显了 sort_order：#9 的 data 里没有这一列').toBe(false)
  })

  it('二级条目的 level 是现推的：请求体里没有 level 这个键，返回的却是 2', async () => {
    expect(res2!.level).toBe(2)
    expect(res2!.parent_id).toBe(id1)
  })

  it('这两条现在就挂在公开那棵树（#7）上，父子关系是对的', async () => {
    const tree = await call<CategoryNode[]>('GET', '/api/categories')
    const n1 = findById(tree, id1)
    if (!n1) throw new Error(`#7 里没有刚建的 #${id1}：写字典和读字典不是同一棵树？`)
    expect(n1.level).toBe(1)
    expect(n1.name).toBe(L1)
    const n2 = findById(tree, id2)
    if (!n2) throw new Error(`#7 里没有刚建的子条目 #${id2}`)
    expect(n1.children.map((c) => c.id)).toContain(id2)

    // categories 表根本没有 is_freeform 这一列，#7 的节点因此也不该有：
    // 多出来的一列不会让任何功能坏掉，只会让前端以为「分类也能标记自由输入」。
    expectAbsent(n1, ['is_freeform', 'parent_id', 'is_active'])
  })

  it('第三级建不出来：分类最多两级，而且那个错落在 parent_id 上', async () => {
    const e = await expectCode(Code.VALIDATION, () =>
      call('POST', '/api/admin/categories', seed.tokenAdmin, {
        name: `${TAG}三级`,
        parent_id: id2,
        sort_order: 1,
        reason: REASON,
      }),
    )
    expect(e.errorFor('parent_id'), `字段级错误没落在 parent_id 上：${JSON.stringify(e.fieldErrors)}`).toBeDefined()
    expect(e.message).toContain('2 级')
  })

  it('同一个上级下面重名 → CONFLICT（409），而那句话说的是「同名」不是「冲突」', async () => {
    const e = await expectCode(Code.CONFLICT, () =>
      call('POST', '/api/admin/categories', seed.tokenAdmin, {
        name: L2,
        parent_id: id1,
        sort_order: 2,
        reason: REASON,
      }),
    )
    expect(e.httpStatus).toBe(409)
    // 这一条是这一族里最值得钉的一句：后端把 23505 分成两种说法，
    // 而「同一个上级下面已经有一个同名的分类了」是管理员唯一能照着改的那句。
    expect(e.message, `冲突那句太笼统，管理员会一遍遍重试同一个名字：${e.message}`).toContain('同名')
  })

  it('大类下面还有子节点时删不掉：CATEGORY_IN_USE（409），而且报出的是几个', async () => {
    const e = await expectCode(Code.CATEGORY_IN_USE, () =>
      call('DELETE', `/api/admin/categories/${id1}`, seed.tokenAdmin, { reason: `${TAG}：先试删父` }),
    )
    expect(e.httpStatus).toBe(409)
    // 两种障碍（子节点 / 被帖子引用）管理员接下来要做的事是**相反的**，
    // 所以那句必须分辨得出是哪一种，而不是笼统一句「被引用中」。
    expect(e.message, `删不掉那句该数出子节点：${e.message}`).toContain('1 个子节点')
    expect(e.message).not.toContain('帖子')

    // 挡下来之后那一行必须还在：409 不是「删了一半」。
    const tree = await call<CategoryNode[]>('GET', '/api/categories')
    expect(findById(tree, id1)).not.toBeNull()
  })

  it('删得成的那种：data 是 null，而且 #7 里立刻查不到了', async () => {
    const gone2 = await call<null>('DELETE', `/api/admin/categories/${id2}`, seed.tokenAdmin, {
      reason: `${TAG}：删子`,
    })
    expect(gone2).toBeNull()
    const gone1 = await call<null>('DELETE', `/api/admin/categories/${id1}`, seed.tokenAdmin, {
      reason: `${TAG}：删父`,
    })
    expect(gone1).toBeNull()

    const tree = await call<CategoryNode[]>('GET', '/api/categories')
    expect(findById(tree, id2)).toBeNull()
    expect(findById(tree, id1)).toBeNull()
  })
})

describe.skipIf(!hasAdmin)('#11 #12 地点：三级建到底 + is_freeform + 64 那个列宽（admin 真打）', () => {
  let id1 = 0
  let id2 = 0
  let id3 = 0
  /** 这一节里因为别的断言而临时建出来的条目，一律记在这里，afterAll 统一删。 */
  const extra: number[] = []
  const NAME_33 = runes(MAX_CATEGORY_NAME_RUNES + 1)
  const NAME_65 = runes(MAX_LOCATION_NAME_RUNES + 1)

  async function mk(name: string, parentId?: number, freeform = false): Promise<DictResult> {
    const res = await call<DictResult>('POST', '/api/admin/locations', seed.tokenAdmin, {
      name,
      ...(parentId ? { parent_id: parentId } : {}),
      sort_order: 900,
      is_freeform: freeform,
      reason: REASON,
    })
    return res
  }

  async function rm(id: number, reason: string): Promise<void> {
    await call('DELETE', `/api/admin/locations/${id}`, seed.tokenAdmin, { reason })
  }

  beforeAll(async () => {
    if (skipAdmin()) return
    // 自己登一次，而不是蹭上一节留在 seed.tokenAdmin 里的那个：
    // 单独 `-t` 跑这一节时「蹭」会变成「拿着空 token 打后端」，报出来的是一串 401。
    await loginAdmin()
    id1 = (await mk(`${TAG}校区`, undefined, true)).id
    id2 = (await mk(`${TAG}楼`, id1)).id
    id3 = (await mk(`${TAG}层`, id2)).id
  })

  afterAll(async () => {
    if (!seed.tokenAdmin) return
    // 先删临时条目，再从最里层往外删那一条链（反着删才不会被子节点挡住）。
    for (const id of extra) {
      try {
        await rm(id, `${TAG}：收尾`)
      } catch {
        /* 吞掉，理由见上面那个 afterAll */
      }
    }
    for (const id of [id3, id2, id1]) {
      if (!id) continue
      try {
        await rm(id, `${TAG}：收尾`)
      } catch {
        /* 同上 */
      }
    }
  })

  it('三级建得出来：level 一路是 1、2、3，而第四级被同一句理由挡住', async () => {
    const l4 = await expectCode(Code.VALIDATION, () => mk(`${TAG}第四级`, id3))
    expect(l4.errorFor('parent_id')).toBeDefined()
    expect(l4.message, `地点的上限那句没写 3 级：${l4.message}`).toContain('3 级')
  })

  it('is_freeform 会原样回来：#8 那一行的这一列就是发过去的那个值', async () => {
    const tree = await call<LocationNode[]>('GET', '/api/locations')
    const n1 = findById(tree, id1)
    if (!n1) throw new Error(`#8 里没有刚建的 #${id1}`)
    // 这一列决定级联组件允许不允许在选完这一项之后再手打一个字，
    // 传过去丢了的话「其他」那一类就永远选不中 —— 静默失效，没人会报错。
    expect(n1.is_freeform).toBe(true)
    const n2 = findById(tree, id2)
    expect(n2?.is_freeform).toBe(false)
  })

  it('名字列宽两张表不一样：分类 32 拒的那个名字，地点 64 收', async () => {
    expect(MAX_CATEGORY_NAME_RUNES).toBeLessThan(MAX_LOCATION_NAME_RUNES)

    // 同一个名字发给分类：撞的是 categories.name 的 VARCHAR(32)。
    const tooLong = await expectCode(Code.VALIDATION, () =>
      call('POST', '/api/admin/categories', seed.tokenAdmin, { name: NAME_33, sort_order: 1, reason: REASON }),
    )
    expect(tooLong.errorFor('name'), `超长那句没落在 name 上：${JSON.stringify(tooLong.fieldErrors)}`).toBeDefined()
    expect(tooLong.message + JSON.stringify(tooLong.fieldErrors)).toContain(String(MAX_CATEGORY_NAME_RUNES))

    // 同一个名字发给地点：这一边必须收 —— 它证明 32 和 64 是两个数，不是一个数抄了两遍。
    const fits = await mk(NAME_33)
    extra.push(fits.id)
    expect(fits.name).toBe(NAME_33)

    // 再长一点，连地点都装不下。
    const tooLongLoc = await expectCode(Code.VALIDATION, () => mk(NAME_65))
    expect(tooLongLoc.errorFor('name')).toBeDefined()
  })

  it('DELETE 连请求体都不给：VALIDATION 停在 JSON 解析那一步，不在 reason 那一格', async () => {
    // 后端这里有两件**不同**的事，混成一句「reason 必填」就会漏掉前一件：
    //   压根没有 body   → 「请求体不是合法的 JSON」，data 是 null，一个字段错都没有；
    //   {} / reason 空白 → 「必须填写理由」，data.errors 里点名 reason（见下面那一节）。
    // 而它拿的是 VALIDATION 而不是 NOT_FOUND，钉的是顺序：解析 body 排在查库之前。
    const e = await expectCode(Code.VALIDATION, () =>
      live.request({
        method: 'DELETE',
        url: `/api/admin/locations/${MISSING_ID}`,
        headers: { Authorization: `Bearer ${seed.tokenAdmin}` },
      }),
    )
    expect(e.fieldErrors, `空 body 却报出了字段错：那句「不是合法的 JSON」搬进校验层了`).toHaveLength(0)
  })

  it('DELETE 给了合法 JSON 但没带 reason：这一句才落在 reason 上，而且那一行还在', async () => {
    // 用真实存在的 id3 打：这样「行还在」才有得验，而 VALIDATION 确实在数子节点、
    // 更在 DELETE 之前发生。
    const e = await expectCode(Code.VALIDATION, () =>
      live.request({
        method: 'DELETE',
        url: `/api/admin/locations/${id3}`,
        headers: { Authorization: `Bearer ${seed.tokenAdmin}` },
        data: {},
      }),
    )
    expect(e.errorFor('reason'), `缺 reason 那句没落在 reason 上：${JSON.stringify(e.fieldErrors)}`).toBeDefined()
    const tree = await call<LocationNode[]>('GET', '/api/locations')
    expect(findById(tree, id3)).not.toBeNull()
  })

  it('删一个不存在的 id 是 NOT_FOUND，不是 500、也不是安静成功', async () => {
    const e = await expectCode(Code.NOT_FOUND, () => rm(MISSING_ID, `${TAG}：试删不存在`))
    expect(e.httpStatus).toBe(404)
  })

  it('被帖子引用挡住的那一种，报的是帖子而不是子节点', async () => {
    // 这一条只在前一条测试真的建过东西之后能对比出形状差别：dictNotInUse 把两种障碍
    // 拼成同一句「这个条目删不掉：……」，而管理员接下来要做的事在两种情况下是相反的。
    // 引用关系在开发库里不可控（我们不该为了测试去发一条帖），所以这里钉的是**那句的形状**，
    // 而不是硬造一个数出来 —— 具体那两种说法在冒烟脚本里有真数据可数。
    const tree = await call<CategoryNode[]>('GET', '/api/categories')
    const first = tree[0]
    const seededChild = first.children[0]
    if (seededChild) {
      const e = await expectCode(Code.CATEGORY_IN_USE, () =>
        call('DELETE', `/api/admin/categories/${first.id}`, seed.tokenAdmin, { reason: `${TAG}：试删种子大类` }),
      )
      // 种子大类下面一定有子节点，所以这句里必须是「子节点」而不是「帖子」。
      expect(e.message, `删不掉那句没分清两种障碍：${e.message}`).toContain('个子节点')
    }
  })
})

describe.skipIf(!hasAdmin)('必填那一格的四种坏法：VALIDATION，而且落在对的字段上（admin 真打）', () => {
  beforeAll(async () => {
    if (skipAdmin()) return
    await loginAdmin()
  })

  it('reason 空：那一条 errorFor("reason") 说的是它会进留痕', async () => {
    for (const path of ['/api/admin/categories', '/api/admin/locations']) {
      const e = await expectCode(Code.VALIDATION, () =>
        call('POST', path, seed.tokenAdmin, { name: `${TAG}没理由`, sort_order: 1, reason: '   ' }),
      )
      expect(e.errorFor('reason'), `${path} 的空理由没落在 reason 上`).toBeDefined()
    }
  })

  it('reason 超过 500 字也是 VALIDATION（前端的字符计数上限就是这个数）', async () => {
    const long = (TAG + '说'.repeat(600)).slice(0, MAX_REASON_RUNES + 1)
    const e = await expectCode(Code.VALIDATION, () =>
      call('POST', '/api/admin/categories', seed.tokenAdmin, { name: `${TAG}长理由`, sort_order: 1, reason: long }),
    )
    expect(e.errorFor('reason')).toBeDefined()
  })

  it('name 只有空格：后端 trim 之后按空处理，所以那一句还是「不能为空」', async () => {
    const e = await expectCode(Code.VALIDATION, () =>
      call('POST', '/api/admin/categories', seed.tokenAdmin, { name: '    ', sort_order: 1, reason: REASON }),
    )
    expect(e.errorFor('name')).toBeDefined()
  })

  it('parent_id 指到一个不存在的 id：是 VALIDATION 而不是 NOT_FOUND', async () => {
    // 这一条钉的是 repo.resolveLevel 上面那段注释写的口径：
    // NOT_FOUND 在这个语境里只说「你要删的那条字典不存在」，两种 4xx 不混用。
    // 混用的话，前端就得在「这个上级没了」和「这个 id 打错了」之间猜。
    const e = await expectCode(Code.VALIDATION, () =>
      call('POST', '/api/admin/categories', seed.tokenAdmin, {
        name: `${TAG}孤儿`,
        parent_id: MISSING_ID,
        sort_order: 1,
        reason: REASON,
      }),
    )
    expect(e.errorFor('parent_id')).toBeDefined()
  })
})

describe.skipIf(!hasAdmin)('这一族写了什么、没写什么：留痕有、通知没有（admin 真打）', () => {
  let name = ''
  let made = 0

  beforeAll(async () => {
    if (skipAdmin()) return
    await loginAdmin()
  })

  afterAll(async () => {
    if (!seed.tokenAdmin || !made) return
    try {
      await call('DELETE', `/api/admin/categories/${made}`, seed.tokenAdmin, { reason: `${TAG}：收尾` })
    } catch {
      /* 见上面那两处 afterAll 的理由 */
    }
  })

  it('#50 里查得到这一增一删两行，而 detail 带着那个已经删掉的名字', async () => {
    name = `${TAG}留痕用`
    const unreadBefore = await call<{ count: number }>('GET', '/api/my/notifications/unread-count', seed.tokenAdmin)

    const created = await call<DictResult>('POST', '/api/admin/categories', seed.tokenAdmin, {
      name,
      sort_order: 901,
      reason: `${REASON}（这一条是给留痕断言用的）`,
    })
    made = created.id
    await call<null>('DELETE', `/api/admin/categories/${made}`, seed.tokenAdmin, {
      reason: `${REASON}（删掉它，留痕才留得下来）`,
    })

    const rows = await call<Page<AdminActionRow>>(
      'GET',
      `/api/admin/actions?target_type=category&page_size=100&action=dict_create`,
      seed.tokenAdmin,
    )
    const createRow = rows.list.find((r) => r.target_id === created.id)
    if (!createRow) throw new Error(`#50 里没有 #${created.id} 的 dict_create 行：写字典不留痕了？`)
    expect(createRow.action).toBe('dict_create')
    expect(createRow.admin?.nickname).toBeTruthy()

    // detail 里带 name 和 level 是刻意的：那一行**已经被删掉了**，
    // 没有这两列的话，日志页只能回答「谁在什么时候删了 id=N」，回答不了「N 叫什么」。
    expect(createRow.detail.name).toBe(name)
    expect(createRow.detail.level).toBe(1)

    const delRows = await call<Page<AdminActionRow>>(
      'GET',
      `/api/admin/actions?target_type=category&action=dict_delete&target_id=${created.id}`,
      seed.tokenAdmin,
    )
    expect(delRows.list.length).toBeGreaterThanOrEqual(1)
    expect(delRows.list[0].detail.name).toBe(name)

    // 「这一族零通知」的活体哨兵：做这些动作的人自己不该收到任何东西。
    // ⚠ 它只覆盖「acting admin 这一侧」——「其他任何人都收不到」那句是后端冒烟的活，
    //   因为前端拿不到别人的收件箱（那是设计，不是缺功能）。
    const unreadAfter = await call<{ count: number }>('GET', '/api/my/notifications/unread-count', seed.tokenAdmin)
    expect(unreadAfter.count, '字典增删给做这件事的人发了通知').toBe(unreadBefore.count)

    made = 0
  })
})

describe.skipIf(!hasAdmin)('#39 真读到的那一份配置（admin 真打）', () => {
  let cfg: DebugConfig | null = null

  beforeAll(async () => {
    if (skipAdmin()) return
    const token = await loginAdmin()
    cfg = await call<DebugConfig>('GET', '/api/debug/config', token)
  })

  it('data 恰好是那 18 个键：一个不多、一个不少', async () => {
    expect(cfg).not.toBeNull()
    expectExactKeys(cfg!, [
      'env',
      'port',
      'log_level',
      'db_host',
      'db_port',
      'db_user',
      'db_name',
      'db_password',
      'jwt_secret',
      'jwt_expire_hours',
      'upload_dir',
      'match_time_tolerance_hours',
      'match_notify_threshold',
      'match_show_threshold',
      'match_decay_days',
      'hduhelp_app_id',
      'hduhelp_app_secret',
      'sso_state_key',
    ])
    // 这一条同时是 DebugConfig 那个 interface 的活体对照：
    // 后端多一列 → 前端 DebugTab 的「还没归组」那一栏会显示它；后端少一列 → 这里先红。
  })

  it('match_ 这一族恰好四个键：「这一页就是为这四个数存在的」才说得出口', async () => {
    // 后端 MatchConfig 恰好四个字段，smoke/m6-governance.sh 数的也是同一个「四」。
    // 2026-10-08 之前漏的是时间容差，那一版这里只数到 3，前端那句说明写的是「只吐三个」。
    const family = Object.keys(cfg!)
      .filter((k) => k.startsWith('match_'))
      .sort()
    expect(family).toEqual([
      'match_decay_days',
      'match_notify_threshold',
      'match_show_threshold',
      'match_time_tolerance_hours',
    ])
  })

  it('敏感那五列只有两种形状：*** 或者 (未配置)，不会是空串、也不会漏出原值', async () => {
    const masked = ['db_password', 'jwt_secret', 'hduhelp_app_id', 'hduhelp_app_secret', 'sso_state_key'] as const
    for (const key of masked) {
      const v = cfg![key]
      expect(typeof v, `${key} 不是字符串：打码那份出口写的是 string`).toBe('string')
      expect(['***', '(未配置)'], `${key} 的形状不对，前端那句「后端打码后的样子」要重看：${v}`).toContain(v)
    }
  })

  it('四个匹配参数是数字不是字符串，而两个阈值都落在 0~1 里', async () => {
    const show = cfg!.match_show_threshold
    const notify = cfg!.match_notify_threshold
    expect(typeof show).toBe('number')
    expect(typeof notify).toBe('number')
    expect(typeof cfg!.match_decay_days).toBe('number')
    // 时间容差必须是**数**：它跟那五个敏感键走的是同一条出口，一旦误过 mask() 就变成 `"***"`，
    // 而 `"***"` 在页面上看着完全合理 —— 只有类型能把它抓住。
    expect(typeof cfg!.match_time_tolerance_hours).toBe('number')
    for (const [k, v] of [
      ['match_show_threshold', show],
      ['match_notify_threshold', notify],
    ] as const) {
      expect(v, `${k} 不在 (0,1] 里：那条打分线不可能长这样`).toBeGreaterThan(0)
      expect(v, `${k} 不在 (0,1] 里`).toBeLessThanOrEqual(1)
    }
    expect(cfg!.match_decay_days).toBeGreaterThan(0)
    // 容差这里只钉「不是负数」：0 是有人真想「只认同一小时」时会写进 .env 的值，
    // 后端也允许它（config.go 只解析、不设下限），所以断言 >0 会把一次合法的调参变成一条假红。
    expect(cfg!.match_time_tolerance_hours).toBeGreaterThanOrEqual(0)

    // 「展示线低于通知线」是设计口径（0.55 < 0.75），但它不是数据库里的恒等式，
    // 而是 .env 里两个数 —— 有人调参就会动它。所以这里**警告而不是失败**：
    // 红了会把人引向「测试坏了」，而真正该被看一眼的是那句前端文案。
    if (show >= notify) {
      console.warn(`⚠ MATCH_SHOW_THRESHOLD(${show}) >= MATCH_NOTIFY_THRESHOLD(${notify})：两线的口径反了，` + '前端所有「展示线比通知线低」的说法都要重看。')
    }
  })

  it('env / port 是字符串：DebugTab 用 String() 把每一格铺成一行', async () => {
    expect(typeof cfg!.env).toBe('string')
    expect(typeof cfg!.port).toBe('string')
    expect(cfg!.env).not.toBe('')
    // 这一节能跑到这里本身就说明它是 dev/test —— ENV=prod 时那条路由压根没注册，
    // 上面的 rawCall 已经把 404 单独解释过了。
    expect(cfg!.env).not.toBe('prod')
  })
})
