// src/api/client.ts —— axios 实例 + §8 信封的唯一解包点。
//
// 计划 §M7 第一条约定：**axios 拦截器统一解信封，业务代码只按 code 分支，不碰 message 文本**。
// 落实在这里，意思是三件事：
//   1. 成功路径上，调用方拿到的是 data 本身，不是 AxiosResponse，也不用自己看 code；
//   2. 失败路径上一律抛 ApiError，带上后端的 code / http_status / request_id / 字段级错误；
//   3. 任何一处业务代码都不需要再写 `if (res.data.code === 'OK')`。
//
// request_id 必须留在错误对象上：后端 apperr 的设计是「报错时带上它，我们拿它去日志里捞链路」，
// 前端把它吞掉就等于废掉 §9 那套可 debug 机制的一半。
import axios, { type AxiosInstance } from 'axios'
import { Code, NETWORK_ERROR } from './codes'
import { clearToken, getToken } from './session'
import type { Envelope, FieldError } from './types'

export class ApiError extends Error {
  readonly code: string
  readonly httpStatus: number
  readonly requestId: string
  readonly fieldErrors: FieldError[]

  constructor(init: {
    code: string
    message: string
    httpStatus?: number
    requestId?: string
    fieldErrors?: FieldError[]
  }) {
    super(init.message)
    this.name = 'ApiError'
    this.code = init.code
    this.httpStatus = init.httpStatus ?? 0
    this.requestId = init.requestId ?? ''
    this.fieldErrors = init.fieldErrors ?? []
  }

  /** 后端把字段级错误放在 data.errors 里（apperr.Fail），页面可以按字段显示。 */
  errorFor(field: string): string | undefined {
    return this.fieldErrors.find((e) => e.field === field)?.msg
  }
}

function isEnvelope(body: unknown): body is Envelope<unknown> {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as Envelope<unknown>).code === 'string' &&
    'request_id' in body
  )
}

// 401/403(封号) 之外不动登录态：FORBIDDEN 是「权限不够」，人和 token 都还是好的，
// 清掉会让人莫名被踢去登录页，而他重新登录回来还是 FORBIDDEN。
const DEAD_SESSION_CODES: string[] = [Code.UNAUTHORIZED, Code.USER_BANNED]

/**
 * 造一个绑定到指定后端的实例。
 * 抽成函数而不是只导出一个单例，是为了让 contract.live.test.ts 能指向真实 8080，
 * 而应用代码用相对路径走 Vite proxy —— 两者共用同一套解包逻辑，测试测的就是线上那份代码。
 */
export function createHttp(baseURL: string): AxiosInstance {
  const inst = axios.create({ baseURL, timeout: 15000 })

  inst.interceptors.request.use((config) => {
    const token = getToken()
    // 后端 middleware/jwt.go 只认 `Bearer <token>`（scheme 大小写不敏感），
    // 前缀写错不会报错，只会让人以为「我登录了但接口说我没登录」。
    if (token) config.headers.Authorization = `Bearer ${token}`
    return config
  })

  inst.interceptors.response.use(
    (response) => {
      if (!isEnvelope(response.data)) return response

      const env = response.data
      // 后端约定所有成功都是 HTTP 200 + code=OK。2xx 上出现非 OK 只可能是装配错位，
      // 这里必须抛而不是静默返回，否则会表现成「请求成功了但 data 是 undefined」。
      if (env.code !== Code.OK) {
        throw toApiError(env, response.status)
      }
      response.data = env.data
      return response
    },
    (error: unknown) => {
      if (!axios.isAxiosError(error)) throw error

      const status = error.response?.status ?? 0
      const body = error.response?.data
      if (isEnvelope(body)) {
        throw toApiError(body, status)
      }

      // 没有信封 = 请求根本没被后端处理：后端没起、proxy 目标端口写错、或者超时。
      // 这种错最容易看起来像「产品 bug」，所以文案直接把排查方向写进去。
      throw new ApiError({
        code: NETWORK_ERROR,
        httpStatus: status,
        message: '连不上服务器。请确认后端已启动（cd backend && go run ./cmd/server），且 http://localhost:8080/api/health 能通。',
      })
    },
  )

  return inst
}

function toApiError(env: Envelope<unknown>, httpStatus: number): ApiError {
  const errors = (env.data as { errors?: FieldError[] } | null)?.errors
  if (DEAD_SESSION_CODES.includes(env.code)) clearToken()
  return new ApiError({
    code: env.code,
    message: env.message,
    httpStatus,
    requestId: env.request_id,
    fieldErrors: Array.isArray(errors) ? errors : [],
  })
}

export const http = createHttp(import.meta.env.VITE_API_BASE ?? '/')

// ---- 四个动词的薄封装：只负责把 data 泛型带上，不做任何业务。 ----

export async function getJSON<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  return (await http.get<T>(url, { params })).data
}

export async function postJSON<T>(url: string, body?: unknown): Promise<T> {
  return (await http.post<T>(url, body)).data
}

export async function putJSON<T>(url: string, body?: unknown): Promise<T> {
  return (await http.put<T>(url, body)).data
}

export async function deleteJSON<T>(url: string, body?: unknown): Promise<T> {
  return (await http.delete<T>(url, { data: body })).data
}

export async function patchJSON<T>(url: string, body?: unknown): Promise<T> {
  return (await http.patch<T>(url, body)).data
}
