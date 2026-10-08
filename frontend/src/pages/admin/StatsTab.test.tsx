// src/pages/admin/StatsTab.test.tsx —— #37 七组全站计数。
//
// 这一页没有交互，所以它唯一的错法是**把数字解释错**，而最常见的一种就是自己加总。
// 后端在 model/stats.go:82-91 明写了三处「这里不给」：
//   ① items_count 没有 total（View() 刻意摘的，因为 lost+found 与 open+closed+deleted 都等于它，
//      两组都不给就等于不给）；
//   ② returns_count 没有 cancelled（用户自己撤掉的那一类对治理没有信息量）；
//   ③ users_count 那个键叫 hduhelp（Go 那边叫 SSO，对外以第三方服务的名字为准）。
// 夹具按等式给数（28+13=41、50+37=60+17+10=87），所以任何「顺手加一个总数」
// 都会在断言里被抓出来 —— 这一页不该出现 87 那个数，哪怕它是算得出来的。
import { screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import StatsTab from './StatsTab'
import { BASE, envelope, ok, sampleAdminStats, sampleUser } from '../../test/helpers'
import { renderRouted } from '../../test/render'
import { server } from '../../test/server'
import { setToken } from '../../api/session'
import { Code } from '../../api/codes'

function mockStats(overrides = {}) {
  const data = sampleAdminStats(overrides)
  setToken('jwt.admin.token')
  server.use(http.get(`${BASE}/api/admin/stats`, () => HttpResponse.json(ok(data))))
  return data
}

/** 取 <dt> 后面那一个 <dd> 的文本。这一页全是 dt/dd 成对，按顺序取比按 class 猜稳。 */
function valueFor(term: string): string {
  const dt = screen.getByText(term)
  return dt.nextElementSibling!.textContent!
}

describe('七组数', () => {
  it('用户那一组：总数、两种来源、已封禁', async () => {
    mockStats()
    renderRouted('/admin', <StatsTab />, '/admin')

    await screen.findByText('账号总数')
    expect(valueFor('账号总数')).toBe('41')
    expect(valueFor('本地账号')).toBe('28')
    // 对外键名是 hduhelp（第三方服务自己的名字），页面上就得说「杭电助手」而不是「第三方」。
    expect(valueFor('杭电助手')).toBe('13')
    expect(valueFor('已封禁')).toBe('2')
    expect(document.body.textContent).not.toMatch(/第三方登录|SSO/)
  })

  it('帖子那一组分两组并列，但不给总数', async () => {
    mockStats()
    renderRouted('/admin', <StatsTab />, '/admin')

    await screen.findByText('失物 / 拾物')
    expect(valueFor('失物 / 拾物')).toBe('50 / 37')
    expect(valueFor('在显示 / 已关闭 / 已下架')).toBe('60 / 17 / 10')

    // 87 是算得出来的，但这一页不算：两组加起来都等于它，挑一组显示等于误导。
    expect(document.body.textContent).not.toContain('87')
    expect(document.body.textContent).not.toMatch(/帖子总数|共 \d+ 条帖/)
  })

  it('归还确认那一组没有「已撤销」那一档', async () => {
    mockStats()
    renderRouted('/admin', <StatsTab />, '/admin')

    await screen.findByText('等人处理')
    expect(valueFor('等人处理')).toBe('6')
    expect(valueFor('发帖人确认过')).toBe('12')
    expect(valueFor('发帖人拒绝过')).toBe('4')
    expect(document.body.textContent).not.toContain('已撤销')
  })

  it('举报三种状态、解锁次数、留痕条数各归各的组', async () => {
    mockStats()
    renderRouted('/admin', <StatsTab />, '/admin')

    await screen.findByText('待处理 / 已采纳 / 未采纳')
    expect(valueFor('待处理 / 已采纳 / 未采纳')).toBe('5 / 9 / 3')
    expect(valueFor('解锁查看次数')).toBe('33')
    expect(valueFor('治理留痕条数')).toBe('21')
  })

  it('今日新增那格必须带上「按数据库时区」这半句', async () => {
    mockStats()
    renderRouted('/admin', <StatsTab />, '/admin')

    await screen.findByText('今日新增')
    const dd = screen.getByText('今日新增').nextElementSibling!
    expect(dd.textContent).toContain('3')
    // 少了这半句，凌晨对不上账时会像坏了一样：那一格用的是 date_trunc('day', now())，
    // 会话时区，而响应里别处一律 UTC。
    expect(dd.textContent).toContain('按数据库时区切的一天，不是浏览器这个时区')
  })
})

describe('「已下架」那一列怎么读', () => {
  it('说明写清了它混着四种来源，而区分它们的是留痕不是这一格', async () => {
    mockStats()
    renderRouted('/admin', <StatsTab />, '/admin')

    const hint = await screen.findByText(/作者自己删、管理员从后台删、批量下架/)
    expect(hint.textContent).toContain('那里筛不到，就说明是作者自己删的')
    // 解锁那一格的身份也要说准：它是「骚扰的唯一事后证据」，不是「谁对帖子感兴趣」。
    expect(screen.getByText(/骚扰的唯一事后证据/)).toBeInTheDocument()
  })
})

describe('拿不到数时', () => {
  it('报的是那句人话 + 请求编号，而不是把七组零当结果显示出来', async () => {
    setToken('jwt.admin.token')
    server.use(
      http.get(`${BASE}/api/auth/me`, () => HttpResponse.json(ok(sampleUser({ role: 'admin', nickname: '管理员' })))),
      http.get(`${BASE}/api/admin/stats`, () =>
        HttpResponse.json(envelope(Code.INTERNAL, '服务器内部错误', 500).body, { status: 500 }),
      ),
    )

    renderRouted('/admin', <StatsTab />, '/admin')

    // 按 code 翻成人话（计划 §M7 第一条约定的另一半）：INTERNAL 这一格给的是
    // 「带上请求编号去反馈」那句，而不是把后端原始 message 复读一遍。
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/请带上/)
    expect(alert).toHaveTextContent(/请求编号/)
    // 零和「不知道」是两件事：全零会被读成「这系统是空的」，那比报错坏得多。
    expect(screen.queryByText('账号总数')).not.toBeInTheDocument()
  })
})
