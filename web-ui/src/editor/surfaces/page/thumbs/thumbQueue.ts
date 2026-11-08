/**
 * 页缩略图生成队列（补全）
 *
 * 要解决的问题：几十到几百页的文档不能一次把所有缩略图都画出来（DOM 缩略图是整页克隆，画布缩略图要引擎光栅），
 * 又必须让用户一打开侧栏就看到眼前这几张、滚到哪张就先有哪张。规则：
 *
 * 1. **可见优先**：栏里看得见的缺图 / 过期图最先做，离当前页近的先于远的；接着是可见范围上下各 `buffer` 项；
 *    最后才是后台补齐（离当前页由近及远，补到缓存上限为止，再往外的只在滚到时才做）。
 * 2. **一次只做一项、两项之间让出线程**：输入事件和主视图滚动能插进来；`minGapMs` 再给两次开工之间加一个最短间隔（节流），
 *    编辑时大批页面同时过期也不会连着占满 CPU。
 * 3. **缓存 + LRU**：做好的图留着；超过 `limit` 条时淘汰最久没被用到的，可见的不淘汰。
 * 4. **失效不闪**：`invalidate` 只标「过期」，旧图继续显示，新图画好再换；过期的可见项优先重画。
 *    渲染途中被标过期的页，这次的结果照样交付（总比空着强）但仍保持过期，随后重画。
 *
 * 队列不认识 DOM：`render` 由调用方给，产出什么（克隆的 DOM / 画布）它不关心，所以能在 jsdom 里把顺序和边界测准。
 */

export interface ThumbRange {
  first: number
  last: number
}

export interface ThumbQueueOptions<A> {
  /** 生成第 `index` 页（0 起）的缩略图；`signal` 在队列销毁或该页被丢弃时中止 */
  render(index: number, signal: AbortSignal): Promise<A>
  /** 缓存条数上限，默认 80 */
  limit?: number
  /** 可见范围外各多做几项，默认 3 */
  buffer?: number
  /** 两次开工之间的最短间隔（毫秒），默认 0 */
  minGapMs?: number
  /** 让出线程再开工；返回取消函数。默认空闲时执行（没有 requestIdleCallback 就 setTimeout） */
  yieldFn?: (run: () => void) => () => void
  now?: () => number
  /** 一张图画好了：`previous` 是它替换掉的旧图（失效重画时） */
  onReady?(index: number, artifact: A, previous: A | undefined): void
  /** 一张图被淘汰 / 随页数减少被丢弃 */
  onEvict?(index: number, artifact: A): void
  /** 画不出来的页不自动重试（重试只会重复失败），等下次失效 */
  onError?(index: number, error: unknown): void
}

/** 默认的让出方式：空闲时做，超时 120ms 兜底（页面忙时缩略图也不至于一张等几百毫秒）；不支持 requestIdleCallback（Safari）就延后一点点 */
function defaultYield(run: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(run, { timeout: 120 })
    return () => cancelIdleCallback(id)
  }
  const id = setTimeout(run, 16)
  return () => clearTimeout(id)
}

export interface PlanInput {
  count: number
  visible: ThumbRange | null
  current: number
  buffer: number
  limit: number
  /** 这一项要不要（缺图或过期） */
  needs(index: number): boolean
  /** 已经缓存且新鲜的项数（后台补齐不超过上限用） */
  cached: number
}

/**
 * 待办顺序（纯函数，测试直接断言）：可见 → 缓冲 → 后台补齐。
 * 可见项里先做当前页（在可见范围内的话）再向两侧扩；缓冲和补齐都是离锚点由近及远。
 */
export function planOrder({ count, visible, current, buffer, limit, needs, cached }: PlanInput): number[] {
  if (count <= 0) return []
  const out: number[] = []
  const seen = new Set<number>()
  const push = (index: number) => {
    if (index < 0 || index >= count || seen.has(index)) return
    seen.add(index)
    if (needs(index)) out.push(index)
  }
  const anchor = Math.min(count - 1, Math.max(0, current))
  if (visible) {
    const focus = Math.min(visible.last, Math.max(visible.first, anchor))
    const span = Math.max(focus - visible.first, visible.last - focus)
    // 可见项向两侧扩：只收可见范围内的（范围外的是下面的「缓冲」，优先级更低）
    const inView = (index: number) => index >= visible.first && index <= visible.last
    for (let step = 0; step <= span; step += 1) {
      if (inView(focus + step)) push(focus + step)
      if (step > 0 && inView(focus - step)) push(focus - step)
    }
    for (let step = 1; step <= buffer; step += 1) {
      push(visible.last + step)
      push(visible.first - step)
    }
  }
  // 后台补齐：离当前页由近及远，总量（已缓存 + 本次计划）不超过上限
  const room = Math.max(0, limit - cached)
  let added = 0
  for (let step = 0; step < count && added < room; step += 1) {
    for (const index of step === 0 ? [anchor] : [anchor + step, anchor - step]) {
      if (index < 0 || index >= count || seen.has(index)) continue
      seen.add(index)
      if (needs(index)) {
        out.push(index)
        added += 1
        if (added >= room) break
      }
    }
  }
  return out
}

export class ThumbQueue<A> {
  private readonly entries = new Map<number, A>()
  private readonly stale = new Set<number>()
  /** 每页的失效代次：渲染开始时记下，回来发现变了说明途中被标过期 */
  private readonly generation = new Map<number, number>()
  private failed = new Set<number>()
  private pending: number[] = []
  private count = 0
  private visible: ThumbRange | null = null
  private current = 0
  private paused = false
  private running: { index: number; controller: AbortController } | null = null
  private cancelYield: (() => void) | null = null
  private cancelGap: (() => void) | null = null
  private lastStart = Number.NEGATIVE_INFINITY
  private disposed = false
  /** 统计：测试 / 调试用 */
  readonly stats = { rendered: 0, aborted: 0, evicted: 0, failed: 0 }

  private readonly limit: number
  private readonly buffer: number
  private readonly minGapMs: number
  private readonly yieldFn: (run: () => void) => () => void
  private readonly now: () => number

  constructor(private readonly options: ThumbQueueOptions<A>) {
    this.limit = Math.max(1, options.limit ?? 80)
    this.buffer = Math.max(0, options.buffer ?? 3)
    this.minGapMs = Math.max(0, options.minGapMs ?? 0)
    this.yieldFn = options.yieldFn ?? defaultYield
    this.now = options.now ?? (() => Date.now())
  }

  /** 页数变了：多出去的页的缓存丢掉，新增的页进入待办 */
  setCount(count: number): void {
    const next = Math.max(0, Math.floor(count))
    if (next === this.count) return
    this.count = next
    for (const index of [...this.entries.keys()]) if (index >= next) this.drop(index)
    for (const index of [...this.stale]) if (index >= next) this.stale.delete(index)
    for (const index of [...this.failed]) if (index >= next) this.failed.delete(index)
    if (this.running && this.running.index >= next) this.abortRunning()
    this.replan()
  }

  /** 栏的可见范围与当前页（0 起）变了：重排待办，并把可见项标成最近使用（不被淘汰） */
  setView(visible: ThumbRange | null, current: number): void {
    this.visible = visible
    this.current = current
    if (visible) for (let index = visible.first; index <= visible.last; index += 1) this.touch(index)
    this.replan()
  }

  /** 这些页的内容变了：旧图保留（不闪），标过期，重画。不传 = 全部 */
  invalidate(indices?: Iterable<number>): void {
    const list = indices ? [...indices] : Array.from({ length: this.count }, (_, index) => index)
    for (const index of list) {
      if (index < 0 || index >= this.count) continue
      this.generation.set(index, (this.generation.get(index) ?? 0) + 1)
      this.failed.delete(index)
      if (this.entries.has(index) || this.running?.index === index) this.stale.add(index)
    }
    this.replan()
  }

  /** 从第 `index` 页（0 起）往后都失效：编辑一页，后面的页会随重排移动 */
  invalidateFrom(index: number): void {
    this.invalidate(Array.from({ length: Math.max(0, this.count - Math.max(0, index)) }, (_, offset) => Math.max(0, index) + offset))
  }

  get(index: number): A | undefined {
    return this.entries.get(index)
  }

  has(index: number): boolean {
    return this.entries.has(index)
  }

  isStale(index: number): boolean {
    return this.stale.has(index)
  }

  /** 当前的待办顺序（不含正在做的那一项） */
  get queued(): readonly number[] {
    return this.pending
  }

  get size(): number {
    return this.entries.size
  }

  get busy(): boolean {
    return this.running !== null
  }

  pause(): void {
    this.paused = true
    this.cancelYield?.()
    this.cancelYield = null
    this.cancelGap?.()
    this.cancelGap = null
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    this.kick()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelYield?.()
    this.cancelGap?.()
    this.cancelYield = this.cancelGap = null
    this.abortRunning()
    this.pending = []
    for (const index of [...this.entries.keys()]) this.drop(index)
    this.stale.clear()
  }

  /* ---------------- 内部 ---------------- */

  private needs = (index: number): boolean => !this.failed.has(index) && (!this.entries.has(index) || this.stale.has(index)) && this.running?.index !== index

  private replan(): void {
    if (this.disposed) return
    let fresh = 0
    for (const index of this.entries.keys()) if (!this.stale.has(index)) fresh += 1
    this.pending = planOrder({ count: this.count, visible: this.visible, current: this.current, buffer: this.buffer, limit: this.limit, needs: this.needs, cached: fresh })
    this.kick()
  }

  private touch(index: number): void {
    const artifact = this.entries.get(index)
    if (artifact === undefined) return
    // Map 保持插入顺序：删掉再放回去 = 最近使用
    this.entries.delete(index)
    this.entries.set(index, artifact)
  }

  private drop(index: number): void {
    const artifact = this.entries.get(index)
    if (artifact === undefined) return
    this.entries.delete(index)
    this.stale.delete(index)
    this.stats.evicted += 1
    this.options.onEvict?.(index, artifact)
  }

  /** 超过上限就淘汰最久没用的；可见项和正在做的不动 */
  private evict(): void {
    if (this.entries.size <= this.limit) return
    for (const index of [...this.entries.keys()]) {
      if (this.entries.size <= this.limit) break
      const shown = this.visible && index >= this.visible.first && index <= this.visible.last
      if (shown) continue
      this.drop(index)
    }
  }

  private abortRunning(): void {
    if (!this.running) return
    this.running.controller.abort()
    this.stats.aborted += 1
    this.running = null
  }

  private kick(): void {
    if (this.disposed || this.paused || this.running || this.cancelYield || this.cancelGap || !this.pending.length) return
    const wait = this.lastStart + this.minGapMs - this.now()
    if (wait > 0) {
      const id = setTimeout(() => {
        this.cancelGap = null
        this.kick()
      }, wait)
      this.cancelGap = () => clearTimeout(id)
      return
    }
    this.cancelYield = this.yieldFn(() => {
      this.cancelYield = null
      void this.step()
    })
  }

  private async step(): Promise<void> {
    if (this.disposed || this.paused || this.running) return
    const index = this.pending.shift()
    if (index === undefined) return
    if (!this.needs(index)) {
      this.kick()
      return
    }
    const controller = new AbortController()
    const started = this.generation.get(index) ?? 0
    this.running = { index, controller }
    this.lastStart = this.now()
    let artifact: A | undefined
    let error: unknown
    let failed = false
    try {
      artifact = await this.options.render(index, controller.signal)
    } catch (caught) {
      failed = true
      error = caught
    }
    const current = this.running
    const aborted = controller.signal.aborted || current?.index !== index
    if (current?.index === index) this.running = null
    if (this.disposed) {
      if (!failed && artifact !== undefined) this.options.onEvict?.(index, artifact)
      return
    }
    if (aborted) {
      if (!failed && artifact !== undefined) this.options.onEvict?.(index, artifact)
    } else if (failed) {
      // 失败发生在这页被标过期之后：多半是来源把在途的会话作废了（文档改了），不是这页本身画不出来，不记错，随后重画
      if ((this.generation.get(index) ?? 0) === started) {
        this.failed.add(index)
        this.stats.failed += 1
        this.options.onError?.(index, error)
      }
    } else if (index < this.count && artifact !== undefined) {
      const previous = this.entries.get(index)
      this.entries.set(index, artifact)
      this.stats.rendered += 1
      // 渲染途中又被标过期：交付这一张，但仍然过期，随后重画
      if ((this.generation.get(index) ?? 0) === started) this.stale.delete(index)
      else this.stale.add(index)
      this.options.onReady?.(index, artifact, previous)
      if (previous !== undefined && previous !== artifact) this.options.onEvict?.(index, previous)
      this.evict()
    } else if (artifact !== undefined) {
      this.options.onEvict?.(index, artifact)
    }
    this.replan()
  }
}
