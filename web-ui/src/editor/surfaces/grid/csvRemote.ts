/**
 * 服务端分页的表格适配器
 *
 * 什么时候用：CSV / TSV 超过 512 KB（整份读不进浏览器编辑）或不是 UTF-8（GBK / GB18030 / UTF-16）。
 * 这两类文件的「逐字节原样写回」只有服务端能保证（`csv_edit` 按文件原来的编码、分隔符、引号、换行写），
 * 所以这里不解码、不序列化整份文本，只做三件事：
 *
 * 1. 按页取行：`cell` 只读已经读进来的页，没读到的返回 null；真正的取页由「视图滚到哪里」驱动（`prefetch`），
 *    只取当前看得见的页，快速拖动滚动条时不会为路过的每一页发请求。
 * 2. 草稿：改格子 / 插入行 / 删除行都记在草稿里（行号一律指打开时的表），不碰已读入的页；
 *    草稿是不可变的，撤销栈里存的旧草稿永远有效，翻页、页被淘汰都不会丢改动。
 * 3. 保存：把草稿翻译成操作列表交给后端（带打开时的版本号和内容哈希做乐观锁）；被拒绝（冲突）时草稿原样保留。
 *
 * 不依赖 Vue / DOM / 网络；后端由页面注入（`RemoteTableBackend`），单测用内存假后端。
 */
import { columnWidths } from '@/utils/tabular'
import type { RemoteTableBackend, RemoteTableFormat, RemoteTableOp, RemoteTablePage, SaveResult } from '../../types'
import { RemoteTableConflict } from '../../types'
import type { GridAdapter, GridChange } from './surface'
import { CHANGED_CELL_TINT, PENDING_ROW_TINT, isBlankRow, placeBlankRows } from './rowEdits'
import { RowLayout, type InsertedRow } from './rowLayout'
import type { GridCell, GridEdit, GridSheet } from './types'

/** 一页多少行：服务端每次取页都要把整份文件读一遍再解析，页大一点请求就少一点（上限 2000） */
export const REMOTE_PAGE_ROWS = 500
/** 内存里最多留几页；超出时丢掉离当前视口最远的页（改动在草稿里，不会丢） */
export const REMOTE_MAX_PAGES = 48
/** 同时在途的取页请求数 */
const MAX_INFLIGHT = 2
/** 取页失败后多久才允许重试 */
const RETRY_MS = 2000
/** 一次最多提交多少个操作（与服务端 `MAX_OPS` 一致） */
export const REMOTE_MAX_OPS = 5000
/** 一个格子最多多少字符（与服务端 `MAX_CELL_CHARS` 一致） */
const MAX_CELL_CHARS = 32_767

/** 草稿：全部以「打开时的行号」为准 */
export interface RemoteDraft {
  /** `行:列` → 新内容（只记和原来不同的） */
  readonly cells: ReadonlyMap<string, string>
  /** 被删除的行 */
  readonly deleted: ReadonlySet<number>
  /** 新插入的行 */
  readonly inserts: readonly InsertedRow[]
}

const EMPTY_DRAFT: RemoteDraft = { cells: new Map(), deleted: new Set(), inserts: [] }

const cellKey = (row: number, col: number) => `${row}:${col}`
const pageOf = (row: number) => Math.floor(row / REMOTE_PAGE_ROWS)

/** 草稿 → 后端操作列表。被删行上的格子改动不提交（服务端会拒绝「同时修改和删除」）；一个字都没填的新行不提交 */
export function draftToOps(draft: RemoteDraft): RemoteTableOp[] {
  const ops: RemoteTableOp[] = []
  for (const [key, value] of draft.cells) {
    const [row, col] = key.split(':').map(Number) as [number, number]
    if (draft.deleted.has(row)) continue
    ops.push({ op: 'set_cell', row, col, value })
  }
  for (const row of [...draft.deleted].sort((left, right) => left - right)) ops.push({ op: 'delete_row', row })
  for (const insert of draft.inserts) {
    if (isBlankRow(insert.values)) continue
    let end = insert.values.length
    while (end > 1 && insert.values[end - 1] === '') end -= 1
    ops.push({ op: 'insert_row', at: insert.at, values: Array.from(insert.values.slice(0, end), (value) => value ?? '') })
  }
  return ops
}

const delimiterName = (value: string) => ({ ',': '逗号', ';': '分号', '\t': '制表符', '|': '竖线' })[value] ?? value
const newlineName = (value: string) => ({ lf: 'LF', crlf: 'CRLF', cr: 'CR' })[value] ?? value

export class ServerCsvAdapter implements GridAdapter {
  private total: number
  private columns: number
  private format: RemoteTableFormat
  private widths: number[]
  /** 打开（或上次保存）时拿到的版本号和内容哈希：保存时带回去 */
  private opened: { version: number; sha256: string }
  /** 基线换代：保存成功后旧基线上发出去的取页请求结果一律作废 */
  private epoch = 0
  private pages = new Map<number, string[][]>()
  private inflight = new Set<number>()
  private failedAt = new Map<number, number>()
  private wanted: number[] = []
  private focusPage = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false

  private draft: RemoteDraft = EMPTY_DRAFT
  private undoStack: RemoteDraft[] = []
  private redoStack: RemoteDraft[] = []
  private nextId = 1
  private version = 0
  private stale = false
  private saving = false
  private loadError = ''
  /** 最近一次被拒绝的操作的原因（下一次成功的编辑清掉） */
  private notice = ''
  private layoutCache: RowLayout | null = null
  private sheetCache: GridSheet | null = null
  private listeners = new Set<(change?: GridChange) => void>()

  constructor(
    private readonly backend: RemoteTableBackend,
    private readonly name: string,
    first: RemoteTablePage,
  ) {
    this.total = first.totalRows
    this.columns = Math.max(1, first.columns)
    this.format = first.format
    this.opened = { version: first.version, sha256: first.sha256 }
    this.pages.set(0, first.rows)
    this.widths = columnWidths(first.rows, this.columns)
  }

  /** 读第一页并建立适配器；读不到（文件太大 / 编码无法还原 / 无权限）就抛错，由 Host 给出回退入口 */
  static async create(backend: RemoteTableBackend, name: string): Promise<ServerCsvAdapter> {
    return new ServerCsvAdapter(backend, name, await backend.read(0, REMOTE_PAGE_ROWS))
  }

  /* ---------------------------------------------------------------- 视图 */

  private layout(): RowLayout {
    this.layoutCache ??= new RowLayout(this.total, this.draft.inserts, this.draft.deleted)
    return this.layoutCache
  }

  sheets(): readonly GridSheet[] {
    this.sheetCache ??= this.buildSheet()
    return [this.sheetCache]
  }

  private buildSheet(): GridSheet {
    const layout = this.layout()
    const draft = this.draft
    return {
      name: this.name || 'CSV',
      rowCount: layout.count,
      colCount: this.columns,
      cell: (row, col): GridCell | null => {
        const source = layout.at(row)
        if (!source || col < 0 || col >= this.columns) return null
        if (source.kind === 'inserted') return { text: source.inserted.values[col] ?? '', background: PENDING_ROW_TINT }
        const edited = draft.cells.get(cellKey(source.row, col))
        if (edited !== undefined) return { text: edited, background: CHANGED_CELL_TINT }
        const page = this.pages.get(pageOf(source.row))
        // 这一页还没读进来：留空，读到之后适配器会通知视图重画
        if (!page) return null
        return { text: page[source.row % REMOTE_PAGE_ROWS]?.[col] ?? '' }
      },
      columnWidth: (col) => this.widths[col],
      scanRanges: () => this.loadedViewRanges(layout),
    }
  }

  /** 已读入的页对应的视图行区间（含新行）：查找只扫这些 */
  private loadedViewRanges(layout: RowLayout): Array<[number, number]> {
    const views: number[] = []
    for (const page of this.pages.keys()) {
      const end = Math.min(this.total, (page + 1) * REMOTE_PAGE_ROWS)
      for (let row = page * REMOTE_PAGE_ROWS; row < end; row += 1) {
        const view = layout.viewOfBase(row)
        if (view >= 0) views.push(view)
      }
    }
    for (const { view } of layout.insertedViews()) views.push(view)
    views.sort((left, right) => left - right)
    const ranges: Array<[number, number]> = []
    for (const view of views) {
      const last = ranges[ranges.length - 1]
      if (last && last[1] === view) last[1] = view + 1
      else if (!last || view >= last[1]) ranges.push([view, view + 1])
    }
    return ranges
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

  subscribe(listener: (change?: GridChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(change: GridChange): void {
    if (this.destroyed) return
    for (const listener of this.listeners) listener(change)
  }

  /** 草稿 / 总行数变了：布局和表对象都要重建，视图靠 revision 重算几何 */
  private invalidate(): void {
    this.layoutCache = null
    this.sheetCache = null
    this.version += 1
  }

  readonly(): boolean {
    // 取页发现文件已被别人改过：继续改没有意义（保存必然被拒），转只读；草稿还在，可以复制出来
    return this.stale
  }

  dirty(): boolean {
    return draftToOps(this.draft).length > 0
  }

  stats(): { words: number; unitLabel: string } {
    return { words: this.layout().count, unitLabel: '行' }
  }

  statusText(): string {
    const parts = [`${this.format.encodingLabel} · ${delimiterName(this.format.delimiter)}分隔 · ${newlineName(this.format.newline)}`]
    if (this.saving) parts.push('保存中…')
    else if (this.stale) parts.push('文件在你打开之后被改动，已停止读取新的行；保存会被拒绝，请放弃修改后重新打开')
    else if (this.loadError) parts.push(this.loadError)
    else if (this.inflight.size) parts.push('正在读取…')
    const ops = draftToOps(this.draft)
    if (ops.length) {
      const cells = ops.filter((op) => op.op === 'set_cell').length
      const deleted = ops.filter((op) => op.op === 'delete_row').length
      const added = ops.filter((op) => op.op === 'insert_row').length
      parts.push([cells && `改了 ${cells} 个格子`, deleted && `删 ${deleted} 行`, added && `加 ${added} 行`].filter(Boolean).join('，'))
    }
    if (this.notice) parts.push(this.notice)
    return parts.join(' · ')
  }

  /* ---------------------------------------------------------------- 取页 */

  /** 视图滚到了 [firstRow, lastRow)：把看得见的页排到前面，再顺带取前后各一页（滚动是连续的） */
  prefetch(firstRow: number, lastRow: number): void {
    if (this.destroyed || this.stale) return
    const layout = this.layout()
    const visible: number[] = []
    const seen = new Set<number>()
    for (let view = Math.max(0, firstRow); view < Math.min(lastRow, layout.count); view += 1) {
      const source = layout.at(view)
      if (source?.kind !== 'base') continue
      const page = pageOf(source.row)
      if (!seen.has(page)) {
        seen.add(page)
        visible.push(page)
      }
    }
    if (!visible.length) return
    this.focusPage = visible[0]!
    const lastPage = pageOf(Math.max(0, this.total - 1))
    const around: number[] = []
    for (const page of visible) {
      for (const next of [page + 1, page - 1]) if (next >= 0 && next <= lastPage && !seen.has(next)) around.push(next)
    }
    this.wanted = [...visible, ...around]
    this.pump()
  }

  /** 按「当前想要的页」补满在途请求；想要的页之外的（早已滚过去的）不取 */
  private pump(): void {
    if (this.destroyed || this.stale) return
    const now = Date.now()
    for (const page of this.wanted) {
      if (this.inflight.size >= MAX_INFLIGHT) break
      if (this.pages.has(page) || this.inflight.has(page)) continue
      const failed = this.failedAt.get(page)
      if (failed !== undefined && now - failed < RETRY_MS) continue
      this.load(page)
    }
  }

  private load(page: number): void {
    const epoch = this.epoch
    this.inflight.add(page)
    void this.backend
      .read(page * REMOTE_PAGE_ROWS, REMOTE_PAGE_ROWS)
      .then((result) => {
        if (epoch !== this.epoch || this.destroyed) return
        // 文件在这一页读进来之前被改过：版本或哈希对不上，不能把两个版本的行拼在一张表里
        if (result.sha256 !== this.opened.sha256 || result.version !== this.opened.version) {
          this.stale = true
          this.notify('structure')
          return
        }
        this.failedAt.delete(page)
        this.loadError = ''
        this.pages.set(page, result.rows)
        this.evict()
        this.notify('data')
      })
      .catch((error: unknown) => {
        if (epoch !== this.epoch || this.destroyed) return
        this.failedAt.set(page, Date.now())
        this.loadError = `第 ${page * REMOTE_PAGE_ROWS + 1} 行附近读取失败：${error instanceof Error ? error.message : String(error)}（稍后自动重试）`
        this.notify('data')
        this.retryTimer ??= setTimeout(() => {
          this.retryTimer = null
          this.pump()
        }, RETRY_MS)
      })
      .finally(() => {
        this.inflight.delete(page)
        this.pump()
      })
  }

  /** 丢掉离当前视口最远的页 */
  private evict(): void {
    while (this.pages.size > REMOTE_MAX_PAGES) {
      let farthest = -1
      let distance = -1
      for (const page of this.pages.keys()) {
        if (this.wanted.includes(page)) continue
        const gap = Math.abs(page - this.focusPage)
        if (gap > distance) {
          distance = gap
          farthest = page
        }
      }
      if (farthest < 0) return
      this.pages.delete(farthest)
    }
  }

  /* ---------------------------------------------------------------- 编辑 */

  /** 草稿换成新的一版：记撤销、清重做 */
  private commit(next: RemoteDraft): void {
    this.undoStack.push(this.draft)
    this.redoStack = []
    this.draft = next
    this.notice = ''
    this.invalidate()
  }

  /** 被拒绝的原因要让用户看见（状态栏），不能静默吞掉 */
  private refuse(reason: string): false {
    this.notice = reason
    this.notify('data')
    return false
  }

  private overLimit(next: RemoteDraft): boolean {
    return draftToOps(next).length > REMOTE_MAX_OPS
  }

  apply(edits: GridEdit[]): boolean {
    if (this.readonly() || this.saving) return false
    const layout = this.layout()
    const cells = new Map(this.draft.cells)
    const filled = new Map<number, string[]>()
    let changed = false
    for (const edit of edits) {
      if (edit.text.includes('\0')) return this.refuse('格子里不能有 NUL 字符')
      if (edit.text.length > MAX_CELL_CHARS) return this.refuse(`一个格子最多 ${MAX_CELL_CHARS} 个字符`)
      const source = layout.at(edit.row)
      if (!source || edit.col < 0 || edit.col >= this.columns) continue
      if (source.kind === 'inserted') {
        const values = filled.get(source.inserted.id) ?? [...source.inserted.values]
        while (values.length <= edit.col) values.push('')
        if (values[edit.col] === edit.text) continue
        values[edit.col] = edit.text
        filled.set(source.inserted.id, values)
        changed = true
        continue
      }
      const page = this.pages.get(pageOf(source.row))
      // 这一行还没读进来，不知道原值：不改（清空选区这类大范围操作会扫到没读到的行）
      if (!page) continue
      const original = page[source.row % REMOTE_PAGE_ROWS]?.[edit.col] ?? ''
      const key = cellKey(source.row, edit.col)
      if (edit.text === (cells.get(key) ?? original)) continue
      if (edit.text === original) cells.delete(key)
      else cells.set(key, edit.text)
      changed = true
    }
    if (!changed) return false
    const inserts = filled.size ? this.draft.inserts.map((row) => (filled.has(row.id) ? { ...row, values: filled.get(row.id)! } : row)) : this.draft.inserts
    const next: RemoteDraft = { cells, deleted: this.draft.deleted, inserts }
    if (this.overLimit(next)) return this.refuse(`一次最多保存 ${REMOTE_MAX_OPS} 处改动，请先保存再继续`)
    this.commit(next)
    return true
  }

  insertRows(at: number, count: number): boolean {
    if (this.readonly() || this.saving) return false
    const inserts = placeBlankRows(this.draft.inserts, this.layout(), this.total, at, count, () => this.nextId++)
    if (inserts.length === this.draft.inserts.length) return false
    this.commit({ cells: this.draft.cells, deleted: this.draft.deleted, inserts })
    return true
  }

  deleteRows(from: number, to: number): boolean {
    if (this.readonly() || this.saving) return false
    const layout = this.layout()
    const first = Math.max(0, from)
    const last = Math.min(to, layout.count - 1)
    if (last < first) return false
    // 一次选了几十万行删：超过一次能提交的上限，直接说明，不去遍历
    if (last - first + 1 > REMOTE_MAX_OPS) return this.refuse(`一次最多删除 ${REMOTE_MAX_OPS} 行，请分几次删`)
    const deleted = new Set(this.draft.deleted)
    const gone = new Set<number>()
    for (let view = first; view <= last; view += 1) {
      const source = layout.at(view)
      if (source?.kind === 'base') deleted.add(source.row)
      else if (source?.kind === 'inserted') gone.add(source.inserted.id)
    }
    if (deleted.size === this.draft.deleted.size && !gone.size) return false
    const next: RemoteDraft = { cells: this.draft.cells, deleted, inserts: gone.size ? this.draft.inserts.filter((row) => !gone.has(row.id)) : this.draft.inserts }
    if (this.overLimit(next)) return this.refuse(`一次最多保存 ${REMOTE_MAX_OPS} 处改动，请先保存再继续`)
    this.commit(next)
    return true
  }

  undo(): boolean {
    if (this.saving) return false
    const previous = this.undoStack.pop()
    if (!previous) return false
    this.redoStack.push(this.draft)
    this.draft = previous
    this.notice = ''
    this.invalidate()
    return true
  }

  redo(): boolean {
    if (this.saving) return false
    const next = this.redoStack.pop()
    if (!next) return false
    this.undoStack.push(this.draft)
    this.draft = next
    this.notice = ''
    this.invalidate()
    return true
  }

  /* ---------------------------------------------------------------- 保存 */

  /**
   * 提交草稿。成功后以新的版本 / 哈希为基线、清空草稿与撤销栈并重读第一页；
   * 冲突或失败时草稿原样保留，用户可以复制出来或放弃后重新打开。
   */
  async save(): Promise<SaveResult> {
    const ops = draftToOps(this.draft)
    if (!ops.length) {
      // 只有没填内容的新行：没有可提交的，等于什么都没改
      this.resetDraft(false)
      return { ok: true, unchanged: true, revision: this.opened.version, sha256: this.opened.sha256 }
    }
    if (this.saving) return { ok: false, revision: this.opened.version, sha256: this.opened.sha256, reason: '正在保存' }
    this.saving = true
    this.notify('data')
    try {
      const result = await this.backend.edit(ops, { version: this.opened.version, sha256: this.opened.sha256 })
      this.opened = { version: result.version, sha256: result.sha256 }
      // 本地先按草稿推算新的总行数，重读第一页失败时表也是对的
      this.total = this.total - this.draft.deleted.size + ops.filter((op) => op.op === 'insert_row').length
      this.resetDraft(true)
      await this.reloadFirstPage()
      return { ok: true, unchanged: !result.changed, revision: result.version, sha256: result.sha256, embedded: result.embedded }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof RemoteTableConflict) {
        return { ok: false, revision: this.opened.version, sha256: this.opened.sha256, conflict: { serverRevision: this.opened.version + 1, message } }
      }
      return { ok: false, revision: this.opened.version, sha256: this.opened.sha256, reason: message }
    } finally {
      this.saving = false
      this.notify('structure')
      // 基线换了，视口里的页要按新基线重新取
      this.pump()
    }
  }

  /** 清草稿和撤销栈；`rebase` 为真时基线也换了（保存成功），旧基线的页和在途请求一并作废 */
  private resetDraft(rebase: boolean): void {
    this.draft = EMPTY_DRAFT
    this.undoStack = []
    this.redoStack = []
    this.notice = ''
    if (!rebase) return this.invalidate()
    this.stale = false
    this.epoch += 1
    this.pages.clear()
    this.inflight.clear()
    this.failedAt.clear()
    this.loadError = ''
    this.invalidate()
  }

  /** 保存后重读第一页：总行数、列数、写法都以服务端为准；读不到就沿用推算值，滚动时会按需重试 */
  private async reloadFirstPage(): Promise<void> {
    try {
      const first = await this.backend.read(0, REMOTE_PAGE_ROWS)
      this.total = first.totalRows
      this.columns = Math.max(1, first.columns)
      this.format = first.format
      this.opened = { version: first.version, sha256: first.sha256 }
      this.pages.set(0, first.rows)
      this.widths = columnWidths(first.rows, this.columns)
      this.invalidate()
    } catch (error) {
      this.loadError = `保存成功，但重新读取表格失败：${error instanceof Error ? error.message : String(error)}`
    }
  }

  destroy(): void {
    this.destroyed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.listeners.clear()
  }
}
