// src/lib/time.ts —— 时间显示的唯一一处。
//
// 后端出口一律 UTC（model.formatTimeValue 里先 .UTC() 再格式化），
// 所以 ISO 串末尾是 Z。直接把这串显示给用户会读出「周二 8:00 丢的东西显示成 0:00」，
// 那是整整一个时区的偏差，而丢失时间恰好是匹配算法最吃的那个输入（S_time），
// 用户据此以为「我填的时间不对」而去改一条本来正确的记录。
// 因此显示必须转成本机时区 —— 输入侧同理，表单里那个 datetime-local 见片 3。

const pad = (n: number) => String(n).padStart(2, '0')

/** localMinute('2026-10-07T16:08:00Z') → '2026-10-08 00:08'（本机 +08:00 时）
 *  空串原样返回空串：后端把 NULL 折成了空串，「这一列没有值」不该显示成 1970-01-01。 */
export function localMinute(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
