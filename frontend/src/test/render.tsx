// src/test/render.tsx —— 把组件放进真实的装配环境里测。
//
// 为什么不裸 render：这一片要验的三件事（守卫跳转、登录成功后回原位、注册后跳登录页）
// 全都依赖 Router 和 AuthProvider；裸 render 里 useNavigate/useAuth 会直接抛，
// 测试就只能退化成「断言一段文案存在」，那测不到任何行为。
import { render } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { ReactElement } from 'react'
import { AuthProvider } from '../auth/AuthContext'

/**
 * @param at    进入时的地址
 * @param state 挂在该地址上的 location.state —— RequireAuth 写进去的 from 就靠它复现
 */
export function renderWithAuth(ui: ReactElement, at = '/', state?: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: at, state }]}>
      <AuthProvider>{ui}</AuthProvider>
    </MemoryRouter>,
  )
}

/** 带路由表的渲染，给详情页和广场用。
 *
 *  为什么不能直接 render 组件：这两页都靠 useParams / useSearchParams / Link 的目标地址，
 *  没有 Routes 的话 useParams() 是 undefined，页面会渲染成「没有这条帖子」，
 *  而那个假象和真实的 NOT_FOUND 长得一模一样 —— 测试会绿，代码是坏的。
 *
 *  /login 和 /items/:id 放的是桩而不是真页面：这里要验的是**跳去了哪儿**，
 *  把 LoginPage 装进来只会让它自己的请求 mock 掺进这个测试的 mock 里，
 *  红了以后分不清是谁发的请求。 */
export function renderRouted(path: string, element: ReactElement, at = '/') {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <AuthProvider>
        <Routes>
          <Route path={path} element={element} />
          <Route path="/login" element={<p>登录页桩</p>} />
          <Route path="/" element={<p>广场页桩</p>} />
          {/* 这两条是别的页面的落点，桩就够用了：#23 提交成功后跳 /returns/:id，
              而 /items/:id/claim 自己也要能跳回帖子详情。
              装真页面只会把它们的请求掺进这个测试的 mock 里。 */}
          <Route path="/items/:id" element={<p>详情页桩</p>} />
          <Route path="/returns/:id" element={<p>归还详情桩</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}
