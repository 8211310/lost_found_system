// src/pages/admin/DictTab.test.tsx —— #9–#12：字典的两棵树、新增、删除。
//
// 这一片最容易被写坏的不是逻辑而是**请求体的形状**，所以有几条断言钉的是键的有无：
// ① 不填上级时必须**整个键都不发**。发 parent_id=0 会被后端读成「上级 id 是 0」，
//    而 0 不是任何一行的 id —— 一个「建一级大类」的正确请求会被判成「上级不存在」。
// ② is_freeform 只有地点那张表有，分类那边发过去会被静默忽略（categories 没这一列），
//    所以复选框本身也不许出现在分类那一格里。
// ③ 页面上不许有「改名」和「停用」：后端没有那种端点，这是这一族端点的边界，
//    而边界只能靠断言留住 —— 少写一句，下一个人就会当成「前端漏做了」。
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import DictTab from './DictTab'
import { BASE, envelope, ok, sampleCategories, sampleLocations, sampleUser } from '../../test/helpers'
import { renderRouted } from '../../test/render'
import { server } from '../../test/server'
import { setToken } from '../../api/session'
import { MAX_CATEGORY_NAME_RUNES } from '../../api/admin'

function mockTrees() {
  const calls = { categories: 0, locations: 0 }
  setToken('jwt.admin.token')
  server.use(
    http.get(`${BASE}/api/auth/me`, () =>
      HttpResponse.json(ok(sampleUser({ id: 7, role: 'admin', nickname: '管理员' }))),
    ),
    http.get(`${BASE}/api/categories`, () => {
      calls.categories += 1
      return HttpResponse.json(ok(sampleCategories()))
    }),
    http.get(`${BASE}/api/locations`, () => {
      calls.locations += 1
      return HttpResponse.json(ok(sampleLocations()))
    }),
  )
  return calls
}

/** 两个页签共用一条地址，字段名也同名，所以一切都按小标题圈到那一张卡片里再找。 */
function pane(what: '分类' | '地点') {
  const heading = screen.getByRole('heading', { name: what === '分类' ? /物品分类/ : /^地点/ })
  return within(heading.closest('section')!)
}

async function rowOf(path: string) {
  const cell = await screen.findByText(path)
  return within(cell.closest('li')!)
}

/** 抓 #9/#11 真正发出去的请求体：这一片最贵的断言全在键的有无上。 */
function captureCreate(kind: 'categories' | 'locations', res: Record<string, unknown> = {}) {
  const seen: { body: Record<string, unknown> } = { body: {} }
  server.use(
    http.post(`${BASE}/api/admin/${kind}`, async ({ request }) => {
      seen.body = (await request.json()) as Record<string, unknown>
      return HttpResponse.json(ok({ id: 77, name: String(seen.body.name ?? ''), level: seen.body.parent_id ? 2 : 1, parent_id: seen.body.parent_id ?? null, ...res }))
    }),
  )
  return seen
}

async function fillCreate(
  what: '分类' | '地点',
  { name, reason, parent, sort }: { name?: string; reason?: string; parent?: string; sort?: string },
) {
  const p = pane(what)
  const user = userEvent.setup()
  if (parent !== undefined) await user.selectOptions(p.getByLabelText('挂在哪一条下面'), parent)
  if (name !== undefined) await user.clear(p.getByLabelText('名字'))
  if (name !== undefined && name !== '') await user.type(p.getByLabelText('名字'), name)
  if (sort !== undefined) {
    const sortInput = p.getByLabelText('排序') as HTMLInputElement
    await user.clear(sortInput)
    if (sort !== '') await user.type(sortInput, sort)
  }
  if (reason !== undefined) {
    const reasonBox = p.getByRole('textbox', { name: /必填/ })
    await user.clear(reasonBox)
    if (reason !== '') await user.type(reasonBox, reason)
  }
}

describe('两棵树', () => {
  it('条目平铺着列出，每行带编号、级别和排序', async () => {
    mockTrees()
    renderRouted('/admin', <DictTab />, '/admin')

    const row = await rowOf('教学区 / 图书馆 / 三楼自习区')
    expect(row.getByText('#31')).toBeInTheDocument()
    expect(row.getByText('第 3 级')).toBeInTheDocument()
    expect(row.getByText('排序 1')).toBeInTheDocument()
  })

  it('列表用整条路径而不是光一个名字：两张表里都有 id 不同而名字相近的条目', async () => {
    mockTrees()
    renderRouted('/admin', <DictTab />, '/admin')

    // 夹具里 categories 和 locations **共用** 30 这个号（电子设备 / 图书馆），
    // 而两张表各是一个下拉框，光显示名字就会让人以为选的是同一个东西。
    expect(await screen.findByText('衣物箱包 / 外套')).toBeInTheDocument()
    expect(screen.getByText('教学区 / 图书馆')).toBeInTheDocument()
  })

  it('只有被勾成自由填写的那一条挂着「可补具体位置」', async () => {
    mockTrees()
    renderRouted('/admin', <DictTab />, '/admin')

    const other = await rowOf('其他')
    expect(other.getByText('可补具体位置')).toBeInTheDocument()
    const library = await rowOf('教学区 / 图书馆')
    expect(library.queryByText('可补具体位置')).not.toBeInTheDocument()
  })

  it('上级下拉里不出现最里层：分类到第二级为止，地点到第三级为止', async () => {
    mockTrees()
    renderRouted('/admin', <DictTab />, '/admin')

    await rowOf('衣物箱包 / 钱包')
    const catParent = pane('分类').getByLabelText('挂在哪一条下面') as HTMLSelectElement
    expect(catParent.options).toHaveLength(3)
    for (const n of sampleCategories()) {
      expect([...catParent.options].some((o) => o.value === String(n.id))).toBe(true)
      for (const c of n.children) {
        // 第 2 级是分类的最里层，它下面挂不了东西（后端给 VALIDATION）。
        expect([...catParent.options].some((o) => o.value === String(c.id))).toBe(false)
      }
    }

    const locParent = pane('地点').getByLabelText('挂在哪一条下面') as HTMLSelectElement
    expect([...locParent.options].map((o) => o.value)).toContain('30')
    expect([...locParent.options].some((o) => o.value === '31')).toBe(false)
  })
})

describe('新增', () => {
  it('名字和理由还空着时「新增」是禁用的，不是点下去再弹错', async () => {
    mockTrees()
    renderRouted('/admin', <DictTab />, '/admin')

    const btn = (await rowOf('衣物箱包 / 钱包')) && pane('分类').getByRole('button', { name: '新增' })
    expect(btn).toBeDisabled()

    await fillCreate('分类', { name: '学生证件' })
    expect(pane('分类').getByRole('button', { name: '新增' })).toBeDisabled()

    await fillCreate('分类', { reason: '军训卡经常捡到' })
    expect(pane('分类').getByRole('button', { name: '新增' })).toBeEnabled()
  })

  it('名字超过列宽就先在页面上拦住：分类 32 个字、地点 64 个字是两个数', async () => {
    mockTrees()
    renderRouted('/admin', <DictTab />, '/admin')
    await rowOf('衣物箱包 / 钱包')

    const tooLong = '字'.repeat(MAX_CATEGORY_NAME_RUNES + 1)
    await fillCreate('分类', { name: tooLong, reason: '试试超长' })
    expect(pane('分类').getByRole('button', { name: '新增' })).toBeDisabled()
    expect(pane('分类').getByText(new RegExp(`最多 ${MAX_CATEGORY_NAME_RUNES} 个字`))).toBeInTheDocument()

    // 地点那边同样的长度是合法的，因为那一列宽到 64。
    await fillCreate('地点', { name: tooLong, reason: '同样的名字' })
    expect(pane('地点').getByRole('button', { name: '新增' })).toBeEnabled()
  })

  it('排序清空就禁用：那一列是 INT，后端不会替空串决定填几', async () => {
    mockTrees()
    renderRouted('/admin', <DictTab />, '/admin')
    await rowOf('衣物箱包 / 钱包')

    await fillCreate('分类', { name: '学生证件', reason: '军训卡经常捡到', sort: '' })
    expect(pane('分类').getByRole('button', { name: '新增' })).toBeDisabled()
    expect(pane('分类').getByText('排序要填一个整数')).toBeInTheDocument()
  })

  it('选了上级才带 parent_id，没选时**这个键压根不存在**', async () => {
    const calls = mockTrees()
    const seen = captureCreate('categories')
    renderRouted('/admin', <DictTab />, '/admin')
    await rowOf('衣物箱包 / 钱包')

    await fillCreate('分类', { name: '钱包套', reason: '配件单独一类', parent: '20' })
    await userEvent.setup().click(pane('分类').getByRole('button', { name: '新增' }))

    await waitFor(() => expect(seen.body.name).toBe('钱包套'))
    expect(seen.body).toEqual({ name: '钱包套', sort_order: 0, parent_id: 20, reason: '配件单独一类' })
    expect(calls.categories).toBe(2)
  })

  it('不选上级时发的是「这个键不存在」而不是 parent_id: 0', async () => {
    mockTrees()
    const seen = captureCreate('categories')
    renderRouted('/admin', <DictTab />, '/admin')
    await rowOf('衣物箱包 / 钱包')

    await fillCreate('分类', { name: '学生证件', reason: '军训卡经常捡到' })
    await userEvent.setup().click(pane('分类').getByRole('button', { name: '新增' }))

    await waitFor(() => expect(seen.body.name).toBe('学生证件'))
    expect(seen.body).not.toHaveProperty('parent_id')
    expect(screen.getByText(/#77「学生证件」已经建好，是第 1 级/)).toBeInTheDocument()
  })

  it('is_freeform 这个键只有地点会发，分类那一格连复选框都没有', async () => {
    mockTrees()
    const seen = captureCreate('locations')
    renderRouted('/admin', <DictTab />, '/admin')

    expect(pane('分类').queryByLabelText(/补一句具体位置/)).not.toBeInTheDocument()

    await fillCreate('地点', { name: '操场', reason: '跑步时丢的多' })
    await userEvent.setup().click(pane('地点').getByRole('checkbox', { name: /补一句具体位置/ }))
    await userEvent.setup().click(pane('地点').getByRole('button', { name: '新增' }))

    await waitFor(() => expect(seen.body.name).toBe('操场'))
    expect(seen.body).toEqual({ name: '操场', sort_order: 0, is_freeform: true, reason: '跑步时丢的多' })
  })

  it('同名冲突那句 409 要原样显示，不许糊成「新增失败」', async () => {
    const e = envelope('CONFLICT', '同一个上级下面已经有一个同名的分类了', 409)
    mockTrees()
    server.use(http.post(`${BASE}/api/admin/categories`, () => HttpResponse.json(e.body, { status: e.status })))
    renderRouted('/admin', <DictTab />, '/admin')
    await rowOf('衣物箱包 / 钱包')

    await fillCreate('分类', { name: '钱包', reason: '重复建一个' })
    await userEvent.setup().click(pane('分类').getByRole('button', { name: '新增' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('同一个上级下面已经有一个同名的分类了')
  })
})

describe('删除', () => {
  /** #10/#12 的请求体只有 reason，而空 body 后端判 VALIDATION —— 所以这一格也是必填。 */
  function captureDelete(kind: 'categories' | 'locations') {
    const seen: { id: string; body: Record<string, unknown> } = { id: '', body: {} }
    server.use(
      http.delete(`${BASE}/api/admin/${kind}/:id`, async ({ request, params }) => {
        seen.id = String(params.id)
        seen.body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json(ok(null))
      }),
    )
    return seen
  }

  it('理由没填时「确认删除」是禁用的', async () => {
    mockTrees()
    renderRouted('/admin', <DictTab />, '/admin')

    const row = await rowOf('电子设备')
    await userEvent.setup().click(row.getByRole('button', { name: '删掉这一条' }))
    expect(row.getByRole('button', { name: '确认删除' })).toBeDisabled()

    await userEvent.setup().type(row.getByRole('textbox', { name: /必填/ }), '这一类从来没有东西')
    expect(row.getByRole('button', { name: '确认删除' })).toBeEnabled()
  })

  it('删掉之后打的是那条带编号的路由，而两棵树都重读了一遍', async () => {
    const calls = mockTrees()
    const seen = captureDelete('categories')
    renderRouted('/admin', <DictTab />, '/admin')

    const row = await rowOf('电子设备')
    await userEvent.setup().click(row.getByRole('button', { name: '删掉这一条' }))
    await userEvent.setup().type(row.getByRole('textbox', { name: /必填/ }), '这一类从来没有东西')
    await userEvent.setup().click(row.getByRole('button', { name: '确认删除' }))

    await waitFor(() => expect(seen.id).toBe('30'))
    expect(seen.body).toEqual({ reason: '这一类从来没有东西' })
    expect(calls.categories).toBe(2)
    expect(calls.locations).toBe(2)
    expect(await screen.findByText(/#30「电子设备」已经删掉/)).toBeInTheDocument()
  })

  it('被挡住时把后端数出来的那两个数字显示出来，并且不重读树', async () => {
    const calls = mockTrees()
    const e = envelope('CATEGORY_IN_USE', '这个条目删不掉：下面还有 3 个子节点，并且有 12 条帖子正在引用它', 409)
    server.use(
      http.delete(`${BASE}/api/admin/categories/:id`, () => HttpResponse.json(e.body, { status: e.status })),
    )
    renderRouted('/admin', <DictTab />, '/admin')

    const row = await rowOf('衣物箱包')
    await userEvent.setup().click(row.getByRole('button', { name: '删掉这一条' }))
    await userEvent.setup().type(row.getByRole('textbox', { name: /必填/ }), '想合并成一大类')
    await userEvent.setup().click(row.getByRole('button', { name: '确认删除' }))

    // 两种情况接下来要做的事是相反的（先删子节点 vs 先处理帖子），所以这句话不能缩成「删除失败」。
    expect(await screen.findByRole('alert')).toHaveTextContent('下面还有 3 个子节点，并且有 12 条帖子正在引用它')
    expect(calls.categories).toBe(1)
  })

  it('页面上没有「改名」和「停用」：后端没有这两条端点', async () => {
    mockTrees()
    renderRouted('/admin', <DictTab />, '/admin')
    await rowOf('衣物箱包 / 钱包')

    // 「改名」这两个字在说明里是**允许**出现的（那一句就在讲为什么没有它），
    // 所以钉的是按钮：一个点下去什么都做不了的按钮比没有更坏。
    expect(screen.queryByRole('button', { name: /改名|重命名|停用|禁用这条/ })).not.toBeInTheDocument()
    expect(pane('分类').getByText(/改名和停用后端没有开端点/)).toBeInTheDocument()
  })
})
