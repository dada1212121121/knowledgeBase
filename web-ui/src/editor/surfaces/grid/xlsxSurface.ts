/**
 * XLSX 只读内容面控制器
 *
 * 该内容面不实现 `GridAdapter`：xlsx 的绘制单位是「视口帧」，不是单元格矩阵。
 * 控制器只负责生命周期、命令映射、锚点与状态快照；绘制与命中全部在视图 / 引擎层。
 */
import { createApp, h, ref, shallowRef } from 'vue'
import {
  openXlsxWorkbook,
  type XlsxCollabOptions,
  type XlsxCollabPeer,
  type XlsxCollabStatus,
  type XlsxFindMatch,
} from '../../engines/xlsx'
import type {
  Anchor,
  CommandResult,
  EditorCommand,
  EditorSource,
  Selection,
  Size,
  Surface,
  SurfaceContext,
  SurfaceDocument,
  SurfaceQuery,
  SurfaceState,
} from '../../types'
import XlsxReadView from './XlsxReadView.vue'
import { XlsxEditAdapter, XlsxReadAdapter } from './xlsx'

export class XlsxReadSurface implements Surface {
  private app: ReturnType<typeof createApp> | null = null
  private root: HTMLElement | null = null
  private ctx: SurfaceContext | null = null
  private adapter: XlsxReadAdapter | null = null
  /** 编辑态才存在；只读打开时不创建，避免多一份编辑状态内存 */
  private editAdapter: XlsxEditAdapter | null = null
  private viewRef = ref<InstanceType<typeof XlsxReadView> | null>(null)
  private lastSelection: Selection | null = null
  private activeSheet = 0
  private cells = 0
  private sheets: readonly { name: string }[] = []
  private disposed = false
  /** 协同态：在线光标单独走响应式，不参与引擎帧，避免每次光标移动都重排整表 */
  private collabPeers = shallowRef<readonly XlsxCollabPeer[]>([])
  private offCollab: (() => void) | null = null

  /**
   * `edit` 时打开引擎编辑会话并挂可写视图；默认只读。
   * 传 `collab` 时由上游 Yrs 副本接收房间更新，本地不再注册保存快照
   * （服务端副本会按去抖时间自动落地，手动保存会越过房间编码）。
   */
  constructor(
    private readonly mode: 'read' | 'edit' = 'read',
    private readonly collab?: XlsxCollabOptions,
  ) {}

  async mount(el: HTMLElement, ctx: SurfaceContext): Promise<void> {
    this.ctx = ctx
    this.root = el
    const source = ctx.document.payload as EditorSource | null
    if (!source || source.kind !== 'bytes') {
      throw new Error('XLSX 内容面需要二进制原件')
    }
    // 一次 openWorkbookSession，Worker 常驻；编辑时同一会话带 edit state，不另开 peer
    const editable = this.mode === 'edit' && !ctx.readonly
    const workbook = await openXlsxWorkbook(source.bytes, {
      editable,
      ...(this.collab ? { collab: this.collab } : {}),
    })
    if (this.disposed) {
      await workbook.dispose()
      return
    }
    if (editable) {
      this.editAdapter = new XlsxEditAdapter(workbook)
      this.adapter = this.editAdapter
    } else {
      this.adapter = new XlsxReadAdapter(workbook)
    }
    const initial = await this.adapter.init()
    if (this.disposed) return
    // 协同状态先取快照再订阅；startCollaboration 的首次 onStatus 早于这里
    const initialCollab = this.adapter.collaboration as XlsxCollabStatus | null
    this.collabPeers.value = initialCollab?.peers ?? []
    this.offCollab = this.adapter.onCollaboration(() => {
      const status = this.adapter?.collaboration ?? null
      this.collabPeers.value = status?.peers ?? []
    })
    this.activeSheet = initial.state.active
    this.sheets = initial.state.sheets
    this.app = createApp({
      render: () =>
        h(XlsxReadView, {
          ref: this.viewRef,
          adapter: this.adapter!,
          initial: initial.state,
          edit: this.editAdapter,
          collabPeers: this.collabPeers.value,
          label: `${source.name || '电子表格'} ${initial.state.sheets[initial.state.active]?.name ?? ''}`.trim(),
          onSelection: (payload: { row: number; col: number; text: string; range: XlsxRangeShape }) => {
            this.handleSelection(payload)
            // 广播的是选区而不是活动格：远端能看到拖选的范围
            this.adapter?.setCollaborativeCursor({
              anchor: { row: payload.range.top, col: payload.range.left },
              focus: { row: payload.range.bottom, col: payload.range.right },
            })
          },
          onSelectSheet: (index: number) => {
            this.activeSheet = index
            this.sheets = this.adapter?.sheets ?? this.sheets
          },
          onFindRequest: () => ctx.onFindRequest?.(),
          onError: (message: string) => ctx.onError?.(new Error(message)),
          onReady: (payload: { cells: number; version: string }) => {
            this.cells = payload.cells
            ctx.onStatsChange?.()
          },
          // 协同内容由房间落地，本地脏标记没有意义；否则关闭时会误报「未保存」
          onDirty: (value: boolean) => {
            if (!this.collab) ctx.onDirtyChange?.(value)
          },
          onNotice: (message: string) => ctx.onError?.(new Error(message)),
        }),
    })
    this.app.mount(el)
    el.classList.add('kb-xg-surface')
    this.adapter.subscribe(() => {
      this.activeSheet = this.adapter?.activeIndex ?? 0
      ctx.onStatsChange?.()
      // 协同远端更新只通知「内容变了」，这里重取尺寸后重画；本地编辑的 settle 也会走到，幂等
      if (this.collab) void this.viewRef.value?.refresh()
    })
    // 检索命中 / 深链：先切工作表，再定位单元格；顺序不能反，setSheet 会重置回 A1
    const hint = ctx.document.hint?.anchor
    if (hint?.kind === 'cell') {
      const sheetIndex = this.sheets.findIndex((sheet) => sheet.name === hint.sheet)
      if (sheetIndex >= 0) await this.viewRef.value?.setSheet(sheetIndex)
      const point = parseCell(hint.cell)
      if (point) this.viewRef.value?.reveal(point.row, point.col)
    }
    if (this.collab) {
      // 房间负责落地；Host 的保存入口没有意义，明确清空快照避免绕过 Yjs 覆盖正文
      ctx.session.setSnapshotProvider?.(null)
      ctx.onDirtyChange?.(false)
    } else if (this.editAdapter) {
      // 同步 provider 给未改动时的原始字节；异步 provider 让引擎在保存时才重新打包
      ctx.session.setSnapshotProvider?.(
        () => ({ kind: 'bytes', name: source.name, bytes: source.bytes }) as EditorSource,
        async () => ({ kind: 'bytes', name: source.name, bytes: await this.editAdapter!.save() }) as EditorSource,
      )
      ctx.onDirtyChange?.(false)
    } else {
      // 只读内容面没有本地快照：Host 的保存快捷键在这里是 no-op
      ctx.session.setSnapshotProvider?.(null)
      ctx.onDirtyChange?.(false)
    }
  }

  unmount(): void {
    this.disposed = true
    this.offCollab?.()
    this.offCollab = null
    this.adapter?.setCollaborativeCursor(null)
    this.app?.unmount()
    this.app = null
    this.root?.classList.remove('kb-xg-surface')
    this.root = null
    void this.adapter?.destroy()
    this.adapter = null
    this.editAdapter = null
    this.viewRef.value = null
    this.ctx = null
  }

  resize(_size: Size): void {
    // 视图内部用 ResizeObserver 处理；这里保留契约空实现
  }

  focus(): void {
    this.viewRef.value?.focus()
  }

  setReadonly(_value: boolean): void {
    // 只读面永远只读；权限变化不影响内容
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
        const state = await view.find(args.query ?? '')
        const anchors = view.getFindMatches().map(toAnchor)
        return { ok: true, data: { ...state, anchors } }
      }
      case 'search.next':
        return { ok: true, data: await view.findStep(false) }
      case 'search.prev':
        return { ok: true, data: await view.findStep(true) }
      case 'search.clear':
        view.clearFind()
        return { ok: true }
      case 'grid.goto': {
        const args = (command.args ?? {}) as { row?: number; col?: number; sheet?: number }
        if (typeof args.sheet === 'number') await view.setSheet(args.sheet)
        view.reveal(Math.max(0, Math.floor(args.row ?? 0)), Math.max(0, Math.floor(args.col ?? 0)))
        return { ok: true }
      }
      case 'grid.selectSheet': {
        const args = (command.args ?? {}) as { index?: number }
        if (typeof args.index !== 'number') return { ok: false, reason: 'invalid_args' }
        await view.setSheet(args.index)
        return { ok: true }
      }
      case 'nav.scrollToAnchor': {
        const anchor = (command.args as { anchor?: Anchor } | undefined)?.anchor
        if (!anchor || anchor.kind !== 'cell') return { ok: false, reason: 'unsupported_anchor' }
        const sheetIndex = this.sheets.findIndex((sheet) => sheet.name === anchor.sheet)
        if (sheetIndex >= 0) await view.setSheet(sheetIndex)
        const point = parseCell(anchor.cell)
        if (!point) return { ok: false, reason: 'invalid_anchor' }
        view.reveal(point.row, point.col)
        return { ok: true }
      }
      case 'undo': {
        if (!this.editAdapter) return { ok: false, reason: 'readonly' }
        const changed = (await view.undo()) ?? false
        return changed ? { ok: true } : { ok: false, reason: 'nothing_to_undo' }
      }
      case 'redo': {
        if (!this.editAdapter) return { ok: false, reason: 'readonly' }
        const changed = (await view.redo()) ?? false
        return changed ? { ok: true } : { ok: false, reason: 'nothing_to_redo' }
      }
      default:
        return { ok: false, reason: `unsupported_command:${command.type}` }
    }
  }

  async query(query: SurfaceQuery): Promise<unknown> {
    if (query.type === 'wordCount') {
      return { words: this.cells, unitLabel: '格' }
    }
    if (query.type === 'outline') {
      return this.sheets.map((sheet, index) => ({
        level: 1,
        text: sheet.name,
        anchor: { kind: 'cell', sheet: sheet.name, cell: 'A1' },
        index,
      }))
    }
    if (query.type === 'selection') return this.lastSelection
    return null
  }

  capture(): SurfaceState {
    const viewport = this.viewRef.value?.getViewport()
    const selection = this.viewRef.value?.getSelection()
    return {
      kind: 'grid',
      scrollTop: viewport?.scrollTop ?? 0,
      scrollLeft: viewport?.scrollLeft ?? 0,
      activeSheet: this.sheets[this.activeSheet]?.name ?? '',
      selection: this.lastSelection,
      extra: selection
        ? {
            anchorRow: selection.anchor.row,
            anchorCol: selection.anchor.col,
            focusRow: selection.focus.row,
            focusCol: selection.focus.col,
          }
        : undefined,
    }
  }

  restore(state: SurfaceState): void {
    void this.restoreState(state)
  }

  private async restoreState(state: SurfaceState): Promise<void> {
    const view = this.viewRef.value
    if (!view) return
    if (state.activeSheet) {
      const index = this.sheets.findIndex((sheet) => sheet.name === state.activeSheet)
      // 切表会重置到 A1；必须等它完成再恢复当前格，否则选区会被后一次重置盖掉
      if (index >= 0) await view.setSheet(index)
    }
    const extra = state.extra as { focusRow?: number; focusCol?: number; anchorRow?: number; anchorCol?: number } | undefined
    if (typeof extra?.focusRow === 'number' && typeof extra.focusCol === 'number') {
      view.reveal(extra.focusRow, extra.focusCol)
    }
    view.restoreScroll(state.scrollTop ?? 0, state.scrollLeft ?? 0)
  }

  private handleSelection(payload: { row: number; col: number; text: string; range: XlsxRangeShape }): void {
    const sheet = this.sheets[this.activeSheet]?.name ?? ''
    const start = cellAddress(payload.range.top, payload.range.left)
    const end = cellAddress(payload.range.bottom, payload.range.right)
    this.lastSelection = {
      kind: 'grid',
      anchor: { kind: 'cell', sheet, cell: start, ...(start !== end ? { endCell: end } : {}) },
      isEmpty: payload.text.length === 0,
      text: payload.text,
    }
    this.ctx?.onSelectionChange?.(this.lastSelection)
  }
}

interface XlsxRangeShape {
  top: number
  left: number
  bottom: number
  right: number
}

function cellAddress(row: number, col: number): string {
  let label = ''
  let value = col + 1
  while (value > 0) {
    const remainder = (value - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    value = Math.floor((value - 1) / 26)
  }
  return `${label}${row + 1}`
}

function parseCell(cell: string): { row: number; col: number } | null {
  const match = /^([A-Z]+)(\d+)$/i.exec(cell)
  if (!match) return null
  let col = 0
  for (const char of match[1].toUpperCase()) col = col * 26 + (char.charCodeAt(0) - 64)
  return { row: Math.max(0, Number(match[2]) - 1), col: Math.max(0, col - 1) }
}

function toAnchor(match: XlsxFindMatch): Anchor {
  return { kind: 'cell', sheet: match.sheetName, cell: match.a1 }
}

/** 注册表工厂：xlsx 只在打开时加载引擎与只读视图 */
export function createXlsxReadSurface(): XlsxReadSurface {
  return new XlsxReadSurface('read')
}

/** 可写内容面：只由在线编辑入口显式加载，不注册进默认注册表 */
export function createXlsxEditSurface(collab?: XlsxCollabOptions): XlsxReadSurface {
  return new XlsxReadSurface('edit', collab)
}
