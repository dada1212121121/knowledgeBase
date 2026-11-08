/**
 * XLSX 只读适配器
 *
 * 和 CSV 的 `GridAdapter` 不同：xlsx 不能把整本表压成 `GridSheet` 的二维字符串。
 * 真实表格的样式、合并、条件格式、图表、冻结窗格都在引擎的 DisplayList 里，
 * 再走一层「单元格矩阵」只会把这些信息丢掉。因此这里保留独立的小接口：
 * `frame` 负责当前视口绘制，`readCell` 只服务公式栏，`usedRange` 只给出导航边界。
 */
import type {
  XlsxCellGeometry,
  XlsxCellInfo,
  XlsxCollabStatus,
  XlsxEditSource,
  XlsxFindMatch,
  XlsxFormatting,
  XlsxFrame,
  XlsxMutationResult,
  XlsxNumberFormatChange,
  XlsxRange,
  XlsxSelection,
  XlsxSheetSummary,
  XlsxSheetView,
  XlsxStylePatch,
  XlsxWorkbook,
} from '../../engines/xlsx'
import { xlsxFillPlan, xlsxPlanPaste, type XlsxCopyCell } from './xlsx-edit'

/** 视口；x/y 是非冻结窗格的滚动偏移 */
export interface XlsxViewport {
  x: number
  y: number
  width: number
  height: number
}

/** 只读适配器对外暴露的状态快照 */
export interface XlsxReadState {
  sheets: readonly XlsxSheetSummary[]
  active: number
  view: XlsxSheetView
  usedRange: XlsxRange | null
}

/** 适配器初始化完成后的第一屏状态 */
export interface XlsxReadInit {
  state: XlsxReadState
  version: string
}

export class XlsxReadAdapter {
  private state: XlsxReadState
  protected listeners = new Set<() => void>()
  private revision = 0
  private closed = false
  /** 引擎会话的变更通知（远端协同更新、撤销等）；Surface 据此重画视口 */
  private readonly offWorkbook: () => void

  constructor(protected readonly workbook: XlsxWorkbook) {
    this.state = {
      sheets: workbook.sheets,
      active: workbook.activeIndex,
      view: emptyView(workbook.activeIndex),
      usedRange: null,
    }
    this.offWorkbook = workbook.subscribe(() => {
      if (!this.closed) this.notify()
    })
  }

  /** 打开后先取活动工作表的尺寸与已用区域；之后的切换走 `setActive` */
  async init(): Promise<XlsxReadInit> {
    await this.reloadView()
    return { state: this.snapshot(), version: this.workbook.version }
  }

  snapshot(): XlsxReadState {
    return {
      sheets: this.state.sheets,
      active: this.state.active,
      view: { ...this.state.view },
      usedRange: this.state.usedRange ? { ...this.state.usedRange } : null,
    }
  }

  get sheets(): readonly XlsxSheetSummary[] {
    return this.state.sheets
  }

  get activeIndex(): number {
    return this.state.active
  }

  get view(): XlsxSheetView {
    return this.state.view
  }

  get usedRange(): XlsxRange | null {
    return this.state.usedRange
  }

  get dataRevision(): number {
    return this.revision
  }

  get version(): string {
    return this.workbook.version
  }

  /** 只读面的数据源不会从界面改内容，保留接口给未来的引擎刷新 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 切换工作表并刷新尺寸；返回新状态 */
  async setActive(index: number): Promise<XlsxReadState> {
    if (this.closed) return this.snapshot()
    this.workbook.setActive(index)
    this.state.active = this.workbook.activeIndex
    await this.reloadView()
    return this.snapshot()
  }

  async frame(viewport: XlsxViewport): Promise<XlsxFrame> {
    return this.workbook.frame(viewport, this.state.active)
  }

  async readCell(row: number, col: number): Promise<XlsxCellInfo | null> {
    return this.workbook.readCell(row, col, this.state.active)
  }

  async readRange(range: XlsxRange): Promise<string[][]> {
    return this.workbook.readRange(range, this.state.active)
  }

  async cellGeometry(row: number, col: number): Promise<XlsxCellGeometry> {
    return this.workbook.cellGeometry(row, col, this.state.active)
  }

  async find(text: string): Promise<XlsxFindMatch[]> {
    return this.workbook.findText(text)
  }

  /** 只读面：没有任何可落盘的编辑入口 */
  readonly(): boolean {
    return true
  }

  async destroy(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.offWorkbook()
    this.listeners.clear()
    await this.workbook.dispose()
  }

  /** 协同状态快照；非协同打开为 null */
  get collaboration(): XlsxCollabStatus | null {
    return this.workbook.collaboration
  }

  onCollaboration(listener: () => void): () => void {
    return this.workbook.onCollaboration(listener)
  }

  /** 把本地选区广播到房间；非协同打开时是空操作 */
  setCollaborativeCursor(selection: XlsxSelection | null): void {
    this.workbook.setCollaborativeCursor(selection)
  }

  /**
   * 只刷新尺寸 / 已用区域，不触发订阅通知。
   * 远端更新后视图调用它重算滚动条；若这里再 notify 会和 Surface 的订阅形成回环。
   */
  async viewState(): Promise<XlsxReadState> {
    const [view, usedRange] = await Promise.all([
      this.workbook.sheetView(this.state.active),
      this.workbook.usedRange(this.state.active),
    ])
    this.state.view = view
    this.state.usedRange = usedRange
    return this.snapshot()
  }

  /** 不重取视图，只通知订阅者（保存后 dirty 状态变化） */
  protected notify(): void {
    this.revision += 1
    for (const listener of this.listeners) listener()
  }

  protected async reloadView(): Promise<void> {
    const [view, usedRange] = await Promise.all([
      this.workbook.sheetView(this.state.active),
      this.workbook.usedRange(this.state.active),
    ])
    this.state.view = view
    this.state.usedRange = usedRange
    this.revision += 1
    for (const listener of this.listeners) listener()
  }
}

/** 一次编辑落地的结果：在引擎结果上补 dirty，界面据此显示保存状态 */
export interface XlsxEditOutcome extends XlsxMutationResult {
  dirty: boolean
}

/**
 * 可编辑适配器：读取能力全部继承，写入只走引擎公开的 `WorkbookSession.submit`。
 * 每次成功编辑后重取 sheet 视图与已用区域，保证「第一格写到空表」时滚动条随之变长。
 */
export class XlsxEditAdapter extends XlsxReadAdapter {
  readonly editable = true
  /** 用户是否改过；不直接读引擎 dirty，保存成功后由本层清掉，语义与宿主一致 */
  private changed = false

  constructor(workbook: XlsxWorkbook) {
    super(workbook)
  }

  get dirty(): boolean {
    return this.changed
  }

  /** 可编辑面：`readonly` 返回 false，宿主据此开放写命令 */
  override readonly(): boolean {
    return false
  }

  /** 写入若干格；`source` 只做审计标记，真正的历史由引擎维护 */
  async commit(
    cells: readonly { row: number; col: number; input: string }[],
    selection?: XlsxSelection,
    _source: XlsxEditSource = 'user',
  ): Promise<XlsxEditOutcome> {
    if (cells.length === 0) return this.settle(this.emptyMutation(), false)
    const result = await this.workbook.editCells(cells, selection)
    return this.settle(result, result.applied)
  }

  async applyStyle(range: XlsxRange, patch: XlsxStylePatch, selection?: XlsxSelection): Promise<XlsxEditOutcome> {
    const result = await this.workbook.patchStyle(range, patch, selection)
    return this.settle(result, result.applied)
  }

  async applyNumberFormat(
    range: XlsxRange,
    change: XlsxNumberFormatChange,
    selection?: XlsxSelection,
  ): Promise<XlsxEditOutcome> {
    const result = await this.workbook.setNumberFormat(range, change, selection)
    return this.settle(result, result.applied)
  }

  async clear(range: XlsxRange, selection?: XlsxSelection): Promise<XlsxEditOutcome> {
    const result = await this.workbook.clearRange(range, selection)
    return this.settle(result, result.applied)
  }

  async undo(selection?: XlsxSelection): Promise<XlsxEditOutcome> {
    const result = await this.workbook.undo(selection)
    return this.settle(result, result.applied)
  }

  async redo(selection?: XlsxSelection): Promise<XlsxEditOutcome> {
    const result = await this.workbook.redo(selection)
    return this.settle(result, result.applied)
  }

  history(): { canUndo: boolean; canRedo: boolean } {
    return this.workbook.history()
  }

  async formatting(range: XlsxRange): Promise<XlsxFormatting | null> {
    return this.workbook.formatting(range, this.activeIndex)
  }

  async inputAt(row: number, col: number): Promise<string> {
    return this.workbook.cellInput(row, col, this.activeIndex)
  }

  /** 复制用：显示文本 + 公式（公式用于 HTML 端的 data 属性与后续富剪贴板） */
  async copyRange(range: XlsxRange): Promise<XlsxCopyCell[][]> {
    const [display, inputs] = await Promise.all([
      this.workbook.readRange(range, this.activeIndex),
      this.workbook.readInputs(range, this.activeIndex),
    ])
    return display.map((row, rowIndex) =>
      row.map((text, colIndex) => {
        const input = inputs[rowIndex]?.[colIndex] ?? ''
        return { text, formula: input.startsWith('=') ? input : null }
      }),
    )
  }

  /** 粘贴：纯文本矩阵按目标选区展开，超过上限时由调用方提示 */
  async paste(
    clipboard: { text: string; html?: string },
    range: XlsxRange,
    selection?: XlsxSelection,
  ): Promise<{ outcome: XlsxEditOutcome; truncated: boolean }> {
    const plan = xlsxPlanPaste(clipboard, range)
    const outcome = await this.commit(plan.cells, selection, 'paste')
    return { outcome, truncated: plan.truncated }
  }

  /** Ctrl+D / Ctrl+R：以选区首行/首列为源，公式按偏移平移 */
  async fill(range: XlsxRange, direction: 'down' | 'right', selection?: XlsxSelection): Promise<XlsxEditOutcome> {
    const sourceRange: XlsxRange =
      direction === 'down'
        ? { top: range.top, left: range.left, bottom: range.top, right: range.right }
        : { top: range.top, left: range.left, bottom: range.bottom, right: range.left }
    const inputs = await this.workbook.readInputs(sourceRange, this.activeIndex)
    const cells = xlsxFillPlan(range, inputs, direction)
    return this.commit(cells, selection, 'paste')
  }

  /** 序列化成 xlsx 字节；由宿主保存通道调用 */
  async save(): Promise<Uint8Array> {
    const bytes = await this.workbook.save()
    this.changed = false
    this.notify()
    return bytes
  }

  private emptyMutation(): XlsxMutationResult {
    return {
      applied: false,
      refusedReason: null,
      changed: [],
      limitedCells: [],
      sheets: this.sheets,
      canUndo: this.history().canUndo,
      canRedo: this.history().canRedo,
      formatting: null,
      version: this.version,
    }
  }

  private async settle(result: XlsxMutationResult, changed: boolean): Promise<XlsxEditOutcome> {
    if (changed) {
      this.changed = true
      await this.reloadView()
    }
    return { ...result, dirty: this.changed }
  }
}

function emptyView(sheet: number): XlsxSheetView {
  return {
    sheet,
    contentWidth: 0,
    contentHeight: 0,
    frozenRows: 0,
    frozenCols: 0,
    frozenWidth: 0,
    frozenHeight: 0,
    initialScrollX: 0,
    initialScrollY: 0,
  }
}
