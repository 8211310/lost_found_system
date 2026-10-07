// src/api/client.test.ts —— §8 信封解包器的行为。
//
// 这一层是前端的地基：它错了，每个页面都会错，而每个页面的测试都会红得看不出原因。
// 所以这里把「什么算成功、什么算失败、失败时登录态怎么处理」全钉死。
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'
import { ApiError, createHttp } from './client'
import { Code, NETWORK_ERROR } from './codes'
import type { LoginResult } from './types'
import { clearToken, getToken, setToken, onSessionChange } from './session'
import { BASE, envelope, ok, sampleUser } from '../test/helpers'
import { server } from '../test/server'

const httpTest = createHttp(BASE)

describe('信封解包', () => {
  it('成功时 response.data 就是信封里的 data，外层信封被拆掉', async () => {
    server.use(http.get(`${BASE}/api/ping`, () => HttpResponse.json(ok({ hello: 'world' }))))

    // 拦截器替换的是 response.data，返回值仍是 AxiosResponse ——
    // getJSON/postJSON 那层薄封装就是靠 .data 把这一层收掉的，页面拿不到 status 以外的东西。
    const res = await httpTest.get<{ hello: string }>('/api/ping')
    expect(res.data).toEqual({ hello: 'world' })
  })

  it('HTTP 200 但 code 不是 OK 时抛 ApiError，不能静默返回', async () => {
    server.use(
      http.get(`${BASE}/api/broken`, () => HttpResponse.json(envelope('VALIDATION', 'x', 200).body)),
    )

    const err = await httpTest.get('/api/broken').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.code).toBe('VALIDATION')
  })

  it('/uploads 这种不走信封的二进制响应原样透传', async () => {
    server.use(
      http.get(`${BASE}/uploads/a.png`, () => new HttpResponse('PNGBYTES', { headers: { 'content-type': 'image/png' } })),
    )

    const res = await httpTest.get<string>('/uploads/a.png')
    expect(res.data).toBe('PNGBYTES')
  })
})

describe('鉴权头', () => {
  let sentAuthorization = '<没发出去>'

  beforeEach(() => {
    server.use(
      http.get(`${BASE}/api/whoami`, (c) => {
        sentAuthorization = c.request.headers.get('Authorization') ?? '<无>'
        return HttpResponse.json(ok(null))
      }),
    )
  })

  it('没登录时不带 Authorization 头', async () => {
    await httpTest.get('/api/whoami')
    expect(sentAuthorization).toBe('<无>')
  })

  it('登录后带 `Bearer <token>`（后端 middleware/jwt.go 只认这个前缀）', async () => {
    setToken('abc123')
    await httpTest.get('/api/whoami')
    expect(sentAuthorization).toBe('Bearer abc123')
  })
})

describe('登录态的去留', () => {
  it('UNAUTHORIZED(401) 抛出的 code 可用于分支，且把 token 清掉', async () => {
    setToken('stale')
    server.use(
      http.get(`${BASE}/api/items/1/matches`, () =>
        HttpResponse.json(envelope(Code.UNAUTHORIZED, '请先登录', 401).body, { status: 401 }),
      ),
    )

    const err = await httpTest.get('/api/items/1/matches').catch((e) => e)
    expect(err.code).toBe(Code.UNAUTHORIZED)
    expect(getToken()).toBeNull()
  })

  it('USER_BANNED(403) 也判为登录态已死', async () => {
    setToken('banned')
    server.use(
      http.post(`${BASE}/api/items`, () =>
        HttpResponse.json(envelope(Code.USER_BANNED, '账号已被封禁，请联系管理员', 403).body, { status: 403 }),
      ),
    )

    await httpTest.post('/api/items', {}).catch(() => undefined)
    expect(getToken()).toBeNull()
  })

  it('FORBIDDEN 不清 token —— 权限不够的人还是登录着的，踢去登录页是错的', async () => {
    setToken('good')
    server.use(
      http.get(`${BASE}/api/admin/stats`, () =>
        HttpResponse.json(envelope(Code.FORBIDDEN, '没有权限执行此操作', 403).body, { status: 403 }),
      ),
    )

    const err = await httpTest.get('/api/admin/stats').catch((e) => e)
    expect(err.code).toBe(Code.FORBIDDEN)
    expect(getToken()).toBe('good')
  })

  it('拦截器清 token 会通知到订阅者（React 靠它把状态同步进来）', async () => {
    setToken('stale')
    let notified = 0
    const off = onSessionChange(() => {
      notified += 1
    })
    server.use(
      http.get(`${BASE}/api/auth/me`, () =>
        HttpResponse.json(envelope(Code.UNAUTHORIZED, '登录已过期', 401).body, { status: 401 }),
      ),
    )

    await httpTest.get('/api/auth/me').catch(() => undefined)
    off()
    expect(notified).toBe(1)
  })

  it('手动 logout 清 token 同样会广播', async () => {
    setToken('x')
    let notified = 0
    const off = onSessionChange(() => {
      notified += 1
    })
    clearToken()
    off()
    expect(notified).toBe(1)
  })
})

describe('错误细节的可见性', () => {
  it('字段级错误放在 data.errors 数组里，页面能按字段取', async () => {
    const { body, status } = envelope(Code.VALIDATION, '请求参数校验失败', 400, {
      errors: [
        { field: 'contact', msg: '联系方式不能为空' },
        { field: 'title', msg: '标题至少 2 个字' },
      ],
    })
    server.use(http.post(`${BASE}/api/items`, () => HttpResponse.json(body, { status })))

    const err = await httpTest.post('/api/items', {}).catch((e) => e)
    expect(err.errorFor('contact')).toBe('联系方式不能为空')
    expect(err.errorFor('title')).toBe('标题至少 2 个字')
    expect(err.errorFor('description')).toBeUndefined()
  })

  it('request_id 留在错误对象上（§9：报 bug 时靠它去日志里捞链路）', async () => {
    const { body, status } = envelope(Code.NOT_FOUND, '资源不存在', 404)
    server.use(http.get(`${BASE}/api/items/999`, () => HttpResponse.json(body, { status })))

    const err = await httpTest.get('/api/items/999').catch((e) => e)
    expect(err.requestId).toBe('test-req-not_found')
  })

  it('请求根本没到后端时是 NETWORK，而不是 axios 的英文原文', async () => {
    server.use(http.get(`${BASE}/api/items`, () => HttpResponse.error()))

    const err = await httpTest.get('/api/items').catch((e) => e)
    expect(err.code).toBe(NETWORK_ERROR)
    expect(err.message).toContain('连不上服务器')
  })

  it('错误对象是 ApiError 类型，页面可以用 instanceof 收口', async () => {
    setToken('stale')
    server.use(
      http.get(`${BASE}/api/my/items`, () =>
        HttpResponse.json(envelope(Code.UNAUTHORIZED, '请先登录', 401).body, { status: 401 }),
      ),
    )

    const err = await httpTest.get('/api/my/items').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.httpStatus).toBe(401)
  })
})

describe('登录响应的形状', () => {
  it('调用方拿到的是 data 本身：token 加上「11 个字段，不多不少」的 user', async () => {
    server.use(
      http.post(`${BASE}/api/auth/login`, () =>
        HttpResponse.json(ok({ token: 't', expires_at: '2026-10-08T00:00:00Z', user: sampleUser() })),
      ),
    )

    const res = (await httpTest.post<LoginResult>('/api/auth/login', { username: 'u', password: 'p' })).data
    expect(res.token).toBe('t')
    // 精确到"不多不少"：后端哪天往 UserView 里塞了 password_hash 或 student_id，这里立刻红
    expect(Object.keys(res.user).sort()).toEqual(
      [
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
      ].sort(),
    )
  })
})
