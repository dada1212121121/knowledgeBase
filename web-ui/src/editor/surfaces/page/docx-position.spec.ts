/**
 * 只读预览阅读位置测试（补全）：把 DOM 量成数字、缩放前后停在同一页同一处
 *
 * jsdom 没有布局，页的位置用可控的 getBoundingClientRect 替身模拟一个「CSS zoom 容器里的 20 页」：
 * 缩放系数改变时各页的屏幕尺寸等比变化，和真实浏览器里 zoom 的效果一致。
 */
import { describe, expect, it } from 'vitest'
import { currentPage } from './docx-read'
import { naturalPageSizes, pageBoxesOf, readPosition, restorePosition } from './docx-position'

const PAGES = 20
const PAGE_H = 1056
const GAP = 14
const PAD = 12

/** 搭一个带 20 页的滚动容器；`state.scale` 变了各页的屏幕位置等比变化（模拟 CSS zoom） */
function build(viewHeight = 900) {
  const state = { scale: 1, scrollTop: 0 }
  const scroller = document.createElement('div')
  const host = document.createElement('div')
  scroller.appendChild(host)
  document.body.appendChild(scroller)
  const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 0, width: 816 * state.scale, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
  // 滚动容器自己在屏幕上的位置：上沿 100
  scroller.getBoundingClientRect = () => rect(100, viewHeight)
  Object.defineProperty(scroller, 'clientHeight', { get: () => viewHeight })
  Object.defineProperty(scroller, 'scrollTop', { get: () => state.scrollTop, set: (value: number) => (state.scrollTop = value), configurable: true })
  Object.defineProperty(scroller, 'scrollHeight', { get: () => (PAD * 2 + PAGES * PAGE_H + (PAGES - 1) * GAP) * state.scale, configurable: true })
  const pages: HTMLElement[] = []
  for (let i = 0; i < PAGES; i += 1) {
    const section = document.createElement('section')
    section.className = 'kbdocx'
    section.getBoundingClientRect = () => {
      const contentTop = (PAD + i * (PAGE_H + GAP)) * state.scale
      return rect(100 - state.scrollTop + contentTop, PAGE_H * state.scale)
    }
    host.appendChild(section)
    pages.push(section)
  }
  return { state, scroller, host, pages }
}

describe('只读预览的阅读位置', () => {
  it('pageBoxesOf：换算成滚动内容坐标，滚动多少都不变', () => {
    const { state, scroller, host } = build()
    const at0 = pageBoxesOf(scroller, host)
    state.scrollTop = 5000
    const at5000 = pageBoxesOf(scroller, host)
    expect(at0).toHaveLength(20)
    expect(at0[0]).toEqual({ top: PAD, height: PAGE_H })
    expect(at5000).toEqual(at0)
  })

  it('currentPage 用二分取页：与逐页扫描结果一致（含滚到最底、空文档）', () => {
    const { state, scroller, host } = build()
    const linear = () => {
      const middle = 100 + 900 / 2
      const pages = [...host.children] as HTMLElement[]
      const found = pages.findIndex((page) => page.getBoundingClientRect().bottom >= middle)
      return (found < 0 ? pages.length : found + 1) as number
    }
    for (const scrollTop of [0, 700, 3000, 9999, 15000, 1e6]) {
      state.scrollTop = scrollTop
      expect(currentPage(scroller, host), `scrollTop ${scrollTop}`).toBe(linear())
    }
    expect(currentPage(scroller, document.createElement('div'))).toBe(0)
  })

  it('缩放前后停在同一页同一处：100% → 50% → 200% 再回 100%，页码与页内比例不变', () => {
    const { state, scroller, host } = build()
    // 滚到第 15 页中间偏下
    state.scrollTop = PAD + 14 * (PAGE_H + GAP) + 600 - 450
    const anchor = readPosition(scroller, host)!
    expect(anchor.page).toBe(14)
    expect(anchor.fraction).toBeCloseTo(600 / PAGE_H, 6)
    for (const scale of [0.5, 2, 1, 0.3, 1.25]) {
      state.scale = scale
      restorePosition(scroller, host, anchor)
      const again = readPosition(scroller, host)!
      expect(again.page, `scale ${scale}`).toBe(14)
      expect(again.fraction, `scale ${scale}`).toBeCloseTo(anchor.fraction, 5)
      expect(currentPage(scroller, host), `scale ${scale}`).toBe(15)
    }
  })

  it('naturalPageSizes：屏幕尺寸除以当前缩放，所以不随缩放变', () => {
    const { state, scroller, host } = build()
    void scroller
    state.scale = 0.5
    const sizes = naturalPageSizes(host, 0.5)
    expect(sizes).toHaveLength(20)
    expect(sizes[0]).toEqual({ width: 816, height: PAGE_H })
    state.scale = 2
    expect(naturalPageSizes(host, 2)[3]).toEqual({ width: 816, height: PAGE_H })
  })

  it('没有页：readPosition 返回 null，restorePosition 什么也不做', () => {
    const scroller = document.createElement('div')
    const host = document.createElement('div')
    scroller.appendChild(host)
    expect(readPosition(scroller, host)).toBeNull()
    expect(() => restorePosition(scroller, host, { page: 3, fraction: 0.2 })).not.toThrow()
  })
})
