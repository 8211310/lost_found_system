// src/pages/CreditLogsPage.test.tsx —— #33 积分流水：这一页的断言几乎全在「不许说的话」上。
//
// 后端那个 credit_score 是**现读**的当前分（直接从 JWT 用户那行取），不是流水加出来的。
// 所以「合计 / 累计 / 一共」任何一句都会在某天变成假话 —— 一旦有历史归档或对账差额，
// 屏幕上那句话就和屏幕上那个数打架。这个文件用夹具把这件事钉住：
// sampleCreditHistory 故意给一条 +2 的流水配 105 分，两者本来就不相等。
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import CreditLogsPage from './CreditLogsPage'
import { renderRouted } from '../test/render'
import { server } from '../test/server'
import { BASE, envelope, ok, sampleCreditHistory, sampleCreditLog, sampleUser } from '../test/helpers'
import { setToken } from '../api/session'
import type { CreditHistory } from '../api/types'

function mockLogs(history: CreditHistory, calls: { url: string; times: number } = { url: '', times: 0 }) {
  setToken('jwt.me')
  server.use(
    http.get(`${BASE}/api/auth/me`, () => HttpResponse.json(ok(sampleUser({ credit_score: history.credit_score })))),
    http.get(`${BASE}/api/my/credit-logs`, (c) => {
      calls.url = c.request.url
      calls.times += 1
      return HttpResponse.json(ok(history))
    }),
  )
  return calls
}

describe('当前分与流水的关系', () => {
  it('当前分单独一块显示，页面上不出现任何「合计」式说法', async () => {
    const history = sampleCreditHistory([sampleCreditLog({ delta: 2 })])
    mockLogs(history)
    const { container } = renderRouted('/me/credit', <CreditLogsPage />, '/me/credit')

    expect(await screen.findByText('105')).toBeInTheDocument()

    // +2 的流水配 105 分：这两个数之间没有等式，所以任何求和文案都是编的。
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/合计|累计|一共\s*\d+\s*分/)
    expect(text).toContain('当前信用分')
  })

  it('加分带加号、扣分带减号，两者在文字上分得出来', async () => {
    mockLogs(
      sampleCreditHistory([
        sampleCreditLog({ id: 1, delta: 2, reason: '归还确认通过' }),
        sampleCreditLog({ id: 2, delta: -1, reason: '帖子被举报下架' }),
      ]),
    )

    renderRouted('/me/credit', <CreditLogsPage />, '/me/credit')

    const plus = await screen.findByText('+2')
    const minus = await screen.findByText('-1')
    expect(plus).toHaveClass('log-delta-plus')
    expect(minus).toHaveClass('log-delta-minus')
    expect(within(minus.closest('li')!).getByText('帖子被举报下架')).toBeInTheDocument()
  })

  it('来源只是文字，不做链接：ref_type / ref_id 在库里可空，能不能点开不是能假设的事', async () => {
    mockLogs(
      sampleCreditHistory([
        sampleCreditLog({ ref_type: 'item_return', ref_id: 9 }),
        sampleCreditLog({ id: 2, reason: '管理员手工调整', ref_type: null, ref_id: null }),
      ]),
    )

    renderRouted('/me/credit', <CreditLogsPage />, '/me/credit')
    const withRef = await screen.findByText(/来源 item_return #9/)
    const without = await screen.findByText('管理员手工调整')

    expect(withRef.closest('a')).toBeNull()
    // 没有业务行那一条不能凭空拼出一个「#」来：那看着像一个坏掉的链接。
    expect(within(without.closest('li')!).queryByText(/来源/)).not.toBeInTheDocument()
  })

  it('时间显示的是换算过的形状，不是后端那串带 Z 的 UTC', async () => {
    mockLogs(sampleCreditHistory([sampleCreditLog({ created_at: '2026-10-07T03:00:00Z' })]))

    renderRouted('/me/credit', <CreditLogsPage />, '/me/credit')
    const row = (await screen.findByText('归还确认通过')).closest('li')!

    expect(row.textContent).not.toContain('2026-10-07T03:00:00Z')
    expect(row.textContent).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  })
})

describe('空、翻页与失败', () => {
  it('从没发生过积分变动时，空态那句要说「空不代表分数有问题」', async () => {
    mockLogs(sampleCreditHistory([]))

    renderRouted('/me/credit', <CreditLogsPage />, '/me/credit')

    expect(await screen.findByText(/还没有积分流水/)).toBeInTheDocument()
    expect(screen.getByText(/当前分才是结论/)).toBeInTheDocument()
  })

  it('下一页把 page 带上，第 1 页不写这个参数', async () => {
    const user = userEvent.setup()
    const calls = mockLogs(sampleCreditHistory([sampleCreditLog()], { total: 45 }))

    renderRouted('/me/credit', <CreditLogsPage />, '/me/credit')
    await screen.findByText('+2')
    expect(new URL(calls.url).searchParams.has('page')).toBe(false)

    await user.click(screen.getByRole('button', { name: '下一页' }))
    await screen.findByText('+2')
    expect(new URL(calls.url).searchParams.get('page')).toBe('2')
  })

  it('报 INTERNAL 时显示请求编号 —— 这一页的数字要能被拿去日志里捞链路', async () => {
    setToken('jwt.me')
    server.use(
      http.get(`${BASE}/api/auth/me`, () => HttpResponse.json(ok(sampleUser()))),
      http.get(
        `${BASE}/api/my/credit-logs`,
        () => HttpResponse.json(envelope('INTERNAL', '读流水失败', 500).body, { status: 500 }),
      ),
    )

    renderRouted('/me/credit', <CreditLogsPage />, '/me/credit')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('服务器出错了')
    expect(alert).toHaveTextContent('test-req-internal')
  })
})
