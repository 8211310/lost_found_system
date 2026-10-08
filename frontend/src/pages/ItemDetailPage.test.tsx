// src/pages/ItemDetailPage.test.tsx —— #15 的三种联系方式状态 + #21 解锁 + #41 弱举报 + #20 匹配面板。
//
// 这个文件里最值钱的断言是「点击之前那个请求不存在」：
// #21 会往 contact_views 落一行，而那一行是 §3.4 说的「骚扰的唯一事后证据」。
// 只要有人在 useEffect 里预取它，那份日志就从「谁解锁了」变成「谁打开过页面」，
// 整条链路的意义都没了 —— 而从界面上看，两种实现一模一样。
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import ItemDetailPage from './ItemDetailPage'
import { renderRouted } from '../test/render'
import { server } from '../test/server'
import { BASE, envelope, ok, sampleItemView, sampleSummary, sampleUser } from '../test/helpers'
import { setToken } from '../api/session'
import type { LocationSignal, MatchHit, MatchResult, TimeSignal } from '../api/types'

/** #15 的 mock。顺带记下请求次数：这一页只该问一次详情。 */
function mockDetail(view: ReturnType<typeof sampleItemView>) {
  server.use(
    http.get(`${BASE}/api/items/:id`, () => HttpResponse.json(ok(view))),
  )
}

function mockMe(user: ReturnType<typeof sampleUser>) {
  server.use(http.get(`${BASE}/api/auth/me`, () => HttpResponse.json(ok(user))))
}

describe('匿名访问（#15 是公开接口）', () => {
  it('found 帖内容全可见，但联系方式锁着，只给一个认领按钮', async () => {
    mockDetail(sampleItemView())

    renderRouted('/items/:id', <ItemDetailPage />, '/items/202')

    expect(await screen.findByText('捡到黑色长款钱包')).toBeInTheDocument()
    expect(screen.getByText('三楼自习区靠窗')).toBeInTheDocument()
    expect(screen.queryByText('微信 bbb')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '认领并查看联系方式' })).toBeInTheDocument()
  })

  it('描述里的换行原样保留（后端不做二次加工，前端也不能）', async () => {
    mockDetail(sampleItemView({ description: '第一行\n\n第二行' }))

    renderRouted('/items/:id', <ItemDetailPage />, '/items/202')

    const p = await screen.findByText(/第一行/)
    expect(p).toHaveClass('description')
    expect(p.textContent).toBe('第一行\n\n第二行')
  })

  it('lost 帖的联系方式直接显示，没有认领按钮', async () => {
    mockDetail(
      sampleItemView({ item_type: 'lost', contact: '微信 aaa', contact_locked: false }),
    )

    renderRouted('/items/:id', <ItemDetailPage />, '/items/202')

    expect(await screen.findByText('微信 aaa')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /认领并查看联系方式/ })).not.toBeInTheDocument()
  })

  it('帖子不存在时显示后端那句原因和请求编号，并给一条回广场的路', async () => {
    server.use(
      http.get(
        `${BASE}/api/items/:id`,
        () => HttpResponse.json(envelope('NOT_FOUND', '帖子不存在', 404).body, { status: 404 }),
      ),
    )

    renderRouted('/items/:id', <ItemDetailPage />, '/items/999999')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('要找的东西不在了')
    expect(alert).toHaveTextContent('test-req-not_found')
    expect(screen.getByRole('link', { name: '回广场' })).toHaveAttribute('href', '/')
  })

  it('匿名点「认领」被送去登录页，并带上 from（登录后回本页）', async () => {
    const user = userEvent.setup()
    mockDetail(sampleItemView())

    renderRouted('/items/:id', <ItemDetailPage />, '/items/202')

    await user.click(await screen.findByRole('button', { name: '认领并查看联系方式' }))

    expect(await screen.findByText('登录页桩')).toBeInTheDocument()
  })

  it('这一页在匿名时一个带鉴权的请求都不发', async () => {
    let detailCalls = 0
    server.use(
      http.get(`${BASE}/api/items/:id`, () => {
        detailCalls += 1
        return HttpResponse.json(ok(sampleItemView()))
      }),
      http.get(`${BASE}/api/auth/me`, () => HttpResponse.json(ok(sampleUser()))),
      http.post(`${BASE}/api/items/:id/unlock-contact`, () =>
        HttpResponse.json(ok({ contact: '微信 bbb', unlocked_at: '', already_unlocked: false })),
      ),
    )

    renderRouted('/items/:id', <ItemDetailPage />, '/items/202')
    await screen.findByRole('button', { name: '认领并查看联系方式' })

    // 只有 #15 一次；没有 token 就没有 #3，也没有 #21、没有 #20。
    expect(detailCalls).toBe(1)
  })
})

describe('登录但不是发帖人', () => {
  it('点认领才 POST #21，联系方式显示出来并附一句「不排他」的轻提示', async () => {
    const user = userEvent.setup()
    setToken('jwt.xiaoli')
    mockMe(sampleUser({ id: 7, nickname: '小李' }))
    mockDetail(sampleItemView())

    let unlockedCalled = 0
    server.use(
      http.post(`${BASE}/api/items/:id/unlock-contact`, () => {
        unlockedCalled += 1
        return HttpResponse.json(
          ok({ contact: '微信 bbb', unlocked_at: '2026-10-07T00:00:00Z', already_unlocked: false }),
        )
      }),
    )

    renderRouted('/items/:id', <ItemDetailPage />, '/items/202')

    await screen.findByText('捡到黑色长款钱包')
    // 这一行是整段测试的前提：请求必须还没发生过。
    expect(unlockedCalled).toBe(0)

    await user.click(screen.getByRole('button', { name: '认领并查看联系方式' }))

    await waitFor(() => expect(screen.getByText('微信 bbb')).toBeInTheDocument())
    expect(unlockedCalled).toBe(1)
    // 计划 §M7 要求的轻提示：认领不是排他锁定。
    expect(await screen.findByText(/不会阻止其他人联系发布者/)).toBeInTheDocument()
  })

  it('解锁失败是 ITEM_CLOSED 时把后端那句原因显示出来，联系方式不出现', async () => {
    const user = userEvent.setup()
    setToken('jwt.xiaoli')
    mockMe(sampleUser({ id: 7 }))
    mockDetail(sampleItemView())
    server.use(
      http.post(
        `${BASE}/api/items/:id/unlock-contact`,
        () =>
          HttpResponse.json(
            envelope('ITEM_CLOSED', '帖子已关闭或已删除，无法执行此操作', 409).body,
            { status: 409 },
          ),
        { once: true },
      ),
    )

    renderRouted('/items/:id', <ItemDetailPage />, '/items/202')

    await user.click(await screen.findByRole('button', { name: '认领并查看联系方式' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('帖子已关闭或已删除')
    expect(screen.queryByText('微信 bbb')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '认领并查看联系方式' })).toBeEnabled()
  })

  it('非本人非 admin 看不到匹配面板的入口（#20 会 403，所以入口根本不出现）', async () => {
    setToken('jwt.xiaoli')
    mockMe(sampleUser({ id: 7 }))
    mockDetail(sampleItemView({ author: { id: 8, nickname: '小王' } }))

    renderRouted('/items/:id', <ItemDetailPage />, '/items/202')

    await screen.findByText('捡到黑色长款钱包')
    expect(screen.queryByRole('button', { name: /现算一次匹配结果/ })).not.toBeInTheDocument()
  })
})

describe('归还确认（#23）的入口', () => {
  // 这一组断言的对象是**隐藏**：#23 后端不要求先解锁，所以技术上四个分支都能点进去，
  // 但点进去拿到的是 VALIDATION（lost 帖）、ITEM_CLOSED（closed/deleted）、RETURN_SELF（本人）。
  // 一个「点了必报错」的链接比没有链接更糟，所以判据要跟后端那三道门一模一样。
  it('解锁成功之后，联系方式下面给出「提交归还确认」这条链接', async () => {
    const user = userEvent.setup()
    setToken('jwt.xiaoli')
    mockMe(sampleUser({ id: 7 }))
    mockDetail(sampleItemView())
    server.use(
      http.post(`${BASE}/api/items/:id/unlock-contact`, () =>
        HttpResponse.json(
          ok({ contact: '微信 bbb', unlocked_at: '2026-10-07T00:00:00Z', already_unlocked: false }),
        ),
      ),
    )

    renderRouted('/items/:id', <ItemDetailPage />, '/items/202')

    await user.click(await screen.findByRole('button', { name: '认领并查看联系方式' }))

    const link = await screen.findByRole('link', { name: /提交归还确认/ })
    expect(link).toHaveAttribute('href', '/items/202/claim')
  })

  it('联系方式还锁着时不给这条链接（顺序是先联系上，后登记）', async () => {
    setToken('jwt.xiaoli')
    mockMe(sampleUser({ id: 7 }))
    mockDetail(sampleItemView())

    renderRouted('/items/:id', <ItemDetailPage />, '/items/202')

    await screen.findByText('捡到黑色长款钱包')
    expect(screen.queryByRole('link', { name: /提交归还确认/ })).not.toBeInTheDocument()
  })

  it('lost 帖就算联系方式公开也不给 —— #23 只认 found 帖，点了必吃 VALIDATION', async () => {
    setToken('jwt.xiaoli')
    mockMe(sampleUser({ id: 7 }))
    mockDetail(sampleItemView({ item_type: 'lost', title: '丢了一张校园卡', contact: '微信 aaa', contact_locked: false }))

    renderRouted('/items/:id', <ItemDetailPage />, '/items/202')

    await screen.findByText('微信 aaa')
    expect(screen.queryByRole('link', { name: /提交归还确认/ })).not.toBeInTheDocument()
  })

  it('帖子已经 closed 就不给（之前解锁过的人再进来就是这一格）', async () => {
    setToken('jwt.xiaoli')
    mockMe(sampleUser({ id: 7 }))
    mockDetail(sampleItemView({ status: 'closed', contact: '微信 bbb', contact_locked: false }))

    renderRouted('/items/:id', <ItemDetailPage />, '/items/202')

    await screen.findByText('微信 bbb')
    expect(screen.queryByRole('link', { name: /提交归还确认/ })).not.toBeInTheDocument()
  })

  it('发帖人本人看不到这条链接（#23 给他的是 RETURN_SELF）', async () => {
    setToken('jwt.xiaowan')
    mockMe(sampleUser({ id: 8, username: 'xiaowan', nickname: '小王' }))
    mockDetail(sampleItemView({ author: { id: 8, nickname: '小王' } }))

    renderRouted('/items/:id', <ItemDetailPage />, '/items/202')

    await screen.findByText('捡到黑色长款钱包')
    expect(screen.queryByRole('link', { name: /提交归还确认/ })).not.toBeInTheDocument()
    // 对照：同一页上属于作者的那套操作是在的，说明这条不是「整页都没渲染」造成的假绿。
    expect(screen.getByRole('button', { name: '标记为已归还' })).toBeInTheDocument()
  })
})

describe('发帖人本人', () => {
  it('自己的 found 帖联系方式直接可见，没有认领按钮', async () => {
    setToken('jwt.xiaowang')
    mockMe(sampleUser({ id: 8, nickname: '小王' }))
    mockDetail(sampleItemView({ author: { id: 8, nickname: '小王' }, contact: '微信 bbb', contact_locked: false }))

    renderRouted('/items/:id', <ItemDetailPage />, '/items/202')

    expect(await screen.findByText('微信 bbb')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /认领并查看/ })).not.toBeInTheDocument()
  })

  it('匹配面板把权重、原始得分和加权三列摊开，四路信号加起来等于总分', async () => {
    const user = userEvent.setup()
    setToken('jwt.xiaowang')
    mockMe(sampleUser({ id: 8 }))
    mockDetail(sampleItemView({ author: { id: 8, nickname: '小王' }, contact: '微信 bbb', contact_locked: false }))

    // 分数全部按 matcher 的公式自己算出来，不是随手写的数：
    //   文本 0.5×标题 0.6 + 0.5×描述 0.4 = 0.5000（textScore 就是两个 dice 各占一半）
    //   地点走 detail_text 那一档 = 0.4（文字折扣）× 0.6 = 0.2400
    //   总分 0.35×1 + 0.30×0.5000 + 0.20×1 + 0.15×0.2400 = 0.7360
    // 四格的加权互不相同，所以下面的 getByText 每条都只可能落在它自己那一格上。
    const res: MatchResult = {
      tier: 2,
      notice: '这条帖子选了「其他」，地点无法按叶子比较，只能走宽松匹配。',
      list: [
        {
          item: sampleSummary({ id: 303, item_type: 'lost', title: '我的黑色钱包丢了' }),
          score: 0.736,
          breakdown: {
            score: 0.736,
            tier: 2,
            signals: {
              category: { weight: 0.35, score: 1, same_leaf: true },
              text: { weight: 0.3, score: 0.5, title_dice: 0.6, desc_dice: 0.4 },
              time: { weight: 0.2, score: 1, in_loss_window: true, days_after_lost_at: 0 },
              location: { weight: 0.15, score: 0.24, matched_by: 'detail_text' },
            },
          },
        },
      ],
    }
    server.use(http.get(`${BASE}/api/items/:id/matches`, () => HttpResponse.json(ok(res))))

    renderRouted('/items/:id', <ItemDetailPage />, '/items/202')

    await user.click(await screen.findByRole('button', { name: /现算一次匹配结果/ }))

    expect(await screen.findByText('我的黑色钱包丢了')).toBeInTheDocument()
    // notice 是 data 里的字段，显示它不是依赖 message 做分支。
    expect(screen.getByText(/只能走宽松匹配/)).toBeInTheDocument()

    // 三列都在（这是「调试器」而不是「百分比」）。加权那一列是验算的落点：
    // 0.35×1 + 0.30×0.5000 + 0.20×1 + 0.15×0.2400 = 0.3500 + 0.1500 + 0.2000 + 0.0360 = 0.7360，
    // 和后端返回的总分对上（夹具就是按这个和配平的，所以这条断言真的在验算而不是摆设）。
    // 「加权」这一列是前端把后端给的两个数**相乘**显示出来 —— 只有乘法，没有第二个公式；
    // 总分那一列则一律用后端的，不自己相加。
    expect(screen.getByRole('columnheader', { name: '权重' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: '加权' })).toBeInTheDocument()
    expect(screen.getByText('0.35')).toBeInTheDocument()
    expect(screen.getByText('0.5000')).toBeInTheDocument()
    expect(screen.getByText('0.3500')).toBeInTheDocument()
    expect(screen.getByText('0.1500')).toBeInTheDocument()
    expect(screen.getByText('0.2000')).toBeInTheDocument()
    expect(screen.getByText('0.0360')).toBeInTheDocument()
    expect(screen.getByText(/总分 0\.7360（Tier 2）/)).toBeInTheDocument()
    expect(screen.getByText('靠「具体位置」那段文字匹配上')).toBeInTheDocument()
  })

  it('说明列只说数据支持得了的话（时间与地点两处 0 分陷阱）', async () => {
    const user = userEvent.setup()
    setToken('jwt.xiaowang')
    mockMe(sampleUser({ id: 8 }))
    mockDetail(sampleItemView({ author: { id: 8, nickname: '小王' }, contact: '微信 bbb', contact_locked: false }))

    // 四条候选只差后端返回的字段，覆盖两个「0 会被读成反话」的分支。
    // 时间那条是这条测试的存在理由：后端在「捡得早于 last_seen_at」和「只晚了不到一天」
    // 两种相反的情况下都会回 days_after_lost_at=0 + in_loss_window=false，
    // 所以那句「晚于丢失时间 0 天」会把一个可能还没丢的东西写成迟到了三天。
    // 地点那条同理：matched_by=detail_text 只代表「字典层级没比上、退到比文字」，
    // 分数 0 时它一个字都没重合，说「靠那段文字匹配上」是假话。
    const hit = (id: number, title: string, time: TimeSignal, location?: LocationSignal): MatchHit => ({
      item: sampleSummary({ id, item_type: 'lost', title }),
      score: 0.8,
      breakdown: {
        score: 0.8,
        tier: 1,
        signals: {
          category: { weight: 0.45, score: 1, same_leaf: true },
          text: { weight: 0.4, score: 0.5, title_dice: 0.5, desc_dice: 0.5 },
          time,
          ...(location ? { location } : {}),
        },
      },
    })

    const res: MatchResult = {
      tier: 1,
      list: [
        hit(301, '窗口内那条', { weight: 0.15, score: 1, in_loss_window: true, days_after_lost_at: 0 }),
        hit(302, '晚了三天那条', { weight: 0.15, score: 0.7857, in_loss_window: false, days_after_lost_at: 3 }),
        hit(303, '方向不明那条', { weight: 0.15, score: 0.3, in_loss_window: false, days_after_lost_at: 0 }),
        hit(304, '地点没重合那条', { weight: 0.15, score: 1, in_loss_window: true, days_after_lost_at: 0 }, {
          weight: 0.15,
          score: 0,
          matched_by: 'detail_text',
        }),
      ],
    }
    server.use(http.get(`${BASE}/api/items/:id/matches`, () => HttpResponse.json(ok(res))))

    renderRouted('/items/:id', <ItemDetailPage />, '/items/202')
    await user.click(await screen.findByRole('button', { name: /现算一次匹配结果/ }))
    await screen.findByText('窗口内那条')

    // 按「哪一条候选」分块断言，而不是全文搜索：四条里有两条的时间措辞是同一句，
    // 全文 getByText 只会因为「找到多个」而红，那样这条测试就只是在测夹具了。
    const row = (title: string) => {
      const li = screen.getByText(title).closest('li')
      expect(li, `列表里没有这条候选：${title}`).not.toBeNull()
      return within(li!)
    }

    expect(row('窗口内那条').getByText('落在丢失窗口内')).toBeInTheDocument()
    expect(row('晚了三天那条').getByText('晚于丢失时间 3 天')).toBeInTheDocument()
    expect(row('方向不明那条').getByText('没落在丢失窗口内')).toBeInTheDocument()
    expect(screen.queryByText('晚于丢失时间 0 天')).not.toBeInTheDocument()

    expect(row('地点没重合那条').getByText('地点层级比不上，「具体位置」那段文字也没重合')).toBeInTheDocument()
    expect(screen.queryByText('靠「具体位置」那段文字匹配上')).not.toBeInTheDocument()

    // 展示线低于通知线是后端刻意设计的（config.go 校验了两条线不能写反），
    // 所以这份列表不等于「已通知名单」。这句话不许写死数字，线是 .env 里的可调参数。
    expect(screen.getByText(/不是「已经通知过」的名单/)).toBeInTheDocument()
  })
})

describe('举报（入口要弱，文案不许诺后果）', () => {
  it('弹层里理由没选时提交是禁用的，选了之后提交成功只说「已记录，管理员会看到」', async () => {
    const user = userEvent.setup()
    setToken('jwt.xiaoli')
    mockMe(sampleUser({ id: 7 }))
    mockDetail(sampleItemView())
    server.use(
      http.post(`${BASE}/api/items/:id/report`, () =>
        HttpResponse.json(ok({ id: 1, status: 'open', created_at: '2026-10-07T00:00:00Z' })),
      ),
    )

    renderRouted('/items/:id', <ItemDetailPage />, '/items/202')

    await user.click(await screen.findByRole('button', { name: '举报' }))

    const dialog = await screen.findByRole('dialog', { name: '举报这条帖子' })
    const submit = screen.getByRole('button', { name: '提交举报' })
    expect(submit).toBeDisabled()

    await user.click(within(dialog).getByLabelText('刷屏广告'))
    expect(submit).toBeEnabled()

    await user.click(submit)

    const done = await screen.findByText('已记录，管理员会看到。')
    expect(done).toBeInTheDocument()
    // 这句话是硬判据：后端一条 INSERT、零自动后果，前端承诺了就是骗人。
    expect(dialog.textContent).not.toMatch(/下架|处理|尽快|封/)
  })

  it('同一个人重复举报走 REPORT_DUPLICATE 专属文案，而不是当成普通失败', async () => {
    const user = userEvent.setup()
    setToken('jwt.xiaoli')
    mockMe(sampleUser({ id: 7 }))
    mockDetail(sampleItemView())
    server.use(
      http.post(
        `${BASE}/api/items/:id/report`,
        () =>
          HttpResponse.json(envelope('REPORT_DUPLICATE', '已经举报过了', 409).body, { status: 409 }),
        { once: true },
      ),
    )

    renderRouted('/items/:id', <ItemDetailPage />, '/items/202')

    await user.click(await screen.findByRole('button', { name: '举报' }))
    const dialog = await screen.findByRole('dialog', { name: '举报这条帖子' })
    await user.click(within(dialog).getByLabelText('泄露他人隐私'))
    await user.click(screen.getByRole('button', { name: '提交举报' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('同一人对同一帖只留一条待处理举报')
    // 重复举报不该被显示成「已记录」，否则用户以为报了两次、admin 那边只有一条。
    expect(screen.queryByText('已记录，管理员会看到。')).not.toBeInTheDocument()
  })
})

describe('作者操作（#16 入口 / #18 开关 / #17 软删）', () => {
  /** 自己的、联系方式本来就可见的一条拾物帖（作者 id 8）。 */
  const mine = (overrides: Parameters<typeof sampleItemView>[0] = {}) =>
    sampleItemView({ author: { id: 8, nickname: '小王' }, contact: '微信 bbb', contact_locked: false, ...overrides })

  it('这一栏只给发帖人，admin 也不给', async () => {
    // #18 后端写的就是「仅帖主，admin 也不行」：关一条帖子是「东西还回来了」这个社区表态，
    // admin 能销毁内容但制造不出归属。所以这里连按钮都不出现，而不是点下去吃 FORBIDDEN。
    setToken('jwt.admin')
    mockMe(sampleUser({ id: 9, role: 'admin' }))
    mockDetail(mine())

    renderRouted('/items/:id', <ItemDetailPage />, '/items/202')

    await screen.findByText('捡到黑色长款钱包')
    expect(screen.queryByRole('button', { name: '标记为已归还' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '删除这条帖子' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '修改' })).not.toBeInTheDocument()
  })

  it('#18 发的是取反后的那一个状态，标题跟着库里的 status 走', async () => {
    const user = userEvent.setup()
    setToken('jwt.xiaowang')
    mockMe(sampleUser({ id: 8 }))
    mockDetail(mine())
    const bodies: Array<Record<string, unknown>> = []
    server.use(
      http.patch(`${BASE}/api/items/:id/status`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        bodies.push(body)
        return HttpResponse.json(ok({ id: 202, status: body.status }))
      }),
    )

    renderRouted('/items/:id', <ItemDetailPage />, '/items/202')

    await user.click(await screen.findByRole('button', { name: '标记为已归还' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ status: 'closed' })
    expect(await screen.findByText('已归还')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '修改' })).toHaveAttribute('href', '/items/202/edit')

    // 再点一次方向反过来。后端对「已经是这个状态」幂等返回成功，
    // 所以前端不需要自己判重，只需要每次按当前 status 取反、然后按响应更新那一个字段。
    await user.click(screen.getByRole('button', { name: '重新开放' }))
    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[1]).toEqual({ status: 'open' })
    expect(screen.queryByText('已归还')).not.toBeInTheDocument()
  })

  it('#17 是两步：第一个点击只出那句「没有撤销」，第二个才发 DELETE', async () => {
    const user = userEvent.setup()
    setToken('jwt.xiaowang')
    mockMe(sampleUser({ id: 8 }))
    mockDetail(mine())
    let deletes = 0
    server.use(
      http.delete(`${BASE}/api/items/:id`, () => {
        deletes += 1
        return HttpResponse.json(ok(null))
      }),
    )

    renderRouted('/items/:id', <ItemDetailPage />, '/items/202')

    await user.click(await screen.findByRole('button', { name: '删除这条帖子' }))
    // 这一条是这一屏的存亡线：软删之后广场和搜索都拿不到它，而普通用户没有恢复端点
    //（那是 admin 的 #44），所以「点一下就删」是不允许的交互。
    expect(deletes).toBe(0)
    expect(screen.getByText(/没有撤销/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(deletes).toBe(1))
    // 删完不留在原地：那条详情页的 status 已经是 deleted，停在这儿只会让人以为没删掉。
    expect(await screen.findByText('广场页桩')).toBeInTheDocument()
  })

  it('已经不在架的帖子不再给任何操作入口', async () => {
    setToken('jwt.xiaowang')
    mockMe(sampleUser({ id: 8 }))
    mockDetail(mine({ status: 'deleted' }))

    renderRouted('/items/:id', <ItemDetailPage />, '/items/202')

    await screen.findByText('捡到黑色长款钱包')
    // #16 和 #18 在这种状态上直接返回 ITEM_CLOSED，所以按钮出现即注定失败。
    expect(screen.queryByText('这条是你发的')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /已归还|重新开放/ })).not.toBeInTheDocument()
  })

  it('但「谁看过联系方式」的入口在架不架都给：#22 读的是记录，不是操作权限', async () => {
    setToken('jwt.xiaowang')
    mockMe(sampleUser({ id: 8 }))
    mockDetail(mine())

    renderRouted('/items/:id', <ItemDetailPage />, '/items/202')

    await screen.findByText('捡到黑色长款钱包')
    expect(screen.getByRole('link', { name: '查看谁认领并看过这条联系方式' })).toHaveAttribute(
      'href',
      '/items/202/unlockers',
    )
  })

  it('被下架之后这个入口依然在：后端说那是治理场景里最需要的证据', async () => {
    setToken('jwt.xiaowang')
    mockMe(sampleUser({ id: 8 }))
    // 上面那条测试刚证明「操作栏整块消失」，这一条证明同一屏上**读**的入口没跟着消失。
    // 后端 #22 的注释写得很直接：作者被下架之后仍然有权知道在被下架之前谁来看过。
    mockDetail(mine({ status: 'deleted' }))

    renderRouted('/items/:id', <ItemDetailPage />, '/items/202')

    await screen.findByText('捡到黑色长款钱包')
    expect(screen.queryByText('这条是你发的')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: '查看谁认领并看过这条联系方式' })).toBeInTheDocument()
  })

  it('失物帖没有这个入口：#21 对 lost 返回 VALIDATION，那种帖的名单永远是空的', async () => {
    setToken('jwt.xiaowang')
    mockMe(sampleUser({ id: 8 }))
    mockDetail(mine({ item_type: 'lost', contact: '微信 bbb' }))

    renderRouted('/items/:id', <ItemDetailPage />, '/items/202')

    await screen.findByText('捡到黑色长款钱包')
    expect(screen.queryByRole('link', { name: '查看谁认领并看过这条联系方式' })).not.toBeInTheDocument()
  })
})
