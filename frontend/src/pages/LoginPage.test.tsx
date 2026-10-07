// src/pages/LoginPage.test.tsx —— #2 登录页的行为。
//
// 断言只认 code 翻译出来的文案，不认后端 message 原文：后端改了措辞时该显示的还是显示，
// 而**分支挂在 code 上**这件事不会变 —— 这里测的就是那个挂点。
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { Route, Routes } from 'react-router-dom'
import LoginPage from './LoginPage'
import { BASE, envelope, ok, sampleLogin } from '../test/helpers'
import { server } from '../test/server'
import { renderWithAuth } from '../test/render'
import { Code } from '../api/codes'
import { getToken } from '../api/session'

const PATHS = (
  <Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route path="/" element={<div>广场页</div>} />
    <Route path="/items/3" element={<div>帖子详情页</div>} />
  </Routes>
)

function render(state?: unknown) {
  return renderWithAuth(PATHS, '/login', state)
}

async function submit(username = 'xiaoli', password = 'pw12345678') {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('用户名'), username)
  await user.type(screen.getByLabelText('密码'), password)
  await user.click(screen.getByRole('button', { name: '登录' }))
  return user
}

describe('登录成功', () => {
  it('token 存进 session，并跳回首页', async () => {
    server.use(http.post(`${BASE}/api/auth/login`, () => HttpResponse.json(ok(sampleLogin('jwt.abc')))))

    render()
    await submit()

    await waitFor(() => expect(screen.getByText('广场页')).toBeInTheDocument())
    expect(getToken()).toBe('jwt.abc')
  })

  it('被守卫踢出来时，登录成功后回原来那条路（解锁联系方式靠这条）', async () => {
    server.use(http.post(`${BASE}/api/auth/login`, () => HttpResponse.json(ok(sampleLogin('jwt.abc')))))

    render({ from: '/items/3' })
    // 人是被某个操作带上这个页面的，页面得说清为什么换了地方、登录完会不会回去。
    expect(screen.getByText(/这一步要先登录才能继续/)).toBeInTheDocument()
    await submit()

    await waitFor(() => expect(screen.getByText('帖子详情页')).toBeInTheDocument())
  })

  it('自己走到登录页时不多说一句「要先登录」，也没有回去的承诺', () => {
    render()

    expect(screen.queryByText(/这一步要先登录才能继续/)).not.toBeInTheDocument()
  })

  it('注册页跳过来时，把「请用刚设的账号登录」这句显示出来', async () => {
    render({ notice: '注册成功，请用「xiaowang」登录。' })
    expect(screen.getByText(/注册成功/)).toBeInTheDocument()
  })
})

describe('登录失败', () => {
  it('INVALID_CREDENTIALS：显示「用户名或密码错误」，人留在登录页', async () => {
    server.use(
      http.post(`${BASE}/api/auth/login`, () =>
        HttpResponse.json(envelope(Code.INVALID_CREDENTIALS, '用户名或密码错误', 401).body, { status: 401 }),
      ),
    )

    render()
    await submit()

    expect(await screen.findByRole('alert')).toHaveTextContent('用户名或密码错误')
    expect(screen.getByLabelText('用户名')).toHaveValue('xiaoli')
  })

  it('USER_BANNED：提示找管理员，而不是笼统的登录失败', async () => {
    server.use(
      http.post(`${BASE}/api/auth/login`, () =>
        HttpResponse.json(envelope(Code.USER_BANNED, '账号已被封禁，如有疑问请联系管理员', 403).body, {
          status: 403,
        }),
      ),
    )

    render()
    await submit()

    expect(await screen.findByRole('alert')).toHaveTextContent('请联系管理员')
  })

  it('后端没起（NETWORK）：提示里带排查方向，不是一句「请求失败」', async () => {
    server.use(http.post(`${BASE}/api/auth/login`, () => HttpResponse.error()))

    render()
    await submit()

    expect(await screen.findByRole('alert')).toHaveTextContent('连不上服务器')
  })

  it('错误里带出 request_id，让人能抄去查日志', async () => {
    server.use(
      http.post(`${BASE}/api/auth/login`, () =>
        HttpResponse.json(envelope(Code.INVALID_CREDENTIALS, '用户名或密码错误', 401).body, { status: 401 }),
      ),
    )

    render()
    await submit()

    expect(await screen.findByRole('alert')).toHaveTextContent('test-req-invalid_credentials')
  })
})
