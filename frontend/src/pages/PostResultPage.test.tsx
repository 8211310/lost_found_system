// src/pages/PostResultPage.test.tsx —— 两个长得不一样的成功页（计划 §2.6.2 的 UI 落点）。
//
// 这一页的数据只来自 navigation state：matches_preview / notified_count 是 #13 那一次响应里的键，
// 之后任何 GET 都取不回同一份。所以这里最要紧的一条是**刷新之后不许假装还在**：
// state 没了就说没了，绝不去调 #20 凑一份「看起来一样」的列表 ——
// 那是另一套条件（本人现算、可能又有新帖匹配上了）算出来的另一个答案，
// 把它当成「你发帖那一刻的结果」显示是给用户提供假证据。
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import PostResultPage from './PostResultPage'
import { server } from '../test/server'
import { BASE, ok, sampleItemView, sampleSummary } from '../test/helpers'
import type { CreateItemResult, MatchHit } from '../api/types'

function renderDone(at: string, state?: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: at, state }]}>
      <Routes>
        <Route path="/post/done/:id" element={<PostResultPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

/** 一条候选。分数照 matcher 的 round4 形状给（四位小数），显示那一列不许再加工它。 */
function hit(id: number, title: string, score: number): MatchHit {
  return {
    item: sampleSummary({ id, item_type: 'found', title, location_name: '图书馆' }),
    score,
    breakdown: {
      score,
      tier: 2,
      signals: {
        category: { weight: 0.35, score: 1, same_leaf: true },
        text: { weight: 0.3, score: 0.5, title_dice: 0.6, desc_dice: 0.4 },
        time: { weight: 0.2, score: 1, in_loss_window: true, days_after_lost_at: 1 },
        location: { weight: 0.15, score: 0.24, matched_by: 'detail_text' },
      },
    },
  }
}

describe('失物帖发出去之后', () => {
  it('有候选就把它们列出来，每条带上地点和像的程度', async () => {
    const result: CreateItemResult = {
      item: sampleItemView({ id: 301, item_type: 'lost' }),
      matches_preview: [hit(401, '捡到黑色长款钱包', 0.736), hit(402, '前台有个黑钱包', 0.6021)],
    }

    renderDone('/post/done/301', { result })

    expect(await screen.findByRole('heading', { name: '系统又帮你搜了一遍，这几条拾物帖最像' })).toBeInTheDocument()
    // toFixed(4)：后端 round4 之后是四位，显示这边补齐位数而不是再算一遍。
    expect(screen.getByText('捡到黑色长款钱包 · 图书馆 · 像 0.7360')).toBeInTheDocument()
    expect(screen.getByText('前台有个黑钱包 · 图书馆 · 像 0.6021')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /捡到黑色长款钱包/ })).toHaveAttribute('href', '/items/401')
    // 计划的定位原则：平台只记录事实、不裁决归属，所以这里不能出现「这就是你的东西」。
    expect(screen.getByText(/平台不替你认定哪一条就是你的东西/)).toBeInTheDocument()
    expect(screen.getByText(/不会阻止其他人也去联系/)).toBeInTheDocument()
  })

  it('没候选时说清接下来会发生什么，而不是许诺结果', async () => {
    const result: CreateItemResult = {
      item: sampleItemView({ id: 301, item_type: 'lost' }),
      matches_preview: [],
    }

    renderDone('/post/done/301', { result })

    expect(await screen.findByRole('heading', { name: '已经登记好了' })).toBeInTheDocument()
    expect(screen.getByText(/之后如果有人发拾物帖匹配上了，我们会通知你/)).toBeInTheDocument()
    // §2.6.3 点名的那句承诺话：这一屏不许出现任何「保证找回」的措辞。
    expect(screen.queryByText(/帮你找回|一定能|很快就会有人/)).not.toBeInTheDocument()
  })
})

describe('拾物帖发出去之后', () => {
  it('通知了人就只报人数，并且明确「你不需要再做别的」', async () => {
    const result: CreateItemResult = {
      item: sampleItemView({ id: 302, item_type: 'found' }),
      notified_count: 2,
    }

    renderDone('/post/done/302', { result })

    expect(await screen.findByRole('heading', { name: '拾物帖已经发出去了' })).toBeInTheDocument()
    // 数字用后端给的，不自己数：它数的是这一趟真的被写进通知台账的那几个失主。
    expect(screen.getByText('已通知 2 位可能丢过这个东西的同学。')).toBeInTheDocument()
    expect(screen.getByText(/平台不替你判断东西该归谁/)).toBeInTheDocument()
    // 这一条是给「捡到人」的：他什么都没做错，不该在这一屏看到任何要他提交什么的东西。
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('一个都没通知到时说「挂在广场上」而不是「失败了」', async () => {
    const result: CreateItemResult = {
      item: sampleItemView({ id: 302, item_type: 'found' }),
      notified_count: 0,
    }

    renderDone('/post/done/302', { result })

    expect(await screen.findByText(/暂时没有匹配到失物帖/)).toBeInTheDocument()
    expect(screen.queryByText(/已通知/)).not.toBeInTheDocument()
  })
})

describe('刷新之后（state 没了）', () => {
  it('老实说那一屏的结果取不到了，但仍然给得出帖子本身在哪', async () => {
    // 只注册这一条：这一页在没 state 时应该一个请求都不发。
    // 少注册任何端点都会被 setup 里的 onUnhandledRequest:'error' 当场炸掉，
    // 所以「它有没有偷偷去调 #20 凑一份列表」这条测试是白拿的。
    let matchCalls = 0
    server.use(
      http.get(`${BASE}/api/items/:id/matches`, () => {
        matchCalls += 1
        return HttpResponse.json(ok({ tier: 1, list: [] }))
      }),
    )

    renderDone('/post/done/301')

    expect(await screen.findByRole('heading', { name: '这一屏的结果已经不在了' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '看你发的那条帖子' })).toHaveAttribute('href', '/items/301')
    expect(screen.getByRole('link', { name: '回广场' })).toHaveAttribute('href', '/')
    expect(matchCalls).toBe(0)
  })
})
