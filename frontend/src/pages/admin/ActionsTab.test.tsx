// src/pages/admin/ActionsTab.test.tsx —— #50 操作日志（只读）。
//
// 这一页是风险 14 的唯一防线（「任何 admin 都能看见其他 admin 干了什么」），
// 所以它最容易坏在两处：
// ① 默认必须**什么都不筛**。后端明写不采纳「只看我自己做的」那种默认值，
//    因为那会把一本对所有人摊开的账变成自我备忘。
// ② detail 是自由 JSON，形状随 action 变。未知键必须原样兜出来 ——
//    后端将来加一个键，这一页宁可显示得丑，也不能静默不显示（静默等于把证据藏起来）。
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import ActionsTab, { detailText } from './ActionsTab'
import { BASE, ok, sampleAdminAction, samplePage } from '../../test/helpers'
import { renderRouted } from '../../test/render'
import { server } from '../../test/server'
import { setToken } from '../../api/session'
import type { AdminActionDetail } from '../../api/types'

function mockActions(...rows: ReturnType<typeof sampleAdminAction>[]) {
  const seen: string[] = []
  setToken('jwt.admin.token')
  server.use(
    http.get(`${BASE}/api/admin/actions`, (c) => {
      seen.push(c.request.url)
      return HttpResponse.json(ok(samplePage(rows)))
    }),
  )
  return seen
}

describe('detailText 这个纯函数', () => {
  it('那批 ids 只列前 8 个，但总数照实说', () => {
    const d: AdminActionDetail = { ids: Array.from({ length: 12 }, (_, i) => 300 + i), count: 12 }
    const t = detailText(d)
    expect(t).toContain('这批 12 条：#300 #301 #302 #303 #304 #305 #306 #307')
    expect(t).toContain('等（共 12 条）')
    expect(t).not.toContain('#311')
  })

  it('8 条以内一个不落地列出来，不加「等」那种含糊话', () => {
    expect(detailText({ ids: [1, 2, 3], count: 3 })).toBe('这批 3 条：#1 #2 #3')
  })

  it('处置那一行把 report_id / resolution / also_closed 三件事分开说', () => {
    expect(detailText({ report_id: 901, resolution: 'dismiss', also_closed: [903, 904] })).toBe(
      '由举报 #901 触发 · 处置=驳回 · 同时关掉 2 条同帖举报',
    )
  })

  it('空对象就是一句空话都不编', () => {
    // warning_sent 的 detail 后端就是给 {}（service 里那一条只写理由），
    // 所以这里必须返回空串而不是「这批 0 条」这种凭空造出来的结构。
    expect(detailText({})).toBe('')
  })

  it('认不出的键原样带出而不是丢掉', () => {
    const d = { future_field: 'abc', count: 2 } as AdminActionDetail
    const t = detailText(d)
    expect(t).toContain('future_field="abc"')
    expect(t).toContain('共 2 条')
  })

  it('一级字典条目没有父级那一格，二级才带「父 #id」', () => {
    // 一级字典条目的 parent_id 压根不出现，二级才有；后端两种都可能给 null。
    expect(detailText({ name: '教学区', level: 1 })).toBe('「教学区」1 级')
    expect(detailText({ name: '图书馆', level: 2, parent_id: 10 })).toBe('「图书馆」2 级 · 父 #10')
  })
})

describe('首屏', () => {
  it('一个筛选都不带，并且明说这是全站所有的治理动作', async () => {
    const seen = mockActions(sampleAdminAction())
    renderRouted('/admin', <ActionsTab />, '/admin')

    await screen.findByText('下架帖子')
    expect(seen[0]).not.toContain('admin_id=')
    expect(seen[0]).not.toContain('target_id=')
    expect(seen[0]).not.toContain('target_type=')
    expect(seen[0]).not.toContain('action=')
    expect(screen.getByText(/现在没有加任何筛选：这是全站所有的治理动作/)).toBeInTheDocument()
  })

  it('每条都写着「谁做的」和那句理由原文', async () => {
    mockActions(sampleAdminAction({ admin: { id: 7, nickname: '管理员' }, reason: '同一账号批量发布广告帖' }))
    renderRouted('/admin', <ActionsTab />, '/admin')

    await screen.findByText('下架帖子')
    expect(screen.getByText(/由 管理员（#7）做的/)).toBeInTheDocument()
    expect(screen.getByText('同一账号批量发布广告帖')).toBeInTheDocument()
    expect(screen.getByText('这批 1 条：#202')).toBeInTheDocument()
  })

  it('做这件事的账号已经被删掉了，那一行仍然列出来', async () => {
    mockActions(sampleAdminAction({ admin: null }))
    renderRouted('/admin', <ActionsTab />, '/admin')

    await screen.findByText('下架帖子')
    // 这一条不能被藏：「留痕还在、做它的人已注销」本身就是其他 admin 需要看到的信息。
    expect(screen.getByText(/做这件事的账号已经被删掉了/)).toBeInTheDocument()
    expect(screen.queryByText(/（#0）/)).not.toBeInTheDocument()
  })

  it('detail 是空对象时不挂一个空的「原文」折叠块', async () => {
    mockActions(sampleAdminAction({ action: 'warning_sent', target_type: 'user', target_id: 12, detail: {} }))
    renderRouted('/admin', <ActionsTab />, '/admin')

    await screen.findByText('发警告')
    expect(screen.queryByRole('button', { name: '原文' })).not.toBeInTheDocument()
    expect(screen.queryByText('原文')).not.toBeInTheDocument()
  })

  it('原文那一格里是完整的 JSON，一个键都没少', async () => {
    mockActions(sampleAdminAction({ detail: { ids: [101, 102], count: 2 } }))
    renderRouted('/admin', <ActionsTab />, '/admin')

    await screen.findByText('下架帖子')
    const raw = (await screen.findByText('原文')).closest('details')!
    expect(raw.querySelector('code')!.textContent).toBe('{"ids":[101,102],"count":2}')
  })

  it('只有下架帖子这一类给落点链接，别的类型不硬造', async () => {
    mockActions(
      sampleAdminAction({ id: 1, action: 'item_takedown', target_type: 'item', target_id: 202 }),
      sampleAdminAction({ id: 2, action: 'user_ban', target_type: 'user', target_id: 12, detail: { status: 'banned' } }),
    )
    renderRouted('/admin', <ActionsTab />, '/admin')

    await screen.findByText('封号')
    expect(screen.getAllByRole('link', { name: '打开这条' })).toHaveLength(1)
  })
})

describe('筛选', () => {
  it('做了什么用白名单下拉，选出来的是后端认得的枚举值', async () => {
    const seen = mockActions(sampleAdminAction())
    renderRouted('/admin', <ActionsTab />, '/admin')
    await screen.findByText('下架帖子')

    await userEvent.setup().selectOptions(screen.getByLabelText('做了什么'), 'item_restore')

    await waitFor(() => expect(seen.length).toBe(2))
    expect(seen[1]).toContain('action=item_restore')
    // 拼错一个字母不报错、只是列表空了 —— 那种「没人做过这件事」的假象必须由下拉挡住。
    expect(seen[1]).not.toContain('action=item_takedown')
  })

  it('对象 id 填 0 当「不限」处理：后端对 0 给的是 VALIDATION，不是「筛不到」', async () => {
    const seen = mockActions(sampleAdminAction())
    renderRouted('/admin', <ActionsTab />, '/admin')
    await screen.findByText('下架帖子')

    await userEvent.setup().type(screen.getByLabelText('对象 id'), '0')

    await waitFor(() => expect(seen.length).toBe(2))
    expect(seen[1]).not.toContain('target_id=')
  })

  it('填了正经 id 就带上，加筛后那句说明跟着换', async () => {
    const seen = mockActions(sampleAdminAction())
    renderRouted('/admin', <ActionsTab />, '/admin')
    await screen.findByText('下架帖子')

    await userEvent.setup().type(screen.getByLabelText('对象 id'), '202')

    // 逐字输入会产生三次筛选（2 / 20 / 202），所以看最后那一次而不是第二次。
    await waitFor(() => expect(seen[seen.length - 1]).toContain('target_id=202'))
    expect(await screen.findByText(/筛选后的结果。/)).toBeInTheDocument()
  })

  it('这一页没有任何改、删的入口', async () => {
    mockActions(sampleAdminAction())
    renderRouted('/admin', <ActionsTab />, '/admin')
    await screen.findByText('下架帖子')

    // 「日志只追加」是它能当证据的前提。除了 #50 这一族 GET，页面上不该出现一个写请求的按钮。
    expect(screen.getByText(/这本账只能追加/)).toBeInTheDocument()
    for (const label of ['删除', '修改', '撤销', '编辑']) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument()
    }
  })
})
