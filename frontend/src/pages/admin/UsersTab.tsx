// src/pages/admin/UsersTab.tsx —— #34 找人 + #35 改角色 + #36 封号解封 + #47 警告。
//
// 这一页的三件事后果差别极大，所以**每一样都要人在按之前读到那句说明**：
// 改角色动的是「谁能进这一页」，封号动的是「这个人还能不能用这个系统」，
// 警告动的是「什么都没有，只有一句话」。混在一个「操作」下拉里就等于没说。
//
// ⚠ 这一页**看不到手机号和邮箱**：不是没渲染，是 #34 压根不返回那两列
// （model/user.go:119-131：一页二十行铺满手机号等于把 §3.4 的解锁纪律从后台绕过去）。
// 所以这里也不许写「联系方式需要走 #22 解锁才能看」那种提示 —— 数据不在这一条响应里，
// 前端没有东西可显示，说一句都是猜。
//
// ⚠ 自己的那一行不给「降级」和「封自己」：后端两个方向都是 FORBIDDEN，
// 理由是同一条不可恢复论证（全站只剩一个 admin 时把自己降下去/封掉，没有任何 admin 路径能挽回）。
// 按钮摆在那里点一下得到一个 403，比不摆更坏 —— 那会让人以为后台坏了。
import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext'
import { listAdminUsers, setUserRole, setUserStatus, warnUser, reasonProblem, ROLE_OPTIONS, STATUS_OPTIONS } from '../../api/admin'
import { errorText, requestIdOf } from '../../api/errorText'
import { localMinute } from '../../lib/time'
import { Alert, ListPager, ReasonField } from './parts'
import type { AdminUserRow, Page, UserStatus } from '../../api/types'

const PAGE_ONE = 1
const PAGE_SIZE = 20

function toPage(raw: string | null): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : PAGE_ONE
}

type Kind = 'role' | 'status' | 'warn'

interface Pending {
  kind: Kind
  row: AdminUserRow
}

/** 这一条动作按下去会发生什么。文案的全部职责是**说准**：
 *  能说的只有后端真做的那几件事（写哪一行留痕、发不发通知、立刻不立刻）。 */
function consequence(kind: Kind, row: AdminUserRow): string {
  if (kind === 'warn') {
    return '只有这一条通知，没有任何自动后果：不扣分、不限制发帖、也不会记下「第几次警告」。要封号就另点封号。'
  }
  if (kind === 'role') {
    return row.role === 'admin'
      ? '他马上失去后台入口（后端每个请求都回库读一次 role，不用等他重新登录）。这件事不发通知。'
      : '他马上多出后台入口（后端每个请求都回库读一次 role，不用等他重新登录）。这件事不发通知。'
  }
  return row.status === 'banned'
    ? '解封之后他能重新登录，并收到一条带这句说明的通知；当初封他的那条也还在他自己的通知里。'
    : '封号立刻生效：他手上那张旧 token 当场作废，登录也会被拦。没有到期时间这回事，只能由管理员再点一次解封。他会收到一条写着这句理由的通知，但在他能登录之前读不到。'
}

export default function UsersTab() {
  const { user: me } = useAuth()
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const role = params.get('role') ?? ''
  const status = params.get('status') ?? ''
  const page = toPage(params.get('page'))

  const [keyword, setKeyword] = useState(q)
  const [data, setData] = useState<Page<AdminUserRow> | null>(null)
  const [error, setError] = useState('')
  const [errorId, setErrorId] = useState('')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setKeyword(q)
  }, [q])

  const load = useCallback(() => {
    let dead = false
    listAdminUsers({
      q: q || undefined,
      role: role || undefined,
      status: (status || undefined) as UserStatus | undefined,
      page: page === PAGE_ONE ? undefined : page,
      page_size: PAGE_SIZE,
    })
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
  }, [q, role, status, page])

  useEffect(() => load(), [load])

  function patch(next: Record<string, string>) {
    const merged = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (!v) merged.delete(k)
      else merged.set(k, v)
    }
    // 换筛选条件必须把页码清掉：停在「第 3 页」去看一个只有 1 页的结果集，
    // 屏幕上就是「这里没有人」配一个不存在的页码。
    if (merged.get('page') && !next.page) merged.delete('page')
    setParams(merged, { replace: true })
  }

  function open(next: Pending) {
    setPending(next)
    setReason('')
    setNotice('')
    setError('')
  }

  async function confirm() {
    if (!pending || reasonProblem(reason)) return
    setBusy(true)
    setError('')
    const id = pending.row.id
    const text = reason.trim()
    try {
      if (pending.kind === 'warn') {
        await warnUser(id, text)
        setNotice(`已给 #${id} 发出一条警告。除了那一条通知和操作日志里的一行账，他本人没有任何改变。`)
      } else if (pending.kind === 'role') {
        const target = pending.row.role === 'admin' ? 'user' : 'admin'
        const res = await setUserRole(id, target, text)
        setNotice(`#${res.id} 现在的角色是 ${res.role === 'admin' ? '管理员' : '普通用户'}。这件事没有发通知。`)
      } else {
        const target: UserStatus = pending.row.status === 'banned' ? 'active' : 'banned'
        const res = await setUserStatus(id, target, text)
        setNotice(
          res.status === 'banned'
            ? `#${res.id} 已被封禁，他手上的旧 token 当场失效。留痕是 user_ban。`
            : `#${res.id} 已解封，现在能重新登录。留痕是 user_unban。`,
        )
      }
      setPending(null)
      setReason('')
      load()
    } catch (err) {
      setError(errorText(err))
      setErrorId(requestIdOf(err))
    } finally {
      setBusy(false)
    }
  }

  const rows = data?.list ?? []

  return (
    <>
      <form
        className="filter-row"
        onSubmit={(e) => {
          e.preventDefault()
          patch({ q: keyword.trim() })
        }}
      >
        <div className="field">
          <label htmlFor="u-q">搜索</label>
          <input
            id="u-q"
            type="search"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="用户名 / 昵称 / 真实姓名"
          />
        </div>
        <div className="field">
          <label htmlFor="u-role">角色</label>
          <select id="u-role" value={role} onChange={(e) => patch({ role: e.target.value })}>
            <option value="">全部角色</option>
            {ROLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="u-status">状态</label>
          <select id="u-status" value={status} onChange={(e) => patch({ status: e.target.value })}>
            {/* 不选的时候是「两种都要」：后端没有「只看正常账号」那种默认值，
                被封禁的人一开始就在列表里 —— 找人时把人藏掉是更坏的默认。 */}
            <option value="">全部状态（含已封禁）</option>
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <button className="btn" type="submit">
          查
        </button>
      </form>

      <Alert error={error} errorId={errorId} />
      {notice && <p className="notice">{notice}</p>}

      {rows.length > 0 && (
        <ul className="adm-list">
          {rows.map((row) => {
            const isSelf = me?.id === row.id
            const openSame = pending?.kind && pending.row.id === row.id
            return (
              <li key={row.id} className="adm-row">
                <p className="adm-head">
                  <span className="adm-name">{row.nickname || '（没填昵称）'}</span>
                  <span className="tag">#{row.id}</span>
                  {row.role === 'admin' && <span className="tag tag-admin">管理员</span>}
                  {row.status === 'banned' && <span className="tag tag-deleted">已封禁</span>}
                  {isSelf && <span className="tag tag-new">这是你自己</span>}
                </p>
                <p className="item-meta">
                  登录名 {row.username || '（无：杭电助手账号）'} · {row.real_name || '未填真实姓名'} ·{' '}
                  {row.auth_source === 'local' ? '本地账号' : '杭电助手'} · 信用分 {row.credit_score} · 注册于{' '}
                  {localMinute(row.created_at)}
                </p>

                <p className="adm-actions">
                  {!isSelf && (
                    <button className="link-btn" type="button" disabled={!!pending} onClick={() => open({ kind: 'role', row })}>
                      {row.role === 'admin' ? '降为普通用户' : '提为管理员'}
                    </button>
                  )}
                  {!isSelf && (
                    <button className="link-btn" type="button" disabled={!!pending} onClick={() => open({ kind: 'status', row })}>
                      {row.status === 'banned' ? '解封' : '封禁'}
                    </button>
                  )}
                  <button className="link-btn" type="button" disabled={!!pending} onClick={() => open({ kind: 'warn', row })}>
                    发警告
                  </button>
                </p>

                {openSame && pending && (
                  <div className="adm-form">
                    <p className="hint">{consequence(pending.kind, row)}</p>
                    <ReasonField
                      id={`reason-${row.id}`}
                      label="理由（必填）"
                      value={reason}
                      onChange={setReason}
                      extra="这一句会原样出现在他收到的通知里，也是留痕中唯一说明「为什么」的一列。"
                    />
                    <p className="adm-actions">
                      {/* 理由为空时**先禁用**，不是点下去再弹错（计划 §M7 钉的那条规则在这一页同样成立）。 */}
                      <button
                        className="btn btn-primary"
                        type="button"
                        disabled={busy || !!reasonProblem(reason)}
                        onClick={confirm}
                      >
                        确定
                      </button>
                      <button className="btn" type="button" onClick={() => setPending(null)}>
                        先不
                      </button>
                    </p>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {data && rows.length === 0 && <p className="muted">这个筛选条件下没有这样的人。</p>}

      <ListPager page={page} pageSize={data?.page_size ?? PAGE_SIZE} total={data?.total ?? 0} onPage={(n) => patch({ page: String(n) })} />

      <p className="hint">
        列表里看不到手机号和邮箱：这一页返回的就是「这是谁、什么身份、什么状态、几分」那几列。
        改角色和改状态都不能撤销 —— 改回来要另一次操作，而那一次也会各留一行账。
      </p>
    </>
  )
}
