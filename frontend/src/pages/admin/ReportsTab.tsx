// src/pages/admin/ReportsTab.tsx —— #48 待办 + #49 三种处置。
//
// 两个坑必须在写代码之前就认清，否则这一页会「看起来对」而实际是错的：
//
// ① **后端没有「默认只看待处理」**。#48 不传 status 就是把 open / resolved / dismissed 三种一起给你，
//    所以标题写着「待办」的那一页必须自己带上 `status=open`，否则第一屏就装着已经处理完的行。
//
// ② **排序是按时间，不是按热度**。后端是 `created_at DESC, id DESC`（最新的在最上面），
//    而计划要的是「被举报次数多的排前面」。`report_count_on_item` 这一列给了，
//    排序却没人给，所以这一页拿到一页之后自己排 —— 那个排序只在**当前这一页内**成立
//    （热度没法跨分页排，那是 SQL 的活）。
//    ⚠ 但计数本身**不是**本页的：#48 那条相关子查询按 item_id 数的是**全表的 open 举报数**
//    （SQL 里的别名就叫 open_count_on_item），所以标签说的是「这条帖子上几条待处理」，
//    而且一条已经处置完的行上它可以是 0 —— 那不是数据坏了，是它自己不再计入 open。
//
// 措辞纪律（§3.7，后端 TestNoticeCopyMakesNoPlatformPromise 那份禁词表同样管着前端）：
// `resolution` 只是「管理员决定做哪个动作」，**不代表平台认定举报成立**。
// 所以这里不许出现「判定违规」「确认是骗子」那种词，回执那一栏也只能说「已记录处理结果」。
import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  MAX_REASON_RUNES,
  REPORT_STATUS_LABEL,
  RESOLUTION_OPTIONS,
  listAdminReports,
  reasonProblem,
  resolveReport,
} from '../../api/admin'
import { errorText, requestIdOf } from '../../api/errorText'
import { localMinute } from '../../lib/time'
import { Alert, ListPager, ReasonField } from './parts'
import { REPORT_REASONS } from '../../api/types'
import type { AdminReportRow, Page, ReportReasonCode, ReportResolution, ReportStatus } from '../../api/types'

const PAGE_ONE = 1
const PAGE_SIZE = 20

function toPage(raw: string | null): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : PAGE_ONE
}

function reasonLabel(code: ReportReasonCode): string {
  return REPORT_REASONS.find((r) => r.value === code)?.label ?? code
}

/** 本页内按「这条帖子上还有几条待处理举报」从多到少。数量一样时保持后端那个「新的在前」。
 *  Array.prototype.sort 在现代引擎里是稳定的，所以这里不需要再自己写第二级键 ——
 *  写反而会把 created_at 的次序二次定义一遍，而那一列的语义后端已经定过了。 */
function byHotness(rows: AdminReportRow[]): AdminReportRow[] {
  return [...rows].sort((a, b) => b.report_count_on_item - a.report_count_on_item)
}

/** 每种处置按下去会发生什么。这里的每一句都必须能从后端代码里逐条对上：
 *  下架 = 帖子变 deleted + 作者一条含理由原文的通知；封号 = **帖子不会消失** + 号立刻失效；
 *  驳回 = 帖子不动，举报人收到一句「未采纳」。 */
function consequence(resolution: ReportResolution): string {
  if (resolution === 'takedown') {
    return '下架这条帖子：它从广场消失（是软删，行还在库里），发帖人会收到一条写着这句理由的通知。同一条帖子上其他待处理的举报会一起关掉。'
  }
  if (resolution === 'ban') {
    return '封禁发帖的账号：他立刻登不上、旧 token 当场作废，但这条帖子不会因此消失（封号不删内容）。他会收到一条含这句理由的通知。同一条帖子上其他待处理的举报会一起关掉。'
  }
  return '驳回这条举报：帖子不动、人不动，只有这条举报从待处理变成未采纳。举报人会收到一句「未采纳」，可以附上下面那句说明。'
}

export default function ReportsTab() {
  const [params, setParams] = useSearchParams()
  // 这一页的**默认视图就是待办**，所以 status 缺省时补 open，而不是让它等于「全部」。
  // 而「显式选了全部」必须能和「压根没带这个键」分开 —— 用 all 这个哨兵值：
  // 空串在 patch() 里等于删掉这个键，那样一选就弹回默认，「全部」这一档永远选不中。
  const statusParam = params.get('status')
  const status: ReportStatus | '' =
    statusParam === 'all' ? '' : statusParam === null ? 'open' : (statusParam as ReportStatus)
  const code = params.get('reason_code') ?? ''
  const page = toPage(params.get('page'))

  const [data, setData] = useState<Page<AdminReportRow> | null>(null)
  const [error, setError] = useState('')
  const [errorId, setErrorId] = useState('')
  const [notice, setNotice] = useState('')
  const [openId, setOpenId] = useState<number | null>(null)
  const [resolution, setResolution] = useState<ReportResolution>('takedown')
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    let dead = false
    listAdminReports({
      status: status || undefined,
      reason_code: (code || undefined) as ReportReasonCode | undefined,
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
  }, [status, code, page])

  useEffect(() => load(), [load])

  function patch(next: Record<string, string>) {
    const merged = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (!v) merged.delete(k)
      else merged.set(k, v)
    }
    if (merged.get('page') && !next.page) merged.delete('page')
    setParams(merged, { replace: true })
  }

  function openForm(row: AdminReportRow) {
    setOpenId(row.id === openId ? null : row.id)
    setResolution('takedown')
    setReason('')
    setNote('')
    setError('')
  }

  async function confirm() {
    if (openId === null || reasonProblem(reason)) return
    setBusy(true)
    setError('')
    try {
      const res = await resolveReport(openId, {
        resolution,
        reason: reason.trim(),
        note: note.trim() || undefined,
      })
      setNotice(
        res.status === 'dismissed'
          ? `#${res.id} 已记为未采纳。举报人会收到一句「未采纳」${note.trim() ? '，附你那句说明' : ''}。这一次只写了一行留痕。`
          : `#${res.id} 已记为采纳（${res.status}）。这条帖子上的其他待办举报也一起关掉了，所以待办数可能少不止 1 条。留痕是两行：一件事一行。`,
      )
      setOpenId(null)
      setReason('')
      setNote('')
      load()
    } catch (err) {
      setError(errorText(err))
      setErrorId(requestIdOf(err))
    } finally {
      setBusy(false)
    }
  }

  const rows = data ? byHotness(data.list) : []

  return (
    <>
      <div className="filter-row">
        <div className="field">
          <label htmlFor="r-status">处理状态</label>
          <select
            id="r-status"
            value={status || 'all'}
            onChange={(e) => patch({ status: e.target.value })}
          >
            <option value="open">待处理</option>
            <option value="all">全部（含已处理）</option>
            <option value="resolved">已采纳</option>
            <option value="dismissed">未采纳</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="r-code">举报理由</label>
          <select id="r-code" value={code} onChange={(e) => patch({ reason_code: e.target.value })}>
            <option value="">全部理由</option>
            {REPORT_REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <Alert error={error} errorId={errorId} />
      {notice && <p className="notice">{notice}</p>}

      {rows.length > 0 && (
        <ul className="adm-list">
          {rows.map((row) => (
            <li key={row.id} className="adm-row">
              <p className="adm-head">
                <span className="adm-name">{row.item.title}</span>
                <span className="tag">#{row.item.id}</span>
                {row.item.status !== 'open' && <span className="tag tag-deleted">帖子已是 {row.item.status}</span>}
                <span className="tag tag-hot">这条帖子上 {row.report_count_on_item} 条待处理</span>
                {row.status !== 'open' && <span className="tag">{REPORT_STATUS_LABEL[row.status]}</span>}
              </p>
              <p className="item-meta">
                {reasonLabel(row.reason_code)} · 举报人 {row.reporter.nickname || '（没填昵称）'} ·{' '}
                {localMinute(row.created_at)}
              </p>
              {row.detail && <p className="adm-reason">{row.detail}</p>}
              <p className="adm-actions">
                <button className="link-btn" type="button" disabled={!!openId && openId !== row.id} onClick={() => openForm(row)}>
                  {row.status === 'open' ? '处置这一条' : '看能填什么（已处理过，提交会被告知已处置）'}
                </button>
                <Link className="link-btn" to={`/items/${row.item.id}`}>
                  打开这条帖子
                </Link>
              </p>

              {openId === row.id && (
                <div className="adm-form">
                  <div className="field">
                    <label htmlFor="resolve-kind">处置</label>
                    <select
                      id="resolve-kind"
                      value={resolution}
                      onChange={(e) => setResolution(e.target.value as ReportResolution)}
                    >
                      {RESOLUTION_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <p className="muted">{consequence(resolution)}</p>
                  </div>

                  <ReasonField
                    id="resolve-reason"
                    label="理由（必填）"
                    value={reason}
                    onChange={setReason}
                    extra="对被处置的人和留痕说话：这句会原样进他的通知。"
                  />

                  <div className="field">
                    <label htmlFor="resolve-note">给举报人的说明（选填）</label>
                    <textarea
                      id="resolve-note"
                      rows={2}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder={`最多 ${MAX_REASON_RUNES} 个字。写结论，别写「被举报人是谁」——那种话一旦从这条路出去，举报就会变成互相攻击的工具。`}
                    />
                  </div>

                  <p className="adm-actions">
                    <button
                      className="btn btn-primary"
                      type="button"
                      disabled={busy || !!reasonProblem(reason)}
                      onClick={confirm}
                    >
                      确定
                    </button>
                    <button className="btn" type="button" onClick={() => setOpenId(null)}>
                      先不
                    </button>
                  </p>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {data && rows.length === 0 && (
        <p className="muted">
          {status === 'open' ? '现在没有待处理的举报。' : '这个筛选条件下没有举报记录。'}
        </p>
      )}

      <ListPager page={page} pageSize={data?.page_size ?? PAGE_SIZE} total={data?.total ?? 0} onPage={(n) => patch({ page: String(n) })} />

      <p className="hint">
        「这条帖子上几条待处理」只有在这一页看得见 —— 普通用户那边没有任何一处会显示自己被打了几次，
        这是举报不变成攻击工具的前提。处置结论只决定管理员做了什么动作，不代表平台认定谁对谁错。
      </p>
    </>
  )
}
