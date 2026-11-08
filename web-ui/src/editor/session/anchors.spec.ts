import { describe, expect, it } from 'vitest'
import {
  anchorKey,
  clampAnchor,
  dedupeAnchors,
  sameAnchor,
  shiftTextAnchor,
  sortTextAnchors,
  textAnchorRange,
  textAnchorsOverlap,
} from './Anchors'
import type { Anchor } from '../types'

const textAnchor = (offset: number, length?: number, block = 'b1'): Anchor =>
  length === undefined ? { kind: 'text', block, offset } : { kind: 'text', block, offset, length }

describe('Anchors：跨格式锚点与偏移维护', () => {
  it('25. sameAnchor 比较稳定键，忽略 quote / 展示辅助字段', () => {
    const a: Anchor = { kind: 'text', block: 'b1', offset: 3, length: 2 }
    const b: Anchor = { kind: 'text', block: 'b1', offset: 3, length: 2, quote: '引用文字' }
    expect(sameAnchor(a, b)).toBe(true)
    expect(sameAnchor(a, textAnchor(4, 2))).toBe(false)
    expect(sameAnchor(a, null)).toBe(false)
    // 不同 kind 即使字段巧合也不能相等
    expect(sameAnchor({ kind: 'code', line: 1, column: 1 }, { kind: 'slide', slide: 1 })).toBe(false)
  })

  it('26. anchorKey 对六类锚点都给出稳定且可读的键', () => {
    expect(anchorKey({ kind: 'text', block: 'b1', offset: 3, length: 2 })).toBe('text:b1:3:2')
    expect(anchorKey({ kind: 'cell', sheet: 'S1', cell: 'A1' })).toBe('cell:S1:A1')
    expect(anchorKey({ kind: 'page', page: 2, text: '标题' })).toBe('page:2:标题')
    expect(anchorKey({ kind: 'slide', slide: 0, shape: 's1' })).toBe('slide:0:s1:0')
    expect(anchorKey({ kind: 'code', line: 10, column: 4 })).toBe('code:10:4:0')
    expect(anchorKey({ kind: 'pdf', page: 1, rect: { x: 1, y: 2, width: 3, height: 4 } })).toBe('pdf:1:1,2,3,4')
  })

  it('27. 编辑落在锚点之后：锚点完全不动', () => {
    const anchor = textAnchor(2, 3) // [2,5)
    expect(shiftTextAnchor(anchor, { block: 'b1', from: 5, removed: 0, inserted: 4 })).toEqual(anchor)
    expect(shiftTextAnchor(anchor, { block: 'b1', from: 8, removed: 2, inserted: 0 })).toEqual(anchor)
  })

  it('28. 编辑完全在锚点之前：整体平移 delta', () => {
    const anchor = textAnchor(10, 2)
    // 前面插入 3 个字符 → 锚点右移 3
    expect(shiftTextAnchor(anchor, { block: 'b1', from: 2, removed: 0, inserted: 3 })).toEqual(
      textAnchor(13, 2),
    )
    // 前面删除 4 个字符 → 锚点左移 4，且不会小于 0
    expect(shiftTextAnchor(anchor, { block: 'b1', from: 0, removed: 4, inserted: 0 })).toEqual(
      textAnchor(6, 2),
    )
    // 删除区间完全覆盖了锚点 → 锚点连同文本一起消失，收敛为编辑起点的零长锚点
    expect(shiftTextAnchor(textAnchor(1, 1), { block: 'b1', from: 0, removed: 9, inserted: 0 })).toEqual(
      textAnchor(0, 0),
    )
  })

  it('29. 编辑落在锚点区间内部：起点不动、长度按 delta 伸缩且不为负', () => {
    const anchor = textAnchor(4, 6) // [4,10)
    expect(shiftTextAnchor(anchor, { block: 'b1', from: 6, removed: 1, inserted: 3 })).toEqual(
      textAnchor(4, 8),
    )
    // 删掉区间内 6 个字符中最多的部分，也不能出现负长度
    expect(shiftTextAnchor(anchor, { block: 'b1', from: 4, removed: 6, inserted: 0 })).toEqual(
      textAnchor(4, 0),
    )
  })

  it('30. 编辑覆盖锚点起点：起点收敛到编辑起点，长度归零', () => {
    const anchor = textAnchor(5, 4) // [5,9)
    expect(shiftTextAnchor(anchor, { block: 'b1', from: 3, removed: 4, inserted: 1 })).toEqual(
      textAnchor(3, 0),
    )
  })

  it('31. 不同块的编辑不影响锚点', () => {
    const anchor = textAnchor(5, 4, 'b2')
    expect(shiftTextAnchor(anchor, { block: 'b1', from: 0, removed: 100, inserted: 0 })).toEqual(anchor)
  })

  it('32. 非 text 锚点不参与文本偏移修正', () => {
    const cell: Anchor = { kind: 'cell', sheet: 'S1', cell: 'B2' }
    expect(shiftTextAnchor(cell, { block: 'b1', from: 0, removed: 5, inserted: 0 })).toEqual(cell)
  })

  it('33. clampAnchor 把文本偏移与长度夹进合法范围', () => {
    expect(clampAnchor(textAnchor(20, 10), { maxOffset: 15 })).toEqual(textAnchor(15, 0))
    expect(clampAnchor(textAnchor(-5, 2), { maxOffset: 100 })).toEqual(textAnchor(0, 2))
  })

  it('34. clampAnchor 对 code / page / slide / pdf 分别按各自基准夹取', () => {
    expect(clampAnchor({ kind: 'code', line: 0, column: 0 }, { lineCount: 30, columnCount: 80 })).toEqual({
      kind: 'code',
      line: 1,
      column: 1,
    })
    expect(clampAnchor({ kind: 'page', page: 99, text: 'x' }, { pageCount: 12 })).toEqual({
      kind: 'page',
      page: 12,
      text: 'x',
    })
    expect(clampAnchor({ kind: 'slide', slide: -3 }, { slideCount: 5 })).toEqual({ kind: 'slide', slide: 0 })
    expect(
      clampAnchor({ kind: 'pdf', page: 9, rect: { x: -1, y: -2, width: -3, height: 4 } }, { pageCount: 3 }),
    ).toEqual({ kind: 'pdf', page: 3, rect: { x: 0, y: 0, width: 0, height: 4 } })
  })

  it('35. cell 锚点不参与夹取（由 Sheet Surface 结合工作表尺寸处理）', () => {
    const cell: Anchor = { kind: 'cell', sheet: 'S1', cell: 'ZZ999' }
    expect(clampAnchor(cell, { maxOffset: 0 })).toBe(cell)
  })

  it('36. textAnchorRange 与 textAnchorsOverlap 判定区间相交', () => {
    expect(textAnchorRange(textAnchor(3, 4))).toEqual({ start: 3, end: 7 })
    expect(textAnchorRange(textAnchor(3))).toEqual({ start: 3, end: 3 })
    expect(textAnchorRange({ kind: 'code', line: 1, column: 1 })).toBeNull()

    expect(textAnchorsOverlap(textAnchor(3, 4), textAnchor(5, 4))).toBe(true)
    expect(textAnchorsOverlap(textAnchor(3, 4), textAnchor(7, 4))).toBe(false)
    // 不同块不重叠，即使偏移相同
    expect(textAnchorsOverlap(textAnchor(3, 4, 'b1'), textAnchor(3, 4, 'b2'))).toBe(false)
  })

  it('37. sortTextAnchors 按给定块序与块内偏移排序', () => {
    const anchors: Anchor[] = [textAnchor(5, 1, 'b3'), textAnchor(9, 1, 'b1'), textAnchor(2, 1, 'b1')]
    const sorted = sortTextAnchors(anchors, ['b1', 'b2', 'b3'])
    expect(sorted.map((a) => anchorKey(a))).toEqual(['text:b1:2:1', 'text:b1:9:1', 'text:b3:5:1'])
  })

  it('38. dedupeAnchors 同键只保留第一个', () => {
    const anchors: Anchor[] = [textAnchor(1, 2), textAnchor(1, 2), textAnchor(3, 1)]
    expect(dedupeAnchors(anchors)).toHaveLength(2)
  })
})
