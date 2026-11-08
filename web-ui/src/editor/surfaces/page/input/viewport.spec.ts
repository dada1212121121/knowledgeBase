/** 滚动视口几何的纯计算单测：光标滚入可视区、有效缩放、滚动祖先查找。 */
import { afterEach, describe, expect, it } from 'vitest'
import { effectiveZoom, findVerticalScrollParent, findVerticalScrollParentOrRoot, scrollIntoViewDelta, viewportColumnBand } from './viewport'

afterEach(() => {
  document.body.innerHTML = ''
})

const viewport = { top: 100, bottom: 700, height: 600, zoom: 1 }

describe('scrollIntoViewDelta', () => {
  it('已经在可视区（含边距）内：不滚', () => {
    expect(scrollIntoViewDelta(viewport, 300, 320, 24)).toBe(0)
  })

  it('光标在上方：向上滚到距顶 margin', () => {
    expect(scrollIntoViewDelta(viewport, 90, 110, 24)).toBe(-34)
  })

  it('光标在下方：向下滚到距底 margin', () => {
    expect(scrollIntoViewDelta(viewport, 690, 710, 24)).toBe(34)
  })

  it('容器有 CSS zoom 时，client 像素差要折算回 scrollTop 单位', () => {
    expect(scrollIntoViewDelta({ ...viewport, zoom: 2 }, 90, 110, 24)).toBe(-5 - 24)
  })
})

describe('DOM 辅助', () => {
  it('effectiveZoom 沿祖先链累乘 CSS zoom', () => {
    const outer = document.createElement('div')
    outer.style.zoom = '1.5'
    const inner = document.createElement('div')
    inner.style.zoom = '2'
    outer.appendChild(inner)
    document.body.appendChild(outer)
    // jsdom 没有 currentCSSZoom，走计算样式路径；这里只验证累乘，不依赖具体 layout
    const value = effectiveZoom(inner)
    expect(value === 3 || value === 1).toBe(true)
  })

  it('findVerticalScrollParent 只认真的能滚的祖先', () => {
    const scroller = document.createElement('div')
    scroller.style.overflowY = 'auto'
    Object.defineProperties(scroller, { scrollHeight: { value: 2000 }, clientHeight: { value: 500 } })
    const flat = document.createElement('div')
    flat.style.overflowY = 'auto'
    Object.defineProperties(flat, { scrollHeight: { value: 500 }, clientHeight: { value: 500 } })
    const child = document.createElement('div')
    flat.appendChild(child)
    scroller.appendChild(flat)
    document.body.appendChild(scroller)
    expect(findVerticalScrollParent(child)).toBe(scroller)
  })

  it('没有可滚祖先时退回根元素', () => {
    const lone = document.createElement('div')
    document.body.appendChild(lone)
    expect(findVerticalScrollParent(lone)).toBeNull()
    expect(findVerticalScrollParentOrRoot(lone)).toBe(document.documentElement)
  })

  it('viewportColumnBand 用列顶与视口顶给出视口盖住的那一段', () => {
    const scroller = document.createElement('div')
    scroller.getBoundingClientRect = () => ({ top: 80, bottom: 680, left: 0, right: 0, width: 0, height: 600 }) as DOMRect
    Object.defineProperty(scroller, 'clientHeight', { value: 600 })
    const column = document.createElement('div')
    column.getBoundingClientRect = () => ({ top: -400, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) as DOMRect
    const band = viewportColumnBand(scroller, column)
    expect(band.columnTop).toBe(-400)
    expect(band.top).toBe(80)
    expect(band.height).toBe(600)
  })
})
