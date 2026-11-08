/**
 * 测试用的假幻灯片后端：不依赖引擎和真实 Canvas。
 * 每页画一个带页码的色块；`log` 记录 frame / paint 的调用，用来断言「当前页优先」「缓存命中不重画」。
 */
import type { SlideBackend, SlideFrame, SlideMatch, SlideRect, SlideSummary } from './types'

export interface FakeBackendOptions {
  count?: number
  size?: { width: number; height: number }
  notes?: Record<number, string>
  hidden?: number[]
  /** 这些页画的时候抛错 */
  failPaint?: number[]
  texts?: Record<number, string>
}

export interface FakeBackend extends SlideBackend {
  log: { frame: number[]; paint: number[]; disposed: boolean }
}

export function makeFakeBackend(options: FakeBackendOptions = {}): FakeBackend {
  const count = options.count ?? 5
  const size = options.size ?? { width: 1280, height: 720 }
  const log: FakeBackend['log'] = { frame: [], paint: [], disposed: false }
  const slides: SlideSummary[] = Array.from({ length: count }, (_, i) => ({
    id: `slide:${i}`,
    title: `标题 ${i + 1}`,
    notes: options.notes?.[i] ?? '',
    hidden: options.hidden?.includes(i) ?? false,
  }))
  const text = (i: number) => options.texts?.[i] ?? `第 ${i + 1} 页的正文 alpha beta`
  return {
    size,
    log,
    slides: () => slides,
    slideText: text,
    frame: async (index: number): Promise<SlideFrame> => {
      if (index < 0 || index >= count) throw new RangeError(`越界：${index}`)
      log.frame.push(index)
      return {
        width: size.width,
        height: size.height,
        paint: async (ctx) => {
          if (options.failPaint?.includes(index)) throw new Error('画不出来')
          log.paint.push(index)
          // 真实 Canvas 在 jsdom 里不存在：假后端只记录调用，不碰 ctx
          void ctx
        },
        textRects: (match): SlideRect[] => [{ x: match.start * 10, y: 20, width: (match.end - match.start) * 10, height: 30 }],
      }
    },
    search(query: string): SlideMatch[] {
      const out: SlideMatch[] = []
      const needle = query.toLowerCase()
      for (let i = 0; i < count; i += 1) {
        const hay = text(i).toLowerCase()
        let at = hay.indexOf(needle)
        while (at >= 0) {
          out.push({ slide: i, shapeId: `s${i}`, storyId: `story${i}`, start: at, end: at + needle.length, text: query })
          at = hay.indexOf(needle, at + needle.length)
        }
      }
      return out
    },
    dispose() {
      log.disposed = true
    },
  }
}

/** jsdom 没有 Canvas：补一个什么都不做的 2D 上下文，让 getContext / drawImage 可用 */
export function stubCanvas(): () => void {
  const original = HTMLCanvasElement.prototype.getContext
  const ctx = new Proxy(
    {},
    {
      get: (_target, key) => (key === 'canvas' ? undefined : () => undefined),
    },
  )
  HTMLCanvasElement.prototype.getContext = (() => ctx) as never
  return () => {
    HTMLCanvasElement.prototype.getContext = original
  }
}
