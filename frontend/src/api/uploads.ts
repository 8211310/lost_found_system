// src/api/uploads.ts —— §4 的 #6 POST /api/uploads（JWT，multipart）。
//
// 这是全项目**唯一**不走 JSON 的写端点：请求体是 multipart/form-data，字段名固定为 `file`
// （后端 handler/upload.go 里的 formFieldFile）。所以它不复用 postJSON ——
// 把对象交给 axios 会被序列化成 JSON，那边 c.FormFile 找不到字段，
// 用户收到的是一句莫名其妙的「没有收到图片」。
import { ApiError, http } from './client'
import { TOO_LARGE_LOCAL } from './codes'
import type { StoredImage } from './types'

/** 一张图片的字节上限，和后端 service.MaxUploadBytes 同一个数（5MB）。
 *
 * 这里只做**大小**预检、不做类型预检，因为这两件事前端能知道的程度不一样：
 * - `file.size` 是浏览器报的真实字节数，和后端量出来的一致，拦在前面省掉一次注定失败的上传；
 * - `file.type` 是浏览器按**扩展名**猜的，而后端读文件头 512 字节嗅探（http.DetectContentType）。
 *   一张改了后缀的 .txt 在这里是 image/png、在那边是 FILE_TYPE_UNSUPPORTED。
 *   前端照 MIME 拦就会出现「这里放过去了、那边还是拒」，而两处说法不一样 ——
 *   判据只能有一份，它在后端。 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** #6 上传一张图片，拿到 {path, url}。
 *  path 是发帖时该放进 image_paths 的那个值，url 只用来显示（见 StoredImage 上那段）。
 *
 * ⚠ 这一调用会往服务器写文件，而写下来的图在没被任何帖子引用之前是「孤儿」。
 * 所以它只能由真实的「拍照 / 选图片」触发；用户在表单里撤掉一张图时**不做回收** ——
 * 后端没有删孤儿文件的端点（#42 只删已入库的图片行），这是刻意的取舍：
 * 代价是 uploads 目录里会留下几个没人引用的文件，
 * 好处是不会出现「为了回收孤儿而删掉别人正在用的图」这种更糟的事。 */
export async function uploadImage(file: File): Promise<StoredImage> {
  if (file.size > MAX_IMAGE_BYTES) {
    // 前端造的码（见 codes.ts 里 TOO_LARGE_LOCAL 那段）：后端在这条路上根本没收到请求，
    // 不可能返回 FILE_TOO_LARGE，页面需要一个能分支的东西。
    // message 直接写在这条路上而不是进 errorText 的表 —— 和 NETWORK 同一类待遇：
    // 它没有对应的后端 code，表里也没有它的位置。
    throw new ApiError({
      code: TOO_LARGE_LOCAL,
      message: `这张图片 ${Math.ceil(file.size / 1024 / 1024)}MB，超过 5MB 上限，已经拦住了没有上传。`,
    })
  }

  const form = new FormData()
  form.append('file', file)

  // 超时单独放宽到 60 秒：实例那 15 秒是给 JSON 请求定的，而一张 4MB 的手机照片
  // 在蜂窝网络上 15 秒传不完 —— 传不完会报「连不上服务器」，用户以为后端挂了，
  // 实际是他那张图太大。**不是**给大文件开绿灯，只是别把慢报成挂。
  const res = await http.post<StoredImage>('/api/uploads', form, { timeout: 60_000 })
  return res.data
}
