// src/pages/admin/TakedownTab.tsx —— #43 批量下架 + #44 恢复 + #45 删图 + #46 删归还确认。
//
// 这一页是计划 §M7 钉得最死的一页，两条原文规则都在这儿：
//   ① 「左侧多选列表（按作者聚合，勾选一个人等于勾他名下全部帖）」；
//   ② 「「确定」按钮在理由为空时**必须是禁用状态**，而不是点下去再弹错误」，
//      并且「理由文案下方直接预览通知会长什么样」。
// 预览那句不是装饰：后端把合并规则（一个作者一封、内容里带理由原文）写死在 service 里，
// 管理员在按下去之前应当看见**对方会看见的那句话**，这才是「理由必填」这条规则的全部意义。
//
// ⚠ 候选列表来自 #14 广场（GET /api/items），而不是某个 admin 专用列表：
// 后端**没有**「列某个用户名下全部帖子」这条端点，也没有 GET /api/admin/items。
// 所以「勾他名下全部帖」在这里只能是「这一批筛出来的帖子里，属于他的那些」，
// 页面上必须这么说实话 —— 说成「他全部的帖子」就是一个假承诺，而批量下架是不可逆的销毁动作。
//
// ⚠ #45 / #46 是**硬删除**（行没了、磁盘上的文件也 unlink 了），和 #43 的软删完全不同级；
// 而这两条都不能推进任何社区流程 —— admin 能销毁一行归还确认，但 confirm/reject 对他一律 FORBIDDEN。
// 这是定位原则 5 在这一页的形状，文案不许把它说成「代为处理」。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  MAX_REASON_RUNES,
  MAX_TAKEDOWN_IDS,
  adminDeleteItemImage,
  adminDeleteReturn,
  reasonProblem,
  restoreItem,
  takedownItems,
} from '../../api/admin'
import { listItems } from '../../api/items'
import { errorText, requestIdOf } from '../../api/errorText'
import { localMinute } from '../../lib/time'
import { Alert, IdField, ListPager, parseId, ReasonField } from './parts'
import type { ItemSummary, Page } from '../../api/types'

const PAGE_ONE = 1
// 一次取满 100（后端的 page_size 上限），因为「按作者聚合」这件事只在手里这一批里才数得准：
// 一个人五十条 spam 摊在三页上，每页二十条的话，勾第一个人的二十条会漏掉三十条。
const PAGE_SIZE = 100

interface AuthorGroup {
  authorId: number
  authorName: string
  items: ItemSummary[]
}

/** 按作者聚合，保持首次出现的顺序（和后端 groupByAuthor 同一个理由：
 *  用 Map 拼出来的顺序每次一样才可复现，通知条数也才对得上）。 */
export function groupByAuthor(rows: ItemSummary[]): AuthorGroup[] {
  const at = new Map<number, AuthorGroup>()
  for (const r of rows) {
    const g = at.get(r.author_id)
    if (g) g.items.push(r)
    else at.set(r.author_id, { authorId: r.author_id, authorName: r.author_name, items: [r] })
  }
  return [...at.values()]
}

/** 后端 service/moderation.go:438-446 那句 noticeAround 的前端复现：
 *  `你的 N 条帖子因『<理由>』被下架。` 位数、引号、句号都按那边来，
 *  所以这里预览出来的那一句和他将来收到的那一句是同一句。 */
export function takedownNoticeText(reason: string, count: number): string {
  return `你的 ${count} 条帖子因『${reason}』被下架。`
}

export default function TakedownTab() {
  const [params, setParams] = useSearchParams()
  const keyword = params.get('keyword') ?? ''
  const status = params.get('status') ?? ''
  const page = toPage(params.get('page'))

  const [input, setInput] = useState(keyword)
  const [data, setData] = useState<Page<ItemSummary> | null>(null)
  const [error, setError] = useState('')
  const [errorId, setErrorId] = useState('')
  const [notice, setNotice] = useState('')
  const [picked, setPicked] = useState<Set<number>>(() => new Set())
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setInput(keyword)
  }, [keyword])

  const load = useCallback(() => {
    let dead = false
    listItems({
      keyword: keyword || undefined,
      status: (status || undefined) as 'open' | 'closed' | undefined,
      page: page === PAGE_ONE ? undefined : page,
      page_size: PAGE_SIZE,
    })
      .then((res) => {
        if (dead) return
        setData(res)
        setError('')
        // 换一页 / 改一次筛选就把勾选清空：#43 下架的是**发过去的 id 列表**，
        // 留着上一批的勾等于让管理员按下「确定下架这 N 条」时，N 条里有几条根本不在屏幕上。
        setPicked(new Set())
      })
      .catch((err) => {
        if (dead) return
        setError(errorText(err))
        setErrorId(requestIdOf(err))
      })
    return () => {
      dead = true
    }
  }, [keyword, status, page])

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

  const groups = useMemo(() => groupByAuthor(data?.list ?? []), [data])
  const pickedCount = picked.size
  const authorCount = useMemo(() => {
    const s = new Set<number>()
    for (const g of groups) {
      for (const it of g.items) if (picked.has(it.id)) s.add(g.authorId)
    }
    return s.size
  }, [groups, picked])

  const trimmed = reason.trim()
  const tooMany = pickedCount > MAX_TAKEDOWN_IDS
  // 三个条件里只有「理由为空」是计划点名要禁的那一条，另外两条同样是「先禁、别说教」：
  // 一条空选择、一条超上限的批量，后端都会给 VALIDATION，而点了才知道毫无意义。
  const blocked = !!reasonProblem(reason) || pickedCount === 0 || tooMany

  function toggleItem(id: number) {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleGroup(g: AuthorGroup) {
    setPicked((prev) => {
      const next = new Set(prev)
      const all = g.items.every((it) => next.has(it.id))
      for (const it of g.items) {
        if (all) next.delete(it.id)
        else next.add(it.id)
      }
      return next
    })
  }

  async function confirm() {
    if (blocked) return
    setBusy(true)
    setError('')
    try {
      const ids = [...picked]
      const res = await takedownItems(ids, trimmed)
      setNotice(
        res.taken_down === 0
          ? `这一批 ${ids.length} 条都已经是下架状态了，所以什么都没改动（留痕仍然写了一行）。`
          : `已下架 ${res.taken_down} 条，通知了 ${res.notified_users} 位作者。放回去要用下面那个「恢复一条」。`,
      )
      setPicked(new Set())
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
          patch({ keyword: input.trim() })
        }}
      >
        <div className="field grow">
          <label htmlFor="t-keyword">按标题或描述筛</label>
          <input
            id="t-keyword"
            type="search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="比如「加微信」「代练」——先把这一批筛出来，才能按作者聚合"
          />
        </div>
        <div className="field">
          <label htmlFor="t-status">状态</label>
          <select id="t-status" value={status} onChange={(e) => patch({ status: e.target.value })}>
            <option value="">在广场上的（open）</option>
            <option value="closed">已关闭的（closed）</option>
          </select>
        </div>
        <button className="btn" type="submit">
          查
        </button>
      </form>

      <p className="muted">
        这里列的是当前筛选出来的这一页（每页最多 {PAGE_SIZE} 条），不是某个人的全部帖子 ——
        后端没有「按人列帖」这条端点。勾一个人等于勾这一页里他的每一帖。
      </p>

      <div className="adm-split">
        <div className="adm-left">
          <Alert error={error} errorId={errorId} />
          {rows.length === 0 && data && <p className="muted">这一批里没有帖子。</p>}
          {groups.map((g) => {
            const all = g.items.every((it) => picked.has(it.id))
            return (
              <fieldset key={g.authorId} className="adm-group">
                <legend>
                  <label>
                    <input
                      type="checkbox"
                      checked={all}
                      onChange={() => toggleGroup(g)}
                      aria-label={`全选 ${g.authorName || '（没填昵称）'} 在这一页里的 ${g.items.length} 条`}
                    />
                    {g.authorName || '（没填昵称）'}
                  </label>
                  <span className="tag">#{g.authorId}</span>
                  <span className="tag">这一页 {g.items.length} 条</span>
                </legend>
                <ul className="adm-items">
                  {g.items.map((it) => (
                    <li key={it.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={picked.has(it.id)}
                          onChange={() => toggleItem(it.id)}
                          aria-label={`第 ${it.id} 条 ${it.title}`}
                        />
                        <Link to={`/items/${it.id}`}>{it.title}</Link>
                        <span className="item-meta">
                          #{it.id} · {it.item_type === 'lost' ? '失物' : '拾物'} · {it.category_name} ·{' '}
                          {localMinute(it.created_at)}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
            )
          })}
        </div>

        <div className="adm-right">
          <ReasonField
            id="takedown-reason"
            label="下架理由（必填）"
            value={reason}
            onChange={setReason}
            rows={5}
            extra={`这一句会原样进每位作者的通知，也进那一行留痕。超过 ${MAX_REASON_RUNES} 字后端会拒收。`}
          />

          <div className="adm-preview">
            <p className="adm-preview-head">
              选了 {pickedCount} 条 · 将给 {authorCount} 位作者各发 1 条通知（不是每条帖子一封）
            </p>
            {authorCount > 0 && (
              <ul>
                {groups
                  .filter((g) => g.items.some((it) => picked.has(it.id)))
                  .map((g) => {
                    const n = g.items.filter((it) => picked.has(it.id)).length
                    return (
                      <li key={g.authorId}>
                        {g.authorName || '（没填昵称）'}：「{takedownNoticeText(trimmed || '（理由还没写）', n)}」
                      </li>
                    )
                  })}
              </ul>
            )}
          </div>

          {tooMany && (
            <p className="alert" role="alert">
              一次最多 {MAX_TAKEDOWN_IDS} 条，当前选了 {pickedCount} 条。换一页再筛一次，分两批下架。
            </p>
          )}

          <p className="adm-actions">
            {/* 计划钉的那一条：理由为空时**这个按钮是禁用的**，不是点下去再弹 VALIDATION。 */}
            <button className="btn btn-danger" type="button" disabled={blocked || busy} onClick={confirm}>
              确定下架选中的 {pickedCount} 条
            </button>
            <button className="btn" type="button" disabled={pickedCount === 0} onClick={() => setPicked(new Set())}>
              清空选择
            </button>
          </p>
          {notice && <p className="notice">{notice}</p>}
        </div>
      </div>

      <ListPager page={page} pageSize={PAGE_SIZE} total={data?.total ?? 0} onPage={(n) => patch({ page: String(n) })} />

      <hr className="adm-rule" />

      <IdReasonForm
        idPrefix="restore"
        title="把一条已下架的帖子放回广场"
        idLabel="帖子 id"
        idHint="在「操作日志」页里 item_takedown 那一行的 target_id 就是它；批量下架时 detail.ids 里那批只能一条条填。"
        reasonLabel="恢复理由（必填）"
        consequence="状态回到 open（不会因为下架前是 closed 就回 closed），不发任何通知，留痕是一行新的 item_restore —— 原来那行 item_takedown 不会被改掉也不会被删。"
        run={async (id, text) => {
          const res = await restoreItem(id, text)
          return `#${res.id} 已放回广场（status=${res.status}）。没有给作者发通知。`
        }}
      />

      <IdReasonForm
        idPrefix="del-image"
        title="删掉一张图片（硬删除）"
        idLabel="图片 id"
        idHint="帖子详情里那几张图的 id；#42 是帖主自删那一条，这一条是管理员删。"
        reasonLabel="删掉这张图的理由（必填）"
        consequence="库里那行删掉、磁盘上那个文件也一起删，帖子本身还在广场上。作者会收到一条明写「帖子本身没有被下架」的通知。不可恢复。"
        run={async (id, text) => {
          await adminDeleteItemImage(id, text)
          return `图片 #${id} 已删除（行和文件都走了），帖子没动，作者收到了通知。`
        }}
      />

      <IdReasonForm
        idPrefix="del-return"
        title="删掉一条归还确认记录（硬删除）"
        idLabel="归还确认 id"
        idHint="归还详情页地址栏里那个号就是它；操作日志的 detail 里也带着它。⚠ 这一条只是销毁记录，平台不会替任何人确认或驳回归还。"
        reasonLabel="删掉这条记录的理由（必填）"
        consequence="那一行记录被硬删，只通知提交人（发帖人不收），积分一点不动，帖子状态也一点不动。这是「admin 能销毁内容，但不能制造归属」在这条端点上的意思。"
        run={async (id, text) => {
          await adminDeleteReturn(id, text)
          return `归还确认 #${id} 已删除，提交人会收到一条通知。发帖人和帖子都没有被改动。`
        }}
      />
    </>
  )
}

function toPage(raw: string | null): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : PAGE_ONE
}

/** 「填一个 id + 写一句理由」那一类的三个动作共用这一小块。
 *  三处的判据形状一样（id 坏 → NOT_FOUND，理由空 → 后端 VALIDATION，而这里先禁用），
 *  所以规则只写一遍；差别只在后果那句话和实际调哪个函数。 */
function IdReasonForm({
  idPrefix,
  title,
  idLabel,
  idHint,
  reasonLabel,
  consequence,
  run,
}: {
  idPrefix: string
  title: string
  idLabel: string
  idHint: string
  reasonLabel: string
  consequence: string
  run: (id: number, reason: string) => Promise<string>
}) {
  const [rawId, setRawId] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [errorId, setErrorId] = useState('')
  const [notice, setNotice] = useState('')

  const id = parseId(rawId)
  const blocked = id === null || !!reasonProblem(reason)

  async function submit() {
    if (id === null || blocked) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      setNotice(await run(id, reason.trim()))
      setRawId('')
      setReason('')
    } catch (err) {
      setError(errorText(err))
      setErrorId(requestIdOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="adm-single">
      <h2>{title}</h2>
      <p className="hint">{consequence}</p>
      <IdField
        id={`${idPrefix}-id`}
        label={idLabel}
        value={rawId}
        onChange={setRawId}
        hint={idHint}
      />
      <ReasonField id={`${idPrefix}-reason`} label={reasonLabel} value={reason} onChange={setReason} rows={3} />
      <Alert error={error} errorId={errorId} />
      {notice && <p className="notice">{notice}</p>}
      <p className="adm-actions">
        <button className="btn" type="button" disabled={blocked || busy} onClick={submit}>
          确定
        </button>
      </p>
    </section>
  )
}
