/**
 * 网格选区与键盘移动
 *
 * 选区规则刻意按 Excel / WPS 的习惯：
 * - 方向键移动活动格；Shift + 方向键只动 focus，anchor 不动；
 * - Ctrl / ⌘ + 方向键跳到数据边界（没有数据源时跳到整表边界，行为稳定且可预期）；
 * - Tab / Shift+Tab 左右移动，Enter / Shift+Enter 上下移动；
 * - 合并单元格落在哪一格都扩成整块，避免只选中左上角却显示整块。
 */

import type { CellCoord, GridKeyAction, GridRange, GridSelection } from './types'

export interface GridBounds {
  rowCount: number
  colCount: number
}

export interface MoveOptions {
  bounds: GridBounds
  /** PageUp / PageDown 一次跨多少行 */
  pageSize?: number
  /** 合并区：命中其中任意格时把选区扩到整块 */
  mergedRanges?: readonly GridRange[]
}

/** 把坐标夹在表内；空表返回 {0,0}，调用方仍可安全绘制 */
export function clampCoord(coord: CellCoord, bounds: GridBounds): CellCoord {
  const row = Math.min(Math.max(0, Math.floor(coord.row)), Math.max(0, bounds.rowCount - 1))
  const col = Math.min(Math.max(0, Math.floor(coord.col)), Math.max(0, bounds.colCount - 1))
  return { row, col }
}

/** 选区转矩形；越界坐标先夹紧 */
export function normalizeRange(selection: GridSelection, bounds?: GridBounds): GridRange {
  const anchor = bounds ? clampCoord(selection.anchor, bounds) : selection.anchor
  const focus = bounds ? clampCoord(selection.focus, bounds) : selection.focus
  return {
    top: Math.min(anchor.row, focus.row),
    left: Math.min(anchor.col, focus.col),
    bottom: Math.max(anchor.row, focus.row),
    right: Math.max(anchor.col, focus.col),
  }
}

/** 单格选区 */
export function cellSelection(row: number, col: number): GridSelection {
  return { anchor: { row, col }, focus: { row, col } }
}

/** 选区是否只有一个格子 */
export function isSingleCell(selection: GridSelection): boolean {
  return selection.anchor.row === selection.focus.row && selection.anchor.col === selection.focus.col
}

/** 选区内是否包含某格 */
export function selectionContains(selection: GridSelection, row: number, col: number): boolean {
  const range = normalizeRange(selection)
  return row >= range.top && row <= range.bottom && col >= range.left && col <= range.right
}

/** 整行选择；整行是一个完整矩形，活动格由 view 单独记录 */
export function selectRow(row: number, colCount: number): GridSelection {
  const last = Math.max(0, colCount - 1)
  return { anchor: { row, col: 0 }, focus: { row, col: last } }
}

/** 整列选择 */
export function selectColumn(col: number, rowCount: number): GridSelection {
  const last = Math.max(0, rowCount - 1)
  return { anchor: { row: 0, col }, focus: { row: last, col } }
}

/** 全选 */
export function selectAll(bounds: GridBounds): GridSelection {
  return {
    anchor: { row: 0, col: 0 },
    focus: { row: Math.max(0, bounds.rowCount - 1), col: Math.max(0, bounds.colCount - 1) },
  }
}

/** 把坐标扩到它所在的合并区（若在合并区内） */
export function expandMerged(coord: CellCoord, mergedRanges: readonly GridRange[] | undefined): GridRange | null {
  if (!mergedRanges?.length) return null
  return (
    mergedRanges.find((range) => coord.row >= range.top && coord.row <= range.bottom && coord.col >= range.left && coord.col <= range.right) ?? null
  )
}

/**
 * 执行一次键盘移动。返回新的选区；调用方只改活动格时传 extend=false。
 * 超出表边界时保持原位（不环绕），和 Excel 一致。
 */
export function moveSelection(selection: GridSelection, action: Extract<GridKeyAction, { kind: 'move' | 'page' }>, options: MoveOptions): GridSelection {
  const { bounds } = options
  if (bounds.rowCount <= 0 || bounds.colCount <= 0) return selection
  const focus = clampCoord(selection.focus, bounds)
  let next: CellCoord = { ...focus }
  if (action.kind === 'page') {
    const step = Math.max(1, options.pageSize ?? 20)
    next.row = focus.row + (action.direction === 'down' ? step : -step)
  } else {
    if (action.jump) {
      // Ctrl / ⌘ + 方向：直接到边界。真实数据边界属于数据源，后续由适配器覆盖；
      // 这里先保证「有明确终点」，不会出现按了没反应。
      if (action.rowDelta < 0) next.row = 0
      else if (action.rowDelta > 0) next.row = bounds.rowCount - 1
      if (action.colDelta < 0) next.col = 0
      else if (action.colDelta > 0) next.col = bounds.colCount - 1
    } else {
      next.row += action.rowDelta
      next.col += action.colDelta
    }
  }
  next = clampCoord(next, bounds)

  const merged = expandMerged(next, options.mergedRanges)
  if (merged) {
    // 合并区整块选中：anchor 放左上，focus 放右下，后续复制/清除都按整块处理
    next = action.extend ? { row: merged.bottom, col: merged.right } : { row: merged.top, col: merged.left }
    return action.extend ? { anchor: selection.anchor, focus: next } : { anchor: next, focus: next }
  }

  if (action.extend) return { anchor: selection.anchor, focus: next }
  return { anchor: next, focus: next }
}

/** 键盘事件 → 网格动作；平台修饰键与浏览器保留键都在这里统一判断 */
export function resolveGridKey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>, editing = false): GridKeyAction {
  // 编辑态下方向键属于输入框（光标移动），不能抢；只保留 Escape / Enter 由 overlay 自己处理
  if (editing) return null
  const mod = event.ctrlKey || event.metaKey
  const key = event.key
  if (event.altKey) return null
  if (mod && key.toLowerCase() === 'a') return { kind: 'selectAll' }
  if (mod && key.toLowerCase() === 'c') return { kind: 'copy' }
  if (mod && key.toLowerCase() === 'x') return { kind: 'cut' }
  if (mod && key.toLowerCase() === 'v') return { kind: 'paste' }
  if (mod && key.toLowerCase() === 'z') return event.shiftKey ? { kind: 'redo' } : { kind: 'undo' }
  if (mod && key.toLowerCase() === 'y') return { kind: 'redo' }
  if (mod && key.toLowerCase() === 'f') return { kind: 'find' }
  if (key === 'F2') return { kind: 'edit' }
  if (key === 'Delete' || key === 'Backspace') return { kind: 'clear' }

  const extend = event.shiftKey
  if (key === 'ArrowUp') return { kind: 'move', rowDelta: -1, colDelta: 0, extend, jump: mod }
  if (key === 'ArrowDown') return { kind: 'move', rowDelta: 1, colDelta: 0, extend, jump: mod }
  if (key === 'ArrowLeft') return { kind: 'move', rowDelta: 0, colDelta: -1, extend, jump: mod }
  if (key === 'ArrowRight') return { kind: 'move', rowDelta: 0, colDelta: 1, extend, jump: mod }
  if (key === 'Tab') return { kind: 'move', rowDelta: 0, colDelta: extend ? -1 : 1, extend: false, jump: false }
  if (key === 'Enter') return { kind: 'move', rowDelta: extend ? -1 : 1, colDelta: 0, extend: false, jump: false }
  if (key === 'Home') return { kind: 'move', rowDelta: mod ? -1 : 0, colDelta: -1, extend, jump: true }
  if (key === 'End') return { kind: 'move', rowDelta: mod ? 1 : 0, colDelta: 1, extend, jump: true }
  if (key === 'PageUp') return { kind: 'page', direction: 'up', extend }
  if (key === 'PageDown') return { kind: 'page', direction: 'down', extend }
  // 可打印字符进入编辑：这是 Excel 的默认行为；不把空格当移动，空格也是合法输入
  if (key.length === 1 && !mod) return { kind: 'edit' }
  return null
}
