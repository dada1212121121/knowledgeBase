import { describe, expect, it } from 'vitest'
import { MIN_SHAPE_SIZE, resizeRect } from './resize'

const R = { x: 100, y: 100, width: 200, height: 100 }

describe('拖拽缩放', () => {
  it('东南角：左上不动，宽高随位移变', () => {
    expect(resizeRect(R, 'se', { x: 30, y: 20 })).toEqual({ x: 100, y: 100, width: 230, height: 120 })
  })

  it('西北角：右下不动', () => {
    expect(resizeRect(R, 'nw', { x: -20, y: -10 })).toEqual({ x: 80, y: 90, width: 220, height: 110 })
  })

  it('边中点只改一个方向', () => {
    expect(resizeRect(R, 'e', { x: 50, y: 99 })).toEqual({ x: 100, y: 100, width: 250, height: 100 })
    expect(resizeRect(R, 'n', { x: 99, y: -40 })).toEqual({ x: 100, y: 60, width: 200, height: 140 })
  })

  it('拖过对面的边时夹在最小尺寸，对面的边保持不动', () => {
    const small = resizeRect(R, 'w', { x: 500, y: 0 })
    expect(small.width).toBe(MIN_SHAPE_SIZE)
    expect(small.x + small.width).toBe(300)
    const flat = resizeRect(R, 's', { x: 0, y: -500 })
    expect(flat.height).toBe(MIN_SHAPE_SIZE)
    expect(flat.y).toBe(100)
  })

  it('锁定宽高比：四个角等比缩放，对角不动', () => {
    const grown = resizeRect(R, 'se', { x: 40, y: 0 }, { lockAspect: true })
    expect(grown.width / grown.height).toBeCloseTo(2, 6)
    expect(grown.x).toBe(100)
    expect(grown.y).toBe(100)
    expect(grown.width).toBeGreaterThan(200)
    const shrunk = resizeRect(R, 'nw', { x: 40, y: 20 }, { lockAspect: true })
    expect(shrunk.x + shrunk.width).toBeCloseTo(300, 6)
    expect(shrunk.y + shrunk.height).toBeCloseTo(200, 6)
    expect(shrunk.width / shrunk.height).toBeCloseTo(2, 6)
  })

  it('锁定宽高比时缩到极小也不低于最小尺寸；边中点不受锁定影响', () => {
    const tiny = resizeRect(R, 'se', { x: -999, y: -999 }, { lockAspect: true })
    expect(Math.min(tiny.width, tiny.height)).toBeGreaterThanOrEqual(MIN_SHAPE_SIZE)
    expect(resizeRect(R, 'e', { x: 40, y: 0 }, { lockAspect: true })).toEqual({ x: 100, y: 100, width: 240, height: 100 })
  })

  it('零位移 → 原样', () => {
    for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const) expect(resizeRect(R, handle, { x: 0, y: 0 })).toEqual(R)
  })
})
