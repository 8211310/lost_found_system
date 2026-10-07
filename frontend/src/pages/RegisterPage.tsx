// src/pages/RegisterPage.tsx —— #1 POST /api/auth/register
//
// 注册成功后**不做自动登录**：#1 的 data 只有 {id, username, nickname, role}，后端刻意
// 不返回 token（handler/auth.go 的 registerResp 注释写了这条决定），所以只能把人送去登录页。
// 这里不做任何密码强度校验 —— 弱密码是后端 #1 的 WEAK_PASSWORD 负责判的，
// 前端加一套正则就会出现「前端说行、后端说不行」或反过来的错位，和 contact 那条同理。
import { useNavigate, Link } from 'react-router-dom'
import { useState, type FormEvent } from 'react'
import { register } from '../api/auth'
import { errorText, requestIdOf } from '../api/errorText'

export default function RegisterPage() {
  const navigate = useNavigate()

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [nickname, setNickname] = useState('')
  const [error, setError] = useState('')
  const [requestId, setRequestId] = useState('')
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    setRequestId('')
    try {
      await register({ username, password, nickname: nickname || undefined })
      navigate('/login', {
        state: { notice: `注册成功，请用「${username}」登录。失物招领需要知道你是谁，才能把匹配结果通知到你。` },
      })
    } catch (err) {
      setError(errorText(err))
      setRequestId(requestIdOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card auth-card">
      <h1>注册</h1>

      <form onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="username">用户名（登录用，之后不能改）</label>
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
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="hint">至少 8 位，且不能是纯数字。</p>
        </div>

        <div className="field">
          <label htmlFor="nickname">昵称（选填，显示在帖子上）</label>
          <input
            id="nickname"
            name="nickname"
            autoComplete="nickname"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
          />
        </div>

        {error && (
          <p className="alert" role="alert">
            {error}
            {requestId && <span className="req-id">（请求编号 {requestId}）</span>}
          </p>
        )}

        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? '提交中…' : '注册'}
        </button>
      </form>

      <p className="muted">
        已经有账号了？<Link to="/login">去登录</Link>
      </p>
    </section>
  )
}
