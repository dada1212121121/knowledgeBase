/** 页窗口与页码计算的单测：长文档只让 Worker 出视口附近的图。 */
import { describe, expect, it } from 'vitest'
import { nextPageWindow, pageAtViewport, visiblePageRange } from './pageWindow'

const layout = (count: number, height = 1000, gap = 20) =>
  Array.from({ length: count }, (_, index) => ({ page: { pageIndex: index }, bounds: { y: index * (height + gap), height } }))

describe('nextPageWindow', () => {
  it('首次：可见页前后各多挂 2 页，夹在文档范围内', () => {
    expect(nextPageWindow(null, 5, 6, 20)).toEqual({ start: 3, end: 8 })
    expect(nextPageWindow(null, 0, 1, 20)).toEqual({ start: 0, end: 3 })
    expect(nextPageWindow(null, 18, 19, 20)).toEqual({ start: 16, end: 19 })
  })

  it('刚滚出去的一页因滞回保留，来回滚动不抖', () => {
    const first = nextPageWindow(null, 5, 6, 20)
    const scrolled = nextPageWindow(first, 6, 7, 20)
    expect(scrolled).toEqual({ start: 3, end: 9 })
  })

  it('滚得更远时丢掉超出滞回的旧页', () => {
    const first = nextPageWindow(null, 2, 3, 30)
    const far = nextPageWindow(first, 15, 16, 30)
    // 新可见区挂载 13..18，再往外留 1 页滞回 → 起点 12；旧窗口的 0..5 全部丢掉
    expect(far).toEqual({ start: 12, end: 18 })
  })

  it('窗口没变时返回同一个对象（调用方据此跳过更新）', () => {
    const first = nextPageWindow(null, 5, 6, 20)
    expect(nextPageWindow(first, 5, 6, 20)).toBe(first)
  })
})

describe('visiblePageRange', () => {
  it('返回被 y 区间盖住的第一页与最后一页', () => {
    expect(visiblePageRange(layout(10), 1500, 3200)).toEqual({ first: 1, last: 3 })
  })

  it('区间在文档之后：落到最后一页', () => {
    expect(visiblePageRange(layout(3), 99999, 100000)).toEqual({ first: 2, last: 2 })
  })

  it('区间在文档之前：第一页', () => {
    expect(visiblePageRange(layout(3), -500, -100)).toEqual({ first: 0, last: 0 })
  })
})

describe('pageAtViewport', () => {
  it('取视口中线所在页（页码从 1 起）', () => {
    const pages = layout(10)
    expect(pageAtViewport(pages, 0, 600, 1)).toBe(1)
    // 中线 = 2500 + 300 = 2800，第三页（y 2040..3040）
    expect(pageAtViewport(pages, 2500, 600, 1)).toBe(3)
  })

  it('页面缩放要折算：scrollTop 是屏幕像素', () => {
    const pages = layout(10)
    // 缩放 2 倍：中线 (4000 + 300) / 2 = 2150，第三页
    expect(pageAtViewport(pages, 4000, 600, 2)).toBe(3)
  })

  it('空文档回 1', () => {
    expect(pageAtViewport([], 0, 600, 1)).toBe(1)
  })
})
