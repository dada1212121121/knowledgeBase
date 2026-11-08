/**
 * CSV → GridAdapter（设计规范）
 *
 * 适配器持有不可变的 `CsvDocument`：每次编辑都生成新文档（补丁只动改动字段），
 * 撤销栈保存旧文档引用，所以没有「深拷贝整张表」的开销。
 * 数据源永远是原始文本，Grid 只是它的一个视图；保存仍是原始字节。
 *
 * 插入行：CSV 里全空白的行解析时会被丢掉，空行没法直接写进文本，所以新行先作为「待写入的行」
 * 留在视图里（带底色），用户往里填了内容才真正落进文本。待写入的行和文档一起进撤销栈。
 */
import type { EditorSource } from '../../types'
import {
  CSV_MAX_EDIT_ROWS,
  applyCsvChanges,
  appendCsvRow,
  csvEditable,
  csvToGridSheet,
  deleteCsvRows,
  openCsv,
  openCsvAsync,
  serializeCsv,
  type CsvDocument,
  type CsvRowInsert,
  type CsvTextSource,
} from '../../codecs/csv'
import type { GridAdapter } from './surface'
import { dropInserted, isBlankRow, placeBlankRows, settleAfterDelete, settleAfterMaterialize, withInsertedRows } from './rowEdits'
import { RowLayout, type InsertedRow } from './rowLayout'
import type { GridEdit, GridSheet } from './types'

/** 撤销栈里的一步：文档 + 当时待写入的新行（两者都是不可变引用） */
interface Snapshot {
  doc: CsvDocument
  pending: readonly InsertedRow[]
}

/** 新行的格子可能有空洞（只填了第 3 列），补成连续数组并去掉末尾的空格子 */
export function compactValues(values: readonly string[]): string[] {
  const filled = Array.from(values, (value) => value ?? '')
  let end = filled.length
  while (end > 1 && filled[end - 1] === '') end -= 1
  return filled.slice(0, end)
}

export class CsvGridAdapter implements GridAdapter {
  private doc: CsvDocument
  private pending: readonly InsertedRow[] = []
  private nextId = 1
  private version = 0
  private undoStack: Snapshot[] = []
  private redoStack: Snapshot[] = []
  private cached: { doc: CsvDocument; pending: readonly InsertedRow[]; sheet: GridSheet } | null = null

  /** 同步打开（测试 / 小表）；已经解析好的文档直接传进来（大表由 create 在 Worker 里解析） */
  constructor(source: EditorSource | CsvDocument) {
    this.doc = 'table' in source ? source : openCsv(source)
  }

  /** 异步打开：大表在 Worker 里解析，不在主线程留长任务 */
  static async create(source: EditorSource): Promise<CsvGridAdapter> {
    return new CsvGridAdapter(await openCsvAsync(source))
  }

  sheets(): readonly GridSheet[] {
    if (this.cached?.doc !== this.doc || this.cached.pending !== this.pending) {
      const base = csvToGridSheet(this.doc)
      this.cached = { doc: this.doc, pending: this.pending, sheet: this.pending.length ? withInsertedRows(base, this.layout()) : base }
    }
    return [this.cached.sheet]
  }

  activeIndex(): number {
    return 0
  }

  setActive(_index: number): void {
    // CSV 只有一个逻辑工作表；保留接口给 xlsx 多 sheet 适配器
  }

  revision(): number {
    return this.version
  }

  private layout(): RowLayout {
    return new RowLayout(this.doc.table.rows.length, this.pending)
  }

  /** 记一步撤销，换上新状态 */
  private commit(doc: CsvDocument, pending: readonly InsertedRow[]): void {
    this.undoStack.push({ doc: this.doc, pending: this.pending })
    this.redoStack = []
    this.doc = doc
    this.pending = pending
    this.version += 1
  }

  apply(edits: GridEdit[]): boolean {
    if (!csvEditable(this.doc)) return false
    const layout = this.layout()
    const baseEdits: GridEdit[] = []
    const filled = new Map<number, string[]>()
    for (const edit of edits) {
      const source = layout.at(edit.row)
      if (!source) throw new Error(`第 ${edit.row + 1} 行不存在`)
      if (source.kind === 'base') {
        baseEdits.push({ ...edit, row: source.row })
        continue
      }
      // 待写入的新行：先攒在副本里，整批处理完看是不是填了内容
      const values = filled.get(source.inserted.id) ?? [...source.inserted.values]
      while (values.length <= edit.col) values.push('')
      values[edit.col] = edit.text
      filled.set(source.inserted.id, values)
    }
    // 填了内容的新行落进文本；还是空的继续留在视图里
    const inserts: CsvRowInsert[] = []
    const written = new Set<number>()
    this.pending.forEach((row, seq) => {
      const values = filled.get(row.id)
      if (!values || isBlankRow(values)) return
      inserts.push({ at: row.at, values: compactValues(values), seq })
      written.add(row.id)
    })
    const next = applyCsvChanges(this.doc, baseEdits, inserts)
    if (next === this.doc) return false
    this.commit(next, settleAfterMaterialize(this.pending, written))
    return true
  }

  /** 追加一行：CSV 的空行在解析时会被跳过，所以必须带至少一个非空值或显式空字段 */
  appendRow(values: readonly string[]): boolean {
    if (!csvEditable(this.doc)) return false
    this.commit(appendCsvRow(this.doc, values), this.pending)
    return true
  }

  insertRows(at: number, count: number): boolean {
    if (!csvEditable(this.doc) || this.doc.table.rows.length + this.pending.length + count > CSV_MAX_EDIT_ROWS) return false
    const next = placeBlankRows(this.pending, this.layout(), this.doc.table.rows.length, at, count, () => this.nextId++)
    if (next.length === this.pending.length) return false
    this.commit(this.doc, next)
    return true
  }

  deleteRows(from: number, to: number): boolean {
    if (!csvEditable(this.doc)) return false
    const layout = this.layout()
    const baseRows: number[] = []
    const gone = new Set<number>()
    for (let view = Math.max(0, from); view <= Math.min(to, layout.count - 1); view += 1) {
      const source = layout.at(view)
      if (source?.kind === 'base') baseRows.push(source.row)
      else if (source?.kind === 'inserted') gone.add(source.inserted.id)
    }
    if (!baseRows.length && !gone.size) return false
    const doc = baseRows.length ? deleteCsvRows(this.doc, baseRows) : this.doc
    this.commit(doc, settleAfterDelete(dropInserted(this.pending, gone), baseRows.sort((left, right) => left - right)))
    return true
  }

  undo(): boolean {
    const previous = this.undoStack.pop()
    if (!previous) return false
    this.redoStack.push({ doc: this.doc, pending: this.pending })
    this.doc = previous.doc
    this.pending = previous.pending
    this.version += 1
    return true
  }

  redo(): boolean {
    const next = this.redoStack.pop()
    if (!next) return false
    this.undoStack.push({ doc: this.doc, pending: this.pending })
    this.doc = next.doc
    this.pending = next.pending
    this.version += 1
    return true
  }

  readonly(): boolean {
    return !csvEditable(this.doc)
  }

  /** 未改动时 serializeCsv 原样输出（BOM / CRLF / 末尾换行都不动）；待写入的空行不在文本里，不会被保存 */
  snapshot(): CsvTextSource {
    return serializeCsv(this.doc)
  }

  get document(): CsvDocument {
    return this.doc
  }
}
