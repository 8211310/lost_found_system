// src/auth/RequireAuth.test.tsx —— 守卫，含「刷新不掉登录态」这条判据的自动化版本。
//
// ⚠ 这里没有去解本地 JWT 来判定登录态，走的是 #3 GET /api/auth/me。
// 后端每个请求都重新读库拿最新的 role/status（middleware/jwt.go），token 里只有 sub，
// 所以前端唯一可信的身份来源是那次读取。测试钉住这一点，免得将来有人
// 「为了少一次请求」改成解本地 token，那会让封号和降权在前端失效 24 小时。
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { Route, Routes } from 'react-router-dom'
import LoginPage from '../pages/LoginPage'
import MePage from '../pages/MePage'
import { RequireAuth } from './RequireAuth'
import { BASE, ok, sampleUser } from '../test/helpers'
import { server } from '../test/server'
import { renderWithAuth } from '../test/render'
import { setToken } from '../api/session'
import { Code } from '../api/codes'

const PATHS = (
  <Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route path="/me" element={<RequireAuth><MePage /></RequireAuth>} />
  </Routes>
)

describe('未登录', () => {
  it('访问 /me 被送去登录页', () => {
    renderWithAuth(PATHS, '/me')
    expect(screen.getByRole('heading', { name: '登录' })).toBeInTheDocument()
  })

  it('没有 token 时不会去打 /api/auth/me', () => {
    // 不注册任何 handler：msw 的 onUnhandledRequest:'error' 会在这种请求出现时直接炸，
    // 所以「渲染没抛错」本身就是断言。
    renderWithAuth(PATHS, '/me')
    expect(screen.getByRole('heading', { name: '登录' })).toBeInTheDocument()
  })
})

describe('带着 token 打开页面（刷新场景）', () => {
  it('先显示确认中，再由 #3 把人认回来 —— 不掉登录态', async () => {
    setToken('jwt.still.valid')
    server.use(
      http.get(`${BASE}/api/auth/me`, () => HttpResponse.json(ok(sampleUser({ nickname: '小李' }))), {
        once: true,
      }),
    )

    renderWithAuth(PATHS, '/me')

    // 这一行必须在任何 await 之前：它验的是「还没问出来」不等于「没登录」。
    expect(screen.getByText('正在确认登录状态…')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('heading', { name: '我的' })).toBeInTheDocument())
    expect(screen.getByText('小李')).toBeInTheDocument()
  })

  it('token 已过期时退回匿名，被踢去登录页', async () => {
    setToken('jwt.expired')
    server.use(
      http.get(`${BASE}/api/auth/me`, () =>
        HttpResponse.json({ code: Code.UNAUTHORIZED, message: '登录已过期', data: null, request_id: 'r' }, { status: 401 }),
      ),
    )

    renderWithAuth(PATHS, '/me')
    await waitFor(() => expect(screen.getByRole('heading', { name: '登录' })).toBeInTheDocument())
  })

  it('封号用户的旧 token 立刻失效：/me 返回 USER_BANNED 就当没登录', async () => {
    setToken('jwt.banned')
    server.use(
      http.get(`${BASE}/api/auth/me`, () =>
        HttpResponse.json({ code: Code.USER_BANNED, message: '账号已被封禁', data: null, request_id: 'r' }, { status: 403 }),
      ),
    )

    renderWithAuth(PATHS, '/me')
    await waitFor(() => expect(screen.getByRole('heading', { name: '登录' })).toBeInTheDocument())
  })
})

describe('退出登录', () => {
  it('点退出之后回到匿名态，再访问 /me 被踢回登录页', async () => {
    setToken('jwtabc')
    server.use(http.get(`${BASE}/api/auth/me`, () => HttpResponse.json(ok(sampleUser()))))

    renderWithAuth(PATHS, '/me')
    await screen.findByRole('heading', { name: '我的' })

    await userEvent.setup().click(screen.getByRole('button', { name: '退出登录' }))


    await waitFor(() => expect(screen.getByRole('heading', { name: '登录' })).toBeInTheDocument())
  })
})
