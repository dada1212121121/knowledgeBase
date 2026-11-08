/**
 * 表格编辑命令：增删行列、列对齐、Tab 跳格
 *
 * 为什么自己写而不用 prosemirror-tables：房间格式要求节点名与旧编辑器一致（表头行 table_header_row / 数据行 table_row /
 * 表头格 table_header / 数据格 table_cell，见 schema.ts），prosemirror-tables 的命令按 tableRole 找行类型，
 * 两种行共用 'row' 角色时只会认其中一个，新增的行类型会错；它也不是 package.json 的直接依赖。
 * 这几个命令各自只做一件事，且都按「表头行不能删、新行总是数据行」这条旧编辑器的规矩来。
 *
 * 旧编辑器（Crepe 的 Table 功能）的对应能力：行列手柄上的“在上方 / 下方插入行”“在左 / 右插入列”“删除行 / 列”“对齐方式”；
 * 新编辑器把它们放在光标进入表格时出现的浮动工具条上（floatingTools.ts），并支持 Tab / Shift+Tab 在格间跳转。
 */
import { TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state'
import type { Node as PMNode, Schema } from 'prosemirror-model'
import type { TableAlignment } from './schema'

export interface TableContext {
  /** 表格节点的起点 */
  tablePos: number
  table: PMNode
  /** 光标所在行 / 列（从 0 起；0 行是表头行） */
  row: number
  col: number
}

const isCell = (node: PMNode) => node.type.name === 'table_cell' || node.type.name === 'table_header'

/** 光标是否在表格里；不在返回 null */
export function tableContext(state: EditorState): TableContext | null {
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 1; depth -= 1) {
    if (!isCell($from.node(depth))) continue
    const tableDepth = depth - 2
    const table = $from.node(tableDepth)
    if (table.type.name !== 'table') return null
    return { tablePos: $from.before(tableDepth), table, row: $from.index(tableDepth), col: $from.index(depth - 1) }
  }
  return null
}

export function isInTable(state: EditorState): boolean {
  return tableContext(state) !== null
}

/** 表格里每一行的起点（文档绝对位置） */
function rowStarts(ctx: TableContext): number[] {
  const out: number[] = []
  ctx.table.forEach((_row, offset) => out.push(ctx.tablePos + 1 + offset))
  return out
}

/** 某一行里第 col 个格子的起点；格子数不够返回 -1 */
function cellStart(rowStart: number, row: PMNode, col: number): number {
  if (col >= row.childCount) return -1
  let pos = rowStart + 1
  for (let i = 0; i < col; i += 1) pos += row.child(i).nodeSize
  return pos
}

/** 每格恰好一个段落：旧编辑器的单元格只允许一个段落，协同房间里多出来的段落它不认 */
function emptyCell(schema: Schema, header: boolean, alignment: TableAlignment): PMNode {
  const type = header ? schema.nodes.table_header : schema.nodes.table_cell
  return type.create({ alignment }, schema.nodes.paragraph.create())
}

function selectCell(tr: Transaction, pos: number): Transaction {
  // pos 是格子起点；+1 进入格子内部，near 落到段落里
  return tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos + 1, tr.doc.content.size)), 1))
}

/** 在当前行的上方 / 下方插入一行。表头行上方不能插（表头必须是第一行） */
export function addRow(schema: Schema, where: 'before' | 'after'): Command {
  return (state, dispatch) => {
    const ctx = tableContext(state)
    if (!ctx) return false
    if (where === 'before' && ctx.row === 0) return false
    const starts = rowStarts(ctx)
    const ref = ctx.table.child(ctx.row)
    const cells: PMNode[] = []
    ref.forEach((cell) => cells.push(emptyCell(schema, false, (cell.attrs.alignment as TableAlignment) ?? null)))
    const row = schema.nodes.table_row.create(null, cells)
    const at = where === 'before' ? starts[ctx.row]! : starts[ctx.row]! + ref.nodeSize
    if (dispatch) {
      const tr = state.tr.insert(at, row)
      dispatch(selectCell(tr, at + 1).scrollIntoView())
    }
    return true
  }
}

/** 在当前列的左 / 右插入一列（每一行都加一格，表头行加表头格） */
export function addColumn(schema: Schema, where: 'before' | 'after'): Command {
  return (state, dispatch) => {
    const ctx = tableContext(state)
    if (!ctx) return false
    if (dispatch) {
      const tr = state.tr
      const starts = rowStarts(ctx)
      // 从最后一行往前插：后面的位置不会被前面的插入推乱
      for (let r = ctx.table.childCount - 1; r >= 0; r -= 1) {
        const row = ctx.table.child(r)
        const start = cellStart(starts[r]!, row, ctx.col)
        if (start < 0) continue
        const neighbor = row.child(ctx.col)
        const at = where === 'before' ? start : start + neighbor.nodeSize
        tr.insert(at, emptyCell(schema, r === 0, (neighbor.attrs.alignment as TableAlignment) ?? null))
      }
      dispatch(tr.scrollIntoView())
    }
    return true
  }
}

/** 删除光标所在的数据行；表头行不能删（旧编辑器同样） */
export function deleteRow(): Command {
  return (state, dispatch) => {
    const ctx = tableContext(state)
    if (!ctx || ctx.row === 0) return false
    const starts = rowStarts(ctx)
    const row = ctx.table.child(ctx.row)
    if (dispatch) {
      const tr = state.tr.delete(starts[ctx.row]!, starts[ctx.row]! + row.nodeSize)
      // 光标落到上一行的同一列
      const prev = ctx.table.child(ctx.row - 1)
      const target = cellStart(starts[ctx.row - 1]!, prev, Math.min(ctx.col, prev.childCount - 1))
      dispatch(selectCell(tr, target).scrollIntoView())
    }
    return true
  }
}

/** 删除整张表；表是文档里唯一的块时补一个空段落，保证文档合法 */
export function deleteTable(schema: Schema): Command {
  return (state, dispatch) => {
    const ctx = tableContext(state)
    if (!ctx) return false
    if (dispatch) {
      const tr = state.tr.delete(ctx.tablePos, ctx.tablePos + ctx.table.nodeSize)
      if (tr.doc.childCount === 0) tr.insert(0, schema.nodes.paragraph.create())
      const at = Math.min(ctx.tablePos, tr.doc.content.size)
      dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(at), -1)).scrollIntoView())
    }
    return true
  }
}

/** 删除光标所在的列；只剩一列时等于删除整张表 */
export function deleteColumn(schema: Schema): Command {
  return (state, dispatch, view) => {
    const ctx = tableContext(state)
    if (!ctx) return false
    if (ctx.table.child(0).childCount <= 1) return deleteTable(schema)(state, dispatch, view)
    if (dispatch) {
      const tr = state.tr
      const starts = rowStarts(ctx)
      for (let r = ctx.table.childCount - 1; r >= 0; r -= 1) {
        const row = ctx.table.child(r)
        const start = cellStart(starts[r]!, row, ctx.col)
        if (start < 0) continue
        tr.delete(start, start + row.child(ctx.col).nodeSize)
      }
      // 光标留在表头行的相邻列
      const head = starts[0]!
      const headRow = tr.doc.nodeAt(head)
      const target = headRow ? cellStart(head, headRow, Math.min(ctx.col, headRow.childCount - 1)) : -1
      dispatch((target >= 0 ? selectCell(tr, target) : tr).scrollIntoView())
    }
    return true
  }
}

/** 设置光标所在列的对齐方式（整列：表头和每个数据行），保存成 GFM 的 `:---:` 分隔行 */
export function setColumnAlignment(alignment: TableAlignment): Command {
  return (state, dispatch) => {
    const ctx = tableContext(state)
    if (!ctx) return false
    if (dispatch) {
      const tr = state.tr
      const starts = rowStarts(ctx)
      for (let r = 0; r < ctx.table.childCount; r += 1) {
        const row = ctx.table.child(r)
        const start = cellStart(starts[r]!, row, ctx.col)
        if (start < 0) continue
        tr.setNodeMarkup(start, undefined, { ...row.child(ctx.col).attrs, alignment })
      }
      dispatch(tr)
    }
    return true
  }
}

/**
 * Tab / Shift+Tab 在格间跳转：下一格 / 上一格；
 * 最后一格按 Tab 在末尾新增一行（和表格软件一致）；第一格按 Shift+Tab 留在原地（返回 true 吃掉按键，不跳出表格）。
 * 光标不在表格里返回 false，让列表缩进等其它 Tab 命令接手。
 */
export function goToCell(schema: Schema, direction: 1 | -1): Command {
  return (state, dispatch, view) => {
    const ctx = tableContext(state)
    if (!ctx) return false
    const starts = rowStarts(ctx)
    const rows = ctx.table.childCount
    let row = ctx.row
    let col = ctx.col + direction
    if (col >= ctx.table.child(row).childCount) {
      row += 1
      col = 0
    } else if (col < 0) {
      row -= 1
      col = row >= 0 ? ctx.table.child(row).childCount - 1 : 0
    }
    if (row < 0) return true
    if (row >= rows) {
      // 最后一格 Tab：新增一行再进入它的第一格
      return addRow(schema, 'after')(state, dispatch, view)
    }
    if (dispatch) {
      const target = cellStart(starts[row]!, ctx.table.child(row), col)
      dispatch(selectCell(state.tr, target).scrollIntoView())
    }
    return true
  }
}
