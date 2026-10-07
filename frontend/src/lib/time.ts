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

/** toLocalInput 把后端那串 UTC RFC3339 翻成 `<input type="datetime-local">` 认的形状
 *  （'2026-10-07T15:04'，**本机时区**）。编辑页预填全靠它。
 *
 *  不能图省事把串截前 16 个字符：后端出口一律 UTC（model.formatTimeValue 里先 .UTC()），
 *  直接截就等于把「晚上 8 点丢的」显示成「中午 12 点丢的」。用户看到错的值、
 *  不改就保存，一条本来正确的记录被改坏 —— 而这次改帖还会重新触发匹配。 */
export function toLocalInput(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** fromLocalInput 反过来：datetime-local 的值 → 后端要的 RFC3339 UTC。
 *
 *  这一层是**必需**的，不是风格：`2026-10-07T15:04` 缺秒也缺时区偏移，
 *  不是合法 RFC3339，原样发过去后端直接 VALIDATION（item_validate.go 里 timeLayout
 *  那段注释解释了为什么后端刻意不接受多种格式 —— 同一个时刻有多种写法时，
 *  少写时区那一种会把时间静默挪 8 小时，而 S_time 恰恰是匹配最吃的那个输入）。
 *  new Date('2026-10-07T15:04') 按**本地时区**解析（ECMAScript 对不带偏移的日期时间串就是这么定的），
 *  于是 toISOString() 出来的就是那个时刻的 UTC 写法。
 *
 *  毫秒被抹掉：Go 的 RFC3339 解析其实接受小数秒，但后端出口从来不产生它，
 *  留着会让「发过去的串」和「读回来的串」比对不上，冒烟和契约测试都得多写一层归一化。 */
export function fromLocalInput(value: string): string {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}
