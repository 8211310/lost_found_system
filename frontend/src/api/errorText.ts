// src/api/errorText.ts —— 把后端 code 翻译成人话的唯一一处。
//
// 表里没有的 code 一律直接显示后端的 message：那是给人看的中文文案，**显示**它不是
// 依赖它做分支（分支永远写在 code 上），后端改了措辞页面不会坏。
// NETWORK 也不在这里 —— 那种错误的 message 是 client.ts 里现写的排查提示，本来就该直接显示。
//
// ⚠ VALIDATION 和 CONFLICT 刻意**不**进这张表。后端每次校验失败都把具体原因写在 message 上
// （apperr.Validation 的第一个参数就是那句人话，比如「用户名不能包含空格」），
// 前端替它编一句「填写的内容有不对的地方」只会更差 —— 用户看不到该改哪个字段。
// 字段级的定位靠 ApiError.errorFor(field)，那条路径各表单自己用。
//
// CONFLICT 进这张表是同一个坑：backend 里三个抛它的地方（repo/dict.go 的同名兄弟 ×2、
// repo/pgerr.go）都各带一句具体话，而 codes.go 那句默认「资源冲突」从来没单独出现过。
// 覆盖成「和已有数据冲突了」等于把「同一个上级下面已经有一个同名的分类了」这种
// 正好告诉人该怎么办的句子藏起来。
import { Code } from './codes'
import { ApiError } from './client'

const TEXT: Record<string, string> = {
  [Code.INVALID_CREDENTIALS]: '用户名或密码错误',
  [Code.USER_BANNED]: '账号已被封禁，请联系管理员',
  [Code.UNAUTHORIZED]: '请先登录',
  [Code.FORBIDDEN]: '没有权限执行这个操作',
  [Code.NOT_FOUND]: '要找的东西不在了',
  [Code.USER_ALREADY_EXISTS]: '这个用户名已经被注册了，换一个',
  [Code.WEAK_PASSWORD]: '密码至少 8 位，且不能是纯数字',
  [Code.OLD_PASSWORD_WRONG]: '原密码不正确',
  [Code.INTERNAL]: '服务器出错了，请带上页面下方显示的请求编号反馈',

  // 下面三条属于归还确认流（#23）。措辞要守后端那份禁词表（TestNoticeCopyMakesNoPlatformPromise
  // 禁 归还成功 / 已归还给你 / 已关闭 / 这就是 / 判定）：前端在这里同样**不许**替平台下结论。
  // 比如 RETURN_ILLEGAL_TRANSITION 不能写成「这条已经处理完了」——处理完是「帖子归还成功了」
  // 的委婉说法，而平台记录的只是「发帖人做过一次 confirm/reject/cancel」这个事实。
  [Code.RETURN_SELF]: '这条帖子是你自己发的，不需要向自己提交归还确认。',
  [Code.RETURN_DUPLICATE]: '你为这条帖子提交的那一次还在等对方处理，不用重复提交。',
  [Code.RETURN_ILLEGAL_TRANSITION]: '这一条的状态已经变了，页面上显示的是最新的那一版。',
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    return TEXT[err.code] ?? err.message
  }
  return '发生了一个未预期的错误'
}

/** 请求编号是给 §9 的日志排查用的：出错了让人能把它抄下来给你。 */
export function requestIdOf(err: unknown): string {
  return err instanceof ApiError ? err.requestId : ''
}
