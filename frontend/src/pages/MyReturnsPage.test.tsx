// src/pages/MyReturnsPage.test.tsx —— #28 / #29：这一页的存在理由是「同一枚状态要读成两句话」。
//
// 后端返回的 status 是英文枚举，它对「谁做的这个判断」是沉默的 —— 因为同一个 confirmed
// 在提交人箱子里意思是**对方**确认了，在收件人箱子里意思是**我**确认了。
// 所以带视角完全是显示层的活；写错成中立的「已确认」，这一页就退化成一份看不出主客的日志。
//
// 另一半要钉的是**列表里没有的**东西：message、凭证图、提交人都不在 #28/#29 的响应里
// （后端明写「列表是索引，详情才是判断现场」），所以这里不该有确认/拒绝按钮，
// 也不该有任何「快速看一眼证据」的入口。
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import MyReturnsPage from './MyReturnsPage'
import { renderRouted } from '../test/render'
import { server } from '../test/server'
import {
  BASE,
  envelope,
  ok,
  samplePage,
  sampleReturnEntry,
  sampleSummary,
  sampleUser,
} from '../test/helpers'
import { setToken } from '../api/session'
import type { Page, ReturnEntry, ReturnStatus } from '../api/types'

/** 一行记录。标题必须各条不同（用 title 认行），因为四行如果同名，
 *  「第几行的状态是什么」就只能靠 DOM 顺序猜，而排序是后端的事。 */
function entry(status: ReturnStatus, title: string, id: number): ReturnEntry {
  return sampleReturnEntry({
    id,
    status,
    item: sampleSummary({ id: 900 + id, item_type: 'found', title, category_name: '衣物箱包', author_name: '小王' }),
  })
}

const FOUR: ReturnEntry[] = [
  entry('pending', '等处理的钱包', 1),
  entry('confirmed', '确认过的钥匙', 2),
  entry('rejected', '拒绝过的校园卡', 3),
  entry('cancelled', '撤销过的雨伞', 4),
]

/** 两个箱子各自记下最后一次请求的 URL；默认 submitted 那箱是空的，
 *  需要它也有数据的用例把第二个参数传进来。 */
function mockBoxes(received: Page<ReturnEntry>, submitted: Page<ReturnEntry> = samplePage<ReturnEntry>([])) {
  const seen: { received: string; submitted: string } = { received: '', submitted: '' }
  setToken('jwt.me')
  server.use(
    http.get(`${BASE}/api/auth/me`, () => HttpResponse.json(ok(sampleUser({ id: 7 })))),
    http.get(`${BASE}/api/my/returns/received`, (c) => {
      seen.received = c.request.url
      return HttpResponse.json(ok(received))
    }),
    http.get(`${BASE}/api/my/returns/submitted`, (c) => {
      seen.submitted = c.request.url
      return HttpResponse.json(ok(submitted))
    }),
  )
  return seen
}

function rowOf(title: string): HTMLElement {
  return screen.getByText(title).closest('li')!
}

function stateOf(title: string): string {
  // 按 class 取而不是 getByRole：那个色块是个 span，没有语义角色，
  // 给它加 role="status" 反而会让读屏把每一行的状态都当成一次 live region 播报。
  return rowOf(title).querySelector('.ret-state')!.textContent!
}

describe('同一枚状态在两个箱子里是两句话', () => {
  it('我收到的：等你处理 / 你确认了 / 你拒绝了 / 对方撤销了', async () => {
    mockBoxes(samplePage(FOUR))

    renderRouted('/me/returns', <MyReturnsPage />, '/me/returns')
    await screen.findByText('等处理的钱包')

    expect(stateOf('等处理的钱包')).toBe('等你处理')
    expect(stateOf('确认过的钥匙')).toBe('你确认了')
    expect(stateOf('拒绝过的校园卡')).toBe('你拒绝了')
    expect(stateOf('撤销过的雨伞')).toBe('对方撤销了')

    // 去掉主语的写法不许出现在状态色块上。判据范围刻意收窄到 .ret-state：
    // 上面那个筛选下拉里 legitimately 写着「已确认」—— 那是**发给后端的枚举名**，
    // 不是给人看的那句结论，两者在 UI 上本来就该长得不一样。
    const states = Array.from(document.querySelectorAll('.ret-state'), (el) => el.textContent)
    expect(states).toEqual(['等你处理', '你确认了', '你拒绝了', '对方撤销了'])
  })

  it('换到「我提交给别人的」，同样这四行换成对方视角', async () => {
    const user = userEvent.setup()
    mockBoxes(samplePage(FOUR), samplePage(FOUR))

    renderRouted('/me/returns', <MyReturnsPage />, '/me/returns')
    await screen.findByText('等处理的钱包')

    await user.click(screen.getByRole('button', { name: '我提交给别人的' }))
    await screen.findByText('等处理的钱包')

    expect(stateOf('等处理的钱包')).toBe('等对方处理')
    expect(stateOf('确认过的钥匙')).toBe('对方确认了')
    expect(stateOf('拒绝过的校园卡')).toBe('对方拒绝了')
    expect(stateOf('撤销过的雨伞')).toBe('你撤销了')
  })
})

describe('两个箱子是两个端点', () => {
  it('默认打 #29，不带 status 也不带 page', async () => {
    const seen = mockBoxes(samplePage([entry('pending', '默认箱里的钱包', 11)]))

    renderRouted('/me/returns', <MyReturnsPage />, '/me/returns')
    await screen.findByText('默认箱里的钱包')

    expect(new URL(seen.received).pathname).toBe('/api/my/returns/received')
    expect(seen.submitted).toBe('')
    const q = new URL(seen.received).searchParams
    expect(q.has('status')).toBe(false)
    expect(q.has('page')).toBe(false)
  })

  it('状态筛选把枚举原样发出去，并且换条件时页码归一', async () => {
    const user = userEvent.setup()
    const seen = mockBoxes(samplePage([entry('pending', '筛选后的钱包', 12)], { total: 60 }))

    renderRouted('/me/returns', <MyReturnsPage />, '/me/returns?page=3')
    await screen.findByText('筛选后的钱包')
    expect(screen.getByText(/第 3 \/ 3 页/)).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('状态'), 'pending')
    await screen.findByText('筛选后的钱包')
    const q = new URL(seen.received).searchParams
    expect(q.get('status')).toBe('pending')
    // 停在第 3 页去看一个刚换过条件的结果集，屏幕上就是「这里还没有东西」配一个假页码。
    expect(q.has('page')).toBe(false)
  })

  it('换箱子会换端点，也会把页码清掉，但不会把状态筛选清掉', async () => {
    const user = userEvent.setup()
    const seen = mockBoxes(samplePage([entry('pending', '换箱前的钱包', 13)], { total: 60 }))

    renderRouted('/me/returns', <MyReturnsPage />, '/me/returns?page=3&status=pending')
    await screen.findByText('换箱前的钱包')

    await user.click(screen.getByRole('button', { name: '我提交给别人的' }))
    await screen.findByText(/还没有向别人提交过/)
    const q = new URL(seen.submitted).searchParams
    expect(new URL(seen.submitted).pathname).toBe('/api/my/returns/submitted')
    expect(q.has('page')).toBe(false)
    // 「只看还没处理的」是人对两个箱子都想说的话，换箱子把它丢掉会让人重新选一遍。
    expect(q.get('status')).toBe('pending')
  })

  it('URL 里一个后端不认的状态值照样转给后端 —— 这一页不抄一份白名单', async () => {
    const seen = mockBoxes(samplePage([entry('pending', '未知状态的钱包', 14)]))

    renderRouted('/me/returns', <MyReturnsPage />, '/me/returns?status=bogus')
    await screen.findByText('未知状态的钱包')

    // 和 #19 那页刻意相反：那里前端白名单挡掉未知值。这里枚举和后端是同一份，
    // 前端再抄一份就会先过期，所以未知值由后端那句 VALIDATION 来答。
    expect(new URL(seen.received).searchParams.get('status')).toBe('bogus')
  })
})

describe('列表行里没有判断材料', () => {
  it('owner_note 在行里（后端给了），message 和凭证图不在（后端没给），行只给一个进详情的链接', async () => {
    mockBoxes(
      samplePage([
        {
          ...entry('rejected', '带答复的钱包', 15),
          owner_note: '卡套是灰色的，我在架子上等你',
          reviewed_at: '2026-10-07T08:00:00Z',
        },
      ]),
    )

    renderRouted('/me/returns', <MyReturnsPage />, '/me/returns')
    await screen.findByText('带答复的钱包')
    const row = rowOf('带答复的钱包')

    expect(within(row).getByText(/卡套是灰色的/)).toBeInTheDocument()
    // 提交留言和凭证图不在这一族的响应里 —— 界面上出现了就是前端编的。
    expect(screen.queryByText(/夹层里有一张校园卡/)).not.toBeInTheDocument()
    expect(within(row).queryByRole('img')).not.toBeInTheDocument()
    // 判断要进 #24：列表上放确认/拒绝按钮就等于在没有证据的地方做判断。
    expect(within(row).queryByRole('button', { name: /确认|拒绝|撤销/ })).not.toBeInTheDocument()
    expect(within(row).getByRole('link', { name: '带答复的钱包' })).toHaveAttribute('href', '/returns/15')
  })

  it('摘要里的 item_type 照实显示，lost 的那一行不会被写成拾物', async () => {
    mockBoxes(
      samplePage([
        {
          ...entry('pending', '我提交过的失物帖', 16),
          item: sampleSummary({ id: 916, item_type: 'lost', title: '我提交过的失物帖' }),
        },
      ]),
    )

    renderRouted('/me/returns', <MyReturnsPage />, '/me/returns')
    await screen.findByText('我提交过的失物帖')
    expect(within(rowOf('我提交过的失物帖')).getByText(/失物 ·/)).toBeInTheDocument()
  })
})

describe('失败与空态', () => {
  it('后端报 VALIDATION 时显示那句原因和请求编号', async () => {
    setToken('jwt.me')
    server.use(
      http.get(`${BASE}/api/auth/me`, () => HttpResponse.json(ok(sampleUser()))),
      http.get(
        `${BASE}/api/my/returns/received`,
        () => HttpResponse.json(envelope('VALIDATION', 'status 不是允许的取值', 400).body, { status: 400 }),
      ),
    )

    renderRouted('/me/returns', <MyReturnsPage />, '/me/returns?status=bogus')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('status 不是允许的取值')
    expect(alert).toHaveTextContent('test-req-validation')
  })

  it('两个箱子的空态是两句话，而「我收到的」那句不暗示东西有问题', async () => {
    const user = userEvent.setup()
    mockBoxes(samplePage<ReturnEntry>([]))

    renderRouted('/me/returns', <MyReturnsPage />, '/me/returns')
    expect(await screen.findByText(/这不说明你的东西有问题/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '我提交给别人的' }))
    expect(await screen.findByText(/要提交，去那条拾物帖的详情页/)).toBeInTheDocument()
  })

  it('这一族最容易误会的那件事被写在页面底部：多个人各自提交、互不冲突', async () => {
    mockBoxes(samplePage(FOUR))

    renderRouted('/me/returns', <MyReturnsPage />, '/me/returns')
    // 这条 hint 讲的是唯一索引 (item_id, submitter_id) 的后果，
    // 而那条索引在页面上唯一的可见证据就是四行同名不同人的记录可以同时 pending。
    expect(await screen.findByText(/也不会替其他人把那一条关掉/)).toBeInTheDocument()
  })
})
