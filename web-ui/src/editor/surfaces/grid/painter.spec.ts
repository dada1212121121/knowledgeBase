/**
 * Canvas 绘制测试
 *
 * jsdom 没有真实 canvas 像素，这里用一个记录调用的假 ctx 守住两条：
 * 只画可见区的格子（不能把 5 万格全画一遍），以及表头列标正确。
 */
import { describe, expect, it } from 'vitest'
import { GridGeometry } from './geometry'
import { columnLabel, contentViewport, paintGrid, type GridPalette } from './painter'
import type { GridSheet } from './types'

const palette: GridPalette = {
  background: '#fff',
  text: '#000',
  gridline: '#ddd',
  headerBackground: '#f5f5f5',
  headerText: '#333',
  selectionFill: 'rgba(0,0,0,.05)',
  selectionBorder: '#06f',
  activeBorder: '#06f',
}

function fakeCtx() {
  const texts: string[] = []
  const rects: [number, number, number, number][] = []
  const ctx = {
    textAlign: 'left',
    textBaseline: 'alphabetic',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    setTransform: () => undefined,
    clearRect: () => undefined,
    fillRect: (x: number, y: number, w: number, h: number) => rects.push([x, y, w, h]),
    strokeRect: () => undefined,
    beginPath: () => undefined,
    rect: () => undefined,
    clip: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    translate: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    stroke: () => undefined,
    fillText: (text: string) => texts.push(text),
  }
  return { ctx, texts, rects }
}

function sheetWith(cells: Record<string, string>, rows = 100, cols = 30): GridSheet {
  return {
    name: 'Sheet1',
    rowCount: rows,
    colCount: cols,
    cell: (row, col) => {
      const text = cells[`${row}:${col}`]
      return text === undefined ? null : { text }
    },
  }
}

describe('columnLabel', () => {
  it('1. 0/25/26/51/52 的列标', () => {
    expect([0, 25, 26, 51, 52].map(columnLabel)).toEqual(['A', 'Z', 'AA', 'AZ', 'BA'])
  })

  it('2. 负数按 A 处理，不抛异常', () => {
    expect(columnLabel(-3)).toBe('A')
  })
})

describe('contentViewport', () => {
  it('3. 扣掉行号列与列标行', () => {
    expect(contentViewport({ scrollTop: 0, scrollLeft: 0, width: 100, height: 80 })).toEqual({ scrollTop: 0, scrollLeft: 0, width: 56, height: 56 })
  })
})

describe('paintGrid', () => {
  it('4. 只绘制可见区的单元格文本', () => {
    const { ctx, texts } = fakeCtx()
    const sheet = sheetWith({ '0:0': 'A1', '0:1': 'B1', '2:2': 'C3', '99:29': 'far' })
    paintGrid({
      ctx: ctx as unknown as CanvasRenderingContext2D,
      geometry: new GridGeometry({ rowCount: 100, colCount: 30 }),
      sheet,
      viewport: { scrollTop: 0, scrollLeft: 0, width: 260, height: 140 },
      selection: { anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } },
      palette,
    })
    expect(texts).toContain('A1')
    expect(texts).toContain('B1')
    expect(texts).toContain('C3')
    expect(texts).not.toContain('far')
    // 列标与行号也在其中
    expect(texts).toContain('A')
    expect(texts).toContain('1')
  })

  it('5. 滚动后绘制新的可见区，不再绘制已滚出的格子', () => {
    const { ctx, texts } = fakeCtx()
    const sheet = sheetWith({ '0:0': 'A1', '20:0': 'A21' })
    paintGrid({
      ctx: ctx as unknown as CanvasRenderingContext2D,
      geometry: new GridGeometry({ rowCount: 100, colCount: 30 }),
      sheet,
      viewport: { scrollTop: 24 * 20, scrollLeft: 0, width: 260, height: 140 },
      selection: { anchor: { row: 20, col: 0 }, focus: { row: 20, col: 0 } },
      palette,
    })
    expect(texts).toContain('A21')
    expect(texts).not.toContain('A1')
  })

  it('6. 空表也能安全绘制（只有表头）', () => {
    const { ctx, texts } = fakeCtx()
    expect(() =>
      paintGrid({
        ctx: ctx as unknown as CanvasRenderingContext2D,
        geometry: new GridGeometry({ rowCount: 0, colCount: 0 }),
        sheet: { name: 'empty', rowCount: 0, colCount: 0, cell: () => null },
        viewport: { scrollTop: 0, scrollLeft: 0, width: 260, height: 140 },
        selection: { anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } },
        palette,
      }),
    ).not.toThrow()
    expect(texts).toEqual([])
  })
})
