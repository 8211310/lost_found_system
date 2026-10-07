// src/pages/MyPostsPage.tsx —— #19 GET /api/my/items（我的发布）。
//
// 这一页存在的理由不是「把广场的列表换个 URL」，而是它回答两个广场答不了的问题：
//   ① 「我发的那些现在怎么样了」—— 广场（#14）的状态白名单只有 open/closed，
//      已经下架或自己删掉的帖子在广场上根本不存在，那几行只有这里能列出来；
//   ② 「不见了的那条是为什么不见的」—— removal 这个键只在 #19 出现（见 ItemSummary 上那段），
//      而且它是「为什么」而不是「谁干的」：后端刻意不给操作者身份和举报条数。
//
// 筛选状态放在 URL 里，和广场同一条理由：这一页的人会反复回来，也会把「我那些还在找的」
// 这个链接发给别人看自己的进度。
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { listMyItems, type MyItemListQuery } from '../api/my'
import { errorText, requestIdOf } from '../api/errorText'
import ItemCard from '../components/ItemCard'
import { localMinute } from '../lib/time'
import type { ItemSummary, Page } from '../api/types'

const PAGE_ONE = 1

function toNumber(raw: string | null): number | undefined {
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** 状态筛选的三个值都要能停在 URL 里，包括 deleted：
 *  那一档正是这一页区别于广场的地方，默认视图反而是最常用的「还在挂着」。 */
const STATUSES: Array<[string, string]> = [
  ['', '全部状态'],
  ['open', '还在挂着'],
  ['closed', '已归还'],
  ['deleted', '已下架 / 已删除'],
]

/** 一条自己发的帖子下面挂什么。
 *  解锁名单的入口只给 found 帖：#21 对 lost 帖返回 VALIDATION（失物帖的联系方式本来就公开，
 *  没有「认领之后才给」这一步），所以失物帖的 contact_views 永远是空的 ——
 *  给一个点进去必然是空列表的链接，比不给更糟。
 *
 *  但这一条**不看 status**：后端 #22 的注释专门写了「作者被下架之后仍然有权知道
 *  在被下架之前谁来看过」，那份记录是治理场景里最需要的证据。
 *  反过来，「修改」和「重新开放」这类动作在 deleted 上是必然吃 ITEM_CLOSED 的，所以那两个才要判。 */
function rowFooter(item: ItemSummary): ReactNode {
  return (
    <>
      {item.removal && (
        <p className="removal-box">
          <strong>已被管理员下架</strong>
          <span>{item.removal.reason}</span>
          <span className="muted">
            下架于 {localMinute(item.removal.created_at)}，处理编号 {item.removal.action_id}
            —— 要申诉或报修，报这个编号。
          </span>
        </p>
      )}
      {item.status === 'deleted' && !item.removal && (
        <p className="muted">这条已经关掉，广场和搜索里都查不到它了；系统里没有自助恢复的入口。</p>
      )}
      <span className="item-actions">
        {item.item_type === 'found' && (
          <Link className="link-btn" to={`/items/${item.id}/unlockers`}>
            谁看过联系方式
          </Link>
        )}
        {item.status !== 'deleted' && (
          <Link className="link-btn" to={`/items/${item.id}/edit`}>
            修改
          </Link>
        )}
      </span>
    </>
  )
}

export default function MyPostsPage() {
  const [params, setParams] = useSearchParams()
  const [data, setData] = useState<Page<ItemSummary> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [errorId, setErrorId] = useState('')
  const [keywordDraft, setKeywordDraft] = useState(params.get('keyword') ?? '')

  const query = useMemo<MyItemListQuery>(() => {
    const q: MyItemListQuery = {}
    const itemType = params.get('item_type')
    if (itemType === 'lost' || itemType === 'found') q.item_type = itemType
    const status = params.get('status')
    if (status === 'open' || status === 'closed' || status === 'deleted') q.status = status
    const sort = params.get('sort')
    if (sort === 'created_at' || sort === 'lost_at' || sort === 'found_at') q.sort = sort
    const keyword = params.get('keyword')
    if (keyword) q.keyword = keyword
    const page = toNumber(params.get('page'))
    if (page) q.page = page
    return q
  }, [params])

  useEffect(() => {
    let dead = false
    setLoading(true)
    listMyItems(query)
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
  }, [query])

  const patch = useCallback(
    (next: Partial<Record<keyof MyItemListQuery, string | number | undefined>>) => {
      const merged = new URLSearchParams(params)
      for (const [k, v] of Object.entries(next)) {
        if (v === undefined || v === '' || v === PAGE_ONE) merged.delete(k)
        else merged.set(k, String(v))
      }
      if (!('page' in next)) merged.delete('page')
      setParams(merged, { replace: true })
    },
    [params, setParams],
  )

  const page = query.page ?? PAGE_ONE
  const total = data?.total ?? 0
  const pages = data ? Math.max(1, Math.ceil(total / data.page_size)) : 1

  return (
    <section className="card">
      <h1>我的发布</h1>
      <p className="muted">
        这里列的是你发过的全部帖子，包括已经归还的和已经关掉的。<Link to="/me">回我的</Link>
      </p>

      <div className="type-tabs" role="group" aria-label="类型">
        {(
          [
            ['', '全部'],
            ['lost', '我丢的东西'],
            ['found', '我捡到的东西'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={label}
            type="button"
            className={(query.item_type ?? '') === value ? 'tab tab-on' : 'tab'}
            onClick={() => patch({ item_type: value || undefined })}
          >
            {label}
          </button>
        ))}
      </div>

      <form
        className="filter-row"
        onSubmit={(e) => {
          e.preventDefault()
          patch({ keyword: keywordDraft.trim() || undefined })
        }}
      >
        <div className="field grow">
          <label htmlFor="keyword">搜自己的帖子</label>
          <input
            id="keyword"
            value={keywordDraft}
            placeholder="例如：钱包"
            onChange={(e) => setKeywordDraft(e.target.value)}
          />
        </div>
        <button className="btn" type="submit">
          搜索
        </button>
      </form>

      <div className="filter-row">
        <div className="field">
          <label htmlFor="status">状态</label>
          <select id="status" value={query.status ?? ''} onChange={(e) => patch({ status: e.target.value || undefined })}>
            {STATUSES.map(([value, label]) => (
              <option key={label} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="sort">排序</label>
          <select
            id="sort"
            value={query.sort ?? 'created_at'}
            onChange={(e) => patch({ sort: e.target.value === 'created_at' ? undefined : e.target.value })}
          >
            <option value="created_at">最新发布</option>
            <option value="lost_at">按丢失时间</option>
            <option value="found_at">按拾获时间</option>
          </select>
        </div>
      </div>

      {error && (
        <p className="alert" role="alert">
          {error}
          {errorId && <span className="req-id">（请求编号 {errorId}）</span>}
        </p>
      )}

      {loading && !data && <p className="muted">正在加载…</p>}

      {data && data.list.length === 0 && !loading && (
        <p className="muted">
          这一档里没有帖子。
          {query.status === 'deleted' ? (
            '「已下架 / 已删除」这一档空着是好事。'
          ) : (
            <>
              换个类型或状态看看，或者去<Link to="/post">发一条</Link>。
            </>
          )}
        </p>
      )}

      {data && data.list.length > 0 && (
        <>
          <ul className="item-list">
            {data.list.map((item) => (
              <ItemCard key={item.id} item={item} footer={rowFooter(item)} />
            ))}
          </ul>

          <div className="pager">
            <button className="btn" type="button" disabled={page <= 1} onClick={() => patch({ page: page - 1 })}>
              上一页
            </button>
            <span className="muted">
              第 {page} / {pages} 页，共 {total} 条
            </span>
            <button
              className="btn"
              type="button"
              disabled={page >= pages}
              onClick={() => patch({ page: page + 1 })}
            >
              下一页
            </button>
          </div>
        </>
      )}
    </section>
  )
}
