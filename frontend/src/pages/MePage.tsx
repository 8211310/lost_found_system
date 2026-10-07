// src/pages/MePage.tsx —— 片 1 的受保护页，同时是守卫的验收点。
//
// 「我的」真正的内容（发布 / 归还确认 / 通知 / 积分）在片 4 做，这一版只显示 #3
// GET /api/auth/me 已经返回的字段 + 退出登录。之所以现在就要有这么一页：
// RequireAuth 需要一个真实的落点，否则「刷新不掉登录态」这条判据没法在浏览器里看。
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'

export default function MePage() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  if (!user) return null

  function onLogout() {
    logout()
    navigate('/')
  }

  return (
    <section className="card">
      <h1>我的</h1>

      <dl className="kv">
        <dt>昵称</dt>
        <dd>{user.nickname}</dd>
        <dt>用户名</dt>
        <dd>{user.username}</dd>
        <dt>身份来源</dt>
        <dd>{user.auth_source === 'local' ? '本地账号密码' : user.auth_source}</dd>
        <dt>信用分</dt>
        <dd>{user.credit_score}</dd>
        <dt>注册时间</dt>
        <dd>{user.created_at}</dd>
      </dl>

      <button className="btn" type="button" onClick={onLogout}>
        退出登录
      </button>
    </section>
  )
}
