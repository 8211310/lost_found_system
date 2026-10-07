// src/pages/LoginPage.tsx —— #2 POST /api/auth/login
import { Navigate, useLocation, useNavigate, Link } from 'react-router-dom'
import { useState, type FormEvent } from 'react'
import { errorText, requestIdOf } from '../api/errorText'
import { useAuth } from '../auth/AuthContext'

export default function LoginPage() {
  const { login, status } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [requestId, setRequestId] = useState('')
  const [busy, setBusy] = useState(false)

  // from：被 RequireAuth 踢出来时那条路，登录完要回去（§4 的解锁、认领都靠它）
  const state = location.state as { from?: string; notice?: string } | null
  const from = state?.from ?? '/'

  if (status === 'authed') return <Navigate to={from} replace />

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    setRequestId('')
    try {
      await login(username, password)
      navigate(from, { replace: true })
    } catch (err) {
      setError(errorText(err))
      setRequestId(requestIdOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card auth-card">
      <h1>登录</h1>

      {state?.notice && <p className="notice">{state.notice}</p>}

      {/* 被 RequireAuth 或详情页的「认领」送到这里时，人不知道自己为什么换了页面。
          from 不是首页就说明是被某一步操作带上来的，那一步正是原因 ——
          顺带告诉他登录后会回去，不用自己再翻一遍那篇帖子。 */}
      {!state?.notice && from !== '/' && (
        <p className="muted">这一步要先登录才能继续。登录完会带你回刚才那一页，不用自己再找一遍。</p>
      )}

      <form onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="username">用户名</label>
          <input
            id="username"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="password">密码</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {error && (
          <p className="alert" role="alert">
            {error}
            {requestId && <span className="req-id">（请求编号 {requestId}）</span>}
          </p>
        )}

        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>

      <p className="muted">
        还没有账号？<Link to="/register">去注册</Link>
      </p>
    </section>
  )
}
