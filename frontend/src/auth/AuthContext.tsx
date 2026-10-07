// src/auth/AuthContext.tsx —— 全站唯一的登录态来源。
//
// 两件刻意的设计：
//
// 1. **刷新页面后靠 #3 GET /api/auth/me 恢复身份，不去解本地 JWT。**
//    token 里只有 sub，role 和 status 都不在里面（middleware/jwt.go 每个请求都重新读库，
//    好让封号和降权即时生效）。所以前端手上那份 token 根本不携带可信的身份信息，
//    想知道「我是谁、我是不是 admin」只有一个办法：问后端。
//
// 2. **status 是三态而不是 user 是否为 null。**
//    「还没问出来」和「确认没登录」必须能区分开，否则 RequireAuth 会在页面刚打开时
//    把已登录的人踢去登录页 —— 那个 bug 只在刷新时出现，本地跑起来特别容易看漏。
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import * as authApi from '../api/auth'
import { clearToken, getToken, onSessionChange, setToken } from '../api/session'
import type { UserView } from '../api/types'

export type AuthStatus = 'loading' | 'authed' | 'anon'

interface AuthValue {
  user: UserView | null
  status: AuthStatus
  login: (username: string, password: string) => Promise<void>
  logout: () => void
  /** 重新问一次 #3。#4 改完资料之后要调它，而不是把 #4 的响应直接塞进 state：
   *  全站的身份信息来源只能有 #3 那一个（这个文件头上的设计 1 说的就是这件事），
   *  多塞一份就多一个「页面上显示的是三分钟前的昵称」的机会。 */
  refresh: () => Promise<void>
}

const Ctx = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserView | null>(null)
  const [status, setStatus] = useState<AuthStatus>(() => (getToken() ? 'loading' : 'anon'))

  // 首屏：有 token 就去后端确认一次身份。
  useEffect(() => {
    if (!getToken()) return
    let ignored = false
    authApi
      .me()
      .then((u) => {
        if (ignored) return
        setUser(u)
        setStatus('authed')
      })
      .catch(() => {
        // 任何失败都退回匿名：token 过期、签名换了、账号被封（#3 走 JWT 中间件）、后端没起。
        // 后端没起这一种会被 axios 拦截器换成 NETWORK 错误，此时把人判成未登录不算错，
        // 后面的页面请求同样会失败，用户看到的是同一句提示。
        if (ignored) return
        setUser(null)
        setStatus('anon')
      })
    return () => {
      ignored = true
    }
  }, [])

  // 订阅 session 变化：清 token 的动作发生在 axios 拦截器里（拿到 UNAUTHORIZED / USER_BANNED），
  // 它在 React 树外面，只能靠这个订阅把状态同步进来。
  useEffect(
    () =>
      onSessionChange(() => {
        if (getToken()) return
        setUser(null)
        setStatus('anon')
      }),
    [],
  )

  const login = useCallback(async (username: string, password: string) => {
    const res = await authApi.login(username, password)
    setToken(res.token)
    setUser(res.user)
    setStatus('authed')
  }, [])

  const logout = useCallback(() => {
    clearToken()
    setUser(null)
    setStatus('anon')
  }, [])

  // refresh 失败**不动**状态：能走到这里说明用户刚做完一次写操作（#4 改资料），
  // 把「重新读一次身份」的失败解释成「你被登出了」会凭空吃掉一个人的登录态。
  // 真的过期时不必靠这里收尾——axios 拦截器拿到 UNAUTHORIZED 会 clearToken，
  // 上面那个 onSessionChange 订阅会把状态同步进来。
  const refresh = useCallback(async () => {
    const u = await authApi.me()
    setUser(u)
  }, [])

  return <Ctx.Provider value={{ user, status, login, logout, refresh }}>{children}</Ctx.Provider>
}

export function useAuth(): AuthValue {
  const value = useContext(Ctx)
  if (!value) throw new Error('useAuth 必须在 <AuthProvider> 里面调用')
  return value
}
