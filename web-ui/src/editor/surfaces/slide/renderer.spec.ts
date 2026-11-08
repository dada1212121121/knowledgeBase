import { describe, expect, it } from 'vitest'
import { makeFakeBackend } from './fakeBackend'
import { SlideRenderer, type CanvasLike } from './renderer'

function canvasMaker() {
  const made: CanvasLike[] = []
  return {
    made,
    make: (width: number, height: number): CanvasLike => {
      const canvas = { width, height, getContext: () => ({}) as CanvasRenderingContext2D }
      made.push(canvas)
      return canvas
    },
  }
}

describe('幻灯片位图渲染与缓存', () => {
  it('同一页同一尺寸只画一次，之后直接命中缓存', async () => {
    const backend = makeFakeBackend()
    const { make } = canvasMaker()
    const renderer = new SlideRenderer(backend, { makeCanvas: make })
    const first = await renderer.render(1, 0.5, 1)
    expect(first.width).toBe(640)
    expect(first.height).toBe(360)
    const again = await renderer.render(1, 0.5, 1)
    expect(again).toBe(first)
    expect(backend.log.paint).toEqual([1])
    expect(renderer.cached(1, 0.5, 1)).toBe(first)
    expect(renderer.cached(1, 0.75, 1)).toBeUndefined()
  })

  it('并发的相同请求共用一次绘制', async () => {
    const backend = makeFakeBackend()
    const renderer = new SlideRenderer(backend, { makeCanvas: canvasMaker().make })
    const [a, b] = await Promise.all([renderer.render(0, 1, 1), renderer.render(0, 1, 1)])
    expect(a).toBe(b)
    expect(backend.log.paint).toEqual([0])
  })

  it('超出像素预算从最久没用的开始丢，并归还被丢画布的存储', async () => {
    const backend = makeFakeBackend({ count: 4 })
    const { make, made } = canvasMaker()
    // 每张 1280×720 = 921,600 像素，预算只够 2 张
    const renderer = new SlideRenderer(backend, { makeCanvas: make, budgetPixels: 2_000_000 })
    await renderer.render(0, 1, 1)
    await renderer.render(1, 1, 1)
    renderer.cached(0, 1, 1) // 刷新 0 的位置，1 变成最旧
    await renderer.render(2, 1, 1)
    expect(renderer.size).toBe(2)
    expect(renderer.cached(1, 1, 1)).toBeUndefined()
    expect(renderer.cached(0, 1, 1)).toBeDefined()
    expect(made[1]!.width).toBe(0)
    expect(made[1]!.height).toBe(0)
  })

  it('invalidate 让旧位图作废并清空画布；绘制中途失效的结果不进缓存', async () => {
    const backend = makeFakeBackend()
    const renderer = new SlideRenderer(backend, { makeCanvas: canvasMaker().make })
    const first = await renderer.render(0, 1, 1)
    renderer.invalidate()
    expect(renderer.size).toBe(0)
    expect(first.canvas.width).toBe(0)
    const pending = renderer.render(1, 1, 1)
    renderer.invalidate()
    await pending
    expect(renderer.size).toBe(0)
    await renderer.render(1, 1, 1)
    expect(renderer.size).toBe(1)
  })

  it('按页失效：只作废指定的页，其它页的缓存继续命中；画到一半的旧结果不进缓存', async () => {
    const backend = makeFakeBackend({ count: 3 })
    const renderer = new SlideRenderer(backend, { makeCanvas: canvasMaker().make })
    const keep = await renderer.render(0, 1, 1)
    const stale = await renderer.render(1, 1, 1)
    renderer.invalidate([1])
    expect(renderer.cached(0, 1, 1)).toBe(keep)
    expect(renderer.cached(1, 1, 1)).toBeUndefined()
    expect(stale.canvas.width).toBe(0)
    const pending = renderer.render(2, 1, 1)
    renderer.invalidate([2])
    await pending
    expect(renderer.cached(2, 1, 1)).toBeUndefined()
    const fresh = await renderer.render(1, 1, 1)
    expect(fresh).not.toBe(stale)
    expect(renderer.cached(1, 1, 1)).toBe(fresh)
    expect(backend.log.paint).toEqual([0, 1, 2, 1])
  })

  it('绘制失败向上抛，且不缓存失败', async () => {
    const backend = makeFakeBackend({ failPaint: [2] })
    const renderer = new SlideRenderer(backend, { makeCanvas: canvasMaker().make })
    await expect(renderer.render(2, 1, 1)).rejects.toThrow('画不出来')
    expect(renderer.size).toBe(0)
    await expect(renderer.render(2, 1, 1)).rejects.toThrow('画不出来')
  })

  it('没有 2D 上下文时给出明确错误', async () => {
    const renderer = new SlideRenderer(makeFakeBackend(), { makeCanvas: () => ({ width: 1, height: 1, getContext: () => null }) })
    await expect(renderer.render(0, 1, 1)).rejects.toThrow('Canvas 2D')
  })
})
