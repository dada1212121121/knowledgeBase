/**
 * Word 编辑的格式状态与命令可用性
 *
 * 工具栏高亮（粗体是否亮、当前是哪种对齐、字号是多少）和按钮是否可点，都来自引擎每帧附带的 `editState`
 * （上游叫 toolbar context），不在前端自己猜：选区跨了粗体和非粗体，引擎说 `mixed`，按钮就该是"部分激活"，
 * 前端自己算会在边界处错。本文件只做一件事：把 `editState` 压成外壳能直接消费的形状。
 */
import type { DocxCommandType } from './intents'

/** 引擎三态：true / false / 'mixed' */
type Tri = boolean | 'mixed' | null | undefined

/** `editState` 里我们用到的字段（只写用到的，引擎的完整类型不穿过 Surface 层） */
export interface DocxEditStateLike {
  readOnly?: boolean
  canUndo?: boolean
  canRedo?: boolean
  toolbar?: {
    bold?: Tri
    italic?: Tri
    underline?: Tri
    strike?: Tri
    superscript?: Tri
    subscript?: Tri
    fontFamily?: string | null
    /** 半磅 */
    fontSize?: number | null
    color?: string | null
    highlight?: string | null
    styleId?: string | null
    alignment?: string | null
    paragraphProperties?: { numPr?: unknown; lineSpacing?: unknown; indentLeft?: unknown; [key: string]: unknown }
  } | null
  effectiveFormatting?: { fontSizePt?: number | null } | null
  tableContext?: {
    rowCount?: number
    columnCount?: number
    hasMultiCellSelection?: boolean
    canSplitCell?: boolean
  } | null
}

/** 外壳消费的格式状态：既兼容文本面的 `FormatState`（marks / lists），又带 Word 特有字段 */
export interface DocxFormatState {
  marks: string[]
  block: string
  inBlockquote: boolean
  lists: { bullet: boolean; ordered: boolean; task: boolean }
  /** 工具栏「当前值」类控件：字号（磅）、字体、颜色、对齐、样式 */
  fontSizePt: number | null
  fontFamily: string | null
  color: string | null
  highlight: string | null
  alignment: string | null
  styleId: string | null
  lineSpacing: number | null
  /** 当前选中了一张图片（环绕等图片命令的前提） */
  imageSelected: boolean
  /** 光标在表格里 */
  inTable: boolean
  canMerge: boolean
  canSplit: boolean
  canUndo: boolean
  canRedo: boolean
  readOnly: boolean
}

/** `mixed` 也算"有"：Word 里选区部分加粗时粗体按钮是亮的 */
const partly = (value: Tri) => value === true || value === 'mixed'

function numberingOf(value: unknown): { numId?: number } | null {
  if (!value || typeof value !== 'object') return null
  const numId = (value as { numId?: unknown }).numId
  return typeof numId === 'number' ? { numId } : null
}

export function docxFormatState(editState: DocxEditStateLike | null | undefined, imageSelected = false): DocxFormatState {
  const context = editState?.toolbar ?? null
  const marks: string[] = []
  if (partly(context?.bold)) marks.push('bold')
  if (partly(context?.italic)) marks.push('italic')
  if (partly(context?.underline)) marks.push('underline')
  if (partly(context?.strike)) marks.push('strike')
  if (partly(context?.superscript)) marks.push('superscript')
  if (partly(context?.subscript)) marks.push('subscript')
  // 列表：numId 1 是项目符号，其余是编号（上游 evaluate.ts 的同一约定）
  const numbering = numberingOf(context?.paragraphProperties?.numPr)
  const bullet = numbering?.numId === 1
  const ordered = numbering?.numId !== undefined && numbering.numId !== 1 && numbering.numId > 0
  const table = editState?.tableContext ?? null
  const size = context?.fontSize ?? null
  const spacing = context?.paragraphProperties?.lineSpacing
  return {
    marks,
    block: 'paragraph',
    inBlockquote: false,
    lists: { bullet, ordered, task: false },
    // toolbar.fontSize 是半磅；effectiveFormatting 给的是磅，混选时 toolbar 是 null，退回到后者
    fontSizePt: size !== null ? size / 2 : (editState?.effectiveFormatting?.fontSizePt ?? null),
    fontFamily: context?.fontFamily ?? null,
    color: context?.color ?? null,
    highlight: context?.highlight ?? null,
    alignment: context?.alignment ?? null,
    styleId: context?.styleId ?? null,
    lineSpacing: typeof spacing === 'number' ? spacing : null,
    imageSelected,
    inTable: !!table,
    canMerge: !!table?.hasMultiCellSelection,
    canSplit: !!table?.canSplitCell,
    canUndo: editState?.canUndo === true,
    canRedo: editState?.canRedo === true,
    readOnly: editState?.readOnly === true,
  }
}

/** 表格命令只有光标在表格里才有意义 */
const TABLE_COMMANDS = new Set<DocxCommandType>([
  'docx.table.row', 'docx.table.column', 'docx.table.deleteRow', 'docx.table.deleteColumn', 'docx.table.delete',
  'docx.table.merge', 'docx.table.split', 'docx.table.shading', 'docx.table.borders', 'docx.table.select',
])

/**
 * 一条命令现在能不能执行；不能时给出能直接展示的中文原因。
 * 只读始终最先判：被收回编辑权后，哪怕按钮还没来得及隐藏，点下去也要被拒。
 *
 * `pendingInput`：还有刚键入、引擎没回执的输入。此时 `canUndo` 还停在旧值（键入的那一步还没入栈），
 * 但用户按撤销显然是要撤掉刚打的字——上游同样放行（evaluate.ts 的 `canUndo || pendingInput`）。
 */
export function docxCommandGate(type: DocxCommandType, state: DocxFormatState, pendingInput = false): string | null {
  if (state.readOnly) return '文档当前是只读的'
  if (type === 'docx.undo') return state.canUndo || pendingInput ? null : '没有可撤销的操作'
  if (type === 'docx.redo') return state.canRedo || pendingInput ? null : '没有可重做的操作'
  if (type === 'docx.image.wrap' && !state.imageSelected) return '请先选中一张图片'
  if (TABLE_COMMANDS.has(type) && !state.inTable) return '请先把光标放进表格'
  if (type === 'docx.table.merge' && !state.canMerge) return '请先选中要合并的多个单元格'
  if (type === 'docx.table.split' && !state.canSplit) return '这个单元格不能再拆分'
  return null
}

/** 外壳 `FormatState` 的形状（Chrome 的类型在 host/ 里，这里只写结构，避免 surface 反向依赖 host） */
export interface DocxChromeFormatState {
  marks: string[]
  block: string
  inBlockquote: boolean
  lists: { bullet: boolean; ordered: boolean; task: boolean }
  values: Record<string, string | number | null>
  unavailable: Record<string, string>
  /** 开着的开关（修订模式、审阅栏、缩略图栏），工具栏据此高亮 */
  toggles: string[]
}

/** 工具栏需要被置灰的命令（undo / redo 由外壳自己的按钮管，不在这里重复） */
const GATED: readonly DocxCommandType[] = [...TABLE_COMMANDS, 'docx.image.wrap']

export function toChromeFormatState(state: DocxFormatState, flags: { tracking?: boolean; review?: boolean; thumbs?: boolean } = {}): DocxChromeFormatState {
  const unavailable: Record<string, string> = {}
  for (const type of GATED) {
    const reason = docxCommandGate(type, state)
    if (reason) unavailable[type] = reason
  }
  return {
    marks: state.marks,
    block: state.block,
    inBlockquote: state.inBlockquote,
    lists: state.lists,
    values: {
      alignment: state.alignment,
      fontFamily: state.fontFamily,
      fontSizePt: state.fontSizePt,
      styleId: state.styleId,
      lineSpacing: state.lineSpacing,
    },
    unavailable,
    toggles: [...(flags.tracking ? ['trackChanges'] : []), ...(flags.review ? ['review'] : []), ...(flags.thumbs ? ['thumbs'] : [])],
  }
}
