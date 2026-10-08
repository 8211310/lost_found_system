// src/auth/RequireAdmin.test.tsx —— 后台那道门。
//
// 这里钉的不是「能不能看到这段文字」，而是**渲染时机**：
// #3 还没回来时 role 是未知的，那时如果把 children 放出去，五个页签会各自发一条必然 403 的请求。
// 一次点错链接在生产日志里留下五条噪音，而那五条噪音盖住的正是「谁在这时候动过数据」——
// 这一本账存在的唯一理由。所以「loading 时不渲染 children」必须是一条断言，不能是一句注释。
import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { RequireAdmin } from './RequireAdmin'
import { BASE, ok, sampleUser } from '../test/helpers'
import { renderWithAuth } from '../test/render'
import { server } from '../test/server'
import { setToken } from '../api/session'

const GATED = (
  <RequireAdmin>
    <p>后台内容桩</p>
  </RequireAdmin>
)

function asAdmin() {
  setToken('jwt.admin.token')
  server.use(http.get(`${BASE}/api/auth/me`, () => HttpResponse.json(ok(sampleUser({ role: 'admin' })))))
}

describe('还没问出身份（#3 在路上）', () => {
  it('只说「正在确认」，不放 children 出去', () => {
    asAdmin()
    renderWithAuth(GATED, '/admin')

    // 这一行必须在任何 await 之前：它验的就是「还没问出来」那一瞬间。
    expect(screen.getByText('正在确认登录状态…')).toBeInTheDocument()
    expect(screen.queryByText('后台内容桩')).not.toBeInTheDocument()
  })
})

describe('问出来是普通用户', () => {
  it('看到「只有管理员能看」，而且 children 一点都没渲染', async () => {
    setToken('jwt.user')
    server.use(http.get(`${BASE}/api/auth/me`, () => HttpResponse.json(ok(sampleUser({ role: 'user' })))))
    renderWithAuth(GATED, '/admin')

    await waitFor(() => expect(screen.getByRole('heading', { name: '这一页只有管理员能看' })).toBeInTheDocument())
    expect(screen.queryByText('后台内容桩')).not.toBeInTheDocument()
  })
})

describe('问出来是管理员', () => {
  it('children 正常放行', async () => {
    asAdmin()
    renderWithAuth(GATED, '/admin')

    expect(await screen.findByText('后台内容桩')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '这一页只有管理员能看' })).not.toBeInTheDocument()
  })
})

describe('没登录', () => {
  it('没有 token 时不猜身份：走「不是管理员」那一格，且不打后台任何一条端点', async () => {
    // 不注册任何 /api/admin/* handler：msw 的 onUnhandledRequest:'error' 会在这种请求出现时直接炸，
    // 所以「渲染没抛错 + 看到了拒绝页」本身就是那条断言。
    renderWithAuth(GATED, '/admin')

    await waitFor(() => expect(screen.getByRole('heading', { name: '这一页只有管理员能看' })).toBeInTheDocument())
  })
})
