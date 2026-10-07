// src/components/ImagePicker.test.tsx —— #6 上传那一段的行为，重点是「哪一次点击真的发出了请求」。
//
// 这一层往服务器**写文件**，而写下来的图在没被任何帖子引用之前是孤儿（后端没有回收端点）。
// 所以它最怕的不是传失败，而是「没想传却传了」：打开弹层就预传、或者一进来就 POST 一次，
// 磁盘上就多一个没人引用的文件，而且没人会知道是怎么来的。
// 下面那条「没选文件时上传请求数为 0」就是这个组件的存在理由，不是凑数的断言。
//
// 类型判断一律不在这里做：file.type 是浏览器按扩展名猜的，后端读文件头 512 字节嗅探。
// 这里要是照 MIME 拦一道，就会出现「前端放过去了、后端还是拒」，两处说法不一样 ——
// 判据只能有一份。所以前端只拦字节数（那一件事两边量出来是一致的）。
//
// ⚠ 为什么这里 vi.spyOn(http,'post') 而不走 msw：jsdom + msw 的 XHR 拦截对 **multipart** 请求
// 是死路一条 —— handler 进得去、响应回不来，Promise 永远 pending（实测把 handler 改成完全同步、
// 一行 body 都不读也一样）。那样测出来的「没反应」会被误读成组件的 bug。
// 拦在 http.post 这一层反而能多验两件事：FormData 的字段名必须是 `file`
// （后端 handler/upload.go 的 formFieldFile），以及 5MB 那条预检发生在 axios 之前。
// 真发一次 multipart、以及 FILE_TOO_LARGE / FILE_TYPE_UNSUPPORTED 这两个 code 长什么样，
// 归 contract.post.live.test.ts 打真后端验。
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ImagePicker from './ImagePicker'
import { ApiError, http } from '../api/client'
import { ok } from '../test/helpers'
import { setToken } from '../api/session'
import type { PickedImage } from './ImagePicker'
import type { StoredImage } from '../api/types'

/** 一张正常大小的假图。字节数是真的（jsdom 按内容算 size），
 *  因为 5MB 那条预检读的就是 file.size —— 伪造 size 等于把要验的那行代码绕过去。 */
function image(name = 'photo.jpg', bytes = 1024): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' })
}

const STORED: StoredImage = { path: '2026/10/abc.jpg', url: '/uploads/2026/10/abc.jpg' }

/** 拦下 http.post，返回**信封**而不是解过包的数据：
 *  uploadImage 拿的是 res.data，而拦截器那一步（信封 → data）在这里被绕过了，
 *  所以这一层只验「发出去的是什么、拿回来的怎么用」，不验解包。 */
function mockPost(result: 'ok' | 'unsupported' | 'too-large' = 'ok') {
  const spy = vi.spyOn(http, 'post')
  if (result === 'ok') {
    spy.mockResolvedValue({ data: ok(STORED).data } as never)
  } else {
    const message =
      result === 'unsupported' ? '文件内容不是受支持的图片类型' : '图片超过 5MB，后端拒绝接收'
    spy.mockRejectedValue(new ApiError({ code: result === 'unsupported' ? 'FILE_TYPE_UNSUPPORTED' : 'FILE_TOO_LARGE', message }))
  }
  return spy
}

function setup(props: { images?: PickedImage[]; maxed?: boolean } = {}) {
  const onAdded = vi.fn()
  const onDropped = vi.fn()
  const onClose = vi.fn()
  render(
    <ImagePicker
      images={props.images ?? []}
      maxed={props.maxed ?? false}
      onAdded={onAdded}
      onDropped={onDropped}
      onClose={onClose}
    />,
  )
  return { onAdded, onDropped, onClose }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('上传（#6）', () => {
  it('没选文件时一个上传请求都不发', async () => {
    const user = userEvent.setup()
    setToken('jwt.x')
    const spy = mockPost()

    setup()

    // 底部那个大按钮存在且能点，但它只负责打开系统文件框（jsdom 里没有系统框），不发请求。
    const shot = screen.getByRole('button', { name: '拍照 / 从相册选一张' })
    expect(shot).toBeEnabled()
    await user.click(shot)
    expect(spy).not.toHaveBeenCalled()
  })

  it('选了文件才 POST /api/uploads，字段名是 file，path 和 url 都交给表单', async () => {
    const user = userEvent.setup()
    setToken('jwt.x')
    const spy = mockPost()
    const { onAdded } = setup()

    await user.upload(screen.getByLabelText('选择图片文件'), image())

    await waitFor(() => expect(onAdded).toHaveBeenCalled())
    expect(spy).toHaveBeenCalledTimes(1)
    const [url, body, config] = spy.mock.calls[0]
    expect(url).toBe('/api/uploads')
    // 字段名写成别的（比如 fileToUpload）前端一切正常、后端 c.FormFile 找不到字段，
    // 用户收到莫名其妙的「没有收到图片」，而界面看起来是后端坏了。
    expect((body as FormData).get('file')).toBeInstanceOf(File)
    // 超时放宽到 60 秒：实例那 15 秒是给 JSON 请求定的，一张 4MB 的手机照片传不完。
    expect(config).toMatchObject({ timeout: 60_000 })
    // path 进 image_paths，url 只用来显示 —— 少了 path 就没法发帖。
    expect(onAdded).toHaveBeenCalledWith(STORED)
  })

  it('超过 5MB 在本地就拦住：一次请求都不发，文案说清「没有上传」', async () => {
    const user = userEvent.setup()
    setToken('jwt.x')
    const spy = mockPost()
    const { onAdded } = setup()

    // 5MB + 1 字节：正好越过 service.MaxUploadBytes 那条线，量的是真实字节数。
    await user.upload(
      screen.getByLabelText('选择图片文件'),
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'huge.jpg', { type: 'image/jpeg' }),
    )

    expect(spy).not.toHaveBeenCalled()
    expect(onAdded).not.toHaveBeenCalled()
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('超过 5MB 上限')
    expect(alert).toHaveTextContent('已经拦住了没有上传')
  })

  it('后端拒绝接收时显示它那句原话，不把这张图放进列表', async () => {
    const user = userEvent.setup()
    setToken('jwt.x')
    const spy = mockPost('unsupported')
    const { onAdded } = setup()

    await user.upload(screen.getByLabelText('选择图片文件'), image('renamed.jpg'))

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(spy).toHaveBeenCalledTimes(1)
    expect(onAdded).not.toHaveBeenCalled()
    // 这个 code 不在 errorText 的表里，所以显示的就是后端 message 原文 —— 判据只有一份。
    expect(screen.getByRole('alert')).toHaveTextContent('文件内容不是受支持的图片类型')
  })

  it('满 9 张时按钮禁用并说明怎么办，而不是让用户传完第十张吃 VALIDATION', async () => {
    const user = userEvent.setup()
    setToken('jwt.x')
    const spy = mockPost()

    setup({ maxed: true })

    const shot = screen.getByRole('button', { name: '最多 9 张，先去掉一张再加' })
    expect(shot).toBeDisabled()
    // 禁用不是摆设：按下去（jsdom 里 disabled 的按钮 user-event 会照样派发）也不该发请求。
    await user.click(shot).catch(() => {})
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('弹层的形状（计划 §M7 对这一块写得很具体）', () => {
  it('是全屏模态层，头部只有关闭图标；× 掉一张只走 onDropped，不碰服务器', async () => {
    const user = userEvent.setup()
    const spy = mockPost()
    const { onClose, onDropped } = setup({
      images: [{ url: '/uploads/2026/10/a.jpg', path: '2026/10/a.jpg' }],
    })

    const dialog = screen.getByRole('dialog', { name: '图片' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')

    // 头部不许有第二个按钮：计划明写「不要多余的滑动面板」，
    // 每按一次拍照就多一张图，列表本身就是结果，不需要一个「完成」。
    const head = dialog.querySelector('.capture-head')
    expect(head).not.toBeNull()
    expect(head!.querySelectorAll('button')).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: '不要这张' }))
    expect(onDropped).toHaveBeenCalledTimes(1)
    // 这一条是它和编辑页那套删除的唯一区别：这里的图还没被任何帖子引用，#42 删不到它。
    expect(spy).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
