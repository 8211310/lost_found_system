// src/pages/ContactViewsPage.tsx —— #22 GET /api/items/:id/contact-views（谁解锁过我的联系方式）。
//
// 这份名单是定位原则 3 的另一半：认领**非排他**，发帖人拦不住谁去解锁，
// 但他有权知道谁来看过 —— 后端那句注释说这是「骚扰的唯一事后补救手段」，
// 所以这一页的价值全在「完整、按时间可追溯」上，而不是一个统计数字。
//
// 鉴权（发帖人本人或 admin）由后端判，前端这里只做一件事：
// 身份不符时**根本不发那次请求**（和 ItemDetailPage 的 canSeeMatches 同一个写法），
// 因为一个注定 FORBIDDEN 的请求除了让人以为页面坏了，不产生任何信息。
// 注意条件里含 admin：后端允许的是这两类人，前端把条件收紧成「只认本人」
// 就会让管理员在任何一条帖子上都看不到名单 —— 那是替后端做了它没做的决定。
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { getContactViews, getItem } from '../api/items'
import { errorText, requestIdOf } from '../api/errorText'
import { useAuth } from '../auth/AuthContext'
import { localMinute } from '../lib/time'
import type { ContactViewEntry, ItemView, Page } from '../api/types'

const PAGE_ONE = 1

function toPage(raw: string | null): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : PAGE_ONE
}

export default function ContactViewsPage() {
  const { id = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const { status, user } = useAuth()

  const [item, setItem] = useState<ItemView | null>(null)
  const [itemError, setItemError] = useState('')
  const [data, setData] = useState<Page<ContactViewEntry> | null>(null)
  const [listError, setListError] = useState('')
  const [errorId, setErrorId] = useState('')
  const [loading, setLoading] = useState(true)

  const page = toPage(params.get('page'))

  useEffect(() => {
    let dead = false
    getItem(id)
      .then((res) => {
        if (!dead) setItem(res)
      })
      .catch((err) => {
        if (!dead) setItemError(errorText(err))
      })
    return () => {
      dead = true
    }
  }, [id])

  const canSee = status === 'authed' && !!item && (user?.role === 'admin' || user?.id === item.author.id)

  useEffect(() => {
    if (!canSee) {
      setLoading(false)
      return
    }
    let dead = false
    setLoading(true)
    getContactViews(id, page)
      .then((res) => {
        if (dead) return
        setData(res)
        setListError('')
      })
      .catch((err) => {
        if (dead) return
        setListError(errorText(err))
        setErrorId(requestIdOf(err))
      })
      .finally(() => {
        if (!dead) setLoading(false)
      })
    return () => {
      dead = true
    }
  }, [canSee, id, page])

  /** 只有 page 这一个条件要改，所以不写广场那套 patch：这里的 URL 一旦带上别的参数，
   *  就会让人以为这一页也能筛选，而它只是一份日志。 */
  const gotoPage = useCallback(
    (next: number) => {
      const merged = new URLSearchParams(params)
      if (next <= PAGE_ONE) merged.delete('page')
      else merged.set('page', String(next))
      setParams(merged, { replace: true })
    },
    [params, setParams],
  )

  if (itemError) {
    return (
      <section className="card">
        <h1>看不了这份名单</h1>
        <p className="alert" role="alert">
          {itemError}
        </p>
        <p className="muted">
          <Link to="/me/posts">回我的发布</Link>
        </p>
      </section>
    )
  }

  if (!item) return <p className="muted">正在加载…</p>

  // status 还在 loading 时不能判成「没权限」：那一会儿 user 是 null，
  // 直接把下面那句 alert 亮出来，用户会看到一句关于他身份的假结论。
  // RequireAuth 已经挡掉了匿名访问，所以这里唯一可能的「还没好」就是首次进页面那几百毫秒。
  if (status === 'loading') return <p className="muted">正在加载…</p>

  const total = data?.total ?? 0
  const pages = data ? Math.max(1, Math.ceil(total / data.page_size)) : 1

  return (
    <>
      <section className="card">
        <h1>谁看过这条的联系方式</h1>
        <p className="muted">
          帖子：<Link to={`/items/${item.id}`}>{item.title}</Link>
        </p>

        {/* 这句不是客套，是把两个容易混的东西分开：这份名单**只记录了他查看过**，
            它不代表对方认领成功、也不代表系统认可了他和你之间的联系。 */}
        <p className="hint">名单只有你和管理员看得到。查看记录不等于认领成功，也不排除其他人照样联系你。</p>

        {!canSee && (
          <p className="alert" role="alert">
            只有发帖人本人能看这份名单。
          </p>
        )}

        {canSee && listError && (
          <p className="alert" role="alert">
            {listError}
            {errorId && <span className="req-id">（请求编号 {errorId}）</span>}
          </p>
        )}

        {canSee && loading && !data && <p className="muted">正在加载…</p>}

        {canSee && data && data.list.length === 0 && !loading && (
          <p className="muted">还没有人查看过这条联系方式。</p>
        )}

        {canSee && data && data.list.length > 0 && (
          <>
            <ul className="log-list">
              {data.list.map((entry) => (
                <li key={entry.id} className="log-row">
                  <span className="log-who">
                    {entry.user.nickname}
                    {/* real_name 只有这一份名单里有（见 UnlockerView 上那段）：
                        可空的那一列后端折成了空串，所以没有真名时整块不出现，
                        而不是显示一个括号里面空着。 */}
                    {entry.user.real_name && <span className="muted">（{entry.user.real_name}）</span>}
                  </span>
                  <span className="log-time">{localMinute(entry.created_at)}</span>
                  <span className="muted">记录 {entry.id}</span>
                </li>
              ))}
            </ul>

            <div className="pager">
              <button className="btn" type="button" disabled={page <= 1} onClick={() => gotoPage(page - 1)}>
                上一页
              </button>
              <span className="muted">
                第 {page} / {pages} 页，共 {total} 条
              </span>
              <button className="btn" type="button" disabled={page >= pages} onClick={() => gotoPage(page + 1)}>
                下一页
              </button>
            </div>

            <p className="hint">
              按最近查看的排在前面。要拿这份记录说明情况，引用「记录」后面那个编号，它比「第三个人」精确。
            </p>
          </>
        )}
      </section>

      <p className="card muted">
        <Link to="/me/posts">回我的发布</Link>
      </p>
    </>
  )
}
