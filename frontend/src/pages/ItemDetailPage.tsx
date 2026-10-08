// src/pages/ItemDetailPage.tsx —— #15 详情 + #21 解锁 + #41 举报入口 + #20 匹配面板。
//
// 这一页是整套「只记录事实、不裁决归属」设计在 UI 上的落点，所以三处文案是判据不是装饰：
//   ① contact 是否显示**完全由后端决定**（本人 / 已解锁 / lost 帖公开），前端只读 contact_locked；
//   ② 解锁按钮的轻提示必须说清「认领只是登记，不排他」，否则用户以为锁定了自己的认领权（§2.3）；
//   ③ 举报入口要弱，成功文案不许诺任何后果（见 ReportDialog 顶部那段）。
//
// 后端 #15 挂的是 OptionalJWT：认得出就多给一点，认不出绝不 401。
// 所以这一页在未登录时也必须能完整渲染 —— 不要在这里放 RequireAuth。
import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { changeItemStatus, deleteItem, getItem, unlockContact } from '../api/items'
import { errorText, requestIdOf } from '../api/errorText'
import { useAuth } from '../auth/AuthContext'
import { localMinute } from '../lib/time'
import MatchPanel from '../components/MatchPanel'
import ReportDialog from '../components/ReportDialog'
import type { ItemView } from '../api/types'

/** 详情页要显示的时间行，按类型挑列。
 *  lost 两个（最后确认还在 / 发现丢失）、found 一个（实际拾获）。
 *  这三个键和数据库那三个具名列一一对应 —— 计划 §3.2 说「列名就是最好的注释」，
 *  在 UI 上也成立：标签写对了，用户就不会把上传时间当成拾获时间填。 */
function timeRows(item: ItemView): Array<[string, string]> {
  if (item.item_type === 'lost') {
    return [
      ['最后确认还在', localMinute(item.last_seen_at)],
      ['发现丢失', localMinute(item.lost_at)],
    ]
  }
  return [['实际拾获时间', localMinute(item.found_at)]]
}

export default function ItemDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const { status, user } = useAuth()

  const [item, setItem] = useState<ItemView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [errorId, setErrorId] = useState('')

  // 解锁是这一页唯一的写操作，它的结果只活在这一次访问里：
  // contact 一旦拿到就显示出来，但**不写进任何缓存**，也不改 item state ——
  // 那份 state 是后端给的真相，前端替它「补上联系方式」会让下一次刷新和这次不一致。
  const [unlocked, setUnlocked] = useState<string | null>(null)
  const [unlockHint, setUnlockHint] = useState('')
  const [unlocking, setUnlocking] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)

  // 作者对自己这条帖的三个动作（#16 入口 / #18 开关 / #17 软删）。
  const [ownerBusy, setOwnerBusy] = useState(false)
  // 删除要两步：#17 是软删，帖子当场从广场消失，而**没有任何撤销端点**
  // （恢复是 admin 的 #44，普通用户拿不到）。所以它不能是一个点了就走的按钮。
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    let dead = false
    setLoading(true)
    getItem(id)
      .then((res) => {
        if (dead) return
        setItem(res)
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
  }, [id])

  /** 去做一件需要身份的事：匿名先跳登录，登录后回本页（from 带过去）。
   *  这就是 §13 第 4 步里「小李登录 → 解锁」那条路径的前端形态。 */
  const needAuth = useCallback(() => {
    if (status === 'authed') return true
    navigate('/login', { state: { from: location.pathname + location.search } })
    return false
  }, [navigate, status, location.pathname, location.search])

  async function onUnlock() {
    if (!needAuth()) return
    setUnlocking(true)
    setError('')
    try {
      const res = await unlockContact(id)
      setUnlocked(res.contact)
      setUnlockHint(
        res.already_unlocked
          ? '你之前已经查看过这条联系方式。认领只是登记，不会阻止其他人联系发布者。'
          : '认领只是登记，不会阻止其他人联系发布者。',
      )
    } catch (err) {
      setError(errorText(err))
      setErrorId(requestIdOf(err))
    } finally {
      setUnlocking(false)
    }
  }

  async function toggleStatus() {
    if (!item) return
    // 目标状态取反：open → closed（「还回来了」），closed → open（还错了 / 又想重新挂出去）。
    const next = item.status === 'open' ? 'closed' : 'open'
    setOwnerBusy(true)
    setError('')
    try {
      const res = await changeItemStatus(item.id, next)
      // 这里**可以**用响应更新 state，而且只更新那一个字段：#18 的 data 就是 {id, status}，
      // 后端刚刚写进库的就是它。和上面解锁那处不更新 item 不矛盾 ——
      // 解锁的响应里根本没有 item 的新形状，只有一个 contact。
      setItem({ ...item, status: res.status })
    } catch (err) {
      setError(errorText(err))
      setErrorId(requestIdOf(err))
    } finally {
      setOwnerBusy(false)
    }
  }

  async function removePost() {
    if (!item) return
    setOwnerBusy(true)
    setError('')
    try {
      await deleteItem(item.id)
      // 删完不回这条详情页：它的 status 已经是 deleted，留在原地只会让人以为没删掉。
      // 广场也拿不到它了（#14 的 publicListStatus 拒绝 deleted），所以去处只有「我的发布」，
      // 而那一页在片 4。现在能给的诚实去处就是广场。
      navigate('/')
    } catch (err) {
      setError(errorText(err))
      setErrorId(requestIdOf(err))
      setConfirmDelete(false)
    } finally {
      setOwnerBusy(false)
    }
  }

  if (loading && !item) return <p className="muted">正在加载…</p>

  if (!item) {
    return (
      <section className="card">
        <h1>看不了这条帖子</h1>
        <p className="alert" role="alert">
          {error || '不知道哪里出了问题'}
          {errorId && <span className="req-id">（请求编号 {errorId}）</span>}
        </p>
        <p className="muted">
          <Link to="/">回广场</Link>
        </p>
      </section>
    )
  }

  const contact = item.contact ?? unlocked
  // #20 的鉴权是「本人或 Admin」（router.go 那段注释交代了为什么这里不用 OptionalJWT 给空列表）。
  // role 是每次请求现读数据库的（middleware/jwt.go），所以这里的 user.role 不可能是过期的 admin 身份。
  const canSeeMatches = status === 'authed' && (user?.role === 'admin' || user?.id === item.author.id)
  // 作者操作只判本人，**不含 admin**：#18 后端写的就是「仅帖主，admin 也不行」
  // （关一条帖子是「东西还回来了」这个社区表态，admin 能销毁内容但制造不出归属）。
  // #16/#17 后端虽然允许 admin，但那条路要带 admin_reason，它的入口在管理后台（片 5），
  // 所以这里对 admin 也不出现按钮 —— 不是做不到，是点下去只会吃一个他自己看不懂的 VALIDATION。
  const isOwner = status === 'authed' && user?.id === item.author.id
  // 归还确认（#23）的入口条件跟后端那四道门一一对齐：found 帖（lost 帖后端给 VALIDATION）、
  // open（closed/deleted 吃 ITEM_CLOSED）、不是本人（RETURN_SELF）、已登录。
  // 而它只挂在「联系方式已经看得到」那一格里：#23 后端**不要求**先解锁，
  // 但顺序上登记本来就是「联系上、东西到手」之后的那一步，排在拿到电话之前会误导。
  const canSubmitReturn =
    status === 'authed' && !isOwner && item.item_type === 'found' && item.status === 'open'
  // deleted 的帖子什么都不能再动：#16 在这种状态上返回 ITEM_CLOSED，
  // #18 也一样。所以这一栏整块不出现，而不是给了按钮再报错。
  const canAct = isOwner && item.status !== 'deleted'

  return (
    <>
      <section className="card">
        <div className="detail-head">
          <h1>{item.title}</h1>
          {/* 入口要弱：一个小小的文字按钮。计划 §M7 明确写了「不是醒目的红色图标」——
              醒目的举报按钮等于鼓励用举报解决问题，而它解决不了任何事。 */}
          <button
            className="report-link"
            type="button"
            onClick={() => {
              if (needAuth()) setReportOpen(true)
            }}
          >
            举报
          </button>
        </div>

        <p className="item-tags">
          <span className={`tag tag-${item.item_type}`}>{item.item_type === 'lost' ? '失物' : '拾物'}</span>
          {item.status === 'closed' && <span className="tag tag-closed">已归还</span>}
          {item.status === 'deleted' && <span className="tag tag-deleted">已被管理员下架</span>}
        </p>

        {item.images.length > 0 ? (
          <ul className="gallery">
            {item.images.map((img) => (
              <li key={img.id}>
                <img className="gallery-img" src={img.url} alt={item.title} loading="lazy" />
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">发布者没上传图片。</p>
        )}

        <dl className="kv">
          <dt>分类</dt>
          <dd>{item.category.name}</dd>
          <dt>地点</dt>
          <dd>{item.location.name}</dd>
          {item.location_detail && (
            <>
              <dt>具体位置</dt>
              <dd>{item.location_detail}</dd>
            </>
          )}
          {timeRows(item).map(([label, value]) =>
            value ? (
              <div className="kv-pair" key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ) : null,
          )}
          <dt>发布者</dt>
          <dd>{item.author.nickname}</dd>
          <dt>发布于</dt>
          <dd>{localMinute(item.created_at)}</dd>
        </dl>

        <h2>描述</h2>
        {/* 后端原样返回用户写的换行（model.ItemView 的注释里交代过为什么），
            HTML 默认会把换行吃掉，所以这里必须 white-space: pre-wrap，
            否则用户会看到「我明明分了段，页面挤成一坨」。 */}
        <p className="description">{item.description}</p>

        <h2>联系方式</h2>
        {contact ? (
          <>
            <p className="contact-value">{contact}</p>
            {unlockHint && <p className="hint">{unlockHint}</p>}
            {canSubmitReturn && (
              <p className="hint">
                <Link className="link-btn" to={`/items/${item.id}/claim`}>
                  东西已经到手了？提交归还确认
                </Link>
              </p>
            )}
          </>
        ) : item.contact_locked ? (
          <>
            <p className="muted">
              平台不提供站内私信。拾主留的联系方式要认领之后才看得到 ——
              这是登记，不是排他锁定。
            </p>
            <button className="btn btn-primary" type="button" onClick={onUnlock} disabled={unlocking}>
              {unlocking ? '正在登记…' : '认领并查看联系方式'}
            </button>
          </>
        ) : (
          <p className="muted">这条帖子没有联系方式。</p>
        )}

        {error && (
          <p className="alert" role="alert">
            {error}
            {errorId && <span className="req-id">（请求编号 {errorId}）</span>}
          </p>
        )}

        {/* 解锁名单的入口放在 canAct 那块**外面**，而且只判 found：
            #22 在帖子被下架之后仍然允许作者读（后端那段注释说那是治理场景里最需要的证据），
            而 canAct 为了避开 ITEM_CLOSED 把 deleted 排除掉了 —— 两个判据不是一回事。 */}
        {isOwner && item.item_type === 'found' && (
          <p className="hint">
            <Link className="link-btn" to={`/items/${item.id}/unlockers`}>
              查看谁认领并看过这条联系方式
            </Link>
          </p>
        )}
      </section>

      {canAct && (
        <section className="card owner-actions">
          <h2>这条是你发的</h2>
          <div className="owner-row">
            <Link className="btn" to={`/items/${item.id}/edit`}>
              修改
            </Link>
            {/* 文案跟着当前状态走而不是写死一个「关闭帖子」：
                open 的人要的是「还回来了」，closed 的人要的是「重新挂出去」，
                同一个按钮两种标题会让人按之前先犹豫一下。 */}
            <button className="btn" type="button" disabled={ownerBusy} onClick={toggleStatus}>
              {item.status === 'open' ? '标记为已归还' : '重新开放'}
            </button>
            {confirmDelete ? (
              <button className="btn btn-danger" type="button" disabled={ownerBusy} onClick={removePost}>
                确认删除
              </button>
            ) : (
              <button className="link-btn" type="button" onClick={() => setConfirmDelete(true)}>
                删除这条帖子
              </button>
            )}
          </div>
          {confirmDelete && (
            <p className="hint">
              删掉之后这条帖子在广场和搜索里就都没了，你自己也<strong>没有撤销</strong>的入口。
              <button className="link-btn" type="button" onClick={() => setConfirmDelete(false)}>
                取消
              </button>
            </p>
          )}
          <p className="hint">
            「标记为已归还」只是把这条帖子的状态改掉，不给任何人加积分 ——
            积分走的是另一条路：有人提交归还确认、你确认了才算。
          </p>
        </section>
      )}

      {/* 匹配结果只有发帖人和 admin 读得到（#20 的鉴权是「本人或 Admin」），
          所以入口对其他人**根本不出现**，而不是点下去吃一个 FORBIDDEN。
          顺手也省掉了一次注定失败的请求。 */}
      {canSeeMatches && <MatchPanel itemId={item.id} />}

      {reportOpen && <ReportDialog itemId={item.id} onClose={() => setReportOpen(false)} />}
    </>
  )
}
