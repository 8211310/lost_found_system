// src/test/setup.ts —— 每个测试文件跑之前的全局设置。
import '@testing-library/jest-dom/vitest'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { cleanup } from '@testing-library/react'
import { server } from './server'
import { clearToken } from '../api/session'

// onUnhandledRequest: 'error' 是这里最关键的一行：测试少 mock 一个端点时会立刻炸，
// 而不是让请求穿透出去挂在那儿，把一个「URL 写错了」表现成一次莫名的超时。
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))

afterEach(() => {
  // 必须显式写：@testing-library/react 的自动卸载只在 globalThis.afterEach 存在时注册，
  // 而本项目没开 vitest 的 globals（配置里 import 全部显式_from 'vitest'），
  // 于是同一个文件里的第二个测试会看见上一个测试留下的 DOM，
  // 报「Found multiple elements」—— 看起来像组件渲染了两遍，其实是被上一轮的尸体污染了。
  cleanup()
  server.resetHandlers()
  // 登录态会从上一个测试漏到下一个测试，所以每个测试开始前必须是干净的。
  // 这里调 session 的公开 API 而不是直接 localStorage.clear()：
  // 后者在本机的 Node 25 + jsdom 下是个没有方法的空壳（详见 api/session.ts 的注释）。
  clearToken()
})

afterAll(() => server.close())
