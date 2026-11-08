/**
 * XLSX Headless 引擎适配层
 *
 * 工程铁律：全仓只有 `src/editor/engines/` 允许 import `@betteroffice/xlsx`。
 * 本文件把上游的 Worker 会话、DisplayList 绘制命令、命中测试和选区 reducer
 * 收在一个薄封装里，宿主 / 内容面只看到本仓定义的普通数据类型。
 *
 * 关键取舍：
 * 1. 只读首屏用 `openWorkbookSession`：上游自己创建同源 ES Module Worker，
 *    主线程只拿「当前视口」的 DisplayList，不把整本工作簿搬进 Vue 响应式；
 * 2. 不把上游 `DisplayList` 暴露给 Surface，避免上游类型泄漏到界面层；
 * 3. 滚动 / 选区 / 命中全部走纯函数，Canvas 绘制只在 `paint` 里发生；
 * 4. 编辑沿用同一个 Worker 会话：`WorkbookSession.submit(command)` 是上游公开入口，
 *    编辑由 Worker 内的 `WorkbookEditSession` 应用并回 ack，主线程不复制第二份 WASM；
 *    这里**不**碰 `WorkbookEditConnection`（未导出）也不做 `hydratePeer`（@internal，且要双份内存）。
 */
import {
  openWorkbookSession,
  paintDisplayList,
  type CapturedCellFormat,
  type DisplayList,
  type EditResult,
  type NumberFormatMutation,
  type RangeStylePatch,
  type SelectionFormatting,
  type WorkbookSession,
} from '@betteroffice/xlsx'
import {
  CollaborationProvider,
  type CollaborationTransport,
  type CollaborationStatus,
} from '@betteroffice/xlsx/collaboration'
import type {
  CommandStatus,
  WorkbookCommand,
  WorkbookCommandKind,
  WorkbookCommandSelection,
} from '@betteroffice/xlsx/worker'
import {
  cellAtPoint,
  cellRect,
  normalizeRange,
  rangeRect,
  selectionKeyReducer,
  type CellRange,
  type DisplayList as HeadlessDisplayList,
  type KeyInput,
  type Selection,
  type SelectionLimits,
  type SelectionMerges,
} from '@betteroffice/xlsx/headless'

/** 零基单元格坐标 */
export interface XlsxPoint {
  row: number
  col: number
}

/** 闭合单元格区域（含右下边界） */
export interface XlsxRange {
  top: number
  left: number
  bottom: number
  right: number
}

/** 选区：anchor 固定起点，focus 是活动单元格 */
export interface XlsxSelection {
  anchor: XlsxPoint
  focus: XlsxPoint
}

/** 键盘 reducer 的网格边界（不暴露上游类型） */
export interface XlsxSelectionLimits {
  rows: number
  cols: number
  rowsPerPage: number
}

/** 键盘输入（只保留 reducer 关心的修饰键） */
export interface XlsxKeyInput {
  key: string
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
}

/** 工作表目录项（上游 session state 的稳定子集） */
export interface XlsxSheetSummary {
  id: string
  index: number
  name: string
}

/** 当前工作表的滚动范围 / 冻结窗格；对应上游 WorkbookSheetView */
export interface XlsxSheetView {
  sheet: number
  contentWidth: number
  contentHeight: number
  frozenRows: number
  frozenCols: number
  frozenWidth: number
  frozenHeight: number
  initialScrollX: number
  initialScrollY: number
}

/** 一个单元格的只读内容；公式栏只需要这些字段 */
export interface XlsxCellInfo {
  a1: string
  displayText: string
  formula: string | null
  /** 原始输入（没有公式时等于 displayText） */
  input: string
}

/** 查找命中（只保留本仓需要的字段） */
export interface XlsxFindMatch {
  sheet: number
  sheetName: string
  row: number
  col: number
  a1: string
  text: string
}

/** 单元格几何；scrollPosition 是让该格左上角可见的目标滚动偏移 */
export interface XlsxCellGeometry {
  rect: { x: number; y: number; w: number; h: number }
  scrollPosition: { x: number; y: number }
}

/** 对齐方式（只保留本仓 UI 需要的枚举，避免把上游联合类型泄漏到视图） */
export type XlsxHorizontalAlignment = 'general' | 'left' | 'center' | 'right' | 'fill' | 'justify' | 'centerContinuous' | 'distributed'
export type XlsxVerticalAlignment = 'top' | 'center' | 'bottom' | 'justify' | 'distributed'
export type XlsxTextWrapping = 'overflow' | 'wrap' | 'clip'

/** 单元格可编辑内容的快照（公式栏 / 工具栏用） */
export interface XlsxFormatting {
  bold: boolean
  italic: boolean
  strikethrough: boolean
  fontFamily: string | null
  fontSize: number | null
  textColor: string | null
  fillColor: string | null
  /** 数字格式的语义类别；自定义格式额外给 `pattern` */
  numberFormat: 'automatic' | 'plainText' | 'number' | 'percent' | 'scientific' | 'currency' | 'date' | 'time' | 'custom' | null
  numberFormatPattern: string | null
  horizontalAlignment: XlsxHorizontalAlignment | null
  verticalAlignment: XlsxVerticalAlignment | null
  textWrapping: XlsxTextWrapping | null
}

/** 一次编辑的结果；Surface 只看这些稳定字段，不接触上游 EditResult */
export interface XlsxMutationResult {
  applied: boolean
  refusedReason: string | null
  /** 依赖重算导致显示值变化的其它单元格（A1，不含本次直接编辑的格） */
  changed: readonly string[]
  /** 触发计算上限的单元格 */
  limitedCells: readonly string[]
  sheets: readonly XlsxSheetSummary[]
  canUndo: boolean
  canRedo: boolean
  /** 本次命令携带选区时的格式化快照；没有选区时为 null */
  formatting: XlsxFormatting | null
  version: string
}

/** 区域样式补丁（只暴露本仓字段，类型定义留在 engines 内） */
export type XlsxStylePatch = RangeStylePatch

/** 数字格式变更（语义类别或增减小数位） */
export type XlsxNumberFormatChange = NumberFormatMutation

/** 编辑命令来源：由调用方显式传入，便于日后排查「谁改了这一格」 */
export type XlsxEditSource = 'user' | 'paste' | 'style' | 'undo' | 'redo' | 'system'

/** 一个待写入的单元格输入（`=` 开头为公式，`'` 开头为强制文本） */
export interface XlsxCellInput {
  row: number
  col: number
  input: string
}

/**
 * 协同传输：与 `src/editor/collab/officeRoomTransport.ts` 结构一致。
 * 放在引擎层定义是为了让上游类型止步于此，Surface 只传一个 WebSocket 适配器。
 */
export type XlsxCollabTransportEvent =
  | { type: 'open' }
  | { type: 'message'; data: Uint8Array }
  | { type: 'close'; reason?: string }
  | { type: 'error'; error: unknown }
  | { type: 'drain' }

export interface XlsxCollabTransport {
  connect(): void | Promise<void>
  disconnect(): void | Promise<void>
  send(data: Uint8Array): boolean
  onEvent(listener: (event: XlsxCollabTransportEvent) => void): () => void
  /** 服务端主动关闭（权限收回、房间关闭）；普通断线不触发 */
  onClosed?(listener: (code: number, reason: string) => void): () => void
}

/** 一个在线协作者的光标；sheet 是工作表 id，不是显示名 */
export interface XlsxCollabPeer {
  clientId: number
  name: string
  color: string
  sheet: string
  anchor: XlsxPoint
  head: XlsxPoint
}

export type XlsxCollabConnection = 'connecting' | 'connected' | 'disconnected' | 'destroyed'

/** 协同状态快照；Surface 只读这个结构做状态条和远端选区 */
export interface XlsxCollabStatus {
  status: XlsxCollabConnection
  synced: boolean
  peers: readonly XlsxCollabPeer[]
  /** 传输层错误；不中断本地编辑，只用于提示 */
  error?: string
}

/** 打开协同工作簿需要的配置；transport 由 `collab/OfficeTransport.ts` 提供 */
export interface XlsxCollabOptions {
  transport: XlsxCollabTransport
  user: { name: string; color?: string }
  clientId?: number
  /** docx 才需要房间初始状态；xlsx 用同一份底稿即可汇合，留作统一接口 */
  initialUpdate?: Uint8Array
  onStatus?: (status: XlsxCollabStatus) => void
  onClosed?: (code: number, reason: string) => void
}

/** 屏幕阅读器镜像的一行 / 单元格（不引入上游类型） */
export interface XlsxA11yCell {
  row: number
  col: number
  address: string
  text: string
  selected: boolean
  label: string
}
export interface XlsxA11yRow {
  row: number
  header: string
  cells: XlsxA11yCell[]
}

/** 把上游 DisplayList 包成不可变帧；Surface 不接触上游绘制命令 */
export class XlsxFrame {
  readonly width: number
  readonly height: number
  readonly truncated: boolean
  /** 可见区域的网格元数据（给屏幕阅读器 / 调试用），不含上游绘制命令 */
  readonly grid: {
    startRow: number
    startCol: number
    rowIndices?: number[]
    colIndices?: number[]
    rowOffsets: number[]
    colOffsets: number[]
  } | null
  readonly mergedRanges: readonly XlsxRange[]

  constructor(
    private readonly raw: DisplayList,
    mergedRanges: readonly { start: XlsxPoint; end: XlsxPoint }[] = [],
  ) {
    this.width = raw.width
    this.height = raw.height
    this.truncated = raw.truncated === true
    const grid = raw.grid
    this.grid = grid
      ? {
          startRow: grid.startRow,
          startCol: grid.startCol,
          rowIndices: grid.rowIndices ? [...grid.rowIndices] : undefined,
          colIndices: grid.colIndices ? [...grid.colIndices] : undefined,
          rowOffsets: [...grid.rowOffsets],
          colOffsets: [...grid.colOffsets],
        }
      : null
    this.mergedRanges = mergedRanges.map((range) => ({
      top: range.start.row,
      left: range.start.col,
      bottom: range.end.row,
      right: range.end.col,
    }))
  }

  /** 把当前帧画到 Canvas；dpr 只影响设备像素，不影响逻辑坐标 */
  paint(ctx: CanvasRenderingContext2D, dpr: number): void {
    paintDisplayList(ctx, this.raw as HeadlessDisplayList, dpr)
  }

  /** 视口本地坐标 → 单元格；点在网格外返回 null */
  cellAtPoint(x: number, y: number): XlsxPoint | null {
    return cellAtPoint(this.raw.grid, x, y)
  }

  /** 单元格 → 视口本地矩形；完全不可见返回 null */
  cellRect(row: number, col: number): { x: number; y: number; w: number; h: number } | null {
    return cellRect(this.raw.grid, row, col)
  }

  /** 选区 → 可见部分的视口本地矩形 */
  rangeRect(range: XlsxRange): { x: number; y: number; w: number; h: number } | null {
    return rangeRect(this.raw.grid, toCellRange(range))
  }

  /**
   * 可见的列 / 行：序号（0 起）与视口本地的起点、宽高（画行号列标用）。
   * 上游 DisplayList 不画表头，行号列标由宿主自己画；位置取自 grid 的 offsets（第 i 条轨道的左 / 上边是 offsets[i]，
   * 序号是 indices?.[i] ?? start + i，与上游 cellAtPoint / cellRect 同一套换算），冻结窗格与隐藏行列自然正确。
   */
  tracks(kind: 'col' | 'row'): { index: number; start: number; size: number }[] {
    const grid = this.grid
    if (!grid) return []
    const offsets = kind === 'col' ? grid.colOffsets : grid.rowOffsets
    const indices = kind === 'col' ? grid.colIndices : grid.rowIndices
    const first = kind === 'col' ? grid.startCol : grid.startRow
    const out: { index: number; start: number; size: number }[] = []
    for (let i = 0; i + 1 < offsets.length; i += 1) {
      out.push({ index: indices?.[i] ?? first + i, start: offsets[i], size: offsets[i + 1] - offsets[i] })
    }
    return out
  }
}

/**
 * 只读工作簿会话。
 *
 * `openWorkbookSession` 返回的窄会话自带 Worker；这里只保存用户需要的目录、
 * 活动工作表与绘制入口。任何方法抛错都由 Surface 收敛成可见错误。
 */
export class XlsxWorkbook {
  private active = 0
  private readonly catalog: XlsxSheetSummary[]
  /** 编辑命令必须按 seq 顺序落地：并发 submit 会与上游的「下一条序号」校验冲突 */
  private queue: Promise<unknown> = Promise.resolve()
  private lastFormatting: XlsxFormatting | null = null
  private disposed = false
  /** 远端更新 / 本地命令落地后的轻量通知，Surface 据此重画但不复制整本表 */
  private readonly changeListeners = new Set<() => void>()
  /** 协同连接；只读打开时为 null */
  private provider: CollaborationProvider | null = null
  private collabConfig: XlsxCollabOptions | null = null
  private collabState: XlsxCollabStatus | null = null
  private collabClientId = 0
  private unbindCollab: (() => void) | null = null
  private offClosed: (() => void) | null = null
  private readonly offProvider: (() => void)[] = []
  private readonly collabListeners = new Set<() => void>()

  private constructor(
    private readonly session: WorkbookSession,
    private readonly canEdit: boolean,
  ) {
    this.catalog = session.state.sheets.map((sheet) => ({
      id: sheet.id,
      index: sheet.index,
      name: sheet.name,
    }))
    this.active = Math.min(Math.max(0, session.state.activeSheet), Math.max(0, this.catalog.length - 1))
    // 远端改动经 Worker 落地后不会走本地编辑的 settle，这里统一通知重画
    session.on('changed', () => this.notifyChange())
  }

  /**
   * 打开工作簿。`editable` 时带上 `includeEditState`：Worker 会在打开阶段就回传
   * 可撤销状态与选区格式，第一帧工具栏不必再补一次 RPC。
   * 传 `collab` 时以 Yrs 副本打开，同一份底稿的字节一致即可和房间里的其他人汇合。
   */
  static async open(
    bytes: Uint8Array | ArrayBuffer,
    options: { editable?: boolean; collab?: XlsxCollabOptions } = {},
  ): Promise<XlsxWorkbook> {
    // 上游签名写的是 ArrayBuffer；传入 Uint8Array 在浏览器端也能被 structured clone，
    // 但显式切出 ArrayBuffer 可以避免 subarray 把整个上层 buffer 带进 Worker。
    // 复制成独立的 ArrayBuffer：subarray 的 buffer 可能被上层复用，Worker structured clone 会连带整块内存
    const buffer = (bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer) as ArrayBuffer
    const clientId = options.collab ? (options.collab.clientId ?? randomClientId()) : undefined
    const session = await openWorkbookSession(buffer, {
      ...(options.editable ? { includeEditState: true as const } : {}),
      ...(clientId
        ? {
            collaborative: true as const,
            clientId,
            ...(options.collab?.initialUpdate ? { initialUpdate: options.collab.initialUpdate.slice() } : {}),
          }
        : {}),
    })
    const workbook = new XlsxWorkbook(session, options.editable === true)
    if (options.collab) workbook.startCollaboration(options.collab)
    return workbook
  }

  /** 是否可编辑；只读面上所有写方法都会拒绝 */
  get editable(): boolean {
    return this.canEdit
  }

  /** 本地是否有未保存的改动（引擎侧计数，与宿主 session 的 dirty 独立） */
  get dirty(): boolean {
    return this.canEdit && this.session.state.dirty === true
  }

  get sheets(): readonly XlsxSheetSummary[] {
    return this.catalog
  }

  get activeIndex(): number {
    return this.active
  }

  get version(): string {
    return String(this.session.state.version ?? '')
  }

  /** 当前协同状态；非协同打开为 null */
  get collaboration(): XlsxCollabStatus | null {
    return this.collabState
      ? {
          ...this.collabState,
          peers: this.collabState.peers.map((peer) => ({
            ...peer,
            anchor: { ...peer.anchor },
            head: { ...peer.head },
          })),
        }
      : null
  }

  /** 订阅「工作簿内容变了」：本地命令、撤销、远端更新都会触发 */
  subscribe(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  /** 订阅协同状态 / 在线光标；非协同打开时立即回调一次 null 语义由调用方处理 */
  onCollaboration(listener: () => void): () => void {
    this.collabListeners.add(listener)
    return () => this.collabListeners.delete(listener)
  }

  /** 把本地选区广播给房间；null 表示离开 / 没有选区 */
  setCollaborativeCursor(selection: XlsxSelection | null): void {
    if (!this.provider) return
    const sheet = this.catalog[this.active]
    if (!selection || !sheet) {
      this.provider.setCursor(null)
      return
    }
    this.provider.setCursor({
      sheet: sheet.id,
      anchor: { row: selection.anchor.row, col: selection.anchor.col },
      head: { row: selection.focus.row, col: selection.focus.col },
    })
  }

  /** 切换工作表；只改本地索引，下一帧按新 sheet 取 */
  setActive(index: number): void {
    if (this.catalog.length === 0) {
      this.active = 0
      return
    }
    this.active = Math.min(Math.max(0, Math.trunc(index)), this.catalog.length - 1)
  }

  async sheetView(index = this.active): Promise<XlsxSheetView> {
    const view = await this.session.call.sheetView(index)
    return {
      sheet: view.sheet,
      contentWidth: view.contentWidth,
      contentHeight: view.contentHeight,
      frozenRows: view.frozenRows ?? 0,
      frozenCols: view.frozenCols ?? 0,
      frozenWidth: view.frozenWidth ?? 0,
      frozenHeight: view.frozenHeight ?? 0,
      initialScrollX: view.initialScrollX ?? 0,
      initialScrollY: view.initialScrollY ?? 0,
    }
  }

  /** 取一帧；viewport 的 x/y 是非冻结窗格的滚动偏移（与上游一致） */
  async frame(viewport: { x: number; y: number; width: number; height: number }, index = this.active): Promise<XlsxFrame> {
    const frame = await this.session.call.frame(viewport, { sheet: index })
    return new XlsxFrame(frame.displayList, frame.mergedRanges ?? [])
  }

  /** 当前工作表已用区域；空表返回 null（上游给 0,0 的单格区域） */
  async usedRange(index = this.active): Promise<XlsxRange | null> {
    const data = await this.session.call.selectionData(index, 0, 0, 'usedRange')
    const range = data.usedRange
    return range ? { top: range.top, left: range.left, bottom: range.bottom, right: range.right } : null
  }

  /** 读一个单元格；空单元格也会返回一个 displayText 为空的记录 */
  async readCell(row: number, col: number, index = this.active): Promise<XlsxCellInfo | null> {
    const sheet = this.catalog[index]
    if (!sheet) return null
    const result = await this.session.call.readCells({
      ranges: [{ sheetId: sheet.id, range: { kind: 'a1', a1: cellName(row, col) } }],
    })
    if (!result.ok) return null
    const cell = result.ranges[0]?.cells[0]?.[0]
    if (!cell) return null
    return {
      a1: cell.a1,
      displayText: cell.displayText,
      formula: cell.formula,
      input: cell.formula ? `=${cell.formula}` : cell.displayText,
    }
  }

  /** 读一个区域的显示文本（复制 / 屏幕阅读器用） */
  async readRange(range: XlsxRange, index = this.active): Promise<string[][]> {
    const sheet = this.catalog[index]
    if (!sheet) return []
    const result = await this.session.call.readCells({
      ranges: [
        {
          sheetId: sheet.id,
          range: {
            kind: 'rowCol',
            start: { row: range.top, col: range.left },
            end: { row: range.bottom, col: range.right },
          },
        },
      ],
    })
    if (!result.ok) return []
    return (result.ranges[0]?.cells ?? []).map((row) => row.map((cell) => cell.displayText))
  }

  /** 精确单元格位置；用于把键盘选中的格滚进视口 */
  async cellGeometry(row: number, col: number, index = this.active): Promise<XlsxCellGeometry> {
    const geometry = await this.session.call.cellGeometry(index, row, col)
    return {
      rect: { ...geometry.rect },
      scrollPosition: { ...geometry.scrollPosition },
    }
  }

  /** 跨工作表查找 displayText；只返回本仓需要的字段 */
  async findText(text: string, sheetIds?: readonly string[]): Promise<XlsxFindMatch[]> {
    const result = await this.session.call.findText({ text, ...(sheetIds ? { sheetIds } : {}) })
    if (!result.ok) return []
    return result.matches.map((match) => ({
      sheet: match.cell.sheetId ? (this.catalog.find((sheet) => sheet.id === match.cell.sheetId)?.index ?? this.active) : this.active,
      sheetName: this.catalog.find((sheet) => sheet.id === match.cell.sheetId)?.name ?? '',
      row: match.cell.row,
      col: match.cell.col,
      a1: match.cell.a1,
      text: match.text,
    }))
  }

  /* ------------------------------ 编辑 ------------------------------ */

  /**
   * 写入一个单元格。`input` 与 Excel 输入框一致：`=` 开头是公式，`'` 开头强制文本，空串清空。
   * 依赖重算、输入解析（数字/日期/百分比）全部交给引擎，本层不猜。
   */
  async editCell(row: number, col: number, input: string, selection?: XlsxSelection): Promise<XlsxMutationResult> {
    return this.dispatch('editCell', { args: [this.active, row, col, input] }, selection)
  }

  /** 批量写入（粘贴矩阵、一行多格提交）；单元格顺序即按行展开的矩阵顺序 */
  async editCells(edits: readonly XlsxCellInput[], selection?: XlsxSelection): Promise<XlsxMutationResult> {
    if (edits.length === 0) return this.emptyResult()
    return this.dispatch(
      'editCells',
      { args: [this.active, edits.map((edit) => ({ row: edit.row, col: edit.col, input: edit.input }))] },
      selection,
    )
  }

  /**
   * 清空区域内容。走工具栏 `clear` 而不是逐格写空串：
   * 1. 合并单元格的从属格写入会被引擎判 `locked-target`，整批都会被拒；
   * 2. 超大选区（整列/整行）逐格展开会产生几十万条 payload。
   */
  async clearRange(range: XlsxRange, selection?: XlsxSelection): Promise<XlsxMutationResult> {
    const sheet = this.catalog[this.active]
    if (!sheet) return this.emptyResult()
    return this.dispatch(
      'applyOps',
      {
        toolbar: {
          id: 'clear',
          args: undefined,
          target: { sheetId: sheet.id, range: { kind: 'a1', a1: xlsxRangeA1(range) } },
        },
      },
      selection,
    )
  }

  /** 区域样式：加粗 / 斜体 / 字号 / 颜色 / 填充 / 边框 / 对齐 / 换行 */
  async patchStyle(range: XlsxRange, patch: XlsxStylePatch, selection?: XlsxSelection): Promise<XlsxMutationResult> {
    return this.dispatch('patchRangeStyle', { args: [this.active, xlsxRangeA1(range), patch] }, selection)
  }

  /** 数字格式；相对变更（increaseDecimal/decreaseDecimal）由引擎按每格当前格式计算 */
  async setNumberFormat(
    range: XlsxRange,
    format: XlsxNumberFormatChange,
    selection?: XlsxSelection,
  ): Promise<XlsxMutationResult> {
    return this.dispatch('setNumberFormat', { args: [this.active, xlsxRangeA1(range), format] }, selection)
  }

  /** 引擎撤销 / 重做（历史栈在 Worker 内，跨sheet 一致） */
  async undo(selection?: XlsxSelection): Promise<XlsxMutationResult> {
    return this.dispatch('undo', { args: [] }, selection)
  }

  async redo(selection?: XlsxSelection): Promise<XlsxMutationResult> {
    return this.dispatch('redo', { args: [] }, selection)
  }

  /** 撤销/重做可用性与深度；不发起 RPC，读当前投影 */
  history(): { canUndo: boolean; canRedo: boolean } {
    if (!this.canEdit) return { canUndo: false, canRedo: false }
    const state = this.session.editState
    return { canUndo: state.canUndo === true, canRedo: state.canRedo === true }
  }

  /** 当前选区第一格的格式；工具栏 / 快捷键用 */
  async formatting(range: XlsxRange, index = this.active): Promise<XlsxFormatting | null> {
    if (!this.canEdit) return null
    const captured = await this.session.call.captureFormat(index, xlsxRangeA1(range))
    const first = captured.formats[0] as CapturedCellFormat | undefined
    if (!first) return null
    this.lastFormatting = formattingFromCaptured(first)
    return this.lastFormatting
  }

  /** 批量读「用户输入串」（含公式），用于填充与复制 */
  async readInputs(range: XlsxRange, index = this.active): Promise<string[][]> {
    const result = await this.session.call.cellInputs(index, xlsxRangeA1(range))
    return result.cells.map((row) => row.map((cell) => cell.input ?? ''))
  }

  /** 活动单元格「用户实际会编辑的字符串」；公式带 `=`，文本守卫带 `'` */
  async cellInput(row: number, col: number, index = this.active): Promise<string> {
    const result = await this.session.call.cellInputs(index, cellName(row, col))
    return result.cells[0]?.[0]?.input ?? ''
  }

  /** 序列化成 xlsx 字节；保存前先等所有排队命令落地，避免少写最后一格 */
  async save(): Promise<Uint8Array> {
    this.assertEditable()
    return this.enqueue(async () => {
      const bytes = await this.session.save()
      return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.provider?.destroy()
    this.provider = null
    this.unbindCollab?.()
    this.unbindCollab = null
    this.offClosed?.()
    this.offClosed = null
    for (const off of this.offProvider.splice(0)) off()
    // 先断开传输，避免 Worker 销毁后它还在重连
    await this.collabConfig?.transport.disconnect()
    this.collabConfig = null
    this.collabListeners.clear()
    this.changeListeners.clear()
    // 等在途命令结束再销毁 Worker，避免上游在 dispose 后收到 ack 报错
    await this.queue.catch(() => undefined)
    await this.session.dispose()
  }

  /* ------------------------------ 内部实现 ------------------------------ */

  /**
   * 接上协同房间。
   *
   * 关键：远端更新不能直接走上游 replica 的默认 applyUpdate，否则它会绕开本层的
   * 串行队列，和本地命令抢同一个 `seq`。这里用 `bindCollaboration` 把远端更新
   * 也变成一条 `applyUpdate` 命令，和编辑共享队列，保证「谁先提交谁先落地」。
   */
  private startCollaboration(config: XlsxCollabOptions): void {
    const replica = this.session.replica
    if (!replica) throw new Error('协同工作簿缺少副本，无法连接房间')
    this.collabConfig = config
    this.collabClientId = replica.clientId
    this.collabState = { status: 'connecting', synced: false, peers: [] }
    this.unbindCollab = this.session.bindCollaboration?.((update) => this.applyRemoteUpdate(update)) ?? null
    const provider = new CollaborationProvider(replica, config.transport as CollaborationTransport, {
      user: config.user,
    })
    this.provider = provider
    this.offProvider.push(
      provider.onStatus((change) => {
        this.updateCollab({ status: change.status as XlsxCollabConnection, synced: change.synced })
      }),
      provider.onAwareness((peers) => {
        this.updateCollab({
          peers: peers
            .filter((peer) => peer.clientId !== this.collabClientId && peer.cursor)
            .map((peer) => ({
              clientId: peer.clientId,
              name: peer.user.name,
              color: peer.user.color,
              sheet: peer.cursor!.sheet,
              anchor: { row: peer.cursor!.anchor.row, col: peer.cursor!.anchor.col },
              head: { row: peer.cursor!.head.row, col: peer.cursor!.head.col },
            })),
        })
      }),
      provider.onError((error) => {
        // 背压 / 协议错误不破坏本地内容：只在状态条提示，等传输自己重连
        this.updateCollab({ error: error.message })
      }),
    )
    this.offClosed = config.transport.onClosed?.((code, reason) => config.onClosed?.(code, reason)) ?? null
    provider.connect()
    this.emitCollab()
  }

  /** 远端更新也走编辑队列；被引擎拒绝时抛错，让 provider 记录失败而不是静默丢内容 */
  private applyRemoteUpdate(update: Uint8Array): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('表格已经关闭'))
    return this.enqueue(async () => {
      const command = {
        ...this.session.commandIdentity,
        seq: this.session.throughSeq + 1,
        basis: this.session.confirmedBasis,
        kind: 'applyUpdate',
        payload: { update: update.slice() },
      } as unknown as WorkbookCommand
      const status = await this.session.submit(command)
      if (status.status !== 'applied' && status.status !== 'noop') {
        throw new Error(status.reason ?? '同步更新被拒绝')
      }
      return status
    })
  }

  private updateCollab(patch: Partial<XlsxCollabStatus>): void {
    const base = this.collabState ?? { status: 'connecting' as const, synced: false, peers: [] }
    this.collabState = { ...base, ...patch }
    this.emitCollab()
  }

  private emitCollab(): void {
    const status = this.collaboration
    if (this.collabConfig?.onStatus) this.collabConfig.onStatus(status ?? { status: 'disconnected', synced: false, peers: [] })
    for (const listener of this.collabListeners) listener()
  }

  private notifyChange(): void {
    for (const listener of this.changeListeners) listener()
  }

  private assertEditable(): void {
    if (!this.canEdit) throw new Error('这个表格以只读方式打开，不能编辑')
    if (this.disposed) throw new Error('表格已经关闭')
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * 提交一条命令到 Worker 内的编辑会话，并把 ack 收敛成本仓稳定结果。
   *
   * 上游要求 `seq` 严格等于「下一条待提交序号」，`basis` 用当前已确认版本；
   * 因此所有命令串行入队，绝不允许两个 Promise 同时 submit。
   */
  private async dispatch(
    kind: WorkbookCommandKind,
    payload: { args: readonly unknown[] } | { toolbar: unknown },
    selection?: XlsxSelection,
  ): Promise<XlsxMutationResult> {
    this.assertEditable()
    return this.enqueue(async () => {
      const intent: Record<string, unknown> = { ...payload }
      if (selection) intent.selection = this.commandSelection(selection)
      const command = {
        ...this.session.commandIdentity,
        seq: this.session.throughSeq + 1,
        basis: this.session.confirmedBasis,
        kind,
        payload: intent,
      } as unknown as WorkbookCommand
      let status: CommandStatus
      try {
        status = await this.session.submit(command)
      } catch (err) {
        // 失败已由引擎落到会话 failure（Surface 会显示错误并保留未保存字节），这里只回一个可展示结果
        return { ...this.emptyResult(), refusedReason: err instanceof Error ? err.message : String(err) }
      }
      const result = (status.result ?? null) as EditResult | null
      const editState = this.session.editState
      if (selection) this.lastFormatting = formattingOfSelection(editState.formatting) ?? this.lastFormatting
      return {
        applied: status.status === 'applied' || status.status === 'noop',
        refusedReason: status.status === 'refused' || status.status === 'cancelled' ? (status.reason ?? '编辑被拒绝') : null,
        changed: result?.changed ?? [],
        limitedCells: result?.limitedCells ?? [],
        sheets: this.syncSheets(result?.sheetInfo),
        canUndo: editState.canUndo === true,
        canRedo: editState.canRedo === true,
        formatting: selection ? this.lastFormatting : null,
        version: String(this.session.state.version),
      }
    })
  }

  private emptyResult(): XlsxMutationResult {
    const state = this.session.editState
    return {
      applied: false,
      refusedReason: null,
      changed: [],
      limitedCells: [],
      sheets: this.catalog,
      canUndo: state.canUndo === true,
      canRedo: state.canRedo === true,
      formatting: null,
      version: String(this.session.state.version),
    }
  }

  /** 命令里的选区用 sheetId + A1，和工具栏 / 协同的寻址方式一致 */
  private commandSelection(selection: XlsxSelection): WorkbookCommandSelection {
    const sheet = this.catalog[this.active]
    const range = xlsxNormalizeRange(selection)
    return {
      sheetId: sheet?.id ?? '',
      range: { kind: 'a1', a1: xlsxRangeA1(range) },
      activeCell: { row: selection.focus.row, col: selection.focus.col },
    }
  }

  /** 编辑可能让引擎改写 sheet 目录（重命名等）；长度变化时刷新本地投影 */
  private syncSheets(info: EditResult['sheetInfo'] | undefined): readonly XlsxSheetSummary[] {
    if (!info || info.sheetNames.length !== this.catalog.length) return this.catalog
    info.sheetNames.forEach((name, index) => {
      const entry = this.catalog[index]
      if (entry && entry.name !== name) entry.name = name
    })
    return this.catalog
  }
}

/** 打开工作簿；`editable` 为真时可在 Worker 内编辑 */
export async function openXlsxWorkbook(
  bytes: Uint8Array | ArrayBuffer,
  options: { editable?: boolean; collab?: XlsxCollabOptions } = {},
): Promise<XlsxWorkbook> {
  return XlsxWorkbook.open(bytes, options)
}

/** 客户端 id 必须是非零安全整数；Yjs 用它区分同房间的副本 */
function randomClientId(): number {
  return (crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff) || 1
}

/** 单元格地址：A1 / AA10（零基行号 + 1） */
export function xlsxCellName(row: number, col: number): string {
  return cellName(row, col)
}

/** 选区起点 → 单格选区 */
export function xlsxSelectionAt(point: XlsxPoint): XlsxSelection {
  return { anchor: { ...point }, focus: { ...point } }
}

/** 选区规范化成闭合矩形 */
export function xlsxNormalizeRange(selection: XlsxSelection): XlsxRange {
  const range = normalizeRange(toSelection(selection))
  return { top: range.top, left: range.left, bottom: range.bottom, right: range.right }
}

/**
 * 键盘导航：方向键 / Shift 扩展 / Tab / Home / End / PageUp / PageDown。
 *
 * 只接受上游 reducer 产生的 `move`；F2 / Enter 在只读视图里不进入编辑，
 * Delete / 输入字符也不会落盘（Surface 本身 readonly）。
 */
export function xlsxKeySelection(
  selection: XlsxSelection,
  key: XlsxKeyInput,
  limits: XlsxSelectionLimits,
  mergedRanges: readonly XlsxRange[] = [],
  usedRange?: XlsxRange | null,
): XlsxSelection | null {
  const merges: SelectionMerges | undefined = mergedRanges.length
    ? {
        mergeAt(row, col) {
          return (
            mergedRanges.find((range) => row >= range.top && row <= range.bottom && col >= range.left && col <= range.right) ?? null
          )
        },
      }
    : undefined
  // usedRange 让 End / Ctrl+End 落到已用区域边缘；不传时只做普通单格移动
  const data = usedRange ? { usedRange: toCellRange(usedRange) } : undefined
  const action = selectionKeyReducer(toSelection(selection), key as KeyInput, limits as SelectionLimits, data, undefined, merges)
  if (action.type !== 'move') return null
  return fromSelection(action.selection)
}

/** 拖拽 / Shift+点击：保持 anchor，把 focus 移到目标格 */
export function xlsxExtendSelection(selection: XlsxSelection, focus: XlsxPoint, limits: XlsxSelectionLimits): XlsxSelection {
  // Shift+点击 / 拖拽是二维的，不能只沿一个方向走；直接按边界夹住 focus
  return {
    anchor: { ...selection.anchor },
    focus: {
      row: Math.min(Math.max(0, focus.row), Math.max(0, limits.rows - 1)),
      col: Math.min(Math.max(0, focus.col), Math.max(0, limits.cols - 1)),
    },
  }
}

/** 全选已用区域 */
export function xlsxSelectAll(usedRange: XlsxRange): XlsxSelection {
  return {
    anchor: { row: usedRange.top, col: usedRange.left },
    focus: { row: usedRange.bottom, col: usedRange.right },
  }
}

/* ------------------------------ 内部转换 ------------------------------ */

function toSelection(selection: XlsxSelection): Selection {
  return {
    anchor: { ...selection.anchor },
    focus: { ...selection.focus },
  }
}

function fromSelection(selection: Selection): XlsxSelection {
  return {
    anchor: { ...selection.anchor },
    focus: { ...selection.focus },
  }
}

function toCellRange(range: XlsxRange): CellRange {
  return range
}

function cellName(row: number, col: number): string {
  let name = ''
  let value = col + 1
  while (value > 0) {
    const remainder = (value - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    value = Math.floor((value - 1) / 26)
  }
  return `${name}${row + 1}`
}

/** 选区 → A1 区块（`A1` / `A1:C3`），命令与工具栏都用这种寻址 */
export function xlsxRangeA1(range: XlsxRange): string {
  const start = cellName(range.top, range.left)
  if (range.top === range.bottom && range.left === range.right) return start
  return `${start}:${cellName(range.bottom, range.right)}`
}

/**
 * 引擎 `SelectionFormatting`（ack 内联）→ 本仓稳定格式快照。
 * 缺失字段按「未设置」处理，避免工具栏把默认值误显示成显式格式。
 */
export function formattingOfSelection(formatting: SelectionFormatting | undefined | null): XlsxFormatting | null {
  if (!formatting) return null
  return {
    bold: formatting.bold === true,
    italic: formatting.italic === true,
    strikethrough: formatting.strikethrough === true,
    fontFamily: formatting.fontFamily ?? null,
    fontSize: formatting.fontSize ?? null,
    textColor: formatting.textColor ?? null,
    fillColor: formatting.fillColor ?? null,
    numberFormat: formatting.numberFormat ?? null,
    numberFormatPattern: formatting.numberFormatPattern ?? null,
    horizontalAlignment: formatting.horizontalAlignment ?? null,
    // SelectionFormatting 用 middle，本仓统一 center
    verticalAlignment:
      formatting.verticalAlignment == null
        ? null
        : formatting.verticalAlignment === 'middle'
          ? 'center'
          : formatting.verticalAlignment,
    textWrapping: formatting.textWrapping ?? null,
  }
}

/** 引擎 `CapturedCellFormat`（captureFormat 返回值）→ 本仓稳定格式快照 */
export function formattingFromCaptured(cell: CapturedCellFormat): XlsxFormatting {
  const { numberFormat } = cell
  return {
    bold: cell.font.bold === true,
    italic: cell.font.italic === true,
    strikethrough: cell.font.strike === true,
    fontFamily: cell.font.name ?? null,
    fontSize: cell.font.size_pt ?? null,
    textColor: colorToHex(cell.font.color),
    fillColor: fillToHex(cell.fill),
    ...numberFormatOfCaptured(numberFormat),
    horizontalAlignment: alignmentFromCaptured(cell.alignment.h),
    verticalAlignment: verticalAlignmentFromCaptured(cell.alignment.v),
    textWrapping: cell.alignment.wrap_text === true ? 'wrap' : null,
  }
}

/**
 * 内置数字格式 id → 语义类别。
 *
 * 只映射 Excel 内置段（0-49）中我们工具栏会展示的几类；其余（会计、区域日期）
 * 一律落到 `custom` + 空 pattern，由引擎在单元格里显示真实值，绝不改用户原格式。
 */
export function numberFormatOfCaptured(
  numberFormat: CapturedCellFormat['numberFormat'],
): Pick<XlsxFormatting, 'numberFormat' | 'numberFormatPattern'> {
  if (numberFormat.kind === 'custom') {
    return { numberFormat: 'custom', numberFormatPattern: numberFormat.pattern }
  }
  const id = numberFormat.id
  if (id === 0) return { numberFormat: 'automatic', numberFormatPattern: null }
  if (id === 49) return { numberFormat: 'plainText', numberFormatPattern: null }
  if (id >= 1 && id <= 4) return { numberFormat: 'number', numberFormatPattern: null }
  if (id === 9 || id === 10) return { numberFormat: 'percent', numberFormatPattern: null }
  if (id === 11) return { numberFormat: 'scientific', numberFormatPattern: null }
  if (id >= 5 && id <= 8) return { numberFormat: 'currency', numberFormatPattern: null }
  if (id >= 14 && id <= 22) return { numberFormat: 'date', numberFormatPattern: null }
  if (id >= 45 && id <= 47) return { numberFormat: 'time', numberFormatPattern: null }
  return { numberFormat: 'custom', numberFormatPattern: null }
}

function colorToHex(color: CapturedCellFormat['font']['color']): string | null {
  if (!color || color === 'Auto') return null
  if ('Rgb' in color) {
    const rgb = color.Rgb.replace(/^#/, '')
    // xlsx 的 ARGB 常带 FF 不透明前缀；UI 只认 6 位 RGB
    return `#${(rgb.length === 8 ? rgb.slice(2) : rgb).toLowerCase()}`
  }
  return null
}

function fillToHex(fill: CapturedCellFormat['fill']): string | null {
  if (fill === 'None') return null
  if ('Solid' in fill) return colorToHex(fill.Solid)
  return null
}

function alignmentFromCaptured(
  value: CapturedCellFormat['alignment']['h'],
): XlsxHorizontalAlignment | null {
  if (!value || value === 'General') return null
  return value.toLowerCase() as XlsxHorizontalAlignment
}

function verticalAlignmentFromCaptured(
  value: CapturedCellFormat['alignment']['v'],
): XlsxVerticalAlignment | null {
  if (!value) return null
  // 上游用 middle，本仓统一叫 center，避免两套词汇混用
  return (value === 'Center' ? 'center' : value.toLowerCase()) as XlsxVerticalAlignment
}
