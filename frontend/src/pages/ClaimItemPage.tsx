// src/pages/ClaimItemPage.tsx —— #23 POST /api/items/:id/returns（提交归还确认）。
//
// 方向要认准：这一条是**丢了东西的人**向**捡到东西的人**提交确认，所以只有 found 帖能进来
// （对 lost 帖调用后端给的是 VALIDATION 而不是 NOT_FOUND）。
//
// 后端**不要求先解锁过联系方式**，也不看你们匹不匹配得上（RETURN_NOT_UNLOCKED 那个码
// 整个被删掉了）。防乱提交靠的只有三条弱机制：不能给自己提交、同一个人同一帖只能有一条
// pending、留言和图片都得填。真正的防线是发帖人自己的判断。
// 所以这一页不许写「提交后系统会核实」那种话 —— 没有任何东西会被核实。
import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { getItem } from '../api/items'
import { submitReturn } from '../api/returns'
import { errorText, requestIdOf } from '../api/errorText'
import { ApiError } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import ImagePicker, { type PickedImage } from '../components/ImagePicker'
import { localMinute } from '../lib/time'
import type { ItemView } from '../api/types'

const MESSAGE_MIN = 5
const MESSAGE_MAX = 1000

function runeLen(s: string): number {
  return [...s.trim()].length
}

export default function ClaimItemPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()

  const [item, setItem] = useState<ItemView | null>(null)
  const [loadError, setLoadError] = useState('')
  const [message, setMessage] = useState('')
  const [proof, setProof] = useState<PickedImage | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [error, setError] = useState('')
  const [errorId, setErrorId] = useState('')
  const [fieldError, setFieldError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let dead = false
    getItem(id)
      .then((res) => {
        if (!dead) setItem(res)
      })
      .catch((err) => {
        if (!dead) setLoadError(errorText(err))
      })
    return () => {
      dead = true
    }
  }, [id])

  const len = runeLen(message)
  const canSubmit = len >= MESSAGE_MIN && !!proof?.path && !busy
  const missing: string[] = []
  if (len < MESSAGE_MIN) missing.push(`说明至少写 ${MESSAGE_MIN} 个字`)
  if (!proof?.path) missing.push('一张凭证图')

  async function onSubmit() {
    if (!canSubmit || !proof?.path) return
    setBusy(true)
    setError('')
    setErrorId('')
    setFieldError('')
    try {
      const res = await submitReturn(id, { message: message.trim(), proof_image_path: proof.path })
      // 提交之后不停在这一页：这一条已经存在了，再停在这儿只会让人以为还没交上去，
      // 而重复提交拿到的是 RETURN_DUPLICATE，一句报错换一次困惑。
      navigate(`/returns/${res.id}`, { replace: true })
    } catch (err) {
      setError(errorText(err))
      setErrorId(requestIdOf(err))
      if (err instanceof ApiError) setFieldError(err.errorFor('proof_image_path') ?? err.errorFor('message') ?? '')
    } finally {
      setBusy(false)
    }
  }

  if (loadError && !item) {
    return (
      <section className="card">
        <h1>这条帖子读不到</h1>
        <p className="alert" role="alert">
          {loadError}
        </p>
        <p className="muted">
          <Link to="/">回广场</Link>
        </p>
      </section>
    )
  }

  if (!item) return <p className="muted">正在加载…</p>

  // 两种人在这张表前面都没有出路，所以都不给表，而不是让他填完再收一句报错：
  // - 发帖人自己：#23 判据④给 RETURN_SELF；
  // - lost 帖：#23 判据③给 VALIDATION —— 丢了东西的人没有「拾主」可提交，
  //   这一族的方向是反的（是捡到的人欠一个判断，不是丢了的人欠一个判断）。
  // 入口在详情页上就只给 found 帖的别人，所以这里挡的是直接敲地址进来的人。
  if (item.item_type !== 'found' || user?.id === item.author.id) {
    return <Navigate to={`/items/${item.id}`} replace />
  }

  return (
    <section className="card">
      <h1>向拾主提交归还确认</h1>

      <p className="muted">
        帖子：
        <Link to={`/items/${item.id}`}>{item.title}</Link>
        <span className="tag tag-found">拾物</span>
      </p>
      <p className="item-meta">
        {item.category.name} · {item.location.name} · 拾获于 {localMinute(item.found_at ?? '')}
      </p>

      <p className="hint">
        拾主会看到你写的说明、这张凭证图，还有你的昵称和信用分。真实姓名不会带过去。
        平台不核实这些内容，也不判断东西是不是你的 —— 最后那一句话由拾主自己给。
      </p>

      {error && (
        <p className="alert" role="alert">
          {error}
          {errorId && <span className="req-id">（请求编号 {errorId}）</span>}
        </p>
      )}
      {fieldError && <p className="field-error">{fieldError}</p>}

      <div className="field">
        <label htmlFor="message">说明这件东西为什么是你的</label>
        <textarea
          id="message"
          rows={5}
          value={message}
          maxLength={MESSAGE_MAX * 2}
          onChange={(e) => setMessage(e.target.value)}
        />
        <span className={len > MESSAGE_MAX ? 'counter over' : 'counter'}>
          {len} / {MESSAGE_MAX}
        </span>
      </div>

      <div className="field">
        <label htmlFor="proof">凭证图（必填，一张）</label>
        {proof ? (
          <div className="proof-picked">
            <img className="proof-img" src={proof.url} alt="凭证图预览" />
            <button className="btn" type="button" onClick={() => setProof(null)}>
              换一张
            </button>
          </div>
        ) : (
          <button className="btn btn-block" type="button" onClick={() => setPickerOpen(true)}>
            拍照或从相册选一张
          </button>
        )}
      </div>

      <button className="btn btn-primary" type="button" disabled={!canSubmit} onClick={onSubmit}>
        {busy ? '提交中…' : '提交给拾主'}
      </button>
      {!canSubmit && missing.length > 0 && <p className="hint">还差：{missing.join('、')}</p>}

      <p className="hint">
        提交之后这条会进入「等拾主答复」的状态。你可以随时撤销它，也可以再提交一次新的 ——
        但同一件东西你只能有一条在等答复。
      </p>

      {pickerOpen && (
        <ImagePicker
          images={proof ? [proof] : []}
          maxed={!!proof}
          onAdded={(image) => {
            setProof(image)
            setPickerOpen(false)
          }}
          onDropped={() => setProof(null)}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </section>
  )
}
