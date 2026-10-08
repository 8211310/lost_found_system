// src/pages/admin/ReportsTab.test.tsx —— #48 待办 + #49 三种处置。
//
// 这一页最容易「看起来对」而其实是错的两个点都要钉住：
// ① 后端**没有**「默认只看待处理」这一条（不传 status 就是三种一起给），
//    所以「举报待办」这个标题全靠前端自己带上 `status=open` 才成立。
// ② 后端按 created_at DESC 排，而计划要的是「热度高的排前面」，所以那一排序是前端做的，
//    而且**只在当前这一页内成立** —— 但计数本身不是本页的（那条子查询数的是全表的 open 举报），
//    所以标签说的是「这条帖子上 N 条待处理」，既不许写「本页」也不许写成「被举报过几次」。
//
// 措辞纪律同 §3.7：resolution 只说明管理员做了哪个动作，不代表平台认定举报成立。
// 所以这里既不许出现「判定违规」，也不许把回执写成「对方已被处理」。
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import ReportsTab from './ReportsTab'
import { BASE, envelope, ok, sampleAdminReport, samplePage } from '../../test/helpers'
import { renderRouted } from '../../test/render'
import { server } from '../../test/server'
import { setToken } from '../../api/session'
import { Code } from '../../api/codes'
import type { AdminReportRow } from '../../api/types'

/** 三条待办，热度故意按「1、3、2」的顺序给（和后端那个时间序一致）：
 *  这样页面必须自己重排成 3、2、1，忘了排的话顺序就露出来了。 */
const ROWS: AdminReportRow[] = [
  sampleAdminReport({
    id: 901,
    item: { id: 203, title: '白色水杯', status: 'open' },
    report_count_on_item: 1,
    detail: '',
    created_at: '2026-10-07T09:00:00Z',
  }),
  sampleAdminReport({
    id: 902,
    item: { id: 202, title: '捡到黑色长款钱包', status: 'open' },
    reporter: { id: 12, nickname: '小李' },
    reason_code: 'fraud',
    report_count_on_item: 3,
    detail: '同一个人连发五条，每条留的微信都不一样',
    created_at: '2026-10-07T08:00:00Z',
  }),
  sampleAdminReport({
    id: 903,
    item: { id: 204, title: '学生卡', status: 'closed' },
    report_count_on_item: 2,
    created_at: '2026-10-07T07:00:00Z',
  }),
]

function mockList(rows = ROWS) {
  const seen: string[] = []
  setToken('jwt.admin.token')
  server.use(
    http.get(`${BASE}/api/admin/reports`, (c) => {
      seen.push(c.request.url)
      return HttpResponse.json(ok(samplePage(rows)))
    }),
  )
  return seen
}

function titles(): string[] {
  return Array.from(document.querySelectorAll('.adm-row .adm-name')).map((el) => el.textContent!)
}

describe('#48 首屏', () => {
  it('地址里没写 status 时自动带上 status=open —— 不然「待办」这个标题是假的', async () => {
    const seen = mockList()
    renderRouted('/admin', <ReportsTab />, '/admin')

    await screen.findByText('捡到黑色长款钱包')
    expect(seen[0]).toContain('status=open')
  })

  it('选了「全部」就一个 status 都不带（那一档用的是 all 这个哨兵值，不是空串）', async () => {
    const seen = mockList()
    renderRouted('/admin', <ReportsTab />, '/admin')
    await screen.findByText('捡到黑色长款钱包')

    await userEvent.setup().selectOptions(screen.getByLabelText('处理状态'), 'all')

    // 空串在这一页的 URL 写法里等于「删掉这个键」，而删掉等于回到默认的待办 ——
    // 所以「全部」这一档必须有自己的值 all，发出去时才反过来一个 status 都不带。
    await waitFor(() => expect(seen.length).toBe(2))
    expect(seen[1]).not.toContain('status=')
  })

  it('按「这条帖子上还有几条待处理」从重到少重排这一页，并且不冒充那是本页的计数', async () => {
    mockList()
    renderRouted('/admin', <ReportsTab />, '/admin')
    await screen.findByText('捡到黑色长款钱包')

    expect(titles()).toEqual(['捡到黑色长款钱包', '学生卡', '白色水杯'])

    const hottest = screen.getByText('捡到黑色长款钱包').closest('li')!
    expect(within(hottest).getByText('这条帖子上 3 条待处理')).toBeInTheDocument()
    // 三种假说法：把它说成本页的（子查询不受分页影响）、说成历史总次数（那是 reports_count）、
    // 说成全站被举报数（这一页没有那个数）。
    expect(document.body.textContent).not.toMatch(/本页被举报|共被举报|全站被举报/)
  })

  it('举报理由显示成人话，且带着举报人和他填的补充', async () => {
    mockList()
    renderRouted('/admin', <ReportsTab />, '/admin')

    const row = (await screen.findByText('捡到黑色长款钱包')).closest('li')!
    expect(within(row).getByText(/冒领或虚假信息/)).toBeInTheDocument()
    expect(within(row).getByText(/举报人 小李/)).toBeInTheDocument()
    expect(within(row).getByText('同一个人连发五条，每条留的微信都不一样')).toBeInTheDocument()
    // 时间必须是换算过的形状，不能是后端那串带 Z 的 UTC。
    expect(row.textContent).not.toContain('2026-10-07T08:00:00Z')
  })

  it('帖子已经不在广场上了要标出来，但链接照样给（软删的行还在库里）', async () => {
    mockList()
    renderRouted('/admin', <ReportsTab />, '/admin')

    const row = (await screen.findByText('学生卡')).closest('li')!
    expect(within(row).getByText('帖子已是 closed')).toBeInTheDocument()
    expect(within(row).getByRole('link', { name: '打开这条帖子' })).toHaveAttribute('href', '/items/204')
  })

  it('处理过的行不伪装成待办：按钮上写明提交会被告知已处置', async () => {
    mockList([sampleAdminReport({ id: 905, status: 'resolved', report_count_on_item: 1 })])
    renderRouted('/admin', <ReportsTab />, '/admin?status=resolved')

    const row = (await screen.findByText('捡到黑色长款钱包')).closest('li')!
    expect(within(row).getByText('已采纳')).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: /已处理过，提交会被告知已处置/ })).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: '处置这一条' })).not.toBeInTheDocument()
  })
})

describe('#49 处置', () => {
  it('理由为空时「确定」先是禁用的，填了才放开', async () => {
    mockList()
    renderRouted('/admin', <ReportsTab />, '/admin')

    const row = (await screen.findByText('捡到黑色长款钱包')).closest('li')!
    await userEvent.setup().click(within(row).getByRole('button', { name: '处置这一条' }))

    expect(screen.getByRole('button', { name: '确定' })).toBeDisabled()
    expect(screen.getByText('必须填写理由')).toBeInTheDocument()

    await userEvent.setup().type(screen.getByLabelText('理由（必填）'), '冒领他人拾物，已核实五条')
    await waitFor(() => expect(screen.getByRole('button', { name: '确定' })).toBeEnabled())
  })

  it('默认处置是下架：那句后果说清「软删 + 作者收到通知 + 同帖其他待办一起关」', async () => {
    mockList()
    renderRouted('/admin', <ReportsTab />, '/admin')

    const row = (await screen.findByText('捡到黑色长款钱包')).closest('li')!
    await userEvent.setup().click(within(row).getByRole('button', { name: '处置这一条' }))

    expect(within(row).getByText(/它从广场消失（是软删，行还在库里）/)).toBeInTheDocument()
    expect(within(row).getByText(/同一条帖子上其他待处理的举报会一起关掉/)).toBeInTheDocument()
  })

  it('换成封号时，后果那句必须明说帖子不会消失', async () => {
    mockList()
    renderRouted('/admin', <ReportsTab />, '/admin')

    const row = (await screen.findByText('捡到黑色长款钱包')).closest('li')!
    await userEvent.setup().click(within(row).getByRole('button', { name: '处置这一条' }))
    await userEvent.setup().selectOptions(screen.getByLabelText('处置'), 'ban')

    // 「封号 = 内容也没了」是一个很容易顺口说出来的错觉，而后端根本不删那条帖子。
    expect(within(row).getByText(/但这条帖子不会因此消失（封号不删内容）/)).toBeInTheDocument()
  })

  it('发出去的是 resolution + reason；note 没填时那个键压根不出现', async () => {
    mockList()
    let body: Record<string, unknown> = {}
    server.use(
      http.post(`${BASE}/api/admin/reports/:id/resolve`, async (c) => {
        body = (await c.request.json()) as Record<string, unknown>
        return HttpResponse.json(ok({ id: 902, status: 'resolved', resolved_at: '2026-10-07T10:00:00Z' }))
      }),
    )

    renderRouted('/admin', <ReportsTab />, '/admin')
    const row = (await screen.findByText('捡到黑色长款钱包')).closest('li')!
    await userEvent.setup().click(within(row).getByRole('button', { name: '处置这一条' }))
    await userEvent.setup().type(screen.getByLabelText('理由（必填）'), '冒领他人拾物')
    await userEvent.setup().click(screen.getByRole('button', { name: '确定' }))

    await waitFor(() => expect(body.reason).toBe('冒领他人拾物'))
    expect(body.resolution).toBe('takedown')
    expect('note' in body).toBe(false)
  })

  it('填了说明就一起发出去，那句说明是对举报人说话的', async () => {
    mockList()
    let body: Record<string, unknown> = {}
    server.use(
      http.post(`${BASE}/api/admin/reports/:id/resolve`, async (c) => {
        body = (await c.request.json()) as Record<string, unknown>
        return HttpResponse.json(ok({ id: 902, status: 'dismissed', resolved_at: '2026-10-07T10:00:00Z' }))
      }),
    )

    renderRouted('/admin', <ReportsTab />, '/admin')
    const row = (await screen.findByText('捡到黑色长款钱包')).closest('li')!
    await userEvent.setup().click(within(row).getByRole('button', { name: '处置这一条' }))
    await userEvent.setup().selectOptions(screen.getByLabelText('处置'), 'dismiss')
    await userEvent.setup().type(screen.getByLabelText('理由（必填）'), '描述的磨损特征与帖子一致')
    await userEvent.setup().type(screen.getByLabelText('给举报人的说明（选填）'), '这条不属于冒领')
    await userEvent.setup().click(screen.getByRole('button', { name: '确定' }))

    await waitFor(() => expect(body.note).toBe('这条不属于冒领'))
    expect(body.resolution).toBe('dismiss')
  })

  it('驳回那一条的提示说「只写了一行留痕」，因为它没有连带动作', async () => {
    mockList()
    server.use(
      http.post(`${BASE}/api/admin/reports/:id/resolve`, () =>
        HttpResponse.json(ok({ id: 902, status: 'dismissed', resolved_at: '2026-10-07T10:00:00Z' })),
      ),
    )

    renderRouted('/admin', <ReportsTab />, '/admin')
    const row = (await screen.findByText('捡到黑色长款钱包')).closest('li')!
    await userEvent.setup().click(within(row).getByRole('button', { name: '处置这一条' }))
    await userEvent.setup().selectOptions(screen.getByLabelText('处置'), 'dismiss')
    await userEvent.setup().type(screen.getByLabelText('理由（必填）'), '描述的磨损特征与帖子一致')
    await userEvent.setup().click(screen.getByRole('button', { name: '确定' }))

    const notice = await screen.findByText(/已记为未采纳/)
    expect(notice.textContent).toContain('这一次只写了一行留痕')
    expect(document.body.textContent).not.toMatch(/举报成立|已认定/)
  })

  it('采纳那一条的提示预先容纳了「待办数少的不止 1 条」', async () => {
    mockList()
    server.use(
      http.post(`${BASE}/api/admin/reports/:id/resolve`, () =>
        HttpResponse.json(ok({ id: 902, status: 'resolved', resolved_at: '2026-10-07T10:00:00Z' })),
      ),
    )

    renderRouted('/admin', <ReportsTab />, '/admin')
    const row = (await screen.findByText('捡到黑色长款钱包')).closest('li')!
    await userEvent.setup().click(within(row).getByRole('button', { name: '处置这一条' }))
    await userEvent.setup().type(screen.getByLabelText('理由（必填）'), '冒领他人拾物')
    await userEvent.setup().click(screen.getByRole('button', { name: '确定' }))

    expect(await screen.findByText(/待办数可能少不止 1 条/)).toBeInTheDocument()
  })

  it('后端说这条已经处置过了，就把那句话原样还给人，不改写成成功', async () => {
    mockList()
    server.use(
      http.post(`${BASE}/api/admin/reports/:id/resolve`, () =>
        HttpResponse.json(
          envelope(Code.REPORT_ALREADY_RESOLVED, '这条举报已经被处置过了', 409).body,
          { status: 409 },
        ),
      ),
    )

    renderRouted('/admin', <ReportsTab />, '/admin')
    const row = (await screen.findByText('捡到黑色长款钱包')).closest('li')!
    await userEvent.setup().click(within(row).getByRole('button', { name: '处置这一条' }))
    await userEvent.setup().type(screen.getByLabelText('理由（必填）'), '冒领他人拾物')
    await userEvent.setup().click(screen.getByRole('button', { name: '确定' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('这条举报已经被处置过了')
    expect(alert).toHaveTextContent(/请求编号/)
    expect(screen.queryByText(/已记为/)).not.toBeInTheDocument()
  })
})

describe('整页的措辞', () => {
  it('没有任何一处替平台做了承诺', async () => {
    mockList()
    renderRouted('/admin', <ReportsTab />, '/admin')
    await screen.findByText('捡到黑色长款钱包')

    // §3.7 那份禁词表同样管着前端这一族：处置结论只是「管理员做了哪个动作」。
    const text = document.body.textContent!
    for (const banned of ['归还成功', '已归还给你', '判定违规', '确认是骗子', '已关闭这条帖子']) {
      expect(text).not.toContain(banned)
    }
  })
})
