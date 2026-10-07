// src/pages/ContactViewsPage.test.tsx —— #22 解锁名单：这一页最贵的断言是「不该发的请求没发」。
//
// 名单里装的是别人的真实姓名（UnlockerView 上那段：全项目唯一一处）。所以
// 「非作者连请求都不发」不是省一次往返的性能优化，而是一条隐私边界的前端形态：
// 后端当然会返回 FORBIDDEN，但一次发了又被拒的请求意味着 URL 拼错、身份判错时
// 浏览器历史里留了一条「有人试图读别人的名单」，而这份日志本身就是要拿来说事的。
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import ContactViewsPage from './ContactViewsPage'
import { renderRouted } from '../test/render'
import { server } from '../test/server'
import {
  BASE,
  envelope,
  ok,
  sampleContactEntry,
  sampleItemView,
  samplePage,
  sampleUser,
} from '../test/helpers'
import { setToken } from '../api/session'
import type { ContactViewEntry } from '../api/types'

/** 装上 #15（这条帖属于 id=8 的小王）与 #22，并返回两个计数器：
 *  这两个数就是这一页的行为契约 —— details 应当恒为 1，views 由身份决定。 */
function mockItemAndViews(list: ContactViewEntry[], extra: { total?: number } = {}) {
  const calls = { details: 0, views: 0, lastUrl: '' }
  server.use(
    http.get(`${BASE}/api/items/:id`, () => {
      calls.details += 1
      return HttpResponse.json(
        ok(sampleItemView({ author: { id: 8, nickname: '小王' }, contact: '微信 bbb', contact_locked: false })),
      )
    }),
    http.get(`${BASE}/api/items/:id/contact-views`, (c) => {
      calls.views += 1
      calls.lastUrl = c.request.url
      return HttpResponse.json(ok(samplePage(list, { total: extra.total ?? list.length })))
    }),
  )
  return calls
}

function asAuthor() {
  setToken('jwt.xiaowang')
  server.use(http.get(`${BASE}/api/auth/me`, () => HttpResponse.json(ok(sampleUser({ id: 8, nickname: '小王' })))))
}

function asSomeoneElse(role = 'user') {
  setToken('jwt.other')
  server.use(http.get(`${BASE}/api/auth/me`, () => HttpResponse.json(ok(sampleUser({ id: 7, nickname: '小李', role })))))
}

describe('发帖人本人', () => {
  it('名单列得出人、时间和可引用的记录编号', async () => {
    asAuthor()
    const calls = mockItemAndViews([sampleContactEntry({ nickname: '小李', real_name: '李雷' }, { id: 37 })])

    renderRouted('/items/:id/unlockers', <ContactViewsPage />, '/items/202/unlockers')

    expect(await screen.findByText('小李')).toBeInTheDocument()
    const row = screen.getByText('小李').closest('li')!
    expect(within(row).getByText('（李雷）')).toBeInTheDocument()
    expect(within(row).getByText(/记录 37/)).toBeInTheDocument()

    // 时间必须是换算过的形状，不能是后端那串带 Z 的 UTC —— 那种串读出来差一个时区。
    expect(row.textContent).not.toContain('2026-10-07T01:30:00Z')
    expect(row!.textContent).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)

    expect(calls.details).toBe(1)
    expect(calls.views).toBe(1)
  })

  it('没有真名的那行不显示空括号', async () => {
    asAuthor()
    mockItemAndViews([sampleContactEntry({ nickname: '阿明', real_name: '' })])

    renderRouted('/items/:id/unlockers', <ContactViewsPage />, '/items/202/unlockers')

    const row = (await screen.findByText('阿明')).closest('li')!
    expect(row.textContent).not.toContain('（）')
  })

  it('空名单说的是「还没有人看过」，不是「没有数据」', async () => {
    asAuthor()
    mockItemAndViews([])

    renderRouted('/items/:id/unlockers', <ContactViewsPage />, '/items/202/unlockers')

    expect(await screen.findByText(/还没有人查看过这条联系方式/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('翻页只改 page，并且回到第二页时不重复请求详情', async () => {
    const user = userEvent.setup()
    asAuthor()
    const calls = mockItemAndViews([sampleContactEntry({}, { id: 38 })], { total: 25 })

    renderRouted('/items/:id/unlockers', <ContactViewsPage />, '/items/202/unlockers')
    await screen.findByText('小李')

    await user.click(screen.getByRole('button', { name: '下一页' }))
    await screen.findByText('小李')

    expect(new URL(calls.lastUrl).searchParams.get('page')).toBe('2')
    expect(calls.details, '翻页不该把详情再问一遍：标题和作者身份这一屏内没变').toBe(1)
    expect(calls.views).toBe(2)
  })
})

describe('不是发帖人', () => {
  it('普通访客连请求都不发，页面上直接说明为什么', async () => {
    asSomeoneElse()
    const calls = mockItemAndViews([sampleContactEntry()])

    renderRouted('/items/:id/unlockers', <ContactViewsPage />, '/items/202/unlockers')

    await screen.findByText(/只有发帖人本人/)
    expect(calls.views, '非作者不该发出那次读名单的请求（后端会拒，但拒之前已经是一次越界尝试）').toBe(0)
  })

  it('admin 例外：后端 #22 的鉴权列写的就是「发帖人或 admin」，前端不许把它收紧成只认本人', async () => {
    asSomeoneElse('admin')
    const calls = mockItemAndViews([sampleContactEntry()])

    renderRouted('/items/:id/unlockers', <ContactViewsPage />, '/items/202/unlockers')

    expect(await screen.findByText('小李')).toBeInTheDocument()
    expect(calls.views).toBe(1)
  })
})

describe('失败', () => {
  it('#15 就失败时不出现名单，只给一句看不了和回我的发布的路', async () => {
    asAuthor()
    const calls: { views: number } = { views: 0 }
    server.use(
      http.get(`${BASE}/api/items/:id`, () =>
        HttpResponse.json(envelope('NOT_FOUND', '帖子不存在', 404).body, { status: 404 }),
      ),
      http.get(`${BASE}/api/items/:id/contact-views`, () => {
        calls.views += 1
        return HttpResponse.json(ok(samplePage([])))
      }),
    )

    renderRouted('/items/:id/unlockers', <ContactViewsPage />, '/items/999999/unlockers')

    expect(await screen.findByRole('alert')).toHaveTextContent('要找的东西不在了')
    expect(calls.views).toBe(0)
    expect(screen.getByRole('link', { name: '回我的发布' })).toHaveAttribute('href', '/me/posts')
  })

  it('#22 报 FORBIDDEN 时显示后端那句具体原因和请求编号', async () => {
    asAuthor()
    server.use(
      http.get(`${BASE}/api/items/:id`, () =>
        HttpResponse.json(ok(sampleItemView({ author: { id: 8, nickname: '小王' } }))),
      ),
      http.get(
        `${BASE}/api/items/:id/contact-views`,
        () =>
          HttpResponse.json(
            envelope('FORBIDDEN', '只有发帖人能查看这条帖子的解锁名单', 403).body,
            { status: 403 },
          ),
      ),
    )

    renderRouted('/items/:id/unlockers', <ContactViewsPage />, '/items/202/unlockers')

    // 这一条走的是「前端判对了身份、后端还是拒」的路径（比如那条帖的作者刚改过）。
    // 文案按 §8 的纪律走前端的 code→人话表（errorText 里 FORBIDDEN 那一条），
    // 分支永远写在 code 上而不是后端的 message 上 —— 所以这里断言的是我们那句，不是它那句。
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('没有权限执行这个操作')
    expect(alert).toHaveTextContent('test-req-forbidden')
  })
})
