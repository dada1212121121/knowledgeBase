/**
 * 网格几何
 *
 * 为什么单独成文件：滚动时每一帧都要回答「现在该画哪几行/列」「这个坐标落在哪一格」。
 * 如果把这些计算写进 Vue 组件，scroll 事件会把整棵组件树唤醒；这里用纯函数 + 预计算轨道偏移，
 * 滚动只调用 `visibleRange` / `cellRect`，不触碰响应式状态。
 *
 * 坐标约定：row / col 从 0 开始；scrollTop / scrollLeft 是内容坐标（不含表头）。
 */

import type { CellCoord, GridRange, GridViewport, VisibleRange } from './types'

/** 默认行高 / 列宽（CSS px）；与 Excel 默认视觉接近，真实尺寸可由数据源覆盖 */
export const DEFAULT_ROW_HEIGHT = 24
export const DEFAULT_COL_WIDTH = 96
/** 行号列 / 列标行的固定尺寸；view 绘制表头时使用，geometry 不把它算进内容坐标 */
export const HEADER_WIDTH = 44
export const HEADER_HEIGHT = 24

export interface GridGeometryOptions {
  rowCount: number
  colCount: number
  defaultRowHeight?: number
  defaultColWidth?: number
  /** 单行高度覆盖；只对显式返回值的行生效 */
  rowHeight?: (row: number) => number | undefined
  /** 单列宽度覆盖 */
  colWidth?: (col: number) => number | undefined
}

/** 二分查找：offsets 是递增的轨道边界，返回包含 value 的轨道下标 */
function trackAt(offsets: Float64Array, value: number): number {
  const count = offsets.length - 1
  if (count <= 0) return 0
  if (value <= 0) return 0
  if (value >= offsets[count]!) return count - 1
  let low = 0
  let high = count - 1
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2)
    if (offsets[mid]! <= value) low = mid
    else high = mid - 1
  }
  return low
}

export class GridGeometry {
  readonly rowCount: number
  readonly colCount: number
  readonly defaultRowHeight: number
  readonly defaultColWidth: number
  /** n + 1 个边界；0 = 内容起点 */
  readonly rowOffsets: Float64Array
  readonly colOffsets: Float64Array

  constructor(options: GridGeometryOptions) {
    this.rowCount = Math.max(0, Math.floor(options.rowCount))
    this.colCount = Math.max(0, Math.floor(options.colCount))
    this.defaultRowHeight = options.defaultRowHeight ?? DEFAULT_ROW_HEIGHT
    this.defaultColWidth = options.defaultColWidth ?? DEFAULT_COL_WIDTH
    this.rowOffsets = new Float64Array(this.rowCount + 1)
    this.colOffsets = new Float64Array(this.colCount + 1)
    for (let row = 0; row < this.rowCount; row += 1) {
      this.rowOffsets[row + 1] = this.rowOffsets[row]! + Math.max(1, options.rowHeight?.(row) ?? this.defaultRowHeight)
    }
    for (let col = 0; col < this.colCount; col += 1) {
      this.colOffsets[col + 1] = this.colOffsets[col]! + Math.max(1, options.colWidth?.(col) ?? this.defaultColWidth)
    }
  }

  get contentWidth(): number {
    return this.colOffsets[this.colCount] ?? 0
  }

  get contentHeight(): number {
    return this.rowOffsets[this.rowCount] ?? 0
  }

  rowTop(row: number): number {
    if (row <= 0) return 0
    if (row >= this.rowCount) return this.contentHeight
    return this.rowOffsets[row]!
  }

  colLeft(col: number): number {
    if (col <= 0) return 0
    if (col >= this.colCount) return this.contentWidth
    return this.colOffsets[col]!
  }

  rowHeight(row: number): number {
    if (row < 0 || row >= this.rowCount) return 0
    return this.rowOffsets[row + 1]! - this.rowOffsets[row]!
  }

  colWidth(col: number): number {
    if (col < 0 || col >= this.colCount) return 0
    return this.colOffsets[col + 1]! - this.colOffsets[col]!
  }

  /** 内容坐标 y 落在哪一行；超出范围返回 -1 */
  rowAtY(y: number): number {
    if (y < 0 || y >= this.contentHeight || this.rowCount === 0) return -1
    return trackAt(this.rowOffsets, y)
  }

  /** 内容坐标 x 落在哪一列；超出范围返回 -1 */
  colAtX(x: number): number {
    if (x < 0 || x >= this.contentWidth || this.colCount === 0) return -1
    return trackAt(this.colOffsets, x)
  }

  /** 可见范围（last 为开区间）；overscan 让滚动时边缘不出现空白 */
  visibleRange(viewport: GridViewport, overscan = 2): VisibleRange {
    if (this.rowCount === 0 || this.colCount === 0) return { firstRow: 0, lastRow: 0, firstCol: 0, lastCol: 0 }
    // 滚到最底部时 scrollTop 可能略大于内容高度，先夹到最后一格，否则会得到空范围
    const top = Math.min(Math.max(0, viewport.scrollTop), Math.max(0, this.contentHeight - 1))
    const left = Math.min(Math.max(0, viewport.scrollLeft), Math.max(0, this.contentWidth - 1))
    // 减一个极小量：视口下边界正好压在轨道边界上时，只应算已完整露出的那一行
    const bottom = Math.min(this.contentHeight - 1, top + Math.max(1, viewport.height) - 0.001)
    const right = Math.min(this.contentWidth - 1, left + Math.max(1, viewport.width) - 0.001)
    const firstRow = Math.max(0, this.rowAtY(top) - overscan)
    const lastRow = Math.min(this.rowCount, this.rowAtY(bottom) + 1 + overscan)
    const firstCol = Math.max(0, this.colAtX(left) - overscan)
    const lastCol = Math.min(this.colCount, this.colAtX(right) + 1 + overscan)
    return { firstRow, lastRow, firstCol, lastCol }
  }

  /** 单元格矩形；合并区域由数据源扩选，不在这里做 */
  cellRect(row: number, col: number): { x: number; y: number; width: number; height: number } {
    return {
      x: this.colLeft(col),
      y: this.rowTop(row),
      width: this.colWidth(col),
      height: this.rowHeight(row),
    }
  }

  /** 选区矩形（含右下边界）；用于绘制虚线选区与复制范围 */
  rangeRect(range: GridRange): { x: number; y: number; width: number; height: number } {
    const left = this.colLeft(range.left)
    const top = this.rowTop(range.top)
    return {
      x: left,
      y: top,
      width: this.colLeft(range.right + 1) - left,
      height: this.rowTop(range.bottom + 1) - top,
    }
  }

  /** 内容坐标命中；用于鼠标 / 触摸 */
  hitTest(x: number, y: number): CellCoord | null {
    const row = this.rowAtY(y)
    const col = this.colAtX(x)
    return row >= 0 && col >= 0 ? { row, col } : null
  }

  /** 让某格完整进入视口；返回修正后的滚动位置，调用方负责写回 DOM */
  scrollToCell(row: number, col: number, viewport: Pick<GridViewport, 'scrollTop' | 'scrollLeft' | 'width' | 'height'>, margin = 8): { scrollTop: number; scrollLeft: number } {
    if (row < 0 || row >= this.rowCount || col < 0 || col >= this.colCount) {
      return { scrollTop: viewport.scrollTop, scrollLeft: viewport.scrollLeft }
    }
    const rect = this.cellRect(row, col)
    let scrollTop = viewport.scrollTop
    let scrollLeft = viewport.scrollLeft
    if (rect.y - margin < scrollTop) scrollTop = Math.max(0, rect.y - margin)
    else if (rect.y + rect.height + margin > scrollTop + viewport.height) scrollTop = Math.max(0, rect.y + rect.height + margin - viewport.height)
    if (rect.x - margin < scrollLeft) scrollLeft = Math.max(0, rect.x - margin)
    else if (rect.x + rect.width + margin > scrollLeft + viewport.width) scrollLeft = Math.max(0, rect.x + rect.width + margin - viewport.width)
    return { scrollTop, scrollLeft }
  }
}
