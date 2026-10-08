// src/api/admin.test.ts —— reason 那三道预检（必填、trim、按 rune 数 500）。
//
// 这一族端点的 reason 同时进两处：留痕那一列，和对方收到的通知那一句话。
// 所以「前端先拦」和「后端会拒」必须是同一个判据 —— 差一点的表现形式是
// 「我删了两个字就保存成功了」，而管理员正在做的是一次不可逆的治理动作。
import { describe, expect, it } from 'vitest'
import { MAX_REASON_RUNES, reasonProblem } from './admin'

describe('reasonProblem', () => {
  it('空和纯空白都给同一句「必须填写理由」，不是分别两句', () => {
    expect(reasonProblem('')).toBe('必须填写理由')
    expect(reasonProblem('   \n  ')).toBe('必须填写理由')
  })

  it('正常一句放行', () => {
    expect(reasonProblem('同一账号批量发布广告帖')).toBe('')
  })

  it('边界是 500，第 501 个字才拒', () => {
    expect(reasonProblem('字'.repeat(MAX_REASON_RUNES))).toBe('')
    expect(reasonProblem('字'.repeat(MAX_REASON_RUNES + 1))).toBe(
      `理由最多 ${MAX_REASON_RUNES} 个字，当前 ${MAX_REASON_RUNES + 1} 个`,
    )
  })

  it('首尾空白不计入长度：后端比的是 trim 之后的 rune 数', () => {
    const core = '字'.repeat(MAX_REASON_RUNES)
    expect(reasonProblem(`  ${core}  `)).toBe('')
  })

  it('emoji 按一个字算：JS 的 .length 会把它们数成两个而误拒', () => {
    // 后端是 utf8.RuneCountInString，一个 emoji 是 1；这里凑 500 个 rune，
    // 其中 10 个是 emoji —— 用 .length 数会得到 510 并把这条合法的理由拦下来。
    const s = '😀'.repeat(10) + '字'.repeat(490)
    expect(s.length).toBe(510)
    expect(reasonProblem(s)).toBe('')

    const over = '😀'.repeat(10) + '字'.repeat(491)
    expect(reasonProblem(over)).toBe(`理由最多 ${MAX_REASON_RUNES} 个字，当前 501 个`)
  })
})
