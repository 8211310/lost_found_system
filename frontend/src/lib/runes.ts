// src/lib/runes.ts —— 按「字（rune）数」量长度，和后端 utf8.RuneCountInString 同一种数法。
//
// 存在的理由不是风格：后端所有长度上限（reason 500、note 500、message 5–1000）都按 rune 算，
// 而 JS 的 `str.length` 按 UTF-16 单元算。一个汉字两边都是 1，所以只用中文看不出差别；
// 一个 emoji 在 JS 里是 2、在后端是 1 —— 拿 .length 做前端预检会拦下一条后端本来接受的内容，
// 那种「前端先报错、改一个字又过了」的现象排查起来最不划算。
// Array.from 按码点迭代，正好就是后端的数法。
export function runeLen(s: string): number {
  return Array.from(s).length
}
