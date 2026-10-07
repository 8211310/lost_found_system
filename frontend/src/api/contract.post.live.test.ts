// src/api/contract.post.live.test.ts —— 片 3 那六条端点打真后端的契约检查：#6 #13 #16 #17 #18 #42。
//
// 和 contract.write.live.test.ts 的分工：那边验的是「读回来的形状」（解锁、举报、匹配），
// 这一片验的是**写进去的形状**——发帖的字段、图片的两种路径、开关状态的那一个值。
// 这一组里有一半的 bug 不会让任何前端测试变红：比如把 image_paths 传成 url，
// msw 的假响应是按前端类型写的（它不知道后端只认 path），只有真打才会变成一句 VALIDATION。
//
// 跑法同前：`npm run test:live`（后端要已在 8080 起）。它会在开发库里留下
// 2 个账号、3 条帖子和 1~2 个没人引用的图片文件 —— 这是刻意的，理由见下面 register 那段。
//
// ⚠ describe 之间是**有顺序**的，不是并列的：#17 之后那条帖子就读不到了，
// 所以它必须排在 #18/#42 后面。vitest 在同一文件里按声明顺序执行。
import { beforeAll, describe, expect, it } from 'vitest'
import { ApiError, createHttp } from './client'
import { Code } from './codes'
import type { CategoryNode, CreateItemResult, ItemView, LocationNode, StoredImage } from './types'

const BASE = process.env.LIVE_API_BASE ?? 'http://localhost:8080'
const live = createHttp(BASE)

async function call<T>(method: string, path: string, token?: string, body?: unknown): Promise<T> {
  const res = await live.request<T>({
    method,
    url: path,
    data: body,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  })
  return res.data
}

/** multipart 只能自己组：axios 拿到普通对象会序列化成 JSON，后端 c.FormFile 就找不到字段了
 *  （api/uploads.ts 顶部交代的是同一件事，这里是在真后端上把它验一遍）。 */
async function upload(token: string, field: string, file: File): Promise<StoredImage> {
  const form = new FormData()
  form.append(field, file)
  const res = await live.post<StoredImage>('/api/uploads', form, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 60_000,
  })
  return res.data
}

async function expectCode(code: string, action: () => Promise<unknown>): Promise<ApiError> {
  try {
    await action()
  } catch (err) {
    expect(err, `期望 ${code}，实际抛的不是 ApiError`).toBeInstanceOf(ApiError)
    const e = err as ApiError
    expect(e.code, `期望 ${code}，实际 ${e.code}（request_id=${e.requestId}）`).toBe(code)
    return e
  }
  throw new Error(`期望 ${code}，结果请求成功了`)
}

function expectFields(obj: object, keys: string[]): void {
  const missing = keys.filter((k) => !(k in obj))
  expect(missing, `缺失字段：${missing.join(', ')}`).toEqual([])
}

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function flatten<N extends { children: N[] }>(nodes: N[]): N[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)])
}

// 一张真的 1×1 PNG。用真字节而不是伪造 Content-Type，是因为后端嗅探的是文件头 512 字节
// （http.DetectContentType）—— 这张图同时验到了「类型判定靠内容」这半条契约。
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function png(name = 'contract.png'): File {
  return new File([Buffer.from(PNG_1X1, 'base64')], name, { type: 'image/png' })
}

const TAG = `livepost${Date.now()}`
const PASSWORD = 'correct-horse-battery'

const seed = {
  tokenOwner: '',
  tokenOther: '',
  walletId: 0,
  libraryId: 0,
  /** 带一张图的主帖：#13 #15 #16 #42 #17 都挂在它身上，顺序见文件头。 */
  itemId: 0,
  imageId: 0,
  imagePath: '',
  /** 专门用来演示「image_paths 是整组替换」的那条帖。 */
  wipeId: 0,
}

beforeAll(async () => {
  await call('GET', '/api/health')

  const cats = await call<CategoryNode[]>('GET', '/api/categories')
  const locs = await call<LocationNode[]>('GET', '/api/locations')
  const wallet = flatten(cats).find((c) => c.name === '钱包')
  const library = flatten(locs).find((l) => l.name === '图书馆' && l.level === 3)
  if (!wallet || !library) throw new Error('字典里找不到 钱包 / 图书馆(三级叶子)，种子数据改过了')
  seed.walletId = wallet.id
  seed.libraryId = library.id

  // 每轮都注册新账号，不复用固定的：#18 的幂等那条要求起点是一个**干净的状态**，
  // 而 #42 删掉的图片永远回不来（文件已经删了），复用账号会让第二轮开始测上一轮的残骸。
  const register = async (who: string): Promise<string> => {
    const username = `${who}${TAG}`
    await call('POST', '/api/auth/register', undefined, { username, password: PASSWORD, nickname: who })
    const r = await call<{ token: string }>('POST', '/api/auth/login', undefined, {
      username,
      password: PASSWORD,
    })
    return r.token
  }
  seed.tokenOwner = await register('postowner')
  seed.tokenOther = await register('postother')
})

describe('#6 POST /api/uploads', () => {
  it('上传一张真 PNG 得到 {path,url}，url 就是 /uploads 前缀 + path', async () => {
    const img = await upload(seed.tokenOwner, 'file', png())
    expectFields(img, ['path', 'url'])
    // path 的形状是 service.IsUploadPath 的白名单：`2026/10/<随机>.<扩展名>`，不带前导斜杠。
    // 发帖时提交的就是这一个串，所以它长了什么样必须在前端钉住。
    expect(img.path).toMatch(/^\d{4}\/\d{2}\/[A-Za-z0-9_-]+\.(png|jpe?g|webp|gif)$/)
    expect(img.url).toBe(`/uploads/${img.path}`)
    seed.imagePath = img.path
  })

  it('字段名不写 file → VALIDATION，而且错误报在 file 上', async () => {
    const e = await expectCode(Code.VALIDATION, () => upload(seed.tokenOwner, 'fileToUpload', png()))
    // 这一条是 api/uploads.ts 里那个 form.append('file', ...) 的存亡理由：
    // 名字错了前端看不出任何异常，只会在后端变成一句「没有收到图片」。
    expect(e.errorFor('file'), `字段错误没报在 file 上：${JSON.stringify(e.fieldErrors)}`).toBeTruthy()
  })

  it('改了后缀的文本文件由内容嗅探拒掉 → FILE_TYPE_UNSUPPORTED', async () => {
    const fake = new File([Buffer.from('这张图其实是一段文字'.repeat(20), 'utf8')], 'photo.jpg', {
      type: 'image/jpeg',
    })
    await expectCode(Code.FILE_TYPE_UNSUPPORTED, () => upload(seed.tokenOwner, 'file', fake))
  })

  it('6MB 的文件 → FILE_TOO_LARGE（前端那条本地预检拦的就是同一个上限）', async () => {
    const big = new File([new Uint8Array(6 * 1024 * 1024)], 'big.png', { type: 'image/png' })
    await expectCode(Code.FILE_TOO_LARGE, () => upload(seed.tokenOwner, 'file', big))
  })

  it('匿名上传 → UNAUTHORIZED（图片目录不是公共可写区）', async () => {
    await expectCode(Code.UNAUTHORIZED, () => upload('', 'file', png()))
  })
})

describe('#13 POST /api/items 与图片的两条路径', () => {
  it('带 image_paths 发帖，详情里回的是 {id,url,sort_order} —— 而且没有 path', async () => {
    const created = await call<CreateItemResult>('POST', '/api/items', seed.tokenOwner, {
      item_type: 'lost',
      title: `${TAG} 黑色长款钱包`,
      description: `${TAG} 夹层角落有磨损`,
      category_id: seed.walletId,
      location_id: seed.libraryId,
      location_detail: '三楼自习区靠窗',
      last_seen_at: hoursAgo(3),
      lost_at: hoursAgo(2),
      contact: '13800000000',
      image_paths: [seed.imagePath],
    })
    expectFields(created, ['item'])
    seed.itemId = created.item.id

    const view = await call<ItemView>('GET', `/api/items/${seed.itemId}`, seed.tokenOwner)
    expect(view.images, '发了图却没进库').toHaveLength(1)
    expectFields(view.images[0], ['id', 'url', 'sort_order'])
    seed.imageId = view.images[0].id
    // 这一条是片 3 那个「编辑模式不能加图」的唯一原因，所以它必须钉在契约里而不是只写在注释里：
    // #15 不把 path 给出来，客户端就重建不出「原有那些 + 新加那张」的完整集合，
    // 而 #16 的 image_paths 是整组替换 —— 一发就会把原图全删掉。
    expect('path' in view.images[0], '#15 的图片项里出现了 path，编辑表单那条限制可以撤了').toBe(false)
  })

  it('把 url 当成 path 提交 → VALIDATION（前端必须提交 #6 的 path 字段）', async () => {
    await expectCode(Code.VALIDATION, () =>
      call('POST', '/api/items', seed.tokenOwner, {
        item_type: 'lost',
        title: `${TAG} 用错了路径形状`,
        description: 'x',
        category_id: seed.walletId,
        location_id: seed.libraryId,
        location_detail: '',
        last_seen_at: hoursAgo(3),
        lost_at: hoursAgo(2),
        contact: '13800000000',
        image_paths: [`/uploads/${seed.imagePath}`],
      }),
    )
  })

  it('时间少了时区偏移 → VALIDATION（datetime-local 那个串不能直接发）', async () => {
    await expectCode(Code.VALIDATION, () =>
      call('POST', '/api/items', seed.tokenOwner, {
        item_type: 'lost',
        title: `${TAG} 时间没带时区`,
        description: 'x',
        category_id: seed.walletId,
        location_id: seed.libraryId,
        location_detail: '',
        last_seen_at: '2026-10-07T15:04',
        lost_at: hoursAgo(2),
        contact: '13800000000',
      }),
    )
  })

  it('lost 帖的响应带 matches_preview（空也要是 []），并且没有 notified_count', async () => {
    const created = await call<CreateItemResult>('POST', '/api/items', seed.tokenOwner, {
      item_type: 'lost',
      title: `${TAG} 用来验互斥键的空帖`,
      description: '钥匙扣上挂着一只小熊',
      category_id: seed.walletId,
      location_id: seed.libraryId,
      location_detail: '',
      last_seen_at: hoursAgo(5),
      lost_at: hoursAgo(4),
      contact: '13800000000',
    })
    expect('matches_preview' in created, '发布成功页的 lost 分支没有 matches_preview 这个键').toBe(true)
    expect(Array.isArray(created.matches_preview)).toBe(true)
    expect(created.notified_count, 'lost 方向不通知任何人，这个键不该出现').toBeUndefined()
  })
})

describe('#16 PUT /api/items/:id', () => {
  it('不带 image_paths 改帖 → 图片一张都不动', async () => {
    const before = await call<ItemView>('GET', `/api/items/${seed.itemId}`, seed.tokenOwner)
    const view = await call<ItemView>('PUT', `/api/items/${seed.itemId}`, seed.tokenOwner, {
      title: `${TAG} 黑色长款钱包（改过一次）`,
      description: before.description,
      category_id: before.category.id,
      location_id: before.location.id,
      location_detail: before.location_detail,
      last_seen_at: before.last_seen_at,
      lost_at: before.lost_at,
      found_at: '',
      contact: before.contact,
    })
    expect(view.title).toBe(`${TAG} 黑色长款钱包（改过一次）`)
    expect(view.images, '没提交 image_paths 却把图删了 —— 整组替换语义被破坏了').toHaveLength(
      before.images.length,
    )
  })

  it('提交 image_paths: [] 是「全删」而不是「不动」', async () => {
    const created = await call<CreateItemResult>('POST', '/api/items', seed.tokenOwner, {
      item_type: 'lost',
      title: `${TAG} 要被清空图片的帖`,
      description: 'x',
      category_id: seed.walletId,
      location_id: seed.libraryId,
      location_detail: '',
      last_seen_at: hoursAgo(3),
      lost_at: hoursAgo(2),
      contact: '13800000000',
      image_paths: [seed.imagePath],
    })
    seed.wipeId = created.item.id

    const view = await call<ItemView>('PUT', `/api/items/${seed.wipeId}`, seed.tokenOwner, {
      title: `${TAG} 要被清空图片的帖`,
      description: 'x',
      category_id: seed.walletId,
      location_id: seed.libraryId,
      location_detail: '',
      last_seen_at: hoursAgo(3),
      lost_at: hoursAgo(2),
      found_at: '',
      contact: '13800000000',
      image_paths: [],
    })
    // 这就是 PostFormPage 在编辑模式下**一个 image_paths 都不发**的原因：
    // 少这一行的语义是「不动」，多这一行的语义是「全删」，而中间没有「只加一张」。
    expect(view.images).toHaveLength(0)
  })

  it('不是本人改帖 → FORBIDDEN（详情页因此对别人不渲染「修改」入口）', async () => {
    await expectCode(Code.FORBIDDEN, () =>
      call('PUT', `/api/items/${seed.itemId}`, seed.tokenOther, {
        title: '别人替我改的标题',
        description: 'x',
        category_id: seed.walletId,
        location_id: seed.libraryId,
        location_detail: '',
        last_seen_at: hoursAgo(3),
        lost_at: hoursAgo(2),
        found_at: '',
        contact: '13800000000',
      }),
    )
  })
})

describe('#18 PATCH /api/items/:id/status', () => {
  it('data 只有 {id,status}，关帖之后广场的 open 筛选里就查不到它', async () => {
    const r = await call<{ id: number; status: string }>(
      'PATCH',
      `/api/items/${seed.itemId}/status`,
      seed.tokenOwner,
      { status: 'closed' },
    )
    expectFields(r, ['id', 'status'])
    expect(r.id).toBe(seed.itemId)
    expect(r.status).toBe('closed')

    // 用本轮的编号当关键字筛，而不是翻第一页找它：开发库里已经有前面几轮的帖子，
    // 「没在第 20 条里出现」既可能是因为被关了，也可能只是因为排在第二页 —— 那种断言是空的。
    const open = await call<{ list: { id: number }[] }>(
      'GET',
      `/api/items?status=open&keyword=${TAG}`,
      seed.tokenOwner,
    )
    expect(open.list.some((i) => i.id === seed.itemId), '关了帖却还在 open 名单里').toBe(false)
    const closed = await call<{ list: { id: number }[] }>(
      'GET',
      `/api/items?status=closed&keyword=${TAG}`,
      seed.tokenOwner,
    )
    expect(closed.list.some((i) => i.id === seed.itemId), 'closed 筛选里找不到刚关的那条').toBe(true)
  })

  it('重复关同一个帖 → 还是成功（幂等），前端连点两次不该收到 409', async () => {
    const r = await call<{ status: string }>('PATCH', `/api/items/${seed.itemId}/status`, seed.tokenOwner, {
      status: 'closed',
    })
    expect(r.status).toBe('closed')
  })

  it('把 deleted 从这条路由递过去 → VALIDATION（下架是治理动作，走 #43）', async () => {
    const e = await expectCode(Code.VALIDATION, () =>
      call('PATCH', `/api/items/${seed.itemId}/status`, seed.tokenOwner, { status: 'deleted' }),
    )
    expect(e.errorFor('status'), `字段错误没报在 status 上：${JSON.stringify(e.fieldErrors)}`).toBeTruthy()
  })

  it('不是本人 → FORBIDDEN（admin 也不行：#18 的 Auth 列写的就是「本人」）', async () => {
    await expectCode(Code.FORBIDDEN, () =>
      call('PATCH', `/api/items/${seed.itemId}/status`, seed.tokenOther, { status: 'open' }),
    )
  })

  it('关完再开回来，status 跟着变', async () => {
    const r = await call<{ status: string }>('PATCH', `/api/items/${seed.itemId}/status`, seed.tokenOwner, {
      status: 'open',
    })
    expect(r.status).toBe('open')
  })
})

describe('#42 DELETE /api/item-images/:id', () => {
  it('别人删不动', async () => {
    await expectCode(Code.FORBIDDEN, () =>
      call('DELETE', `/api/item-images/${seed.imageId}`, seed.tokenOther),
    )
  })

  it('本人删掉之后详情少一张，再删同一个 id → NOT_FOUND', async () => {
    await call('DELETE', `/api/item-images/${seed.imageId}`, seed.tokenOwner)
    const view = await call<ItemView>('GET', `/api/items/${seed.itemId}`, seed.tokenOwner)
    expect(view.images).toHaveLength(0)
    await expectCode(Code.NOT_FOUND, () => call('DELETE', `/api/item-images/${seed.imageId}`, seed.tokenOwner))
  })
})

describe('#17 DELETE /api/items/:id（软删，无撤销）', () => {
  it('作者删掉之后：匿名读是 NOT_FOUND，作者自己读得到 deleted', async () => {
    await call('DELETE', `/api/items/${seed.itemId}`, seed.tokenOwner)

    await expectCode(Code.NOT_FOUND, () => call('GET', `/api/items/${seed.itemId}`))
    const mine = await call<ItemView>('GET', `/api/items/${seed.itemId}`, seed.tokenOwner)
    expect(mine.status).toBe('deleted')
  })

  it('重复删 → ITEM_CLOSED，而不是当成功（前端两步删除的第二次点击就该看到这句）', async () => {
    await expectCode(Code.ITEM_CLOSED, () =>
      call('DELETE', `/api/items/${seed.itemId}`, seed.tokenOwner),
    )
  })

  it('删完之后 #18 也动不了它 → ITEM_CLOSED', async () => {
    await expectCode(Code.ITEM_CLOSED, () =>
      call('PATCH', `/api/items/${seed.itemId}/status`, seed.tokenOwner, { status: 'open' }),
    )
  })
})
