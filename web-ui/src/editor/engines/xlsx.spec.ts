/**
 * XLSX 引擎适配层的纯函数测试
 *
 * 只测可离线验证的部分：单元格地址、选区 reducer、视口命中 / 反算。
 * 真正的 Worker 绘制由浏览器 e2e 覆盖（jsdom 没有 Canvas 与 Worker）。
 */
import { describe, expect, it } from 'vitest'
import {
  XlsxFrame,
  xlsxCellName,
  xlsxExtendSelection,
  xlsxKeySelection,
  xlsxNormalizeRange,
  xlsxSelectAll,
} from './xlsx'

describe('xlsxCellName', () => {
  it('把零基行列转成 A1 地址', () => {
    expect(xlsxCellName(0, 0)).toBe('A1')
    expect(xlsxCellName(9, 25)).toBe('Z10')
    expect(xlsxCellName(0, 26)).toBe('AA1')
    expect(xlsxCellName(99, 27)).toBe('AB100')
  })
})

describe('xlsx selection', () => {
  it('规范化反向选区', () => {
    expect(
      xlsxNormalizeRange({
        anchor: { row: 4, col: 3 },
        focus: { row: 1, col: 0 },
      }),
    ).toEqual({ top: 1, left: 0, bottom: 4, right: 3 })
  })

  it('方向键移动并夹在已用区域内', () => {
    const limits = { rows: 3, cols: 2, rowsPerPage: 2 }
    expect(xlsxKeySelection({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } }, { key: 'ArrowDown' }, limits)).toEqual({
      anchor: { row: 1, col: 0 },
      focus: { row: 1, col: 0 },
    })
    // reducer 在边界返回同一个格；视图随后仍夹在 limits 内，不能把「已到边」当错误
    expect(xlsxKeySelection({ anchor: { row: 2, col: 1 }, focus: { row: 2, col: 1 } }, { key: 'ArrowDown' }, limits)).toEqual({
      anchor: { row: 2, col: 1 },
      focus: { row: 2, col: 1 },
    })
  })

  it('Shift+方向键保持 anchor 并扩展选区', () => {
    expect(
      xlsxKeySelection(
        { anchor: { row: 1, col: 1 }, focus: { row: 1, col: 1 } },
        { key: 'ArrowRight', shiftKey: true },
        { rows: 10, cols: 10, rowsPerPage: 5 },
      ),
    ).toEqual({ anchor: { row: 1, col: 1 }, focus: { row: 1, col: 2 } })
  })

  it('Tab / Home / End 交给 reducer', () => {
    const limits = { rows: 10, cols: 5, rowsPerPage: 4 }
    expect(xlsxKeySelection({ anchor: { row: 2, col: 4 }, focus: { row: 2, col: 4 } }, { key: 'Tab' }, limits)).toEqual({
      anchor: { row: 3, col: 0 },
      focus: { row: 3, col: 0 },
    })
    expect(xlsxKeySelection({ anchor: { row: 4, col: 3 }, focus: { row: 4, col: 3 } }, { key: 'Home' }, limits)).toEqual({
      anchor: { row: 4, col: 0 },
      focus: { row: 4, col: 0 },
    })
    expect(
      xlsxKeySelection(
        { anchor: { row: 4, col: 3 }, focus: { row: 4, col: 3 } },
        { key: 'End', ctrlKey: true },
        limits,
        [],
        { top: 0, left: 0, bottom: 4, right: 4 },
      ),
    ).toEqual({
      anchor: { row: 4, col: 4 },
      focus: { row: 4, col: 4 },
    })
  })

  it('F2 不进编辑；Enter 只做向下移动', () => {
    const limits = { rows: 10, cols: 5, rowsPerPage: 4 }
    expect(xlsxKeySelection({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } }, { key: 'F2' }, limits)).toBeNull()
    expect(xlsxKeySelection({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } }, { key: 'Enter' }, limits)).toEqual({
      anchor: { row: 1, col: 0 },
      focus: { row: 1, col: 0 },
    })
  })

  it('Shift+点击按二维边界夹住 focus', () => {
    expect(
      xlsxExtendSelection({ anchor: { row: 1, col: 1 }, focus: { row: 1, col: 1 } }, { row: 99, col: -3 }, { rows: 10, cols: 5, rowsPerPage: 4 }),
    ).toEqual({ anchor: { row: 1, col: 1 }, focus: { row: 9, col: 0 } })
  })

  it('全选已用区域', () => {
    expect(xlsxSelectAll({ top: 1, left: 2, bottom: 4, right: 6 })).toEqual({
      anchor: { row: 1, col: 2 },
      focus: { row: 4, col: 6 },
    })
  })
})

describe('XlsxFrame viewport math', () => {
  const frame = new XlsxFrame(
    {
      width: 100,
      height: 60,
      commands: [],
      grid: {
        startRow: 0,
        startCol: 0,
        rowIndices: [0, 1, 2, 3],
        colIndices: [0, 1],
        rowOffsets: [0, 20, 40, 60],
        colOffsets: [0, 50, 100],
      },
    } as never,
    [{ start: { row: 1, col: 0 }, end: { row: 2, col: 1 } }],
  )

  it('点命中单元格', () => {
    expect(frame.cellAtPoint(25, 10)).toEqual({ row: 0, col: 0 })
    expect(frame.cellAtPoint(75, 45)).toEqual({ row: 2, col: 1 })
    expect(frame.cellAtPoint(120, 10)).toBeNull()
  })

  it('单元格与选区反算成矩形', () => {
    expect(frame.cellRect(0, 1)).toEqual({ x: 50, y: 0, w: 50, h: 20 })
    expect(frame.rangeRect({ top: 1, left: 0, bottom: 2, right: 1 })).toEqual({ x: 0, y: 20, w: 100, h: 40 })
    expect(frame.cellRect(9, 9)).toBeNull()
  })

  it('保留合并区域给选区展开', () => {
    expect(frame.mergedRanges).toEqual([{ top: 1, left: 0, bottom: 2, right: 1 }])
  })
})
