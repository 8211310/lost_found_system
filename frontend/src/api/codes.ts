// src/api/codes.ts —— 后端 internal/apperr/codes.go 的镜像，共 OK + 21 个错误码。
//
// 那边文件头上的铁律同样适用于前端：**只允许 match code，禁止依赖 message 文本**。
// message 是给人看的中文，随时可以改措辞；code 是稳定的机器码，永不改语义。
// 所以这个文件必须和 codes.go 一起维护：后端加一个码，这里跟着加一个。
export const Code = {
  OK: 'OK',
  INTERNAL: 'INTERNAL',

  VALIDATION: 'VALIDATION',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  CONFLICT: 'CONFLICT',

  USER_ALREADY_EXISTS: 'USER_ALREADY_EXISTS',
  USER_BANNED: 'USER_BANNED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  WEAK_PASSWORD: 'WEAK_PASSWORD',
  OLD_PASSWORD_WRONG: 'OLD_PASSWORD_WRONG',

  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  FILE_TYPE_UNSUPPORTED: 'FILE_TYPE_UNSUPPORTED',

  ITEM_CLOSED: 'ITEM_CLOSED',

  RETURN_DUPLICATE: 'RETURN_DUPLICATE',
  RETURN_ILLEGAL_TRANSITION: 'RETURN_ILLEGAL_TRANSITION',
  RETURN_SELF: 'RETURN_SELF',

  CATEGORY_IN_USE: 'CATEGORY_IN_USE',

  REPORT_DUPLICATE: 'REPORT_DUPLICATE',
  REPORT_ALREADY_RESOLVED: 'REPORT_ALREADY_RESOLVED',
} as const

export type CodeValue = (typeof Code)[keyof typeof Code]

// 前端自己造的码，后端永远不会返回它。存在的理由：请求根本没走到后端
// （后端没起、proxy 目标写错、超时）时，页面需要一个能分支的东西，
// 而不是 `err.message === 'Network Error'` 这种依赖 axios 措辞的判断。
export const NETWORK_ERROR = 'NETWORK'

/** 同上：图片在**浏览器里**就被大小预检拦下时用的码（api/uploads.ts 的 MAX_IMAGE_BYTES）。
 *  后端这条路根本没收到请求，所以它不可能回 FILE_TOO_LARGE ——
 *  拿真码来代表「后端说过这句话」是假的，宁可造一个明确标着 LOCAL 的。
 *  ⚠ 文案和 FILE_TOO_LARGE 显示上几乎一样，但分支必须分开写：
 *  「没上传成功因为太大」和「传上去了被退回」用户接下来要做的事不同（一个不用等网络）。 */
export const TOO_LARGE_LOCAL = 'FILE_TOO_LARGE_LOCAL'
