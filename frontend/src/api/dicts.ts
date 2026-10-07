// src/api/dicts.ts —— §4 的 #7 #8（M2 字典树）。
//
// 两个端点都是公开的：未登录也要能逛广场并按分类/地点筛选。
// 这一层没有任何缓存 —— **故意不缓存**（计划 §15-5 那条操作约束「字典树不缓存，
// 否则改完得重启」在前端的对应面）：字典改名目前走数据库手工改，缓存会让「改完看不见」
// 变成一个新的排查项。以后真要加缓存，加在页面层并且带上失效时间，别加在这里。
import { getJSON } from './client'
import type { CategoryNode, LocationNode } from './types'

/** #7 GET /api/categories（公开）。两级树，children 永远是数组。 */
export function getCategories(): Promise<CategoryNode[]> {
  return getJSON<CategoryNode[]>('/api/categories')
}

/** #8 GET /api/locations（公开）。三级树，多一个 is_freeform（全库只有「其他」是 true）。 */
export function getLocations(): Promise<LocationNode[]> {
  return getJSON<LocationNode[]>('/api/locations')
}
