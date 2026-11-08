/**
 * 滚动同步纯计算测试（补全）：页码计算、缩放保持阅读位置、缩略图滚入可见
 */
import { describe, expect, it } from 'vitest'
import {
  captureAnchor,
  clampPage,
  lineForAnchor,
  pageIndexAtLine,
  referenceLine,
  revealOffset,
  scrollTopForAnchor,
  scrollTopForPage,
  visibleRange,
  type PageBox,
} from './scrollSync'

/** 20 页，每页 1056 高、页间 14 的空隙，上边留 12（与 DocxReadView 的 12px 内边距 + 14px 页间距同形） */
function layout(zoom: number, pages = 20): { boxes: PageBox[]; content: number } {
  const boxes: PageBox[] = []
  let top = 12 * zoom
  for (let i = 0; i < pages; i += 1) {
    boxes.push({ top, height: 1056 * zoom })
    top += (1056 + 14) * zoom
  }
  return { boxes, content: top + 12 * zoom }
}

describe('页码计算（参考线落在哪一页）', () => {
  const { boxes } = layout(1)

  it('参考线在页里：返回那一页；在页间空隙里：取下一页（与旧 currentPage 的「第一个底边 ≥ 中线」一致）', () => {
    expect(pageIndexAtLine(boxes, boxes[3]!.top + 10)).toBe(3)
    expect(pageIndexAtLine(boxes, boxes[3]!.top + boxes[3]!.height)).toBe(3)
    expect(pageIndexAtLine(boxes, boxes[3]!.top + boxes[3]!.height + 5)).toBe(4)
  })

  it('首尾与空文档：在第一页之上取第 0 页，在最后一页之下取最后一页，没有页返回 -1', () => {
    expect(pageIndexAtLine(boxes, -50)).toBe(0)
    expect(pageIndexAtLine(boxes, 1e9)).toBe(19)
    expect(pageIndexAtLine([], 100)).toBe(-1)
  })

  it('参考线默认在视口中线：滚到第 15 页顶部再往下半个视口，页码就是 15', () => {
    const view = 800
    const scrollTop = boxes[14]!.top - view / 2 + 100
    expect(pageIndexAtLine(boxes, referenceLine(scrollTop, view)) + 1).toBe(15)
  })

  it('几百页也成立（二分，结果与线性扫描一致）', () => {
    const many = layout(1, 600).boxes
    for (const line of [0, 5000, 123456, 600000, 1e7]) {
      const linear = many.findIndex((box) => box.top + box.height >= line)
      expect(pageIndexAtLine(many, line)).toBe(linear < 0 ? many.length - 1 : linear)
    }
  })

  it('clampPage：越界夹住、非数字回 1', () => {
    expect(clampPage(0, 20)).toBe(1)
    expect(clampPage(99, 20)).toBe(20)
    expect(clampPage(Number.NaN, 20)).toBe(1)
    expect(clampPage(7.4, 20)).toBe(7)
    expect(clampPage(3, 0)).toBe(1)
  })
})

describe('缩放保持阅读位置', () => {
  it('缩放前后参考线仍在同一页、同一页内位置：50% → 200% 再回到 100% 页码与页内比例不变', () => {
    const view = 900
    const before = layout(1)
    const scrollTop = before.boxes[14]!.top + 300 - view / 2
    const anchor = captureAnchor(before.boxes, referenceLine(scrollTop, view))!
    expect(anchor.page).toBe(14)
    expect(anchor.fraction).toBeCloseTo(300 / 1056, 6)
    for (const zoom of [0.5, 2, 1.2, 0.3]) {
      const after = layout(zoom)
      const next = scrollTopForAnchor(after.boxes, anchor, view, after.content)
      const again = captureAnchor(after.boxes, referenceLine(next, view))!
      expect(again.page, `zoom ${zoom}`).toBe(14)
      expect(again.fraction, `zoom ${zoom}`).toBeCloseTo(anchor.fraction, 6)
    }
  })

  it('参考线落在页间空隙里：缩放后仍落在同一道空隙，不会跳到上一页或下一页', () => {
    const view = 900
    const before = layout(1)
    const gapLine = before.boxes[4]!.top + before.boxes[4]!.height + 7
    const anchor = captureAnchor(before.boxes, gapLine)!
    expect(anchor.page).toBe(5)
    expect(anchor.fraction).toBeLessThan(0)
    const after = layout(2)
    const next = scrollTopForAnchor(after.boxes, anchor, view, after.content)
    const line = referenceLine(next, view)
    expect(line).toBeGreaterThan(after.boxes[4]!.top + after.boxes[4]!.height)
    expect(line).toBeLessThan(after.boxes[5]!.top)
  })

  it('缩小到不满一屏：scrollTop 夹在 0；放大后超出：夹在最大值，不会把页面推出视口', () => {
    const view = 900
    const tiny = layout(0.05, 2)
    expect(scrollTopForAnchor(tiny.boxes, { page: 1, fraction: 0.5 }, view, tiny.content)).toBe(0)
    const big = layout(1)
    const last = scrollTopForAnchor(big.boxes, { page: 19, fraction: 5 }, view, big.content)
    expect(last).toBe(big.content - view)
  })

  it('锚点页码越界时夹到首 / 尾页；空布局回 0', () => {
    const { boxes } = layout(1)
    expect(lineForAnchor(boxes, { page: 99, fraction: 0 })).toBe(boxes[19]!.top)
    expect(lineForAnchor(boxes, { page: -3, fraction: 0 })).toBe(boxes[0]!.top)
    expect(lineForAnchor([], { page: 0, fraction: 0 })).toBe(0)
    expect(captureAnchor([], 10)).toBeNull()
  })

  it('跳页：第 N 页顶部贴视口上沿（留 gap），第 1 页不会出现负的 scrollTop', () => {
    const { boxes, content } = layout(1)
    expect(scrollTopForPage(boxes, 14, 900, content, 8)).toBe(boxes[14]!.top - 8)
    expect(scrollTopForPage(boxes, 0, 900, content, 40)).toBe(0)
    expect(scrollTopForPage(boxes, 19, 900, content, 0)).toBe(Math.min(boxes[19]!.top, content - 900))
  })
})

describe('缩略图栏滚入可见', () => {
  // 每项 100 高，间隔 6，共 20 项
  const startOf = (index: number) => index * 106
  const sizeOf = () => 100

  it('visibleRange：返回与视口相交的首尾项，二分结果与线性扫描一致', () => {
    for (const offset of [0, 50, 300, 1000, 1900, 2100]) {
      const range = visibleRange(20, startOf, sizeOf, offset, 400)!
      const linear = Array.from({ length: 20 }, (_, index) => index).filter((index) => startOf(index) + sizeOf() > offset && startOf(index) < offset + 400)
      expect(range.first, `offset ${offset}`).toBe(linear[0] ?? 19)
      expect(range.last, `offset ${offset}`).toBe(linear.at(-1) ?? 19)
    }
    expect(visibleRange(0, startOf, sizeOf, 0, 400)).toBeNull()
  })

  it('已经完全可见：偏移不变（滚主视图时缩略图栏不抖）', () => {
    expect(revealOffset({ start: 220, size: 100, offset: 100, view: 400 })).toBe(100)
  })

  it('在视口下方一点：刚好露出（含边距），不居中', () => {
    expect(revealOffset({ start: 420, size: 100, offset: 100, view: 400 })).toBe(420 + 100 + 8 - 400)
  })

  it('在视口上方一点：滚到起点往上留边距', () => {
    expect(revealOffset({ start: 60, size: 100, offset: 200, view: 400 })).toBe(52)
  })

  it('离得很远（整屏以外）：让它居中；开头附近不出现负偏移', () => {
    expect(revealOffset({ start: 1590, size: 100, offset: 0, view: 400 })).toBe(1590 - 150)
    expect(revealOffset({ start: 10, size: 100, offset: 3000, view: 400 })).toBe(0)
  })

  it('条目比视口还长：贴齐起点', () => {
    expect(revealOffset({ start: 500, size: 600, offset: 0, view: 400 })).toBe(492)
  })
})
