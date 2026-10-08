// src/pages/NotificationsPage.test.tsx —— #30 列表 + #31 未读数 + #32 标记已读。
//
// 三条断言的优先级来自后端的形状，而不是页面好不好看：
//   ① 落点不能只按 type 决定：`admin_action` 底下藏着五种事，只有删归还记录那一种带 return_id；
//      批量下架动 50 条时通知里两个 id 都是 null。所以规则只能是 return_id → item_id → 不给链接。
//   ② 「已标记 N 条」里的 N 只能是 updated_count（真的从 false 翻成 true 的行数），
//      同一批连点两次第二次是 0 —— 按 ids.length 报数就是在报一件没发生过的事。
//   ③ #32 的 body 只能有两种形状（只有 ids，或只有 {"all":true}）。`{"all":false}` 会被后端
//      读成「没填 all」而落到全标已读那条路上，那是一个人一键把别人通知全标掉的入口。
//   ④ 标已读有两条路（按钮 / 点开落点），两条都必须安静地只管这一条，而且都只发那两种形状之一。
//      「点开落点」那条还要能在**不跳走**的情况下验（按住 Ctrl 点 = 开新标签页，这一页还活着），
//      不然乐观翻转和失败不吭声这两件事在测试里根本观察不到 —— 一跳转整页就卸载了。
//   另外：?read 是三态，'false' 必须真的发到线上（只看未读正是这一页的主用法）。
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import NotificationsPage from './NotificationsPage'
import { onUnreadCountChanged } from '../api/unreadBus'
import { renderRouted } from '../test/render'
import { server } from '../test/server'
import { BASE, envelope, ok, sampleNotification, samplePage, sampleUser } from '../test/helpers'
import { setToken } from '../api/session'
import type { NotificationView } from '../api/types'

/** #30 / #31 都记次数和 URL；#32 记请求体。 */
function mockFlow(
  list: NotificationView[],
  opts: { unread?: number | null; updated?: number } = {},
) {
  const seen: {
    listUrl: string
    listTimes: number
    unreadTimes: number
    markBody: unknown
    markTimes: number
  } = { listUrl: '', listTimes: 0, unreadTimes: 0, markBody: null, markTimes: 0 }
  const unread = opts.unread === undefined ? 2 : opts.unread
  setToken('jwt.me')
  server.use(
    http.get(`${BASE}/api/auth/me`, () => HttpResponse.json(ok(sampleUser({ id: 7 })))),
    http.get(`${BASE}/api/my/notifications`, (c) => {
      seen.listUrl = c.request.url
      seen.listTimes += 1
      return HttpResponse.json(ok(samplePage(list)))
    }),
    http.get(`${BASE}/api/my/notifications/unread-count`, () => {
      seen.unreadTimes += 1
      if (unread === null) {
        return HttpResponse.json(envelope('INTERNAL', 'boom', 500).body, { status: 500 })
      }
      return HttpResponse.json(ok({ count: unread }))
    }),
    http.put(`${BASE}/api/my/notifications/read`, async (c) => {
      seen.markTimes += 1
      seen.markBody = await c.request.json()
      return HttpResponse.json(ok({ updated_count: opts.updated ?? 0 }))
    }),
  )
  return seen
}

async function rowOf(title: string): Promise<HTMLElement> {
  const el = await screen.findByText(title)
  return el.closest('li')!
}

describe('未读数是单独一次读', () => {
  it('顶部那句用的是 #31 的 count，不是列表行数', async () => {
    mockFlow([sampleNotification()], { unread: 34 })

    renderRouted('/me/notifications', <NotificationsPage />, '/me/notifications')
    await screen.findByText('还有 34 条没读过。')

    // 列表只回了一行（默认 page_size 20），而顶上是 34 —— 两个数是两件事。
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })

  it('#31 失败时说的是「读不到」而不是「0 条」', async () => {
    mockFlow([sampleNotification()], { unread: null })

    renderRouted('/me/notifications', <NotificationsPage />, '/me/notifications')
    expect(await screen.findByText('未读数暂时读不到。')).toBeInTheDocument()
    expect(screen.queryByText(/还有 0 条/)).not.toBeInTheDocument()
  })
})

describe('?read 是三态', () => {
  it('不带参数时不发给后端，界面上亮的是「全部」', async () => {
    const seen = mockFlow([sampleNotification()])

    renderRouted('/me/notifications', <NotificationsPage />, '/me/notifications')
    await screen.findByText(/向《捡到黑色长款钱包》提交了一次归还确认/)

    expect(new URL(seen.listUrl).searchParams.has('is_read')).toBe(false)
    expect(screen.getByRole('button', { name: '全部' })).toHaveClass('tab-on')
  })

  it('「没读过」把 is_read=false 真的发出去 —— false 不是「没填」', async () => {
    const user = userEvent.setup()
    const seen = mockFlow([sampleNotification()])

    renderRouted('/me/notifications', <NotificationsPage />, '/me/notifications')
    await screen.findByText(/向《捡到黑色长款钱包》提交了一次归还确认/)

    await user.click(screen.getByRole('button', { name: '没读过' }))
    await screen.findByText(/向《捡到黑色长款钱包》提交了一次归还确认/)

    // 后端只认字符串 'true'/'false'，而 JS 里 falsy 的 false 太容易被当成「没填」丢掉。
    expect(new URL(seen.listUrl).searchParams.get('is_read')).toBe('false')
  })

  it('「已读」发 is_read=true', async () => {
    const user = userEvent.setup()
    const seen = mockFlow([sampleNotification({ is_read: true })])

    renderRouted('/me/notifications', <NotificationsPage />, '/me/notifications?read=true')
    await screen.findByText(/向《捡到黑色长款钱包》提交了一次归还确认/)

    expect(new URL(seen.listUrl).searchParams.get('is_read')).toBe('true')
    await user.click(screen.getByRole('button', { name: '全部' }))
    expect(new URL(seen.listUrl).searchParams.has('is_read')).toBe(false)
  })
})

describe('一条通知能点去哪里', () => {
  it('有 return_id 就进那条归还记录，哪怕它还带着 item_id', async () => {
    mockFlow([sampleNotification({ id: 1, return_id: 901, item_id: 202 })])

    renderRouted('/me/notifications', <NotificationsPage />, '/me/notifications')
    const row = await rowOf('小李向《捡到黑色长款钱包》提交了一次归还确认')

    // 顺序是有道理的：这一条的「现场」是那次归还，帖子只是背景。
    expect(within(row).getByRole('link')).toHaveAttribute('href', '/returns/901')
  })

  it('只有 item_id 就进那条帖子', async () => {
    mockFlow([sampleNotification({ id: 2, type: 'new_match', return_id: null })])

    renderRouted('/me/notifications', <NotificationsPage />, '/me/notifications')
    expect(within(await rowOf('小李向《捡到黑色长款钱包》提交了一次归还确认')).getByRole('link')).toHaveAttribute(
      'href',
      '/items/202',
    )
  })

  it('两个 id 都没有就不给链接 —— 批量下架 50 条时通知里就是两个 null', async () => {
    mockFlow([
      sampleNotification({ id: 3, type: 'admin_action', title: '你的 50 条帖子已被下架', item_id: null, return_id: null }),
    ])

    renderRouted('/me/notifications', <NotificationsPage />, '/me/notifications')
    const row = await rowOf('你的 50 条帖子已被下架')

    // 硬造一个 /items/ 的空链接比不给链接更坏：点开是一句「不存在」，而那条通知本来就没有落点。
    expect(within(row).queryByRole('link')).not.toBeInTheDocument()
    expect(within(row).getByText('你的 50 条帖子已被下架')).toBeInTheDocument()
    // 没有落点就没有「点开即已读」这条路，那个按钮是这一行唯一的出口，不能顺手收掉。
    expect(within(row).getByRole('button', { name: '标为已读' })).toBeInTheDocument()
  })

  it('类型那一行把七种取值都认得，未知的那种原样显示而不是空白', async () => {
    mockFlow([
      sampleNotification({ id: 4, type: 'item_returned_hint', title: '你联系过的那条拾物帖有了进展' }),
    ])

    renderRouted('/me/notifications', <NotificationsPage />, '/me/notifications')
    const row = await rowOf('你联系过的那条拾物帖有了进展')
    // 这一句讲的是这条通知的真实来历：发帖人确认过一次归还，而确认**不通知提交人以外的人**，
    // 所以收到它的只有匹配台账里的失物作者。
    expect(within(row).getByText(/你联系过的那条拾物帖，发帖人已确认过一次归还/)).toBeInTheDocument()
  })
})

describe('点开落点也算已读', () => {
  it('点标题：既跳去了落点，也把这一条标掉了，body 还是只发 ids', async () => {
    const user = userEvent.setup()
    const seen = mockFlow([sampleNotification({ id: 801 })], { updated: 1 })

    renderRouted('/me/notifications', <NotificationsPage />, '/me/notifications')
    const row = await rowOf('小李向《捡到黑色长款钱包》提交了一次归还确认')
    await user.click(within(row).getByRole('link'))

    // 看详情是目的，标已读是顺手，两件都必须成：跳转不能等 PUT，PUT 也不能拦住跳转。
    expect(await screen.findByText('详情页桩')).toBeInTheDocument()
    await waitFor(() => expect(seen.markTimes).toBe(1))
    expect(seen.markBody).toEqual({ ids: [801] })
    expect(Object.keys(seen.markBody as object)).toEqual(['ids'])
  })

  it('点开成功要发一次「未读数变了」：换页那一刻徽标读的是还没落库的数', async () => {
    const user = userEvent.setup()
    mockFlow([sampleNotification({ id: 801 })], { updated: 1 })
    const rang = vi.fn()
    const off = onUnreadCountChanged(rang)

    try {
      renderRouted('/me/notifications', <NotificationsPage />, '/me/notifications')
      await user.click(within(await rowOf('小李向《捡到黑色长款钱包》提交了一次归还确认')).getByRole('link'))

      // 这一句钉的是顺序，不是次数：Link 一点就换页，App 的徽标在换页时读一次 #31，
      // 那次读多半早于 PUT 落库。没有这第二次唤起，徽标就永远停在标记之前的数上。
      await waitFor(() => expect(rang).toHaveBeenCalledTimes(1))
    } finally {
      off()
    }
  })

  it('按住 Ctrl 点（开新标签页，这一页还活着）：那一行的未读点和按钮当场消失，而且一声不吭', async () => {
    const seen = mockFlow([sampleNotification({ id: 801 })], { updated: 1, unread: 5 })

    renderRouted('/me/notifications', <NotificationsPage />, '/me/notifications')
    const row = await rowOf('小李向《捡到黑色长款钱包》提交了一次归还确认')
    expect(within(row).getByText('未读')).toBeInTheDocument()

    // React Router 见到任何修饰键就不接管这次点击（把开新标签页的权力留给浏览器），
    // 于是这一页没卸载 —— 乐观翻转在普通点击那条路上根本看不见，只有这一种点法能钉住它。
    // 这里用 fireEvent 而不是 user.click：user-event 的 convenience click 不收修饰符参数，
    // 事件上没带 ctrlKey， Router 照样把页面跳走了（console 里那两句 "Not implemented: navigation"
    // 就是浏览器接管之后的事，正说明 Router 没拦）。
    fireEvent.click(within(row).getByRole('link'), { ctrlKey: true })

    expect(screen.queryByText('详情页桩')).not.toBeInTheDocument()
    await waitFor(() => expect(within(row).queryByText('未读')).not.toBeInTheDocument())
    expect(within(row).queryByRole('button', { name: '标为已读' })).not.toBeInTheDocument()

    // 静默：这条路不许弹 mark() 那句「已标记 N 条」，也不重读整张列表（人没在管理收件箱）。
    expect(screen.queryByText(/已标记/)).not.toBeInTheDocument()
    expect(seen.listTimes).toBe(1)
    // 顶部那句「还有 N 条没读过」是这一页自己的 state，跟着新读一次 #31，不能自己减一。
    expect(seen.unreadTimes).toBe(2)
  })

  it('点开时那条 PUT 失败了：不报错、那一行还是未读、也不惊动徽标', async () => {
    const seen = mockFlow([sampleNotification({ id: 801 })], { updated: 1 })
    // 记次数的那个 handler 会被下面这条覆盖掉（msw 取最后注册的那条匹配），
    // 所以前提「请求真的发出去了」只能在覆盖之后的 handler 里自己记。
    let putTimes = 0
    server.use(
      http.put(`${BASE}/api/my/notifications/read`, () => {
        putTimes += 1
        return HttpResponse.json(envelope('INTERNAL', 'boom', 500).body, { status: 500 })
      }),
    )
    const rang = vi.fn()
    const off = onUnreadCountChanged(rang)

    try {
      renderRouted('/me/notifications', <NotificationsPage />, '/me/notifications')
      const row = await rowOf('小李向《捡到黑色长款钱包》提交了一次归还确认')
      fireEvent.click(within(row).getByRole('link'), { ctrlKey: true })

      await waitFor(() => expect(putTimes).toBe(1))

      // 已读只是元数据，不是这一趟跳转的前提，更不是一个值得单独报的错。
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(within(row).getByText('未读')).toBeInTheDocument()
      expect(within(row).getByRole('button', { name: '标为已读' })).toBeInTheDocument()
      expect(rang).not.toHaveBeenCalled()
      expect(seen.listTimes).toBe(1)
    } finally {
      off()
    }
  })

  it('已经是已读的行点标题只是跳过去，不再发第二次 PUT', async () => {
    const user = userEvent.setup()
    const seen = mockFlow([sampleNotification({ id: 801, is_read: true })])

    renderRouted('/me/notifications', <NotificationsPage />, '/me/notifications')
    const row = await rowOf('小李向《捡到黑色长款钱包》提交了一次归还确认')
    await user.click(within(row).getByRole('link'))

    expect(await screen.findByText('详情页桩')).toBeInTheDocument()
    expect(seen.markTimes).toBe(0)
  })
})

describe('标记已读只有两种 body 形状', () => {
  it('单条：只发 ids，不发 all', async () => {
    const user = userEvent.setup()
    const seen = mockFlow([sampleNotification({ id: 701 })], { updated: 1 })

    renderRouted('/me/notifications', <NotificationsPage />, '/me/notifications')
    const row = await rowOf('小李向《捡到黑色长款钱包》提交了一次归还确认')
    await user.click(within(row).getByRole('button', { name: '标为已读' }))

    expect(await screen.findByText('已标记 1 条。')).toBeInTheDocument()
    expect(seen.markBody).toEqual({ ids: [701] })
    expect(Object.keys(seen.markBody as object)).toEqual(['ids'])
  })

  it('全部要两步，第一步一个请求都不发', async () => {
    const user = userEvent.setup()
    const seen = mockFlow([sampleNotification({ id: 701 })])

    renderRouted('/me/notifications', <NotificationsPage />, '/me/notifications')
    await user.click(await screen.findByRole('button', { name: '全部标为已读' }))

    // 已读不可逆：整个路由表里没有「标为未读」这条，所以点第一下只把确认问出来。
    expect(seen.markTimes).toBe(0)
    expect(screen.getByText(/标为已读以后不能再变回来/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '确定' }))
    expect(seen.markBody).toEqual({ all: true })
    expect(Object.keys(seen.markBody as object)).toEqual(['all'])
  })

  it('「先不」把确认收掉，什么都不发', async () => {
    const user = userEvent.setup()
    const seen = mockFlow([sampleNotification({ id: 701 })])

    renderRouted('/me/notifications', <NotificationsPage />, '/me/notifications')
    await user.click(await screen.findByRole('button', { name: '全部标为已读' }))
    await user.click(screen.getByRole('button', { name: '先不' }))

    expect(seen.markTimes).toBe(0)
    expect(screen.queryByText(/标为已读以后不能再变回来/)).not.toBeInTheDocument()
  })

  it('报的是 updated_count，不是提交上去的条数', async () => {
    const user = userEvent.setup()
    // 同一批连点两次：第二次后端翻不出任何行，updated_count 是 0。
    const seen = mockFlow([sampleNotification({ id: 701 })], { updated: 0 })

    renderRouted('/me/notifications', <NotificationsPage />, '/me/notifications')
    const row = await rowOf('小李向《捡到黑色长款钱包》提交了一次归还确认')
    await user.click(within(row).getByRole('button', { name: '标为已读' }))

    expect(await screen.findByText('没有需要标记的，这些都已经是已读了。')).toBeInTheDocument()
    expect(screen.queryByText('已标记 1 条。')).not.toBeInTheDocument()
    expect(seen.markTimes).toBe(1)
  })

  it('标完重新读列表和未读数，不拿响应拼界面', async () => {
    const user = userEvent.setup()
    const seen = mockFlow([sampleNotification({ id: 701 })], { updated: 1, unread: 8 })

    renderRouted('/me/notifications', <NotificationsPage />, '/me/notifications')
    await screen.findByText('还有 8 条没读过。')
    expect(seen.listTimes).toBe(1)
    expect(seen.unreadTimes).toBe(1)

    await user.click(within(await rowOf('小李向《捡到黑色长款钱包》提交了一次归还确认')).getByRole('button', { name: '标为已读' }))
    await screen.findByText('已标记 1 条。')

    expect(seen.listTimes).toBe(2)
    expect(seen.unreadTimes).toBe(2)
  })

  it('标成功时对外发一次「未读数变了」：导航栏那个数不是这一页的 state，不发就停在标之前', async () => {
    const user = userEvent.setup()
    mockFlow([sampleNotification({ id: 701 })], { updated: 1 })
    const rang = vi.fn()
    const off = onUnreadCountChanged(rang)

    try {
      renderRouted('/me/notifications', <NotificationsPage />, '/me/notifications')
      await user.click(
        within(await rowOf('小李向《捡到黑色长款钱包》提交了一次归还确认')).getByRole('button', {
          name: '标为已读',
        }),
      )
      await screen.findByText('已标记 1 条。')

      // 这一页自己那句「还有 N 条没读过」跟着 state 走，天然会新；
      // 会滞后的只有 App 里那个靠 pathname 重读的徽标，所以钉的是信号发没发。
      expect(rang).toHaveBeenCalledTimes(1)
    } finally {
      off()
    }
  })

  it('标失败不发这个信号：没发生过的事不能通知别人去重读', async () => {
    const user = userEvent.setup()
    mockFlow([sampleNotification({ id: 701 })], { updated: 1 })
    server.use(
      http.put(
        `${BASE}/api/my/notifications/read`,
        () => HttpResponse.json(envelope('INTERNAL', 'boom', 500).body, { status: 500 }),
      ),
    )
    const rang = vi.fn()
    const off = onUnreadCountChanged(rang)

    try {
      renderRouted('/me/notifications', <NotificationsPage />, '/me/notifications')
      await user.click(
        within(await rowOf('小李向《捡到黑色长款钱包》提交了一次归还确认')).getByRole('button', {
          name: '标为已读',
        }),
      )
      await screen.findByRole('alert')

      expect(rang).not.toHaveBeenCalled()
    } finally {
      off()
    }
  })

  it('已经是已读的行不给「标为已读」键', async () => {
    mockFlow([sampleNotification({ id: 701, is_read: true })])

    renderRouted('/me/notifications', <NotificationsPage />, '/me/notifications')
    const row = await rowOf('小李向《捡到黑色长款钱包》提交了一次归还确认')
    expect(within(row).queryByRole('button', { name: '标为已读' })).not.toBeInTheDocument()
    expect(within(row).queryByText('未读')).not.toBeInTheDocument()
  })
})

describe('失败与空态', () => {
  it('#30 报错显示后端那句（VALIDATION 不在前端表里）和请求编号', async () => {
    setToken('jwt.me')
    server.use(
      http.get(`${BASE}/api/auth/me`, () => HttpResponse.json(ok(sampleUser()))),
      http.get(`${BASE}/api/my/notifications/unread-count`, () => HttpResponse.json(ok({ count: 0 }))),
      http.get(
        `${BASE}/api/my/notifications`,
        () => HttpResponse.json(envelope('VALIDATION', 'is_read 只能是 true 或 false', 400).body, { status: 400 }),
      ),
    )

    renderRouted('/me/notifications', <NotificationsPage />, '/me/notifications?read=1')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('is_read 只能是 true 或 false')
    expect(alert).toHaveTextContent('test-req-validation')
  })

  it('未读那一档空着时说「没有没读过的」，而不是「这里还没有过通知」', async () => {
    mockFlow([])

    renderRouted('/me/notifications', <NotificationsPage />, '/me/notifications?read=false')
    expect(await screen.findByText('没有没读过的通知。')).toBeInTheDocument()
    expect(screen.queryByText(/这里还没有过通知/)).not.toBeInTheDocument()
  })

  it('这一页不承诺任何判断：通知只是发生过一件事的记录', async () => {
    mockFlow([sampleNotification()])

    renderRouted('/me/notifications', <NotificationsPage />, '/me/notifications')
    await screen.findByText(/向《捡到黑色长款钱包》提交了一次归还确认/)

    expect(screen.getByText(/它不代表那件事还在原地/)).toBeInTheDocument()
    // 后端 TestNoticeCopyMakesNoPlatformPromise 那张禁词表同样管前端这句。
    const text = document.body.textContent ?? ''
    for (const banned of ['归还成功', '已归还给你', '已关闭', '这就是', '判定']) {
      expect(text, `出现了禁词：${banned}`).not.toContain(banned)
    }
  })
})
