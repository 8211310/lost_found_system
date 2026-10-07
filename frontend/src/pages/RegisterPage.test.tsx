// src/pages/RegisterPage.test.tsx —— #1 注册页的行为。
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { Route, Routes } from 'react-router-dom'
import LoginPage from './LoginPage'
import RegisterPage from './RegisterPage'
import { BASE, envelope, ok, sampleRegister } from '../test/helpers'
import { server } from '../test/server'
import { renderWithAuth } from '../test/render'
import { Code } from '../api/codes'

const PATHS = (
  <Routes>
    <Route path="/register" element={<RegisterPage />} />
    <Route path="/login" element={<LoginPage />} />
  </Routes>
)

function render() {
  return renderWithAuth(PATHS, '/register')
}

async function fill(username = 'xiaowang', password = 'pw12345678') {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText(/用户名/), username)
  await user.type(screen.getByLabelText('密码'), password)
  await user.click(screen.getByRole('button', { name: '注册' }))
  return user
}

describe('注册成功', () => {
  it('跳到登录页并说明要再登一次 —— #1 的响应里没有 token，这是唯一正确的做法', async () => {
    server.use(http.post(`${BASE}/api/auth/register`, () => HttpResponse.json(ok(sampleRegister()))))

    render()
    await fill()

    await waitFor(() => expect(screen.getByRole('heading', { name: '登录' })).toBeInTheDocument())
    expect(await screen.findByText(/注册成功/)).toBeInTheDocument()
  })

  it('昵称留空也发得出去（后端把空昵称折成默认值，前端不该拦）', async () => {
    let sentBody: Record<string, unknown> = {}
    server.use(
      http.post(`${BASE}/api/auth/register`, async (c) => {
        sentBody = (await c.request.json()) as Record<string, unknown>
        return HttpResponse.json(ok(sampleRegister()))
      }),
    )

    render()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/用户名/), 'xiaowang')
    await user.type(screen.getByLabelText('密码'), 'pw12345678')
    await user.click(screen.getByRole('button', { name: '注册' }))

    await waitFor(() => expect(screen.getByRole('heading', { name: '登录' })).toBeInTheDocument())
    expect(sentBody.username).toBe('xiaowang')
    expect(sentBody.nickname).toBeUndefined()
  })
})

describe('注册失败', () => {
  it('USER_ALREADY_EXISTS：说清是用户名重了，并留在本页', async () => {
    server.use(
      http.post(`${BASE}/api/auth/register`, () =>
        HttpResponse.json(envelope(Code.USER_ALREADY_EXISTS, '用户名已被注册', 409).body, { status: 409 }),
      ),
    )

    render()
    await fill()

    expect(await screen.findByRole('alert')).toHaveTextContent('已经被注册')
    expect(screen.getByRole('button', { name: '注册' })).toBeEnabled()
  })

  it('WEAK_PASSWORD：密码规则由后端判，前端只翻译成人话', async () => {
    // 断言的重点是「请求真的发出去了」：如果前端自己加了纯数字拦截，
    // 这里就会看不到任何请求，而那条规则并不属于前端（和 contact 不做格式校验同理）。
    let reached = false
    server.use(
      http.post(`${BASE}/api/auth/register`, () => {
        reached = true
        return HttpResponse.json(envelope(Code.WEAK_PASSWORD, '密码至少 8 位，且不能是纯数字', 400).body, {
          status: 400,
        })
      }),
    )

    render()
    await fill('xiaowang', '12345678')

    expect(await screen.findByRole('alert')).toHaveTextContent('至少 8 位')
    expect(reached).toBe(true)
  })

  it('表里没有的 code 兜底显示后端 message —— 显示文案不等于依赖文案做分支', async () => {
    server.use(
      http.post(`${BASE}/api/auth/register`, () =>
        HttpResponse.json(envelope(Code.VALIDATION, '用户名不能包含空格', 400).body, { status: 400 }),
      ),
    )

    render()
    await fill('xiao wang')

    expect(await screen.findByRole('alert')).toHaveTextContent('用户名不能包含空格')
  })
})
