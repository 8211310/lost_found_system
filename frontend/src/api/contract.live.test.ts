// src/api/contract.live.test.ts —— 前端类型 vs 真实后端的对齐检查（只读，不写库）。
//
// 为什么需要这一层：前端是 TS，但类型声明本身只是个"说法"。后端把 `location_detail`
// 改成 `detail_location`，tsc 照样绿、msw 的假响应照样对，只有真打了才知道错了。
// 这类"接口漏字段"和"本来没数据"是两种完全不同的故障，靠肉眼分不出来。
//
// 跑法：`npm run test:live`（需要后端已在 8080 起）。它被 npm test 默认排除，
// 因为没起后端时的红和代码没关系。
import { beforeAll, describe, expect, it } from 'vitest'
import { createHttp } from './client'
import type { CategoryNode, Health, ItemSummary, ItemView, LocationNode, Page } from './types'

const BASE = process.env.LIVE_API_BASE ?? 'http://localhost:8080'
const live = createHttp(BASE)

/** 第二个参数是**查询参数**，不是 axios config。
 *  少包一层 params 的话分页参数会被静默丢掉，表现成「筛选不生效」这种特别像后端 bug 的假象。 */
async function get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
  return (await live.get<T>(path, { params })).data
}

/** 断言字段名逐个存在。缺一个就红，并且直接说是哪个 —— 这是这个文件唯一的用处。 */
function expectFields(obj: object, keys: string[]): void {
  const missing = keys.filter((k) => !(k in obj))
  expect(missing, `缺失字段：${missing.join(', ')}`).toEqual([])
}

function countTree(nodes: { children: unknown[] }[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countTree(n.children as { children: unknown[] }[]), 0)
}

beforeAll(async () => {
  // 后端不可达一律算失败，不静默跳过：被跳过的冒烟测试等于没有冒烟测试
  // （后端那边同一套规矩，见 scripts 里 REQUIRE_INTEGRATION=1 的用法）。
  await get<Health>('/api/health')
})

describe('#38 GET /api/health', () => {
  it('data 有 status/db/version/time，且 db 是 ok', async () => {
    const h = await get<Health>('/api/health')
    expectFields(h, ['status', 'db', 'version', 'time'])
    expect(h.status).toBe('ok')
    expect(h.db).toBe('ok')
  })
})

describe('#7 GET /api/categories', () => {
  it('两级树，字段是 id/name/level/sort_order/children，M0 的种子是 55 行', async () => {
    const tree = await get<CategoryNode[]>('/api/categories')
    expect(Array.isArray(tree)).toBe(true)

    const walk = (nodes: CategoryNode[]): void => {
      for (const n of nodes) {
        expectFields(n, ['id', 'name', 'level', 'sort_order', 'children'])
        expect([1, 2]).toContain(n.level)
        // 后端刻意让叶子节点返回 [] 而不是 null（model/dict.go 写了这条理由：
        // 前端类型不该为每个叶子多写一遍判空）
        expect(Array.isArray(n.children)).toBe(true)
        walk(n.children)
      }
    }
    walk(tree)
    expect(countTree(tree as unknown as { children: unknown[] }[])).toBe(55)
  })
})

describe('#8 GET /api/locations', () => {
  it('三级树 + is_freeform，M0 的种子是 91 行，且全库只有「其他」一个 freeform', async () => {
    const tree = await get<LocationNode[]>('/api/locations')

    const freeform: string[] = []
    const walk = (nodes: LocationNode[]): void => {
      for (const n of nodes) {
        expectFields(n, ['id', 'name', 'level', 'is_freeform', 'sort_order', 'children'])
        expect([1, 2, 3]).toContain(n.level)
        expect(typeof n.is_freeform).toBe('boolean')
        if (n.is_freeform) freeform.push(n.name)
        expect(Array.isArray(n.children)).toBe(true)
        walk(n.children)
      }
    }
    walk(tree)

    expect(countTree(tree as unknown as { children: unknown[] }[])).toBe(91)
    expect(freeform.length).toBe(1)
  })
})

describe('#14 GET /api/items', () => {
  it('分页四件套 list/total/page/page_size', async () => {
    const page = await get<Page<ItemSummary>>('/api/items', { page: 1, page_size: 5 })
    expectFields(page, ['list', 'total', 'page', 'page_size'])
    expect(Array.isArray(page.list)).toBe(true)
    expect(page.page).toBe(1)
    expect(page.page_size).toBe(5)
  })

  it('摘要字段名逐个对齐 model.ItemSummary；found 帖的 contact 在广场上必须是 null', async () => {
    const page = await get<Page<ItemSummary>>('/api/items', { page: 1, page_size: 20 })
    if (page.list.length === 0) {
      console.warn('#14 本库还没有帖子，摘要字段与 found 不返回 contact 这两条断言没有被执行')
      return
    }

    for (const s of page.list) {
      expectFields(s, [
        'id',
        'item_type',
        'title',
        'status',
        'category_id',
        'category_name',
        'location_id',
        'location_name',
        'lost_at',
        'found_at',
        'contact',
        'cover_image',
        'author_id',
        'author_name',
        'created_at',
      ])
      // 计划 §4：#14 广场对 found 帖一律不给 contact，**不看是谁在查**。
      // 这条是「联系方式只在详情页解锁那一下才出去」的地基，不能退化。
      if (s.item_type === 'found') expect(s.contact).toBeNull()
    }
  })

  it('列表里拿不到 description —— 这是契约，不是遗漏', async () => {
    const page = await get<Page<ItemSummary>>('/api/items', { page: 1, page_size: 5 })
    for (const s of page.list) expect('description' in s).toBe(false)
  })
})

describe('#15 GET /api/items/:id', () => {
  it('匿名读到的详情有 contact_locked 这个布尔，author 里不带 real_name', async () => {
    const page = await get<Page<ItemSummary>>('/api/items', { page: 1, page_size: 1 })
    if (page.total === 0) {
      console.warn('#15 本库还没有帖子，详情形状的断言没有被执行')
      return
    }

    const item = await get<ItemView>(`/api/items/${page.list[0].id}`)
    expectFields(item, [
      'id',
      'item_type',
      'title',
      'description',
      'status',
      'category',
      'location',
      'location_detail',
      'last_seen_at',
      'lost_at',
      'found_at',
      'contact',
      'contact_locked',
      'images',
      'author',
      'created_at',
      'updated_at',
    ])
    expect(typeof item.contact_locked).toBe('boolean')
    expect(Array.isArray(item.images)).toBe(true)
    expectFields(item.author, ['id', 'nickname'])
    // ⚠ #15 是公开接口。real_name 只许出现在 #22 的名单里（model/item.go 的 AuthorView 注释），
    // 一旦哪天它被顺手加进 AuthorView，这里立刻红。
    expect('real_name' in item.author).toBe(false)

    if (item.item_type === 'found' && item.contact !== null) {
      expect(item.contact_locked, 'found 帖返回了 contact，却没锁 —— 二者不能同时成立').toBe(true)
    }
  })
})
