// src/components/MatchPanel.tsx —— #20 GET /api/items/:id/matches 的可视化（§5.7 那张表）。
//
// 它在计划里的定位是**调试器**，判据是「每个信号的分数和权重都能验算」，
// 所以这张表必须把 weight 和原始 score 分两列摊开，而不是只给一个总分。
// 只给总分的话，用户看到 0.62 会觉得系统在瞎算；看到「分类 0.45×1.0 + 文本 0.40×0.32 + 时间 0.15×0.0」
// 才知道是自己描述没写、时间没落在窗口里 —— 那两类东西他改得了，
// 而这正是 §14-12 那条风险的唯一缓解措施（删了 color/brand 列之后，匹配全靠用户会不会写描述）。
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { getMatches } from '../api/items'
import { errorText, requestIdOf } from '../api/errorText'
import type { Breakdown, LocationSignal, MatchHit } from '../api/types'

const MATCHED_BY: Record<string, string> = {
  same_leaf: '同一个具体地点',
  same_second: '同一个二级地点',
  same_top: '同一个片区',
  detail_text: '靠「具体位置」那段文字匹配上',
}

/** locNote 处理 detail_text 那一档的一个特殊情形：分数是 0。
 *  前三档（同叶子/同二级/同片区）的分数是固定值、不会是 0，只有落到「比文字」这一档
 *  才可能是 0 —— 那意味着两段 location_detail 一个词都没重合。
 *  这时候还说「靠那段文字匹配上」就是假话，而它偏偏出现在地点这一路得分 0.0000 的旁边，
 *  用户只会更困惑。候选能进列表是 SQL 那层放宽了范围（同一片区就行），不是靠文字命中的。 */
function locNote(loc: LocationSignal): string {
  if (loc.matched_by === 'detail_text' && loc.score === 0) {
    return '地点层级比不上，「具体位置」那段文字也没重合'
  }
  return MATCHED_BY[loc.matched_by] ?? loc.matched_by
}

/** timeNote 把时间信号说成一句**数据支持得了**的话。
 *  days_after_lost_at 在两种相反的情况下都是 0：捡得**早于** last_seen_at（重罚那一档），
 *  和捡得只差不到一天（几乎不罚）。所以只有 days>0 才敢断言「晚于」，
 *  另一种不能猜方向 —— 写成「晚于丢失时间 0 天」会把「可能还没丢」显示成「迟到了」，
 *  而用户看这张表就是为了判断该不该联系对方。 */
function timeNote(b: Breakdown): string {
  const t = b.signals.time
  if (t.in_loss_window) return '落在丢失窗口内'
  if (t.days_after_lost_at > 0) return `晚于丢失时间 ${t.days_after_lost_at} 天`
  return '没落在丢失窗口内'
}

/** signals 的显示顺序对应 matcher/thresholds.go 里那两组常量。
 *  这里**不写死权重数字**，一律显示响应里带回来的 weight ——
 *  权重是后端 §9 可 debug 配置的一部分，将来调参不用改前端，
 *  也不会出现「前端显示的权重和实际算的权重不一样」这种最坏的情况。 */
function rows(b: Breakdown): Array<{ name: string; weight: number; score: number; note: string }> {
  const out = [
    {
      name: '分类',
      weight: b.signals.category.weight,
      score: b.signals.category.score,
      note: b.signals.category.same_leaf ? '同一个小类' : '同大类、不同小类（半分）',
    },
    {
      name: '文本',
      weight: b.signals.text.weight,
      score: b.signals.text.score,
      note: `标题相似 ${b.signals.text.title_dice.toFixed(3)}、描述相似 ${b.signals.text.desc_dice.toFixed(3)}`,
    },
    {
      name: '时间',
      weight: b.signals.time.weight,
      score: b.signals.time.score,
      note: timeNote(b),
    },
  ]

  // 只有 Tier 2 才有这一路（Tier 1 的地点是 SQL 硬条件，不进打分）。
  // 用「有没有这一路」来解释「这次是哪一档」，所以它必须显示，不能当成可省的细节。
  const loc = b.signals.location
  if (loc) {
    out.push({
      name: '地点',
      weight: loc.weight,
      score: loc.score,
      note: locNote(loc),
    })
  }
  return out
}

export default function MatchPanel({ itemId }: { itemId: number | string }) {
  const [hits, setHits] = useState<MatchHit[] | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [errorId, setErrorId] = useState('')

  async function load() {
    setBusy(true)
    setError('')
    try {
      const res = await getMatches(itemId)
      setHits(res.list)
      setNotice(res.notice ?? '')
    } catch (err) {
      setError(errorText(err))
      setErrorId(requestIdOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <h2>系统认为像的那几条</h2>

      {!hits && (
        <button className="btn" type="button" onClick={load} disabled={busy}>
          {busy ? '正在算…' : '现算一次匹配结果'}
        </button>
      )}
      {hits && hits.length === 0 && (
        <p className="muted">
          没有一条候选达到阈值。这不代表没人捡到 ——
          也可能是描述里少了颜色、品牌或外观特征，写得越具体越容易匹配上。
        </p>
      )}

      {notice && <p className="notice">{notice}</p>}

      {error && (
        <p className="alert" role="alert">
          {error}
          {errorId && <span className="req-id">（请求编号 {errorId}）</span>}
        </p>
      )}

      {hits && hits.length > 0 && (
        <>
          {/* 展示线低于通知线是后端的刻意设计（config.go 里还专门校验了两条线不能写反），
              所以这张列表里**可以**出现当初没进台账、没发通知的候选。
              不写清这一点，用户会以为「列在这里的都通知过了」，然后去问对方「你没收到我的消息吗」。
              这里不印具体数字：两条线都是 .env 里的可调参数，前端写死必然和实际不一致。 */}
          <p className="muted">
            下面这些是「像」的程度，不是「已经通知过」的名单 ——
            只有达到后端配置的通知线才进台账、才发通知，而那条线比这里的展示线更高。
          </p>

          <ol className="match-list">
            {hits.map((hit) => (
              <li className="match-hit" key={hit.item.id}>
                <p className="match-head">
                  <strong>{hit.item.title}</strong>
                  <span className="muted">
                    {hit.item.category_name} · {hit.item.location_name} · {hit.item.author_name}
                  </span>
                  <span className="match-score">
                    {/* 拼成**一个**字符串而不是几段插值：插值会把这句切成三个文本节点，
                        于是 getByText(/总分 0.72/) 找不到它（DOM 里那句是对的，测试却是红的），
                        而「复制总分给 admin 排查」这种真实操作也需要它是一个整体。 */}
                    {`总分 ${hit.breakdown.score.toFixed(4)}（Tier ${hit.breakdown.tier}）`}
                  </span>
                </p>

                <table className="signals">
                  <thead>
                    <tr>
                      <th>信号</th>
                      <th>权重</th>
                      <th>得分</th>
                      <th>加权</th>
                      <th>说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows(hit.breakdown).map((r) => (
                      <tr key={r.name}>
                        <td>{r.name}</td>
                        <td>{r.weight.toFixed(2)}</td>
                        <td>{r.score.toFixed(4)}</td>
                        <td>{(r.weight * r.score).toFixed(4)}</td>
                        <td>{r.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <p className="hint">
                  <Link to={`/items/${hit.item.id}`}>看这条帖子</Link>
                </p>
              </li>
            ))}
          </ol>
        </>
      )}

      <p className="hint">这一页每次打开都现算，不写台账也不发通知 —— 匹配只在有人发帖那一刻跑。</p>
    </section>
  )
}
