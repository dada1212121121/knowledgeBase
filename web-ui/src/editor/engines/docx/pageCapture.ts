/**
 * 逐页取整页位图所需的纯逻辑（打印 / `rasterizeDisplayListPages` 的对应物）。
 *
 * 为什么不用上游的 `createWorkerPrintCapture`：它要挂在会话的帧消费者集合上，而我们会话层只有一个帧监听槽，
 * 多挂一个会顶掉屏幕渲染自己的监听。改用「隔离的只读临时会话 + 空壳画布」：引擎本来就会把页面位图画到
 * `canvasForPage` 给的画布上，直接读那块画布即可，不碰帧分发，也不会在用户打印时去改他正在看的页窗口。
 *
 * 这里只放与 WASM 无关、能在 jsdom 里测的部分：等一个条件成立（超时 / 取消 / 轮询）、判断页画布是否已被引擎画过。
 */

/** 引擎画一页之前，浏览器新建画布的默认尺寸；被引擎改成页面位图尺寸，就说明这页画上了 */
export const DEFAULT_CANVAS = { width: 300, height: 150 } as const

/** 这块画布是不是已经被引擎画过：尺寸不再是浏览器默认值。引擎在 drawImage 之前同步设置尺寸，之后同一任务内完成绘制 */
export function isPagePainted(canvas: { width: number; height: number }): boolean {
  return canvas.width !== DEFAULT_CANVAS.width || canvas.height !== DEFAULT_CANVAS.height
}

export class CaptureTimeout extends Error {
  constructor(what: string, ms: number) {
    super(`${what}在 ${Math.round(ms / 1000)} 秒内没有完成`)
    this.name = 'CaptureTimeout'
  }
}

export class CaptureAborted extends Error {
  constructor() {
    super('已取消')
    this.name = 'CaptureAborted'
  }
}

/**
 * 轮询直到 `predicate` 为真。超时抛 `CaptureTimeout`（带上"在等什么"，报错时能说清卡在哪一页），
 * 信号中止抛 `CaptureAborted`。轮询间隔取小值：条件通常在几十毫秒内成立，等得太久会把 20 页的总时间拉长。
 */
export async function waitUntil(
  predicate: () => boolean,
  options: { what: string; timeoutMs: number; signal?: AbortSignal; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<void> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? (() => Date.now())
  const interval = options.intervalMs ?? 25
  const deadline = now() + options.timeoutMs
  for (;;) {
    if (options.signal?.aborted) throw new CaptureAborted()
    if (predicate()) return
    if (now() >= deadline) throw new CaptureTimeout(options.what, options.timeoutMs)
    await sleep(interval)
  }
}

export interface CapturedPage {
  /** 页序号（从 0 起） */
  index: number
  width: number
  height: number
  /** PNG data URL，可直接作为 <img src> */
  dataUrl: string
}
