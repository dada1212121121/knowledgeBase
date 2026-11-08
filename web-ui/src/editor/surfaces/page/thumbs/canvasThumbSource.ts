/**
 * 画布编辑 / 高保真查看的缩略图后端（补全）：引擎页位图
 *
 * 缩略图用一个**独立的只读光栅会话**（`openDocxRasterSession`）取页位图，不碰用户正在看的那个会话：
 * 取页要不断改"显示哪一页"，借用屏幕会话会把页窗口和画布搅乱；屏幕会话的光栅倍数也是跟缩放走的，缩略图要的是小图。
 * 代价是多一个 Worker 会话（wasm 编译已缓存），所以：
 *  - 栏没开就不开会话；开了也是第一张缩略图被要的时候才开；
 *  - 取完后空闲一阵（`idleCloseMs`）自动关掉，下次要图再按需重开，常驻内存不涨；
 *  - 文档改了（`markDirty`）旧会话作废，下一张要的图用新的字节快照重开。快照由调用方给：
 * 编辑中是 `engine.save`（先落未提交的输入），只读查看是原件字节，所以只读查看不会为缩略图去保存任何东西。
 * 会话打不开（引擎崩溃 / 排版超时）就在冷却期内直接拒绝，不让每一页都重试一遍几秒的开会话。
 *
 * 产出是 `<img>`（页位图编码成 PNG data URL；页面 CSP 的 img-src 放行 data:）而不是 `<canvas>`：
 * 栏里放几十块画布会让页面上所有按 `canvas` 选择元素的代码（取第一页画布的几何、统计页画布个数…）取到缩略图；
 * 而且静态图片由浏览器管理解码缓存，不占 2D 上下文。编码在主线程约几毫秒一张，生成队列一次只做一张。
 */
import type { DocxRasterSession, OpenDocxRasterSessionOptions } from '../../../engines/docx'
import type { ThumbBox, ThumbSource } from './types'

export interface CanvasThumbOptions {
  /** 取一份当前文档的字节快照；只在文档改过（或第一次）才调用 */
  snapshot(): Promise<Uint8Array>
  /** 第 `index` 页的版面宽度（px，未缩放），用来算光栅倍数：位图宽 = 缩略图盒子宽 × 设备像素比 */
  pageWidth(index: number): number
  /** 取完后空闲多久关掉光栅会话，默认 15 秒 */
  idleCloseMs?: number
  /** 会话打开失败后多久内不再重试，默认 30 秒 */
  failureCooldownMs?: number
  /** 测试注入 */
  open?: (bytes: Uint8Array, options: OpenDocxRasterSessionOptions) => Promise<DocxRasterSession>
  now?: () => number
}

export interface CanvasThumbSource extends ThumbSource {
  /** 文档内容变了：旧的光栅会话与字节快照作废，下一次生成用新快照 */
  markDirty(): void
  release(artifact: HTMLElement): void
  dispose(): void
}

/** 光栅倍数的合理范围：太小（<0.03）位图只有几像素，太大浪费内存 */
const MIN_SCALE = 0.03
const MAX_SCALE = 1.5

export function createCanvasThumbSource(options: CanvasThumbOptions): CanvasThumbSource {
  // 引擎模块按需加载：单测不带 WASM，也不让只读预览路径（不用这个来源）为它付任何体积
  const open = options.open ?? (async (...args: Parameters<NonNullable<CanvasThumbOptions['open']>>) => (await import('../../../engines/docx')).openDocxRasterSession(...args))
  const idleCloseMs = options.idleCloseMs ?? 15_000
  const cooldown = options.failureCooldownMs ?? 30_000
  const now = options.now ?? (() => Date.now())

  let generation = 0
  let session: DocxRasterSession | null = null
  let sessionGeneration = -1
  let sessionScale = 0
  /** 最近一次取到的字节快照：文档没改、会话因空闲关了再开时直接复用，不用再让引擎保存一遍 */
  let bytes: Uint8Array | null = null
  let bytesGeneration = -1
  let failure: { error: Error; at: number } | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const closeSession = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
    session?.dispose()
    session = null
  }
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(closeSession, idleCloseMs)
  }

  async function ensure(index: number, box: ThumbBox, signal: AbortSignal): Promise<DocxRasterSession> {
    if (disposed) throw new Error('缩略图来源已关闭')
    const width = options.pageWidth(index) || 816
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, (box.width * box.dpr) / width))
    // 文档改了，或缩略图盒子换了尺寸（纵栏 ↔ 横条）：旧会话里已画过的页不会按新倍数重画，只能重开
    if (session && (sessionGeneration !== generation || Math.abs(scale / sessionScale - 1) > 0.02)) closeSession()
    if (session) return session
    if (failure && now() - failure.at < cooldown) throw failure.error
    const wanted = generation
    if (!bytes || bytesGeneration !== wanted) {
      bytes = await options.snapshot()
      bytesGeneration = wanted
    }
    if (signal.aborted) throw new DOMException('已取消', 'AbortError')
    try {
      const opened = await open(bytes, { scale, signal })
      if (disposed) {
        opened.dispose()
        throw new Error('缩略图来源已关闭')
      }
      session = opened
      sessionGeneration = wanted
      sessionScale = scale
      failure = null
      return opened
    } catch (error) {
      if (!signal.aborted && !disposed) failure = { error: error instanceof Error ? error : new Error(String(error)), at: now() }
      throw error
    }
  }

  return {
    async render(index, box, signal) {
      const active = await ensure(index, box, signal)
      try {
        const canvas = await active.rasterize(index, signal)
        try {
          const image = new Image()
          image.className = 'kb-pgt-image'
          image.alt = ''
          image.decoding = 'async'
          image.draggable = false
          image.src = canvas.toDataURL('image/png')
          // 先解码再交付：挂进槽的那一刻就能直接画出来，不会先闪一下空白
          await image.decode?.().catch(() => undefined)
          return image
        } finally {
          // 位图已经编码进 data URL：缩到 0×0 把画布内存还掉
          canvas.width = 0
          canvas.height = 0
        }
      } finally {
        if (!disposed) armIdle()
      }
    },
    release(artifact) {
      // 丢掉 data URL，让浏览器回收解码缓存
      if (artifact instanceof HTMLImageElement) artifact.removeAttribute('src')
    },
    markDirty() {
      generation += 1
      bytes = null
      closeSession()
    },
    dispose() {
      disposed = true
      closeSession()
      bytes = null
    },
  }
}
