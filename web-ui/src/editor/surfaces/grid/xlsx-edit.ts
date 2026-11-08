/**
 * XLSX 编辑面的纯逻辑
 *
 * 这一层刻意不碰 Worker 与 DOM：输入归一、公式相对引用平移、粘贴矩阵展开、
 * 样式补丁合成都在这里用纯函数完成，`XlsxEditView.vue` 只负责事件与绘制。
 * 好处是 Excel 语义（`$` 绝对引用、`'` 文本守卫、单格复制到多格选区）可以单测锁死，
 * 不必每次起浏览器。
 */
import type {
  XlsxEditSource,
  XlsxNumberFormatChange,
  XlsxStylePatch,
  XlsxFormatting,
  XlsxRange,
} from '../../engines/xlsx'
import { parseClipboard, serializeTsv } from './clipboard'

/** 一次粘贴最多落多少格：超过就只贴左上角并提示，避免把主线程和 Worker 一起拖死 */
export const XLSX_PASTE_CELL_LIMIT = 20_000

/** 复制上限：与引擎 16 MiB 请求上限匹配的保守值 */
export const XLSX_COPY_CELL_LIMIT = 50_000

export interface XlsxPastePlan {
  /** 目标起点 + 每格输入（相对引号已按 Excel 规则平移） */
  cells: { row: number; col: number; input: string }[]
  rows: number
  cols: number
  /** 因上限被截断时为真，调用方必须提示用户 */
  truncated: boolean
}

/**
 * 展开剪贴板矩阵。
 *
 * Excel 的三条语义：
 * 1. 单格复制 → 贴到整个目标选区（逐格同值）；
 * 2. 多格复制 → 从锚点开始按矩阵铺开，覆盖原有选区；
 * 3. 文本粘贴按原样写入，**不**平移公式引用：从 Excel 复制的文本里引用已经是复制后的坐标，
 *    再平移一次会错位；需要相对填充时用 `xlsxFillPlan`（Ctrl+D / Ctrl+R）。
 */
export function xlsxPlanPaste(
  clipboard: { text: string; html?: string },
  selection: XlsxRange,
  limit = XLSX_PASTE_CELL_LIMIT,
): XlsxPastePlan {
  const matrix = parseClipboard(clipboard.text, clipboard.html ?? '')
  const rows = matrix.length
  const cols = rows === 0 ? 0 : Math.max(...matrix.map((row) => row.length))
  const startRow = selection.top
  const startCol = selection.left
  const selectionRows = selection.bottom - selection.top + 1
  const selectionCols = selection.right - selection.left + 1
  const singleCell = rows === 1 && cols === 1

  const targetRows = singleCell ? selectionRows : rows
  const targetCols = singleCell ? selectionCols : cols
  const total = targetRows * targetCols
  const truncated = total > limit
  const allowedRows = truncated ? Math.max(1, Math.floor(limit / Math.max(1, targetCols))) : targetRows

  const cells: XlsxPastePlan['cells'] = []
  for (let r = 0; r < allowedRows; r += 1) {
    for (let c = 0; c < targetCols; c += 1) {
      if (cells.length >= limit) break
      // 单格复制：源值只有一份；多格复制：越界列留空（Excel 也是空）
      const source = singleCell ? (matrix[0]?.[0] ?? '') : (matrix[r]?.[c] ?? '')
      const input = source
      cells.push({ row: startRow + r, col: startCol + c, input })
    }
  }
  return { cells, rows: allowedRows, cols: targetCols, truncated }
}

/**
 * 公式相对引用平移：`=A1+$B$2` 向下右移一行一列 → `=B2+$B$2`。
 *
 * 只处理 A1 形式，跳过字符串字面量、带引号的表名与跨工作簿引用，避免误改用户数据。
 * 移出表格边界（列 < A 或行 < 1）时保留原引用：不生成 `#REF!`，粘贴结果至少还能打开。
 */
export function shiftFormula(input: string, dRow: number, dCol: number): string {
  if (!input.startsWith('=') || (dRow === 0 && dCol === 0)) return input
  const body = input.slice(1)
  // 字符串字面量先挖空，避免里面的 "A1" 被当成引用
  const literals: string[] = []
  const masked = body.replace(/"(?:[^"]|"")*"/g, (literal) => {
    literals.push(literal)
    return '\u0000'
  })
  const shifted = masked.replace(/(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![\w(!'\u0000])/g, (token, colAbs, letters, rowAbs, digits) => {
    if (colAbs && rowAbs) return token
    const col = (letters as string).toUpperCase().split('').reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0)
    const row = Number(digits)
    const nextCol = colAbs ? col : col + dCol
    const nextRow = rowAbs ? row : row + dRow
    if (nextCol < 1 || nextRow < 1) return token
    return `${colAbs}${colAbs ? letters : columnName(nextCol)}${rowAbs}${rowAbs ? digits : nextRow}`
  })
  let restored = shifted
  for (const literal of literals) restored = restored.replace('\u0000', literal)
  return `=${restored}`
}

/** 0 基列号 → A1 列字母（大写） */
export function columnName(col: number): string {
  let name = ''
  let value = col
  while (value > 0) {
    const remainder = (value - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    value = Math.floor((value - 1) / 26)
  }
  return name
}

/** 提交输入：单格写入；多格选区只有显式 `fillSelection`（Ctrl+Enter）才整片填同值 */
export function xlsxCommitEdits(
  selection: XlsxRange,
  input: string,
  options: { fillSelection?: boolean } = {},
): { row: number; col: number; input: string }[] {
  const cells: { row: number; col: number; input: string }[] = []
  for (let row = selection.top; row <= selection.bottom; row += 1) {
    for (let col = selection.left; col <= selection.right; col += 1) {
      // 单格选区本来就是这一格；多格不带 fillSelection 时只写活动格（选区左上角）
      if (!options.fillSelection && (row !== selection.top || col !== selection.left)) continue
      cells.push({ row, col, input })
    }
  }
  return cells
}

/** 复制内容：引擎读到的显示文本 + 公式；公式带 `=` 才能被 Excel 重算 */
export interface XlsxCopyCell {
  text: string
  formula: string | null
}

/** 生成复制负载：TSV 保兼容，HTML 保换行与合并视觉 */
export function xlsxCopyPayload(matrix: readonly (readonly XlsxCopyCell[])[], merged?: { row: number; col: number; rowSpan: number; colSpan: number }[]): {
  text: string
  html: string
} {
  const display = matrix.map((row) => row.map((cell) => cell.text))
  const text = serializeTsv(display)
  const mergeAt = new Map((merged ?? []).map((entry) => [`${entry.row}:${entry.col}`, entry]))
  const covered = new Set<string>()
  for (const entry of merged ?? []) {
    for (let r = entry.row; r < entry.row + entry.rowSpan; r += 1) {
      for (let c = entry.col; c < entry.col + entry.colSpan; c += 1) {
        if (r !== entry.row || c !== entry.col) covered.add(`${r}:${c}`)
      }
    }
  }
  const body = matrix
    .map((row, rowIndex) =>
      `<tr>${row
        .map((cell, colIndex) => {
          if (covered.has(`${rowIndex}:${colIndex}`)) return ''
          const merge = mergeAt.get(`${rowIndex}:${colIndex}`)
          const span =
            (merge && merge.rowSpan > 1 ? ` rowspan="${merge.rowSpan}"` : '') +
            (merge && merge.colSpan > 1 ? ` colspan="${merge.colSpan}"` : '')
          const escaped = (cell.text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          return `<td${span}>${escaped.replace(/\n/g, '<br>')}</td>`
        })
        .join('')}</tr>`,
    )
    .join('')
  return { text, html: `<table>${body}</table>` }
}

/**
 * 向下 / 向右填充（Ctrl+D / Ctrl+R）：以选区首行（首列）为源，其余行（列）复制并平移公式。
 * 返回需要写入的格；调用方一次 `editCells` 提交。
 */
export function xlsxFillPlan(
  selection: XlsxRange,
  sources: readonly (readonly string[])[],
  direction: 'down' | 'right',
): { row: number; col: number; input: string }[] {
  const cells: { row: number; col: number; input: string }[] = []
  const rows = sources.length
  const cols = rows === 0 ? 0 : Math.max(...sources.map((row) => row.length))
  if (rows === 0 || cols === 0) return cells
  if (direction === 'down') {
    for (let r = 1; r < selection.bottom - selection.top + 1; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        cells.push({
          row: selection.top + r,
          col: selection.left + c,
          input: shiftFormula(sources[0]?.[c] ?? '', r, 0),
        })
      }
    }
    return cells
  }
  for (let c = 1; c < selection.right - selection.left + 1; c += 1) {
    for (let r = 0; r < rows; r += 1) {
      cells.push({
        row: selection.top + r,
        col: selection.left + c,
        input: shiftFormula(sources[r]?.[0] ?? '', 0, c),
      })
    }
  }
  return cells
}

/* ------------------------------ 样式补丁 ------------------------------ */

export type XlsxToggleProperty = 'bold' | 'italic' | 'strikethrough'

/** 工具栏按钮的 toggle 语义：读当前选区格式，再取反 */
export function xlsxTogglePatch(current: XlsxFormatting | null, property: XlsxToggleProperty): XlsxStylePatch {
  return { [property]: !(current?.[property] ?? false) }
}

export type XlsxNumberFormatChoice = Exclude<XlsxFormatting['numberFormat'], null | 'custom'> | 'increaseDecimal' | 'decreaseDecimal'

/** 数字格式下拉 → 引擎变更；引擎按语义类别映射到内置格式 id，本层不写死数字 */
export function xlsxNumberFormatMutation(
  choice: XlsxNumberFormatChoice,
): XlsxNumberFormatChange {
  return choice
}

/** 命令来源 → 引擎 `source` 标记（审计 / 协同排查用） */
export function xlsxCommandSource(tag: XlsxEditSource): 'user' | 'api' | 'system' {
  if (tag === 'system' || tag === 'undo' || tag === 'redo') return 'system'
  return 'user'
}
