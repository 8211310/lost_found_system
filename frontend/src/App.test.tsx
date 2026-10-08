// src/App.test.tsx —— 外壳那一条：导航栏上的未读数（#31）。
//
// 这一条值得单独测，因为它同时踩在三个容易出错的地方：
//   ① 只有登录的人才看得到通知入口 —— #30 的收件人取自 JWT，匿名点进去会被守卫弹回登录页，
//      而那一下弹回会让人以为是自己点错了；
//   ② 读失败时显示「通知」而不是「通知 0」：拿不到数字和数字是 0 是两件事；
//   ③ 每换一页重读一次 —— 这套系统没有推送（不做站内私信、不做长连接是定稿的边界），
//      所以「有没有新东西」只能靠读，标完已读之后回到别的页面，人期望那个数字是新的。
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { AuthProvider } from './auth/AuthContext'
import App from './App'
import { notifyUnreadCountChanged } from './api/unreadBus'
import { server } from './test/server'
import {
  BASE,
  envelope,
  ok,
  sampleCategories,
  sampleLocations,
  samplePage,
  sampleUser,
} from './test/helpers'
import { setToken } from './api/session'

/** #31 记次数；unread=null 时让它失败。 */
function mockShell(unread: number | null) {
  const seen: { unreadTimes: number } = { unreadTimes: 0 }
  server.use(
    http.get(`${BASE}/api/auth/me`, () => HttpResponse.json(ok(sampleUser({ id: 7 })))),
    http.get(`${BASE}/api/my/notifications/unread-count`, () => {
      seen.unreadTimes += 1
      if (unread === null) {
        return HttpResponse.json(envelope('INTERNAL', 'boom', 500).body, { status: 500 })
      }
      return HttpResponse.json(ok({ count: unread }))
    }),
    // 广场那三个读：换页那条测试会真的走到广场，未注册的请求 msw 会直接报错。
    http.get(`${BASE}/api/categories`, () => HttpResponse.json(ok(sampleCategories()))),
    http.get(`${BASE}/api/locations`, () => HttpResponse.json(ok(sampleLocations()))),
    http.get(`${BASE}/api/items`, () => HttpResponse.json(ok(samplePage([])))),
  )
  return seen
}

function renderApp(at: string) {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  )
}

/** 顶栏那块。查询一律收窄到这里：「我的」首页的入口清单里也有一条叫「通知」的链接，
 *  在全屏里按名字找会得到「找到两个」，而那两条要验的根本不是同一件事。 */
const HEADER = () => screen.getByRole('banner')

describe('导航栏上的未读数', () => {
  it('匿名时整条通知入口都不在 —— 点进去只会先被守卫弹回登录页', async () => {
    mockShell(3)

    renderApp('/login')
    await screen.findByRole('link', { name: '广场' })

    const nav = HEADER()
    expect(within(nav).queryByRole('link', { name: /通知/ })).not.toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: '登录' })).toBeInTheDocument()
  })

  it('登录着就显示「通知 3」，而且登录状态下一次 #31 都不该多发', async () => {
    setToken('jwt.me')
    const seen = mockShell(3)

    renderApp('/me')
    // 顶上那条和「我的」首页里那条入口同名，所以一律按所在的 nav 收窄：
    // 断言「有几条链接」不是这里要验的事，断「顶栏那条带不带数字」才是。
    // 按**带数字的完整名字**找：那条链接在没有数字时也叫「通知」，
    // 用 /通知/ 会立刻命中「还没回来的那一版」，然后断言出一个假失败。
    const link = await within(HEADER()).findByRole('link', { name: '通知 3' })
    expect(link).toHaveAttribute('href', '/me/notifications')
    // 「我的」首页自己不请求（身份只有一份），所以这里的 1 次就是顶栏那一次。
    expect(seen.unreadTimes).toBe(1)
  })

  it('换页会重读一次：标完已读回到别的页面时，那个数字得是新的', async () => {
    const user = userEvent.setup()
    setToken('jwt.me')
    const seen = mockShell(3)

    renderApp('/me')
    // 等的是「通知 3」而不是 /通知/：没有数字时那条链接也叫「通知」，
    // 于是下面那句会在这次 GET 落地之前就被读到 0（上面和下面那两条都是靠带数字的全名避开的）。
    await within(HEADER()).findByRole('link', { name: '通知 3' })
    expect(seen.unreadTimes).toBe(1)

    await user.click(screen.getByRole('link', { name: '广场' }))
    // 换页之后旧数字还挂在顶上，所以按名字等是等不到新一次的：这里等的是请求本身发生了第二次。
    await vi.waitFor(() => expect(seen.unreadTimes).toBe(2))
  })

  it('标完已读但没换页时也跟着重读：徽标不能停在人刚刚亲手清零的那个数上', async () => {
    setToken('jwt.me')
    const seen = mockShell(3)

    renderApp('/me')
    await within(HEADER()).findByRole('link', { name: '通知 3' })
    expect(seen.unreadTimes).toBe(1)

    // 上面那条测试的触发器是换页，这一条的触发器是「同一页里发生了一次改变未读数的操作」。
    notifyUnreadCountChanged()
    await vi.waitFor(() => expect(seen.unreadTimes).toBe(2))
  })

  it('超过 99 显示 99+，而不是把顶栏撑开', async () => {
    setToken('jwt.me')
    mockShell(140)

    renderApp('/me')
    await within(HEADER()).findByRole('link', { name: '通知 99+' })
  })

  it('#31 读失败时显示「通知」而不是「通知 0」', async () => {
    setToken('jwt.me')
    mockShell(null)

    renderApp('/me')
    // 失败时那条链接的名字就只有「通知」两个字：写成「通知 0」是把「不知道」说成「没有」。
    const link = await within(HEADER()).findByRole('link', { name: '通知' })
    expect(link).toHaveAttribute('href', '/me/notifications')
  })
})
