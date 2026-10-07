// src/components/ItemCard.tsx —— 一条帖子摘要的显示，广场和我的发布共用。
//
// 它只吃 ItemSummary，**不发详情请求**去补 description 或 images。
// 这不是偷懒：计划 §4 把摘要和详情分成两个形状，就是为了让列表页不去干详情页的活
// （model.ItemSummary 的注释里写了这条理由）。在卡片里偷偷多发一次 #15，
// 一个 20 行的列表就是 20 次额外请求，而且契约测试抓不到 —— 它测的是响应形状，不是请求次数。
//
// footer 是给「摘要之外还要挂东西」的页面留的（我的发布挂编辑入口和下架原因），
// 它渲染在卡片链接**外面**：嵌套 <a> 是非法 HTML，浏览器解析时会自行拆开，
// 拆出来的形状取决于解析器而不是写代码的人 —— 那种事不该靠测试去发现。
import { type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { localMinute } from '../lib/time'
import type { ItemSummary } from '../api/types'

/** 摘要里那一行时间该显示哪个：lost 显示「丢失于」，found 显示「拾获于」。
 *  两个时间列在数据库里由 CHECK 钉死了「哪种类型填哪列」（§3.2），
 *  所以这里不需要判「lost 帖的 found_at 有值」这种不可能的情况 —— 它不可能是值。 */
function timeLine(item: ItemSummary): string {
  const iso = item.item_type === 'lost' ? item.lost_at : item.found_at
  if (!iso) return ''
  return `${item.item_type === 'lost' ? '丢失于' : '拾获于'} ${localMinute(iso)}`
}

/** deleted 的标签为什么写得这么含糊：#19 里 status=deleted 的行有两种来历 ——
 *  作者自己 #17 软删的，和 admin 下架的。后者才带 removal，那种行由页面上专门一块
 *  「为什么不见了」说明原因；这里这一枚标签只负责把「它不在广场上了」说清楚，
 *  不许在两种来历之间替用户下判断。 */
function statusTag(item: ItemSummary): string {
  if (item.status === 'closed') return '已归还'
  if (item.status === 'deleted') return item.removal ? '已被下架' : '已关闭'
  return ''
}

export default function ItemCard({ item, footer }: { item: ItemSummary; footer?: ReactNode }) {
  const time = timeLine(item)
  const tag = statusTag(item)

  return (
    <li className="item-card">
      <Link to={`/items/${item.id}`}>
        {item.cover_image ? (
          <img className="item-cover" src={item.cover_image} alt="" loading="lazy" />
        ) : (
          <span className="item-cover item-cover-empty" aria-hidden="true">
            无图
          </span>
        )}

        <span className="item-body">
          <span className="item-tags">
            <span className={`tag tag-${item.item_type}`}>{item.item_type === 'lost' ? '失物' : '拾物'}</span>
            {tag && <span className={`tag tag-${item.status}`}>{tag}</span>}
          </span>

          <span className="item-title">{item.title}</span>
          <span className="item-meta">
            {item.category_name} · {item.location_name}
          </span>
          <span className="item-meta">
            {time ? `${time} · ` : ''}
            {item.author_name}
          </span>

          {/* 有就显示、没有就整行不出现。found 帖在广场上 contact 恒为 null，
              这里不写「进详情认领后可见」那种话：#14 不认身份，卡片上任何承诺
              都不是后端保证过的，写了就是前端替平台许愿。 */}
          {item.contact && <span className="item-contact">联系：{item.contact}</span>}
        </span>
      </Link>

      {footer}
    </li>
  )
}
