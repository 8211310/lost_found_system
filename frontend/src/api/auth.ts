// src/api/auth.ts —— §4 的 #1–#5（M1 认证）。
//
// 这一层薄到只有 URL 和类型：判断「密码够不够强」住在后端 service，
// 前端只负责把后端返回的 code 翻译成人话（见 pages/LoginPage.tsx 的文案表）。
import { getJSON, postJSON, putJSON } from './client'
import type { LoginResult, RegisterResult, UserView } from './types'

export interface RegisterInput {
  username: string
  password: string
  nickname?: string
}

export interface UpdateProfileInput {
  nickname?: string
  phone?: string
  email?: string
}

export interface ChangePasswordInput {
  old_password: string
  new_password: string
}

/** #1 POST /api/auth/register（公开）。注意返回里没有 token。 */
export function register(input: RegisterInput): Promise<RegisterResult> {
  return postJSON<RegisterResult>('/api/auth/register', input)
}

/** #2 POST /api/auth/login（公开） */
export function login(username: string, password: string): Promise<LoginResult> {
  return postJSON<LoginResult>('/api/auth/login', { username, password })
}

/** #3 GET /api/auth/me（JWT）—— 刷新页面后恢复登录态靠它，不靠解 JWT。 */
export function me(): Promise<UserView> {
  return getJSON<UserView>('/api/auth/me')
}

/** #4 PUT /api/auth/me（JWT）。三个字段都是「不传就保持原值」，所以调用方只提交改动过的。 */
export function updateMe(input: UpdateProfileInput): Promise<UserView> {
  return putJSON<UserView>('/api/auth/me', input)
}

/** #5 POST /api/auth/change-password（JWT，仅本地用户）。成功时 data 是 null。 */
export function changePassword(input: ChangePasswordInput): Promise<null> {
  return postJSON<null>('/api/auth/change-password', input)
}
