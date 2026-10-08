// src/api/contract.returns.live.test.ts —— 片 5 那十条端点：#23–#29 + #30 #31 #32。
//
// 这一节必须真打，不能靠 msw 的理由比前几片更硬：这一族的所有判断都在**服务端的事务里**，
// 假响应是照着前端类型写的，类型是我自己写的，于是「测过了」在这里只意味着「我信了自己的猜测」。
// 具体到只有真后端能回答的问题：
//   ① #23 那五道判据的**顺序**（③排在④前面、④排在⑤前面、①排在所有查库之前）——
//      顺序错了不会报错，只会把一句用户当下能改的话换成一句他改不了的话；
//   ② RETURN_DUPLICATE 那条唯一索引到底建在什么键上（决定「一条帖子上能不能同时挂着好几个人的 pending」，
//      而那一屏的列表文案全押在这件事上）；
//   ③ #25 一次调用连带六件事（改记录、关帖、两处加分、两条流水、若干条通知），
//      跨了五张表，假响应里这些后果一个都不会自己长出来；
//   ④ #32 的 ids/all 二选一：指针字段的「没带」和「带了但是 false」在 JSON 里是两种形状，
//      只有真解析器会区分它们。
//
// 跑法同其它 live 文件：`npm run test:live`（需要后端已在 8080 上起）。
// 它会在开发库里留下四个用户、四条帖子、三行归还确认和若干通知。留着不清理，
// 理由和前面几片一样：这一族的行没有任何删除端点给普通用户（#46 是 admin 的），
// 而且这些行正是 §13 第 4 步那条完整动线的物证。
import { beforeAll, describe, expect, it } from 'vitest'
import { ApiError, createHttp } from './client'
import { Code } from './codes'
import type {
  CancelReturnResult,
  ConfirmReturnResult,
  CreditHistory,
  DecideReturnResult,
  ItemSummary,
  ItemView,
  NotificationView,
  Page,
  ReturnDetailView,
  ReturnEntry,
  SubmitReturnResult,
  UserView,
} from './types'

const BASE = process.env.LIVE_API_BASE ?? 'http://localhost:8080'
const live = createHttp(BASE)

function expectFields(obj: object, keys: string[]): void {
  const missing = keys.filter((k) => !(k in obj))
  expect(missing, `缺失字段：${missing.join(', ')}`).toEqual([])
}

function expectAbsent(obj: object, keys: string[]): void {
  const leaked = keys.filter((k) => k in obj)
  expect(leaked, `不该出现的字段：${leaked.join(', ')}`).toEqual([])
}

async function call<T>(method: string, path: string, token?: string, body?: unknown): Promise<T> {
  const res = await live.request<T>({
    method,
    url: path,
    data: body,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
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

const TAG = `ret${Date.now()}`
const PASSWORD = 'correct-horse-battery'

/** 一张「凭证图」。#23 对 proof_image_path 只校验**形状**（IsUploadPath 那一条白名单正则），
 *  不查磁盘 —— 这一条本身就是要钉的契约：真上传（#6）不是提交归还确认的前置条件，
 *  所以这里可以造一个形状正确的假 path，而不必先搭 multipart。 */
const PROOF = '2026/10/0123456789abcdef0123456789abcdef.jpg'

const seed = {
  /** 拾主：三条 found 帖 + 一条 lost 帖的作者，#25/#26 的唯一合法actor */
  tokenOwner: '',
  ownerId: 0,
  /** 失主甲：这一片的主角，提交、被拒、再提交、被确认 */
  tokenClaimant: '',
  claimantId: 0,
  /** 失主乙：只为钉住「唯一索引不是按帖子建的」而存在 */
  tokenClaimant2: '',
  claimant2Id: 0,
  /** 路人：什么都不是，用来撞 FORBIDDEN */
  tokenOutsider: '',
  /** A：全流程那条；B：被拾主自己关掉的那条；C：lost 帖；D：被软删的那条；
   *  E：撤销用的那条（提交后被删）；F：只用来撞 500 字上限的那条（一直开着） */
  itemA: 0,
  itemB: 0,
  itemC: 0,
  itemD: 0,
  itemE: 0,
  itemF: 0,
  /** 三条归还确认的 id，按发生顺序 */
  ret1: 0,
  ret2: 0,
  ret3: 0,
}

beforeAll(async () => {
  await call('GET', '/api/health')

  const register = async (who: string, nickname: string): Promise<{ token: string; id: number }> => {
    const username = `${who}${TAG}`
    const r = await call<{ id: number }>('POST', '/api/auth/register', undefined, {
      username,
      password: PASSWORD,
      nickname,
    })
    const login = await call<{ token: string }>('POST', '/api/auth/login', undefined, {
      username,
      password: PASSWORD,
    })
    return { token: login.token, id: r.id }
  }
  const owner = await register('retnet', '契约拾主')
  const claimant = await register('ret甲', '契约失主甲')
  const claimant2 = await register('ret乙', '契约失主乙')
  const outsider = await register('ret路', '契约路人')
  seed.tokenOwner = owner.token
  seed.ownerId = owner.id
  seed.tokenClaimant = claimant.token
  seed.claimantId = claimant.id
  seed.tokenClaimant2 = claimant2.token
  seed.claimant2Id = claimant2.id
  seed.tokenOutsider = outsider.token

  const cats = await call<Array<{ id: number; children: Array<{ id: number }> }>>('GET', '/api/categories')
  const locs = await call<Array<{ id: number; children: Array<{ id: number; children: Array<{ id: number }> }> }>>(
    'GET',
    '/api/locations',
  )
  const category = cats[0]?.children[0]
  const location = locs[0]?.children[0]?.children[0]
  if (!category || !location) throw new Error('字典种子数据拿不到可用的叶子节点，这一节没法造帖子')

  const post = async (type: 'found' | 'lost', title: string): Promise<number> => {
    const body: Record<string, unknown> = {
      item_type: type,
      title: `${TAG} ${title}`,
      description: `${TAG} 夹层有磨损，内有校园卡一张`,
      category_id: category.id,
      location_id: location.id,
      location_detail: '一楼服务台',
      contact: `wx_${TAG}`,
    }
    // lost 和 found 的时间列不是同一组，#13 按类型校验，所以这里不能偷懒共用一个。
    const now = new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    if (type === 'found') body.found_at = now
    else {
      body.last_seen_at = now
      body.lost_at = now
    }
    const created = await call<{ item: ItemView }>('POST', '/api/items', seed.tokenOwner, body)
    return created.item.id
  }
  seed.itemA = await post('found', '捡到一串带红色挂绳的钥匙')
  seed.itemB = await post('found', '捡到一副黑色蓝牙耳机')
  seed.itemC = await post('lost', '丢了一张校园卡')
  seed.itemD = await post('found', '捡到一把折叠伞')
  seed.itemE = await post('found', '捡到一张图书馆的入场券')
  seed.itemF = await post('found', '捡到一叠高等数学讲义')
})

describe('#23 POST /api/items/:id/returns 的判据与顺序', () => {
  it('字段校验排在所有查库之前：一个不存在的帖子 + 一句太短的说明，拿到的是 message 而不是 NOT_FOUND', async () => {
    // 这一条钉的是 service 注释里那句「字段错了应该先说字段错了，那是用户当下能改的东西」。
    // 顺序反过来时症状是：用户改了说明、换了图，第二次才被告知「帖子不存在」。
    const e = await expectCode(Code.VALIDATION, () =>
      call('POST', '/api/items/99999999/returns', seed.tokenClaimant, {
        message: '太短',
        proof_image_path: PROOF,
      }),
    )
    expect(e.errorFor('message'), `字段错误没报在 message 上：${JSON.stringify(e.fieldErrors)}`).toBeTruthy()
    expect(e.message).toContain('归还说明')
  })

  it('凭证图要的是 path 而不是 url，形状不对时报在 proof_image_path 上', async () => {
    // /uploads 开头那个是**给 <img src> 用的**，直接塞进来就是这条断言要拦的写法。
    const e = await expectCode(Code.VALIDATION, () =>
      call('POST', `/api/items/${seed.itemA}/returns`, seed.tokenClaimant, {
        message: '钥匙上有一截褪色的红挂绳，挂环边上有刻痕',
        proof_image_path: `/uploads/${PROOF}`,
      }),
    )
    expect(e.errorFor('proof_image_path')).toBeTruthy()

    const empty = await expectCode(Code.VALIDATION, () =>
      call('POST', `/api/items/${seed.itemA}/returns`, seed.tokenClaimant, {
        message: '钥匙上有一截褪色的红挂绳，挂环边上有刻痕',
        proof_image_path: '',
      }),
    )
    expect(empty.errorFor('proof_image_path')).toBeTruthy()
  })

  it('软删的帖子给 NOT_FOUND：#23 判据②，前端因此在 deleted 的详情页上不放这个入口', async () => {
    await call('DELETE', `/api/items/${seed.itemD}`, seed.tokenOwner)
    await expectCode(Code.NOT_FOUND, () =>
      call('POST', `/api/items/${seed.itemD}/returns`, seed.tokenClaimant, {
        message: '伞柄上缠了一圈蓝色胶带，是我自己缠的',
        proof_image_path: PROOF,
      }),
    )
  })

  it('lost 帖给的是 VALIDATION 而且报在 id 上，不是 NOT_FOUND（判据③）', async () => {
    // 方向反了这件事后端选择用「校验失败」表达，前端如果把它当成 404，
    // 失主会以为自己的帖子没了，而不是「这条路本来就不存在」。
    const e = await expectCode(Code.VALIDATION, () =>
      call('POST', `/api/items/${seed.itemC}/returns`, seed.tokenClaimant, {
        message: '卡号后四位是 3391，卡套是灰色的',
        proof_image_path: PROOF,
      }),
    )
    expect(e.errorFor('id'), `那条 VALIDATION 应报在 id 上：${JSON.stringify(e.fieldErrors)}`).toBeTruthy()
  })

  it('③排在④前面：拾主对自己的 lost 帖点归还确认，听到的是「失物帖不需要」而不是「不能对自己提交」', async () => {
    // 判断顺序错了的症状在后端注释里写得很具体：人会困惑地去发一条 found 帖试试。
    await expectCode(Code.VALIDATION, () =>
      call('POST', `/api/items/${seed.itemC}/returns`, seed.tokenOwner, {
        message: '这张卡就是我丢的那一张',
        proof_image_path: PROOF,
      }),
    )
  })

  it('④排在⑤前面：closed 的**自己的**帖子给 RETURN_SELF，而不是 ITEM_CLOSED', async () => {
    // 先把 B 关掉（拾主自己 #18），再让他对自己那条点归还确认。
    await call('PATCH', `/api/items/${seed.itemB}/status`, seed.tokenOwner, { status: 'closed' })
    await expectCode(Code.RETURN_SELF, () =>
      call('POST', `/api/items/${seed.itemB}/returns`, seed.tokenOwner, {
        message: '这是我自己的耳机，我把它捡起来放在了桌上',
        proof_image_path: PROOF,
      }),
    )
  })

  it('⑤：别人对一条 closed 的帖子提交 → ITEM_CLOSED（closed 的帖子不收新的归还确认）', async () => {
    await expectCode(Code.ITEM_CLOSED, () =>
      call('POST', `/api/items/${seed.itemB}/returns`, seed.tokenClaimant, {
        message: '耳机盒右下角有我的缩写，是我刻的',
        proof_image_path: PROOF,
      }),
    )
  })

  it('提交成功：data 是 {id, item_id, status: pending, submitted_at}，而且不需要先解锁过联系方式', async () => {
    // 整个流程里 seed.tokenClaimant 从没打过 #21 —— §12 的 M5 冒烟第一条就是这个。
    // 前端若在提交前强制解锁，这一条会「看起来也能过」，而 API 的门槛被偷偷加高了。
    const r = await call<SubmitReturnResult>('POST', `/api/items/${seed.itemA}/returns`, seed.tokenClaimant, {
      message: '钥匙串上有一截褪色的红挂绳，挂环边上有我自己锉出的刻痕',
      proof_image_path: PROOF,
    })
    expectFields(r, ['id', 'item_id', 'status', 'submitted_at'])
    expect(r.item_id).toBe(seed.itemA)
    expect(r.status).toBe('pending')
    expect(r.submitted_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    seed.ret1 = r.id
  })

  it('匿名提交 → UNAUTHORIZED', async () => {
    await expectCode(Code.UNAUTHORIZED, () =>
      call('POST', `/api/items/${seed.itemA}/returns`, undefined, {
        message: '这串钥匙是我丢的，挂绳是我自己系的',
        proof_image_path: PROOF,
      }),
    )
  })

  it('RETURN_DUPLICATE 的唯一索引建在 (item_id, submitter_id) 上：同一个人挡两次，两个人各挂一条', async () => {
    // 这一条决定列表页的文案。若它真是「按帖子唯一」，
    // 「已经有 3 人在等你处理」那种话就不该出现 —— 而现在它是正常的。
    await expectCode(Code.RETURN_DUPLICATE, () =>
      call('POST', `/api/items/${seed.itemA}/returns`, seed.tokenClaimant, {
        message: '再交一次，说的是同一串钥匙，挂绳是我自己系的',
        proof_image_path: PROOF,
      }),
    )

    const second = await call<SubmitReturnResult>('POST', `/api/items/${seed.itemA}/returns`, seed.tokenClaimant2, {
      message: '钥匙里有一把是铜色的旧式五齿，和我家抽屉锁配过',
      proof_image_path: PROOF,
    })
    expect(second.status).toBe('pending')
    seed.ret2 = second.id

    const received = await call<Page<ReturnEntry>>(
      'GET',
      '/api/my/returns/received?status=pending',
      seed.tokenOwner,
    )
    expect(received.list.filter((e) => e.status === 'pending').length, '一条帖子上该同时挂着两条 pending').toBe(2)
  })
})

describe('#24 GET /api/returns/:id', () => {
  it('提交人读得到自己那一条，message / proof_image_url / submitter 三样只在详情里有', async () => {
    const d = await call<ReturnDetailView>('GET', `/api/returns/${seed.ret1}`, seed.tokenClaimant)
    expectFields(d, [
      'id',
      'item',
      'submitter',
      'message',
      'proof_image_url',
      'status',
      'owner_note',
      'reviewer_id',
      'review_kind',
      'submitted_at',
      'reviewed_at',
    ])
    expect(d.message).toContain('褪色的红挂绳')
    // 后端把存的 path 拼成 /uploads 前缀的 url 再返回，和 #15 的图集同一套做法。
    expect(d.proof_image_url).toBe(`/uploads/${PROOF}`)
    expectFields(d.submitter, ['id', 'nickname', 'credit_score'])
    expect(d.submitter.id).toBe(seed.claimantId)
    // pending 时「还没有」在这三个键上有两种表示法，前端不许写反（见 types.ts 的那段注释）。
    expect(d.reviewer_id, 'pending 时 reviewer_id 该是 null').toBeNull()
    expect(d.review_kind).toBeNull()
    expect(d.reviewed_at, 'pending 时 reviewed_at 该是空串而不是 null').toBe('')
    expect(d.owner_note).toBe('')
    // 详情里嵌的那份 item 走的是 summary 形状：contact 恒 null、removal 恒不出现。
    expect(d.item.contact, '#24 这条路不该把联系方式带出来').toBeNull()
    expect(d.item.removal).toBeUndefined()
  })

  it('发帖人也读得到同一条：判断现场需要那张凭证图', async () => {
    const d = await call<ReturnDetailView>('GET', `/api/returns/${seed.ret1}`, seed.tokenOwner)
    expect(d.id).toBe(seed.ret1)
    expect(d.proof_image_url).toBe(`/uploads/${PROOF}`)
  })

  it('路人读 → FORBIDDEN，而不是 NOT_FOUND（存在性不是要保密的事，身份才是）', async () => {
    await expectCode(Code.FORBIDDEN, () => call('GET', `/api/returns/${seed.ret1}`, seed.tokenOutsider))
  })

  it('匿名读 → UNAUTHORIZED；不存在的 id → NOT_FOUND', async () => {
    await expectCode(Code.UNAUTHORIZED, () => call('GET', `/api/returns/${seed.ret1}`))
    await expectCode(Code.NOT_FOUND, () => call('GET', '/api/returns/99999999', seed.tokenClaimant))
  })
})

describe('#26 POST /api/returns/:id/reject（先拒后确，因为它不改变帖子状态）', () => {
  it('拒绝必须留下为什么：空 body 在 bindJSON 就被拦，空串/纯空白报在 owner_note 上（这一点和 #25 相反）', async () => {
    // #25 用 bindJSONOptional、这条用严格 bindJSON。假后端不会区分这两种形状，
    // 而「把两条都写成 body 可选」的前端会让发帖人点完拒绝、对方什么也没收到解释。
    const noBody = await expectCode(Code.VALIDATION, () =>
      call('POST', `/api/returns/${seed.ret1}/reject`, seed.tokenOwner),
    )
    // 一个字段错误都没有：这一句是在 JSON 层就失败了，还没走到业务校验。
    // 前端的 rejectReturn 永远带 {owner_note}，就是为了不落到这条路上（那句话对用户没有意义）。
    expect(noBody.fieldErrors ?? [], `空 body 不该带字段错误：${JSON.stringify(noBody.fieldErrors)}`).toHaveLength(0)

    // 带了键但值是空的：这才是 normalizeOwnerNote(raw, true) 那一处，报在 owner_note 上。
    for (const blank of ['', '   ']) {
      const e = await expectCode(Code.VALIDATION, () =>
        call('POST', `/api/returns/${seed.ret1}/reject`, seed.tokenOwner, { owner_note: blank }),
      )
      expect(e.errorFor('owner_note'), `空备注该报在 owner_note 上：${JSON.stringify(e.fieldErrors)}`).toBeTruthy()
    }
  })

  it('路人拒绝 → FORBIDDEN，而且权限排在字段之前（带了四百字的备注也听不到 VALIDATION）', async () => {
    // 这一条是那个顺序的**唯一**可观测面：状态和权限都不该由一个路人通过报错类型试探出来。
    const e = await expectCode(Code.FORBIDDEN, () =>
      call('POST', `/api/returns/${seed.ret1}/reject`, seed.tokenOutsider, {
        owner_note: '我不是拾主，但我要试试这条的校验在前还是在后'.repeat(20),
      }),
    )
    expect(e.httpStatus, '权限问题不该以 400 出现').toBe(403)
  })

  it('拒绝只留下一行状态和一句备注：不关帖、不扣分、响应里连 credit_delta 这个键都没有', async () => {
    const before = await call<ItemView>('GET', `/api/items/${seed.itemA}`, seed.tokenOwner)
    // 先立基线：不这样下面那句「拒绝之后还是 open」就是空的 —— 一条本来就关着的帖子
    // 关不关都一样，而这一条要钉的正是「拒绝没有动它」。
    expect(before.status, '拒绝之前这条得是 open，否则下面的对照没有意义').toBe('open')
    const creditBefore = await call<CreditHistory>('GET', '/api/my/credit-logs', seed.tokenClaimant)

    const r = await call<DecideReturnResult>('POST', `/api/returns/${seed.ret1}/reject`, seed.tokenOwner, {
      owner_note: '挂绳是红色的没错，但那截是我后来自己换的，说明不了更多',
    })
    expectFields(r, ['id', 'status', 'reviewed_at'])
    expectAbsent(r, ['credit_delta'])
    expect(r.status).toBe('rejected')
    expect(r.reviewed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const after = await call<ItemView>('GET', `/api/items/${seed.itemA}`, seed.tokenOwner)
    expect(after.status, '拒绝不该顺手把帖子关掉').toBe('open')
    const creditAfter = await call<CreditHistory>('GET', '/api/my/credit-logs', seed.tokenClaimant)
    expect(creditAfter.credit_score, '拒绝不扣分是这套系统的立场').toBe(creditBefore.credit_score)
    // 备注被原样存下来，而它是提交人唯一能得到的解释 —— #24 读回来必须还在。
    const d = await call<ReturnDetailView>('GET', `/api/returns/${seed.ret1}`, seed.tokenClaimant)
    expect(d.owner_note).toBe('挂绳是红色的没错，但那截是我后来自己换的，说明不了更多')
    expect(d.status).toBe('rejected')
  })

  it('拒绝不拦着对方重新提交：被拒之后再交一次会得到一条全新的 pending', async () => {
    // 这是「认领非排他」在这一族的落点。若后端在这里做「同一人只能提交一次」，
    // 前端就不该给被拒的人一个「再提交一次」的出口。
    const again = await call<SubmitReturnResult>('POST', `/api/items/${seed.itemA}/returns`, seed.tokenClaimant, {
      message: '补充一个只有我才知道的细节：挂环上拴着一枚洗到发白的蓝色小铃铛',
      proof_image_path: PROOF,
    })
    expect(again.status).toBe('pending')
    expect(again.id, '重提该是一行新记录，而不是把 rejected 那行改回 pending').not.toBe(seed.ret1)
    seed.ret3 = again.id
  })

  it('被拒的那条现在再拒 → RETURN_ILLEGAL_TRANSITION（状态机只认 pending 出发的两条边）', async () => {
    await expectCode(Code.RETURN_ILLEGAL_TRANSITION, () =>
      call('POST', `/api/returns/${seed.ret1}/reject`, seed.tokenOwner, { owner_note: '再拒一次' }),
    )
  })
})

describe('#27 POST /api/returns/:id/cancel', () => {
  it('只有提交人能撤销，而且后端连 body 都不读', async () => {
    await expectCode(Code.FORBIDDEN, () =>
      call('POST', `/api/returns/${seed.ret2}/cancel`, seed.tokenOwner),
    )

    const r = await call<CancelReturnResult>('POST', `/api/returns/${seed.ret2}/cancel`, seed.tokenClaimant2)
    expectFields(r, ['id', 'status'])
    expectAbsent(r, ['reviewed_at'])
    // 撤销不是「处理」，后端刻意不给处理时间（给了就等于把它当成一次判断）。
    expect(r.status).toBe('cancelled')
  })

  it('撤销不查 items 表：帖子已经被软删了，我依然能撤掉自己那条主张', async () => {
    // 「#27 不读 items」这件事只有在这里才可测：先趁 E 还在架上提交，再把 E 删掉，然后撤销。
    // 「我不再主张了」不需要帖子还在 —— 反过来说，若后端在这里读帖子，
    // 前端就不该在已删帖子的收件行上放撤销按钮。
    const orphan = await call<SubmitReturnResult>('POST', `/api/items/${seed.itemE}/returns`, seed.tokenOutsider, {
      message: '我先提交一条，再把帖子删掉，用来证明撤销不看帖子在不在架上',
      proof_image_path: PROOF,
    })
    await call('DELETE', `/api/items/${seed.itemE}`, seed.tokenOwner)

    const r = await call<CancelReturnResult>('POST', `/api/returns/${orphan.id}/cancel`, seed.tokenOutsider)
    expect(r.status).toBe('cancelled')
  })

  it('撤销是零通知：提交给拾主加了一条未读，撤销之后它一条没多', async () => {
    // 「零副作用」里最容易被忘掉的是通知。这一条分两半步走：
    // 先证明提交这一步确实 +1（否则整段断言会因为「一直是 0」而假绿），
    // 再证明撤销不再 +1 —— 既不给自己发回执，也不给拾主补一条「他撤回了」。
    const ownerBefore = await call<{ count: number }>(
      'GET',
      '/api/my/notifications/unread-count',
      seed.tokenOwner,
    )
    const mineBefore = await call<{ count: number }>(
      'GET',
      '/api/my/notifications/unread-count',
      seed.tokenOutsider,
    )

    const one = await call<SubmitReturnResult>('POST', `/api/items/${seed.itemA}/returns`, seed.tokenClaimant2, {
      message: '这条注定撤销：钥匙串里那把铜色的五齿，和我家抽屉其实配不上',
      proof_image_path: PROOF,
    })
    const ownerMid = await call<{ count: number }>('GET', '/api/my/notifications/unread-count', seed.tokenOwner)
    expect(ownerMid.count, '提交该给拾主留下一条未读').toBe(ownerBefore.count + 1)

    await call('POST', `/api/returns/${one.id}/cancel`, seed.tokenClaimant2)
    const ownerAfter = await call<{ count: number }>('GET', '/api/my/notifications/unread-count', seed.tokenOwner)
    expect(ownerAfter.count, '撤销不该再给拾主发一条').toBe(ownerMid.count)
    const mineAfter = await call<{ count: number }>('GET', '/api/my/notifications/unread-count', seed.tokenOutsider)
    expect(mineAfter.count, '撤销也不给提交人自己发回执').toBe(mineBefore.count)
  })
})

describe('#25 POST /api/returns/:id/confirm', () => {
  it('owner_note 是可选的：不带 body 也能确认（这一处是全项目唯一用 bindJSONOptional 的 POST）', async () => {
    const before = await call<UserView>('GET', '/api/auth/me', seed.tokenOwner)
    const claimantBefore = await call<CreditHistory>('GET', '/api/my/credit-logs', seed.tokenClaimant)

    const r = await call<ConfirmReturnResult>('POST', `/api/returns/${seed.ret3}/confirm`, seed.tokenOwner)
    expectFields(r, ['id', 'status', 'reviewed_at', 'credit_delta'])
    expect(r.status).toBe('confirmed')
    // 新账号离 200 封顶还远，所以这里的增量就是名义值：拾主 +10。
    expect(r.credit_delta, 'credit_delta 是调用者自己那一份，不是双方各加').toBe(10)

    const after = await call<UserView>('GET', '/api/auth/me', seed.tokenOwner)
    expect(after.credit_score).toBe(before.credit_score + 10)
    // 提交人的 +2 **不在**这个响应里，只能从他的那一侧读到 —— 前端不许拿 credit_delta 显示双方。
    const claimantAfter = await call<CreditHistory>('GET', '/api/my/credit-logs', seed.tokenClaimant)
    expect(claimantAfter.credit_score).toBe(claimantBefore.credit_score + 2)
    expect(claimantAfter.list.length, '加分要有流水可对账，不是只改一个数').toBeGreaterThan(0)
  })

  it('一次确认连带关帖：#15 读回来是 closed，而广场默认不再列它 —— 要看它得显式选 status=closed', async () => {
    const item = await call<ItemView>('GET', `/api/items/${seed.itemA}`, seed.tokenOwner)
    expect(item.status, '确认后帖子该跟着关掉').toBe('closed')

    // #14 的 statusPolicy 是 Default=[open]、Allowed=[open,closed]：不带 status 就是只看开着的那些。
    // 这一对断言钉的是广场那一栏「状态」筛选的存在理由 —— 默认视图里消失不是丢了，
    // 而是被这一条规则挡在默认档之外，前端如果只发默认请求，用户就永远找不到已归还的那批。
    const plaza = await call<Page<ItemSummary>>('GET', `/api/items?keyword=${encodeURIComponent(TAG)}`)
    expect(
      plaza.list.some((i) => i.id === seed.itemA),
      'closed 的帖子不该出现在默认（open）那一档里',
    ).toBe(false)

    const closedOnly = await call<Page<ItemSummary>>(
      'GET',
      `/api/items?status=closed&keyword=${encodeURIComponent(TAG)}`,
    )
    expect(
      closedOnly.list.some((i) => i.id === seed.itemA),
      '显式要 closed 时它该回来（这解释了广场为什么必须有那个筛选器）',
    ).toBe(true)
  })

  it('确认之后 #24 的三个「谁审的」键同时落地，review_kind 是 owner', async () => {
    // review_kind 只有 owner / admin_data_fix 两种值，前端不许把它们显示成同一句「已处理」。
    const d = await call<ReturnDetailView>('GET', `/api/returns/${seed.ret3}`, seed.tokenClaimant)
    expect(d.status).toBe('confirmed')
    expect(d.reviewer_id).toBe(seed.ownerId)
    expect(d.review_kind).toBe('owner')
    expect(d.reviewed_at).not.toBe('')
    expect(d.owner_note, '不带备注确认时这一格是空串').toBe('')
  })

  it('重复确认 → RETURN_ILLEGAL_TRANSITION：409 对发帖人是有用的（那条已经处理过了，刷新一下）', async () => {
    await expectCode(Code.RETURN_ILLEGAL_TRANSITION, () =>
      call('POST', `/api/returns/${seed.ret3}/confirm`, seed.tokenOwner, { owner_note: '再点一次' }),
    )
  })

  it('超过 500 字的备注被拒，而且校验发生在写之前（同一条上限 confirm 和 reject 共用）', async () => {
    // normalizeOwnerNote 那一句 trim+500 是 confirm 和 reject 共用的（service 里两边都调它），
    // 前端因此把两个键一起 disable，而不是只拦「拒绝」那一个。
    // 这里用 F：A 在这一节已经被关掉、B 被拾主自己关了、E 被删了，只有 F 还开着、还能挂新的 pending。
    const fresh = await call<SubmitReturnResult>('POST', `/api/items/${seed.itemF}/returns`, seed.tokenClaimant2, {
      message: '这副讲义的封底有我的学号，第一页右下角有一道圆珠笔画的横线',
      proof_image_path: PROOF,
    })
    const e = await expectCode(Code.VALIDATION, () =>
      call('POST', `/api/returns/${fresh.id}/confirm`, seed.tokenOwner, {
        // 18 字 × 30 = 540，越过 500 这一档；按字（rune）数算，一个汉字算一个字。
        owner_note: '这段备注会超过五百字，专门用来撞上限'.repeat(30),
      }),
    )
    expect(e.errorFor('owner_note'), `超长该报在 owner_note 上：${JSON.stringify(e.fieldErrors)}`).toBeTruthy()

    // 状态没被动过：⑤排在⑥之前，所以这一次点下去什么都没发生。
    const d = await call<ReturnDetailView>('GET', `/api/returns/${fresh.id}`, seed.tokenClaimant2)
    expect(d.status).toBe('pending')

    // 改短之后同一条记录就确认得动 —— 证明上面那次失败不是权限或状态迁移的问题。
    const okRes = await call<ConfirmReturnResult>('POST', `/api/returns/${fresh.id}/confirm`, seed.tokenOwner, {
      owner_note: '是你要的讲义，第 12 页那道折角也在',
    })
    expect(okRes.status).toBe('confirmed')
  })
})

describe('#28 #29 两个列表：收件人永远来自 JWT', () => {
  it('列表行是索引不是判断现场：没有 message、没有 proof、没有 submitter', async () => {
    const p = await call<Page<ReturnEntry>>('GET', '/api/my/returns/received', seed.tokenOwner)
    expectFields(p, ['list', 'total', 'page', 'page_size'])
    const row = p.list.find((e) => e.id === seed.ret3)
    expect(row, '刚确认的那条该出现在拾主的收件里').toBeDefined()
    expectFields(row!, ['id', 'item', 'status', 'owner_note', 'submitted_at', 'reviewed_at'])
    expectAbsent(row!, ['message', 'proof_image_url', 'proof_image_path', 'submitter'])
    // 但备注在：它是「这一行曾经被判断过」的唯一痕迹，列表页因此可以直接显示它。
    expect(row!.item.id, '嵌的那份 item 只到 summary 那一层').toBe(seed.itemA)
    // 前端那句「列表里点进去才看证据」的依据就是上面那三行断言。
  })

  it('两个方向是两套完全不同的行：#28 按提交人查、#29 按帖子的作者查', async () => {
    const mine = await call<Page<ReturnEntry>>('GET', '/api/my/returns/submitted', seed.tokenClaimant)
    const ids = mine.list.map((e) => e.id)
    expect(ids).toContain(seed.ret1)
    expect(ids).toContain(seed.ret3)
    expect(
      ids.includes(seed.ret2),
      '乙提交的那条不该出现在甲的「我提交的」里（那一行的收件条件是 items.user_id，不是 item_returns 的某列）',
    ).toBe(false)

    const received = await call<Page<ReturnEntry>>('GET', '/api/my/returns/received', seed.tokenClaimant)
    expect(
      received.list.length,
      '甲自己没有帖子，所以他的「等我处理」该是空的',
    ).toBe(0)
    expect(Array.isArray(received.list), '空列表给的是 []，前端可以不加判空地 map').toBe(true)
  })

  it('cancelled 的行在列表里带非空 reviewed_at，而 #27 的响应里根本没有这个键', async () => {
    // 这两处的不一致是后端注释里明写的，前端以列表为准（撤销时刻要显示出来）。
    const p = await call<Page<ReturnEntry>>('GET', '/api/my/returns/received?status=cancelled', seed.tokenOwner)
    const row = p.list.find((e) => e.id === seed.ret2)
    expect(row, '被撤销的那条该在拾主的收件里留着').toBeDefined()
    expect(row!.reviewed_at, '列表里的 cancelled 行该带撤销时刻').not.toBe('')
  })

  it('?status= 白名单严格：bogus 直接 VALIDATION，而不是当成不过滤', async () => {
    // 前端把地址栏里那个不认识的值原样发过去（和 #19 的白名单同一件事），
    // 依据就是这一条：后端不会悄悄把它放宽成「全部」。
    await expectCode(Code.VALIDATION, () => call('GET', '/api/my/returns/submitted?status=bogus', seed.tokenClaimant))
    const pending = await call<Page<ReturnEntry>>(
      'GET',
      '/api/my/returns/submitted?status=pending',
      seed.tokenClaimant,
    )
    expect(pending.list.every((e) => e.status === 'pending')).toBe(true)
  })

  it('匿名读两个列表都是 UNAUTHORIZED：收件人取自 JWT，没有「匿名也算一个收件人」这种解释', async () => {
    await expectCode(Code.UNAUTHORIZED, () => call('GET', '/api/my/returns/submitted'))
    await expectCode(Code.UNAUTHORIZED, () => call('GET', '/api/my/returns/received'))
  })
})

describe('#30 #31 #32 收件箱、未读数、标记已读', () => {
  it('#30 的 return_submitted 行把 item_id 和 return_id 都带上了 —— 前端那条三级路由的依据', async () => {
    const p = await call<Page<NotificationView>>('GET', '/api/my/notifications?page_size=100', seed.tokenOwner)
    expectFields(p, ['list', 'total', 'page', 'page_size'])
    const hit = p.list.find((n) => n.type === 'return_submitted' && n.return_id === seed.ret3)
    expect(hit, '拾主该收到「有人提交了归还确认」').toBeDefined()
    expect(hit!.item_id).toBe(seed.itemA)
    expectFields(hit!, ['id', 'type', 'title', 'content', 'item_id', 'return_id', 'is_read', 'created_at'])
    expect(hit!.is_read, '刚写进来的通知该是未读').toBe(false)

    // 三种落点各验一次：有 return_id 的跳 #24，只有 item_id 的跳帖子，两个都空的没有链接。
    const confirmed = await call<Page<NotificationView>>(
      'GET',
      '/api/my/notifications?page_size=100',
      seed.tokenClaimant,
    )
    const rc = confirmed.list.find((n) => n.type === 'return_confirmed')
    expect(rc, '提交人该收到确认回执').toBeDefined()
    expect(rc!.return_id).toBe(seed.ret3)
    const rj = confirmed.list.find((n) => n.type === 'return_rejected')
    expect(rj, '被拒的人该拿到那条 return_rejected —— 那是他唯一的解释来源').toBeDefined()
    expect(rj!.item_id).toBe(seed.itemA)
    expect(rj!.content, '被拒的人能从通知里读到那句备注').toContain('挂绳是红色的没错')

    // 撤销不该留下任何一行通知：路人这一整路只当过提交人，他的收件箱该是空的。
    const outsiderInbox = await call<Page<NotificationView>>(
      'GET',
      '/api/my/notifications?page_size=100',
      seed.tokenOutsider,
    )
    expect(outsiderInbox.list.length, '撤销零通知：路人不该收到任何回执').toBe(0)
  })

  it('#31 的未读数等于 #30 里 is_read=false 的行数（两条端点是故意分开的）', async () => {
    const list = await call<Page<NotificationView>>(
      'GET',
      '/api/my/notifications?is_read=false&page_size=100',
      seed.tokenOwner,
    )
    const u = await call<{ count: number }>('GET', '/api/my/notifications/unread-count', seed.tokenOwner)
    expectFields(u, ['count'])
    expect(u.count).toBe(list.total)
    expect(u.count, '拾主这一路收了四次提交，未读不该是 0').toBeGreaterThan(0)
  })

  it('?is_read 是三态：不带=全部，false=未读，true=已读，写别的直接 VALIDATION', async () => {
    const all = await call<Page<NotificationView>>('GET', '/api/my/notifications?page_size=100', seed.tokenOwner)
    const unread = await call<Page<NotificationView>>(
      'GET',
      '/api/my/notifications?is_read=false&page_size=100',
      seed.tokenOwner,
    )
    expect(all.list.length).toBeGreaterThanOrEqual(unread.list.length)
    expect(unread.list.every((n) => !n.is_read)).toBe(true)
    const read = await call<Page<NotificationView>>(
      'GET',
      '/api/my/notifications?is_read=true&page_size=100',
      seed.tokenOwner,
    )
    expect(read.list.every((n) => n.is_read)).toBe(true)
    await expectCode(Code.VALIDATION, () =>
      call('GET', '/api/my/notifications?is_read=maybe', seed.tokenOwner),
    )
  })

  it('#32 按 ids 标：updated_count 数的是真的从未读翻过来的行，第二次同样提交它就是 0', async () => {
    const unread = await call<Page<NotificationView>>(
      'GET',
      '/api/my/notifications?is_read=false&page_size=100',
      seed.tokenOwner,
    )
    const target = unread.list[0]
    expect(target, '这一条要先有未读才能测标记').toBeDefined()

    const r = await call<{ updated_count: number }>('PUT', '/api/my/notifications/read', seed.tokenOwner, {
      ids: [target.id],
    })
    expectFields(r, ['updated_count'])
    expect(r.updated_count).toBe(1)

    const again = await call<{ updated_count: number }>('PUT', '/api/my/notifications/read', seed.tokenOwner, {
      ids: [target.id],
    })
    // 幂等：已经是已读的行不会被重复计数。「你提交了 1 个、标记了 0 个」是这句话的形状，
    // 而页面上那句「已标记 N 条」只能用这个数，不能用选择数。
    expect(again.updated_count).toBe(0)

    const stillUnread = await call<{ count: number }>(
      'GET',
      '/api/my/notifications/unread-count',
      seed.tokenOwner,
    )
    expect(stillUnread.count).toBe(unread.list.length - 1)
  })

  it('#32 拿别人的 id 标记 → FORBIDDEN：归属查在 UPDATE 之前，不是静默跳过', async () => {
    // 这一条是 #32 唯一真正 dangerous 的形状。如果后端只靠 repo 那句 WHERE user_id=$1
    // 静默过滤，用户会看到 200 + updated_count 比预期小，却不知道原因；
    // 后端选择在服务层先查归属并明确拒绝，前端因此可以把「这条不是你的」说出来。
    const theirs = await call<Page<NotificationView>>(
      'GET',
      '/api/my/notifications?page_size=100',
      seed.tokenClaimant,
    )
    expect(theirs.list.length, '这一条要先有别人的通知可拿').toBeGreaterThan(0)
    await expectCode(Code.FORBIDDEN, () =>
      call('PUT', '/api/my/notifications/read', seed.tokenOwner, { ids: [theirs.list[0].id] }),
    )
  })

  it('#32 的 ids 和 all 严格二选一：都不带、都带、带空数组、带 all:false，四种全是 VALIDATION', async () => {
    // 指针字段的「没带」和「带了但是 false」必须能区分 ——
    // 若后端把 {all:false} 当成「没带」，前端漏了个判断也不会红，而用户会以为「全部已读」点过了。
    await expectCode(Code.VALIDATION, () => call('PUT', '/api/my/notifications/read', seed.tokenOwner, {}))
    await expectCode(Code.VALIDATION, () =>
      call('PUT', '/api/my/notifications/read', seed.tokenOwner, { all: false }),
    )
    await expectCode(Code.VALIDATION, () =>
      call('PUT', '/api/my/notifications/read', seed.tokenOwner, { ids: [] }),
    )
    const both = await expectCode(Code.VALIDATION, () =>
      call('PUT', '/api/my/notifications/read', seed.tokenOwner, { ids: [1], all: true }),
    )
    expect(both.errorFor('all'), '二选一冲突该报在 all 上').toBeTruthy()

    // 上面那四次失败必须什么都没改：形状校验排在执行之前，一条都没被标掉。
    const before = await call<{ count: number }>('GET', '/api/my/notifications/unread-count', seed.tokenOwner)
    expect(before.count, 'VALIDATION 不该顺手标掉任何东西').toBeGreaterThan(0)

    // 不带 id 的「全部已读」绝不能顺手把别人的行也标了：这一条是它只作用于 JWT 那个人。
    const outsiderBefore = await call<{ count: number }>(
      'GET',
      '/api/my/notifications/unread-count',
      seed.tokenOutsider,
    )
    await call('PUT', '/api/my/notifications/read', seed.tokenOwner, { all: true })
    const outsiderAfter = await call<{ count: number }>(
      'GET',
      '/api/my/notifications/unread-count',
      seed.tokenOutsider,
    )
    expect(outsiderAfter.count, '拾主的 all=true 不该动到路人的未读').toBe(outsiderBefore.count)

    const mine = await call<{ count: number }>('GET', '/api/my/notifications/unread-count', seed.tokenOwner)
    expect(mine.count, 'all=true 之后自己的未读该归零').toBe(0)

    const read = await call<Page<NotificationView>>(
      'GET',
      '/api/my/notifications?is_read=true&page_size=100',
      seed.tokenOwner,
    )
    expect(read.list.length).toBeGreaterThan(0)
  })

  it('匿名读收件箱 / 未读数 / 标记已读都是 UNAUTHORIZED：这一族没有「匿名收件人」', async () => {
    await expectCode(Code.UNAUTHORIZED, () => call('GET', '/api/my/notifications'))
    await expectCode(Code.UNAUTHORIZED, () => call('GET', '/api/my/notifications/unread-count'))
    await expectCode(Code.UNAUTHORIZED, () => call('PUT', '/api/my/notifications/read', undefined, { all: true }))
  })
})
