// src/pages/NotificationsPage.tsx —— #30 列表 + #31 未读数 + #32 标记已读。
//
// 这一页最难写对的是「一条通知能点开去哪里」。type 有七种，但**不能只按 type 分支**：
// `admin_action` 一种底下藏着五种事（批量下架 / 封号 / 警告 / 删图 / 删归还记录），
// 其中只有删归还那一条带 return_id；而批量下架只在「这次只动了 1 条」时才带 item_id
// （service/moderation.go:438-446），50 条一起下架时通知里就是两个 null。
// 所以跳转规则只能是：先看 return_id，再看 item_id，都没有就不给链接 ——
// 这不是偷懒，是那条通知本来就没有对应的页面可去。
//
// ⚠ item_id / return_id **不是外键**，指向的东西可能先没了，点进去拿到 NOT_FOUND 是预期内的，
// 落地页自己会说「不存在」，这里不许提前替它们担保「一定能打开」。
//
// ⚠ 已读**不可逆**：整个路由表里没有「标为未读」这条。所以「全部已读」必须二步确认。
import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { getUnreadCount, listMyNotifications, markNotificationsRead } from '../api/notifications'
import { errorText, requestIdOf } from '../api/errorText'
import { notifyUnreadCountChanged } from '../api/unreadBus'
import { localMinute } from '../lib/time'
import type { NotificationView, Page } from '../api/types'

const PAGE_ONE = 1

/** 七种 type 各自的一句名字。显示它是为了让人知道这条是从哪件事来的，
 *  不是为了判断真假 —— content 本身已经是后端写好的那句话了。 */
const TYPE_LABEL: Record<NotificationView['type'], string> = {
  new_match: '有人捡到疑似你要找的东西',
  return_submitted: '有人向你提交了一次归还确认',
  return_confirmed: '有人确认了你提交的那一条',
  return_rejected: '有人拒绝了你提交的那一条',
  item_returned_hint: '你联系过的那条拾物帖，发帖人已确认过一次归还',
  admin_action: '管理员动过数据',
  report_resolved: '你举报的那条已有处理记录',
}

function toPage(raw: string | null): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : PAGE_ONE
}

/** 一条通知能点开的地方，按 return_id → item_id 的顺序试。返回 null 就是没有落点。 */
function hrefOf(n: NotificationView): string | null {
  if (n.return_id) return `/returns/${n.return_id}`
  if (n.item_id) return `/items/${n.item_id}`
  return null
}

export default function NotificationsPage() {
  const [params, setParams] = useSearchParams()
  const readFilter = params.get('read')
  const page = toPage(params.get('page'))

  const [data, setData] = useState<Page<NotificationView> | null>(null)
  const [unread, setUnread] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [errorId, setErrorId] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [confirmAll, setConfirmAll] = useState(false)
  const [busy, setBusy] = useState(false)

  // ?read 是三态，所以这里不能用 `params.get('read') || undefined`：
  // 'false' 是合法筛选（只看未读），把它当假值丢掉就等于默认视图变成「全部」，
  // 而这一页默认恰恰应该停在未读上。
  const isRead = readFilter === 'true' ? true : readFilter === 'false' ? false : undefined

  const loadList = useCallback(() => {
    let dead = false
    listMyNotifications({ is_read: isRead, page: page === PAGE_ONE ? undefined : page })
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
  }, [isRead, page])

  const loadUnread = useCallback(() => {
    getUnreadCount()
      .then((res) => setUnread(res.count))
      .catch(() => setUnread(null))
  }, [])

  useEffect(() => loadList(), [loadList])
  useEffect(() => loadUnread(), [loadUnread])

  async function mark(ids: number[], all = false) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const res = all
        ? await markNotificationsRead({ all: true })
        : await markNotificationsRead({ ids })
      // 说的是 updated_count，不是提交上去的条数：同样一批连点两次，第二次后端返回 0，
      // 要是按 ids.length 报「已标记 3 条」就是在报一个没发生过的事。
      setNotice(res.updated_count === 0 ? '没有需要标记的，这些都已经是已读了。' : `已标记 ${res.updated_count} 条。`)
      setConfirmAll(false)
      loadList()
      loadUnread()
      notifyUnreadCountChanged()
    } catch (err) {
      setError(errorText(err))
      setErrorId(requestIdOf(err))
    } finally {
      setBusy(false)
    }
  }

  const patch = useCallback(
    (next: Record<string, string>) => {
      const merged = new URLSearchParams(params)
      for (const [k, v] of Object.entries(next)) {
        if (!v) merged.delete(k)
        else merged.set(k, v)
      }
      if (merged.get('page') && !next.page) merged.delete('page')
      setParams(merged, { replace: true })
    },
    [params, setParams],
  )

  const total = data?.total ?? 0
  const pages = data ? Math.max(1, Math.ceil(total / data.page_size)) : 1
  const rows = data?.list ?? []

  return (
    <section className="card">
      <h1>通知</h1>
      <p className="muted">
        {/* 未读数拿不到时不显示「0 条没读」：#31 失败和真的没有未读是两件事，
            后者是结论，前者只是不知道。 */}
        {unread === null ? '未读数暂时读不到。' : `还有 ${unread} 条没读过。`}
        <Link to="/me">回我的</Link>
      </p>

      <div className="type-tabs" role="group" aria-label="读没读过">
        <button
          type="button"
          className={isRead === false ? 'tab tab-on' : 'tab'}
          aria-pressed={isRead === false}
          onClick={() => patch({ read: 'false' })}
        >
          没读过
        </button>
        <button
          type="button"
          className={isRead === undefined ? 'tab tab-on' : 'tab'}
          aria-pressed={isRead === undefined}
          onClick={() => patch({ read: '' })}
        >
          全部
        </button>
        <button
          type="button"
          className={isRead === true ? 'tab tab-on' : 'tab'}
          aria-pressed={isRead === true}
          onClick={() => patch({ read: 'true' })}
        >
          已读
        </button>
      </div>

      {error && (
        <p className="alert" role="alert">
          {error}
          {errorId && <span className="req-id">（请求编号 {errorId}）</span>}
        </p>
      )}
      {notice && <p className="notice">{notice}</p>}

      {rows.length > 0 && (
        <div className="item-actions">
          {confirmAll ? (
            <>
              <span className="muted">标为已读以后不能再变回来，确定全部标掉？</span>
              <button className="btn" type="button" disabled={busy} onClick={() => mark([], true)}>
                确定
              </button>
              <button className="btn" type="button" onClick={() => setConfirmAll(false)}>
                先不
              </button>
            </>
          ) : (
            <button className="btn" type="button" disabled={busy} onClick={() => setConfirmAll(true)}>
              全部标为已读
            </button>
          )}
        </div>
      )}

      {loading && !data && <p className="muted">正在加载…</p>}

      {data && rows.length === 0 && !loading && (
        <p className="muted">
          {isRead === false ? '没有没读过的通知。' : '这里还没有过通知。'}
        </p>
      )}

      {rows.length > 0 && (
        <ul className="n-list">
          {rows.map((n) => {
            const href = hrefOf(n)
            return (
              <li key={n.id} className={n.is_read ? 'n-row' : 'n-row n-unread'}>
                <p className="n-head">
                  {/* 有落点才做成链接：一条 50 帖批量下架的通知没有 item_id，
                      硬造一个 /items/ 的空链接比不给链接更坏。 */}
                  {href ? <Link to={href}>{n.title}</Link> : <span>{n.title}</span>}
                  {!n.is_read && <span className="tag tag-new">未读</span>}
                </p>
                <p className="n-body">{n.content}</p>
                <p className="item-meta">
                  {TYPE_LABEL[n.type] ?? n.type} · {localMinute(n.created_at)}
                </p>
                {!n.is_read && (
                  <p className="item-actions">
                    <button className="link-btn" type="button" disabled={busy} onClick={() => mark([n.id])}>
                      标为已读
                    </button>
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {data && total > 0 && (
        <div className="pager">
          <button className="btn" type="button" disabled={page <= 1} onClick={() => patch({ page: String(page - 1) })}>
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

      <p className="hint">
        通知只是「发生过一件事」的记录，它不代表那件事还在原地：链接点开的帖子或记录可能已经被人删掉了。
      </p>
    </section>
  )
}
