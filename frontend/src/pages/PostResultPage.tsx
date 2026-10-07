// src/pages/PostResultPage.tsx —— 两个长得不一样的发帖成功页（计划 §2.6.2 的 UI 落地）。
//
// 这一页存在的唯一理由是：**#13 响应里那两个键没有第二份**。
// matches_preview 和 notified_count 是发帖那一刻现算的，之后任何 GET 都取不回同一份
// （#20 要本人登录、每次重算，结果还可能因为又有新帖而不同）。
// 所以它只能靠 navigation state 传过来 —— 于是必须回答「state 没了怎么办」。
// 答案是老实说没了：帖子本身有 id、有详情页，那一屏搜索结果不是资产，没必要为它设计缓存。
//
// 两套文案的差别不是排版，是**事实**：
//   lost 的人刚登记完，此刻最想知道「有没有人捡到」，所以给他这一趟搜出来的候选；
//   found 的人什么都没做错过，此刻系统替他推了通知，所以他只需要知道「推了几个人」，
//   **不需要任何下一步** —— 给他一个待办清单会让他以为平台在等他提交什么材料。
import { Link, useLocation, useParams } from 'react-router-dom'
import type { CreateItemResult, MatchHit } from '../api/types'

/** 一句话把这张候选卡片说清：像到什么程度 + 它是哪条帖。
 *  这里**不重排、不二次加工**分数：显示的就是 #13 返回的那一个数（round4 之后的），
 *  和它 breakdown 里的加权和是同一个口径。 */
function previewLine(hit: MatchHit): string {
  return `${hit.item.title} · ${hit.item.location_name} · 像 ${hit.score.toFixed(4)}`
}

export default function PostResultPage() {
  // :id 走 URL 而不是只走 state：刷新之后 state 没了，但 id 还在，
  // 于是这一页还能给出一条**真的能用**的退路（「去看你发的那条」），而不是一片空白。
  const { id } = useParams()
  const state = useLocation().state as { result?: CreateItemResult } | null
  const result = state?.result

  if (!result) {
    return (
      <section className="card">
        <h1>这一屏的结果已经不在了</h1>
        {/* 这一句必须说「不在了」而不是假装成功：matches_preview 只在发帖那一次响应里，
            刷新、从历史记录回来、直接把地址贴进来，都拿不到它。
            这里不去调 #20 凑一份「看起来一样」的列表 —— 那是另一套条件算出来的另一个答案。 */}
        <p className="muted">
          发帖那一刻搜出来的匹配结果只在那一次响应里，刷新之后就取不到了。
          帖子本身没事，它好好挂在广场上。
        </p>
        <p className="hint">
          <Link to={`/items/${id}`}>看你发的那条帖子</Link> · <Link to="/">回广场</Link>
        </p>
      </section>
    )
  }

  const item = result.item

  if (item.item_type === 'lost') {
    const preview = result.matches_preview ?? []
    return (
      <section className="card">
        <h1>{preview.length > 0 ? '系统又帮你搜了一遍，这几条拾物帖最像' : '已经登记好了'}</h1>

        {preview.length > 0 ? (
          <>
            <p className="muted">
              这是发帖那一刻按标题、描述、分类、地点、时间比出来的候选。像不像你自己判断 ——
              平台不替你认定哪一条就是你的东西。
            </p>
            <ul className="item-list">
              {preview.map((hit) => (
                <li className="item-card" key={hit.item.id}>
                  <Link to={`/items/${hit.item.id}`}>
                    <span className="item-body">
                      <span className="item-title">{previewLine(hit)}</span>
                      <span className="item-meta">
                        {hit.item.author_name} 发的 · 联系方式要先认领才看得到
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <p className="hint">
              看中了哪一条，进去点「认领并查看联系方式」就能看到对方留的联系方式；
              那只是登记，不会阻止其他人也去联系。
            </p>
          </>
        ) : (
          // 空列表不许写成「没有匹配」那种丧气话，也不许写成「系统帮你找回」那种承诺
          // （计划 §2.6.3 点名的就是这句）。这里说的是接下来**真的会发生什么**。
          <p className="muted">
            捡到的人能搜到你并直接看到你的联系方式；之后如果有人发拾物帖匹配上了，我们会通知你。
          </p>
        )}

        <p className="hint">
          <Link to={`/items/${item.id}`}>看你发的这条</Link> · <Link to="/">回广场</Link>
        </p>
      </section>
    )
  }

  const notified = result.notified_count ?? 0
  return (
    <section className="card">
      <h1>拾物帖已经发出去了</h1>
      <p className="notice" role="status">
        {notified > 0
          ? // 数字直接用后端给的，不自己数：它数的是「这一趟里真的被写进通知的那几个失主」。
            `已通知 ${notified} 位可能丢过这个东西的同学。`
          : '暂时没有匹配到失物帖，不过它会一直挂在广场上，丢东西的人搜得到。'}
      </p>
      <p className="muted">
        你不需要再做别的了。接下来如果有人联系你，是你说了算 ——
        平台不替你判断东西该归谁，也不会在中间收一道费、留一份档案。
      </p>
      <p className="hint">
        <Link to={`/items/${item.id}`}>看你发的这条</Link> · <Link to="/">回广场</Link>
      </p>
    </section>
  )
}
