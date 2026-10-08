// src/pages/admin/AdminPage.test.tsx —— 那一页七个页签的外壳。
//
// 这里钉两件在代码里最容易悄悄坏掉的事：
// ① 顺序和默认页签。计划 §M7 给的是「用户 / 举报待办 / 批量下架 / 操作日志 / 统计」这个次序
//    （先看清人 → 再看待办 → 才动手 → 回头看账），默认停在用户：
//    刚进后台的人第一眼该是「这系统里有谁」，不是一片勾选框。
//    「字典」和「诊断」排在最后，因为它们不在 §M7 那五个里，是 2026-10-08 补的 #9–#12 和 #39。
// ② 换页签时上一个页签的查询参数必须丢掉。所有页签共用一条地址，
//    而它们的筛选参数**同名不同义**：#34 的 status 是 active/banned，
//    #48 的 status 是 open/resolved/dismissed，#14 的 status 是 open/closed/deleted。
//    带过去不会安静地返回空列表，而是后端那条 VALIDATION ——
//    人会以为是自己点错了页签，而这不是他的错。
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import AdminPage from './AdminPage'
import { RequireAdmin } from '../../auth/RequireAdmin'
import {
  BASE,
  ok,
  sampleAdminReport,
  sampleAdminStats,
  sampleAdminUser,
  sampleCategories,
  sampleLocations,
  samplePage,
  sampleUser,
} from '../../test/helpers'
import { renderRouted } from '../../test/render'
import { server } from '../../test/server'
import { setToken } from '../../api/session'

const TAB_NAMES = ['用户', '举报待办', '批量下架', '操作日志', '统计', '字典', '诊断']

/** #3 的身份刻意用 id=7 的管理员，和下面 #34 行里的 id=12 岔开：
 *  「这是你自己」那一格只该在该出现的时候出现。 */
function asAdmin() {
  setToken('jwt.admin.token')
  server.use(
    http.get(`${BASE}/api/auth/me`, () => HttpResponse.json(ok(sampleUser({ id: 7, role: 'admin', nickname: '管理员' })))),
  )
}

function tabGroup() {
  return screen.findByRole('group', { name: '管理后台页签' })
}

describe('页签条', () => {
  it('七个页签按钉住的顺序排，默认停在「用户」并发出 #34', async () => {
    let usersCalls = 0
    asAdmin()
    server.use(
      http.get(`${BASE}/api/admin/users`, () => {
        usersCalls += 1
        return HttpResponse.json(ok(samplePage([sampleAdminUser({ id: 12, nickname: '小李' })])))
      }),
    )

    renderRouted('/admin', <AdminPage />, '/admin')

    const group = await tabGroup()
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(TAB_NAMES)
    expect(within(group).getByRole('button', { name: '用户' })).toHaveAttribute('aria-pressed', 'true')

    expect(await screen.findByText('小李')).toBeInTheDocument()
    expect(usersCalls).toBe(1)
  })

  it('顶上那句边界在场：admin 能销毁内容和账号，但不能制造归属', async () => {
    asAdmin()
    server.use(http.get(`${BASE}/api/admin/users`, () => HttpResponse.json(ok(samplePage([])))))

    renderRouted('/admin', <AdminPage />, '/admin')

    // 这句话被删掉不会让任何功能坏掉，所以只有断言能留住它 ——
    // 而它是这一族端点唯一的「为什么这里没有 confirm/reject 按钮」的说明。
    expect(await screen.findByText(/admin 能销毁内容和账号，但不能制造归属/)).toBeInTheDocument()
  })

  it('tab 值认不出来时退回「用户」而不是白屏', async () => {
    asAdmin()
    server.use(
      http.get(`${BASE}/api/admin/users`, () => HttpResponse.json(ok(samplePage([sampleAdminUser({ nickname: '小李' })])))),
    )

    renderRouted('/admin', <AdminPage />, '/admin?tab=%E9%9A%8F%E4%BE%BF%E5%86%99%E7%9A%84')

    expect(await screen.findByText('小李')).toBeInTheDocument()
    const group = await tabGroup()
    expect(within(group).getByRole('button', { name: '用户' })).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('换页签', () => {
  it('上一个页签的筛选参数不会带过去', async () => {
    const seen: string[] = []
    asAdmin()
    server.use(
      http.get(`${BASE}/api/admin/reports`, (c) => {
        seen.push(`reports ${c.request.url}`)
        return HttpResponse.json(ok(samplePage([sampleAdminReport({ status: 'dismissed' })])))
      }),
      http.get(`${BASE}/api/admin/users`, (c) => {
        seen.push(`users ${c.request.url}`)
        return HttpResponse.json(ok(samplePage([sampleAdminUser({ nickname: '小李' })])))
      }),
    )

    renderRouted('/admin', <AdminPage />, '/admin?tab=reports&status=dismissed')
    await screen.findByText('捡到黑色长款钱包')
    expect(seen[0]).toContain('status=dismissed')

    await userEvent.setup().click(screen.getByRole('button', { name: '用户' }))

    await waitFor(() => expect(seen.some((u) => u.startsWith('users '))).toBe(true))
    const usersUrl = seen.find((u) => u.startsWith('users '))!
    // dismissed 对 #34 是一个非法的 status 值，后端回的是 VALIDATION。
    expect(usersUrl).not.toContain('dismissed')
    expect(usersUrl).not.toContain('status=')
  })

  it('直接开在 ?tab=stats 时只发 #37，「用户」那一页一次请求都不发', async () => {
    const calls = { stats: 0, users: 0 }
    asAdmin()
    server.use(
      http.get(`${BASE}/api/admin/users`, () => {
        calls.users += 1
        return HttpResponse.json(ok(samplePage([])))
      }),
      http.get(`${BASE}/api/admin/stats`, () => {
        calls.stats += 1
        return HttpResponse.json(ok(sampleAdminStats()))
      }),
    )

    renderRouted('/admin', <AdminPage />, '/admin?tab=stats')

    expect(await screen.findByText('账号总数')).toBeInTheDocument()
    expect(calls.stats).toBe(1)
    expect(calls.users).toBe(0)
  })

  it('字典页签读的是公开那两棵树（#7/#8），不是任何 /api/admin 路由', async () => {
    const calls = { users: 0, categories: 0, locations: 0 }
    asAdmin()
    server.use(
      http.get(`${BASE}/api/admin/users`, () => {
        calls.users += 1
        return HttpResponse.json(ok(samplePage([])))
      }),
      http.get(`${BASE}/api/categories`, () => {
        calls.categories += 1
        return HttpResponse.json(ok(sampleCategories()))
      }),
      http.get(`${BASE}/api/locations`, () => {
        calls.locations += 1
        return HttpResponse.json(ok(sampleLocations()))
      }),
    )

    renderRouted('/admin', <AdminPage />, '/admin?tab=dict')

    // 认路径而不是认「钱包」：树是平铺展示的，同名的条目在两张表里都真的存在。
    expect(await screen.findByText('衣物箱包 / 钱包')).toBeInTheDocument()
    expect(calls.categories).toBe(1)
    expect(calls.locations).toBe(1)
    expect(calls.users).toBe(0)
  })

  it('诊断页签打的是 /api/debug/config，它不在 /api/admin 那个组里', async () => {
    const calls = { adminUsers: 0, debug: 0 }
    asAdmin()
    server.use(
      http.get(`${BASE}/api/admin/users`, () => {
        calls.adminUsers += 1
        return HttpResponse.json(ok(samplePage([])))
      }),
      http.get(`${BASE}/api/debug/config`, () => {
        calls.debug += 1
        return HttpResponse.json(ok({ env: 'dev', port: '8080' }))
      }),
    )

    renderRouted('/admin', <AdminPage />, '/admin?tab=debug')

    expect(await screen.findByText('当前环境')).toBeInTheDocument()
    expect(calls.debug).toBe(1)
    expect(calls.adminUsers).toBe(0)
  })
})

describe('非管理员停在任何一个页签上', () => {
  it('连 #37 都不会发一次', async () => {
    let statsCalls = 0
    setToken('jwt.user')
    server.use(
      http.get(`${BASE}/api/auth/me`, () => HttpResponse.json(ok(sampleUser({ role: 'user' })))),
      http.get(`${BASE}/api/admin/stats`, () => {
        statsCalls += 1
        return HttpResponse.json(ok(sampleAdminStats()))
      }),
    )

    renderRouted('/admin', <RequireAdmin><AdminPage /></RequireAdmin>, '/admin?tab=stats')

    await waitFor(() => expect(screen.getByRole('heading', { name: '这一页只有管理员能看' })).toBeInTheDocument())
    expect(statsCalls).toBe(0)
  })
})
