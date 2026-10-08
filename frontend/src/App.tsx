// src/App.tsx —— 页面外壳 + 路由表。
//
// 路由表就是里程碑的进度表：广场、详情、发帖改帖删帖、「我的」那一族四页、
// 归还确认流（详情/两个列表/提交）、通知中心、管理后台（一页五个页签）已经通，
// 后面每一片往里加，没做的不放链接（放着就是死链）。
import { Link, Route, Routes, useLocation } from 'react-router-dom'
import { RequireAuth } from './auth/RequireAuth'
import { RequireAdmin } from './auth/RequireAdmin'
import { useAuth } from './auth/AuthContext'
import { getUnreadCount } from './api/notifications'
import { onUnreadCountChanged } from './api/unreadBus'
import LoginPage from './pages/LoginPage'
import MePage from './pages/MePage'
import PlazaPage from './pages/PlazaPage'
import PostFormPage from './pages/PostFormPage'
import PostResultPage from './pages/PostResultPage'
import RegisterPage from './pages/RegisterPage'
import ItemDetailPage from './pages/ItemDetailPage'
import MyPostsPage from './pages/MyPostsPage'
import ContactViewsPage from './pages/ContactViewsPage'
import CreditLogsPage from './pages/CreditLogsPage'
import SettingsPage from './pages/SettingsPage'
import MyReturnsPage from './pages/MyReturnsPage'
import ReturnDetailPage from './pages/ReturnDetailPage'
import ClaimItemPage from './pages/ClaimItemPage'
import NotificationsPage from './pages/NotificationsPage'
import AdminPage from './pages/admin/AdminPage'
import { useEffect, useState } from 'react'

/** 导航栏上那个未读数（#31）。
 *
 * 为什么在每次换页时重读一次：这套系统没有推送（不做站内私信、不做长连接是定稿的边界），
 * 所以「有没有新通知」只能靠读。标完已读、确认完归还之后回到别的页面，人期望那个数字是新的。
 * 代价是每换一页多一条 #31 —— 它就是一条走 idx_notifications_user 的 count，
 * 后端特意把未读数和收件箱做成两条端点，正是为了让这种高频读便宜。
 * ⚠ 读失败时显示的是「通知」而不是「通知 0」：拿不到数字和数字是 0 是两件事。
 * 除换页之外还订阅 unreadBus 那一个信号：人站在收件箱里把未读清零时 pathname 没变，
 * 只靠换页的话，他刚做完的事和顶上那个数会当场对不上。 */
function NavNotifications() {
  const location = useLocation()
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    let dead = false
    const read = () =>
      getUnreadCount()
        .then((res) => {
          if (!dead) setCount(res.count)
        })
        .catch(() => {
          if (!dead) setCount(null)
        })
    read()
    // 换页读一次之外还要订阅这个信号：标完已读时人正站在收件箱里， pathname 没变，
    // 只靠换页的话徽标会一直挂着那个刚刚被自己清零的数。
    const off = onUnreadCountChanged(read)
    return () => {
      dead = true
      off()
    }
  }, [location.pathname])

  return (
    <Link to="/me/notifications">
      {/* 「通知」和数字之间必须有一个真正的空格：写成 通知{count} 时无障碍树里读出来是「通知3」，
          读屏软件会把两个字粘成一个词。没数字时尾部那个空格会被归一化掉，名字就还是「通知」。 */}
      通知 {count ? <span className="badge">{count > 99 ? '99+' : count}</span> : null}
    </Link>
  )
}


export default function App() {
  const { status, user, logout } = useAuth()

  return (
    <div className="app">
      <header className="app-header">
        <Link to="/" className="brand">
          失物招领
        </Link>
        {/* 这一页之外还有 MePage 那个 <nav aria-label="我的那一族">：两个 nav 不加名字时，
            读屏念「导航」人不知道自己在哪一块，测试也只能靠顺序猜。 */}
        <nav className="nav" aria-label="主导航">
          <Link to="/">广场</Link>
          <Link to="/post">发布</Link>
          <Link to="/me">我的</Link>
          {status === 'authed' ? (
            <>
              {/* 通知入口只给登录的人看：#30 的收件人取自 JWT，匿名点进去只会先被守卫弹回登录页，
                  而那一下弹回会让人以为是自己点错了。 */}
              <NavNotifications />
              {/* 后台入口只给 role=admin 的人看。判据取自 #3 而不是手里的 token（token 里没有 role），
                  所以刚提权的人刷新一次就会出现，被降权的人刷新一次就消失。
                  这一条只是少给一个必然 403 的链接，真正的门在后端那个 admin 组上。 */}
              {user?.role === 'admin' && <Link to="/admin">管理</Link>}
              <span className="who">
                {user?.nickname}
                <button className="link-btn" type="button" onClick={logout}>
                  退出
                </button>
              </span>
            </>
          ) : (
            <Link to="/login">登录</Link>
          )}
        </nav>
      </header>

      <main className="app-main">
        <Routes>
          <Route path="/" element={<PlazaPage />} />
          {/* :id 这个名字和后端 #15 的路径参数保持一致：
              调试时对着浏览器地址栏和后端日志，两边同一个名字省掉一次换算。 */}
          <Route path="/items/:id" element={<ItemDetailPage />} />
          {/* 三条都要登录：#13 是写操作，#16 只认本人，成功页的数据本身就是登录之后才可能有的。
              /items/:id/edit 放在 /items/:id 之后不影响匹配 —— 路由是按具体性而不是顺序来的，
              但顺序读起来和 §4 的编号一致，省一次回头找。 */}
          <Route
            path="/post"
            element={
              <RequireAuth>
                <PostFormPage />
              </RequireAuth>
            }
          />
          <Route
            path="/post/done/:id"
            element={
              <RequireAuth>
                <PostResultPage />
              </RequireAuth>
            }
          />
          <Route
            path="/items/:id/edit"
            element={
              <RequireAuth>
                <PostFormPage />
              </RequireAuth>
            }
          />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          {/* 「我的」那一族四页全要登录：#19 #33 的收件人来自 JWT，#4 #5 改的是凭据本身。
              /items/:id/unlockers 也在这里 —— 名单里是别人的真实姓名，
              后端 #22 的鉴权列写的就是「发帖人本人或 admin」，匿名连请求都不该发出去。 */}
          <Route
            path="/me"
            element={
              <RequireAuth>
                <MePage />
              </RequireAuth>
            }
          />
          <Route
            path="/me/posts"
            element={
              <RequireAuth>
                <MyPostsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/me/credit"
            element={
              <RequireAuth>
                <CreditLogsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/me/settings"
            element={
              <RequireAuth>
                <SettingsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/items/:id/unlockers"
            element={
              <RequireAuth>
                <ContactViewsPage />
              </RequireAuth>
            }
          />

          {/* 片 5：归还确认流 + 通知中心。四条全要登录 ——
              #23 是写操作，#24 的读者是提交人/发帖人/admin（匿名连读都读不到），
              #28/#29 的收件人取自 JWT，#30/#31/#32 更是只有「你」这一个视角。 */}
          <Route
            path="/items/:id/claim"
            element={
              <RequireAuth>
                <ClaimItemPage />
              </RequireAuth>
            }
          />
          <Route
            path="/returns/:id"
            element={
              <RequireAuth>
                <ReturnDetailPage />
              </RequireAuth>
            }
          />
          <Route
            path="/me/returns"
            element={
              <RequireAuth>
                <MyReturnsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/me/notifications"
            element={
              <RequireAuth>
                <NotificationsPage />
              </RequireAuth>
            }
          />

          {/* 片 6：管理后台。两道门是故意的，各管一种失误 ——
              RequireAuth 挡「匿名连请求都不该发」，RequireAdmin 挡「非 admin 进来只会看到五个 403」。
              真正的权限判定在后端 router.go 那个 admin 组里（role 每请求回库重读一次）。 */}
          <Route
            path="/admin"
            element={
              <RequireAuth>
                <RequireAdmin>
                  <AdminPage />
                </RequireAdmin>
              </RequireAuth>
            }
          />
          <Route
            path="*"
            element={
              <section className="card">
                <h1>页面不存在</h1>
                <p className="muted">
                  检查地址，或者回<Link to="/">广场</Link>。
                </p>
              </section>
            }
          />
        </Routes>
      </main>
    </div>
  )
}
