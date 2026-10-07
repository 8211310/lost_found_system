// src/pages/PlazaPage.tsx —— #14 GET /api/items（物品广场）。
//
// 筛选状态放在 **URL** 里而不是组件 state：丢东西的人会反复回来刷新，
// 也会把「图书馆 + 拾物」这条筛选发给同学看。用 state 存的话刷新即丢，
// 而这两件事（刷新、分享）恰是这个页面最主要的两个用法。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { getCategories, getLocations } from '../api/dicts'
import { listItems, type ItemListQuery } from '../api/items'
import { errorText, requestIdOf } from '../api/errorText'
import DictCascader from '../components/DictCascader'
import ItemCard from '../components/ItemCard'
import type { CategoryNode, ItemSummary, LocationNode, Page } from '../api/types'

/** 第一页不写 ?page=1：URL 短一点，也让「分享出去的筛选」和「默认的筛选」是同一个串。 */
const PAGE_ONE = 1

function toNumber(raw: string | null): number | undefined {
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

export default function PlazaPage() {
  const [params, setParams] = useSearchParams()
  const [data, setData] = useState<Page<ItemSummary> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [errorId, setErrorId] = useState('')
  const [tree, setTree] = useState<{ categories: CategoryNode[]; locations: LocationNode[] }>({
    categories: [],
    locations: [],
  })

  // keyword 单独用 state 接：输入框里每敲一个字就改 URL，会让「按 搜索 才发请求」
  // 变成「每敲一个字发一次请求」，而这个后端的关键字是 ILIKE 全表扫（§3.2 没建全文索引）。
  const [keywordDraft, setKeywordDraft] = useState(params.get('keyword') ?? '')

  const query = useMemo<ItemListQuery>(() => {
    const q: ItemListQuery = {}
    const itemType = params.get('item_type')
    if (itemType === 'lost' || itemType === 'found') q.item_type = itemType
    const status = params.get('status')
    if (status === 'open' || status === 'closed') q.status = status
    const sort = params.get('sort')
    if (sort === 'created_at' || sort === 'lost_at' || sort === 'found_at') q.sort = sort
    const keyword = params.get('keyword')
    if (keyword) q.keyword = keyword
    const categoryId = toNumber(params.get('category_id'))
    if (categoryId) q.category_id = categoryId
    const locationId = toNumber(params.get('location_id'))
    if (locationId) q.location_id = locationId
    const page = toNumber(params.get('page'))
    if (page) q.page = page
    return q
  }, [params])

  // 字典树只要一次。它失败不挡列表：筛选项渲染不出来，但已经生效的筛选还能用。
  useEffect(() => {
    let dead = false
    Promise.all([getCategories(), getLocations()])
      .then(([categories, locations]) => {
        if (!dead) setTree({ categories, locations })
      })
      .catch(() => {
        /* 筛选项空着比整页报错好：用户是来看帖子的，不是来看筛选器的。 */
      })
    return () => {
      dead = true
    }
  }, [])

  // ⚠ query 必须是上面那个 useMemo 的产物：直接把 params 当依赖，
  // useSearchParams 每次渲染都给新对象，这个 effect 就成了「每次渲染都发一次请求」，
  // 而那种请求风暴在本地看不出来，只在日志里刷出一屏 GET /api/items。
  useEffect(() => {
    let dead = false
    setLoading(true)
    listItems(query)
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

  /** patch 里 undefined 表示「删掉这个条件」。回到默认值不写 ?x=，
   *  是为了让 URL 里出现的每一个参数都真的改变了默认行为。 */
  const patch = useCallback(
    (next: Partial<Record<keyof ItemListQuery, string | number | undefined>>) => {
      const merged = new URLSearchParams(params)
      for (const [k, v] of Object.entries(next)) {
        if (v === undefined || v === '' || v === PAGE_ONE) merged.delete(k)
        else merged.set(k, String(v))
      }
      // 换了任何筛选条件，页码必须回第一页：停在第 4 页换类目，用户会看到
      // 「这个类目怎么只有三条」，而那其实是第 4 页的尾巴。
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
      <h1>物品广场</h1>

      <div className="type-tabs" role="group" aria-label="类型">
        {(
          [
            ['', '全部'],
            ['lost', '我在找东西'],
            ['found', '有人捡到东西'],
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
          <label htmlFor="keyword">搜标题和描述</label>
          <input
            id="keyword"
            value={keywordDraft}
            placeholder="例如：黑色钱包"
            onChange={(e) => setKeywordDraft(e.target.value)}
          />
        </div>
        <button className="btn" type="submit">
          搜索
        </button>
      </form>

      <div className="filter-row">
        <div className="field grow">
          <DictCascader
            idPrefix="cat"
            firstLabel="分类"
            tree={tree.categories}
            value={query.category_id}
            onChange={(id) => patch({ category_id: id })}
          />
        </div>
        <div className="field grow">
          <DictCascader
            idPrefix="loc"
            firstLabel="地点"
            tree={tree.locations}
            value={query.location_id}
            onChange={(id) => patch({ location_id: id })}
          />
        </div>
      </div>

      <div className="filter-row">
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
        <div className="field">
          <label htmlFor="status">状态</label>
          <select
            id="status"
            value={query.status ?? 'open'}
            onChange={(e) => patch({ status: e.target.value === 'open' ? undefined : e.target.value })}
          >
            <option value="open">还在找 / 还没归还</option>
            <option value="closed">已归还</option>
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
          这个筛选下暂时没有帖子。换个地点或把关键字删短一点试试 ——
          搜索是全模糊匹配，一个多余的字就什么都搜不到。
        </p>
      )}

      {data && data.list.length > 0 && (
        <>
          <ul className="item-list">
            {data.list.map((item) => (
              <ItemCard key={item.id} item={item} />
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

      <p className="hint">
        按分类筛选要选到最细那一层：后端按帖子存的那一个 id 精确匹配，只选到大类等于没选。
      </p>
    </section>
  )
}
