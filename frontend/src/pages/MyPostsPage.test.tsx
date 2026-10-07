// src/pages/MyPostsPage.test.tsx —— #19 我的发布：把「只有这一页能看到的那些东西」钉住。
//
// 这一页和广场长得几乎一样，所以测试要盯的是**只有这里成立**的四件事：
//   ① status=deleted 是一个能发出去的条件（广场那条白名单里根本没有它）；
//   ② removal 那块只在后端给了这个键时出现，而且把 reason 和 action_id 都显示出来；
//   ③ found 帖在这里**显示联系方式**（都是自己的帖子，#14 那种恒为 null 不适用）；
//   ④ 解锁名单的入口只看 item_type，不看 status —— 被下架之后那份「谁来过」反而更要紧。
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import MyPostsPage from './MyPostsPage'
import { renderRouted } from '../test/render'
import { server } from '../test/server'
import { BASE, envelope, ok, samplePage, sampleRemoval, sampleSummary, sampleUser } from '../test/helpers'
import { setToken } from '../api/session'
import type { ItemSummary } from '../api/types'

/** 装上 #3 和 #19，并记下最后一次 #19 请求的完整 URL。 */
function mockMine(list: ItemSummary[], extra: { total?: number } = {}) {
  const seen: { url: string } = { url: '' }
  setToken('jwt.me')
  server.use(
    http.get(`${BASE}/api/auth/me`, () => HttpResponse.json(ok(sampleUser({ id: 7 })))),
    http.get(`${BASE}/api/my/items`, (c) => {
      seen.url = c.request.url
      return HttpResponse.json(ok(samplePage(list, { total: extra.total ?? list.length })))
    }),
  )
  return seen
}

/** 一条卡片（ItemCard 的 <li>）；按标题找比按序号找稳，因为列表顺序是后端定的。 */
function cardOf(title: string): HTMLElement {
  return screen.getByText(title).closest('li')!
}

describe('只有这一页才有的那几行', () => {
  it('自己的 found 帖把联系方式显示出来 —— 这里不是广场，contact 一律有值', async () => {
    mockMine([sampleSummary({ id: 1, item_type: 'found', title: '捡到一串钥匙', contact: '13800000000' })])

    renderRouted('/me/posts', <MyPostsPage />, '/me/posts')
    await screen.findByText('捡到一串钥匙')

    expect(within(cardOf('捡到一串钥匙')).getByText('联系：13800000000')).toBeInTheDocument()
  })

  it('被下架的那条显示原因和处理编号，并且不给「修改」入口', async () => {
    mockMine([
      sampleSummary({
        id: 2,
        item_type: 'found',
        title: '捡到一张校园卡',
        status: 'deleted',
        removal: sampleRemoval(),
      }),
    ])

    renderRouted('/me/posts', <MyPostsPage />, '/me/posts')
    await screen.findByText('捡到一张校园卡')

    const card = cardOf('捡到一张校园卡')
    expect(within(card).getByText(/帖子中的联系方式为他人手机号/)).toBeInTheDocument()
    // 编号必须原样给出来：作者去找 admin 说明情况时要引用它，没有它双方说的不是同一件事。
    expect(within(card).getByText(/4801/)).toBeInTheDocument()
    // #16 在这种状态上直接返回 ITEM_CLOSED，所以「修改」出现了也点不动。
    expect(within(card).queryByRole('link', { name: '修改' })).not.toBeInTheDocument()
  })

  it('解锁名单的入口只看类型不看状态：被下架的 found 帖照样能查「谁来过」', async () => {
    mockMine([
      sampleSummary({ id: 3, item_type: 'found', title: '下架的拾物帖', status: 'deleted', removal: sampleRemoval() }),
      sampleSummary({ id: 4, item_type: 'lost', title: '下架的失物帖', status: 'deleted' }),
    ])

    renderRouted('/me/posts', <MyPostsPage />, '/me/posts')
    await screen.findByText('下架的拾物帖')

    // #22 后端那句注释写的就是「作者被下架之后仍然有权知道在被下架之前谁来看过」，
    // 这一条把它翻成 UI 上的可见性：入口在不在，和「修改」在不在是两条独立判据。
    const found = cardOf('下架的拾物帖')
    expect(within(found).getByRole('link', { name: '谁看过联系方式' })).toHaveAttribute('href', '/items/3/unlockers')

    // 失物帖不出现这个入口：#21 对 lost 返回 VALIDATION，那种帖的名单永远是空的。
    const lost = cardOf('下架的失物帖')
    expect(within(lost).queryByRole('link', { name: '谁看过联系方式' })).not.toBeInTheDocument()
    // 自己删的（没有 removal）不给原因块 —— 那句「谁下架的」根本无从显示，也不该编一句。
    expect(within(lost).queryByText(/已被管理员下架/)).not.toBeInTheDocument()
  })
})

describe('筛选与分页进请求', () => {
  it('状态选「已下架 / 已删除」把 deleted 发出去 —— 广场那一档是不存在的', async () => {
    const user = userEvent.setup()
    const seen = mockMine([sampleSummary()])

    renderRouted('/me/posts', <MyPostsPage />, '/me/posts')
    await screen.findByText('黑色钱包')

    await user.selectOptions(screen.getByLabelText('状态'), 'deleted')
    await screen.findByText('黑色钱包')
    expect(new URL(seen.url).searchParams.get('status')).toBe('deleted')
  })

  it('默认不带 status，也意味着默认视图不是「只看在架的」', async () => {
    const seen = mockMine([sampleSummary()])

    renderRouted('/me/posts', <MyPostsPage />, '/me/posts')
    await screen.findByText('黑色钱包')

    expect(new URL(seen.url).searchParams.has('status')).toBe(false)
  })

  it('关键字按「搜索」才提交，类型 tab 立刻生效且都会把页码清掉', async () => {
    const user = userEvent.setup()
    const seen = mockMine([sampleSummary()], { total: 60 })

    renderRouted('/me/posts', <MyPostsPage />, '/me/posts?page=3')
    await screen.findByText('黑色钱包')

    await user.type(screen.getByLabelText('搜自己的帖子'), '校园卡')
    await user.click(screen.getByRole('button', { name: '搜索' }))
    await screen.findByText('黑色钱包')
    let q = new URL(seen.url).searchParams
    expect(q.get('keyword')).toBe('校园卡')
    expect(q.has('page')).toBe(false)

    await user.click(screen.getByRole('button', { name: '我捡到的东西' }))
    await screen.findByText('黑色钱包')
    q = new URL(seen.url).searchParams
    expect(q.get('item_type')).toBe('found')
    // 换类型不该把关键字清掉：这两个条件是叠加的（「我捡到的、和校园卡有关的」），
    // 清掉任何一个都会让用户以为页面坏了。只有 page 是被刻意重置的。
    expect(q.get('keyword')).toBe('校园卡')
  })

  it('URL 里一个后端不认的值不会转给后端：白名单在 query 组装那一层就生效', async () => {
    const seen = mockMine([sampleSummary()])

    renderRouted('/me/posts', <MyPostsPage />, '/me/posts?status=whatever&sort=updated_at&item_type=bogus')
    await screen.findByText('黑色钱包')

    const q = new URL(seen.url).searchParams
    expect(q.has('status')).toBe(false)
    expect(q.has('sort')).toBe(false)
    expect(q.has('item_type')).toBe(false)
  })

  it('下一页带 page', async () => {
    const user = userEvent.setup()
    const seen = mockMine([sampleSummary()], { total: 45 })

    renderRouted('/me/posts', <MyPostsPage />, '/me/posts')
    await screen.findByText('黑色钱包')
    expect(screen.getByText(/共 45 条/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '下一页' }))
    await screen.findByText('黑色钱包')
    expect(new URL(seen.url).searchParams.get('page')).toBe('2')
  })

  it('末页的「下一页」是禁用的，而不是点出一页空的', async () => {
    mockMine([sampleSummary()], { total: 45 })

    renderRouted('/me/posts', <MyPostsPage />, '/me/posts?page=3')
    await screen.findByText('黑色钱包')

    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '上一页' })).toBeEnabled()
  })
})

describe('失败与空态', () => {
  it('#19 报 VALIDATION 时显示后端那句原因和请求编号', async () => {
    setToken('jwt.me')
    server.use(
      http.get(`${BASE}/api/auth/me`, () => HttpResponse.json(ok(sampleUser()))),
      http.get(
        `${BASE}/api/my/items`,
        () => HttpResponse.json(envelope('VALIDATION', 'sort 不是允许的排序字段', 400).body, { status: 400 }),
      ),
    )

    renderRouted('/me/posts', <MyPostsPage />, '/me/posts?sort=lost_at')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('sort 不是允许的排序字段')
    expect(alert).toHaveTextContent('test-req-validation')
  })

  it('空的那一档给的是这一档专属的一句话，而不是通用的「没有数据」', async () => {
    mockMine([])

    renderRouted('/me/posts', <MyPostsPage />, '/me/posts?status=deleted')

    expect(await screen.findByText(/这一档空着是好事/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '发一条' })).not.toBeInTheDocument()
  })
})
