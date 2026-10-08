// src/pages/ClaimItemPage.test.tsx —— #23：丢了东西的人向捡到东西的人提交一次归还确认。
//
// 这一页要钉住四条：
//   ① 发出去的是 #6 响应里的 **path**，不是页面上那个 /uploads 开头的 url
//      （后端 IsUploadPath 只认前者，填错得到一句写着 proof_image_path 的 VALIDATION）。
//   ② 后端**不要求先解锁过联系方式**（RETURN_NOT_UNLOCKED 那个码整个被删了），
//      所以这一页不许出现「请先查看联系方式」那种挡人的话。
//   ③ 自己的帖子不给这张表：后端给 RETURN_SELF，而让人填完整张表再收一句报错是白折腾。
//   ④ 提交成功立刻离开这一页 —— 停在这儿只会让人以为没交上去，而重复提交是 RETURN_DUPLICATE。
//
// ⚠ 上传那一段和 PostFormPage.test.tsx 一样被 vi.mock 掉：jsdom + msw 拦不住 multipart。
// 这里要验的是 path 进 proof_image_path，和 multipart 怎么发无关。
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ClaimItemPage from './ClaimItemPage'
import { renderRouted } from '../test/render'
import { server } from '../test/server'
import { BASE, envelope, ok, sampleItemView, sampleUser } from '../test/helpers'
import { setToken } from '../api/session'
import type { ItemView } from '../api/types'

vi.mock('../api/uploads', () => ({
  MAX_IMAGE_BYTES: 5 * 1024 * 1024,
  uploadImage: (file: File) =>
    Promise.resolve({ path: `2026/10/${file.name}`, url: `/uploads/2026/10/${file.name}` }),
}))

/** #15 记请求；#23 记请求体和次数。 */
function mockFlow(item: ItemView, viewer = sampleUser({ id: 12, nickname: '小李' })) {
  const seen: { body: unknown; times: number } = { body: null, times: 0 }
  setToken('jwt.me')
  server.use(
    http.get(`${BASE}/api/auth/me`, () => HttpResponse.json(ok(viewer))),
    http.get(`${BASE}/api/items/:id`, () => HttpResponse.json(ok(item))),
    http.post(`${BASE}/api/items/:id/returns`, async (c) => {
      seen.times += 1
      seen.body = await c.request.json()
      return HttpResponse.json(
        ok({ id: 901, item_id: item.id, status: 'pending', submitted_at: '2026-10-08T01:00:00Z' }),
      )
    }),
  )
  return seen
}

async function fill(user: ReturnType<typeof userEvent.setup>, message: string, fileName = 'proof.jpg') {
  await user.type(screen.getByLabelText('说明这件东西为什么是你的'), message)
  await user.click(screen.getByRole('button', { name: '拍照或从相册选一张' }))
  await user.upload(
    screen.getByLabelText('选择图片文件'),
    new File([new Uint8Array(1024)], fileName, { type: 'image/jpeg' }),
  )
  // 选完一张弹层就自己收了：这一族只要一张凭证图，后端那个字段是单个字符串而不是数组。
  await screen.findByAltText('凭证图预览')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('表单什么时候才让人提交', () => {
  it('两样都缺的时候「还差」把两件事都列出来，键按不了', async () => {
    mockFlow(sampleItemView())

    renderRouted('/items/:id/claim', <ClaimItemPage />, '/items/202/claim')
    await screen.findByRole('heading', { name: '向拾主提交归还确认' })

    expect(screen.getByRole('button', { name: '提交给拾主' })).toBeDisabled()
    expect(screen.getByText('还差：说明至少写 5 个字、一张凭证图')).toBeInTheDocument()
  })

  it('只有说明不够、只有图也不够 —— 两个条件都是必填', async () => {
    const user = userEvent.setup()
    mockFlow(sampleItemView())

    renderRouted('/items/:id/claim', <ClaimItemPage />, '/items/202/claim')
    await screen.findByRole('heading', { name: '向拾主提交归还确认' })

    await user.type(screen.getByLabelText('说明这件东西为什么是你的'), '夹层里有我的校园卡')
    expect(screen.getByRole('button', { name: '提交给拾主' })).toBeDisabled()
    expect(screen.getByText('还差：一张凭证图')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '拍照或从相册选一张' }))
    await user.upload(
      screen.getByLabelText('选择图片文件'),
      new File([new Uint8Array(1024)], 'proof.jpg', { type: 'image/jpeg' }),
    )
    // 弹层自己收了（只要一张），表单上的那一栏换成了预览 + 「换一张」。
    await screen.findByAltText('凭证图预览')
    expect(screen.getByRole('button', { name: '提交给拾主' })).toBeEnabled()
    expect(screen.queryByText(/还差/)).not.toBeInTheDocument()
  })

  it('四个字的说明不够（后端按字算 5–1000），五个字才够', async () => {
    const user = userEvent.setup()
    mockFlow(sampleItemView())

    renderRouted('/items/:id/claim', <ClaimItemPage />, '/items/202/claim')
    await screen.findByRole('heading', { name: '向拾主提交归还确认' })

    const note = screen.getByLabelText('说明这件东西为什么是你的')
    await user.type(note, '这是我的')
    expect(screen.getByRole('button', { name: '提交给拾主' })).toBeDisabled()

    await user.type(note, '钱包')
    expect(screen.getByRole('button', { name: '提交给拾主' })).toBeDisabled() // 还没配图
    expect(screen.getByText(/还差：一张凭证图/)).toBeInTheDocument()
    expect(screen.getByText('6 / 1000')).toBeInTheDocument()
  })
})

describe('发出去的东西', () => {
  it('凭证图是以 path 进 proof_image_path 的，不是页面上那个 /uploads 开头的 url', async () => {
    const user = userEvent.setup()
    const seen = mockFlow(sampleItemView())

    renderRouted('/items/:id/claim', <ClaimItemPage />, '/items/202/claim')
    await screen.findByRole('heading', { name: '向拾主提交归还确认' })

    await fill(user, '夹层角落有磨损，卡号尾数是 4471', 'card-proof.jpg')
    await user.click(screen.getByRole('button', { name: '提交给拾主' }))

    // IsUploadPath 只对 `2026/10/x.jpg` 这种形状放行，把 url 原样传过去会判路径不合法。
    expect(seen.body).toEqual({
      message: '夹层角落有磨损，卡号尾数是 4471',
      proof_image_path: '2026/10/card-proof.jpg',
    })
  })

  it('提交成功立刻跳到那条记录，不停在一张已经交掉的表单上', async () => {
    const user = userEvent.setup()
    mockFlow(sampleItemView())

    renderRouted('/items/:id/claim', <ClaimItemPage />, '/items/202/claim')
    await screen.findByRole('heading', { name: '向拾主提交归还确认' })

    await fill(user, '钱包里有校园卡和两百现金')
    await user.click(screen.getByRole('button', { name: '提交给拾主' }))

    expect(await screen.findByText('归还详情桩')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '提交给拾主' })).not.toBeInTheDocument()
  })

  it('说明会被 trim 之后再发出去', async () => {
    const user = userEvent.setup()
    const seen = mockFlow(sampleItemView())

    renderRouted('/items/:id/claim', <ClaimItemPage />, '/items/202/claim')
    await screen.findByRole('heading', { name: '向拾主提交归还确认' })

    await fill(user, '   夹层里有我的校园卡   ')
    await user.click(screen.getByRole('button', { name: '提交给拾主' }))

    expect((seen.body as { message: string }).message).toBe('夹层里有我的校园卡')
  })
})

describe('这一页不说什么', () => {
  it('没有「请先查看联系方式」那种挡人的话 —— 后端不要求先解锁', async () => {
    mockFlow(sampleItemView({ contact: null, contact_locked: true }))

    renderRouted('/items/:id/claim', <ClaimItemPage />, '/items/202/claim')
    await screen.findByRole('heading', { name: '向拾主提交归还确认' })

    expect(screen.queryByText(/先查看联系方式|先解锁/)).not.toBeInTheDocument()
    // 说的是同一件事的正面版本：谁都能提交，判断权在拾主手里。
    expect(screen.getByText(/最后那一句话由拾主自己给/)).toBeInTheDocument()
  })

  it('平台不核实任何材料，这句话必须写在表单上', async () => {
    mockFlow(sampleItemView())

    renderRouted('/items/:id/claim', <ClaimItemPage />, '/items/202/claim')
    await screen.findByRole('heading', { name: '向拾主提交归还确认' })

    expect(screen.getByText(/平台不核实这些内容/)).toBeInTheDocument()
    // 真实姓名不带过去是 #23 响应的形状决定的（SubmitterView 里没有那一列），
    // 所以这句承诺是做得到的，不是安抚。
    expect(screen.getByText(/真实姓名不会带过去/)).toBeInTheDocument()
  })

  it('自己的帖子不给这张表，直接回那条帖子', async () => {
    mockFlow(sampleItemView(), sampleUser({ id: 8, nickname: '小王' }))

    renderRouted('/items/:id/claim', <ClaimItemPage />, '/items/202/claim')
    expect(await screen.findByText('详情页桩')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '提交给拾主' })).not.toBeInTheDocument()
  })
})

describe('报错', () => {
  it('RETURN_DUPLICATE 显示的是这一族自己那句人话，不是后端 message', async () => {
    const user = userEvent.setup()
    mockFlow(sampleItemView())
    server.use(
      http.post(
        `${BASE}/api/items/:id/returns`,
        () => HttpResponse.json(envelope('RETURN_DUPLICATE', 'duplicate submit', 409).body, { status: 409 }),
      ),
    )

    renderRouted('/items/:id/claim', <ClaimItemPage />, '/items/202/claim')
    await screen.findByRole('heading', { name: '向拾主提交归还确认' })

    await fill(user, '夹层里有我的校园卡和一张照片')
    await user.click(screen.getByRole('button', { name: '提交给拾主' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('你为这条帖子提交的那一次还在等对方处理，不用重复提交。')
    expect(alert).toHaveTextContent('test-req-return_duplicate')
    // 失败要留在表单上：把人扔走等于让他以为已经交过了。
    expect(screen.getByRole('button', { name: '提交给拾主' })).toBeEnabled()
  })

  it('VALIDATION 里写着 proof_image_path 时，那句原因显示在图那一栏下面', async () => {
    const user = userEvent.setup()
    mockFlow(sampleItemView())
    server.use(
      http.post(`${BASE}/api/items/:id/returns`, () => {
        const e = envelope('VALIDATION', '凭证图路径不合法', 400, {
          errors: [{ field: 'proof_image_path', msg: '只接受本次上传返回的 path' }],
        })
        return HttpResponse.json(e.body, { status: e.status })
      }),
    )

    renderRouted('/items/:id/claim', <ClaimItemPage />, '/items/202/claim')
    await screen.findByRole('heading', { name: '向拾主提交归还确认' })

    await fill(user, '夹层里有我的校园卡和一张照片')
    await user.click(screen.getByRole('button', { name: '提交给拾主' }))

    // 字段级错误各表单自己用 errorFor(field) 取，VALIDATION 刻意不在 errorText 表里。
    expect(await screen.findByText('只接受本次上传返回的 path')).toBeInTheDocument()
    const alert = screen.getByRole('alert')
    expect(within(alert).getByText('凭证图路径不合法')).toBeInTheDocument()
  })

  it('lost 帖不给这张表 —— 这一族的方向是反的，捡到东西的人才欠一个判断', async () => {
    mockFlow(
      sampleItemView({ item_type: 'lost', title: '我丢的黑色钱包', contact: '13800000000', contact_locked: false }),
    )

    renderRouted('/items/:id/claim', <ClaimItemPage />, '/items/202/claim')
    // #23 的判据③对 lost 给 VALIDATION，所以直接敲地址进来的人应该看到那条帖子本身：
    // 一张「向拾主提交」的表单对失物帖根本没有对象可提交，连「拾获于」那一栏都会是空的。
    expect(await screen.findByText('详情页桩')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '向拾主提交归还确认' })).not.toBeInTheDocument()
  })
})
