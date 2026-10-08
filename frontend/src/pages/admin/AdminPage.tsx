// src/pages/admin/AdminPage.tsx —— 管理后台那一页，计划 §M7 钉的五个页签 + 字典（#9–#12）。
//
// 为什么是一页五个页签而不是五条路由：它们回答的是同一组问题的不同侧面
// （这些人是谁 → 有什么在等着处理 → 现在动手 → 动过什么 → 这系统多大），
// 而 admin 的一次完整动作要在这几页之间来回（从举报待办跳去下架、再回操作日志确认留痕）。
// 分成五条路由的话每次都得把筛选状态塞进 URL 再取出来，而它们本来就在同一个会话里。
// 地址仍然是可分享的：?tab=…&status=open&page=2 那套参数各页自己读写。
//
// 顶上那句立场不是装饰，是给这一页定的边界：**admin 能销毁内容和账号，但不能制造归属。**
// 这一族端点里压根没有 confirm / reject / 关帖 / 干预匹配那几条（后端 M6 有专门一条测试
// 断言 admin 组里没有它们），所以这五页里不会出现任何「替发帖人拿个主意」的按钮 ——
// 唯一接近的那件事是删掉一行归还确认，而那是销毁记录，不是判定归还。
import { useSearchParams } from 'react-router-dom'
import ActionsTab from './ActionsTab'
import DebugTab from './DebugTab'
import DictTab from './DictTab'
import ReportsTab from './ReportsTab'
import StatsTab from './StatsTab'
import TakedownTab from './TakedownTab'
import UsersTab from './UsersTab'

const TABS = [
  { value: 'users', label: '用户', El: UsersTab },
  { value: 'reports', label: '举报待办', El: ReportsTab },
  { value: 'takedown', label: '批量下架', El: TakedownTab },
  { value: 'actions', label: '操作日志', El: ActionsTab },
  { value: 'stats', label: '统计', El: StatsTab },
  // 这两块不在计划 §M7 钉的那五个页签里，接的是后端早就做完、前端一直没接的 #9–#12 和 #39
  // （2026-10-08 用户要求「后端做完了前端全量跟进」）。
  { value: 'dict', label: '字典', El: DictTab },
  // ⚠ 「诊断」这一页在生产环境永远显示一句「这条路由没注册」：那是它该有的样子，不是坏了。
  { value: 'debug', label: '诊断', El: DebugTab },
] as const

type AdminTab = (typeof TABS)[number]['value']

export default function AdminPage() {
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab: AdminTab = (TABS as readonly { value: string }[]).some((t) => t.value === raw) ? (raw as AdminTab) : 'users'
  const Active = TABS.find((t) => t.value === tab)!.El

  function go(next: AdminTab) {
    // 换页签只保留 tab 这一个参数：上一个页签的筛选和页码必须清掉。
    // #34 的 status=banned 带进「操作日志」会变成 #50 那个非法枚举值，
    // 报出来是一条 VALIDATION，而人会以为是自己点错了页签。
    setParams(new URLSearchParams({ tab: next }), { replace: true })
  }

  return (
    <>
      <section className="card">
        <h1>管理后台</h1>
        <p className="muted">
          这里的每一次动作都会留下一行对全体管理员可见的账：日志不能改、也不能删，
          所以按下去之前先看清那一句「会发生什么」。admin 能销毁内容和账号，但不能制造归属——
          确认或驳回归还是发帖人的事，这一页里没有那种按钮。
        </p>

        <div className="type-tabs" role="group" aria-label="管理后台页签">
          {TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              className={tab === t.value ? 'tab tab-on' : 'tab'}
              aria-pressed={tab === t.value}
              onClick={() => go(t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <Active />
      </section>
    </>
  )
}
