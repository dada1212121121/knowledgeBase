/**
 * 待写入新行的增删：位置计算错一位，用户就会把内容填到别的行里。
 */
import { describe, expect, it } from 'vitest'
import { dropInserted, isBlankRow, placeBlankRows, settleAfterDelete, settleAfterMaterialize, withInsertedRows } from './rowEdits'
import { RowLayout, type InsertedRow } from './rowLayout'
import type { GridSheet } from './types'

const ids = (start = 1) => {
  let next = start
  return () => next++
}
const order = (layout: RowLayout) =>
  Array.from({ length: layout.count }, (_, view) => {
    const source = layout.at(view)
    return source?.kind === 'base' ? `b${source.row}` : `i${source?.kind === 'inserted' ? source.inserted.id : '?'}`
  })

describe('placeBlankRows', () => {
  it('1. 在底表某行的位置插入：新行出现在它上面，原来的行下移', () => {
    const layout = new RowLayout(3)
    const rows = placeBlankRows([], layout, 3, 1, 2, ids())
    expect(order(new RowLayout(3, rows))).toEqual(['b0', 'i1', 'i2', 'b1', 'b2'])
  })

  it('2. 插在最后（视图行 = 总行数）', () => {
    const rows = placeBlankRows([], new RowLayout(2), 2, 2, 1, ids())
    expect(order(new RowLayout(2, rows))).toEqual(['b0', 'b1', 'i1'])
  })

  it('3. 已经有新行的位置再插：紧贴目标行上方，不插进别的新行中间', () => {
    const first = placeBlankRows([], new RowLayout(2), 2, 1, 1, ids())
    // 视图：b0 i1 b1。在 b1（视图 2）的位置再插一行 → b0 i1 i2 b1
    const second = placeBlankRows(first, new RowLayout(2, first), 2, 2, 1, ids(2))
    expect(order(new RowLayout(2, second))).toEqual(['b0', 'i1', 'i2', 'b1'])
    // 在 i1（视图 1）的位置再插一行 → b0 i3 i1 i2 b1
    const third = placeBlankRows(second, new RowLayout(2, second), 2, 1, 1, ids(3))
    expect(order(new RowLayout(2, third))).toEqual(['b0', 'i3', 'i1', 'i2', 'b1'])
  })

  it('4. 一次最多 100 行，count 为 0 不改', () => {
    expect(placeBlankRows([], new RowLayout(1), 1, 0, 500, ids())).toHaveLength(100)
    expect(placeBlankRows([], new RowLayout(1), 1, 0, 0, ids())).toEqual([])
  })

  it('5. 空表：插在位置 0', () => {
    const rows = placeBlankRows([], new RowLayout(0), 0, 0, 1, ids())
    expect(order(new RowLayout(0, rows))).toEqual(['i1'])
  })
})

describe('落地后的位置修正', () => {
  const rows: InsertedRow[] = [
    { id: 1, at: 1, values: [] },
    { id: 2, at: 1, values: [] },
    { id: 3, at: 3, values: [] },
  ]

  it('6. 一个新行写进底表后，排在它后面的新行 at 加一，前面的不动', () => {
    const next = settleAfterMaterialize(rows, new Set([1]))
    expect(next.map((row) => [row.id, row.at])).toEqual([
      [2, 2],
      [3, 4],
    ])
    // 写进去的是同位置里排在后面的那个：前面的那个仍在它上面
    const second = settleAfterMaterialize(rows, new Set([2]))
    expect(second.map((row) => [row.id, row.at])).toEqual([
      [1, 1],
      [3, 4],
    ])
  })

  it('7. 删掉底表行后，锚点在它之后的新行 at 减去被删的行数', () => {
    const next = settleAfterDelete(rows, [0, 1])
    expect(next.map((row) => row.at)).toEqual([0, 0, 1])
    expect(settleAfterDelete(rows, [])).toEqual(rows)
  })

  it('8. dropInserted / isBlankRow', () => {
    expect(dropInserted(rows, new Set([2])).map((row) => row.id)).toEqual([1, 3])
    expect(isBlankRow([])).toBe(true)
    expect(isBlankRow(['', ''])).toBe(true)
    expect(isBlankRow(['', 'x'])).toBe(false)
  })
})

describe('withInsertedRows', () => {
  const base: GridSheet = { name: 't', rowCount: 2, colCount: 2, cell: (row, col) => ({ text: `${row}${col}` }) }

  it('9. 没有新行时原样返回底表', () => {
    expect(withInsertedRows(base, new RowLayout(2))).toBe(base)
  })

  it('10. 新行显示为带底色的空行（或已填的内容），其余读底表', () => {
    const rows: InsertedRow[] = [{ id: 1, at: 1, values: ['x'] }]
    const sheet = withInsertedRows(base, new RowLayout(2, rows))
    expect(sheet.rowCount).toBe(3)
    expect(sheet.cell(0, 1)?.text).toBe('01')
    expect(sheet.cell(1, 0)).toMatchObject({ text: 'x', background: expect.any(String) })
    expect(sheet.cell(1, 1)?.text).toBe('')
    expect(sheet.cell(2, 0)?.text).toBe('10')
    expect(sheet.cell(3, 0)).toBeNull()
  })
})
