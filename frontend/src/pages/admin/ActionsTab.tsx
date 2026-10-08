// src/pages/admin/ActionsTab.tsx —— #50 操作日志（只读）。
//
// 这一页存在的意义是计划 §M7 那句「任何 admin 都能看见其他 admin 干了什么」——
// 风险 14 的唯一防线不是审批流，是事后可追责。所以它**没有任何默认过滤**：
// 后端明写不采纳「只看我自己做的」那种默认（那会把一本对所有人摊开的账变成自我备忘）。
//
// 这一页只读，而且读的是那本**只追加**的账：#44 恢复一条帖子不会抹掉当初 #43 那行，
// 只会新增一行 item_restore。所以「下架了又放回去」在这里是两行，
// 那不是脏数据，那正是这段历史的完整形状。
//
// ⚠ detail 在契约上**永远是一个 JSON 对象**（列是 JSONB NOT NULL DEFAULT '{}'，
// 空的时候后端补 "{}"，model/admin_action.go:165-177），所以这里可以当对象读，
// 不需要判 null、也不需要第二次 JSON.parse。未知键一律按 `键=值` 兜出来 ——
// 后端将来加一个键，这一页宁可显示得丑，也不要静默不显示。
//
// ⚠ admin 那一格可能是 null：做这件事的账号已经被删掉了。SQL 用的是
// `(u.id IS NULL) AS admin_missing`，不是「昵称空串就当没这个人」
// （users.nickname 是 NOT NULL DEFAULT ''，一个从没填过昵称的真实用户也是空串）。
import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ACTION_OPTIONS,
  TARGET_TYPE_OPTIONS,
  listAdminActions,
} from '../../api/admin'
import { errorText, requestIdOf } from '../../api/errorText'
import { localMinute } from '../../lib/time'
import { Alert, ListPager, parseId } from './parts'
import type { AdminActionRow, AdminActionDetail, AdminActionName, AdminTargetType, Page } from '../../api/types'

const PAGE_ONE = 1
const PAGE_SIZE = 20

function toPage(raw: string | null): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : PAGE_ONE
}

function actionLabel(a: AdminActionName): string {
  return ACTION_OPTIONS.find((o) => o.value === a)?.label ?? a
}

function targetLabel(t: AdminTargetType): string {
  return TARGET_TYPE_OPTIONS.find((o) => o.value === t)?.label ?? t
}

const RESOLUTION_LABEL: Record<string, string> = {
  takedown: '下架',
  ban: '封号',
  dismiss: '驳回',
}

/** 那批 ids 只列前 8 个：五十条 spam 的一次下架，把五十个数字摊在一页表格里
 *  等于谁也没法读，而完整那份在下面的「原文」里，一个字符都没少。 */
const IDS_SHOWN = 8

const DETAIL_ORDER = [
  'ids',
  'count',
  'report_id',
  'resolution',
  'also_closed',
  'item_id',
  'author_id',
  'submitter_id',
  'previous_status',
  'status',
  'role',
  'name',
  'level',
  'parent_id',
] as const

/** 把 detail 翻成一句人话。逐键走已知表，剩下的原样带出（见文件头那条兜底理由）。 */
export function detailText(d: AdminActionDetail): string {
  const parts: string[] = []
  const known = new Set<string>(DETAIL_ORDER)

  if (d.ids && d.ids.length) {
    const shown = Math.min(IDS_SHOWN, d.ids.length)
    const head = d.ids.slice(0, shown).map((i) => `#${i}`).join(' ')
    parts.push(
      d.ids.length > shown
        ? `这批 ${d.ids.length} 条：${head} 等（共 ${d.count ?? d.ids.length} 条）`
        : `这批 ${d.ids.length} 条：${head}`,
    )
  }
  // count 只在「没有 ids」时单独说：批量下架那一行里它已经并进上面那句「共 N 条」了，
  // 再列一遍就是重复；而万一后端只给 count 不给 ids，这一格也不能把它悄悄吞掉。
  if (d.count && !d.ids) parts.push(`共 ${d.count} 条`)
  if (d.report_id) parts.push(`由举报 #${d.report_id} 触发`)
  if (d.resolution) parts.push(`处置=${RESOLUTION_LABEL[d.resolution] ?? d.resolution}`)
  if (d.also_closed) parts.push(`同时关掉 ${d.also_closed.length} 条同帖举报`)
  if (d.item_id) parts.push(`帖子 #${d.item_id}`)
  if (d.author_id) parts.push(`作者 #${d.author_id}`)
  if (d.submitter_id) parts.push(`提交人 #${d.submitter_id}`)
  if (d.previous_status) parts.push(`删掉之前是 ${d.previous_status}`)
  if (d.status) parts.push(`现在 ${d.status}`)
  if (d.role) parts.push(`改成 ${d.role === 'admin' ? '管理员' : '普通用户'}`)
  if (d.name) parts.push(`「${d.name}」${d.level ? `${d.level} 级` : ''}`)
  if (d.parent_id !== undefined && d.parent_id !== null) parts.push(`父 #${d.parent_id}`)

  for (const [k, v] of Object.entries(d)) {
    if (!known.has(k) && v !== undefined && v !== null) parts.push(`${k}=${JSON.stringify(v)}`)
  }
  return parts.join(' · ')
}

export default function ActionsTab() {
  const [params, setParams] = useSearchParams()
  const adminId = params.get('admin_id') ?? ''
  const targetId = params.get('target_id') ?? ''
  const targetType = params.get('target_type') ?? ''
  const action = params.get('action') ?? ''
  const page = toPage(params.get('page'))

  const [data, setData] = useState<Page<AdminActionRow> | null>(null)
  const [error, setError] = useState('')
  const [errorId, setErrorId] = useState('')

  const load = useCallback(() => {
    let dead = false
    listAdminActions({
      admin_id: parseId(adminId) ?? undefined,
      target_id: parseId(targetId) ?? undefined,
      target_type: (targetType || undefined) as AdminTargetType | undefined,
      action: (action || undefined) as AdminActionName | undefined,
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
  }, [adminId, targetId, targetType, action, page])

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

  const rows = data?.list ?? []
  const noFilter = !adminId && !targetId && !targetType && !action

  return (
    <>
      <div className="filter-row">
        <div className="field">
          <label htmlFor="a-admin">哪个管理员</label>
          <input
            id="a-admin"
            type="text"
            inputMode="numeric"
            value={adminId}
            onChange={(e) => patch({ admin_id: e.target.value.trim() })}
            placeholder="账号 id，留空=不限"
          />
        </div>
        <div className="field">
          <label htmlFor="a-target-id">对象 id</label>
          <input
            id="a-target-id"
            type="text"
            inputMode="numeric"
            value={targetId}
            onChange={(e) => patch({ target_id: e.target.value.trim() })}
            placeholder="帖子/用户/举报的 id，留空=不限"
          />
        </div>
        <div className="field">
          <label htmlFor="a-target-type">对象类型</label>
          <select
            id="a-target-type"
            value={targetType}
            onChange={(e) => patch({ target_type: e.target.value })}
          >
            <option value="">全部类型</option>
            {TARGET_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="a-action">做了什么</label>
          <select id="a-action" value={action} onChange={(e) => patch({ action: e.target.value })}>
            <option value="">全部动作</option>
            {ACTION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* 那两个下拉不是审美：这两个参数进的是 WHERE，拼错一个字母**不报错，只是列表空了**，
          管理员会以为「没人做过这件事」。id 那两个框只能自由输入，所以后端给了 0 那种值要当「不限」处理，
          这里用 parseId 把非正整数一律折成 undefined。 */}
      <p className="muted">
        {noFilter ? '现在没有加任何筛选：这是全站所有的治理动作。' : '筛选后的结果。'}
        处置一次举报会写一到两行：驳回只有 report_resolved 那一行，下架和封号会先写那件事本身那一行、
        再写 report_resolved。这两行的时间戳相同，靠 id 分出先后 —— 那是设计，不是重复记账。
      </p>

      <Alert error={error} errorId={errorId} />

      {rows.length > 0 && (
        <ul className="adm-list">
          {rows.map((row) => (
            <li key={row.id} className="adm-row">
              <p className="adm-head">
                <span className="adm-name">{actionLabel(row.action)}</span>
                <span className="tag">
                  {targetLabel(row.target_type)} #{row.target_id}
                </span>
                {row.action === 'item_takedown' && row.target_type === 'item' && (
                  <Link className="link-btn" to={`/items/${row.target_id}`}>
                    打开这条
                  </Link>
                )}
              </p>
              <p className="item-meta">
                {localMinute(row.created_at)} ·{' '}
                {row.admin ? (
                  <>
                    由 {row.admin.nickname || '（没填昵称）'}（#{row.admin.id}）做的
                  </>
                ) : (
                  // 那一行的 admin 账号已经不在了：留痕照列，不做归属推断，
                  // 后端这时给的是 admin:null（连 id 都不给，因为那个 id 已无处可查）。
                  <>做这件事的账号已经被删掉了</>
                )}
              </p>
              <p className="adm-reason">{row.reason}</p>
              {Object.keys(row.detail ?? {}).length > 0 && (
                <>
                  <p className="adm-detail">{detailText(row.detail)}</p>
                  <details className="adm-raw">
                    <summary>原文</summary>
                    <code>{JSON.stringify(row.detail)}</code>
                  </details>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {data && rows.length === 0 && <p className="muted">这一批条件下没有留痕。</p>}

      <ListPager page={page} pageSize={data?.page_size ?? PAGE_SIZE} total={data?.total ?? 0} onPage={(n) => patch({ page: String(n) })} />

      <p className="hint">
        这本账只能追加：这一页没有任何改、删的入口，整个后端也只有 service 那一个写入点。
        「谁做的」那一格给的是昵称，因为日志要回答的是「谁做的」，不是「这人现在叫什么、几分」。
      </p>
    </>
  )
}
