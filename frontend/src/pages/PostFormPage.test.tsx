// src/pages/PostFormPage.test.tsx —— 发布（#13）与编辑（#16）这张共用表单。
//
// 这一页最值钱的三条断言：
//  ① 时间按「哪一个瞬间」发出去，不是把 datetime-local 那个不带时区的串原样送过去。
//     后端刻意不接受缺时区的写法（少写时区会静默挪 8 小时，而 S_time 是匹配最吃的输入），
//     所以这里必须验到瞬时，写死 '+08:00' 反而会让测试只在中国时区的机器上成立。
//  ② 编辑模式**不发 image_paths**。那是后端契约的硬限制（#16 整组替换 + #15 不给 path），
//     一旦哪天有人「顺手补上这个字段」，改帖就会静默删掉帖子上原有的图。
//  ③ 只有点提交才 POST。表单加载是三个 GET（#7 #8 和编辑时的 #15），一个写操作都没有。
//
// ⚠ 上传这一段被 vi.mock 掉了：jsdom + msw 的 XHR 拦截对 multipart 是死路（响应回不来，
// 详见 ImagePicker.test.tsx 顶部）。这里要验的是「path 进 image_paths、url 不进」，
// 那和 multipart 怎么发无关；真实上传归 ImagePicker.test.tsx + contract.post.live.test.ts。
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PostFormPage from './PostFormPage'
import { AuthProvider } from '../auth/AuthContext'
import { server } from '../test/server'
import {
  BASE,
  envelope,
  ok,
  sampleCategories,
  sampleItemView,
  sampleLocations,
  sampleUser,
} from '../test/helpers'
import { setToken } from '../api/session'
import type { CreateItemResult, ItemView } from '../api/types'

vi.mock('../api/uploads', () => ({
  MAX_IMAGE_BYTES: 5 * 1024 * 1024,
  // 文件名进 path，好让下面的断言能指认「这张图是以 path 还是 url 的形式发出去的」。
  uploadImage: (file: File) =>
    Promise.resolve({ path: `2026/10/${file.name}`, url: `/uploads/2026/10/${file.name}` }),
}))

/** 成功页桩：把 navigation state 里到底有没有带着结果说出来的一个真组件。
 *  PostFormPage 发出去的是 navigate(url, {state:{result}})，而 state 只在导航这一跳里存在，
 *  桩必须自己 useLocation() 才看得到 —— 用字符串元素是断不出它的。 */
function DoneStub() {
  const state = useLocation().state as { result?: CreateItemResult } | null
  return <p>成功页桩 {state?.result ? `带上结果 ${state.result.item.id}` : '没有 state'}</p>
}

function renderForm(at: string) {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <AuthProvider>
        <Routes>
          <Route path="/post" element={<PostFormPage />} />
          <Route path="/items/:id/edit" element={<PostFormPage />} />
          <Route path="/items/:id" element={<p>详情页桩</p>} />
          <Route path="/post/done/:id" element={<DoneStub />} />
          <Route path="/" element={<p>广场页桩</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

/** 记下收到的请求体。JSON 能被 handler 读到（multipart 不行），
 *  所以 #13/#16 这两个端点的契约就验在这里。 */
interface Captured {
  calls: number
  body: Record<string, unknown> | null
}

function mockDicts() {
  server.use(
    http.get(`${BASE}/api/categories`, () => HttpResponse.json(ok(sampleCategories()))),
    http.get(`${BASE}/api/locations`, () => HttpResponse.json(ok(sampleLocations()))),
  )
}

function mockMe(user: ReturnType<typeof sampleUser>) {
  server.use(http.get(`${BASE}/api/auth/me`, () => HttpResponse.json(ok(user))))
}

function mockCreate(reply: () => Response) {
  const cap: Captured = { calls: 0, body: null }
  server.use(
    http.post(`${BASE}/api/items`, async ({ request }) => {
      cap.calls += 1
      cap.body = (await request.json()) as Record<string, unknown>
      return reply()
    }),
  )
  return cap
}

function mockUpdate(view: ItemView) {
  const cap: Captured = { calls: 0, body: null }
  server.use(
    http.put(`${BASE}/api/items/:id`, async ({ request }) => {
      cap.calls += 1
      cap.body = (await request.json()) as Record<string, unknown>
      return HttpResponse.json(ok(view))
    }),
  )
  return cap
}

function mockDetail(view: ItemView) {
  server.use(http.get(`${BASE}/api/items/:id`, () => HttpResponse.json(ok(view))))
}

// datetime-local 用 fireEvent 而不是 user.type：jsdom 没实现日期选择器控件，
// 逐字符敲进去的串和浏览器真正会产生的 value 形状不一样。React 的 onChange 只看 value，
// 所以这里直接把框的值设成浏览器会给的那个串（'2026-10-06T20:00'）。
function setTime(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

/** 把 lost 帖的必填项填满。分类走两级（选到小类 21），地点走三级（选到 31）——
 *  顺手也证明了这张表单里的级联确实遵守「只有叶子才是值」。 */
async function fillLost(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/标题/), '黑色长款钱包')
  await user.selectOptions(screen.getByLabelText('大类'), '20')
  await user.selectOptions(screen.getByLabelText('衣物箱包里的下一级'), '21')
  await user.selectOptions(screen.getByLabelText('片区'), '10')
  await user.selectOptions(screen.getByLabelText('教学区里的下一级'), '30')
  await user.selectOptions(screen.getByLabelText('图书馆里的下一级'), '31')
  await user.type(screen.getByLabelText(/具体位置/), '三楼自习区靠窗')
  await user.type(screen.getByLabelText(/联系方式/), '微信 aaa')
  setTime(/最后确认还在的时间/, '2026-10-06T20:00')
  setTime(/发现丢失的时间/, '2026-10-07T09:00')
}

beforeEach(() => {
  mockDicts()
})

describe('发布（#13）', () => {
  it('空表单不能提交，并且逐栏列出还差什么', async () => {
    setToken('jwt.x')
    mockMe(sampleUser())
    mockCreate(() => HttpResponse.json(ok({ item: sampleItemView() })))

    renderForm('/post')
    await screen.findByRole('heading', { name: '我丢了东西' })

    expect(screen.getByRole('button', { name: '发布' })).toBeDisabled()
    // 禁用按钮必须配一句「还差什么」，否则「为什么不能点」是只有开发者知道的事。
    expect(
      screen.getByText('还差：标题、分类、地点、联系方式、最后确认还在的时间、发现丢失的时间'),
    ).toBeInTheDocument()
  })

  it('填完之后才放开提交，发出去的时间是同一个瞬间而不是那串没时区的字', async () => {
    const user = userEvent.setup()
    setToken('jwt.x')
    mockMe(sampleUser())
    const cap = mockCreate(() =>
      HttpResponse.json(ok({ item: sampleItemView({ id: 301, item_type: 'lost' }), matches_preview: [] })),
    )

    renderForm('/post')
    await screen.findByRole('heading', { name: '我丢了东西' })

    await fillLost(user)
    expect(screen.getByRole('button', { name: '发布' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: '发布' }))

    // 跳转带的 state 里必须有那份结果 —— 成功页除了这一跳没有第二个来源（见 PostResultPage 顶部）。
    expect(await screen.findByText(/带上结果 301/)).toBeInTheDocument()
    expect(cap.calls).toBe(1)
    const b = cap.body!
    expect(b.item_type).toBe('lost')
    expect(b.title).toBe('黑色长款钱包')
    // 叶子 id，不是大类 id：写成大类就是后端那条 `i.category_id = $n` 精确匹配落空。
    expect(b.category_id).toBe(21)
    expect(b.location_id).toBe(31)
    expect(b.contact).toBe('微信 aaa')

    // 断的是「同一个瞬间」而不是某个具体偏移 —— 换台机器跑也成立。
    const lostAt = String(b.lost_at)
    expect(lostAt).toMatch(/Z$/)
    expect(new Date(lostAt).getTime()).toBe(new Date('2026-10-07T09:00').getTime())
    expect(new Date(String(b.last_seen_at)).getTime()).toBe(new Date('2026-10-06T20:00').getTime())
    // 另一种类型的两列发空串（后端折成 NULL），不能留着上一个类型时的值。
    expect(b.found_at).toBe('')
  })

  it('切到拾物帖，时间那几栏只剩一个「实际拾获时间」', async () => {
    const user = userEvent.setup()
    setToken('jwt.x')
    mockMe(sampleUser())
    mockCreate(() => HttpResponse.json(ok({ item: sampleItemView(), notified_count: 0 })))

    renderForm('/post')
    await screen.findByRole('heading', { name: '我丢了东西' })
    expect(screen.getByLabelText(/最后确认还在的时间/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/实际拾获时间/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '我捡到东西' }))

    expect(await screen.findByRole('heading', { name: '我捡到东西' })).toBeInTheDocument()
    expect(screen.queryByLabelText(/最后确认还在的时间/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/发现丢失的时间/)).not.toBeInTheDocument()
    expect(screen.getByLabelText(/实际拾获时间/)).toBeInTheDocument()
    expect(screen.getByText(/还差：.*实际拾获时间/)).toBeInTheDocument()
    // 计划点名的那句提醒：把上传时间当拾获时间填是几乎人人会犯的错。
    expect(screen.getByText(/实际捡到/)).toBeInTheDocument()
  })

  it('地点选了「其他」时红字警告，并把具体位置变成必填', async () => {
    const user = userEvent.setup()
    setToken('jwt.x')
    mockMe(sampleUser())
    mockCreate(() => HttpResponse.json(ok({ item: sampleItemView() })))

    renderForm('/post')
    await screen.findByRole('heading', { name: '我丢了东西' })

    await user.selectOptions(screen.getByLabelText('片区'), '99')

    // 这句红的理由是后果（降到 Tier 2），不是「格式不对」。
    expect(screen.getByText(/选「其他」会极大降低匹配成功率/)).toBeInTheDocument()
    expect(screen.getByText(/还差：.*具体位置/)).toBeInTheDocument()
    expect(screen.getByLabelText(/具体位置/)).toBeInTheDocument()
  })

  it('VALIDATION 的字段级错误显示在它自己那一栏下面', async () => {
    const user = userEvent.setup()
    setToken('jwt.x')
    mockMe(sampleUser())
    mockCreate(
      () =>
        HttpResponse.json(
          envelope('VALIDATION', '标题太长了', 400, {
            errors: [{ field: 'title', msg: '不能超过 100 个字符' }],
          }).body,
          { status: 400 },
        ),
    )

    renderForm('/post')
    await screen.findByRole('heading', { name: '我丢了东西' })
    await fillLost(user)
    await user.click(screen.getByRole('button', { name: '发布' }))

    const fieldError = await screen.findByText('不能超过 100 个字符')
    // 「落在正确的栏」必须验到 DOM 归属，光看文案里有没有「标题」两个字是测不出串位的。
    expect(fieldError.closest('.field')).toContainElement(screen.getByLabelText(/标题/))
    // 顶部同时给后端那句 message 原文（VALIDATION 不进 errorText 的表）和请求编号。
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('标题太长了')
    expect(alert).toHaveTextContent('test-req-validation')
    // 提交失败要留在表单上，不能把人扔到详情页。
    expect(screen.getByRole('button', { name: '发布' })).toBeEnabled()
  })

  it('图片是以 path 进 image_paths 的，不是页面上那个 /uploads 开头的 url', async () => {
    const user = userEvent.setup()
    setToken('jwt.x')
    mockMe(sampleUser())
    const cap = mockCreate(() => HttpResponse.json(ok({ item: sampleItemView(), matches_preview: [] })))

    renderForm('/post')
    await screen.findByRole('heading', { name: '我丢了东西' })
    await fillLost(user)

    await user.click(screen.getByRole('button', { name: '拍照 / 选照片' }))
    await user.upload(
      screen.getByLabelText('选择图片文件'),
      new File([new Uint8Array(1024)], 'wallet.jpg', { type: 'image/jpeg' }),
    )
    // 弹层还开着的时候有两个「不要这张」：弹层里那个是「这张别收进表单」，
    // 后面那个是同一个列表的缩略图。关掉弹层之后只剩一个。
    await waitFor(() => expect(screen.getAllByRole('button', { name: '不要这张' })).toHaveLength(2))
    await user.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.getByRole('button', { name: '不要这张' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '发布' }))
    expect(await screen.findByText(/成功页桩/)).toBeInTheDocument()
    // IsUploadPath 只对 `2026/10/xxx.jpg` 这种形状放行，把 url 原样传过去会被判路径不合法。
    expect(cap.body!.image_paths).toEqual(['2026/10/wallet.jpg'])
  })
})

describe('编辑（#16）', () => {
  const mine = () =>
    sampleItemView({
      id: 202,
      item_type: 'found',
      author: { id: 8, nickname: '小王' },
      contact: '微信 bbb',
      contact_locked: false,
      found_at: '2026-10-06T04:00:00Z',
      images: [{ id: 5, url: '/uploads/2026/10/wallet.jpg', sort_order: 0 }],
    })

  it('预填的时间显示成本机时刻，改完发回去还是那一个瞬间', async () => {
    const user = userEvent.setup()
    setToken('jwt.owner')
    mockMe(sampleUser({ id: 8, nickname: '小王' }))
    mockDetail(mine())
    const cap = mockUpdate(mine())

    renderForm('/items/202/edit')
    const found = await screen.findByLabelText<HTMLInputElement>(/实际拾获时间/)

    // datetime-local 的 value 没有时区后缀，浏览器按本机时区解读 ——
    // 所以「预填对了」的定义就是：它表示的瞬间等于后端给的那一个。
    // 直接截前 16 个字符（把 UTC 串当本地串）会让这条帖子在保存后被静默挪 8 小时，
    // 而改一条 found 帖是要重新触发匹配的。
    expect(new Date(found.value).getTime()).toBe(new Date('2026-10-06T04:00:00Z').getTime())

    await user.clear(screen.getByLabelText(/标题/))
    await user.type(screen.getByLabelText(/标题/), '捡到黑色长款钱包（补：内有校园卡）')
    await user.click(screen.getByRole('button', { name: '保存修改' }))

    expect(await screen.findByText('详情页桩')).toBeInTheDocument()
    expect(cap.calls).toBe(1)
    // 没动时间 → 发回去的必须还是同一个瞬间。
    expect(new Date(String(cap.body!.found_at)).getTime()).toBe(new Date('2026-10-06T04:00:00Z').getTime())
    expect(cap.body!.title).toBe('捡到黑色长款钱包（补：内有校园卡）')
  })

  it('编辑模式不发 image_paths，也不发 item_type', async () => {
    const user = userEvent.setup()
    setToken('jwt.owner')
    mockMe(sampleUser({ id: 8 }))
    mockDetail(mine())
    const cap = mockUpdate(mine())

    renderForm('/items/202/edit')
    await screen.findByLabelText(/标题/)
    await user.click(screen.getByRole('button', { name: '保存修改' }))

    await waitFor(() => expect(cap.calls).toBe(1))
    // 这一条是这一片的守门人：#16 的 image_paths 是整组替换，而 #15 不给 path，
    // 客户端因此重建不出「原有那些 + 新加的」。哪天有人把它加回来，改帖就会删掉原有图片。
    expect('image_paths' in cap.body!).toBe(false)
    // 改类型等于换了一条帖子（谁在找 / 谁捡到是两个相反立场），后端请求体里也没这个键。
    expect('item_type' in cap.body!).toBe(false)
    expect(cap.body!.contact).toBe('微信 bbb')
  })

  it('编辑模式没有加图入口，只有删图，并且删图是两步、立刻生效', async () => {
    const user = userEvent.setup()
    setToken('jwt.owner')
    mockMe(sampleUser({ id: 8 }))
    mockDetail(mine())
    let deletes = 0
    server.use(
      http.delete(`${BASE}/api/item-images/:imageId`, () => {
        deletes += 1
        return HttpResponse.json(ok(null))
      }),
    )

    renderForm('/items/202/edit')
    await screen.findByLabelText(/标题/)

    // 加图的按钮在这里必须不存在（不是禁用）：一个会删掉别人照片的按钮比没有按钮更糟。
    expect(screen.queryByRole('button', { name: /拍照/ })).not.toBeInTheDocument()
    expect(screen.getByText(/改帖只能删图/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '删除这张图' }))
    // 第一步只出确认，#42 还没被打 —— 它是立刻删行删文件的，和「去掉一张还没提交的图」不是一回事。
    expect(deletes).toBe(0)
    expect(screen.getByText(/删除会/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(deletes).toBe(1))
    expect(screen.queryByRole('button', { name: '删除这张图' })).not.toBeInTheDocument()
  })

  it('#42 失败时那张图还在列表里，不为后端的拒绝替它消失', async () => {
    const user = userEvent.setup()
    setToken('jwt.owner')
    mockMe(sampleUser({ id: 8 }))
    mockDetail(mine())
    server.use(
      http.delete(
        `${BASE}/api/item-images/:imageId`,
        () =>
          HttpResponse.json(envelope('FORBIDDEN', '没有权限', 403).body, { status: 403 }),
        { once: true },
      ),
    )

    renderForm('/items/202/edit')
    await user.click(await screen.findByRole('button', { name: '删除这张图' }))
    await user.click(screen.getByRole('button', { name: '确认删除' }))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '删除这张图' })).toBeInTheDocument()
  })

  it('不是本人时整张表单都不出现，而不是填完再吃一个 FORBIDDEN', async () => {
    setToken('jwt.other')
    mockMe(sampleUser({ id: 7, nickname: '小李' }))
    mockDetail(mine())

    renderForm('/items/202/edit')

    expect(await screen.findByRole('heading', { name: '这条不是你发的' })).toBeInTheDocument()
    expect(screen.queryByLabelText(/标题/)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /它的详情页/ })).toHaveAttribute('href', '/items/202')
  })
})
