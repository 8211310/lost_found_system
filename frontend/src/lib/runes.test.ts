// src/lib/runes.test.ts —— 长度这一把尺子得和后端同一把。
//
// 只用中文看不出差别（一个汉字两边都是 1），所以这一条测试的全部价值在那种
// 只在 JS 里算两个的字符上：拿 .length 做预检会拦下一条后端本来接受的理由，
// 而那种「前端先报错、改一个字又过了」的现象最难排查。
import { describe, expect, it } from 'vitest'
import { runeLen } from './runes'

describe('runeLen', () => {
  it('中文按字算', () => {
    expect(runeLen('刷屏广告')).toBe(4)
  })

  it('JS 里占两个单元的字在这里算一个', () => {
    // 这五个字符在 JS 的 .length 里是 7：emoji 各 2、引号 1。
    expect('😀「刷」😀'.length).toBe(7)
    expect(runeLen('😀「刷」😀')).toBe(5)
  })

  it('空串是 0，全空白不是 0（是不是空由调用方 trim 之后自己判）', () => {
    expect(runeLen('')).toBe(0)
    expect(runeLen('   ')).toBe(3)
  })
})
