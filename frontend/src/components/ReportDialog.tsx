// src/components/ReportDialog.tsx —— #41 POST /api/items/:id/report 的弹层。
//
// 计划 §M7 对这一块只有两句话，但两句都是硬约束：
//   ① 入口要**弱**（详情页右上角一个小的文字按钮，不是红色图标）—— 那是调用方的事，见 ItemDetailPage。
//   ② 提交成功的提示**必须**是「已记录，管理员会看到」，**绝不能**写「我们会尽快处理」或「该帖子将被下架」。
// 后端这条链路上只有一条 INSERT：不下架、不扣分、不影响排序、被举报人永远不知道（§3.7）。
// 前端一旦替 admin 承诺了处置，用户下次举报没结果就会认为平台说话不算数 ——
// 而举报是这套系统唯一的眼睛，把它用坏了就再也没有第二条信息来源。
import { useState } from 'react'
import { reportItem } from '../api/items'
import { errorText, requestIdOf } from '../api/errorText'
import { Code } from '../api/codes'
import { ApiError } from '../api/client'
import { REPORT_REASONS, type ReportReasonCode } from '../api/types'

interface Props {
  itemId: number | string
  onClose: () => void
}

export default function ReportDialog({ itemId, onClose }: Props) {
  const [reason, setReason] = useState<ReportReasonCode | ''>('')
  const [detail, setDetail] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [duplicate, setDuplicate] = useState(false)
  const [error, setError] = useState('')
  const [errorId, setErrorId] = useState('')

  async function submit() {
    if (!reason) return
    setBusy(true)
    setError('')
    setDuplicate(false)
    try {
      await reportItem(itemId, reason, detail)
      setDone(true)
    } catch (err) {
      if (err instanceof ApiError && err.code === Code.REPORT_DUPLICATE) {
        // 单独认这个码而不是把它当成普通失败：它的正确处理是「你已经报过了，不用再来一次」，
        // 而把这句话写成通用错误提示，用户会以为是自己网不好，然后再点一次。
        setDuplicate(true)
      } else {
        setError(errorText(err))
        setErrorId(requestIdOf(err))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="举报这条帖子"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>举报</h2>
          <button className="sheet-close" type="button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        {done ? (
          <>
            {/* 这一句是这块 UI 的全部契约：一个事实（已记录）+ 一个受众（管理员会看到）。
                role="status" 不是为了好看：提交成功后那个获得焦点的按钮会被卸载，
                焦点掉回 body，读屏用户就听不到任何东西 —— 而「到底报成功了没有」
                正是这一步唯一需要确认的事。 */}
            <p className="notice" role="status">已记录，管理员会看到。</p>
            <button className="btn btn-block" type="button" onClick={onClose}>
              知道了
            </button>
          </>
        ) : (
          <>
            <p className="muted">
              举报只是把这条帖子放进管理员的待办队列。它不会自动下架、不会扣分，
              被举报的人也看不到是谁报的。
            </p>

            <fieldset className="reasons">
              <legend>理由</legend>
              {REPORT_REASONS.map((r) => (
                <label className="reason" key={r.value}>
                  <input
                    type="radio"
                    name="reason_code"
                    value={r.value}
                    checked={reason === r.value}
                    onChange={() => setReason(r.value)}
                  />
                  {r.label}
                </label>
              ))}
            </fieldset>

            <div className="field">
              <label htmlFor="report-detail">补充说明（选填）</label>
              <textarea
                id="report-detail"
                rows={3}
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
              />
              <p className="hint">不用写很长，说清哪里不对就够。</p>
            </div>

            {duplicate && (
              <p className="alert" role="alert">
                你已经举报过这条帖子了，同一人对同一帖只留一条待处理举报，不用重复提交。
              </p>
            )}
            {error && (
              <p className="alert" role="alert">
                {error}
                {errorId && <span className="req-id">（请求编号 {errorId}）</span>}
              </p>
            )}

            {/* 理由没选时按钮是**禁用**而不是点了再报错 —— 和 admin 批量下架页同一条规矩：
                让人先看到「还不能提交」，比让人提交完再看到「提交失败」好。 */}
            <button className="btn btn-primary btn-block" type="button" disabled={!reason || busy} onClick={submit}>
              {busy ? '提交中…' : '提交举报'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
