/**
 * 幻灯片位图渲染与缓存
 *
 * 为什么先画到离屏画布再整块贴到可见画布：
 * - `paintSlide` 是异步的（图片解码），直接画在可见画布上会先清空再逐步出现，翻页时出现一瞬间的白屏；
 *   离屏画好后一次 `drawImage`，可见画布从旧页直接变到新页，没有中间态。
 * - 画好的位图留在 LRU 里，来回翻页、相邻页预渲染、缩放回到原比例都是直接贴图（<10 ms）。
 *
 * 缓存按「像素预算」而不是页数控制：同样 8 页，手机 390 宽只有 0.5 MB，4K 屏要 30 MB。
 */
import { paintScale, pixelSize } from './zoom'
import type { SlideBackend, SlideFrame } from './types'

/** 画布的最小形状：既能是 HTMLCanvasElement 也能是 OffscreenCanvas，测试里是假对象 */
export interface CanvasLike {
  width: number
  height: number
  getContext(type: '2d'): CanvasRenderingContext2D | null
}

export interface Rendered {
  canvas: CanvasLike
  frame: SlideFrame
  /** 位图的物理像素尺寸 */
  width: number
  height: number
}

export interface RendererOptions {
  /** 缓存里最多保留多少像素（宽×高之和），默认 24M ≈ 96 MB */
  budgetPixels?: number
  makeCanvas?: (width: number, height: number) => CanvasLike
}

const DEFAULT_BUDGET = 24_000_000

function defaultCanvas(width: number, height: number): CanvasLike {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

export class SlideRenderer {
  private cache = new Map<string, Rendered>()
  private inflight = new Map<string, Promise<Rendered>>()
  private used = 0
  private revision = 0
  /** 每页各自的失效代数：编辑某一页时只让这一页的位图作废，其余页的缓存和预渲染继续有效 */
  private generations = new Map<number, number>()
  private disposed = false
  private readonly budget: number
  private readonly makeCanvas: (width: number, height: number) => CanvasLike

  constructor(
    private readonly backend: SlideBackend,
    options: RendererOptions = {},
  ) {
    this.budget = options.budgetPixels ?? DEFAULT_BUDGET
    this.makeCanvas = options.makeCanvas ?? defaultCanvas
  }

  private gen(index: number): number {
    return this.generations.get(index) ?? 0
  }

  private key(index: number, width: number, height: number): string {
    return `${this.revision}:${index}:${this.gen(index)}:${width}x${height}`
  }

  /** 已经画好的位图（同时刷新它在 LRU 里的位置）；没有返回 undefined */
  cached(index: number, scale: number, dpr: number): Rendered | undefined {
    const px = pixelSize(this.backend.size, scale, dpr)
    const key = this.key(index, px.width, px.height)
    const hit = this.cache.get(key)
    if (hit) {
      this.cache.delete(key)
      this.cache.set(key, hit)
    }
    return hit
  }

  /** 画一页（同样的请求并发时共用一次绘制）；失败向上抛，不缓存失败 */
  render(index: number, scale: number, dpr: number): Promise<Rendered> {
    const px = pixelSize(this.backend.size, scale, dpr)
    const key = this.key(index, px.width, px.height)
    const hit = this.cached(index, scale, dpr)
    if (hit) return Promise.resolve(hit)
    const running = this.inflight.get(key)
    if (running) return running
    const revision = this.revision
    const generation = this.gen(index)
    const job = (async () => {
      const frame = await this.backend.frame(index)
      const canvas = this.makeCanvas(px.width, px.height)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('浏览器不支持 Canvas 2D，画不出幻灯片')
      await frame.paint(ctx, dpr, paintScale(this.backend.size, scale, dpr))
      const result: Rendered = { canvas, frame, width: px.width, height: px.height }
      // 画的过程中内容变了（编辑 / 撤销）或已销毁：结果作废，不进缓存
      if (!this.disposed && revision === this.revision && generation === this.gen(index)) this.store(key, result)
      return result
    })().finally(() => {
      this.inflight.delete(key)
    })
    this.inflight.set(key, job)
    return job
  }

  private store(key: string, value: Rendered): void {
    this.cache.set(key, value)
    this.used += value.width * value.height
    // 从最久没用的开始丢，至少留下刚存的这一张
    for (const [oldKey, old] of this.cache) {
      if (this.used <= this.budget || this.cache.size <= 1) break
      if (oldKey === key) continue
      this.drop(oldKey, old)
    }
  }

  private drop(key: string, value: Rendered): void {
    this.cache.delete(key)
    this.used -= value.width * value.height
    // 立刻归还画布的后备存储，不等 GC（Safari 对离屏画布内存很吝啬）
    value.canvas.width = 0
    value.canvas.height = 0
  }

  /**
   * 内容变了：旧位图作废。不传页号 = 全部（页序 / 页数变了）；传页号 = 只作废这几页。
   * 正在画的旧结果不会进缓存（代数对不上）。
   */
  invalidate(indices?: readonly number[]): void {
    if (!indices) {
      this.revision += 1
      for (const [key, value] of [...this.cache]) this.drop(key, value)
      this.inflight.clear()
      this.generations.clear()
      return
    }
    const targets = new Set(indices)
    for (const index of targets) this.generations.set(index, this.gen(index) + 1)
    for (const [key, value] of [...this.cache]) if (targets.has(Number(key.split(':')[1]))) this.drop(key, value)
    for (const key of [...this.inflight.keys()]) if (targets.has(Number(key.split(':')[1]))) this.inflight.delete(key)
  }

  get size(): number {
    return this.cache.size
  }

  dispose(): void {
    this.disposed = true
    this.invalidate()
  }
}
