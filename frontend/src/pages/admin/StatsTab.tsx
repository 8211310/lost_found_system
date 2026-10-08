// src/pages/admin/StatsTab.tsx —— #37 全站计数（只读，无参数）。
//
// 这一页只有一件事容易做错：**别把这一族的数字当成另一族去解释**。
// 后端在 model/stats.go:82-91 明写了三处「这里没有」，页面上每一处都要跟着闭嘴：
//   ① `items_count` 里**没有 total**（View() 刻意摘掉的）—— 所以这一页不显示「共多少条帖」，
//      因为 lost+found 和 open+closed+deleted 加起来都等于它，而两个都不给就等于不给；
//   ② `returns_count` 里**没有 cancelled**：用户自己撤掉的那一类对治理没有信息量；
//   ③ `users_count.hduhelp` 这个键在 Go 那边叫 SSO，是**第三方服务的名字**，
//      所以中文写「杭电助手」而不是「第三方」。
//
// ⚠ `today_items_count` 的「今天」是 `date_trunc('day', now())` 切的，
// 用的是**数据库会话时区**（`now()` 是本地时间，而响应里别处一律 UTC）。
// 这一格的标签必须带上那半句，否则凌晨对不上账时会像坏了一样。
import { useCallback, useEffect, useState } from 'react'
import { getStats } from '../../api/admin'
import { errorText, requestIdOf } from '../../api/errorText'
import { Alert } from './parts'
import type { AdminStats } from '../../api/types'

export default function StatsTab() {
  const [data, setData] = useState<AdminStats | null>(null)
  const [error, setError] = useState('')
  const [errorId, setErrorId] = useState('')

  const load = useCallback(() => {
    let dead = false
    getStats()
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
    return () => {
      dead = true
    }
  }, [])

  useEffect(() => load(), [load])

  return (
    <>
      <Alert error={error} errorId={errorId} />

      {data ? (
        <>
          <h2>用户</h2>
          <dl className="kv">
            <dt>账号总数</dt>
            <dd>{data.users_count.total}</dd>
            <dt>本地账号</dt>
            <dd>{data.users_count.local}</dd>
            <dt>杭电助手</dt>
            <dd>{data.users_count.hduhelp}</dd>
            <dt>已封禁</dt>
            <dd>{data.users_count.banned}</dd>
          </dl>

          <h2>帖子</h2>
          <dl className="kv">
            <dt>失物 / 拾物</dt>
            <dd>
              {data.items_count.lost} / {data.items_count.found}
            </dd>
            <dt>在显示 / 已关闭 / 已下架</dt>
            <dd>
              {data.items_count.open} / {data.items_count.closed} / {data.items_count.deleted}
            </dd>
            <dt>今日新增</dt>
            <dd>
              {data.today_items_count}
              <span className="muted">（按数据库时区切的一天，不是浏览器这个时区）</span>
            </dd>
          </dl>

          <h2>归还确认</h2>
          <dl className="kv">
            <dt>等人处理</dt>
            <dd>{data.returns_count.pending}</dd>
            <dt>发帖人确认过</dt>
            <dd>{data.returns_count.confirmed}</dd>
            <dt>发帖人拒绝过</dt>
            <dd>{data.returns_count.rejected}</dd>
          </dl>

          <h2>举报与留痕</h2>
          <dl className="kv">
            <dt>待处理 / 已采纳 / 未采纳</dt>
            <dd>
              {data.reports_count.open} / {data.reports_count.resolved} / {data.reports_count.dismissed}
            </dd>
            <dt>解锁查看次数</dt>
            <dd>{data.contact_views_count}</dd>
            <dt>治理留痕条数</dt>
            <dd>{data.admin_actions_count}</dd>
          </dl>
        </>
      ) : (
        !error && <p className="muted">正在加载…</p>
      )}

      <p className="hint">
        「已下架」这一格数的是所有 status=deleted 的行：作者自己删、管理员从后台删、批量下架、
        因举报被连带下架，全都算在这一列里。区别只有一条 —— 后三种会留下 item_takedown 那行账，
        作者自删的不会。想知道某一条是谁弄的，去操作日志筛；那里筛不到，就说明是作者自己删的。
        解锁查看次数是全表行数 —— 它是「骚扰的唯一事后证据」，在这里看量级，出事再去台账里按人查。
      </p>
    </>
  )
}
