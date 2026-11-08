/**
 * CSV 协同适配器
 *
 * 房间里的真源是一段 Y.Text（和源码编辑器完全同一份文本）。
 * 表格只负责把「改哪个格子」翻译成文本补丁，然后作为一个事务写进 Y.Text：
 * - 两个人改不同格子 → 文本不同位置，Yjs 自然合并；
 * - 远端文本变化 → 重新解析并通知 Grid 视图（只重建视图状态，不重写文本）；
 * - 未触碰的记录、BOM、行尾、引号风格仍由文本本身保留。
 *
 * 没有 UndoManager：协同撤销属于房间策略，不能拿本地「旧文档快照」覆盖别人的修改。
 *
 * 行操作：删除行 = 对房间文本做最小删除（相邻行合并成一段），别人立刻看到；
 * 插入行 = 本地先留一个「待写入的空行」（CSV 里空白行不占行号，写不进文本），填了内容才作为一次文本插入发出去。
 * 待写入的行只存在于本机，不会替别人占位；房间里的行数变了就把它们的位置夹回合法范围。
 */
import {
  CSV_MAX_EDIT_ROWS,
  applyCsvSplices,
  csvChangeSplices,
  csvEditable,
  csvToGridSheet,
  deleteCsvRowsSplices,
  parseCsvText,
  parseCsvTextAsync,
  serializeCsv,
  type CsvDocument,
  type CsvRowInsert,
  type CsvTextSource,
} from '../codecs/csv'
import type { Splice } from '@/utils/csvText'
import type { CollabTextEvent, CollabTextLike } from '../types'
import type { GridAdapter } from '../surfaces/grid/surface'
import { compactValues } from '../surfaces/grid/csv'
import { dropInserted, isBlankRow, placeBlankRows, settleAfterDelete, settleAfterMaterialize, withInsertedRows } from '../surfaces/grid/rowEdits'
import { RowLayout, type InsertedRow } from '../surfaces/grid/rowLayout'
import type { GridEdit, GridSheet } from '../surfaces/grid/types'

export interface CsvCollabOptions {
  /** 房间里的纯文本（Y.Text） */
  text: CollabTextLike
  /** 文件名，用于 .tsv 判定与展示 */
  name: string
  /** 房间是否只读（服务端降级 / 无写权限）；默认 false */
  readonly?: () => boolean
}

export class CsvCollab implements GridAdapter {
  private readonly room: CollabTextLike
  private readonly name: string
  private readonly readonlyFn: (() => boolean) | undefined
  private doc: CsvDocument
  private version = 0
  /** Y.Text 里的 BOM 不在解析正文的下标体系里；打补丁要把它加回去 */
  private bomOffset = 0
  private listeners = new Set<() => void>()
  private cached: { doc: CsvDocument; pending: readonly InsertedRow[]; sheet: GridSheet } | null = null
  /** 本机待写入的空行（见文件头说明） */
  private pending: readonly InsertedRow[] = []
  private nextId = 1
  /**
   * 房间文本变了（别人改的，或者自己刚写进去的）：按这次的 delta 增量更新表格。
   * 以前每次都整份重解析——5 MB 的表别人每敲一个字就卡半秒，自己改一格还要解析两遍（Yjs 的观察器一遍、
   * apply 里同步刷新一遍）。增量结果与房间全文对不上（delta 缺失、动了 BOM、一笔改动跨了多条记录）时整份重解析兜底。
   */
  private readonly observer = (event?: CollabTextEvent) => {
    const raw = this.room.toString()
    const bom = raw.startsWith('\uFEFF') ? 1 : 0
    const body = bom ? raw.slice(1) : raw
    // 已经是最新的（apply 里同步刷新过，Yjs 的观察器又来一次）：不重复通知
    if (bom === this.bomOffset && body === this.doc.text) return
    let next: CsvDocument | null = null
    if (event?.delta && bom === this.bomOffset) {
      const splices = splicesFromDelta(event.delta, this.bomOffset)
      if (splices) {
        const candidate = applyCsvSplices(this.doc, splices)
        if (candidate.text === body) next = candidate
      }
    }
    this.bomOffset = bom
    this.doc = next ?? parseCsvText(raw, this.name)
    // 别人增删了行：待写入的行位置夹回 [0, 行数]，不能指向已经不存在的行
    const rowCount = this.doc.table.rows.length
    if (this.pending.some((row) => row.at > rowCount)) this.pending = this.pending.map((row) => (row.at > rowCount ? { ...row, at: rowCount } : row))
    this.version += 1
    for (const listener of this.listeners) listener()
  }

  constructor(options: CsvCollabOptions, initial?: CsvDocument) {
    this.room = options.text
    this.name = options.name
    this.readonlyFn = options.readonly
    const raw = this.room.toString()
    this.bomOffset = raw.startsWith('\uFEFF') ? 1 : 0
    // 预先解析好的文档只有在房间文本没变过时才能用（解析期间可能有人改了）
    const body = this.bomOffset ? raw.slice(1) : raw
    this.doc = initial && initial.text === body ? initial : parseCsvText(raw, this.name)
    this.room.observe(this.observer)
  }

  /** 异步建立：首次解析在 Worker 里做；之后的变更都是增量更新 */
  static async create(options: CsvCollabOptions): Promise<CsvCollab> {
    return new CsvCollab(options, await parseCsvTextAsync(options.text.toString(), options.name))
  }

  destroy(): void {
    this.room.unobserve(this.observer)
    this.listeners.clear()
  }

  sheets(): readonly GridSheet[] {
    if (this.cached?.doc !== this.doc || this.cached.pending !== this.pending) {
      const base = csvToGridSheet(this.doc)
      this.cached = { doc: this.doc, pending: this.pending, sheet: this.pending.length ? withInsertedRows(base, this.layout()) : base }
    }
    return [this.cached.sheet]
  }

  private layout(): RowLayout {
    return new RowLayout(this.doc.table.rows.length, this.pending)
  }

  /** 把一串补丁作为一个事务写进房间文本；其他人不会看到「先删后插」的中间态 */
  private write(splices: readonly Splice[]): void {
    const run = () => {
      for (const splice of splices) {
        const index = splice.index + this.bomOffset
        if (splice.remove) this.room.delete(index, splice.remove)
        if (splice.insert) this.room.insert(index, splice.insert)
      }
    }
    const doc = this.room.doc
    if (doc) doc.transact(run)
    else run()
    // 某些 Yjs 实现（或未绑定 doc 的 Text）观察器是异步的；这里同步刷新，保证网格立刻回显
    this.observer()
  }

  activeIndex(): number {
    return 0
  }

  setActive(_index: number): void {
    // 单表
  }

  revision(): number {
    return this.version
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  apply(edits: GridEdit[]): boolean {
    if (this.readonly() || !csvEditable(this.doc)) return false
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
      const values = filled.get(source.inserted.id) ?? [...source.inserted.values]
      while (values.length <= edit.col) values.push('')
      values[edit.col] = edit.text
      filled.set(source.inserted.id, values)
    }
    const inserts: CsvRowInsert[] = []
    const written = new Set<number>()
    this.pending.forEach((row, seq) => {
      const values = filled.get(row.id)
      if (!values || isBlankRow(values)) return
      inserts.push({ at: row.at, values: compactValues(values), seq })
      written.add(row.id)
    })
    const splices = csvChangeSplices(this.doc, baseEdits, inserts)
    if (!splices.length) return false
    // 先把写进文本的新行从待写入里去掉：观察器回显时不能同一行显示两遍
    if (written.size) this.pending = settleAfterMaterialize(this.pending, written)
    this.write(splices)
    return true
  }

  insertRows(at: number, count: number): boolean {
    if (this.readonly() || !csvEditable(this.doc) || this.doc.table.rows.length + this.pending.length + count > CSV_MAX_EDIT_ROWS) return false
    const next = placeBlankRows(this.pending, this.layout(), this.doc.table.rows.length, at, count, () => this.nextId++)
    if (next.length === this.pending.length) return false
    this.pending = next
    this.version += 1
    for (const listener of this.listeners) listener()
    return true
  }

  deleteRows(from: number, to: number): boolean {
    if (this.readonly() || !csvEditable(this.doc)) return false
    const layout = this.layout()
    const baseRows: number[] = []
    const gone = new Set<number>()
    for (let view = Math.max(0, from); view <= Math.min(to, layout.count - 1); view += 1) {
      const source = layout.at(view)
      if (source?.kind === 'base') baseRows.push(source.row)
      else if (source?.kind === 'inserted') gone.add(source.inserted.id)
    }
    if (!baseRows.length && !gone.size) return false
    this.pending = settleAfterDelete(dropInserted(this.pending, gone), [...baseRows].sort((left, right) => left - right))
    if (baseRows.length) this.write(deleteCsvRowsSplices(this.doc, baseRows))
    else {
      this.version += 1
      for (const listener of this.listeners) listener()
    }
    return true
  }

  undo(): boolean {
    return false
  }

  redo(): boolean {
    return false
  }

  readonly(): boolean {
    return this.readonlyFn?.() ?? false
  }

  snapshot(): CsvTextSource {
    return serializeCsv(this.doc, this.name)
  }

  get document(): CsvDocument {
    return this.doc
  }
}

/**
 * Y.Text 的 delta（retain / insert / delete，按顺序作用在变化前的文本上）→ 正文坐标里的一串替换。
 * 相邻的「删 + 插」并成一笔替换（改一格就是一笔，增量更新只碰一条记录）；
 * 动到 BOM（下标落到正文之前）或插入了非文字内容时返回 null，交给整份重解析。
 */
export function splicesFromDelta(delta: NonNullable<CollabTextEvent['delta']>, bomOffset: number): Splice[] | null {
  const splices: Splice[] = []
  let position = 0
  for (const op of delta) {
    if (typeof op.retain === 'number') {
      position += op.retain
      continue
    }
    const index = position - bomOffset
    if (index < 0) return null
    const last = splices[splices.length - 1]
    if (typeof op.insert === 'string') {
      if (last && last.insert === '' && last.index === index) last.insert = op.insert
      else splices.push({ index, remove: 0, insert: op.insert })
      position += op.insert.length
    } else if (typeof op.delete === 'number') {
      if (last && last.remove === 0 && last.index + last.insert.length === index) last.remove = op.delete
      else splices.push({ index, remove: op.delete, insert: '' })
    } else if (op.insert !== undefined) {
      return null
    }
  }
  return splices
}
