// src/pages/MyReturnsPage.tsx —— #28 我提交的 + #29 我收到的，一个页面两个箱子。
//
// 为什么合成一页而不是两页：这两条返回的是**同一个 ReturnEntry 形状**，只有过滤的列不同
// （#28 过滤 item_returns.submitter_id，#29 过滤 items.user_id）。分成两页就会各写一套
// 筛选、各写一套分页、各写一套空态文案，而那三套东西本来是一样的 —— 会不一样的只有标签口吻。
//
// ⚠ 状态标签必须带视角。「confirmed」在我提交的箱子里意思是**对方确认了**，
// 在我收到的箱子里意思是**我已确认**。写成一句中立的「已确认」就把「谁做的这个判断」
// 抹掉了，而这份记录里最有意义的恰好就是那个「谁」——定位原则 1 说的「只说某人做某事」，
// 在这一页是显示层的事，不是后端的事。
//
// 列表行里**没有** message、没有凭证图、没有提交人（后端故意的：「列表是索引，详情才是判断现场」），
// 所以这里不许出现「快速预览一下证据」那种小心思，也不许放确认/拒绝按钮 ——
// 要判断就进 #24。
import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { listMyReceivedReturns, listMySubmittedReturns } from '../api/returns'
import { errorText, requestIdOf } from '../api/errorText'
import { localMinute } from '../lib/time'
import type { Page, ReturnEntry, ReturnStatus } from '../api/types'

const PAGE_ONE = 1

type Box = 'submitted' | 'received'

const BOXES: { value: Box; label: string }[] = [
  { value: 'received', label: '别人提交给我的' },
  { value: 'submitted', label: '我提交给别人的' },
]

const STATUSES: { value: ReturnStatus; label: string }[] = [
  { value: 'pending', label: '还没处理' },
  { value: 'confirmed', label: '已确认' },
  { value: 'rejected', label: '已拒绝' },
  { value: 'cancelled', label: '已撤销' },
]

/** 同一枚状态在两个箱子里是两句话。空串表示「这一格整块不出现」。 */
function statusLine(box: Box, status: ReturnStatus): string {
  if (box === 'submitted') {
    return (
      {
        pending: '等对方处理',
        confirmed: '对方确认了',
        rejected: '对方拒绝了',
        cancelled: '你撤销了',
      }[status] ?? ''
    )
  }
  return (
    {
      pending: '等你处理',
      confirmed: '你确认了',
      rejected: '你拒绝了',
      cancelled: '对方撤销了',
    }[status] ?? ''
  )
}

function toPage(raw: string | null): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : PAGE_ONE
}

export default function MyReturnsPage() {
  const [params, setParams] = useSearchParams()
  const box: Box = params.get('box') === 'submitted' ? 'submitted' : 'received'
  const status = (params.get('status') || '') as ReturnStatus | ''
  const page = toPage(params.get('page'))

  const [data, setData] = useState<Page<ReturnEntry> | null>(null)
  const [error, setError] = useState('')
  const [errorId, setErrorId] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let dead = false
    setLoading(true)
    const q = { status: status || undefined, page: page === PAGE_ONE ? undefined : page }
    const call = box === 'submitted' ? listMySubmittedReturns(q) : listMyReceivedReturns(q)
    call
      .then((res) => {
        if (dead) return
        setData(res)
        setError('')
      })
      .catch((err) => {
        if (dead) return
        setError(errorText(err))
        setErrorId(requestIdOf(err))
      })
      .finally(() => {
        if (!dead) setLoading(false)
      })
    return () => {
      dead = true
    }
  }, [box, status, page])

  const patch = useCallback(
    (next: Record<string, string>) => {
      const merged = new URLSearchParams(params)
      for (const [k, v] of Object.entries(next)) {
        if (!v) merged.delete(k)
        else merged.set(k, v)
      }
      // 换箱子或换筛选条件时页码必须归一，否则会停在「第 3 页」去看一个只有 1 页的结果集，
      // 屏幕上就是一句「这里还没有东西」配一个不存在的页码。
      if (merged.get('page') && (!next.page || next.page === String(PAGE_ONE))) merged.delete('page')
      setParams(merged, { replace: true })
    },
    [params, setParams],
  )

  const total = data?.total ?? 0
  const pages = data ? Math.max(1, Math.ceil(total / data.page_size)) : 1

  return (
    <>
      <section className="card">
        <h1>归还确认</h1>
        <p className="muted">
          这里记的是「谁向谁提交过一次归还、对方有没有给过一句话」。<Link to="/me">回我的</Link>
        </p>

        <div className="type-tabs" role="group" aria-label="哪一边的记录">
          {BOXES.map((b) => (
            <button
              key={b.value}
              type="button"
              className={box === b.value ? 'tab tab-on' : 'tab'}
              aria-pressed={box === b.value}
              onClick={() => patch({ box: b.value })}
            >
              {b.label}
            </button>
          ))}
        </div>

        <div className="field">
          <label htmlFor="status">状态</label>
          <select
            id="status"
            value={status}
            onChange={(e) => patch({ status: e.target.value })}
          >
            <option value="">全部</option>
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <p className="alert" role="alert">
            {error}
            {errorId && <span className="req-id">（请求编号 {errorId}）</span>}
          </p>
        )}

        {loading && !data && <p className="muted">正在加载…</p>}

        {data && data.list.length === 0 && !loading && (
          <p className="muted">
            {box === 'received'
              ? '还没有人向你提交过归还确认。这不说明你的东西有问题，只说明这一页还没发生过事。'
              : '你还没有向别人提交过归还确认。要提交，去那条拾物帖的详情页。'}
          </p>
        )}

        {data && data.list.length > 0 && (
          <ul className="ret-list">
            {data.list.map((row) => (
              <li key={row.id} className="ret-row">
                <Link to={`/returns/${row.id}`}>{row.item.title}</Link>
                <span className="item-meta">
                  {row.item.item_type === 'lost' ? '失物' : '拾物'} · {row.item.category_name} ·{' '}
                  {row.item.author_name}
                </span>
                <span className={`ret-state ret-state-${row.status}`}>{statusLine(box, row.status)}</span>
                <span className="muted">提交于 {localMinute(row.submitted_at)}</span>
                {/* owner_note 列表里就给出来：它是发帖人自己写过的那句话，
                    不需要进详情就能看，而凭证图和提交留言必须进详情。 */}
                {row.owner_note && <span className="ret-note">对方留下的话：{row.owner_note}</span>}
              </li>
            ))}
          </ul>
        )}

        {data && total > 0 && (
          <div className="pager">
            <button
              className="btn"
              type="button"
              disabled={page <= 1}
              onClick={() => patch({ page: String(page - 1) })}
            >
              上一页
            </button>
            <span className="muted">
              第 {page} / {pages} 页，共 {total} 条
            </span>
            <button
              className="btn"
              type="button"
              disabled={page >= pages}
              onClick={() => patch({ page: String(page + 1) })}
            >
              下一页
            </button>
          </div>
        )}
      </section>

      {/* 这条提醒是给「我收到的」那一侧的，但它讲的是整个流程最容易误会的地方：
          同一条帖子可以由好几个人各自提交一次归还（唯一索引是 (item_id, submitter_id)），
          我确认了其中一条，不等于驳回了其他条。 */}
      <p className="card hint">
        同一件东西可能有好几个人各自提交过一次确认，彼此不冲突；你对其中一个人给了答复，
        也不会替其他人把那一条关掉。想不起来了就点进去看那一条的详情。
      </p>
    </>
  )
}
