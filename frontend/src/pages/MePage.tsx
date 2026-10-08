// src/pages/MePage.tsx —— 「我的」首页：身份来自 #3，五条入口，一个退出。
//
// 这一页自己不请求任何东西。这不是省一次调用，而是**身份只有一个来源**：
// 顶栏和这里都读 AuthContext 里那份由 #3 填进来的 user，所以两处的 role / credit_score
// 一定同时变、也一定和后端一致（后端每个请求都重读库，封号和降权即时生效）。
// 这里再发一次 #3，就会有两个可能不同步的「我是谁」。
//
// 入口只放已经存在的页面：计划 §M7 的纪律是「没做的不放链接，放着就是死链」。
// 片 5 之后归还确认（#28/#29）和通知中心（#30–#32）都在了，所以这两条现在敢挂上来 ——
// 通知里那些带 return_id 的条目点得开了，这是它们必须同一片做的原因。
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { localMinute } from '../lib/time'

export default function MePage() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  // 匿名到不了这一页（RequireAuth 挡着），但 #3 还没回来的那几百毫秒 user 也是空的：
  // 守卫在那段时间原地等待而不是闪一下登录页，所以等待的样子也得在这里给出来。
  if (!user) return <p className="muted">正在确认身份…</p>

  function onLogout() {
    logout()
    navigate('/')
  }

  return (
    <>
      <section className="card">
        <h1>{user.nickname}</h1>

        <dl className="kv">
          <dt>用户名</dt>
          <dd>{user.username}</dd>
          <dt>身份来源</dt>
          <dd>{user.auth_source === 'local' ? '本地账号密码' : '杭电助手'}</dd>
          <dt>当前信用分</dt>
          <dd>{user.credit_score}</dd>
          <dt>注册时间</dt>
          <dd>{localMinute(user.created_at)}</dd>
        </dl>

        {user.role === 'admin' && (
          <p className="hint">
            这个账号是管理员，但管理后台还没做，所以这里只有普通用户的那几项 ——
            没有入口不等于没有权限，权限本身是后端在每个请求上现读的。
          </p>
        )}

        <button className="btn" type="button" onClick={onLogout}>
          退出登录
        </button>
      </section>

      <nav className="card me-entries" aria-label="我的那一族">
        <h2>我的</h2>
        <ul className="entry-list">
          <li>
            <Link to="/me/posts">我的发布</Link>
            <span className="muted">包括已归还的、已下架的，以及「为什么不见了」那句话。</span>
          </li>
          <li>
            <Link to="/me/returns">归还确认</Link>
            <span className="muted">谁向我提交过一次归还、我提交给过谁，一次一条记着。</span>
          </li>
          <li>
            <Link to="/me/notifications">通知</Link>
            <span className="muted">发生过一件事的记录。标成已读之后不能再变回未读。</span>
          </li>
          <li>
            <Link to="/me/credit">积分流水</Link>
            <span className="muted">当前分数和它的来龙去脉，一条一分记着。</span>
          </li>
          <li>
            <Link to="/me/settings">账号设置</Link>
            <span className="muted">改昵称、留联系方式，本地账号还能改密码。</span>
          </li>
        </ul>
      </nav>
    </>
  )
}
