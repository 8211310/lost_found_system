// src/auth/RequireAuth.tsx —— 受保护路由的入口守卫。
import { Navigate, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from './AuthContext'

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth()
  const location = useLocation()

  if (status === 'loading') return <p className="muted">正在确认登录状态…</p>

  if (status === 'anon') {
    // 把原地址带走，登录成功后回原位。片 2 之后解锁联系方式这类动作全靠它 ——
    // 未登录点「认领」被踢去登录页，登录完必须回到那条帖子，而不是首页。
    return <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />
  }

  return children
}
