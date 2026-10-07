// src/App.tsx —— 页面外壳 + 路由表。
//
// 路由表就是里程碑的进度表： '/'、'/login'、'/register'、'/me' 已经通，
// 后面每一片往里加，没做的不放链接（放着就是死链）。
import { Link, Route, Routes } from 'react-router-dom'
import { RequireAuth } from './auth/RequireAuth'
import { useAuth } from './auth/AuthContext'
import LoginPage from './pages/LoginPage'
import MePage from './pages/MePage'
import PlazaPage from './pages/PlazaPage'
import PostFormPage from './pages/PostFormPage'
import PostResultPage from './pages/PostResultPage'
import RegisterPage from './pages/RegisterPage'
import ItemDetailPage from './pages/ItemDetailPage'

export default function App() {
  const { status, user, logout } = useAuth()

  return (
    <div className="app">
      <header className="app-header">
        <Link to="/" className="brand">
          失物招领
        </Link>
        <nav className="nav">
          <Link to="/">广场</Link>
          <Link to="/post">发布</Link>
          <Link to="/me">我的</Link>
          {status === 'authed' ? (
            <span className="who">
              {user?.nickname}
              <button className="link-btn" type="button" onClick={logout}>
                退出
              </button>
            </span>
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
          <Route
            path="/me"
            element={
              <RequireAuth>
                <MePage />
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
