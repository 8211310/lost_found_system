// src/pages/admin/DebugTab.test.tsx —— #39 那份打码后的配置，以及 404 / 403 那两句不同的话。
//
// 这一页最值钱的是**两句不同的解释**：后端那条路由在 prod 里压根没注册（404），
// 而 handler 里那道 prod 闸给的是 403。把它们混成一句「加载失败」，
// 生产环境里这一页就变成一个永远的假故障；反过来说，403 如果被解释成「不存在」，
// 真配错了也没人会去查。
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import DebugTab from './DebugTab'
import { BASE, envelope, ok, sampleUser } from '../../test/helpers'
import { renderRouted } from '../../test/render'
import { server } from '../../test/server'
import { setToken } from '../../api/session'

/** 后端 config.Redacted() 那一份，逐键照抄（值用 .env 里那套默认，好让断言能对得上口径）。 */
function sampleConfig(extra: Record<string, unknown> = {}) {
  return {
    env: 'dev',
    port: '8080',
    log_level: 'info',
    db_host: 'localhost',
    db_port: '5432',
    db_user: 'lf',
    db_name: 'lostfound',
    db_password: '***',
    jwt_secret: '***',
    jwt_expire_hours: 24,
    upload_dir: './uploads',
    match_time_tolerance_hours: 24,
    match_notify_threshold: 0.75,
    match_show_threshold: 0.55,
    match_decay_days: 14,
    hduhelp_app_id: '(未配置)',
    hduhelp_app_secret: '(未配置)',
    sso_state_key: '(未配置)',
    ...extra,
  }
}

function mockConfig(data = sampleConfig()) {
  const calls = { n: 0 }
  setToken('jwt.admin.token')
  server.use(
    http.get(`${BASE}/api/auth/me`, () =>
      HttpResponse.json(ok(sampleUser({ id: 7, role: 'admin', nickname: '管理员' }))),
    ),
    http.get(`${BASE}/api/debug/config`, () => {
      calls.n += 1
      return HttpResponse.json(ok(data))
    }),
  )
  return calls
}

/** 一行 = 一个 dt 配一个 dd（外面套着 HTML5 允许的那个 div）。
 *  这里按 dt 自己的直接文本找，不用 getByRole('term')：term 这个角色在 ARIA 里
 *  **不允许**从内容取名字，所以它的 accessible name 永远是空的，name 条件匹配不上。
 *  取整个 dd 的 textContent，因为被打码那几行在值后面还跟着半句 muted 说明。 */
function valueOf(label: RegExp): string {
  const dt = screen.getByText(label, { selector: 'dt' })
  return (dt.parentElement as HTMLElement).querySelector('dd')!.textContent ?? ''
}

describe('读到了配置', () => {
  it('四个匹配参数带着它们的环境变量名 —— 这一页存在的理由就是这一格', async () => {
    mockConfig()
    renderRouted('/admin', <DebugTab />, '/admin')

    await screen.findByText('当前环境')
    // 环境变量名用正则而不是整串：那一格实际渲染的是「（MATCH_SHOW_THRESHOLD）」，
    // 全角括号是组件写的，断言不该跟着抄一遍括号。
    expect(valueOf(/^展示线/)).toContain('0.55')
    expect(screen.getByText(/MATCH_SHOW_THRESHOLD/)).toBeInTheDocument()
    expect(valueOf(/^通知线/)).toContain('0.75')
    expect(screen.getByText(/MATCH_NOTIFY_THRESHOLD/)).toBeInTheDocument()
    expect(valueOf(/^衰减天数/)).toContain('14')
    expect(screen.getByText(/MATCH_DECAY_DAYS/)).toBeInTheDocument()
    expect(valueOf(/^时间容差/)).toContain('24')
    expect(screen.getByText(/MATCH_TIME_TOLERANCE_HOURS/)).toBeInTheDocument()
    // 展示线必须排在通知线前面讲得通的那条口径：0.55 < 0.75，两个数都要看得见才比得出。
    expect(screen.getByText(/这一页主要就是为这四个数存在的/)).toBeInTheDocument()
  })

  it('打码那几列原样显示，并且说清那不是内容', async () => {
    mockConfig()
    renderRouted('/admin', <DebugTab />, '/admin')

    await screen.findByText('当前环境')
    expect(valueOf(/^密码/)).toContain('***')
    // 「(未配置)」是后端写的，不是前端填空 —— 空白会让人以为漏了这一项。
    expect(valueOf(/^App ID/)).toContain('(未配置)')
    // 打码那几行必须紧跟半句「那不是内容」：只有 `***` 孤零零摆在那儿，
    // 有人会以为密码真的等于三个星号。
    expect(valueOf(/^密码/)).toContain('后端打码后的样子，不是内容')
  })

  it('后端新加、这份表还没归组的键会被摊出来，而不是静默丢掉', async () => {
    mockConfig(sampleConfig({ upload_base_url: '/uploads' }))
    renderRouted('/admin', <DebugTab />, '/admin')

    expect(await screen.findByText('这一页还没归组的键')).toBeInTheDocument()
    expect(valueOf(/^upload_base_url$/)).toBe('/uploads')
  })

  it('时间容差显示的是后端给的那个数，不是这一页自己填的 24', async () => {
    // 夹具默认就是 24（.env 里那套），所以这里换一个别的值：
    // 直接拿默认值断言「24 在页面上」分不清那个 24 是读来的还是写死的。
    mockConfig(sampleConfig({ match_time_tolerance_hours: 48 }))
    renderRouted('/admin', <DebugTab />, '/admin')

    await screen.findByText('当前环境')
    expect(valueOf(/^时间容差/)).toContain('48')
    // 而它不该同时出现在「还没归组」那一栏 —— 出现在那里意味着这张表漏了一行。
    expect(screen.queryByText('这一页还没归组的键')).not.toBeInTheDocument()
  })

  it('重读一次会真的再发一遍（改完 .env 重启之后要能看到数变了）', async () => {
    const calls = mockConfig()
    renderRouted('/admin', <DebugTab />, '/admin')

    await screen.findByText('当前环境')
    expect(calls.n).toBe(1)

    await userEvent.setup().click(screen.getByRole('button', { name: '重读一次' }))

    await waitFor(() => expect(calls.n).toBe(2))
  })
})

describe('读不到配置', () => {
  it('404 说的是「这条路由只在开发环境注册」，而且一行配置都不显示', async () => {
    const e = envelope('NOT_FOUND', '404 page not found', 404)
    mockConfig()
    server.use(http.get(`${BASE}/api/debug/config`, () => HttpResponse.json(e.body, { status: e.status })))

    renderRouted('/admin', <DebugTab />, '/admin')

    expect(await screen.findByText(/只在开发环境注册/)).toBeInTheDocument()
    expect(screen.getByText(/那不是坏了/)).toBeInTheDocument()
    expect(screen.queryByRole('term')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重读一次' })).not.toBeInTheDocument()
  })

  it('403 说的是另一件事：路由在，但这一关没过', async () => {
    const e = envelope('FORBIDDEN', '这个端点在生产环境已关闭', 403)
    mockConfig()
    server.use(http.get(`${BASE}/api/debug/config`, () => HttpResponse.json(e.body, { status: e.status })))

    renderRouted('/admin', <DebugTab />, '/admin')

    expect(await screen.findByText(/这条路由注册了，但这一关没过/)).toBeInTheDocument()
    expect(screen.queryByText(/只在开发环境注册/)).not.toBeInTheDocument()
  })

  it('既不是 404 也不是 403 的错误：走 errorText 那句话，请求编号还是要给', async () => {
    const e = envelope('INTERNAL', '数据库连接失败', 500)
    mockConfig()
    server.use(http.get(`${BASE}/api/debug/config`, () => HttpResponse.json(e.body, { status: e.status })))

    renderRouted('/admin', <DebugTab />, '/admin')

    const alert = await screen.findByRole('alert')
    // INTERNAL 在 errorText 那张表里，所以这里显示的是表里那句、不是后端的「数据库连接失败」——
    // 那是全站的口径（表里没有的 code 才照抄 message），这一页不例外。
    expect(alert).toHaveTextContent('服务器出错了，请带上页面下方显示的请求编号反馈')
    expect(alert).toHaveTextContent('test-req-internal')
    // 而这两句「环境解释」不能被顺手带出来：它们各自对应一个特定的 code。
    expect(screen.queryByText(/只在开发环境注册/)).not.toBeInTheDocument()
    expect(screen.queryByText(/这条路由注册了/)).not.toBeInTheDocument()
  })
})
