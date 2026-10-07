// src/api/session.ts —— JWT 的存放处，也是「登录态变了」这件事的唯一通知源。
//
// 为什么放在 localStorage 而不是内存：后端 token 有效期是 JWT_EXPIRE_HOURS（默认 24h），
// 刷新页面不掉登录态是这一片验收判据之一，存内存就做不到。
//
// 为什么需要一个 listeners 集合：清 token 的动作发生在 axios 拦截器里（拿到 401 就清），
// 而拦截器在 React 树外面，它没法 setState。没有这个订阅，就会出现
// 「token 已经被清了，但页面上的用户名还挂着、还能停在受保护路由」这种错位。
const TOKEN_KEY = 'lostfound.token'

interface KeyValue {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  clear(): void
}

// 内存兜底。真实浏览器里走不到这条分支，它存在的原因只有一个：
// Node 22+ 自带的 experimental Web Storage 会在 Vitest(jsdom) 里接管 window.localStorage，
// 而 --localstorage-file 没给有效路径时，拿到的是个 getItem/setItem/clear 全是 undefined 的空壳
// （本机实测：Node v25.2.1 + jsdom 29 + vitest 4.1.11，报 "localStorage.setItem is not a function"）。
// 判据用「方法在不在」而不是「对象在不在」，因为那个空壳的对象是存在的 —— 只判存在会一路放行到第一次写入才炸。
const memoryStore = new Map<string, string>()
const inMemory: KeyValue = {
  getItem: (k) => memoryStore.get(k) ?? null,
  setItem: (k, v) => {
    memoryStore.set(k, v)
  },
  removeItem: (k) => {
    memoryStore.delete(k)
  },
  clear: () => {
    memoryStore.clear()
  },
}

function pickStorage(): KeyValue {
  try {
    const s = (globalThis as { localStorage?: KeyValue }).localStorage
    if (s && typeof s.setItem === 'function' && typeof s.getItem === 'function') return s
  } catch {
    // 某些嵌入式 webview 里读 localStorage 属性本身就抛 SecurityError，同样退回内存
  }
  return inMemory
}

const storage = pickStorage()

type Listener = () => void
const listeners = new Set<Listener>()

export function getToken(): string | null {
  return storage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  storage.setItem(TOKEN_KEY, token)
  emit()
}

export function clearToken(): void {
  storage.removeItem(TOKEN_KEY)
  emit()
}

/** 订阅登录态变化，返回取消订阅的函数。 */
export function onSessionChange(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function emit(): void {
  for (const fn of listeners) fn()
}
