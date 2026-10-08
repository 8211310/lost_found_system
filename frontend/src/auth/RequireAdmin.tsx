// src/auth/RequireAdmin.tsx —— 管理后台的门。
//
// 它挡的是「点进来之前就知道自己进不去」，**不是**权限本身：真正的闸门在后端
// router.go 那个 admin 组上（jwt → RequireAdmin，而且 role 每个请求回库重读一次）。
// 两边都要，各管一种失误：少了后端那道，前端判 role 的依据（#3 的响应）就成了唯一的防线；
// 少了这道，普通用户会先看到一片「加载失败：没有权限执行这个操作」，
// 而那看起来像后台坏了，不像「这一页本来就不给你看」。
//
// 用 role 而不是解析 JWT：token 里只有 sub，role 和 status 都不在里面（AuthContext 头上那条设计 1）。
// 所以页面刚打开、#3 还没回来时 status 是 loading —— 那时**不渲染 children**，
// 否则五个页签会各自发一条必然 403 的请求，日志里多出五条噪音，
// 而一个人只是点错了一个链接。
import { useAuth } from './AuthContext'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { user, status } = useAuth()

  if (status === 'loading') return <p className="muted">正在确认登录状态…</p>

  if (user?.role !== 'admin') {
    return (
      <section className="card">
        <h1>这一页只有管理员能看</h1>
        <p className="muted">
          管理后台里的每一个动作都会留下一行对全体管理员可见的账，所以它不开给普通账号。
          如果你觉得自己应该看到某条信息，回<Link to="/">广场</Link>或者去
          <Link to="/me/notifications">通知</Link>里找它 —— 那两条路是给你用的。
        </p>
      </section>
    )
  }

  return children
}
