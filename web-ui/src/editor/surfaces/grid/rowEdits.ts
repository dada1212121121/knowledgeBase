/**
 * 待写入新行的增删：本地 CSV、协同房间、服务端分页三种适配器共用。
 *
 * 新行用 {@link InsertedRow} 表示：`at` 是「插在底表第几行之前」，同一个 `at` 的新行按数组顺序排。
 * 这里全是纯函数，返回新数组，不改入参——撤销栈里保存的旧数组因此永远有效。
 */
import type { GridCell, GridSheet } from './types'
import type { InsertedRow, RowLayout } from './rowLayout'

/** 待写入的新行在网格里的底色：提示「这一行还没写进文件，填了内容才算」 */
export const PENDING_ROW_TINT = 'rgba(79, 70, 229, 0.07)'
/** 改过、还没保存的格子底色（服务端分页表的草稿） */
export const CHANGED_CELL_TINT = 'rgba(217, 119, 6, 0.14)'

/** 一次最多插多少个空行：选中几行就插几行，但不让一次误操作插出几万行 */
export const MAX_INSERT_ROWS = 100

/**
 * 在视图第 `viewAt` 行的位置插入 `count` 个空行（原来在这个位置的行被顺到下面）。
 * `viewAt` 等于总行数就是加在最后。返回新数组，新行的编号由 `nextId` 分配。
 */
export function placeBlankRows(rows: readonly InsertedRow[], layout: RowLayout, baseCount: number, viewAt: number, count: number, nextId: () => number): InsertedRow[] {
  const amount = Math.min(Math.max(0, Math.floor(count)), MAX_INSERT_ROWS)
  if (amount === 0) return [...rows]
  const target = layout.at(Math.min(Math.max(0, viewAt), layout.count))
  const created = (at: number): InsertedRow[] => Array.from({ length: amount }, () => ({ id: nextId(), at, values: [] }))
  const next = [...rows]
  if (target?.kind === 'inserted') {
    // 插在某个待写入新行的上面：数组里排在它前面，视图里就在它上面
    const index = next.findIndex((row) => row.id === target.inserted.id)
    next.splice(index < 0 ? next.length : index, 0, ...created(target.inserted.at))
    return next
  }
  // 插在底表某行之前（或最后）：同位置的新行都已经在它上面，追加到数组末尾就是紧贴它的上方
  next.push(...created(target?.kind === 'base' ? target.row : baseCount))
  return next
}

/** 去掉若干新行（被删除、或已经写进底表） */
export function dropInserted(rows: readonly InsertedRow[], ids: ReadonlySet<number>): InsertedRow[] {
  return rows.filter((row) => !ids.has(row.id))
}

/**
 * 有些新行写进底表之后，剩下的新行要跟着挪：底表多出来的行排在它们前面时，`at` 加一。
 * 「排在前面」按视图顺序算（先看 `at`，同一个 `at` 看数组顺序）。
 */
export function settleAfterMaterialize(rows: readonly InsertedRow[], materialized: ReadonlySet<number>): InsertedRow[] {
  const ordered = rows.map((row, index) => ({ row, index })).sort((left, right) => left.row.at - right.row.at || left.index - right.index)
  const shifted = new Map<number, InsertedRow>()
  let before = 0
  for (const { row } of ordered) {
    if (materialized.has(row.id)) {
      before += 1
      continue
    }
    shifted.set(row.id, before ? { ...row, at: row.at + before } : row)
  }
  // 保持原数组顺序（同一个 at 的先后就是视图先后）
  return rows.flatMap((row) => {
    const next = shifted.get(row.id)
    return next ? [next] : []
  })
}

/** 新行是不是还一个字都没填 */
export const isBlankRow = (values: readonly string[]): boolean => values.every((value) => value === '')

/**
 * 删掉底表若干行之后，剩下的新行要跟着上移：锚点之前每少一行，`at` 减一。
 * `deletedBase` 是被删的底表行号（升序）。
 */
export function settleAfterDelete(rows: readonly InsertedRow[], deletedBase: readonly number[]): InsertedRow[] {
  if (!deletedBase.length) return [...rows]
  return rows.map((row) => {
    // 二分数「行号 < at」的被删行
    let low = 0
    let high = deletedBase.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (deletedBase[mid]! < row.at) low = mid + 1
      else high = mid
    }
    return low ? { ...row, at: row.at - low } : row
  })
}

/**
 * 把「底表 + 新行」包成一张网格表：新行显示成带底色的空行，其余原样取底表。
 * 没有新行时直接返回底表，不多包一层。
 */
export function withInsertedRows(base: GridSheet, layout: RowLayout): GridSheet {
  if (layout.insertedViews().length === 0 && layout.count === base.rowCount) return base
  return {
    name: base.name,
    rowCount: layout.count,
    colCount: base.colCount,
    columnWidth: base.columnWidth,
    cell(row: number, col: number): GridCell | null {
      const source = layout.at(row)
      if (!source || col < 0 || col >= base.colCount) return null
      if (source.kind === 'base') return base.cell(source.row, col)
      return { text: source.inserted.values[col] ?? '', background: PENDING_ROW_TINT }
    },
  }
}
