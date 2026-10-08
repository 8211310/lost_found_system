// src/api/unreadBus.ts —— 「未读数可能变了」这一个信号。
//
// 为什么需要它：导航栏那个数（#31）是读出来的，不是推过来的，而读它的组件挂在 App 上、
// 改它的动作发生在 NotificationsPage 里 —— 两处在 React 树上没有共同的 state，
// 标完已读若不传这个信号，徽标会继续显示标之前的数，直到下一次换页才追上。
// 一个刚被自己清零的收件箱配一个没清零的徽标，比徽标慢半拍更让人怀疑系统是不是坏了。
//
// 为什么不用 sessionStorage 的 storage 事件：那只对不同标签页有效，同页内的写入不触发。
type Listener = () => void
const listeners = new Set<Listener>()

/** 订阅后返回取消订阅的函数；和 session.ts 的 onSessionChange 同一个形状。 */
export function onUnreadCountChanged(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** 任何让未读数发生变化的操作成功后调用。变化的来源只有 #32 那一条 PUT，
 *  但页面上有两条路会打到它：按「标为已读」，和点开一条未读通知的落点。 */
export function notifyUnreadCountChanged(): void {
  for (const fn of [...listeners]) fn()
}
