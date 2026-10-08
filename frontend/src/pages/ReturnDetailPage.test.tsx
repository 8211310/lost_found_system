// src/pages/ReturnDetailPage.test.tsx —— #24 + #25/#26/#27：归属由人产生，界面必须把「谁」演出来。
//
// 这一页要钉住的是五件事，全都来自「不读源码就会写错」的地方：
//   ① 键只给发帖人：admin 读得到全部事实但一个键都按不了，而且页面上要有一句解释，
//      不然管理员会以为是自己没权限的 bug（#25/#26 是全系统唯一 admin 也不行的两条）。
//   ② confirm 的备注可空、reject 的备注必填 —— 这条不对称在后端是刻意的，
//      落到界面上就是「拒绝」在空白时被禁用，而不是点下去再收一句 VALIDATION。
//   ③ 长度按字（rune）数算：JS 的 .length 把 emoji 数成 2，直接用它前端会在人没到限时先拦下来。
//   ④ 每次写完都重新读 #24，不拿写响应拼界面：三条写端点回的键各不相同
//      （#25 有 credit_delta、#26 没有、#27 连 reviewed_at 都不给）。
//   ⑤ review_kind 两种值不许显示成同一句「已处理」：admin_data_fix 没有任何社区含义。
import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import ReturnDetailPage from './ReturnDetailPage'
import { renderRouted } from '../test/render'
import { server } from '../test/server'
import { BASE, envelope, ok, sampleReturnDetail, sampleUser } from '../test/helpers'
import { setToken } from '../api/session'
import type { ReturnDetailView } from '../api/types'

/** 装上 #3（默认身份是**发帖人**小王 id=8）和 #24/#25/#26/#27，记下请求体和 GET 次数。
 *  要换身份的用例在后面再 server.use 一次 /api/auth/me —— 后加的 handler 优先。 */
function mockFlow(detail: ReturnDetailView | (() => ReturnDetailView)) {
  const seen = {
    getTimes: 0,
    confirmBody: null as unknown,
    rejectBody: null as unknown,
    cancelBody: null as unknown,
  }
  setToken('jwt.me')
  const resolve = () => (typeof detail === 'function' ? detail() : detail)
  server.use(
    http.get(`${BASE}/api/auth/me`, () => HttpResponse.json(ok(sampleUser({ id: 8, nickname: '小王' })))),
    http.get(`${BASE}/api/returns/:id`, () => {
      seen.getTimes += 1
      return HttpResponse.json(ok(resolve()))
    }),
    http.post(`${BASE}/api/returns/:id/confirm`, async (c) => {
      seen.confirmBody = await c.request.json()
      return HttpResponse.json(ok({ id: 1, status: 'confirmed', reviewed_at: '', credit_delta: 10 }))
    }),
    http.post(`${BASE}/api/returns/:id/reject`, async (c) => {
      seen.rejectBody = await c.request.json()
      return HttpResponse.json(ok({ id: 1, status: 'rejected', reviewed_at: '' }))
    }),
    http.post(`${BASE}/api/returns/:id/cancel`, async (c) => {
      // #27 后端连 body 都不读，所以这里要能看出前端**没有**偷偷塞一个 owner_note。
      const text = await c.request.text()
      seen.cancelBody = text === '' ? null : text
      return HttpResponse.json(ok({ id: 1, status: 'cancelled' }))
    }),
  )
  return seen
}

function as(overrides: Parameters<typeof sampleUser>[0]) {
  server.use(http.get(`${BASE}/api/auth/me`, () => HttpResponse.json(ok(sampleUser(overrides)))))
}

function page(at = '/returns/501') {
  renderRouted('/returns/:id', <ReturnDetailPage />, at)
}

const NOTE_FIELD = /给你的答复留一句话/

describe('只有发帖人有键', () => {
  it('发帖人看到确认和拒绝，还有那句写清楚两者后果不同的话', async () => {
    mockFlow(sampleReturnDetail())

    page()
    await screen.findByText('还没有人给出答复。')

    expect(screen.getByRole('button', { name: '确认这一条' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '拒绝' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '撤销我这次提交' })).not.toBeInTheDocument()
    // 拒绝什么都不动、确认会同时关帖和加分 —— 两句都得在这儿，不然两个按钮看着一样重。
    expect(screen.getByText(/拒绝只是记下你这个答复/)).toBeInTheDocument()
    expect(screen.getByText(/到 200 封顶就不再加/)).toBeInTheDocument()
  })

  it('管理员读得到全部事实，但一个键都按不了，而且页面上有一句解释为什么', async () => {
    mockFlow(sampleReturnDetail())
    as({ id: 1, role: 'admin' })

    page()
    expect(await screen.findByText('小李')).toBeInTheDocument()
    expect(screen.getByAltText('提交人上传的凭证')).toBeInTheDocument()

    expect(screen.queryByRole('button', { name: /确认这一条|拒绝|撤销/ })).not.toBeInTheDocument()
    expect(screen.getByText(/管理员也一样不行/)).toBeInTheDocument()
  })

  it('提交人只有撤销自己那一次的键，没有替对方判断的键', async () => {
    mockFlow(sampleReturnDetail())
    as({ id: 12 })

    page()
    await screen.findByText('还没有人给出答复。')

    expect(screen.getByRole('button', { name: '撤销我这次提交' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: '确认这一条' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '拒绝' })).not.toBeInTheDocument()
    expect(screen.getByText(/撤销只改这一行记录，不会通知对方/)).toBeInTheDocument()
  })
})

describe('确认与拒绝的备注是不对称的', () => {
  it('空白按不了拒绝、确认照样能按；纯空白也一样按不了', async () => {
    const user = userEvent.setup()
    mockFlow(sampleReturnDetail())

    page()
    await screen.findByText('还没有人给出答复。')

    const note = screen.getByLabelText(NOTE_FIELD)
    expect(screen.getByRole('button', { name: '确认这一条' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '拒绝' })).toBeDisabled()

    await user.type(note, '等')
    expect(screen.getByRole('button', { name: '拒绝' })).toBeEnabled()

    // 后端 normalizeOwnerNote(raw, true) 是 trim 之后判空的，所以三个空格同样按不了。
    await user.clear(note)
    await user.type(note, '   ')
    expect(screen.getByRole('button', { name: '拒绝' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '确认这一条' })).toBeEnabled()
  })

  it('拒绝发出去的是 trim 后的那句话', async () => {
    const user = userEvent.setup()
    const seen = mockFlow(sampleReturnDetail())

    page()
    await screen.findByText('还没有人给出答复。')

    await user.type(screen.getByLabelText(NOTE_FIELD), '  卡套是灰色的  ')
    await user.click(screen.getByRole('button', { name: '拒绝' }))

    await screen.findByText('你拒绝了这一条。')
    expect(seen.rejectBody).toEqual({ owner_note: '卡套是灰色的' })
  })

  it('确认不带话时发的是空串，而不是不发这个键', async () => {
    const user = userEvent.setup()
    const seen = mockFlow(sampleReturnDetail())

    page()
    await screen.findByText('还没有人给出答复。')

    await user.click(screen.getByRole('button', { name: '确认这一条' }))
    // #25 用的是 bindJSONOptional：缺键、空串、空 body 都合法。这里统一发空串，
    // 让「没写话」是一件明确的事，而不是一个没传的参数。
    expect(seen.confirmBody).toEqual({ owner_note: '' })
  })

  it('长度按字算：499 个 emoji 是 499 个字，不是 998', async () => {
    mockFlow(sampleReturnDetail())

    page()
    await screen.findByText('还没有人给出答复。')

    const note = screen.getByLabelText(NOTE_FIELD)
    // 一次 change 事件填进去而不是 user.type：500 个字符逐个敲会让这条测试变成计时器。
    fireEvent.change(note, { target: { value: '🙂'.repeat(499) } })

    // 用 .length 的话这里会显示 998 / 500，而按字算是 499 —— 前端拿 .length 就会在人没到限时先拦下来。
    expect(screen.getByText('499 / 500')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '拒绝' })).toBeEnabled()

    // 超限那一条用纯汉字复现：emoji 那个串再往下打会撞上 textarea 的 maxLength（那是另一件事），
    // 而这里要验的只是「数到 501 就两个键都按不了」。
    fireEvent.change(note, { target: { value: '归'.repeat(501) } })
    expect(screen.getByText('501 / 500')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '拒绝' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '确认这一条' })).toBeDisabled()
  })
})

describe('写完重新读，不拿写响应拼界面', () => {
  it('确认之后重读 #24，界面跟着后端那版走', async () => {
    const user = userEvent.setup()
    let current = sampleReturnDetail()
    const seen = mockFlow(() => current)

    page()
    await screen.findByText('还没有人给出答复。')
    expect(seen.getTimes).toBe(1)

    current = sampleReturnDetail({
      status: 'confirmed',
      reviewer_id: 8,
      review_kind: 'owner',
      reviewed_at: '2026-10-08T01:00:00Z',
    })
    await user.click(screen.getByRole('button', { name: '确认这一条' }))

    await screen.findByText('发帖人确认了这一条。')
    expect(screen.getByText('你确认了这一条。')).toBeInTheDocument()
    // 第二次读真的发了请求：如果界面是拿 #25 的响应拼的，就永远验不到后端实际存了什么。
    expect(seen.getTimes).toBe(2)
    expect(screen.getByText('发帖人本人（编号 8）')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /确认这一条|拒绝/ })).not.toBeInTheDocument()
  })

  it('#27 的响应里没有 reviewed_at，所以撤销之后那个字段只能由重新读决定', async () => {
    const user = userEvent.setup()
    let current = sampleReturnDetail()
    const seen = mockFlow(() => current)
    as({ id: 12 })

    page()
    await screen.findByText('还没有人给出答复。')
    expect(screen.queryByText('定下来的时间')).not.toBeInTheDocument()

    current = sampleReturnDetail({
      status: 'cancelled',
      reviewer_id: 12,
      review_kind: 'owner',
      reviewed_at: '2026-10-08T01:00:00Z',
    })
    await user.click(screen.getByRole('button', { name: '撤销我这次提交' }))

    await screen.findByText('提交人撤销了这一条。')
    expect(seen.getTimes).toBe(2)
    // 这一句同时证明两件事：处理时间是重新读出来的，而 #27 一个字节都没发。
    expect(screen.getByText('定下来的时间')).toBeInTheDocument()
    expect(seen.cancelBody).toBeNull()
  })

  it('写失败时显示这句 code 对应的人话和请求编号，状态句不跟着改口', async () => {
    const user = userEvent.setup()
    mockFlow(sampleReturnDetail())
    server.use(
      http.post(`${BASE}/api/returns/:id/confirm`, () =>
        HttpResponse.json(envelope('RETURN_ILLEGAL_TRANSITION', '这条记录已经处理过了', 409).body, { status: 409 }),
      ),
    )

    page()
    await screen.findByText('还没有人给出答复。')

    await user.click(screen.getByRole('button', { name: '确认这一条' }))
    const alert = await screen.findByRole('alert')
    // 断的是 errorText 表里那句、不是后端 message：这一族的状态冲突前端自己会说话，
    // 后端改措辞时页面不该跟着变（而分支仍然只写在 code 上）。
    expect(alert).toHaveTextContent('这一条的状态已经变了，页面上显示的是最新的那一版。')
    expect(alert).toHaveTextContent('test-req-return_illegal_transition')
    expect(screen.getByText('还没有人给出答复。')).toBeInTheDocument()
  })

  it('按下之后记录被人删了：重读拿到 NOT_FOUND，界面承认不存在而不是留着旧结论', async () => {
    const user = userEvent.setup()
    let current = sampleReturnDetail()
    mockFlow(() => current)
    server.use(
      http.post(`${BASE}/api/returns/:id/confirm`, () =>
        HttpResponse.json(ok({ id: 1, status: 'confirmed', reviewed_at: '', credit_delta: 10 })),
      ),
      http.get(`${BASE}/api/returns/:id`, () =>
        current.status === 'confirmed'
          ? HttpResponse.json(envelope('NOT_FOUND', '记录不存在', 404).body, { status: 404 })
          : HttpResponse.json(ok(current)),
      ),
    )

    page()
    await screen.findByText('还没有人给出答复。')

    current = sampleReturnDetail({ status: 'confirmed' })
    await user.click(screen.getByRole('button', { name: '确认这一条' }))

    expect(await screen.findByRole('heading', { name: '这条记录不存在' })).toBeInTheDocument()
  })
})

describe('两种 review_kind 不是同一句话', () => {
  it('admin_data_fix 明说管理员改过这行，且不代表当事人做过这个判断', async () => {
    mockFlow(
      sampleReturnDetail({
        status: 'confirmed',
        reviewer_id: 8,
        review_kind: 'admin_data_fix',
        reviewed_at: '2026-10-08T01:00:00Z',
      }),
    )

    page()
    expect(await screen.findByText(/管理员改过这行数据/)).toBeInTheDocument()
    expect(screen.getByText(/它没有社区含义/)).toBeInTheDocument()
    // 「发帖人本人」不许同时出现：那等于把「管理员改了库」说成「发帖人同意了」。
    expect(screen.queryByText(/发帖人本人/)).not.toBeInTheDocument()
  })

  it('pending 时既没有处理时间也没有 review_kind，整块不出现而不是显示一个空的', async () => {
    mockFlow(sampleReturnDetail({ reviewed_at: '' }))

    page()
    await screen.findByText('还没有人给出答复。')
    expect(screen.queryByText('定下来的时间')).not.toBeInTheDocument()
    expect(screen.queryByText('这一行是谁给的')).not.toBeInTheDocument()
  })
})

describe('这一页读得到的那些事实', () => {
  it('提交人的信用分显示出来，真实姓名不显示（那条路上根本没有这一列）', async () => {
    mockFlow(sampleReturnDetail())

    page()
    await screen.findByText('还没有人给出答复。')

    expect(screen.getByText('（信用分 103）')).toBeInTheDocument()
    expect(screen.queryByText('李雷')).not.toBeInTheDocument()
  })

  it('帖子被删了照样读得到，状态写的是「已经不在架上了」而不是美化过的「已关闭」', async () => {
    mockFlow(sampleReturnDetail({ item: { ...sampleReturnDetail().item, status: 'deleted' } }))

    page()
    await screen.findByText('还没有人给出答复。')

    expect(screen.getByText('已经不在架上了')).toBeInTheDocument()
    expect(screen.queryByText('已关闭')).not.toBeInTheDocument()
  })

  it('没有凭证图时明说「没有图」，而不是画一个破图', async () => {
    mockFlow(sampleReturnDetail({ proof_image_url: '' }))

    page()
    await screen.findByText('还没有人给出答复。')

    expect(screen.getByText('没有图')).toBeInTheDocument()
    expect(screen.queryByAltText('提交人上传的凭证')).not.toBeInTheDocument()
  })
})

describe('读不到的时候', () => {
  it('外人拿到 FORBIDDEN，看到的是「看不了这条记录」而不是「不存在」', async () => {
    mockFlow(sampleReturnDetail())
    as({ id: 99 })
    server.use(
      http.get(
        `${BASE}/api/returns/:id`,
        () => HttpResponse.json(envelope('FORBIDDEN', '你不是这条记录的当事人', 403).body, { status: 403 }),
      ),
    )

    page()
    expect(await screen.findByRole('heading', { name: '看不了这条记录' })).toBeInTheDocument()
    // FORBIDDEN 在 errorText 表里，所以这里显示的是表里那句而不是后端 message。
    // 两条路的区别是刻意的：能被前端解释的 code 前端解释，解释不了的（VALIDATION）才转述后端。
    expect(screen.getByRole('alert')).toHaveTextContent('没有权限执行这个操作')
    expect(screen.queryByRole('heading', { name: '这条记录不存在' })).not.toBeInTheDocument()
  })

  it('NOT_FOUND 单独一块，并说明记录可能被删过', async () => {
    mockFlow(sampleReturnDetail())
    as({ id: 99 })
    server.use(
      http.get(
        `${BASE}/api/returns/:id`,
        () => HttpResponse.json(envelope('NOT_FOUND', '记录不存在', 404).body, { status: 404 }),
      ),
    )

    page()
    expect(await screen.findByRole('heading', { name: '这条记录不存在' })).toBeInTheDocument()
    expect(screen.getByText(/也可能那条已经被删掉/)).toBeInTheDocument()
  })
})

describe('文案纪律', () => {
  it('这一页不出现后端那张禁词表上的五个词', async () => {
    mockFlow(
      sampleReturnDetail({
        status: 'confirmed',
        reviewer_id: 8,
        review_kind: 'owner',
        reviewed_at: '2026-10-08T01:00:00Z',
      }),
    )

    page()
    await screen.findByText('发帖人确认了这一条。')

    // 后端 TestNoticeCopyMakesNoPlatformPromise 用这张表钉通知文案；
    // 这一页是「某人做了某事」最容易被说成「系统认定了归属」的地方，所以同一条约束管到这里。
    const text = document.body.textContent ?? ''
    for (const banned of ['归还成功', '已归还给你', '已关闭', '这就是', '判定']) {
      expect(text, `出现了禁词：${banned}`).not.toContain(banned)
    }
  })
})
