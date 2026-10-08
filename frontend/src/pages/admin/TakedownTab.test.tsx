// src/pages/admin/TakedownTab.test.tsx —— #43 批量下架 + #44/#45/#46 三条单条动作。
//
// 计划 §M7 在这一页钉了两条原文，它们各自对应一种真实的伤害：
//   ① 「按作者聚合，勾选一个人等于勾他名下全部帖」→ 一个人名下五十条 spam 不该勾五十次；
//   ② 「「确定」按钮在理由为空时必须是禁用状态，而不是点下去再弹错误」，
//      并且「理由文案下方直接预览通知会长什么样」→ 管理员必须在按下去之前看见对方将看见的那句话。
// ② 的两半是一件事的两面：理由必填不是因为后端会拒，而是因为那句理由会变成别人收到的通知。
//
// 另外钉一条不那么显眼但更危险的：候选列表来自 #14，而 #43 下架的是**发出去的那串 id**。
// 所以换一次筛选必须把勾清空 —— 留着上一批的勾，屏幕上写着「下架这 2 条」而实际发了 5 条。
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import TakedownTab, { groupByAuthor, takedownNoticeText } from './TakedownTab'
import { BASE, ok, samplePage, sampleSummary, sampleUser } from '../../test/helpers'
import { renderRouted } from '../../test/render'
import { server } from '../../test/server'
import { setToken } from '../../api/session'
import type { ItemSummary } from '../../api/types'

/** 两个作者、三条帖：小李两条、小王一条。顺序刻意让小李先出现（聚合按首次出现排）。 */
const ROWS: ItemSummary[] = [
  sampleSummary({ id: 101, title: '加微信代练', author_id: 12, author_name: '小李' }),
  sampleSummary({ id: 102, title: '代练低价接单', author_id: 12, author_name: '小李' }),
  sampleSummary({ id: 103, title: '黑色钱包', author_id: 13, author_name: '小王' }),
]

function mockItems(rows = ROWS) {
  const seen: string[] = []
  setToken('jwt.admin.token')
  server.use(
    // 这个页签是通过 renderRouted 挂的，外面套着 AuthProvider —— 有 token 就会去打 #3 恢复身份。
    // 不注册它不会让测试变红，只会让「这一页是以谁渲染的」这件事在日志里消失。
    http.get(`${BASE}/api/auth/me`, () => HttpResponse.json(ok(sampleUser({ id: 7, role: 'admin', nickname: '管理员' })))),
    http.get(`${BASE}/api/items`, (c) => {
      seen.push(c.request.url)
      return HttpResponse.json(ok(samplePage(rows, { total: rows.length })))
    }),
  )
  return seen
}

function boxName(id: number) {
  return `第 ${id} 条 ${ROWS.find((r) => r.id === id)?.title ?? ''}`
}

function pick(id: number): HTMLInputElement {
  return screen.getByRole('checkbox', { name: boxName(id) })
}

// 列表是 #14 回来的，所以勾之前必须先等到那一行真的在屏幕上 ——
// 直接 getByRole 会在数据还没落地时先炸一次，报成「找不到控件」这种和真实故障长得一样的错。
async function pickByClick(ids: number[]) {
  for (const id of ids) {
    const box = await screen.findByRole('checkbox', { name: boxName(id) })
    await userEvent.setup().click(box)
  }
}

function previewHead(): HTMLElement {
  return document.querySelector('.adm-preview-head')!
}

function singleForm(title: string): HTMLElement {
  return screen.getByRole('heading', { name: title }).closest('section')!
}

describe('groupByAuthor 这个纯函数', () => {
  it('按作者聚合且保持首次出现的顺序', () => {
    const groups = groupByAuthor(ROWS)
    expect(groups.map((g) => [g.authorId, g.items.map((i) => i.id)])).toEqual([
      [12, [101, 102]],
      [13, [103]],
    ])
  })

  it('预览那句和后端发通知那句是同一句（位数 + 引号 + 句号）', () => {
    expect(takedownNoticeText('刷屏广告', 2)).toBe('你的 2 条帖子因『刷屏广告』被下架。')
  })
})

describe('候选列表', () => {
  it('来自 #14，而且一次要 100 条：一个人五十条 spam 摊在三页里就聚不齐', async () => {
    const seen = mockItems()
    renderRouted('/admin', <TakedownTab />, '/admin')

    await screen.findByRole('checkbox', { name: '第 101 条 加微信代练' })
    expect(seen[0]).toContain('page_size=100')
  })

  it('分成按作者归好的两组，组里写着这一页他有几条', async () => {
    mockItems()
    renderRouted('/admin', <TakedownTab />, '/admin')

    const li = await screen.findByRole('checkbox', { name: '全选 小李 在这一页里的 2 条' })
    const group = li.closest('fieldset')!
    expect(within(group).getByRole('checkbox', { name: '第 101 条 加微信代练' })).toBeInTheDocument()
    expect(within(group).getByRole('checkbox', { name: '第 102 条 代练低价接单' })).toBeInTheDocument()

    const wangAll = screen.getByRole('checkbox', { name: '全选 小王 在这一页里的 1 条' })
    expect(within(wangAll.closest('fieldset')!).getAllByRole('checkbox')).toHaveLength(2)
  })

  it('说实话：这里列的是筛出来的这一页，不是某个人的全部帖子', async () => {
    mockItems()
    renderRouted('/admin', <TakedownTab />, '/admin')

    // 批量下架是不可逆的销毁动作，所以「勾他名下全部帖」这句承诺只能缩小到筛出来的这一批。
    expect(await screen.findByText(/不是某个人的全部帖子/)).toBeInTheDocument()
  })
})

describe('勾选与预览', () => {
  it('勾一个作者等于勾这一页里他的每一帖', async () => {
    mockItems()
    renderRouted('/admin', <TakedownTab />, '/admin')

    const groupAll = await screen.findByRole('checkbox', { name: '全选 小李 在这一页里的 2 条' })
    await userEvent.setup().click(groupAll)

    expect(pick(101)).toBeChecked()
    expect(pick(102)).toBeChecked()
    expect(pick(103)).not.toBeChecked()
    expect(previewHead().textContent).toBe('选了 2 条 · 将给 1 位作者各发 1 条通知（不是每条帖子一封）')
  })

  it('两位作者各得一条通知，不是一个作者两条', async () => {
    mockItems()
    renderRouted('/admin', <TakedownTab />, '/admin')

    await pickByClick([101, 102, 103])
    await waitFor(() =>
      expect(previewHead().textContent).toBe('选了 3 条 · 将给 2 位作者各发 1 条通知（不是每条帖子一封）'),
    )
  })

  it('理由一空下来「确定」就是禁用的，哪怕已经勾了 2 条（计划钉的那一条）', async () => {
    mockItems()
    renderRouted('/admin', <TakedownTab />, '/admin')

    await pickByClick([101, 102])

    const btn = screen.getByRole('button', { name: '确定下架选中的 2 条' })
    expect(btn).toBeDisabled()

    await userEvent.setup().type(document.getElementById('takedown-reason') as HTMLTextAreaElement, '  刷屏广告  ')
    await waitFor(() => expect(btn).toBeEnabled())
  })

  it('理由下方预览的就是作者将来收到的那一句', async () => {
    mockItems()
    renderRouted('/admin', <TakedownTab />, '/admin')

    await pickByClick([101, 102])
    await userEvent.setup().type(document.getElementById('takedown-reason') as HTMLTextAreaElement, '刷屏广告')

    expect(await screen.findByText('小李：「你的 2 条帖子因『刷屏广告』被下架。」')).toBeInTheDocument()
    // 没勾到的那位此刻不该出现在预览里。
    expect(document.body.textContent).not.toContain('小王：「')
  })

  it('一条都没勾时按钮也禁用，而且预览不编造收件人', async () => {
    mockItems()
    renderRouted('/admin', <TakedownTab />, '/admin')

    await screen.findByRole('checkbox', { name: '第 101 条 加微信代练' })
    expect(screen.getByRole('button', { name: '确定下架选中的 0 条' })).toBeDisabled()
    expect(previewHead().textContent).toContain('选了 0 条 · 将给 0 位作者')
  })
})

describe('#43 发出去的东西', () => {
  it('请求体是 ids 数组 + 去过空白的理由，一次一个事务', async () => {
    mockItems()
    let body: { ids?: number[]; reason?: string } = {}
    server.use(
      http.post(`${BASE}/api/admin/items/takedown`, async (c) => {
        body = (await c.request.json()) as typeof body
        return HttpResponse.json(ok({ taken_down: 2, notified_users: 1 }))
      }),
    )

    renderRouted('/admin', <TakedownTab />, '/admin')
    await pickByClick([101, 103])
    await userEvent.setup().type(document.getElementById('takedown-reason') as HTMLTextAreaElement, '  刷屏广告  ')
    await userEvent.setup().click(screen.getByRole('button', { name: '确定下架选中的 2 条' }))

    await waitFor(() => expect(body.reason).toBe('刷屏广告'))
    expect(body.ids).toEqual([101, 103])

    const notice = await screen.findByText(/已下架 2 条，通知了 1 位作者/)
    expect(notice.textContent).toContain('放回去要用下面那个「恢复一条」')
  })

  it('taken_down=0 是幂等成功：说「都已经是下架状态了」而不是报错', async () => {
    mockItems()
    server.use(
      http.post(`${BASE}/api/admin/items/takedown`, () => HttpResponse.json(ok({ taken_down: 0, notified_users: 0 }))),
    )

    renderRouted('/admin', <TakedownTab />, '/admin')
    await pickByClick([101])
    await userEvent.setup().type(document.getElementById('takedown-reason') as HTMLTextAreaElement, '刷屏广告')
    await userEvent.setup().click(screen.getByRole('button', { name: '确定下架选中的 1 条' }))

    const notice = await screen.findByText(/都已经是下架状态了/)
    expect(notice.textContent).toContain('留痕仍然写了一行')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('换一次筛选就把上一批的勾清掉：屏幕上的条数必须等于发出去的条数', async () => {
    const seen = mockItems()
    renderRouted('/admin', <TakedownTab />, '/admin')

    await pickByClick([101])
    await waitFor(() => expect(pick(101)).toBeChecked())

    await userEvent.setup().type(screen.getByLabelText('按标题或描述筛'), '代练')
    await userEvent.setup().click(screen.getByRole('button', { name: '查' }))

    await waitFor(() => expect(seen.length).toBe(2))
    expect(seen[1]).toContain('keyword=')
    expect(pick(101)).not.toBeChecked()
    expect(screen.getByRole('button', { name: '确定下架选中的 0 条' })).toBeDisabled()
  })

  it('超过 200 条时先禁下来并说明怎么分批，而不是让后端拒收', async () => {
    const many = Array.from({ length: 201 }, (_, i) =>
      sampleSummary({ id: 300 + i, title: `刷屏第 ${i + 1} 条`, author_id: 12, author_name: '小李' }),
    )
    mockItems(many)
    renderRouted('/admin', <TakedownTab />, '/admin')

    await userEvent.setup().click(await screen.findByRole('checkbox', { name: '全选 小李 在这一页里的 201 条' }))
    await userEvent.setup().type(document.getElementById('takedown-reason') as HTMLTextAreaElement, '刷屏广告')

    expect(await screen.findByRole('alert')).toHaveTextContent('一次最多 200 条，当前选了 201 条')
    expect(screen.getByRole('button', { name: '确定下架选中的 201 条' })).toBeDisabled()
  })
})

describe('#44 恢复一条', () => {
  it('id 和理由都齐了才放开，成功后明说「没有给作者发通知」', async () => {
    mockItems()
    let path = ''
    let body: Record<string, unknown> = {}
    server.use(
      http.post(`${BASE}/api/admin/items/:id/restore`, async (c) => {
        path = new URL(c.request.url).pathname
        body = (await c.request.json()) as Record<string, unknown>
        return HttpResponse.json(ok({ id: 101, status: 'open' }))
      }),
    )

    renderRouted('/admin', <TakedownTab />, '/admin')
    const form = singleForm('把一条已下架的帖子放回广场')
    const okBtn = within(form).getByRole('button', { name: '确定' })

    await userEvent.setup().type(within(form).getByLabelText('帖子 id'), '101')
    expect(okBtn).toBeDisabled()

    await userEvent.setup().type(within(form).getByLabelText('恢复理由（必填）'), '重新核实后确认不是广告')
    await waitFor(() => expect(okBtn).toBeEnabled())
    expect(within(form).getByText(/不发任何通知/)).toBeInTheDocument()

    await userEvent.setup().click(okBtn)

    await waitFor(() => expect(body.reason).toBe('重新核实后确认不是广告'))
    expect(path).toBe('/api/admin/items/101/restore')
    const notice = await screen.findByText(/已放回广场/)
    expect(notice.textContent).toContain('没有给作者发通知')
  })
})

describe('#45 删一张图', () => {
  it('说的是硬删除而且帖子还在，成功之后不把下架混进来', async () => {
    mockItems()
    let body: Record<string, unknown> = {}
    let path = ''
    server.use(
      http.delete(`${BASE}/api/admin/item-images/:id`, async (c) => {
        path = new URL(c.request.url).pathname
        body = (await c.request.json()) as Record<string, unknown>
        return HttpResponse.json(ok(null))
      }),
    )

    renderRouted('/admin', <TakedownTab />, '/admin')
    const form = singleForm('删掉一张图片（硬删除）')
    const okBtn = within(form).getByRole('button', { name: '确定' })

    await userEvent.setup().type(within(form).getByLabelText('图片 id'), '55')
    await userEvent.setup().type(within(form).getByLabelText('删掉这张图的理由（必填）'), '图里有他人手机号')
    await waitFor(() => expect(okBtn).toBeEnabled())
    expect(within(form).getByText(/帖子本身还在广场上/)).toBeInTheDocument()

    await userEvent.setup().click(okBtn)

    await waitFor(() => expect(body.reason).toBe('图里有他人手机号'))
    expect(path).toBe('/api/admin/item-images/55')
    const notice = await screen.findByText(/图片 #55 已删除/)
    expect(notice.textContent).toContain('帖子没动')
  })
})

describe('#46 删一条归还确认', () => {
  it('后果那句写着「只通知提交人」和「积分一点不动」，成功那句写着发帖人没被改动', async () => {
    mockItems()
    let body: Record<string, unknown> = {}
    let path = ''
    server.use(
      http.delete(`${BASE}/api/admin/returns/:id`, async (c) => {
        path = new URL(c.request.url).pathname
        body = (await c.request.json()) as Record<string, unknown>
        return HttpResponse.json(ok(null))
      }),
    )

    renderRouted('/admin', <TakedownTab />, '/admin')
    const form = singleForm('删掉一条归还确认记录（硬删除）')
    const okBtn = within(form).getByRole('button', { name: '确定' })

    await userEvent.setup().type(within(form).getByLabelText('归还确认 id'), '501')
    await userEvent.setup().type(within(form).getByLabelText('删掉这条记录的理由（必填）'), '这一行是误提交的重复记录')
    await waitFor(() => expect(okBtn).toBeEnabled())
    expect(within(form).getByText(/只通知提交人（发帖人不收），积分一点不动/)).toBeInTheDocument()

    await userEvent.setup().click(okBtn)

    await waitFor(() => expect(body.reason).toBe('这一行是误提交的重复记录'))
    expect(path).toBe('/api/admin/returns/501')
    const notice = await screen.findByText(/归还确认 #501 已删除/)
    expect(notice.textContent).toContain('发帖人和帖子都没有被改动')
    // 「能销毁、不能制造归属」在这一页的反面：这条端点不会替任何人确认或驳回归还。
    expect(document.body.textContent).not.toMatch(/已确认归还|已代为确认/)
  })
})
