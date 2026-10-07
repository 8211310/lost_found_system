// src/pages/PostFormPage.tsx —— 发布（#13）与编辑（#16）共用一张表单。
//
// 为什么是一页两个路由而不是两页：两种情况下要校验的是**同一套**字段规则，
// 后端那里也是同一套（handler 把 createItemReq 和 updateItemReq 都折成 service.ItemFields，
// 注释里写明了「两边各写一遍字段的话，将来给发帖加一条校验、忘了改帖就出现
// 新建时不许这样、编辑时却能改成这样」）。前端要是复制两份表单，就会犯一模一样的错。
//
// 计划 §M7 那句「发布表单只有 7 个字段：标题、描述、分类、地点、具体位置、时间、联系方式，
// 外加可选图片。字段少是这个系统的优点，不要往回加」是这一页的范围边界。
// 所以这里**没有**颜色、没有品牌、没有物品成色 —— 颜色写进标题和描述，
// 因为删掉那两列之后匹配就靠文本，而 UI 替它补偿的方式是引导（见描述那行的灰字），
// 不是把列加回来。
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { getCategories, getLocations } from '../api/dicts'
import { createItem, deleteItemImage, getItem, updateItem } from '../api/items'
import { ApiError } from '../api/client'
import { errorText } from '../api/errorText'
import { fromLocalInput, toLocalInput } from '../lib/time'
import { useAuth } from '../auth/AuthContext'
import DictCascader from '../components/DictCascader'
import ImagePicker from '../components/ImagePicker'
import type { PickedImage } from '../components/ImagePicker'
import type {
  CategoryNode,
  CreateItemPayload,
  ItemView,
  LocationNode,
  UpdateItemPayload,
} from '../api/types'

// 四个上限照抄 items 表的 VARCHAR 宽度（service/item_validate.go 那组常量的前端对应面）。
// 它们**不是**内容校验：这里只限制长度，不判断格式、不猜语义。
const TITLE_MAX = 100
const DESCRIPTION_MAX = 5000
const LOCATION_DETAIL_MAX = 200
const CONTACT_MAX = 100

/** 一个帖子最多几张图，和后端 service.maxItemImages 同一个数。
 *  写在这里是为了让按钮在第九张之后就禁用，而不是等用户传完第十张再吃一句 VALIDATION。 */
const MAX_IMAGES = 9

type ItemType = 'lost' | 'found'

/** 表单里的草稿。时间是 **datetime-local 的串**（'2026-10-07T15:04'，本机时区），
 *  不是发给后端的那一种 —— 换算只在 toPayload 那一处发生。
 *  存成输入框的形状是为了让「用户改了什么」和「框里显示什么」是同一个值，
 *  中间任何一次双向换算都会让失焦那一刻的光标和值打架。 */
interface Draft {
  itemType: ItemType
  title: string
  description: string
  categoryId?: number
  locationId?: number
  locationDetail: string
  lastSeenAt: string
  lostAt: string
  foundAt: string
  contact: string
}

const EMPTY: Draft = {
  itemType: 'lost',
  title: '',
  description: '',
  categoryId: undefined,
  locationId: undefined,
  locationDetail: '',
  lastSeenAt: '',
  lostAt: '',
  foundAt: '',
  contact: '',
}

/** draftOf 把 #15 的响应折成草稿。
 *  item_type 在这里**只读**：#16 的请求体根本没有 item_type 这个键（改帖不能改类型），
 *  所以编辑模式下那一栏显示成一行说明而不是一个能点的开关。 */
function draftOf(item: ItemView): Draft {
  return {
    itemType: item.item_type === 'found' ? 'found' : 'lost',
    title: item.title,
    description: item.description,
    categoryId: item.category.id,
    locationId: item.location.id,
    locationDetail: item.location_detail,
    lastSeenAt: toLocalInput(item.last_seen_at),
    lostAt: toLocalInput(item.lost_at),
    foundAt: toLocalInput(item.found_at),
    contact: item.contact ?? '',
  }
}

/** findFreeform 查这一颗叶子是不是 is_freeform=true 的「其他」。
 *  后端全库只有那一个节点是 true（§3.6），但这里不写死 id ——
 *  字典是数据，写死一个 id 意味着以后加第二个自由地点时这一页会静默地不警告。 */
function findFreeform(tree: LocationNode[], id?: number): boolean {
  if (!id) return false
  for (const n of tree) {
    if (n.id === id) return n.is_freeform
    if (findFreeform(n.children, id)) return true
  }
  return false
}

export default function PostFormPage() {
  // 有 :id 就是编辑模式。这个名字和 #16 的路径参数一致，地址栏、后端日志、代码三处同一个串。
  const { id } = useParams()
  const isEdit = Boolean(id)
  const navigate = useNavigate()
  const { user } = useAuth()

  const [item, setItem] = useState<ItemView | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [images, setImages] = useState<PickedImage[]>([])
  const [tree, setTree] = useState<{ categories: CategoryNode[]; locations: LocationNode[] }>({
    categories: [],
    locations: [],
  })
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [errorId, setErrorId] = useState('')
  const [fieldErr, setFieldErr] = useState<ApiError | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  // 编辑模式里「点了 × 但还没确认」的那张图。#42 是立刻删行删文件的，
  // 所以这一下必须比创建模式里「去掉一张还没提交的图」重。
  const [pendingDelete, setPendingDelete] = useState<PickedImage | null>(null)

  const patch = (next: Partial<Draft>) => setDraft((cur) => ({ ...cur, ...next }))

  useEffect(() => {
    let dead = false
    Promise.all([getCategories(), getLocations(), isEdit ? getItem(id!) : Promise.resolve(null)])
      .then(([categories, locations, view]) => {
        if (dead) return
        setTree({ categories, locations })
        if (view) {
          setItem(view)
          setDraft(draftOf(view))
          // 已有的图进列表时不带 path：#15 的 ImageView 只有 {id,url,sort_order}，
          // 而 #16 的 image_paths 是**整组替换**，客户端重建不出「原有那些 + 新加的」，
          // 一发就会把原图全删掉。所以编辑模式一律不发这个字段，图片只能一张一张删（#42）。
          setImages(view.images.map((img) => ({ url: img.url, imageId: img.id })))
        }
      })
      .catch((err) => {
        if (dead) return
        setLoadError(errorText(err))
      })
      .finally(() => {
        if (!dead) setLoading(false)
      })
    return () => {
      dead = true
    }
  }, [id, isEdit])

  const isFreeform = useMemo(() => findFreeform(tree.locations, draft.locationId), [tree.locations, draft.locationId])

  /** 必填项缺哪些。这里只判**空不空**，不判内容 ——
   *  后端对 contact 明确放弃了一切格式校验（连「无」都收，见 item_validate.go 那段长注释），
   *  前端再把手机号正则捡回来就是自相矛盾：同一条规则两处判、两套说法。
   *  唯一多出来的一条是自由地点必须补具体位置，那是计划 §M7 给前端的额外要求（后端不强制）。 */
  const missing = useMemo(() => {
    const out: string[] = []
    if (!draft.title.trim()) out.push('标题')
    if (!draft.categoryId) out.push('分类')
    if (!draft.locationId) out.push('地点')
    if (isFreeform && !draft.locationDetail.trim()) out.push('具体位置')
    if (!draft.contact.trim()) out.push('联系方式')
    if (draft.itemType === 'lost') {
      if (!draft.lastSeenAt) out.push('最后确认还在的时间')
      if (!draft.lostAt) out.push('发现丢失的时间')
    } else if (!draft.foundAt) out.push('实际拾获时间')
    return out
  }, [draft, isFreeform])

  function toPayload(): CreateItemPayload | UpdateItemPayload {
    // 另一种类型的两个时间一律发空串而不是不发：后端 parseItemTime 把空串折成 NULL，
    // 于是「切了类型但框里还留着上一个时间」不会把上一档的值写进库，
    // 也不会撞上「拾物帖不能填丢失时间」那条 VALIDATION。
    const times =
      draft.itemType === 'lost'
        ? { last_seen_at: fromLocalInput(draft.lastSeenAt), lost_at: fromLocalInput(draft.lostAt), found_at: '' }
        : { last_seen_at: '', lost_at: '', found_at: fromLocalInput(draft.foundAt) }

    const shared = {
      title: draft.title,
      description: draft.description,
      category_id: draft.categoryId ?? 0,
      location_id: draft.locationId ?? 0,
      location_detail: draft.locationDetail,
      contact: draft.contact,
      ...times,
    }

    if (isEdit) return shared
    return { ...shared, item_type: draft.itemType, image_paths: images.map((i) => i.path).filter((p): p is string => Boolean(p)) }
  }

  async function submit() {
    if (missing.length) return
    setBusy(true)
    setError('')
    setErrorId('')
    setFieldErr(null)
    try {
      if (isEdit) {
        const view = await updateItem(id!, toPayload() as UpdateItemPayload)
        // 回到详情页而不是留在表单：改完的人下一步是看它现在长什么样，
        // 而详情页会重新请求一次，显示的就是库里真的存下来的那份。
        navigate(`/items/${view.id}`)
      } else {
        const res = await createItem(toPayload() as CreateItemPayload)
        // matches_preview / notified_count 只存在于**这一次响应**里：
        // #13 之外没有任何 GET 能取回同一份数据（#20 要登录且是本人现算，结果还可能不同）。
        // 所以它得靠 navigation state 交给成功页 —— 这是这条数据唯一的活路。
        // id 另外走一遍 URL：刷新之后 state 没了，成功页还能指出「你发的那条在哪」。
        navigate(`/post/done/${res.item.id}`, { state: { result: res } })
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErr(err)
        setError(errorText(err))
        setErrorId(err.requestId)
      } else {
        setError(errorText(err))
      }
    } finally {
      setBusy(false)
    }
  }

  async function confirmDeleteImage() {
    const target = pendingDelete
    if (!target?.imageId) return
    setBusy(true)
    setError('')
    try {
      await deleteItemImage(target.imageId)
      // 只有后端确认删掉了才动列表：失败了那行还在库里，前端替它消失就是撒谎。
      setImages((cur) => cur.filter((i) => i.imageId !== target.imageId))
      setPendingDelete(null)
    } catch (err) {
      setError(errorText(err))
      setPendingDelete(null)
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <p className="muted">正在准备表单…</p>

  if (loadError) {
    return (
      <section className="card">
        <h1>{isEdit ? '改不了这条帖子' : '发不了帖'}</h1>
        <p className="alert" role="alert">{loadError}</p>
        <p className="muted">
          <Link to="/">回广场</Link>
        </p>
      </section>
    )
  }

  // 编辑模式的身份闸门。后端 #16 允许「本人或 Admin」，这里只放本人 ——
  // admin 那条路要带 admin_reason，它的入口在管理后台（片 5），不在这张表单上。
  // 不是本人时**整张表单都不出现**，而不是让人填完再吃一个 FORBIDDEN。
  if (isEdit && item && user && item.author.id !== user.id) {
    return (
      <section className="card">
        <h1>这条不是你发的</h1>
        <p className="muted">只能改自己发布的帖子。看<Link to={`/items/${item.id}`}>它的详情页</Link>。</p>
      </section>
    )
  }

  // 每栏的错误都显示在自己那一栏下面（ApiError.errorFor 按 data.errors 的 field 取），
  // 而不是只把后端那句 message 甩在页面顶上：用户得知道改哪个框。
  const fe = (field: string) => fieldErr?.errorFor(field)

  return (
    <section className="card">
      <h1>{isEdit ? '修改这条帖子' : draft.itemType === 'lost' ? '我丢了东西' : '我捡到东西'}</h1>

      {!isEdit && (
        <div className="type-tabs" role="group" aria-label="帖子类型">
          {(
            [
              ['lost', '我丢了东西'],
              ['found', '我捡到东西'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={draft.itemType === value ? 'tab tab-on' : 'tab'}
              onClick={() => patch({ itemType: value })}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {isEdit && (
        <p className="muted">
          类型：{draft.itemType === 'lost' ? '失物帖' : '拾物帖'}。发帖之后不能改类型 ——
          它是「谁在找」和「谁捡到了」这两个方向相反的立场，改了等于换了一条帖子。
        </p>
      )}

      <div className="field">
        <label htmlFor="title">
          标题 <span className="req" aria-hidden="true">*</span>
        </label>
        <input
          id="title"
          value={draft.title}
          maxLength={TITLE_MAX}
          placeholder="例如：黑色长款钱包"
          onChange={(e) => patch({ title: e.target.value })}
        />
        {fe('title') && <p className="field-error">{fe('title')}</p>}
        <p className="hint">颜色、品牌、外观特征写进标题和描述里。系统就靠这两段文字判断像不像。</p>
      </div>

      <div className="field">
        <label htmlFor="description">描述</label>
        <textarea
          id="description"
          rows={5}
          value={draft.description}
          maxLength={DESCRIPTION_MAX}
          placeholder="例如：黑色长款钱包，夹层角落有磨损，内有校园卡一张"
          onChange={(e) => patch({ description: e.target.value })}
        />
        {fe('description') && <p className="field-error">{fe('description')}</p>}
        <p className="hint strong">写上颜色、品牌、外观特征能显著提高匹配成功率。</p>
      </div>

      <div className="field">
        <label>
          分类 <span className="req" aria-hidden="true">*</span>
        </label>
        <DictCascader
          idPrefix="form-cat"
          firstLabel="大类"
          firstPlaceholder="请选择"
          tree={tree.categories}
          value={draft.categoryId}
          onChange={(categoryId) => patch({ categoryId })}
        />
        {fe('category_id') && <p className="field-error">{fe('category_id')}</p>}
        <p className="hint">要选到最细那一层（小类）。选在大类不算选中。</p>
      </div>

      <div className="field">
        <label>
          地点 <span className="req" aria-hidden="true">*</span>
        </label>
        <DictCascader
          idPrefix="form-loc"
          firstLabel="片区"
          firstPlaceholder="请选择"
          tree={tree.locations}
          value={draft.locationId}
          onChange={(locationId) => patch({ locationId })}
        />
        {fe('location_id') && <p className="field-error">{fe('location_id')}</p>}
        {isFreeform && (
          // 计划 §M7 指定了这句红字。它红是因为**后果**：匹配按地点叶子比较，
          // 选了「其他」就没有叶子可比，这次只能降到 Tier 2（宽松匹配），成功率明显掉一截。
          <p className="field-error">
            选「其他」会极大降低匹配成功率，请尽量指定到具体楼栋。下面那栏必须填，写最近的建筑。
          </p>
        )}
      </div>

      <div className="field">
        <label htmlFor="location-detail">
          具体位置{isFreeform && <span className="req" aria-hidden="true"> *</span>}
        </label>
        <input
          id="location-detail"
          value={draft.locationDetail}
          maxLength={LOCATION_DETAIL_MAX}
          placeholder="例如：三楼自习区靠窗 / 图书馆一楼服务台"
          onChange={(e) => patch({ locationDetail: e.target.value })}
        />
        {fe('location_detail') && <p className="field-error">{fe('location_detail')}</p>}
        <p className="hint">这一栏也参与匹配：地点层级比不上时，系统会退回来比这段文字。</p>
      </div>

      {draft.itemType === 'lost' ? (
        <>
          <div className="field">
            <label htmlFor="last-seen-at">
              最后确认还在的时间 <span className="req" aria-hidden="true">*</span>
            </label>
            <input
              id="last-seen-at"
              type="datetime-local"
              value={draft.lastSeenAt}
              onChange={(e) => patch({ lastSeenAt: e.target.value })}
            />
            {fe('last_seen_at') && <p className="field-error">{fe('last_seen_at')}</p>}
          </div>
          <div className="field">
            <label htmlFor="lost-at">
              发现丢失的时间 <span className="req" aria-hidden="true">*</span>
            </label>
            <input
              id="lost-at"
              type="datetime-local"
              value={draft.lostAt}
              onChange={(e) => patch({ lostAt: e.target.value })}
            />
            {fe('lost_at') && <p className="field-error">{fe('lost_at')}</p>}
            <p className="hint">
              捡到时间落在这两个时间之间的那条拾物帖，时间这一路的相似度最高；
              所以「大概什么时候还在」比「什么时候发现的」更值得想准一点。
            </p>
          </div>
        </>
      ) : (
        <div className="field">
          <label htmlFor="found-at">
            实际拾获时间 <span className="req" aria-hidden="true">*</span>
          </label>
          <input
            id="found-at"
            type="datetime-local"
            value={draft.foundAt}
            onChange={(e) => patch({ foundAt: e.target.value })}
          />
          {fe('found_at') && <p className="field-error">{fe('found_at')}</p>}
          {/* 这句话是防一个几乎人人会犯的错：把上传时间当拾获时间填。
              差几个小时就掉出别人的丢失窗口，一条本来能匹配上的帖就此错过，
              而失主永远不知道为什么没有通知。 */}
          <p className="hint strong">填你<strong>实际捡到</strong>它的时间，不是现在上传的时间。</p>
        </div>
      )}

      <div className="field">
        <label htmlFor="contact">
          联系方式 <span className="req" aria-hidden="true">*</span>
        </label>
        <input
          id="contact"
          value={draft.contact}
          maxLength={CONTACT_MAX}
          placeholder="微信号 / 手机号 / QQ 都行，填对方能联系到你的那个"
          onChange={(e) => patch({ contact: e.target.value })}
        />
        {fe('contact') && <p className="field-error">{fe('contact')}</p>}
        <p className="hint">平台不提供站内私信，这是对方联系到你的唯一方式。</p>
      </div>

      <div className="field">
        <label>图片（选填，最多 {MAX_IMAGES} 张）</label>
        {isEdit ? (
          <>
            {images.length === 0 ? (
              <p className="muted">这条帖子没有图片。</p>
            ) : (
              <ul className="thumb-grid">
                {images.map((img) => (
                  <li className="thumb-cell" key={img.imageId ?? img.url}>
                    <img src={img.url} alt="" loading="lazy" />
                    <button
                      className="capture-del"
                      type="button"
                      aria-label="删除这张图"
                      disabled={busy}
                      onClick={() => setPendingDelete(img)}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {pendingDelete && (
              <p className="confirm-row">
                这张图已经贴在帖子上，删除会<strong>立刻</strong>生效，跟你后面保不保存这次改动无关。
                <button className="btn" type="button" onClick={confirmDeleteImage} disabled={busy}>
                  确认删除
                </button>
                <button className="link-btn" type="button" onClick={() => setPendingDelete(null)}>
                  取消
                </button>
              </p>
            )}
            {/* 这是后端契约的一条限制，不是这里偷懒：#16 的 image_paths 整组替换，
                而 #15 不把已有图片的 path 给前端（ImageView 只有 id/url/sort_order），
                客户端因此无法提交「原有那些 + 新加的那张」这个完整集合 ——
                一发就会把原图全删掉。宁可不给加图的按钮，也不能给一个会删掉别人照片的按钮。 */}
            <p className="hint">改帖只能删图，不能再加图。要补照片请删了重发，或者在描述里写清楚。</p>
          </>
        ) : (
          <>
            {images.length > 0 && (
              <ul className="thumb-grid">
                {images.map((img) => (
                  <li className="thumb-cell" key={img.path ?? img.url}>
                    <img src={img.url} alt="" loading="lazy" />
                    <button
                      className="capture-del"
                      type="button"
                      aria-label="不要这张"
                      onClick={() => setImages((cur) => cur.filter((i) => i !== img))}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {/* 拍照入口在表单里也必须是一个大的全宽按钮，而不是一行小字链接：
                这一层点开的是全屏弹层，用户按下去就知道自己在选照片。 */}
            <button className="btn btn-block" type="button" onClick={() => setPickerOpen(true)}>
              {images.length ? '再加一张照片' : '拍照 / 选照片'}
            </button>
          </>
        )}
      </div>

      {error && (
        <p className="alert" role="alert">
          {error}
          {errorId && <span className="req-id">（请求编号 {errorId}）</span>}
        </p>
      )}

      <button className="btn btn-primary btn-block" type="button" disabled={busy || missing.length > 0} onClick={submit}>
        {busy ? '提交中…' : isEdit ? '保存修改' : '发布'}
      </button>
      {missing.length > 0 && (
        // 禁用按钮必须配一句「还差什么」：没有这行，按钮为什么不能点是只有开发者知道的事。
        <p className="hint">还差：{missing.join('、')}</p>
      )}

      {isEdit ? (
        <p className="hint">
          <Link to={`/items/${id}`}>先不改了，回这条帖子的详情页</Link>
        </p>
      ) : (
        <p className="hint">
          <Link to="/">先不发了，回广场</Link>
        </p>
      )}

      {pickerOpen && (
        <ImagePicker
          images={images}
          maxed={images.length >= MAX_IMAGES}
          onAdded={(image) => setImages((cur) => [...cur, image])}
          onDropped={(image) => setImages((cur) => cur.filter((i) => i !== image))}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </section>
  )
}
