// src/pages/admin/parts.tsx —— 五个页签共用的四小块。
//
// 为什么抽出来：用户 / 举报 / 日志三页都是「筛选 + 分页表格」，
// 下架 / 恢复 / 警告 / 处置四个表单都是「一个必填的理由 + 一句它会造成什么」。
// 各写一遍的话，「理由为空时按钮必须先禁用」这条计划钉死的规则就会出现四份实现，
// 而其中一份忘了写也没人能发现 —— 这类规则只该有一个地方。
import { runeLen } from '../../lib/runes'
import { MAX_REASON_RUNES, reasonProblem } from '../../api/admin'

/** §8 的错误行：文案 + 请求编号（§9 那套可 debug 机制的前端出口）。 */
export function Alert({ error, errorId }: { error: string; errorId?: string }) {
  if (!error) return null
  return (
    <p className="alert" role="alert">
      {error}
      {errorId && <span className="req-id">（请求编号 {errorId}）</span>}
    </p>
  )
}

/** 分页条。page 从 1 起，越界由调用方（URL 参数）负责归一。 */
export function ListPager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number
  pageSize: number
  total: number
  onPage: (next: number) => void
}) {
  if (total <= 0) return null
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return (
    <div className="pager">
      <button className="btn" type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        上一页
      </button>
      <span className="muted">
        第 {page} / {pages} 页，共 {total} 条
      </span>
      <button
        className="btn"
        type="button"
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
      >
        下一页
      </button>
    </div>
  )
}

/** 必填理由那一格。
 *
 * 计划钉的那条规则在这一块**外面**（按钮的 disabled），这里只负责把状态说清楚：
 * 还差什么、已经几个字。`extra` 是各页自己的补充说明（「这句会原样出现在他的通知里」那种）。 */
export function ReasonField({
  id,
  label,
  value,
  onChange,
  rows = 3,
  extra,
}: {
  id: string
  label: string
  value: string
  onChange: (next: string) => void
  rows?: number
  extra?: string
}) {
  const len = runeLen(value.trim())
  const problem = reasonProblem(value)
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="会原样出现在对方收到的通知里，也写进治理留痕"
      />
      <p className="item-meta">
        {len} / {MAX_REASON_RUNES} 字
        {problem && <span className="field-error">　{problem}</span>}
      </p>
      {extra && <p className="muted">{extra}</p>}
    </div>
  )
}

/** 只有 id 的自由输入：#44 / #45 / #46 都是「报一个编号」。
 *  后端对坏 id 给的是 NOT_FOUND（`pathID` 那条），不是 VALIDATION，
 *  所以这里只做「填了吗、是正整数吗」的最少预检，剩下的交给后端判。 */
export function IdField({
  id,
  label,
  value,
  onChange,
  hint,
}: {
  id: string
  label: string
  value: string
  onChange: (next: string) => void
  hint?: string
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <p className="muted">{hint}</p>}
    </div>
  )
}

/** 把一个自由文本收成「可以发出去的 id」。返回 null 表示还不能用 —— 
 *  调用方用它来决定按钮禁用，而不是点了再报错。 */
export function parseId(raw: string): number | null {
  const t = raw.trim()
  if (!t) return null
  const n = Number(t)
  if (!Number.isInteger(n) || n <= 0) return null
  return n
}
