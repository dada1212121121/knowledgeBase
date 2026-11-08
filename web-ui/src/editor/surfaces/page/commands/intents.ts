/**
 * Word 编辑命令 → 引擎命令意图
 *
 * 为什么单独一个纯函数文件：工具栏、快捷键、斜杠菜单、AI 都要把「用户要做的事」翻成引擎认识的意图，
 * 只有一张表才能保证它们一致；也只有它是纯函数，才能在不起引擎的情况下做「命令矩阵」单测
 * （每个命令 × 期望的意图种类 / 载荷 / 是否走格式通道）。
 *
 * 映射来自上游 `peerless/shellController.ts` 的 `perform`（Apache-2.0，见 NOTICE）：
 * - `format`：格式类意图（粗斜体、字号、对齐、列表…）走 `commands.format`，准入队列会打围栏并让输入回显收尾；
 * - `submit`：结构类意图（表格、分页符、图片）走 `commands.submit`。
 * 命令类型统一加 `docx.` 前缀，与文本面的 `mark.*` / `block.*` 区分，CommandBus 按前缀路由到本内容面。
 */
import type { PeerlessFormattingIntent } from '../../../engines/docx/vendor/inputAdmission'
import type { PeerlessInputIntent } from '../../../engines/docx/vendor/inputEvents'

/** 一个具体要提交给引擎的意图，以及走哪条通道 */
export type DocxPlannedIntent =
  | { channel: 'format'; intent: PeerlessFormattingIntent }
  | { channel: 'submit'; intent: PeerlessInputIntent }

/** 对齐方式（OOXML `w:jc`） */
export type DocxAlignment = 'left' | 'center' | 'right' | 'both'

/** 表格边框预设（与上游 tableAction 的 border* 一一对应） */
export type DocxBorderPreset = 'all' | 'outside' | 'inside' | 'none' | 'top' | 'bottom' | 'left' | 'right'

export interface DocxBorderPen {
  style: string
  /** 以 1/8 磅为单位（OOXML `w:sz`） */
  size: number
  color: { rgb: string }
}

/** 默认边框笔：单实线 0.5 磅黑色，与 Word 的「所有框线」默认一致 */
export const DEFAULT_BORDER_PEN: DocxBorderPen = { style: 'single', size: 4, color: { rgb: '000000' } }

/** 工具栏的字号档位（磅），与 Word 的字号下拉一致 */
export const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72] as const

/** 行距档位（twips，240 = 单倍） */
export const LINE_SPACINGS = [
  { label: '1.0', value: 240 },
  { label: '1.15', value: 276 },
  { label: '1.5', value: 360 },
  { label: '2.0', value: 480 },
  { label: '2.5', value: 600 },
  { label: '3.0', value: 720 },
] as const

/** 命令参数 */
export interface DocxCommandArgsMap {
  'docx.bold': undefined
  'docx.italic': undefined
  'docx.underline': undefined
  'docx.strike': undefined
  'docx.superscript': undefined
  'docx.subscript': undefined
  'docx.clearFormat': undefined
  'docx.fontFamily': { family: string }
  'docx.fontSize': { points: number }
  'docx.textColor': { color: string | null }
  'docx.highlight': { color: string | null }
  'docx.align': { value: DocxAlignment }
  'docx.lineSpacing': { value: number }
  'docx.list': { kind: 'bullet' | 'numbered' }
  'docx.indent': { direction: 'increase' | 'decrease' }
  'docx.style': { styleId: string }
  'docx.ltr': undefined
  'docx.rtl': undefined
  'docx.table.insert': { rows: number; columns: number }
  'docx.table.row': { side: 'above' | 'below' }
  'docx.table.column': { side: 'left' | 'right' }
  'docx.table.deleteRow': undefined
  'docx.table.deleteColumn': undefined
  'docx.table.delete': undefined
  'docx.table.merge': undefined
  'docx.table.split': { rows: number; columns: number }
  'docx.table.shading': { color: string | null }
  'docx.table.borders': { preset: DocxBorderPreset; pen?: DocxBorderPen }
  'docx.table.select': { target: 'table' | 'row' | 'column' }
  'docx.image.insert': { image: Readonly<Record<string, unknown>> }
  /** 环绕方式：需要读选中图片的当前版式，所以由执行器而不是纯映射表处理 */
  'docx.image.wrap': { target: 'inline' | 'square' | 'squareLeft' | 'squareRight' | 'tight' | 'through' | 'topAndBottom' | 'behind' | 'inFront' }
  'docx.pageBreak': undefined
  'docx.sectionBreak': { type: 'nextPage' | 'continuous' | 'oddPage' | 'evenPage' }
  'docx.undo': undefined
  'docx.redo': undefined
}

export type DocxCommandType = keyof DocxCommandArgsMap

/** 全部命令类型（Surface 据此路由；`docx.` 前缀之外的命令不归这里管） */
export const DOCX_COMMAND_TYPES: readonly DocxCommandType[] = [
  'docx.bold', 'docx.italic', 'docx.underline', 'docx.strike', 'docx.superscript', 'docx.subscript', 'docx.clearFormat',
  'docx.fontFamily', 'docx.fontSize', 'docx.textColor', 'docx.highlight',
  'docx.align', 'docx.lineSpacing', 'docx.list', 'docx.indent', 'docx.style', 'docx.ltr', 'docx.rtl',
  'docx.table.insert', 'docx.table.row', 'docx.table.column', 'docx.table.deleteRow', 'docx.table.deleteColumn',
  'docx.table.delete', 'docx.table.merge', 'docx.table.split', 'docx.table.shading', 'docx.table.borders', 'docx.table.select',
  'docx.image.insert', 'docx.image.wrap', 'docx.pageBreak', 'docx.sectionBreak', 'docx.undo', 'docx.redo',
]

export function isDocxCommandType(type: string): type is DocxCommandType {
  return (DOCX_COMMAND_TYPES as readonly string[]).includes(type)
}

/** 颜色统一成 6 位大写无井号 hex；不合法返回 null（调用方当作"清除"还是"拒绝"自己决定） */
export function normalizeHex(color: string | null | undefined): string | null {
  if (!color) return null
  const value = color.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{6}$/.test(value)) return value.toUpperCase()
  if (/^[0-9a-fA-F]{3}$/.test(value)) {
    return value
      .split('')
      .map((char) => char + char)
      .join('')
      .toUpperCase()
  }
  return null
}

function bordersFor(preset: DocxBorderPreset, pen: DocxBorderPen): Record<string, DocxBorderPen> {
  const none: DocxBorderPen = { style: 'none', size: 0, color: { rgb: '000000' } }
  const all = (border: DocxBorderPen) => ({ top: border, bottom: border, left: border, right: border, insideH: border, insideV: border })
  switch (preset) {
    case 'all':
      return all(pen)
    case 'outside':
      return { top: pen, bottom: pen, left: pen, right: pen }
    case 'inside':
      return { insideH: pen, insideV: pen }
    case 'none':
      return all(none)
    default:
      return { [preset]: pen }
  }
}

/**
 * 把一条命令翻成要提交的意图。返回 null 表示这条命令不产生意图（参数不合法或不归本表管）。
 * 注意：字体族还要先登记字体环境（见 `runner.ts`），这里只给出最后那条格式意图。
 */
export function planDocxCommand<K extends DocxCommandType>(type: K, args: DocxCommandArgsMap[K]): DocxPlannedIntent | null {
  const format = (intent: PeerlessFormattingIntent): DocxPlannedIntent => ({ channel: 'format', intent })
  const submit = (intent: PeerlessInputIntent): DocxPlannedIntent => ({ channel: 'submit', intent })
  const a = args as never as Record<string, any>
  switch (type) {
    case 'docx.bold':
    case 'docx.italic':
    case 'docx.underline':
      return format({ kind: 'toggleMark', payload: { mark: { type: type.slice('docx.'.length) as 'bold' | 'italic' | 'underline' } } })
    case 'docx.strike':
      return format({ kind: 'toggleStrike', payload: {} })
    case 'docx.superscript':
    case 'docx.subscript':
      return format({ kind: 'toggleMark', payload: { mark: { type: type.slice('docx.'.length) as 'superscript' | 'subscript' } } })
    case 'docx.clearFormat':
      return format({ kind: 'clearFormatting', payload: {} })
    case 'docx.fontFamily': {
      const family = String(a.family ?? '').trim()
      if (!family) return null
      return format({ kind: 'formatRange', payload: { delta: { fontFamily: { ascii: family, hAnsi: family } } } as never })
    }
    case 'docx.fontSize': {
      const points = Number(a.points)
      // 引擎写 w:sz（半磅），所以最小粒度 0.5；越界直接拒绝，不替用户夹到"差不多"的值
      if (!Number.isFinite(points) || points < 1 || points > 400 || Math.round(points * 2) !== points * 2) return null
      return format({ kind: 'formatRange', payload: { delta: { fontSize: points } } as never })
    }
    case 'docx.textColor': {
      if (a.color === null) return format({ kind: 'formatRange', payload: { delta: { color: null, other: { textColor: null } } } as never })
      const rgb = normalizeHex(a.color)
      if (!rgb) return null
      return format({ kind: 'formatRange', payload: { delta: { color: { rgb }, other: { textColor: { rgb } } } } as never })
    }
    case 'docx.highlight': {
      const color = a.color as string | null
      return format({ kind: 'formatRange', payload: { delta: { highlight: color && color !== 'none' ? color : null } } as never })
    }
    case 'docx.align':
      if (!['left', 'center', 'right', 'both'].includes(a.value)) return null
      return format({ kind: 'setParagraphAttrs', payload: { attrs: { alignment: a.value } } as never })
    case 'docx.lineSpacing': {
      const value = Number(a.value)
      if (!Number.isFinite(value) || value < 120 || value > 2400) return null
      return format({ kind: 'setParagraphAttrs', payload: { attrs: { lineSpacing: value, lineSpacingRule: 'auto' } } as never })
    }
    case 'docx.ltr':
    case 'docx.rtl':
      return format({ kind: 'setParagraphAttrs', payload: { attrs: { bidi: type === 'docx.rtl' } } as never })
    case 'docx.list':
      return format({ kind: 'toggleList', payload: { kind: a.kind === 'numbered' ? 'numbered' : 'bullet' } })
    case 'docx.indent':
      return format({ kind: 'changeIndent', payload: { direction: a.direction === 'decrease' ? 'decrease' : 'increase' } })
    case 'docx.style':
      return a.styleId ? format({ kind: 'applyParagraphStyle', payload: { styleId: String(a.styleId) } }) : null
    case 'docx.table.insert': {
      const rows = Number(a.rows)
      const columns = Number(a.columns)
      // 上限与 Word 的"插入表格"网格一致量级；超大表格会让一次布局卡很久
      if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1 || rows > 100 || columns > 63) return null
      return submit({ kind: 'insertTable', payload: { rows, columns } } as never)
    }
    case 'docx.table.row':
      return submit({ kind: 'insertTableRow', payload: { side: a.side === 'above' ? 'above' : 'below' } })
    case 'docx.table.column':
      return submit({ kind: 'insertTableColumn', payload: { side: a.side === 'left' ? 'left' : 'right' } })
    case 'docx.table.deleteRow':
      return submit({ kind: 'deleteTableRow', payload: {} })
    case 'docx.table.deleteColumn':
      return submit({ kind: 'deleteTableColumn', payload: {} })
    case 'docx.table.delete':
      return submit({ kind: 'deleteTable', payload: {} })
    case 'docx.table.merge':
      return submit({ kind: 'mergeTableCells', payload: {} })
    case 'docx.table.split': {
      const rows = Number(a.rows)
      const columns = Number(a.columns)
      if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1) return null
      return submit({ kind: 'splitTableCell', payload: { rows, columns } })
    }
    case 'docx.table.shading': {
      if (a.color === null || a.color === '') return submit({ kind: 'setTableCellShading', payload: { color: null } })
      const rgb = normalizeHex(a.color)
      return rgb ? submit({ kind: 'setTableCellShading', payload: { color: rgb } }) : null
    }
    case 'docx.table.borders': {
      const preset = a.preset as DocxBorderPreset
      if (!['all', 'outside', 'inside', 'none', 'top', 'bottom', 'left', 'right'].includes(preset)) return null
      return submit({ kind: 'setTableBorders', payload: { borders: bordersFor(preset, a.pen ?? DEFAULT_BORDER_PEN) } } as never)
    }
    case 'docx.table.select':
      return submit({ kind: 'selectTableCells', payload: { target: a.target } } as never)
    case 'docx.image.insert':
      return a.image ? submit({ kind: 'insertImage', payload: { image: a.image } } as never) : null
    case 'docx.image.wrap':
      // 补丁依赖选中图片的当前属性，纯映射表给不出；执行器里单独处理
      return null
    case 'docx.pageBreak':
      return submit({ kind: 'insertPageBreak', payload: {} })
    case 'docx.sectionBreak':
      return submit({ kind: 'insertSectionBreak', payload: { type: a.type ?? 'nextPage' } } as never)
    case 'docx.undo':
      return submit({ kind: 'undo', payload: {} })
    case 'docx.redo':
      return submit({ kind: 'redo', payload: {} })
    default:
      return null
  }
}
