/**
 * CSV / TSV 编解码
 *
 * 目标不是「把表格对象写回成新的 CSV」，而是**只改用户动过的那几个字段**：
 * 未触碰的记录保持原字节（BOM、CRLF、引号写法、空行、末尾有无换行全部保留），
 * 这样打开→改一格→保存的 git diff 只有那一格。
 *
 * 解析与补丁算法复用 `utils/csvText.ts`（同一套规则已被服务端 csv_edit 与协同编辑器验证）：
 * - 分隔符嗅探：`,` / `;` / `\t` / `|`，按前 20 条非空记录的列数众数打分；
 * - 行号只数非空记录，和表格 UI / 后端保持一致；
 * - `set_cell` 在行尾补列时补分隔符，不加多余引号；
 * - 一次编辑多个格子时从后往前打补丁，避免下标漂移。
 */
import type { EditorSource, SurfaceDocument } from '../types'
import {
  applySplicesToTable,
  cellValue,
  deleteRowSplice,
  insertRowSplice,
  parseTable,
  serializeField,
  setCellSplice,
  type CsvTable,
  type Splice,
} from '@/utils/csvText'
import { parseTableAsync } from '@/utils/csvParseAsync'
import { columnWidths } from '@/utils/tabular'
import type { GridEdit, GridSheet } from '../surfaces/grid/types'

/** 大文件只读门槛：超过 20 万非空行不再允许编辑（避免一次编辑重解析整份文件） */
export const CSV_MAX_EDIT_ROWS = 200_000
/** BOM 单独保存；正文里的所有下标都不含它 */
const BOM = '\uFEFF'

export interface CsvDocument {
  /** 去掉 BOM 的正文（原样，不做行尾归一化） */
  text: string
  name: string
  /** 原文件是否带 UTF-8 BOM */
  bom: boolean
  table: CsvTable
}

/** 解码一份 CSV / TSV；二进制源按 UTF-8 解（CSV 不应有非文本内容） */
export function openCsv(source: EditorSource): CsvDocument {
  const raw = source.kind === 'text' ? source.text : new TextDecoder().decode(source.bytes)
  return parseCsvText(raw, source.name)
}

/** 异步打开：大表在 Worker 里解析，结果与 openCsv 完全相同 */
export async function openCsvAsync(source: EditorSource): Promise<CsvDocument> {
  const raw = source.kind === 'text' ? source.text : new TextDecoder().decode(source.bytes)
  return parseCsvTextAsync(raw, source.name)
}

export async function parseCsvTextAsync(raw: string, name = ''): Promise<CsvDocument> {
  const bom = raw.startsWith(BOM)
  const text = bom ? raw.slice(1) : raw
  return { text, name, bom, table: await parseTableAsync(text, /\.tsv$/i.test(name)) }
}

/** 纯文本入口：便于测试语料直接调用，不构造 EditorSource */
export function parseCsvText(raw: string, name = ''): CsvDocument {
  const bom = raw.startsWith(BOM)
  const text = bom ? raw.slice(1) : raw
  const tsv = /\.tsv$/i.test(name)
  return { text, name, bom, table: parseTable(text, tsv) }
}

export function csvRowCount(doc: CsvDocument): number {
  return doc.table.rows.length
}

export function csvColumnCount(doc: CsvDocument): number {
  return Math.max(1, doc.table.columns)
}

/** 非空行数超过上限时只读：UI 和适配器都读同一个判断，避免只读提示与实际行为不一致 */
export function csvEditable(doc: CsvDocument): boolean {
  return doc.table.rows.length <= CSV_MAX_EDIT_ROWS
}

export function csvCell(doc: CsvDocument, row: number, col: number): string {
  return cellValue(doc.table, row, col)
}

/**
 * 把一次网格编辑变成补丁。同一格被连改多次时以最后一次为准；
 * 打补丁从后往前，保证前面的字段下标仍然有效。
 */
export function csvEditsToSplices(doc: CsvDocument, edits: readonly GridEdit[]): Splice[] {
  const latest = new Map<string, GridEdit>()
  for (const edit of edits) latest.set(`${edit.row}:${edit.col}`, edit)
  const splices: Splice[] = []
  for (const edit of latest.values()) {
    if (!Number.isInteger(edit.row) || !Number.isInteger(edit.col) || edit.row < 0 || edit.col < 0) {
      throw new Error(`格子坐标无效：${edit.row}:${edit.col}`)
    }
    if (edit.row >= doc.table.rows.length) throw new Error(`第 ${edit.row + 1} 行不存在`)
    const splice = setCellSplice(doc.table, edit.row, edit.col, edit.text)
    if (splice) splices.push(splice)
  }
  // 同一位置理论上只会有一个补丁（上面按格去重）；仍按 index 降序，保证多格编辑互不干扰
  return splices.sort((left, right) => right.index - left.index)
}

const isTsv = (doc: CsvDocument) => /\.tsv$/i.test(doc.name)

/**
 * 应用一组补丁；没有任何实际变化时返回原对象，调用方可用引用相等判断无操作。
 * 改格子只重解析被改的那几条记录（applySplicesToTable），不再每改一格整份重解析。
 */
export function applyCsvEdits(doc: CsvDocument, edits: readonly GridEdit[]): CsvDocument {
  const splices = csvEditsToSplices(doc, edits)
  if (!splices.length) return doc
  const table = applySplicesToTable(doc.table, splices, isTsv(doc))
  return { ...doc, text: table.text, table }
}

/** 远端（协同）对正文做的一串替换：同样增量更新 */
export function applyCsvSplices(doc: CsvDocument, splices: readonly Splice[]): CsvDocument {
  if (!splices.length) return doc
  const table = applySplicesToTable(doc.table, splices, isTsv(doc))
  return { ...doc, text: table.text, table }
}

/** 末尾追加一行（新行值按需补分隔符；不写多余空列） */
export function appendCsvRow(doc: CsvDocument, values: readonly string[]): CsvDocument {
  if (!csvEditable(doc)) throw new Error(`表格超过 ${CSV_MAX_EDIT_ROWS} 行，仅支持只读浏览`)
  const splice = insertRowSplice(doc.table, doc.table.rows.length, [...values])
  const table = applySplicesToTable(doc.table, [splice], isTsv(doc))
  return { ...doc, text: table.text, table }
}

/** 一条要写进文档的新行：插在文档第 `at` 行之前（等于行数就是加在最后），`seq` 决定同一位置多条的先后 */
export interface CsvRowInsert {
  at: number
  values: readonly string[]
  seq: number
}

interface TaggedSplice {
  splice: Splice
  /** 新行的插入（相对于改格子产生的补丁，同一位置要先落） */
  row: boolean
  seq: number
}

/**
 * 补丁的落地顺序：所有补丁的坐标都是「改动之前」的文本，所以必须从后往前落，前面的坐标才不会漂移。
 * 同一个位置有多条时：
 * 1. 替换 / 删除（remove > 0）先落——新行插在这一行的开头，不能被它们误删；
 * 2. 纯插入里新行先落、改格子补列后落——文件末行没有换行时，两者都在行尾，补列要接在原行上、新行要排在它后面；
 * 3. 多条新行同位置：seq 大的先落，最终 seq 小的排在上面。
 */
function orderSplices(tagged: readonly TaggedSplice[]): Splice[] {
  return [...tagged]
    .sort((left, right) => {
      if (left.splice.index !== right.splice.index) return right.splice.index - left.splice.index
      const leftReplace = left.splice.remove > 0
      const rightReplace = right.splice.remove > 0
      if (leftReplace !== rightReplace) return leftReplace ? -1 : 1
      if (left.row !== right.row) return left.row ? -1 : 1
      return right.seq - left.seq
    })
    .map((item) => item.splice)
}

const hasNul = (values: readonly string[]) => values.some((value) => value.includes('\0'))

/**
 * 一次编辑里「改格子 + 把待写入的新行落进文本」合成的补丁（已排好落地顺序）。
 * 行号都按改动之前的文档算；协同适配器直接把它们依次作用在房间文本上。
 */
export function csvChangeSplices(doc: CsvDocument, edits: readonly GridEdit[], inserts: readonly CsvRowInsert[] = []): Splice[] {
  const tagged: TaggedSplice[] = csvEditsToSplices(doc, edits).map((splice) => ({ splice, row: false, seq: 0 }))
  for (const insert of inserts) {
    if (!Number.isInteger(insert.at) || insert.at < 0 || insert.at > doc.table.rows.length) throw new Error(`不能插到第 ${insert.at + 1} 行之前`)
    if (hasNul(insert.values)) throw new Error('格子里不能有 NUL 字符')
    tagged.push({ splice: insertRowSplice(doc.table, insert.at, [...insert.values]), row: true, seq: insert.seq })
  }
  return orderSplices(tagged)
}

/** 应用 {@link csvChangeSplices}；没有任何实际变化时返回原对象 */
export function applyCsvChanges(doc: CsvDocument, edits: readonly GridEdit[], inserts: readonly CsvRowInsert[] = []): CsvDocument {
  if (!csvEditable(doc)) throw new Error(`表格超过 ${CSV_MAX_EDIT_ROWS} 行，仅支持只读浏览`)
  const splices = csvChangeSplices(doc, edits, inserts)
  if (!splices.length) return doc
  const table = applySplicesToTable(doc.table, splices, isTsv(doc))
  return { ...doc, text: table.text, table }
}

/**
 * 删除若干行的补丁（从后往前，互不重叠）。
 * 规则照服务端 csv_edit：删行连同它的行尾一起删；最后一行没有换行时连它前面的换行一起删；
 * 相邻两行的删除区间会重叠（后者吃掉前者的行尾），合并成一段；
 * 原来最后一行没有换行、这次又被删了，结果不能凭空多出一个结尾换行——把那个换行也删掉。
 */
export function deleteCsvRowsSplices(doc: CsvDocument, rows: readonly number[]): Splice[] {
  const { table } = doc
  const unique = [...new Set(rows)].sort((left, right) => left - right)
  if (!unique.length) return []
  const raw = unique.map((row) => deleteRowSplice(table, row)).sort((left, right) => left.index - right.index)
  const merged: Splice[] = []
  for (const splice of raw) {
    const last = merged[merged.length - 1]
    if (last && splice.index <= last.index + last.remove) {
      last.remove = Math.max(last.index + last.remove, splice.index + splice.remove) - last.index
      continue
    }
    merged.push({ ...splice })
  }
  const lastRecord = table.rows[table.rows.length - 1]
  const lastDeleted = lastRecord !== undefined && unique[unique.length - 1] === table.rows.length - 1
  if (lastDeleted && table.recTermEnd[lastRecord] === table.recEnd[lastRecord]) {
    const tail = merged[merged.length - 1]!
    const floor = merged.length > 1 ? merged[merged.length - 2]!.index + merged[merged.length - 2]!.remove : 0
    const newline = table.newline
    if (tail.index - newline.length >= floor && table.text.slice(tail.index - newline.length, tail.index) === newline) {
      tail.index -= newline.length
      tail.remove += newline.length
    }
  }
  return merged.sort((left, right) => right.index - left.index)
}

/** 删除若干行；行号越界会抛错 */
export function deleteCsvRows(doc: CsvDocument, rows: readonly number[]): CsvDocument {
  if (!csvEditable(doc)) throw new Error(`表格超过 ${CSV_MAX_EDIT_ROWS} 行，仅支持只读浏览`)
  const splices = deleteCsvRowsSplices(doc, rows)
  if (!splices.length) return doc
  const table = applySplicesToTable(doc.table, splices, isTsv(doc))
  return { ...doc, text: table.text, table }
}

/** 总是文本源；单独收窄返回类型，调用方不必重复判断 kind */
export interface CsvTextSource {
  kind: 'text'
  text: string
  name: string
  encoding: string
}

/** 序列化：没改动时逐字节相同；BOM 只在原来有时才加回 */
export function serializeCsv(doc: CsvDocument, name = doc.name): CsvTextSource {
  return { kind: 'text', text: doc.bom ? `${BOM}${doc.text}` : doc.text, name, encoding: 'utf-8' }
}

/** 把 CSV 文档包装成 GridSurface 认识的只读数据源；列宽按前 200 行估算 */
export function csvToGridSheet(doc: CsvDocument): GridSheet {
  const columns = csvColumnCount(doc)
  const rows = Array.from({ length: Math.min(doc.table.rows.length, 200) }, (_, row) =>
    Array.from({ length: columns }, (_, col) => csvCell(doc, row, col)),
  )
  const widths = columnWidths(rows, columns)
  return {
    name: doc.name || 'CSV',
    rowCount: doc.table.rows.length,
    colCount: columns,
    cell: (row, col) => {
      if (row < 0 || col < 0 || row >= doc.table.rows.length || col >= columns) return null
      return { text: csvCell(doc, row, col) }
    },
    columnWidth: (col) => widths[col],
  }
}

/** 给调试/测试用的字段转义入口，保持和编辑补丁同一规则 */
export function csvField(value: string, doc: CsvDocument, quoted = false): string {
  return serializeField(value, doc.table.delimiter, quoted)
}

/** Codec 形状：GridSurface 可直接用 payload 建适配器，Host 不解释 CSV 细节 */
export const csvCodec = {
  id: 'csv',
  formats: ['csv', 'tsv'],
  kind: 'grid' as const,
  open: async (source: EditorSource): Promise<SurfaceDocument> => {
    const doc = openCsv(source)
    return {
      kind: 'grid',
      format: /\.tsv$/i.test(source.name) ? 'tsv' : 'csv',
      revision: 0,
      payload: doc,
    }
  },
  save: async (document: SurfaceDocument, source: EditorSource): Promise<EditorSource> => {
    const doc = document.payload as CsvDocument
    return serializeCsv(doc, source.name)
  },
}
