/**
 * 画布缩略图后端测试（补全）：按需开会话、空闲关会话、文档改了用新快照重开、倍数算法、失败冷却
 *
 * 引擎会话用替身（真引擎要 WASM + Worker，e2e 里验）；这里验来源自己的状态机。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocxRasterSession } from '../../../engines/docx'
import { createCanvasThumbSource } from './canvasThumbSource'

const BOX = { width: 144, height: 186, dpr: 1 }
const signal = () => new AbortController().signal

function fakeEngine() {
  const opened: Array<{ bytes: Uint8Array; scale: number; disposed: boolean; rasterized: number[] }> = []
  const open = vi.fn(async (bytes: Uint8Array, options: { scale: number }): Promise<DocxRasterSession> => {
    const record = { bytes, scale: options.scale, disposed: false, rasterized: [] as number[] }
    opened.push(record)
    return {
      pageCount: 20,
      pageSizes: Array.from({ length: 20 }, () => ({ width: 816, height: 1056 })),
      async rasterize(index) {
        if (record.disposed) throw new Error('会话已关闭')
        record.rasterized.push(index)
        const canvas = document.createElement('canvas')
        canvas.width = 144
        canvas.height = 186
        return canvas
      },
      dispose: () => {
        record.disposed = true
      },
    }
  })
  return { opened, open }
}

beforeEach(() => {
  vi.useFakeTimers()
  // jsdom 没有 2D 画布实现：编码成 PNG 这一步换成固定的 data URL
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AAAA')
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('createCanvasThumbSource', () => {
  it('第一张缩略图被要的时候才取快照、开会话；之后各页共用同一个会话', async () => {
    const { opened, open } = fakeEngine()
    const snapshot = vi.fn(async () => new Uint8Array([1, 2, 3]))
    const source = createCanvasThumbSource({ snapshot, pageWidth: () => 816, open })
    expect(snapshot).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    await source.render(3, BOX, signal())
    await source.render(4, BOX, signal())
    await source.render(0, BOX, signal())
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledTimes(1)
    expect(opened[0]!.rasterized).toEqual([3, 4, 0])
    source.dispose()
  })

  it('光栅倍数 = 缩略图盒子宽 × 设备像素比 ÷ 页面版面宽：位图宽刚好等于缩略图的物理像素宽', async () => {
    const { opened, open } = fakeEngine()
    const source = createCanvasThumbSource({ snapshot: async () => new Uint8Array(1), pageWidth: () => 816, open })
    await source.render(0, { width: 144, height: 186, dpr: 2 }, signal())
    expect(opened[0]!.scale).toBeCloseTo((144 * 2) / 816, 6)
    source.dispose()
  })

  it('盒子尺寸变了（纵栏 ↔ 横条）：重开会话按新倍数画，已画过的页才会是新尺寸', async () => {
    const { opened, open } = fakeEngine()
    const source = createCanvasThumbSource({ snapshot: async () => new Uint8Array(1), pageWidth: () => 816, open })
    await source.render(0, BOX, signal())
    await source.render(1, { width: 56, height: 72, dpr: 1 }, signal())
    expect(opened).toHaveLength(2)
    expect(opened[0]!.disposed).toBe(true)
    source.dispose()
  })

  it('取完空闲一阵就关会话（不常驻 Worker）；再要图时重开，但文档没改就复用上次的快照，不让引擎再保存一遍', async () => {
    const { opened, open } = fakeEngine()
    const snapshot = vi.fn(async () => new Uint8Array([9]))
    const source = createCanvasThumbSource({ snapshot, pageWidth: () => 816, open, idleCloseMs: 1000 })
    await source.render(0, BOX, signal())
    await vi.advanceTimersByTimeAsync(999)
    expect(opened[0]!.disposed).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(opened[0]!.disposed).toBe(true)
    await source.render(1, BOX, signal())
    expect(opened).toHaveLength(2)
    expect(snapshot).toHaveBeenCalledTimes(1)
    source.dispose()
  })

  it('忙的时候不关：每取一页都把空闲计时往后推', async () => {
    const { opened, open } = fakeEngine()
    const source = createCanvasThumbSource({ snapshot: async () => new Uint8Array(1), pageWidth: () => 816, open, idleCloseMs: 1000 })
    for (let i = 0; i < 5; i += 1) {
      await source.render(i, BOX, signal())
      await vi.advanceTimersByTimeAsync(800)
    }
    expect(opened[0]!.disposed).toBe(false)
    source.dispose()
  })

  it('markDirty：旧会话立刻作废，下一张用新的快照重开（编辑后缩略图画的是新内容）', async () => {
    const { opened, open } = fakeEngine()
    let version = 0
    const snapshot = vi.fn(async () => new Uint8Array([(version += 1)]))
    const source = createCanvasThumbSource({ snapshot, pageWidth: () => 816, open })
    await source.render(2, BOX, signal())
    source.markDirty()
    expect(opened[0]!.disposed).toBe(true)
    await source.render(2, BOX, signal())
    expect(snapshot).toHaveBeenCalledTimes(2)
    expect([...opened[1]!.bytes]).toEqual([2])
    source.dispose()
  })

  it('会话打开失败：冷却期内直接拒绝，不让每一页都花几秒再试一遍；冷却过了再试', async () => {
    let fail = true
    const { opened, open } = fakeEngine()
    const flaky = vi.fn((bytes: Uint8Array, options: { scale: number }) => (fail ? Promise.reject(new Error('排版超时')) : open(bytes, options)))
    const source = createCanvasThumbSource({ snapshot: async () => new Uint8Array(1), pageWidth: () => 816, open: flaky, failureCooldownMs: 30_000 })
    await expect(source.render(0, BOX, signal())).rejects.toThrow('排版超时')
    await expect(source.render(1, BOX, signal())).rejects.toThrow('排版超时')
    await expect(source.render(2, BOX, signal())).rejects.toThrow('排版超时')
    expect(flaky).toHaveBeenCalledTimes(1)
    fail = false
    await vi.advanceTimersByTimeAsync(30_001)
    await source.render(3, BOX, signal())
    expect(opened).toHaveLength(1)
    source.dispose()
  })

  it('产出的是 <img>（data URL），不是 <canvas>：页面上按 canvas 选择元素的代码不会取到缩略图；引擎给的画布编码后立刻归还内存', async () => {
    const created: HTMLCanvasElement[] = []
    const { open } = fakeEngine()
    const wrapped = vi.fn(async (bytes: Uint8Array, options: { scale: number }) => {
      const session = await open(bytes, options)
      return {
        ...session,
        async rasterize(index: number) {
          const canvas = await session.rasterize(index)
          created.push(canvas)
          return canvas
        },
      }
    })
    const source = createCanvasThumbSource({ snapshot: async () => new Uint8Array(1), pageWidth: () => 816, open: wrapped })
    const artifact = await source.render(0, BOX, signal())
    expect(artifact).toBeInstanceOf(HTMLImageElement)
    expect((artifact as HTMLImageElement).src).toBe('data:image/png;base64,AAAA')
    expect(artifact.querySelector('canvas')).toBeNull()
    expect([created[0]!.width, created[0]!.height]).toEqual([0, 0])
    source.dispose()
  })

  it('release 丢掉图片的 data URL；dispose 关会话并拒绝后续请求', async () => {
    const { opened, open } = fakeEngine()
    const source = createCanvasThumbSource({ snapshot: async () => new Uint8Array(1), pageWidth: () => 816, open })
    const image = (await source.render(0, BOX, signal())) as HTMLImageElement
    source.release(image)
    expect(image.hasAttribute('src')).toBe(false)
    source.dispose()
    expect(opened[0]!.disposed).toBe(true)
    await expect(source.render(1, BOX, signal())).rejects.toThrow()
  })

  it('取快照期间被取消：不开会话', async () => {
    const { open } = fakeEngine()
    const controller = new AbortController()
    const source = createCanvasThumbSource({
      snapshot: async () => {
        controller.abort()
        return new Uint8Array(1)
      },
      pageWidth: () => 816,
      open,
    })
    await expect(source.render(0, BOX, controller.signal)).rejects.toThrow()
    expect(open).not.toHaveBeenCalled()
    source.dispose()
  })
})
