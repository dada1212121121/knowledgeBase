/** 远端选区矩形整理单测：碎片合并、页窗口过滤、超限均摊、坏数据丢弃。 */
import { describe, expect, it } from 'vitest'
import { REMOTE_PRESENCE_MAX_RECTS, simplifyRemoteSelectionRects, type PresenceRect } from './presenceGeometry'

const rect = (pageIndex: number, x: number, y: number, width = 10, height = 12): PresenceRect => ({ pageIndex, x, y, width, height })
const ALL = { start: 0, end: 99 }

describe('simplifyRemoteSelectionRects', () => {
  it('同一行上相邻的碎片合成一条', () => {
    const result = simplifyRemoteSelectionRects([rect(0, 0, 100), rect(0, 10, 100), rect(0, 20, 100)], ALL)
    expect(result).toEqual([{ pageIndex: 0, x: 0, y: 100, width: 30, height: 12 }])
  })

  it('间隙 ≤2px 仍算相接；更大的间隙不合并', () => {
    expect(simplifyRemoteSelectionRects([rect(0, 0, 0), rect(0, 12, 0)], ALL)).toHaveLength(1)
    expect(simplifyRemoteSelectionRects([rect(0, 0, 0), rect(0, 13, 0)], ALL)).toHaveLength(2)
  })

  it('不同行、不同页不合并；输出按页、行、列排好序', () => {
    const result = simplifyRemoteSelectionRects([rect(1, 0, 0), rect(0, 0, 30), rect(0, 0, 0)], ALL)
    expect(result.map((item) => [item.pageIndex, item.y])).toEqual([[0, 0], [0, 30], [1, 0]])
  })

  it('页窗口之外的矩形丢掉（窗口两端含）', () => {
    const result = simplifyRemoteSelectionRects([rect(0, 0, 0), rect(2, 0, 0), rect(3, 0, 0), rect(5, 0, 0)], { start: 2, end: 3 })
    expect(result.map((item) => item.pageIndex)).toEqual([2, 3])
  })

  it('无效矩形（零宽高、NaN、非整页号）被丢弃，不会污染合并', () => {
    const result = simplifyRemoteSelectionRects(
      [rect(0, 0, 0, 0, 12), rect(0, 0, 0, 10, 0), rect(0, Number.NaN, 0), rect(1.5, 0, 0), rect(0, 0, 0)],
      ALL,
    )
    expect(result).toEqual([{ pageIndex: 0, x: 0, y: 0, width: 10, height: 12 }])
  })

  it('超过上限时总数压到上限以内，且每页至少保留一块', () => {
    // 3 页，每页 50 行 → 150 条互不相接的行
    const rects: PresenceRect[] = []
    for (let page = 0; page < 3; page += 1) for (let line = 0; line < 50; line += 1) rects.push(rect(page, 0, line * 20))
    const result = simplifyRemoteSelectionRects(rects, ALL)
    expect(result.length).toBeLessThanOrEqual(REMOTE_PRESENCE_MAX_RECTS)
    for (let page = 0; page < 3; page += 1) expect(result.some((item) => item.pageIndex === page)).toBe(true)
  })

  it('超限合并后的块仍然盖住原来所有的行（外包矩形，不漏）', () => {
    const rects: PresenceRect[] = []
    for (let line = 0; line < 200; line += 1) rects.push(rect(0, 5, line * 20))
    const result = simplifyRemoteSelectionRects(rects, ALL)
    const top = Math.min(...result.map((item) => item.y))
    const bottom = Math.max(...result.map((item) => item.y + item.height))
    expect(top).toBe(0)
    expect(bottom).toBe(199 * 20 + 12)
  })

  it('碎片多的页拿到更多名额', () => {
    const rects: PresenceRect[] = []
    for (let line = 0; line < 100; line += 1) rects.push(rect(0, 0, line * 20))
    for (let line = 0; line < 10; line += 1) rects.push(rect(1, 0, line * 20))
    const result = simplifyRemoteSelectionRects(rects, ALL)
    const onPage = (page: number) => result.filter((item) => item.pageIndex === page).length
    expect(onPage(0)).toBeGreaterThan(onPage(1))
    expect(onPage(1)).toBeGreaterThanOrEqual(1)
  })

  it('不改传入的数组与矩形', () => {
    const input = [rect(0, 0, 0), rect(0, 10, 0)]
    const snapshot = JSON.stringify(input)
    simplifyRemoteSelectionRects(input, ALL)
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it('空输入返回空数组', () => {
    expect(simplifyRemoteSelectionRects([], ALL)).toEqual([])
  })
})
