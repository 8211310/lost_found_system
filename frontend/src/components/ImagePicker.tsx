// src/components/ImagePicker.tsx —— 拍照 / 选图片的全屏弹层（只负责 #6 上传那一段）。
//
// 计划 §M7 对这一块的要求很具体，因为它决定这条路在手机上到底能不能走通：
//   「大的全宽按钮，预览用 85%+ 高度的全屏弹层，头部只放关闭图标，底部一个大的全宽拍照/确认按钮。
//    不要藏在小弹窗底部，不要加多余的滑动面板。」
// 所以层级是：backdrop → 全屏层 → 头部只有 × → 中间缩略图 → 底部一个 .btn-block 主按钮。
//
// 用原生 `<input type="file" accept="image/*" capture="environment">` 调系统相机，
// 不自研 WebRTC：少几十倍代码，移动端体验也更好（计划原文的理由）。
// ⚠ 桌面上 capture 被忽略、退化成普通文件选择框 —— 真机拍照只能在手机上验，
// 这一条收尾时算「UI 层验不了」之一，不是「已验证」。
//
// 这里**不碰 #42**：这一层只处理「还没提交」的图片，× 掉一张就是从 image_paths 里去掉一个路径，
// 没有任何远端状态要同步。已经贴在帖子上的那些图在编辑页里删（走 #42，立刻生效），
// 两种删除的后果不一样，所以两套 UI 不共用一个按钮。
import { useRef, useState } from 'react'
import { MAX_IMAGE_BYTES, uploadImage } from '../api/uploads'
import { errorText, requestIdOf } from '../api/errorText'

/** 表单里的一张图。两种来源，字段有有无**是契约本身**，不是随手拼的形状：
 *  - url：#6 刚返回的，或 #15 里已有的，只用来显示；
 *  - path：只有本次新上传的才有。#15 的 ImageView 不含 path，所以已有图片无法被重建进
 *    image_paths —— 这就是编辑模式整组不发 image_paths 的原因（见 api/types.ts 的 UpdateItemPayload）。
 *  - imageId：只有已入库的才有，它是 #42 的唯一入口。 */
export interface PickedImage {
  url: string
  path?: string
  imageId?: number
}

interface Props {
  images: PickedImage[]
  /** 已经满 9 张时禁用拍照按钮。这个数字来自后端 service.maxItemImages，不是前端审美：
   *  数据库没这个限制，超了会得到一句写着 image_paths 的 VALIDATION。 */
  maxed: boolean
  onAdded: (image: PickedImage) => void
  /** 只是从列表里去掉：这张图已经上传到服务器了，但还没被任何帖子引用。
   *  后端没有「删孤儿文件」的端点（#42 只删已入库的图片行），所以这里删不掉磁盘上那个文件，
   *  这是已知取舍，不是漏写。 */
  onDropped: (image: PickedImage) => void
  onClose: () => void
}

export default function ImagePicker({ images, maxed, onAdded, onDropped, onClose }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [errorId, setErrorId] = useState('')

  async function pick(file: File | undefined) {
    // 先清空 input.value：连续两次选同一个文件时 change 不会触发（浏览器认为值没变），
    // 用户看到的症状是「删掉之后再加同一张，按钮没反应」。
    if (input.current) input.current.value = ''
    if (!file) return
    setBusy(true)
    setError('')
    setErrorId('')
    try {
      const stored = await uploadImage(file)
      onAdded({ url: stored.url, path: stored.path })
    } catch (err) {
      setError(errorText(err))
      setErrorId(requestIdOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="capture-backdrop">
      <div className="capture" role="dialog" aria-modal="true" aria-label="图片">
        <div className="capture-head">
          {/* 头部只有一个关闭图标：计划明写「不要多余的滑动面板」，所以这里不放标题按钮组、
              不放「完成」—— 每按一次拍照就多一张图，列表本身就是结果。 */}
          <button className="sheet-close" type="button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <ul className="capture-grid">
          {images.length === 0 && (
            <li className="capture-empty muted">
              还没有图片。照片比文字更能说明「就是这一个」，尤其是颜色和磨损的位置。
            </li>
          )}
          {images.map((img) => (
            <li className="capture-cell" key={img.path ?? img.url}>
              <img src={img.url} alt="" loading="lazy" />
              <button
                className="capture-del"
                type="button"
                aria-label="不要这张"
                disabled={busy}
                onClick={() => onDropped(img)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>

        {error && (
          <p className="alert" role="alert">
            {error}
            {errorId && <span className="req-id">（请求编号 {errorId}）</span>}
          </p>
        )}

        <input
          ref={input}
          className="capture-input"
          type="file"
          accept="image/*"
          capture="environment"
          aria-label="选择图片文件"
          onChange={(e) => pick(e.target.files?.[0])}
        />

        {/* 底部这个按钮是整块 UI 里最大最显眼的东西：全屏层底部、全宽、主色。
            计划把它单列出来，是因为「拍照入口藏在小弹窗底部」是这类系统最常见的失败 ——
            丢东西的人站在图书馆门口单手操作，找不到按钮就直接走了。 */}
        <button
          className="btn btn-primary btn-block capture-shot"
          type="button"
          disabled={busy || maxed}
          onClick={() => input.current?.click()}
        >
          {busy ? '正在上传…' : maxed ? '最多 9 张，先去掉一张再加' : '拍照 / 从相册选一张'}
        </button>
        <p className="hint">
          单张不超过 {MAX_IMAGE_BYTES >> 20}MB，jpg / png / webp / gif。类型由后端读文件内容判，改后缀骗不过去。
        </p>
      </div>
    </div>
  )
}
