// src/pages/PlazaPage.test.tsx —— #14 广场：把「筛选真的进了请求」和「found 帖不显示联系方式」钉死。
//
// 这个文件里的断言几乎都是**看请求 URL**而不是看 DOM：广场最容易坏的地方
// 不是渲染，而是「用户改了筛选、页面也在转圈、但请求参数根本没变」——
// 那种 bug 从 DOM 上看不出来，因为它确实在重新请求，只是带着一模一样的条件。
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import PlazaPage from './PlazaPage'
import { renderRouted } from '../test/render'
import { server } from '../test/server'
import { BASE, envelope, ok, sampleCategories, sampleLocations, samplePage, sampleSummary } from '../test/helpers'

/** 装上 #7 #8 #14 三个 mock，并记下最后一次 #14 请求的完整 URL。
 *  返回的是**同一个对象引用**，所以断言可以在 await 之后再读。 */
function mockPlaza(list: ReturnType<typeof sampleSummary>[], extra: { total?: number } = {}) {
  const seen: { url: string } = { url: '' }
  server.use(
    http.get(`${BASE}/api/categories`, () => HttpResponse.json(ok(sampleCategories()))),
    http.get(`${BASE}/api/locations`, () => HttpResponse.json(ok(sampleLocations()))),
    http.get(`${BASE}/api/items`, (c) => {
      seen.url = c.request.url
      return HttpResponse.json(ok(samplePage(list, { total: extra.total ?? list.length })))
    }),
  )
  return seen
}

describe('列表渲染', () => {
  it('lost 帖把联系方式显示出来，found 帖一个字都不显示', async () => {
    mockPlaza([
      sampleSummary({ id: 1, item_type: 'lost', title: '黑色钱包', contact: '微信 aaa' }),
      sampleSummary({ id: 2, item_type: 'found', title: '捡到一串钥匙', contact: null }),
    ])

    renderRouted('/', <PlazaPage />, '/')

    expect(await screen.findByText('黑色钱包')).toBeInTheDocument()
    expect(screen.getByText('联系：微信 aaa')).toBeInTheDocument()

    // 「不显示」要用「这一行根本没出现」来断言，而不是 textContent.notContain 一段中文：
    // 后端对 found 帖返回的是 null，所以前端没有任何可显示的东西，
    // 而一句「进详情认领后可见」是前端自己许愿的，#14 里没有任何字段支撑它。
    expect(await screen.findByText('捡到一串钥匙')).toBeInTheDocument()
    expect(screen.queryByText(/^联系：/)).not.toHaveTextContent('捡到')
    expect(screen.queryByText('捡到一串钥匙')!.closest('li')!.textContent).not.toContain('联系：')
  })

  it('已归还的帖子带上状态标记', async () => {
    mockPlaza([sampleSummary({ id: 3, status: 'closed' })])

    renderRouted('/', <PlazaPage />, '/')

    expect(await screen.findByText('已归还')).toBeInTheDocument()
  })

  it('空结果那段文案不写成「没有匹配」，而是给出可操作的下一步', async () => {
    mockPlaza([])

    renderRouted('/', <PlazaPage />, '/')

    const hint = await screen.findByText(/这个筛选下暂时没有帖子/)
    expect(hint).toBeInTheDocument()
    expect(hint.textContent).toContain('关键字删短')
  })
})

describe('筛选进请求', () => {
  it('点「我在找东西」带上 item_type=lost', async () => {
    const user = userEvent.setup()
    const seen = mockPlaza([sampleSummary()])

    renderRouted('/', <PlazaPage />, '/')
    await screen.findByText('黑色钱包')

    await user.click(screen.getByRole('button', { name: '我在找东西' }))

    await screen.findByText('黑色钱包')
    expect(new URL(seen.url).searchParams.get('item_type')).toBe('lost')
  })

  it('关键字要按「搜索」才提交，敲一个字请求一次是错的', async () => {
    const user = userEvent.setup()
    const seen = mockPlaza([sampleSummary()])

    renderRouted('/', <PlazaPage />, '/')
    await screen.findByText('黑色钱包')

    await user.type(screen.getByLabelText('搜标题和描述'), '钱包')
    // 敲完之后 URL 里还应该是上一次的条件：这里断言的是「没有多发请求」，
    // 而 keyword 是唯一一个「一改就发」就会变成请求风暴的输入框。
    expect(new URL(seen.url).searchParams.get('keyword')).toBeNull()

    await user.click(screen.getByRole('button', { name: '搜索' }))
    await screen.findByText('黑色钱包')
    expect(new URL(seen.url).searchParams.get('keyword')).toBe('钱包')
  })

  it('排序选「按丢失时间」带 sort=lost_at，默认的 created_at 不写进 URL', async () => {
    const user = userEvent.setup()
    const seen = mockPlaza([sampleSummary()])

    renderRouted('/', <PlazaPage />, '/')
    await screen.findByText('黑色钱包')
    expect(new URL(seen.url).searchParams.has('sort')).toBe(false)

    await user.selectOptions(screen.getByLabelText('排序'), 'lost_at')
    await screen.findByText('黑色钱包')
    expect(new URL(seen.url).searchParams.get('sort')).toBe('lost_at')
  })

  it('分类要选到叶子才生效：只选大类不发 category_id', async () => {
    const user = userEvent.setup()
    const seen = mockPlaza([sampleSummary()])

    renderRouted('/', <PlazaPage />, '/')
    await screen.findByText('黑色钱包')

    await user.selectOptions(screen.getByLabelText('分类'), '20')
    await screen.findByText('黑色钱包')
    expect(new URL(seen.url).searchParams.has('category_id')).toBe(false)

    await user.selectOptions(screen.getByLabelText('衣物箱包里的下一级'), '21')
    await screen.findByText('黑色钱包')
    expect(new URL(seen.url).searchParams.get('category_id')).toBe('21')
  })

  it('打开一条分享来的链接时，URL 里的筛选既生效也显示成选中态', async () => {
    const seen = mockPlaza([sampleSummary({ item_type: 'found', contact: null })])

    renderRouted('/', <PlazaPage />, '/?item_type=found&status=closed&sort=found_at&page=2')
    await screen.findByText('黑色钱包')

    const q = new URL(seen.url).searchParams
    expect(q.get('item_type')).toBe('found')
    expect(q.get('status')).toBe('closed')
    expect(q.get('sort')).toBe('found_at')
    expect(q.get('page')).toBe('2')

    // 光请求对了不够，控件也必须显示成对应状态，否则用户看到「全部」而结果是 found 的，
    // 他会以为筛选坏了，然后把对的链接丢掉。
    expect(screen.getByLabelText('状态')).toHaveValue('closed')
    expect(screen.getByLabelText('排序')).toHaveValue('found_at')
  })
})

describe('分页', () => {
  it('下一页把 page 带上去，并回到顶部那段列表', async () => {
    const user = userEvent.setup()
    const seen = mockPlaza([sampleSummary()], { total: 45 })

    renderRouted('/', <PlazaPage />, '/')
    await screen.findByText('黑色钱包')

    expect(screen.getByText(/共 45 条/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: '下一页' }))
    await screen.findByText('黑色钱包')
    expect(new URL(seen.url).searchParams.get('page')).toBe('2')
  })

  it('最后一页的「下一页」是禁用的，而不是点出一页空的', async () => {
    mockPlaza([sampleSummary()], { total: 21 })

    renderRouted('/', <PlazaPage />, '/?page=2')
    await screen.findByText('黑色钱包')

    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '上一页' })).toBeEnabled()
  })

  it('改任何筛选条件都回到第一页 —— 停在第 4 页换类目会让人以为那个类目只有三条', async () => {
    const user = userEvent.setup()
    const seen = mockPlaza([sampleSummary()], { total: 100 })

    renderRouted('/', <PlazaPage />, '/?page=4')
    await screen.findByText('黑色钱包')

    await user.click(screen.getByRole('button', { name: '有人捡到东西' }))
    await screen.findByText('黑色钱包')

    const q = new URL(seen.url).searchParams
    expect(q.get('item_type')).toBe('found')
    expect(q.has('page')).toBe(false)
  })
})

describe('失败', () => {
  it('#14 报 VALIDATION 时显示后端那句具体原因和请求编号', async () => {
    server.use(
      http.get(`${BASE}/api/categories`, () => HttpResponse.json(ok(sampleCategories()))),
      http.get(`${BASE}/api/locations`, () => HttpResponse.json(ok(sampleLocations()))),
      http.get(
        `${BASE}/api/items`,
        () => HttpResponse.json(envelope('VALIDATION', 'status 不对', 200, { errors: [{ field: 'status', msg: '只能是 open / closed' }] }).body, { status: 400 }),
      ),
    )

    renderRouted('/', <PlazaPage />, '/')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('status 不对')
    expect(alert).toHaveTextContent('test-req-validation')
  })

  it('字典树挂了不影响帖子列表 —— 用户是来看帖子的，不是来看筛选器的', async () => {
    server.use(
      http.get(`${BASE}/api/categories`, () => HttpResponse.json({ code: 'INTERNAL', message: 'x', data: null, request_id: 'r' }, { status: 500 })),
      http.get(`${BASE}/api/locations`, () => HttpResponse.json({ code: 'INTERNAL', message: 'x', data: null, request_id: 'r' }, { status: 500 })),
      http.get(`${BASE}/api/items`, () => HttpResponse.json(ok(samplePage([sampleSummary()])))),
    )

    renderRouted('/', <PlazaPage />, '/')

    expect(await screen.findByText('黑色钱包')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
