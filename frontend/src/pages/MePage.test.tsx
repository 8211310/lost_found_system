// src/pages/MePage.test.tsx —— 「我的」首页：这一页的断言重点是**不该出现的入口**。
//
// 它自己不请求任何东西（身份全靠 AuthContext 里那份 #3 的结果），
// 所以「meTimes 为 0」本身就是契约：这一页如果多发一次 /api/auth/me，
// 全站就有了两个可能不同步的「我是谁」。
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import MePage from './MePage'
import { renderRouted } from '../test/render'
import { server } from '../test/server'
import { BASE, ok, sampleUser } from '../test/helpers'
import { getToken, setToken } from '../api/session'

/** @param onMe 传 handler 时可以自己决定 /api/auth/me 的行为；默认给一个本地普通用户。 */
function mockMe(user = sampleUser()) {
  const seen = { meTimes: 0 }
  setToken('jwt.me')
  server.use(
    http.get(`${BASE}/api/auth/me`, () => {
      seen.meTimes += 1
      return HttpResponse.json(ok(user))
    }),
  )
  return seen
}

describe('身份与入口', () => {
  it('显示的是 #3 给的那份身份，并且这一页自己不再问一次', async () => {
    const seen = mockMe(sampleUser({ nickname: '小李', username: 'xiaoli', credit_score: 103 }))

    renderRouted('/me', <MePage />, '/me')

    expect(await screen.findByText('小李')).toBeInTheDocument()
    expect(screen.getByText('xiaoli')).toBeInTheDocument()
    expect(screen.getByText('103')).toBeInTheDocument()
    expect(screen.getByText('本地账号密码')).toBeInTheDocument()
    // 恰好一次：那一次是 AuthProvider 首屏恢复身份（#3），这一页自己一次都不该发。
    // 多发一次不会报错，只会让「顶栏的身份」和「这一页的身份」出现两个读取时刻。
    expect(seen.meTimes).toBe(1)
  })

  it('五条入口都在 —— 片 5 之后通知中心和归还记录这两条链接才允许出现', async () => {
    mockMe()

    renderRouted('/me', <MePage />, '/me')
    const nav = await screen.findByRole('navigation', { name: /我的/ })

    expect(within(nav).getByRole('link', { name: '我的发布' })).toHaveAttribute('href', '/me/posts')
    expect(within(nav).getByRole('link', { name: '积分流水' })).toHaveAttribute('href', '/me/credit')
    expect(within(nav).getByRole('link', { name: '账号设置' })).toHaveAttribute('href', '/me/settings')
    expect(within(nav).getByRole('link', { name: /归还确认/ })).toHaveAttribute('href', '/me/returns')
    expect(within(nav).getByRole('link', { name: /通知/ })).toHaveAttribute('href', '/me/notifications')
  })

  it('管理员看到的也是普通用户那几项，但有一句解释为什么没有后台', async () => {
    mockMe(sampleUser({ role: 'admin' }))

    renderRouted('/me', <MePage />, '/me')

    expect(await screen.findByText(/管理后台还没做/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /后台|管理/ })).not.toBeInTheDocument()
  })

  it('退出登录后 token 被清掉，并把人送回广场', async () => {
    const user = userEvent.setup()
    mockMe()
    setToken('jwt.me')

    renderRouted('/me', <MePage />, '/me')
    await screen.findByText('小李')

    await user.click(screen.getByRole('button', { name: '退出登录' }))

    await screen.findByText('广场页桩')
    // getToken 在清空后给的是 null（session.ts 那层直接透传 storage.getItem）。
    expect(getToken()).toBeNull()
  })
})
