// src/pages/ReturnDetailPage.tsx —— #24 详情 + #25 确认 / #26 拒绝 / #27 撤销。
//
// 这一页是整个系统里唯一「归属由人产生」的地方，所以它的界面纪律比别的页都紧：
//
// ① 只有发帖人能确认和拒绝，**admin 也不行**（后端那两条是「全系统唯一 admin 也不行」的端点）。
//    所以这里的按钮判的是 `user.id === item.author_id`，而不是 `role !== 'user'` 那种便利写法；
//    admin 进这一页读得到全部事实，但看不到任何可以按的键 —— 页面上要有一句话解释这件事，
//    不然管理员会以为是自己没权限的 bug。
// ② review_kind 有两种，绝不能显示成同一句「已处理」：'owner' 是社区里真发生过的判断，
//    'admin_data_fix' 是管理员改了那行数据、**没有任何社区含义**。
// ③ 文案受后端那份禁词表的同一条约束（归还成功 / 已归还给你 / 已关闭 / 这就是 / 判定）：
//    确认之后不说「已归还」，只说「你确认了这一条」——我们把某人做了某事记下来，
//    东西到底还不还的对，不在我们的表述范围里。
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { cancelReturn, confirmReturn, getReturn, rejectReturn } from '../api/returns'
import { errorText, requestIdOf } from '../api/errorText'
import { ApiError } from '../api/client'
import { Code } from '../api/codes'
import { useAuth } from '../auth/AuthContext'
import { localMinute } from '../lib/time'
import type { ReturnDetailView } from '../api/types'

const NOTE_MAX = 500

/** 后端按字（rune）数算，JS 的 .length 按 UTF-16 单元算：一个汉字两边都是 1，
 *  但一个 emoji 这边是 2、那边是 1。用扩展运算符拆开再数，两边口径才一致，
 *  否则前端会在用户还没到限时就先拦下来。 */
function runeLen(s: string): number {
  return [...s.trim()].length
}

function statusLine(status: ReturnDetailView['status']): string {
  return (
    {
      pending: '还没有人给出答复。',
      confirmed: '发帖人确认了这一条。',
      rejected: '发帖人拒绝了这一条。',
      cancelled: '提交人撤销了这一条。',
    }[status] ?? ''
  )
}

export default function ReturnDetailPage() {
  const { id = '' } = useParams()
  const { user } = useAuth()
  const [data, setData] = useState<ReturnDetailView | null>(null)
  const [loadError, setLoadError] = useState('')
  const [notFound, setNotFound] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [actionId, setActionId] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(() => {
    let dead = false
    getReturn(id)
      .then((res) => {
        if (dead) return
        // 三个标记一起清：只 setData 的话，一次「先失败后成功」会在屏幕上留下
        // 上一轮的结论（那句「这条记录不存在」），而那件事已经不再是事实了。
        setData(res)
        setLoadError('')
        setNotFound(false)
      })
      .catch((err) => {
        if (dead) return
        setNotFound(err instanceof ApiError && err.code === Code.NOT_FOUND)
        setLoadError(errorText(err))
      })
    return () => {
      dead = true
    }
  }, [id])

  useEffect(() => load(), [load])

  /** 做完一次写操作之后**重新读一次**，不拿 #25/#26 的响应去拼界面：
   *  三条写端点各自返回的键不一样（#25 有 credit_delta、#26 没有、#27 连 reviewed_at 都不给），
   *  用响应填 state 就会写出「#27 之后界面上多了一个处理时间」那种后端没给的东西。 */
  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true)
    setActionError('')
    setActionId('')
    setNotice('')
    try {
      await fn()
      setNote('')
      setNotice(done)
      load()
    } catch (err) {
      setActionError(errorText(err))
      setActionId(requestIdOf(err))
    } finally {
      setBusy(false)
    }
  }

  if (notFound) {
    return (
      <section className="card">
        <h1>这条记录不存在</h1>
        <p className="muted">
          编号 {id} 查不到。可能是链接抄错了，也可能那条已经被删掉 —— 归还确认的记录可以被管理员删
          （那是另一条端点，删的是一行记录，不产生任何「有人同意了」的含义）。
        </p>
        <p className="muted">
          <Link to="/me/returns">回到我的归还确认</Link>
        </p>
      </section>
    )
  }

  if (loadError && !data) {
    return (
      <section className="card">
        <h1>看不了这条记录</h1>
        <p className="alert" role="alert">
          {loadError}
        </p>
        <p className="muted">
          <Link to="/me/returns">回到我的归还确认</Link>
        </p>
      </section>
    )
  }

  if (!data) return <p className="muted">正在加载…</p>

  const isAuthor = user?.id === data.item.author_id
  const isSubmitter = user?.id === data.submitter.id
  const canDecide = isAuthor && data.status === 'pending'
  const canCancel = isSubmitter && data.status === 'pending'
  const rejectBlocked = runeLen(note) === 0

  return (
    <section className="card">
      <h1>归还确认记录</h1>

      <p className="muted">
        帖子：
        <Link to={`/items/${data.item.id}`}>{data.item.title}</Link>
        {/* item.status 照实显示，包括 deleted —— 后端明写「摘要里应如实带着 deleted，
            它不做判断，只记录事实」，所以这里不许把它美化成「已关闭」。 */}
        <span className={`tag tag-${data.item.status}`}>
          {data.item.status === 'open'
            ? '还挂着'
            : data.item.status === 'closed'
              ? '标记为已归还'
              : '已经不在架上了'}
        </span>
      </p>

      {actionError && (
        <p className="alert" role="alert">
          {actionError}
          {actionId && <span className="req-id">（请求编号 {actionId}）</span>}
        </p>
      )}
      {notice && <p className="notice">{notice}</p>}

      <dl className="kv">
        <dt>提交人</dt>
        <dd>
          {data.submitter.nickname}
          <span className="muted">（信用分 {data.submitter.credit_score}）</span>
        </dd>

        <dt>提交时间</dt>
        <dd>{localMinute(data.submitted_at)}</dd>

        <dt>他说的话</dt>
        <dd>{data.message}</dd>

        <dt>凭证图</dt>
        <dd>
          {data.proof_image_url ? (
            <img className="proof-img" src={data.proof_image_url} alt="提交人上传的凭证" />
          ) : (
            <span className="muted">没有图</span>
          )}
        </dd>

        <dt>当前状态</dt>
        <dd>{statusLine(data.status)}</dd>

        {data.owner_note && (
          <>
            <dt>发帖人留的话</dt>
            <dd>{data.owner_note}</dd>
          </>
        )}

        {/* reviewed_at 为空时是空串不是 null（后端 formatTime 把 NULL 折成 ""），
            而 reviewer_id / review_kind 才是真 null —— 两种「还没有」的表示法不一样。 */}
        {data.reviewed_at && (
          <>
            <dt>定下来的时间</dt>
            <dd>{localMinute(data.reviewed_at)}</dd>
          </>
        )}

        {data.review_kind && (
          <>
            <dt>这一行是谁给的</dt>
            <dd>
              {data.review_kind === 'owner' ? (
                <span>发帖人本人（编号 {data.reviewer_id}）</span>
              ) : (
                <span className="alert-inline">
                  管理员改过这行数据。它没有社区含义 —— 不代表当事人做过这个判断。
                </span>
              )}
            </dd>
          </>
        )}
      </dl>

      {data.status === 'pending' && !canDecide && !canCancel && (
        <p className="hint">
          这条记录你可以看，但你按不了键 —— 确认和拒绝只能由发帖人本人做，管理员也一样不行。
          平台不替任何人决定东西归谁。
        </p>
      )}

      {canDecide && (
        <div className="ret-actions">
          <div className="field">
            <label htmlFor="owner-note">给你的答复留一句话（拒绝时必须写，确认时可不写）</label>
            <textarea
              id="owner-note"
              value={note}
              rows={3}
              maxLength={NOTE_MAX * 2}
              onChange={(e) => setNote(e.target.value)}
            />
            <span className={runeLen(note) > NOTE_MAX ? 'counter over' : 'counter'}>
              {runeLen(note)} / {NOTE_MAX}
            </span>
          </div>

          <div className="item-actions">
            {/* 两个键共用同一条 500 字上限（后端 normalizeOwnerNote 对 confirm 和 reject 都算它），
                所以超限是两个一起 disable；而「空」只有 reject 拦 —— 那才是 #25/#26 的不对称所在。 */}
            <button
              className="btn btn-primary"
              type="button"
              disabled={busy || runeLen(note) > NOTE_MAX}
              onClick={() => act(() => confirmReturn(data.id, note.trim()), '你确认了这一条。')}
            >
              确认这一条
            </button>
            <button
              className="btn btn-danger"
              type="button"
              disabled={busy || rejectBlocked || runeLen(note) > NOTE_MAX}
              onClick={() => act(() => rejectReturn(data.id, note.trim()), '你拒绝了这一条。')}
            >
              拒绝
            </button>
          </div>

          {/* 拒绝那一侧的后果必须写清楚，因为它的界面看起来和「不同意」差不多重：
              它其实什么都不动 —— 不关帖子、不扣分、也不拦着对方再提交一次。 */}
          <p className="hint">
            拒绝只是记下你这个答复：那条帖子还挂着，信用分不动，对方还可以再提交一次。
            确认则会同时把帖子标为已归还，并给你和对方各加信用分（到 200 封顶就不再加）。
          </p>
        </div>
      )}

      {canCancel && (
        <div className="ret-actions">
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={() => act(() => cancelReturn(data.id), '你撤销了这一条。')}
          >
            撤销我这次提交
          </button>
          <p className="hint">
            撤销只改这一行记录，不会通知对方，也不会影响那条帖子本身。撤销之后你还可以再提交一次。
          </p>
        </div>
      )}

      <p className="muted">
        <Link to="/me/returns">回到我的归还确认</Link>
      </p>
    </section>
  )
}
