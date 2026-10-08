// src/pages/admin/UsersTab.test.tsx —— #34 找人 + #35/#36/#47 三个后果不同的动作。
//
// 这一页最值得钉的是三件事：
// ① 自己的那一行不给「降级」和「封自己」。后端两个方向都是 FORBIDDEN，
//    理由是同一条不可恢复论证（全站只剩一个 admin 时把自己降下去，没有任何 admin 路径能挽回）。
//    按钮摆在那儿点一下拿 403，比不摆更坏 —— 那会让人以为后台坏了。
// ② 理由为空时「确定」先是禁用的，不是点下去再弹 VALIDATION（计划 §M7 钉的那条）。
// ③ 三件事的后果文案各说各的：警告=零自动后果、改角色=不发通知、封号=立刻且没有到期时间。
//    把它们写成同一句「操作成功，已通知对方」就是撒谎，因为改角色压根不发通知。
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import UsersTab from './UsersTab'
import { BASE, envelope, ok, sampleAdminUser, samplePage, sampleUser } from '../../test/helpers'
import { renderRouted } from '../../test/render'
import { server } from '../../test/server'
import { setToken } from '../../api/session'
import { Code } from '../../api/codes'

/** #34 默认那一页：id=7 是「我」（管理员），id=12 小李是正常用户，id=13 小王已被封。
 *  三个人的 role/status 各不相同，这样「该行该有哪些按钮」不需要靠顺序猜。 */
function mockList() {
  const calls: { url: string } = { url: '' }
  setToken('jwt.admin.token')
  server.use(
    http.get(`${BASE}/api/auth/me`, () => HttpResponse.json(ok(sampleUser({ id: 7, role: 'admin', nickname: '管理员' })))),
    http.get(`${BASE}/api/admin/users`, (c) => {
      calls.url = c.request.url
      return HttpResponse.json(
        ok(
          samplePage([
            sampleAdminUser({
              id: 7,
              username: 'adminone',
              nickname: '管理员',
              real_name: '',
              role: 'admin',
              credit_score: 100,
            }),
            sampleAdminUser({ id: 12, username: 'xiaoli', nickname: '小李', real_name: '李雷', role: 'user' }),
            sampleAdminUser({
              id: 13,
              // 杭电助手那边没有本地登录名，后端给的是空串而不是 null（SSO 用户不在这边设密码）。
              username: '',
              nickname: '小王',
              real_name: '',
              role: 'user',
              status: 'banned',
              auth_source: 'hduhelp',
            }),
          ]),
        ),
      )
    }),
  )
  return calls
}

// 按昵称那一格找行：#34 返回的 nickname 在夹具里互不相同。
// 「我」那一行用 #7 而不是「管理员」——那两个字同时是昵称和角色标签，getByText 会拿到两个元素。
async function rowOf(name: string): Promise<HTMLElement> {
  const cell = await screen.findByText(name)
  return cell.closest('li')!
}

async function openAction(rowName: string, action: string) {
  const row = await rowOf(rowName)
  await userEvent.setup().click(within(row).getByRole('button', { name: action }))
}

describe('#34 列表', () => {
  it('默认不筛状态：被封禁的人第一屏就在列表里', async () => {
    const calls = mockList()
    renderRouted('/admin', <UsersTab />, '/admin')

    expect(await screen.findByText('小王')).toBeInTheDocument()
    // 「找人」时默认把人藏掉是更坏的默认，所以这里必须没有 status=active 那种隐藏筛选。
    expect(calls.url).not.toContain('status=')
    expect(calls.url).not.toContain('role=')
    expect(calls.url).toContain('page_size=20')
  })

  it('每行给的是那 9 列：昵称、编号、角色、状态、登录名、真实姓名、来源、信用分、注册时间', async () => {
    mockList()
    renderRouted('/admin', <UsersTab />, '/admin')

    const row = await rowOf('小李')
    expect(within(row).getByText('#12')).toBeInTheDocument()
    expect(within(row).getByText(/登录名 xiaoli/)).toBeInTheDocument()
    expect(within(row).getByText(/李雷/)).toBeInTheDocument()
    expect(within(row).getByText(/本地账号/)).toBeInTheDocument()
    expect(within(row).getByText(/信用分 100/)).toBeInTheDocument()

    // 时间必须是换算过的形状：后端出口一律带 Z 的 UTC，直接显示会差一个时区。
    expect(row.textContent).not.toContain('2026-10-05T01:00:00Z')
    expect(row.textContent).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  })

  it('杭电助手来的账号没有登录名，那一格说真话而不是留白', async () => {
    mockList()
    renderRouted('/admin', <UsersTab />, '/admin')

    const row = await rowOf('小王')
    expect(within(row).getByText(/（无：杭电助手账号）/)).toBeInTheDocument()
    expect(within(row).getByText(/已封禁/)).toBeInTheDocument()
  })

  it('这一页不显示联系方式，并且把这件事说明白了', async () => {
    mockList()
    renderRouted('/admin', <UsersTab />, '/admin')

    await screen.findByText('小李')
    expect(await screen.findByText(/列表里看不到手机号和邮箱/)).toBeInTheDocument()
  })
})

describe('自己的那一行', () => {
  it('没有「降级」也没有「封自己」，但「发警告」还在', async () => {
    mockList()
    renderRouted('/admin', <UsersTab />, '/admin')

    const row = await rowOf('#7')
    expect(within(row).getByText('这是你自己')).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: '降为普通用户' })).not.toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: '封禁' })).not.toBeInTheDocument()
    expect(within(row).getByRole('button', { name: '发警告' })).toBeInTheDocument()
  })

  it('别人的行按当前身份给对应的两个动作', async () => {
    mockList()
    renderRouted('/admin', <UsersTab />, '/admin')

    const user = await rowOf('小李')
    expect(within(user).getByRole('button', { name: '提为管理员' })).toBeInTheDocument()
    expect(within(user).getByRole('button', { name: '封禁' })).toBeInTheDocument()

    const banned = await rowOf('小王')
    expect(within(banned).getByRole('button', { name: '解封' })).toBeInTheDocument()
    expect(within(banned).queryByRole('button', { name: '封禁' })).not.toBeInTheDocument()
  })
})

describe('理由为空时先禁用（计划钉的那条）', () => {
  it('三个动作都是同一个形状：禁用 → 填了才放开 → 字数实时跟着', async () => {
    mockList()
    renderRouted('/admin', <UsersTab />, '/admin')

    await openAction('小李', '封禁')

    const okBtn = screen.getByRole('button', { name: '确定' })
    expect(okBtn).toBeDisabled()
    expect(within(await rowOf('小李')).getByText('必须填写理由')).toBeInTheDocument()

    await userEvent.setup().type(screen.getByLabelText('理由（必填）'), '批量发布广告且拒不改正')
    await waitFor(() => expect(okBtn).toBeEnabled())
    expect(screen.getByText('11 / 500 字')).toBeInTheDocument()
  })
})

describe('#36 封号', () => {
  it('发的是 status=banned + 那句理由，提示说清了「立刻」和「没有到期时间」', async () => {
    mockList()
    let body: Record<string, unknown> = {}
    server.use(
      http.put(`${BASE}/api/admin/users/:id/status`, async (c) => {
        body = (await c.request.json()) as Record<string, unknown>
        return HttpResponse.json(ok({ id: 12, status: 'banned' }))
      }),
    )

    renderRouted('/admin', <UsersTab />, '/admin')
    await openAction('小李', '封禁')
    expect(within(await rowOf('小李')).getByText(/只能由管理员再点一次解封/)).toBeInTheDocument()

    await userEvent.setup().type(screen.getByLabelText('理由（必填）'), '批量发布广告')
    await userEvent.setup().click(screen.getByRole('button', { name: '确定' }))

    await waitFor(() => expect(body.reason).toBe('批量发布广告'))
    expect(body.status).toBe('banned')
    expect(await screen.findByText(/旧 token 当场失效/)).toBeInTheDocument()
    expect(screen.getByText(/留痕是 user_ban/)).toBeInTheDocument()
  })

  it('解封那一句会说「他能重新登录」，不会说「之前的记录没了」', async () => {
    mockList()
    server.use(
      http.put(`${BASE}/api/admin/users/:id/status`, () => HttpResponse.json(ok({ id: 13, status: 'active' }))),
    )

    renderRouted('/admin', <UsersTab />, '/admin')
    await openAction('小王', '解封')

    await userEvent.setup().type(screen.getByLabelText('理由（必填）'), '误封，已当面核实')
    await userEvent.setup().click(screen.getByRole('button', { name: '确定' }))

    expect(await screen.findByText(/已解封，现在能重新登录/)).toBeInTheDocument()
    expect(screen.getByText(/留痕是 user_unban/)).toBeInTheDocument()
  })
})

describe('#35 改角色', () => {
  it('提示明说「不发通知」，成功后报的是响应里那个 role 而不是点之前的猜测', async () => {
    mockList()
    let body: Record<string, unknown> = {}
    server.use(
      http.put(`${BASE}/api/admin/users/:id/role`, async (c) => {
        body = (await c.request.json()) as Record<string, unknown>
        return HttpResponse.json(ok({ id: 12, role: 'admin' }))
      }),
    )

    renderRouted('/admin', <UsersTab />, '/admin')
    await openAction('小李', '提为管理员')
    expect(within(await rowOf('小李')).getByText(/这件事不发通知/)).toBeInTheDocument()

    await userEvent.setup().type(screen.getByLabelText('理由（必填）'), '协助处理积压举报')
    await userEvent.setup().click(screen.getByRole('button', { name: '确定' }))

    await waitFor(() => expect(body.role).toBe('admin'))
    expect(body.reason).toBe('协助处理积压举报')
    const notice = await screen.findByText(/#12 现在的角色是 管理员/)
    expect(notice.textContent).toContain('这件事没有发通知')
    expect(document.body.textContent).not.toMatch(/已通知对方|对方已收到/)
  })
})

describe('#47 警告', () => {
  it('后果那一格说「没有任何自动后果」，而不是「已记入档案」', async () => {
    mockList()
    let body: Record<string, unknown> = {}
    server.use(
      http.post(`${BASE}/api/admin/users/:id/warn`, async (c) => {
        body = (await c.request.json()) as Record<string, unknown>
        return HttpResponse.json(ok({ id: 12, notified: true }))
      }),
    )

    renderRouted('/admin', <UsersTab />, '/admin')
    await openAction('小李', '发警告')
    expect(within(await rowOf('小李')).getByText(/没有任何自动后果/)).toBeInTheDocument()

    await userEvent.setup().type(screen.getByLabelText('理由（必填）'), '私信里向他人索要联系方式')
    await userEvent.setup().click(screen.getByRole('button', { name: '确定' }))

    await waitFor(() => expect(body.reason).toBe('私信里向他人索要联系方式'))
    // 请求体只有 reason 这一键：没有「第几次警告」那种计数列，schema 里压根没那玩意儿。
    expect(Object.keys(body)).toEqual(['reason'])
    expect(await screen.findByText(/除了那一条通知和操作日志里的一行账，他本人没有任何改变/)).toBeInTheDocument()
  })
})

describe('被后端拒绝时', () => {
  it('报的是 code 对应的那句人话 + 请求编号，不写「操作成功」', async () => {
    mockList()
    server.use(
      http.put(`${BASE}/api/admin/users/:id/status`, () =>
        HttpResponse.json(envelope(Code.FORBIDDEN, '没有权限执行这个操作', 403).body, {
          status: 403,
        }),
      ),
    )

    renderRouted('/admin', <UsersTab />, '/admin')
    await openAction('小李', '封禁')
    await userEvent.setup().type(screen.getByLabelText('理由（必填）'), '批量发布广告')
    await userEvent.setup().click(screen.getByRole('button', { name: '确定' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/没有权限/)
    expect(alert).toHaveTextContent(/请求编号/)
    expect(screen.queryByText(/已封禁，他手上的旧 token/)).not.toBeInTheDocument()
  })
})
