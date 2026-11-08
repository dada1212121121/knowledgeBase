/**
 * Grid Surface 控制器
 *
 * 数据源由适配器提供：CSV 是文本 codec，XLSX 是引擎会话；控制器只认识 `GridAdapter`，
 * 这样 / 换数据来源时不用改绘制与键盘。
 *
 * 视图通过 `createApp` 单独挂载，不依赖外层 Vue 组件树；`sheet` 用 shallowReactive 包一层，
 * 大表数据本身仍是普通对象，不会进入深度响应式。
 */
import { createApp, h, nextTick, ref, shallowReactive } from 'vue'
import type { Anchor, CollabTextLike, CommandResult, EditorCommand, EditorSource, SaveOptions, SaveResult, Selection, Size, Surface, SurfaceContext, SurfaceDocument, SurfaceQuery, SurfaceState } from '../../types'
import GridSurfaceView from './GridSurface.vue'
import { CsvCollab } from '../../collab/CsvCollab'
import { CsvGridAdapter } from './csv'
import { ServerCsvAdapter } from './csvRemote'
import { columnLabel } from './painter'
import type { CellCoord, GridEdit, GridSelection, GridSheet } from './types'

/**
 * 数据源通知视图的两种变化：
 * - `structure`（缺省）：行列数 / 表对象变了（编辑、撤销、协同里别人的修改），视图重建几何；
 * - `data`：只有格子内容变了（分页表读进来一页），视图只重画，选区和查找结果保持。
 */
export type GridChange = 'data' | 'structure'

/** GridSurface 需要的数据源能力；实现方负责真正的解析 / 保存 */
export interface GridAdapter {
  sheets(): readonly GridSheet[]
  activeIndex(): number
  setActive(index: number): void
  /** 落一次编辑；返回 false 表示被拒绝（只读 / 公式错误 / 引擎失败） */
  apply(edits: GridEdit[]): boolean | Promise<boolean>
  /** 当前数据版本；sheet 对象可变时靠它触发重绘 */
  revision(): number
  /** 远端 / 引擎异步变更订阅（协同文本、xlsx worker、分页表取页）；返回退订函数 */
  subscribe?(listener: (change?: GridChange) => void): () => void
  /** 保存快照；不提供表示这个数据源不走 Host 保存（如只读 xlsx） */
  snapshot?(): EditorSource | null
  undo?(): boolean | Promise<boolean>
  redo?(): boolean | Promise<boolean>
  /** 在视图第 `at` 行之前插入 `count` 个空行（`at` 等于行数就是加在最后）；不支持行操作的数据源不实现 */
  insertRows?(at: number, count: number): boolean | Promise<boolean>
  /** 删除视图第 `from`～`to` 行（含两端） */
  deleteRows?(from: number, to: number): boolean | Promise<boolean>
  /** 有没有没保存的改动：撤销回到原样后要能清掉脏标记；不实现则「改过就算脏」 */
  dirty?(): boolean
  /** 底部状态栏的补充说明（编码 / 读取进度 / 改动摘要 / 被拒绝的原因） */
  statusText?(): string
  /** 视口滚到了视图的 [firstRow, lastRow) 行：分页数据源据此按需取页 */
  prefetch?(firstRow: number, lastRow: number): void
  /** 页头的统计（总行数等）；不实现则按非空格子数 */
  stats?(): { words: number; unitLabel: string }
  /** 数据源自己的保存（服务端分页表：提交操作列表）；实现了就取代 Host 的整份文本保存 */
  save?(options: SaveOptions): Promise<SaveResult>
  /** 释放远端订阅（协同适配器）；普通适配器可以不实现 */
  destroy?(): void
  readonly?(): boolean
}

export interface GridSurfaceOptions {
  /** 显式适配器（测试 / 引擎接入）；不传时按文档格式从首屏 source 自行建适配器 */
  adapter?: GridAdapter
}

function cellAddress(row: number, col: number): string {
  return `${columnLabel(col)}${row + 1}`
}

function cellAnchor(sheet: GridSheet, range: { top: number; left: number; bottom: number; right: number }): Anchor {
  const start = cellAddress(range.top, range.left)
  const end = cellAddress(range.bottom, range.right)
  return { kind: 'cell', sheet: sheet.name, cell: start, ...(start !== end ? { endCell: end } : {}) }
}

export class GridSurface implements Surface {
  private adapter!: GridAdapter
  private ctx: SurfaceContext | null = null
  private app: ReturnType<typeof createApp> | null = null
  private root: HTMLElement | null = null
  private viewRef = ref<InstanceType<typeof GridSurfaceView> | null>(null)
  private state = shallowReactive<{ sheet: GridSheet; sheets: readonly GridSheet[]; activeSheet: number; revision: number; dataTick: number; note: string }>({
    sheet: { name: 'Sheet1', rowCount: 0, colCount: 0, cell: () => null },
    sheets: [],
    activeSheet: 0,
    revision: 0,
    dataTick: 0,
    note: '',
  })
  private lastSelection: Selection | null = null
  private adapterUnsub: (() => void) | null = null

  constructor(options: GridSurfaceOptions = {}) {
    if (options.adapter) this.adapter = options.adapter
  }

  async mount(el: HTMLElement, ctx: SurfaceContext): Promise<void> {
    this.ctx = ctx
    this.root = el
    if (!this.adapter) {
      this.adapter = await this.adapterFor(ctx)
    }
    this.syncState()
    this.app = createApp({
      render: () =>
        h(GridSurfaceView, {
          ref: this.viewRef,
          sheet: this.state.sheet,
          sheets: this.state.sheets,
          activeSheet: this.state.activeSheet,
          revision: this.state.revision,
          dataTick: this.state.dataTick,
          note: this.state.note,
          rowOps: !!this.adapter.insertRows && !!this.adapter.deleteRows && !ctx.readonly && !(this.adapter.readonly?.() ?? false),
          readonly: ctx.readonly || (this.adapter.readonly?.() ?? false),
          label: `${this.state.sheet.name} 表格`,
          onEdit: (edits: GridEdit[]) => void this.handleEdits(edits),
          onVisible: (range: { firstRow: number; lastRow: number }) => this.adapter.prefetch?.(range.firstRow, range.lastRow),
          onRowAction: (action: 'insertAbove' | 'insertBelow' | 'delete') => void this.runRowAction(action),
          onSelection: (payload: { row: number; col: number; text: string; range: { top: number; left: number; bottom: number; right: number } }) =>
            this.handleSelection(payload),
          onSelectSheet: (index: number) => {
            this.adapter.setActive(index)
            this.syncState()
            ctx.onDirtyChange?.(ctx.session.dirty)
          },
          onFindRequest: () => ctx.onFindRequest?.(),
          onUndo: () => void this.undo(),
          onRedo: () => void this.redo(),
        }),
    })
    this.app.mount(el)
    el.classList.add('kb-gs-surface')
    // 协同 / worker / 分页取页的变更不会经过 handleEdits，靠适配器订阅把新数据推回视图
    this.adapterUnsub =
      this.adapter.subscribe?.((change) => {
        if (change === 'data') this.refreshData()
        else this.syncState()
      }) ?? null
    if (this.adapter.save) {
      // 服务端分页表：保存的是操作列表，由适配器自己提交（带乐观锁），不经过 Host 的整份文本通道
      const save = this.adapter.save.bind(this.adapter)
      ctx.session.setSaveHandler?.((options) => save(options))
    } else if (!ctx.collabText) {
      // 协同房间由服务端负责落地；本地保存快照会绕过房间编码写盘，所以不注册
      ctx.session.setSnapshotProvider?.(() => this.adapter.snapshot?.() ?? null)
    }
    ctx.onDirtyChange?.(ctx.session.dirty)
  }

  /** 首屏 source 来自 Host 的请求，不重新发网络请求；目前只有 CSV/TSV，xlsx 由 接入 */
  private async adapterFor(ctx: SurfaceContext): Promise<GridAdapter> {
    const format = ctx.document.format.toLowerCase()
    const source = ctx.document.payload as EditorSource
    if (format === 'csv' || format === 'tsv') {
      // 超过 512 KB 或不是 UTF-8：页面给了服务端分页数据源，按页取行、按操作列表保存
      if (ctx.remoteTable) return ServerCsvAdapter.create(ctx.remoteTable, source.name)
      // 房间文本优先：同一份 Y.Text，源码编辑器 / 旧表格视图 / 新网格改的都是它
      if (ctx.collabText) {
        return CsvCollab.create({
          text: ctx.collabText as CollabTextLike,
          name: source.name,
          readonly: () => !(ctx.collabWritable?.() ?? false),
        })
      }
      // 大表在 Worker 里解析：点「表格编辑」后主线程不再卡一整段
      return CsvGridAdapter.create(source)
    }
    throw new Error(`网格格式 .${format} 尚未接入`)
  }

  private syncState(): void {
    const sheets = this.adapter.sheets()
    const index = Math.min(Math.max(0, this.adapter.activeIndex()), Math.max(0, sheets.length - 1))
    this.state.sheets = sheets
    this.state.activeSheet = index
    this.state.sheet = sheets[index] ?? { name: 'Sheet1', rowCount: 0, colCount: 0, cell: () => null }
    this.state.revision = this.adapter.revision()
    this.state.note = this.adapter.statusText?.() ?? ''
  }

  /** 只有格子内容变了（分页表读进来一页）：不动表对象，视图只重画 */
  private refreshData(): void {
    this.state.dataTick += 1
    this.state.note = this.adapter.statusText?.() ?? ''
  }

  /**
   * 编辑 / 撤销 / 行操作之后把适配器的最新状态推给视图并更新脏标记。
   * 协同房间由服务端实时落地，本地没有「待保存」；标脏会让页面误以为还要手动保存。
   * 适配器自己知道有没有改动（分页表撤销回原样就不脏了）时听它的，否则「动过就脏」。
   */
  private afterChange(): void {
    this.state.sheet = this.adapter.sheets()[this.adapter.activeIndex()] ?? this.state.sheet
    this.state.revision = this.adapter.revision()
    this.state.note = this.adapter.statusText?.() ?? ''
    this.ctx?.onDirtyChange?.(!this.ctx.collabText && (this.adapter.dirty?.() ?? true))
  }

  private async handleEdits(edits: GridEdit[]): Promise<void> {
    if (!edits.length || this.ctx?.readonly || (this.adapter.readonly?.() ?? false)) return
    try {
      const applied = await this.adapter.apply(edits)
      // 被拒绝的原因（超过单次上限、格子里有 NUL…）要出现在状态栏，不能静默
      if (!applied) return this.refreshData()
      this.afterChange()
    } catch (err) {
      this.ctx?.onError?.(err instanceof Error ? err : new Error(String(err)))
    }
  }

  private handleSelection(payload: { row: number; col: number; text: string; range: { top: number; left: number; bottom: number; right: number } }): void {
    const range = payload.range
    const selection: Selection = {
      kind: 'grid',
      anchor: cellAnchor(this.state.sheet, range),
      isEmpty: payload.text.length === 0,
      text: payload.text,
    }
    this.lastSelection = selection
    this.ctx?.onSelectionChange?.(selection)
  }

  private async undo(): Promise<boolean> {
    const changed = (await this.adapter.undo?.()) ?? false
    if (changed) this.afterChange()
    return changed
  }

  private async redo(): Promise<boolean> {
    const changed = (await this.adapter.redo?.()) ?? false
    if (changed) this.afterChange()
    return changed
  }

  /** 选区覆盖的视图行（含两端）；视图没挂载时为空 */
  private selectedRows(): { top: number; bottom: number; col: number } | null {
    const selection = this.viewRef.value?.getSelection() as GridSelection | undefined
    if (!selection) return null
    // 整行选中时 anchor 在第 0 列、focus 在最后一列：新行的焦点放在选区最左的列，而不是最右
    return { top: Math.min(selection.anchor.row, selection.focus.row), bottom: Math.max(selection.anchor.row, selection.focus.row), col: Math.min(selection.anchor.col, selection.focus.col) }
  }

  /**
   * 行操作（右键菜单与工具栏共用）：在选中行上方 / 下方插入同样数量的空行，或删除选中的行。
   * 适配器自己决定怎么落（本地写文本 / 房间补丁 / 记进服务端草稿），这里只负责取选区、刷新视图、把焦点放到新行。
   */
  private async runRowAction(action: 'insertAbove' | 'insertBelow' | 'delete' | 'append'): Promise<CommandResult> {
    const adapter = this.adapter
    if (!adapter.insertRows || !adapter.deleteRows) return { ok: false, reason: 'unsupported_command:row' }
    if (this.ctx?.readonly || (adapter.readonly?.() ?? false)) return { ok: false, reason: 'readonly' }
    const rows = this.selectedRows() ?? { top: 0, bottom: 0, col: 0 }
    const count = rows.bottom - rows.top + 1
    const total = this.state.sheet.rowCount
    let applied = false
    let focusRow = rows.top
    try {
      if (action === 'insertAbove') applied = await adapter.insertRows(Math.min(rows.top, total), count)
      else if (action === 'insertBelow') {
        applied = await adapter.insertRows(Math.min(rows.bottom + 1, total), count)
        focusRow = rows.bottom + 1
      } else if (action === 'append') {
        applied = await adapter.insertRows(total, 1)
        focusRow = total
      } else applied = await adapter.deleteRows(rows.top, rows.bottom)
    } catch (err) {
      this.ctx?.onError?.(err instanceof Error ? err : new Error(String(err)))
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
    if (!applied) {
      this.refreshData()
      return { ok: false, reason: 'rejected' }
    }
    this.afterChange()
    // 视图要等下一轮渲染才拿到新的行数；先等它，再把焦点放到新行上（删除则由视图把选区夹回有效范围）
    await nextTick()
    if (action !== 'delete') this.viewRef.value?.reveal(focusRow, rows.col)
    this.viewRef.value?.focus()
    return { ok: true }
  }

  unmount(): void {
    this.adapterUnsub?.()
    this.adapterUnsub = null
    this.ctx?.session.setSnapshotProvider?.(null)
    this.ctx?.session.setSaveHandler?.(null)
    this.adapter.destroy?.()
    this.app?.unmount()
    this.app = null
    this.root?.classList.remove('kb-gs-surface')
    this.root = null
    this.ctx = null
  }

  resize(_size: Size): void {
    // 尺寸由组件内部 ResizeObserver 处理；这里保留 Surface 契约的空实现
  }

  focus(): void {
    this.viewRef.value?.focus()
  }

  setReadonly(value: boolean): void {
    this.viewRef.value?.setReadonly(value)
  }

  async command(command: EditorCommand): Promise<CommandResult> {
    const view = this.viewRef.value
    if (!view) return { ok: false, reason: 'surface_not_mounted' }
    switch (command.type) {
      case 'view.focus':
        view.focus()
        return { ok: true }
      case 'view.selectAll':
        view.selectAll()
        return { ok: true }
      case 'search.set': {
        const args = (command.args ?? {}) as { query?: string }
        const state = view.find(args.query ?? '')
        return { ok: true, data: state }
      }
      case 'search.next':
        return { ok: true, data: view.findStep(false) }
      case 'search.prev':
        return { ok: true, data: view.findStep(true) }
      case 'search.clear':
        view.clearFind()
        return { ok: true }
      case 'undo': {
        const changed = await this.undo()
        return changed ? { ok: true } : { ok: false, reason: 'nothing_to_undo' }
      }
      case 'redo': {
        const changed = await this.redo()
        return changed ? { ok: true } : { ok: false, reason: 'nothing_to_redo' }
      }
      case 'grid.goto': {
        const args = (command.args ?? {}) as { row?: number; col?: number; sheet?: number }
        if (typeof args.sheet === 'number') {
          this.adapter.setActive(args.sheet)
          this.syncState()
        }
        const row = Math.max(0, Math.floor(args.row ?? 0))
        const col = Math.max(0, Math.floor(args.col ?? 0))
        view.reveal(row, col)
        return { ok: true }
      }
      case 'grid.insertRowAbove':
        return this.runRowAction('insertAbove')
      case 'grid.insertRowBelow':
        return this.runRowAction('insertBelow')
      case 'grid.deleteRows':
        return this.runRowAction('delete')
      case 'grid.appendRow':
        return this.runRowAction('append')
      case 'grid.selectSheet': {
        const args = (command.args ?? {}) as { index?: number }
        if (typeof args.index !== 'number') return { ok: false, reason: 'invalid_args' }
        this.adapter.setActive(args.index)
        this.syncState()
        return { ok: true }
      }
      default:
        return { ok: false, reason: `unsupported_command:${command.type}` }
    }
  }

  async query(query: SurfaceQuery): Promise<unknown> {
    if (query.type === 'wordCount') {
      // 分页表按总行数报（逐格数要扫百万个格子，而且没读进来的格子本来就是空的）
      const stats = this.adapter.stats?.()
      if (stats) return { words: stats.words, unitLabel: stats.unitLabel }
      const sheet = this.state.sheet
      // 网格的「字数」按非空单元格统计；空表返回 0，不把行列数当内容量
      let filled = 0
      for (let row = 0; row < sheet.rowCount; row += 1) {
        for (let col = 0; col < sheet.colCount; col += 1) if (sheet.cell(row, col)?.text) filled += 1
      }
      return { words: filled, unitLabel: '格' }
    }
    if (query.type === 'outline') return this.state.sheets.map((sheet, index) => ({ level: 1, text: sheet.name, anchor: { kind: 'cell', sheet: sheet.name, cell: 'A1' }, index }))
    if (query.type === 'selection') return this.lastSelection
    return null
  }

  capture(): SurfaceState {
    const view = this.viewRef.value?.getViewport()
    const selection = this.viewRef.value?.getSelection() as GridSelection | undefined
    return {
      kind: 'grid',
      scrollTop: view?.scrollTop ?? 0,
      scrollLeft: view?.scrollLeft ?? 0,
      activeSheet: this.state.sheet.name,
      selection: this.lastSelection,
      extra: selection ? { anchorRow: selection.anchor.row, anchorCol: selection.anchor.col, focusRow: selection.focus.row, focusCol: selection.focus.col } : undefined,
    }
  }

  restore(state: SurfaceState): void {
    const extra = state.extra as { anchorRow?: number; anchorCol?: number; focusRow?: number; focusCol?: number } | undefined
    if (extra && typeof extra.focusRow === 'number' && typeof extra.focusCol === 'number') {
      this.viewRef.value?.reveal(Math.max(0, extra.focusRow), Math.max(0, extra.focusCol))
    }
    const view = this.viewRef.value
    const root = this.root?.querySelector('.kb-gs-scroll') as HTMLElement | null
    if (root && view) {
      if (typeof state.scrollTop === 'number') root.scrollTop = state.scrollTop
      if (typeof state.scrollLeft === 'number') root.scrollLeft = state.scrollLeft
    }
  }
}
