/**
 * 缩略图 / 邻页预渲染的空闲调度
 *
 * 要求：缩略图后台生成，不能让当前页卡住。做法：
 * - 一次只做一项，两项之间让出线程（setTimeout 0），输入事件和当前页重绘能插进来；
 * - 当前页正在画时 `pause`，画完 `resume`；
 * - 任务顺序由调用方给（离当前页近的先画），换页时 `setOrder` 重排，已完成的不重复做。
 */

export interface IdleQueueOptions<K> {
  /** 实际干活的函数；抛错的那一项记为失败并跳过，不卡住后面的 */
  run(key: K): void | Promise<void>
  /** 让出线程的方式；测试里换成同步或假定时器 */
  yieldFn?: (fn: () => void) => () => void
  onError?(key: K, error: unknown): void
}

export class IdleQueue<K = number> {
  private pending: K[] = []
  private done = new Set<K>()
  private paused = false
  private running = false
  private cancelYield: (() => void) | null = null
  private disposed = false
  private readonly yieldFn: (fn: () => void) => () => void

  constructor(private readonly options: IdleQueueOptions<K>) {
    this.yieldFn =
      options.yieldFn ??
      ((fn) => {
        const id = setTimeout(fn, 0)
        return () => clearTimeout(id)
      })
  }

  /** 设置待办顺序（已完成的会被过滤掉）；正在跑的那一项不受影响 */
  setOrder(keys: readonly K[]): void {
    const seen = new Set<K>()
    this.pending = keys.filter((key) => {
      if (this.done.has(key) || seen.has(key)) return false
      seen.add(key)
      return true
    })
    this.kick()
  }

  /** 内容变了：这些项要重新做 */
  invalidate(keys?: readonly K[]): void {
    if (!keys) this.done.clear()
    else for (const key of keys) this.done.delete(key)
  }

  isDone(key: K): boolean {
    return this.done.has(key)
  }

  get size(): number {
    return this.pending.length
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    this.kick()
  }

  dispose(): void {
    this.disposed = true
    this.pending = []
    this.cancelYield?.()
    this.cancelYield = null
  }

  private kick(): void {
    if (this.disposed || this.paused || this.running || this.cancelYield || !this.pending.length) return
    this.cancelYield = this.yieldFn(() => {
      this.cancelYield = null
      void this.step()
    })
  }

  private async step(): Promise<void> {
    if (this.disposed || this.paused || this.running) return
    if (!this.pending.length) return
    const key = this.pending.shift() as K
    this.running = true
    try {
      await this.options.run(key)
      this.done.add(key)
    } catch (error) {
      // 画不出来的页不重试（重试只会重复失败），记下来继续后面的
      this.done.add(key)
      this.options.onError?.(key, error)
    } finally {
      this.running = false
    }
    this.kick()
  }
}

/** 离 `center` 近的先做：center, center+1, center-1, center+2 … 的顺序 */
export function nearestFirst(count: number, center: number): number[] {
  const order: number[] = []
  const clamped = Math.min(Math.max(0, center), Math.max(0, count - 1))
  for (let step = 0; order.length < count; step += 1) {
    const after = clamped + step
    const before = clamped - step
    if (after < count) order.push(after)
    if (step > 0 && before >= 0) order.push(before)
    if (after >= count && before < 0) break
  }
  return order
}
