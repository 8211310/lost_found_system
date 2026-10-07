// src/pages/CreditLogsPage.tsx —— #33 GET /api/my/credit-logs（积分流水）。
//
// 这一页只有一条硬性写法：**当前分现读，不写成流水合计**。
// 后端那个 credit_score 是直接从 JWT 用户那行取的（CreditHistory 上那段交代了原因），
// 所以「以下各条加起来」和它本来就没有等式关系 —— 真出现历史归档或对账差额时，
// 页面上一句「合计 X 分」会和屏幕上那个 X 打架。这里连「累计」这种词都不出现。
//
// 收件人来自 JWT，不来自参数：这一族没有 ?user_id=，前端也不该想办法拼一个。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { getCreditLogs } from '../api/my'
import { errorText, requestIdOf } from '../api/errorText'
import { localMinute } from '../lib/time'
import type { CreditHistory } from '../api/types'

const PAGE_ONE = 1

function toPage(raw: string | null): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : PAGE_ONE
}

/** delta 的正负要分开显示：只显示 2 和 -2 太小，一眼扫过去分不出来，
 *  而这一页拿来做的事正是回顾「分是怎么没的」。加号显式写出来，
 *  因为不带符号的数字在中文语境里会被读成「这是几分」。 */
function deltaText(delta: number): string {
  return delta > 0 ? `+${delta}` : String(delta)
}

export default function CreditLogsPage() {
  const [params, setParams] = useSearchParams()
  const [data, setData] = useState<CreditHistory | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [errorId, setErrorId] = useState('')

  // 必须是 useMemo 的产物，理由和广场那处一样：useSearchParams 每次渲染都给新对象，
  // 直接把它当依赖就成了「每次渲染发一次请求」。
  const page = useMemo(() => toPage(params.get('page')), [params])

  useEffect(() => {
    let dead = false
    setLoading(true)
    // 第一页不写 ?page=1，和广场那条约定一致：URL 里出现的每个参数都真的改变了默认行为。
    getCreditLogs(page === PAGE_ONE ? undefined : page)
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
  }, [page])

  const gotoPage = useCallback(
    (next: number) => {
      const merged = new URLSearchParams(params)
      if (next <= PAGE_ONE) merged.delete('page')
      else merged.set('page', String(next))
      setParams(merged, { replace: true })
    },
    [params, setParams],
  )

  const total = data?.total ?? 0
  const pages = data ? Math.max(1, Math.ceil(total / data.page_size)) : 1

  return (
    <section className="card">
      <h1>积分流水</h1>
      <p className="muted">
        <Link to="/me">回我的</Link>
      </p>

      {data && (
        <p className="credit-now">
          当前信用分 <strong>{data.credit_score}</strong>
        </p>
      )}

      {error && (
        <p className="alert" role="alert">
          {error}
          {errorId && <span className="req-id">（请求编号 {errorId}）</span>}
        </p>
      )}

      {loading && !data && <p className="muted">正在加载…</p>}

      {data && data.list.length === 0 && !loading && (
        <p className="muted">
          还没有积分流水。分数是从具体事件里长出来的（比如一笔归还由你确认），
          那种事没发生过，这里就是空的 —— 空不代表分数有问题，上面那个当前分才是结论。
        </p>
      )}

      {data && data.list.length > 0 && (
        <>
          <ul className="log-list">
            {data.list.map((log) => (
              <li key={log.id} className="log-row">
                <span className={`log-delta ${log.delta < 0 ? 'log-delta-minus' : 'log-delta-plus'}`}>
                  {deltaText(log.delta)}
                </span>
                <span className="log-reason">
                  {log.reason}
                  {/* ref_type / ref_id 在库里可空（admin 手工调分那种不带业务行），
                      所以「这条流水能不能点开一个别的东西」不是能假设的事 —— 这里只把来源
                      作为文字给出来，不做链接。 */}
                  {log.ref_type && (
                    <span className="muted">
                      {' '}
                      （来源 {log.ref_type}
                      {log.ref_id ? ` #${log.ref_id}` : ''}）
                    </span>
                  )}
                </span>
                <span className="log-time">{localMinute(log.created_at)}</span>
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
        </>
      )}
    </section>
  )
}
