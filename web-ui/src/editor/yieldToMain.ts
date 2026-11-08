/**
 * 让出主线程（打开文档时把一长串同步工作切成几个任务）
 *
 * 为什么不用 `await nextTick` / `Promise.resolve`：这些是微任务，浏览器不会在它们之间处理输入、画帧，
 * 前后的工作仍然算同一个长任务。这里要的是真正的宏任务边界。
 * 优先 `scheduler.yield`（让出后续接回来时优先级高于其它排队任务，不会被后台工作饿住）；
 * 没有时用 MessageChannel（不像 setTimeout 那样嵌套几层后被钳到 4 ms）；再没有就 setTimeout。
 */
export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  if (typeof scheduler?.yield === 'function') return scheduler.yield()
  if (typeof MessageChannel === 'undefined') return new Promise((resolve) => setTimeout(resolve, 0))
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(0)
  })
}
