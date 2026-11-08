/**
 * 把一大块 DOM 工作拆成「每帧一小批」时用的两个让出主线程的小工具（笔记渐进渲染、Word 逐页显示共用）。
 */

/** 让出主线程一拍（宏任务）：期间浏览器可以处理输入、画帧 */
export const yieldToMain = (): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, 0))

/**
 * 等浏览器画完一帧之后的下一个任务：挂一批 DOM → 让出 → 下一批，这样每一帧的样式 / 布局只带一批的量，
 * 而不是把几批叠在同一帧里。后台标签页 rAF 不触发，兜底的定时器保证最终会走完。
 */
export function afterNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
    }
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(() => window.setTimeout(done, 0))
    window.setTimeout(done, 250)
  })
}

/** 自适应批量：按上一批实测的帧耗时放大 / 缩小下一批的量（慢机器 / 4× 降速下自动变小，快机器变大） */
export function adaptBatch(current: number, frameMs: number, bounds: { min: number; max: number; slowMs: number; fastMs: number }): number {
  if (frameMs > bounds.slowMs) return Math.max(bounds.min, Math.floor(current * 0.6))
  if (frameMs < bounds.fastMs) return Math.min(bounds.max, Math.ceil(current * 1.25))
  return current
}
