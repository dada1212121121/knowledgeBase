<script setup lang="ts">
/**
 * XLSX 只读视图
 *
 * 设计约束：
 * - 单元格内容由引擎 DisplayList 直接画到 Canvas，Vue 只持有「当前帧对象」的 shallowRef；
 *   滚动位置放在普通对象里，scroll 不触发 Vue patch；
 * - 选区 / 公式栏 / 工作表标签是 DOM，屏幕阅读器和键盘导航走浏览器原生能力；
 * - 只读与编辑共用一个组件：传入 `edit` 适配器即可写。编辑走引擎的 Worker 会话，
 *   视图只负责「输入从哪来、写到哪一格」，不自己算公式、不做序列化；
 * - 保存不在这里发生：宿主在 Ctrl+S 时向 Surface 取引擎序列化后的字节。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  xlsxExtendSelection,
  xlsxKeySelection,
  xlsxNormalizeRange,
  xlsxSelectAll,
  type XlsxCellInfo,
  type XlsxCollabPeer,
  type XlsxFindMatch,
  type XlsxFrame,
  type XlsxRange,
  type XlsxSelection,
  type XlsxSheetView,
  type XlsxFormatting,
} from '../../engines/xlsx'
import type { XlsxEditAdapter, XlsxReadAdapter, XlsxReadState } from './xlsx'
import {
  xlsxCommitEdits,
  xlsxCopyPayload,
  xlsxNumberFormatMutation,
  xlsxTogglePatch,
} from './xlsx-edit'
import { columnLabel } from './painter'

const props = withDefaults(
  defineProps<{
    adapter: XlsxReadAdapter
    initial: XlsxReadState
    label?: string
    /** 传入编辑适配器即进入可编辑态；只读预览不传 */
    edit?: XlsxEditAdapter | null
    /** 房间里其他人的光标；只画当前工作表，不参与引擎绘制 */
    collabPeers?: readonly XlsxCollabPeer[]
  }>(),
  { label: '电子表格', edit: null, collabPeers: () => [] },
)

const emit = defineEmits<{
  selection: [payload: { row: number; col: number; text: string; range: XlsxRange }]
  selectSheet: [index: number]
  findRequest: []
  ready: [payload: { cells: number; version: string }]
  error: [message: string]
  dirty: [value: boolean]
  notice: [message: string]
}>()

const root = ref<HTMLElement | null>(null)
const scroller = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
/** 行号 / 列标：上游 DisplayList 不画表头，宿主在网格外侧自己画两条 */
const colHeader = ref<HTMLCanvasElement | null>(null)
const rowHeader = ref<HTMLCanvasElement | null>(null)
const frame = shallowRef<XlsxFrame | null>(null)
const viewInfo = ref<XlsxSheetView>({ ...props.initial.view })
const usedRange = ref<XlsxRange | null>(props.initial.usedRange ? { ...props.initial.usedRange } : null)
const selection = ref<XlsxSelection>({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } })
const formulaText = ref('')
const displayText = ref('')
const copyText = ref('')
const errorText = ref('')
const loading = ref(true)
const spacerWidth = ref(0)
const spacerHeight = ref(0)
const activeSheet = ref(props.initial.active)
const tabs = computed(() => props.adapter.sheets)
const alignOptions = ['left', 'center', 'right'] as const
const editable = computed(() => props.edit !== null)
const editing = ref(false)
const editDraft = ref('')
const editorEl = ref<HTMLTextAreaElement | null>(null)
const editRect = ref<{ x: number; y: number; w: number; h: number } | null>(null)
const formatting = ref<XlsxFormatting | null>(null)
const busy = ref(false)
const noticeText = ref('')
let formatToken = 0

/** 列标高度与行号宽度：行号按已用区最大行号的位数留宽，10 万行也不截字 */
const HEADER_HEIGHT = 20
const gutterWidth = computed(() => Math.max(32, String((usedRange.value?.bottom ?? 0) + 1).length * 7 + 14))

/** 滚动 / 尺寸都不进响应式：每帧直接读 DOM，避免滚动时 patch 整个模板 */
const viewport = { scrollTop: 0, scrollLeft: 0, width: 0, height: 0 }
let ctx: CanvasRenderingContext2D | null = null
let raf = 0
let drawing = false
let dirty = false
let destroyed = false
let readySent = false
let contentToken = 0
let drag: { pointerId: number; anchor: { row: number; col: number } } | null = null
let resizeObserver: ResizeObserver | null = null
let findMatches: XlsxFindMatch[] = []
let findIndex = -1
let findQuery = ''

const activeCell = computed(() => selection.value.focus)
const activeLabel = computed(() => `${columnLabel(activeCell.value.col)}${activeCell.value.row + 1}`)
const selectedSummary = computed(() => {
  const range = xlsxNormalizeRange(selection.value)
  const rows = range.bottom - range.top + 1
  const cols = range.right - range.left + 1
  return rows === 1 && cols === 1 ? activeLabel.value : `${rows} 行 × ${cols} 列`
})

function limits(): { rows: number; cols: number; rowsPerPage: number } {
  const used = usedRange.value
  const rows = Math.max(1, (used?.bottom ?? 0) + 1)
  const cols = Math.max(1, (used?.right ?? 0) + 1)
  const bodyHeight = Math.max(20, (scroller.value?.clientHeight ?? 400) - viewInfo.value.frozenHeight)
  return { rows, cols, rowsPerPage: Math.max(1, Math.floor(bodyHeight / 20) - 1) }
}

/** 首次挂载后先画一帧；之后滚动 / 尺寸变化都只排一次 rAF */
function scheduleDraw(): void {
  if (destroyed) return
  dirty = true
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    void drawLoop()
  })
}

async function drawLoop(): Promise<void> {
  if (destroyed || drawing) return
  drawing = true
  dirty = false
  try {
    await drawOnce()
  } catch (err) {
    errorText.value = err instanceof Error ? err.message : String(err)
    emit('error', errorText.value)
  } finally {
    drawing = false
    if (dirty && !destroyed) scheduleDraw()
  }
}

async function drawOnce(): Promise<void> {
  const el = scroller.value
  const element = canvas.value
  if (!el || !element) return
  const width = Math.floor(el.clientWidth)
  const height = Math.floor(el.clientHeight)
  if (width <= 0 || height <= 0) return

  const dpr = window.devicePixelRatio || 1
  const backingWidth = Math.max(1, Math.round(width * dpr))
  const backingHeight = Math.max(1, Math.round(height * dpr))
  if (element.width !== backingWidth || element.height !== backingHeight) {
    element.width = backingWidth
    element.height = backingHeight
  }
  // sticky + 负 margin：让画布始终覆盖视口，滚动条和绘制位置分离
  element.style.width = `${width}px`
  element.style.height = `${height}px`
  element.style.marginTop = `-${height}px`
  if (!ctx) ctx = element.getContext('2d', { alpha: false })
  if (!ctx) return

  viewport.width = width
  viewport.height = height
  viewport.scrollLeft = el.scrollLeft
  viewport.scrollTop = el.scrollTop
  const next = await props.adapter.frame({
    x: el.scrollLeft,
    y: el.scrollTop,
    width,
    height,
  })
  if (destroyed) return
  frame.value = next
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, backingWidth, backingHeight)
  next.paint(ctx, dpr)
  paintSelection(dpr)
  paintHeaders(dpr)
  loading.value = false
  if (!readySent) {
    readySent = true
    const used = usedRange.value
    emit('ready', {
      cells: used ? (used.bottom - used.top + 1) * (used.right - used.left + 1) : 0,
      version: props.adapter.version,
    })
  }
}

/** 一条表头画布对齐到网格视口：宽 / 高跟随滚动区（不含滚动条），按 dpr 放大 */
function prepareHeader(element: HTMLCanvasElement | null, width: number, height: number, dpr: number): CanvasRenderingContext2D | null {
  if (!element || width <= 0 || height <= 0) return null
  const backingWidth = Math.max(1, Math.round(width * dpr))
  const backingHeight = Math.max(1, Math.round(height * dpr))
  if (element.width !== backingWidth || element.height !== backingHeight) {
    element.width = backingWidth
    element.height = backingHeight
  }
  element.style.width = `${width}px`
  element.style.height = `${height}px`
  const context = element.getContext('2d')
  if (!context) return null
  context.setTransform(dpr, 0, 0, dpr, 0, 0)
  context.clearRect(0, 0, width, height)
  return context
}

/**
 * 行号列标：位置全部来自当前帧的可见轨道（冻结窗格、隐藏行列、行高列宽与引擎绘制一致）；
 * 选区覆盖到的行 / 列高亮，和 Excel 一样一眼看出当前在哪一行哪一列
 */
function paintHeaders(dpr: number): void {
  const current = frame.value
  const el = scroller.value
  if (!current || !el || typeof current.tracks !== 'function') return
  const style = getComputedStyle(root.value ?? document.documentElement)
  const background = style.getPropertyValue('--panel2').trim() || '#f4f4f5'
  const border = style.getPropertyValue('--b2').trim() || '#d4d4d8'
  const text = style.getPropertyValue('--t2').trim() || '#52525b'
  const activeBg = style.getPropertyValue('--acbg').trim() || 'rgba(94,106,210,.18)'
  const activeText = style.getPropertyValue('--t').trim() || '#18181b'
  const font = `${Math.round(11 * (Number.parseFloat(style.getPropertyValue('--fs')) || 1))}px ${style.fontFamily || 'sans-serif'}`
  const range = xlsxNormalizeRange(selection.value)
  const draw = (
    context: CanvasRenderingContext2D | null,
    tracks: { index: number; start: number; size: number }[],
    horizontal: boolean,
    length: number,
    thickness: number,
  ) => {
    if (!context) return
    context.fillStyle = background
    context.fillRect(0, 0, horizontal ? length : thickness, horizontal ? thickness : length)
    context.font = font
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.strokeStyle = border
    context.lineWidth = 1
    for (const track of tracks) {
      if (track.size <= 0) continue
      const active = horizontal ? track.index >= range.left && track.index <= range.right : track.index >= range.top && track.index <= range.bottom
      if (active) {
        context.fillStyle = activeBg
        if (horizontal) context.fillRect(track.start, 0, track.size, thickness)
        else context.fillRect(0, track.start, thickness, track.size)
      }
      context.fillStyle = active ? activeText : text
      const label = horizontal ? columnLabel(track.index) : String(track.index + 1)
      // 太窄放不下字的轨道只画分隔线（隐藏到 2 px 的列 / 行）
      if (track.size >= 10) {
        if (horizontal) context.fillText(label, track.start + track.size / 2, thickness / 2 + 0.5, track.size - 2)
        else context.fillText(label, thickness / 2, track.start + track.size / 2 + 0.5, thickness - 4)
      }
      context.beginPath()
      if (horizontal) {
        context.moveTo(track.start + track.size - 0.5, 0)
        context.lineTo(track.start + track.size - 0.5, thickness)
      } else {
        context.moveTo(0, track.start + track.size - 0.5)
        context.lineTo(thickness, track.start + track.size - 0.5)
      }
      context.stroke()
    }
    // 与网格相邻的那条边
    context.beginPath()
    if (horizontal) {
      context.moveTo(0, thickness - 0.5)
      context.lineTo(length, thickness - 0.5)
    } else {
      context.moveTo(thickness - 0.5, 0)
      context.lineTo(thickness - 0.5, length)
    }
    context.stroke()
  }
  const width = Math.floor(el.clientWidth)
  const height = Math.floor(el.clientHeight)
  draw(prepareHeader(colHeader.value, width, HEADER_HEIGHT, dpr), current.tracks('col'), true, width, HEADER_HEIGHT)
  draw(prepareHeader(rowHeader.value, gutterWidth.value, height, dpr), current.tracks('row'), false, height, gutterWidth.value)
}

/** 点列标选整列、点行号选整行；按住 Shift 从当前锚点扩到这一列 / 行 */
function onHeaderPointerDown(kind: 'col' | 'row', event: PointerEvent): void {
  if (event.button !== 0) return
  const current = frame.value
  if (!current || typeof current.tracks !== 'function') return
  if (editing.value) void commitEdit()
  root.value?.focus({ preventScroll: true })
  const position = kind === 'col' ? event.offsetX : event.offsetY
  const track = current.tracks(kind).find((item) => position >= item.start && position < item.start + item.size)
  if (!track) return
  const { rows, cols } = limits()
  const anchorIndex = event.shiftKey ? (kind === 'col' ? selection.value.anchor.col : selection.value.anchor.row) : track.index
  const next: XlsxSelection =
    kind === 'col'
      ? { anchor: { row: 0, col: anchorIndex }, focus: { row: rows - 1, col: track.index } }
      : { anchor: { row: anchorIndex, col: 0 }, focus: { row: track.index, col: cols - 1 } }
  setSelection(next, false)
  event.preventDefault()
}

/** 选区 / 远端光标覆盖层；不参与引擎绘制，避免只读帧里混入宿主状态 */
function paintSelection(dpr: number): void {
  const current = frame.value
  const context = ctx
  if (!current || !context) return
  const range = xlsxNormalizeRange(selection.value)
  const rect = current.rangeRect(range)
  if (!rect) return
  const style = getComputedStyle(document.documentElement)
  const accent = style.getPropertyValue('--accent').trim() || '#5e6ad2'
  context.save()
  context.scale(dpr, dpr)
  context.fillStyle = 'rgba(94,106,210,.13)'
  context.fillRect(rect.x, rect.y, rect.w, rect.h)
  context.strokeStyle = accent
  context.lineWidth = range.top === range.bottom && range.left === range.right ? 2 : 1
  const inset = context.lineWidth / 2
  context.strokeRect(rect.x + inset, rect.y + inset, Math.max(0, rect.w - context.lineWidth), Math.max(0, rect.h - context.lineWidth))
  paintRemoteCursors(current, context)
  context.restore()
}

/**
 * 远端选区：同一工作表才画，颜色由房间分配。
 * 名字标签优先放在选区上方；贴到视口顶部时放进选区内部，避免被裁掉。
 */
function paintRemoteCursors(current: XlsxFrame, context: CanvasRenderingContext2D): void {
  const sheetId = tabs.value[activeSheet.value]?.id
  for (const peer of props.collabPeers) {
    if (peer.sheet !== sheetId) continue
    const top = Math.min(peer.anchor.row, peer.head.row)
    const left = Math.min(peer.anchor.col, peer.head.col)
    const bottom = Math.max(peer.anchor.row, peer.head.row)
    const right = Math.max(peer.anchor.col, peer.head.col)
    const rect = current.rangeRect({ top, left, bottom, right })
    if (!rect) continue
    const color = peer.color || '#0B57D0'
    context.save()
    context.globalAlpha = 0.08
    context.fillStyle = color
    context.fillRect(rect.x, rect.y, rect.w, rect.h)
    context.globalAlpha = 1
    context.strokeStyle = color
    context.lineWidth = 1.5
    context.strokeRect(rect.x + 0.75, rect.y + 0.75, Math.max(0, rect.w - 1.5), Math.max(0, rect.h - 1.5))
    const label = peer.name || '协作者'
    context.font = '11px system-ui, sans-serif'
    const labelWidth = Math.min(140, context.measureText(label).width + 8)
    const labelY = rect.y >= 16 ? rect.y - 16 : rect.y + 1
    context.fillStyle = color
    context.fillRect(rect.x, labelY, labelWidth, 15)
    context.fillStyle = '#ffffff'
    context.fillText(label, rect.x + 4, labelY + 11, labelWidth - 8)
    context.restore()
  }
}

function onScroll(): void {
  // 编辑框按视口坐标定位；滚动会让它和单元格错位，先把已输入内容提交掉
  if (editing.value) void commitEdit()
  scheduleDraw()
}

/**
 * 选中单元格：先夹进导航边界，落在一个合并区域里时展开成整个合并区。
 * `scrollIntoView` 在拖拽 / Shift 点击时关闭，只更新选择框。
 */
function setSelection(next: XlsxSelection, scrollIntoView = true): void {
  const { rows, cols } = limits()
  const focus = {
    row: Math.min(Math.max(0, next.focus.row), rows - 1),
    col: Math.min(Math.max(0, next.focus.col), cols - 1),
  }
  const merged = frame.value?.mergedRanges.find(
    (range) => focus.row >= range.top && focus.row <= range.bottom && focus.col >= range.left && focus.col <= range.right,
  )
  selection.value = merged
    ? { anchor: { row: merged.top, col: merged.left }, focus: { row: merged.bottom, col: merged.right } }
    : {
        anchor: {
          row: Math.min(Math.max(0, next.anchor.row), rows - 1),
          col: Math.min(Math.max(0, next.anchor.col), cols - 1),
        },
        focus,
      }
  void syncContent()
  if (editable.value) void refreshFormatting()
  paintAfterSelection()
  if (scrollIntoView) void scrollActiveIntoView()
}

function paintAfterSelection(): void {
  // 不重新拉帧，直接把当前帧重画一遍加新选区；滚动时才走 drawLoop
  const element = canvas.value
  if (!element || !ctx) {
    scheduleDraw()
    return
  }
  const dpr = window.devicePixelRatio || 1
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, element.width, element.height)
  frame.value?.paint(ctx, dpr)
  paintSelection(dpr)
  // 表头的「当前行 / 列」高亮跟着选区走
  paintHeaders(dpr)
}

/* ------------------------------ 编辑 ------------------------------ */

/** 开始就地编辑；`initial` 为用户键入的首字符，缺省时读取单元格现有输入 */
async function startEdit(initial?: string): Promise<void> {
  const adapter = props.edit
  if (!adapter || busy.value || editing.value) return
  const cell = selection.value.focus
  const rect = frame.value?.rangeRect({ top: cell.row, left: cell.col, bottom: cell.row, right: cell.col })
  if (!rect) return
  const draft = initial ?? (await adapter.inputAt(cell.row, cell.col))
  if (destroyed) return
  editRect.value = rect
  editDraft.value = draft
  editing.value = true
  await nextTick()
  const el = editorEl.value
  if (!el) return
  el.focus()
  const end = el.value.length
  el.setSelectionRange(end, end)
}

function cancelEdit(): void {
  editing.value = false
  editRect.value = null
  editDraft.value = ''
  root.value?.focus({ preventScroll: true })
}

/** 提交就地编辑；`move` 让回车/制表符提交后继续导航，接近 Excel 手感 */
async function commitEdit(move?: 'down' | 'up' | 'right' | 'left', fillSelection = false): Promise<void> {
  const adapter = props.edit
  if (!adapter || !editing.value) return
  const range = xlsxNormalizeRange(selection.value)
  const cells = xlsxCommitEdits(range, editDraft.value, { fillSelection })
  editing.value = false
  editRect.value = null
  if (cells.length === 0) return
  busy.value = true
  try {
    const outcome = await adapter.commit(cells, selection.value, 'user')
    applyOutcome(outcome)
  } finally {
    busy.value = false
  }
  if (move) moveActive(move)
  root.value?.focus({ preventScroll: true })
}

/** 公式栏提交：与就地编辑共用一套语义，Ctrl+Enter 填满选区 */
async function commitFormula(event: KeyboardEvent): Promise<void> {
  const adapter = props.edit
  if (!adapter) return
  const range = xlsxNormalizeRange(selection.value)
  const cells = xlsxCommitEdits(range, formulaText.value, {
    fillSelection: event.ctrlKey || event.metaKey,
  })
  busy.value = true
  try {
    applyOutcome(await adapter.commit(cells, selection.value, 'user'))
  } finally {
    busy.value = false
  }
}

function revertFormula(): void {
  void syncContent()
  root.value?.focus({ preventScroll: true })
}

function onEditorKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    cancelEdit()
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    void commitEdit(event.shiftKey ? 'up' : 'down', event.ctrlKey || event.metaKey)
    return
  }
  if (event.key === 'Tab') {
    event.preventDefault()
    void commitEdit(event.shiftKey ? 'left' : 'right')
    return
  }
  // 文本框里的撤销是「撤销正在输入的字」，不能交给宿主的历史
  if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
    event.stopPropagation()
  }
}

function moveActive(direction: 'down' | 'up' | 'right' | 'left'): void {
  const key = direction === 'right' ? 'Tab' : `Arrow${direction[0]!.toUpperCase()}${direction.slice(1)}`
  const next = xlsxKeySelection(
    selection.value,
    { key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false },
    limits(),
    frame.value?.mergedRanges ?? [],
    usedRange.value,
  )
  if (next) setSelection(next)
}

/** 一次写入成功后统一刷新：重画、同步公式栏、刷新工具栏、通知宿主 dirty */
function applyOutcome(outcome: { applied: boolean; refusedReason: string | null; dirty: boolean; changed: readonly string[] }): void {
  if (!outcome.applied && outcome.refusedReason) {
    noticeText.value = outcome.refusedReason
    emit('notice', outcome.refusedReason)
  } else if (outcome.applied) {
    noticeText.value = outcome.changed.length ? `已更新 ${outcome.changed.length} 个依赖单元格` : ''
  }
  emit('dirty', outcome.dirty)
  scheduleDraw()
  void syncContent()
  void refreshFormatting()
}

async function refreshFormatting(): Promise<void> {
  const adapter = props.edit
  if (!adapter) return
  const token = ++formatToken
  const next = await adapter.formatting(xlsxNormalizeRange(selection.value))
  if (token === formatToken) formatting.value = next
}

async function toggleFormat(property: 'bold' | 'italic' | 'strikethrough'): Promise<void> {
  const adapter = props.edit
  if (!adapter) return
  busy.value = true
  try {
    applyOutcome(
      await adapter.applyStyle(xlsxNormalizeRange(selection.value), xlsxTogglePatch(formatting.value, property), selection.value),
    )
  } finally {
    busy.value = false
  }
}

async function setNumberFormat(choice: string): Promise<void> {
  const adapter = props.edit
  if (!adapter) return
  busy.value = true
  try {
    applyOutcome(
      await adapter.applyNumberFormat(
        xlsxNormalizeRange(selection.value),
        xlsxNumberFormatMutation(choice as Parameters<typeof xlsxNumberFormatMutation>[0]),
        selection.value,
      ),
    )
  } finally {
    busy.value = false
  }
}

async function setAlignment(alignment: 'left' | 'center' | 'right'): Promise<void> {
  const adapter = props.edit
  if (!adapter) return
  busy.value = true
  try {
    applyOutcome(
      await adapter.applyStyle(xlsxNormalizeRange(selection.value), { horizontalAlignment: alignment }, selection.value),
    )
  } finally {
    busy.value = false
  }
}

async function toggleWrap(): Promise<void> {
  const adapter = props.edit
  if (!adapter) return
  busy.value = true
  try {
    applyOutcome(
      await adapter.applyStyle(
        xlsxNormalizeRange(selection.value),
        { textWrapping: formatting.value?.textWrapping === 'wrap' ? 'overflow' : 'wrap' },
        selection.value,
      ),
    )
  } finally {
    busy.value = false
  }
}

async function clearSelection(): Promise<void> {
  const adapter = props.edit
  if (!adapter) return
  busy.value = true
  try {
    applyOutcome(await adapter.clear(xlsxNormalizeRange(selection.value), selection.value))
  } finally {
    busy.value = false
  }
}

async function fillSelection(direction: 'down' | 'right'): Promise<void> {
  const adapter = props.edit
  if (!adapter) return
  busy.value = true
  try {
    applyOutcome(await adapter.fill(xlsxNormalizeRange(selection.value), direction, selection.value))
  } finally {
    busy.value = false
  }
}

async function undo(): Promise<boolean> {
  cancelEdit()
  const adapter = props.edit
  if (!adapter) return false
  const outcome = await adapter.undo(selection.value)
  applyOutcome(outcome)
  return outcome.applied
}

async function redo(): Promise<boolean> {
  cancelEdit()
  const adapter = props.edit
  if (!adapter) return false
  const outcome = await adapter.redo(selection.value)
  applyOutcome(outcome)
  return outcome.applied
}

/** 当前选区里的合并区域（转成相对顶点的 rowSpan/colSpan），供复制 HTML 用 */
function mergesInRange(range: XlsxRange): { row: number; col: number; rowSpan: number; colSpan: number }[] {
  const merges = frame.value?.mergedRanges ?? []
  return merges
    .filter((merge) => merge.bottom >= range.top && merge.top <= range.bottom && merge.right >= range.left && merge.left <= range.right)
    .map((merge) => ({
      row: Math.max(merge.top, range.top) - range.top,
      col: Math.max(merge.left, range.left) - range.left,
      rowSpan: Math.min(merge.bottom, range.bottom) - Math.max(merge.top, range.top) + 1,
      colSpan: Math.min(merge.right, range.right) - Math.max(merge.left, range.left) + 1,
    }))
}

async function copySelectionTo(event: ClipboardEvent): Promise<void> {
  const adapter = props.edit
  if (!adapter) return
  const range = xlsxNormalizeRange(selection.value)
  const matrix = await adapter.copyRange(range)
  const payload = xlsxCopyPayload(matrix, mergesInRange(range))
  event.clipboardData?.setData('text/plain', payload.text)
  event.clipboardData?.setData('text/html', payload.html)
  event.preventDefault()
}

async function syncContent(): Promise<void> {
  const token = ++contentToken
  const range = xlsxNormalizeRange(selection.value)
  const active = selection.value.focus
  const [cell, text] = await Promise.all([
    props.adapter.readCell(active.row, active.col),
    props.adapter.readRange(range),
  ])
  if (token !== contentToken) return
  formulaText.value = cell?.input ?? ''
  displayText.value = cell?.displayText ?? ''
  copyText.value = text.map((row) => row.join('\t')).join('\n')
  emitSelection()
}

function emitSelection(): void {
  const range = xlsxNormalizeRange(selection.value)
  emit('selection', {
    row: selection.value.focus.row,
    col: selection.value.focus.col,
    text: range.top === range.bottom && range.left === range.right ? displayText.value : copyText.value,
    range,
  })
}

async function scrollActiveIntoView(): Promise<void> {
  const el = scroller.value
  if (!el) return
  const focus = selection.value.focus
  const geometry = await props.adapter.cellGeometry(focus.row, focus.col)
  if (destroyed) return
  // 冻结窗格是钉住的：点在冻结区里不应该再改滚动位置
  const frozenHeight = viewInfo.value.frozenHeight
  const frozenWidth = viewInfo.value.frozenWidth
  const bodyHeight = Math.max(1, el.clientHeight - frozenHeight)
  const bodyWidth = Math.max(1, el.clientWidth - frozenWidth)
  const targetY = geometry.scrollPosition.y
  const targetX = geometry.scrollPosition.x
  let top = el.scrollTop
  let left = el.scrollLeft
  if (focus.row >= viewInfo.value.frozenRows) {
    if (targetY < top) top = targetY
    else if (targetY + geometry.rect.h > top + bodyHeight) top = targetY + geometry.rect.h - bodyHeight
  }
  if (focus.col >= viewInfo.value.frozenCols) {
    if (targetX < left) left = targetX
    else if (targetX + geometry.rect.w > left + bodyWidth) left = targetX + geometry.rect.w - bodyWidth
  }
  top = Math.max(0, top)
  left = Math.max(0, left)
  if (Math.abs(el.scrollTop - top) > 0.5) el.scrollTop = top
  if (Math.abs(el.scrollLeft - left) > 0.5) el.scrollLeft = left
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  if (editing.value) void commitEdit()
  root.value?.focus({ preventScroll: true })
  const point = frame.value?.cellAtPoint(event.offsetX, event.offsetY)
  if (!point) return
  const extended = event.shiftKey
    ? xlsxExtendSelection(selection.value, point, limits())
    : { anchor: { ...point }, focus: { ...point } }
  setSelection(extended, !event.shiftKey)
  drag = { pointerId: event.pointerId, anchor: { ...selection.value.anchor } }
  canvas.value?.setPointerCapture(event.pointerId)
  event.preventDefault()
}

function onPointerMove(event: PointerEvent): void {
  if (!drag || drag.pointerId !== event.pointerId) return
  const point = frame.value?.cellAtPoint(event.offsetX, event.offsetY)
  if (!point) return
  setSelection(xlsxExtendSelection({ anchor: drag.anchor, focus: point }, point, limits()), false)
}

function onPointerUp(event: PointerEvent): void {
  if (!drag || drag.pointerId !== event.pointerId) return
  drag = null
  canvas.value?.releasePointerCapture?.(event.pointerId)
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented) return
  const target = event.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
  const modifier = event.ctrlKey || event.metaKey
  if (modifier && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    emit('findRequest')
    return
  }
  if (modifier && event.key.toLowerCase() === 'a') {
    event.preventDefault()
    const used = usedRange.value
    if (used) setSelection(xlsxSelectAll(used))
    return
  }
  if (editable.value && modifier && ['d', 'r'].includes(event.key.toLowerCase())) {
    event.preventDefault()
    void fillSelection(event.key.toLowerCase() === 'd' ? 'down' : 'right')
    return
  }
  if (editable.value && modifier && ['b', 'i'].includes(event.key.toLowerCase())) {
    event.preventDefault()
    void toggleFormat(event.key.toLowerCase() === 'b' ? 'bold' : 'italic')
    return
  }
  if (editable.value && (event.key === 'Delete' || event.key === 'Backspace')) {
    event.preventDefault()
    void clearSelection()
    return
  }
  if (editable.value && event.key === 'F2') {
    event.preventDefault()
    void startEdit()
    return
  }
  // 可打印字符直接进入编辑，与 Excel 一致（输入即覆盖当前格）
  if (editable.value && !modifier && !event.altKey && event.key.length === 1) {
    event.preventDefault()
    void startEdit(event.key)
    return
  }
  if (modifier && event.key === 'Home') {
    event.preventDefault()
    setSelection({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } })
    return
  }
  if (event.altKey) return
  const handled = new Set([
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Tab',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'Enter',
  ])
  if (!handled.has(event.key)) return
  const next = xlsxKeySelection(
    selection.value,
    {
      key: event.key,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
    },
    limits(),
    frame.value?.mergedRanges ?? [],
    usedRange.value,
  )
  if (!next) return
  event.preventDefault()
  setSelection(next)
}

function onCopy(event: ClipboardEvent): void {
  if (editing.value) return
  const target = event.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
  if (props.edit) {
    void copySelectionTo(event)
    return
  }
  if (!copyText.value) return
  event.clipboardData?.setData('text/plain', copyText.value)
  event.preventDefault()
}

function onPaste(event: ClipboardEvent): void {
  const adapter = props.edit
  if (!adapter || editing.value) return
  const text = event.clipboardData?.getData('text/plain') ?? ''
  const html = event.clipboardData?.getData('text/html') ?? ''
  if (!text && !html) return
  event.preventDefault()
  void (async () => {
    busy.value = true
    try {
      const { outcome, truncated } = await adapter.paste({ text, html }, xlsxNormalizeRange(selection.value), selection.value)
      applyOutcome(outcome)
      if (truncated) {
        const message = '粘贴内容超过单次上限，只写入了左上部分；请分块粘贴'
        noticeText.value = message
        emit('notice', message)
      }
    } finally {
      busy.value = false
    }
  })()
}

function onCut(event: ClipboardEvent): void {
  const adapter = props.edit
  if (!adapter || editing.value) return
  void copySelectionTo(event)
  void clearSelection()
}

/** 远端光标变化不需要重新拉帧，重画当前帧即可 */
watch(
  () => props.collabPeers,
  () => paintAfterSelection(),
  { deep: true },
)

/**
 * 远端协同更新后的轻量刷新：只重取工作表尺寸 / 已用区域，再重画。
 * 不调用 `reloadView`，否则适配器的 notify 会再次触发这里，形成回环。
 */
async function refresh(): Promise<void> {
  const state = await props.adapter.viewState()
  if (destroyed) return
  applyState(state)
  if (!editing.value) await syncContent()
  scheduleDraw()
}

/** 首屏加载：工作表状态由控制器提前准备好，这里只负责画第一帧 */
onMounted(() => {
  applyState(props.initial)
  resizeObserver = new ResizeObserver(() => {
    applySpacer()
    scheduleDraw()
  })
  if (scroller.value) resizeObserver.observe(scroller.value)
  void syncContent()
  if (editable.value) void refreshFormatting()
  scheduleDraw()
})

onBeforeUnmount(() => {
  destroyed = true
  if (raf) cancelAnimationFrame(raf)
  resizeObserver?.disconnect()
  resizeObserver = null
  ctx = null
})

function applyState(state: XlsxReadState): void {
  activeSheet.value = state.active
  viewInfo.value = { ...state.view }
  usedRange.value = state.usedRange ? { ...state.usedRange } : null
  applySpacer()
}

function applySpacer(): void {
  const el = scroller.value
  const bodyWidth = el?.clientWidth ?? viewport.width
  const bodyHeight = el?.clientHeight ?? viewport.height
  // 滚动条总长 = 内容尺寸 + 冻结窗格尺寸；原生滚动最大值刚好把最后一格滚到底
  spacerWidth.value = Math.max(bodyWidth, viewInfo.value.contentWidth + viewInfo.value.frozenWidth)
  spacerHeight.value = Math.max(bodyHeight, viewInfo.value.contentHeight + viewInfo.value.frozenHeight)
}

/** 切换工作表：重置滚动与选区，尺寸换成新表的 */
async function selectSheet(index: number): Promise<void> {
  if (index === activeSheet.value) return
  if (editing.value) cancelEdit()
  const state = await props.adapter.setActive(index)
  if (destroyed) return
  applyState(state)
  const el = scroller.value
  if (el) {
    el.scrollTop = 0
    el.scrollLeft = 0
  }
  selection.value = { anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } }
  emit('selectSheet', index)
  await syncContent()
  scheduleDraw()
}

async function showMatch(index: number): Promise<void> {
  const match = findMatches[index]
  if (!match) return
  findIndex = index
  if (match.sheet !== activeSheet.value) {
    const state = await props.adapter.setActive(match.sheet)
    if (destroyed) return
    applyState(state)
    // 查找跨表命中时也要通知控制器，否则后续选区的锚点会标成旧工作表
    emit('selectSheet', match.sheet)
    const el = scroller.value
    if (el) {
      el.scrollTop = 0
      el.scrollLeft = 0
    }
  }
  setSelection({ anchor: { row: match.row, col: match.col }, focus: { row: match.row, col: match.col } })
}

async function find(query: string): Promise<{ query: string; total: number; index: number }> {
  if (!query) {
    clearFind()
    return { query: '', total: 0, index: -1 }
  }
  findQuery = query
  findMatches = await props.adapter.find(query)
  findIndex = findMatches.length ? 0 : -1
  if (findIndex >= 0) await showMatch(0)
  return { query: findQuery, total: findMatches.length, index: findIndex }
}

async function findStep(previous = false): Promise<{ query: string; total: number; index: number }> {
  if (!findMatches.length) return { query: findQuery, total: 0, index: -1 }
  const next = (findIndex + (previous ? -1 : 1) + findMatches.length) % findMatches.length
  await showMatch(next)
  return { query: findQuery, total: findMatches.length, index: next }
}

function clearFind(): void {
  findMatches = []
  findIndex = -1
  findQuery = ''
}

function selectAll(): void {
  const used = usedRange.value
  if (used) setSelection(xlsxSelectAll(used))
}

function focus(): void {
  root.value?.focus()
}

function getStats(): { cells: number; sheets: number; version: string } {
  const used = usedRange.value
  return {
    cells: used ? (used.bottom - used.top + 1) * (used.right - used.left + 1) : 0,
    sheets: tabs.value.length,
    version: props.adapter.version,
  }
}

function getSelection(): XlsxSelection {
  return selection.value
}

function getFindMatches(): XlsxFindMatch[] {
  return findMatches.slice()
}

function getViewport(): { scrollTop: number; scrollLeft: number } {
  return { scrollTop: scroller.value?.scrollTop ?? 0, scrollLeft: scroller.value?.scrollLeft ?? 0 }
}

/** 让指定单元格可见；grid.goto 与新标签页恢复共用 */
function reveal(row: number, col: number): void {
  setSelection({ anchor: { row, col }, focus: { row, col } })
}

/** 恢复滚动位置；选区由 Surface 的 reveal 单独恢复 */
function restoreScroll(scrollTop: number, scrollLeft: number): void {
  const el = scroller.value
  if (!el) return
  el.scrollTop = Math.max(0, scrollTop)
  el.scrollLeft = Math.max(0, scrollLeft)
  scheduleDraw()
}

function getFindState(): { query: string; total: number; index: number } {
  return { query: findQuery, total: findMatches.length, index: findIndex }
}

defineExpose({
  focus,
  selectAll,
  setSheet: selectSheet,
  find,
  findStep,
  clearFind,
  getStats,
  getSelection,
  getFindState,
  getFindMatches,
  getViewport,
  refresh,
  reveal,
  restoreScroll,
  undo,
  redo,
  startEdit,
})
</script>

<template>
  <div
    ref="root"
    class="kb-xg"
    tabindex="0"
    :aria-label="label"
    @keydown="onKeyDown"
    @copy="onCopy"
    @cut="onCut"
    @paste="onPaste"
  >
    <div class="kb-xg-formula">
      <span class="kb-xg-cellname" aria-hidden="true">{{ activeLabel }}</span>
      <input
        v-model="formulaText"
        class="kb-xg-formula-input"
        :readonly="!editable"
        aria-label="公式栏"
        spellcheck="false"
        @keydown.enter.prevent="commitFormula($event)"
        @keydown.esc.prevent="revertFormula()"
      />
      <span class="kb-xg-selected" aria-live="polite">{{ selectedSummary }}</span>
    </div>

    <div v-if="editable" class="kb-xg-tools" role="toolbar" aria-label="单元格格式">
      <button
        type="button"
        class="kb-xg-tool"
        :class="{ 'is-on': formatting?.bold }"
        data-testid="xlsx-bold"
        aria-label="加粗"
        title="加粗（Ctrl+B）"
        @click="toggleFormat('bold')"
      >
        <strong>B</strong>
      </button>
      <button
        type="button"
        class="kb-xg-tool"
        :class="{ 'is-on': formatting?.italic }"
        data-testid="xlsx-italic"
        aria-label="斜体"
        title="斜体（Ctrl+I）"
        @click="toggleFormat('italic')"
      >
        <em>I</em>
      </button>
      <button
        type="button"
        class="kb-xg-tool"
        :class="{ 'is-on': formatting?.strikethrough }"
        data-testid="xlsx-strike"
        aria-label="删除线"
        title="删除线"
        @click="toggleFormat('strikethrough')"
      >
        <s>S</s>
      </button>
      <span class="kb-xg-divider" aria-hidden="true" />
      <button
        v-for="align in alignOptions"
        :key="align"
        type="button"
        class="kb-xg-tool"
        :class="{ 'is-on': formatting?.horizontalAlignment === align }"
        :data-testid="`xlsx-align-${align}`"
        :aria-label="align === 'left' ? '左对齐' : align === 'center' ? '居中' : '右对齐'"
        @click="setAlignment(align)"
      >
        {{ align === 'left' ? '⇤' : align === 'center' ? '↔' : '⇥' }}
      </button>
      <button
        type="button"
        class="kb-xg-tool"
        :class="{ 'is-on': formatting?.textWrapping === 'wrap' }"
        data-testid="xlsx-wrap"
        aria-label="自动换行"
        title="自动换行"
        @click="toggleWrap"
      >
        ↵
      </button>
      <span class="kb-xg-divider" aria-hidden="true" />
      <select
        class="kb-xg-select"
        data-testid="xlsx-number-format"
        aria-label="数字格式"
        :value="formatting?.numberFormat ?? 'automatic'"
        @change="setNumberFormat(($event.target as HTMLSelectElement).value)"
      >
        <option value="automatic">常规</option>
        <option value="number">数字</option>
        <option value="percent">百分比</option>
        <option value="currency">货币</option>
        <option value="date">日期</option>
        <option value="time">时间</option>
        <option value="scientific">科学计数</option>
        <option value="plainText">文本</option>
        <option value="increaseDecimal">增加小数位</option>
        <option value="decreaseDecimal">减少小数位</option>
      </select>
      <span class="kb-xg-divider" aria-hidden="true" />
      <button type="button" class="kb-xg-tool" data-testid="xlsx-clear" aria-label="清除内容" @click="clearSelection">
        清除
      </button>
      <span v-if="noticeText" class="kb-xg-notice" role="status">{{ noticeText }}</span>
    </div>

    <div class="kb-xg-body" :style="{ '--kb-xg-gutter': `${gutterWidth}px`, '--kb-xg-head': `${HEADER_HEIGHT}px` }">
      <!-- 行号列标：装饰性（网格本身有 role=grid 与行列数），读屏不重复读 -->
      <div class="kb-xg-corner" aria-hidden="true" />
      <canvas ref="colHeader" class="kb-xg-colhead" aria-hidden="true" data-testid="xlsx-col-header" @pointerdown="onHeaderPointerDown('col', $event)" />
      <canvas ref="rowHeader" class="kb-xg-rowhead" aria-hidden="true" data-testid="xlsx-row-header" @pointerdown="onHeaderPointerDown('row', $event)" />
      <div ref="scroller" class="kb-xg-scroll" role="presentation" @scroll="onScroll">
        <canvas
          ref="canvas"
          class="kb-xg-canvas"
          role="grid"
          :aria-label="`${tabs[activeSheet]?.name ?? ''} 表格`"
          :aria-rowcount="usedRange ? usedRange.bottom + 1 : undefined"
          :aria-colcount="usedRange ? usedRange.right + 1 : undefined"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
          @dblclick="editable ? startEdit() : focus()"
        />
        <textarea
          v-if="editing && editRect"
          ref="editorEl"
          v-model="editDraft"
          class="kb-xg-editor"
          :style="{
            left: `${editRect.x}px`,
            top: `${editRect.y}px`,
            width: `${Math.max(40, editRect.w)}px`,
            height: `${Math.max(22, editRect.h)}px`,
          }"
          aria-label="单元格输入"
          data-testid="xlsx-cell-editor"
          spellcheck="false"
          @keydown="onEditorKeyDown"
        />
        <div
          class="kb-xg-spacer"
          :style="{ width: `${spacerWidth}px`, height: `${spacerHeight}px` }"
          aria-hidden="true"
        />
      </div>
      <div v-if="loading" class="kb-xg-loading" role="status">正在打开表格…</div>
      <div v-if="errorText" class="kb-xg-error" role="alert">{{ errorText }}</div>
    </div>

    <div class="kb-xg-tabs">
      <div class="kb-xg-tablist" role="tablist" aria-label="工作表">
        <button
          v-for="(tab, index) in tabs"
          :key="tab.id"
          class="kb-xg-tab"
          :class="{ 'is-active': index === activeSheet }"
          role="tab"
          :aria-selected="index === activeSheet"
          type="button"
          @click="selectSheet(index)"
        >
          {{ tab.name }}
        </button>
      </div>
      <span class="kb-xg-status" aria-live="polite">{{ selectedSummary }}</span>
    </div>
  </div>
</template>

<style>
/* Host 舞台是 flex item，子元素 height:100% 会解析成 auto；这里把舞台变成纵向 flex。 */
.kb-editor-stage.kb-xg-surface {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.kb-editor-stage.kb-xg-surface > .kb-xg {
  flex: 1 1 auto;
  height: auto;
  min-height: 0;
}
.kb-xg {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: var(--surface-1, #ffffff);
  color: var(--text-primary, #18181b);
  outline: none;
}
.kb-xg:focus-visible {
  box-shadow: inset 0 0 0 1px var(--accent, #5e6ad2);
}
.kb-xg-formula {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  min-height: 32px;
  padding: 0 8px;
  border-bottom: 1px solid var(--border-subtle, #ececf0);
  background: var(--surface-2, #f7f7f8);
}
.kb-xg-cellname {
  flex: 0 0 56px;
  color: var(--text-secondary, #52525b);
  font-size: calc(12px * var(--fs, 1));
  font-variant-numeric: tabular-nums;
}
.kb-xg-formula-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 24px;
  padding: 0 6px;
  border: 1px solid var(--border-default, #d4d4d8);
  border-radius: var(--r-sm, 6px);
  background: var(--surface-1, #ffffff);
  color: var(--text-primary, #18181b);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: calc(12px * var(--fs, 1));
}
.kb-xg-selected {
  flex: 0 0 auto;
  color: var(--text-secondary, #52525b);
  font-size: calc(11px * var(--fs, 1));
  font-variant-numeric: tabular-nums;
}
.kb-xg-tools {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
  min-height: 30px;
  padding: 0 8px;
  border-bottom: 1px solid var(--border-subtle, #ececf0);
  background: var(--surface-1, #ffffff);
  overflow-x: auto;
}
.kb-xg-tool {
  flex: 0 0 auto;
  min-width: 24px;
  height: 24px;
  padding: 0 5px;
  border: 1px solid transparent;
  border-radius: var(--r-sm, 6px);
  background: transparent;
  color: var(--text-primary, #18181b);
  font-size: calc(12px * var(--fs, 1));
  line-height: 1;
  cursor: pointer;
}
.kb-xg-tool:hover {
  background: var(--surface-2, #f7f7f8);
}
.kb-xg-tool.is-on {
  border-color: var(--accent, #5e6ad2);
  background: color-mix(in srgb, var(--accent, #5e6ad2) 12%, transparent);
  color: var(--accent, #5e6ad2);
}
.kb-xg-divider {
  flex: 0 0 1px;
  width: 1px;
  height: 16px;
  margin: 0 4px;
  background: var(--border-subtle, #ececf0);
}
.kb-xg-select {
  flex: 0 0 auto;
  height: 24px;
  padding: 0 4px;
  border: 1px solid var(--border-default, #d4d4d8);
  border-radius: var(--r-sm, 6px);
  background: var(--surface-1, #ffffff);
  color: var(--text-primary, #18181b);
  font-size: calc(11px * var(--fs, 1));
}
.kb-xg-notice {
  flex: 0 1 auto;
  margin-left: 6px;
  color: var(--text-secondary, #52525b);
  font-size: calc(11px * var(--fs, 1));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.kb-xg-body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
}
.kb-xg-editor {
  position: absolute;
  z-index: 2;
  padding: 1px 4px;
  border: 2px solid var(--accent, #5e6ad2);
  border-radius: 2px;
  background: var(--surface-1, #ffffff);
  color: var(--text-primary, #18181b);
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: calc(12px * var(--fs, 1));
  line-height: 1.35;
  resize: none;
  outline: none;
  box-shadow: var(--shadow-sm, 0 2px 8px rgba(0, 0, 0, 0.12));
}
.kb-xg-scroll {
  position: absolute;
  /* 让出左侧行号与顶部列标 */
  inset: var(--kb-xg-head, 20px) 0 0 var(--kb-xg-gutter, 40px);
  overflow: auto;
  overscroll-behavior: contain;
}
.kb-xg-corner,
.kb-xg-colhead,
.kb-xg-rowhead {
  position: absolute;
  display: block;
}
.kb-xg-corner {
  top: 0;
  left: 0;
  width: var(--kb-xg-gutter, 40px);
  height: var(--kb-xg-head, 20px);
  background: var(--surface-sunken);
  border-right: 1px solid var(--border-default);
  border-bottom: 1px solid var(--border-default);
  box-sizing: border-box;
}
.kb-xg-colhead {
  top: 0;
  left: var(--kb-xg-gutter, 40px);
  cursor: s-resize;
}
.kb-xg-rowhead {
  top: var(--kb-xg-head, 20px);
  left: 0;
  cursor: e-resize;
}
.kb-xg-canvas {
  position: sticky;
  top: 0;
  left: 0;
  z-index: 1;
  display: block;
  max-width: none;
  cursor: cell;
  touch-action: none;
}
.kb-xg-spacer {
  pointer-events: none;
}
.kb-xg-loading,
.kb-xg-error {
  position: absolute;
  z-index: 3;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  padding: 10px 14px;
  border: 1px solid var(--border-subtle, #ececf0);
  border-radius: var(--r-md, 8px);
  background: var(--surface-1, #ffffff);
  color: var(--text-secondary, #52525b);
  font-size: calc(12px * var(--fs, 1));
  box-shadow: var(--shadow-md, 0 8px 24px rgba(0, 0, 0, 0.12));
}
.kb-xg-error {
  color: var(--danger, #c0392b);
}
.kb-xg-tabs {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  flex: 0 0 auto;
  min-height: 32px;
  padding: 0 8px;
  border-top: 1px solid var(--border-subtle, #ececf0);
  background: var(--surface-2, #f7f7f8);
  overflow-x: auto;
}
.kb-xg-tablist {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  min-width: 0;
}
.kb-xg-tab {
  flex: 0 0 auto;
  max-width: 160px;
  /* 高度跟全站控件令牌走；触屏下由下面的 coarse 规则加高到 44px（与旧表格页签同一做法） */
  display: inline-flex;
  align-items: center;
  height: var(--ctl-h);
  padding: 0 10px;
  border: 1px solid transparent;
  border-bottom: 0;
  border-radius: var(--r-sm, 6px) var(--r-sm, 6px) 0 0;
  background: transparent;
  color: var(--text-secondary, #52525b);
  font-size: calc(12px * var(--fs, 1));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
@media (pointer: coarse) {
  /* 页签一整排紧挨着，不能靠伪元素外扩（会盖住邻居），直接加高到 44px */
  .kb-xg-tab {
    min-height: 44px;
  }
}
.kb-xg-tab:hover {
  background: var(--surface-1, #ffffff);
}
.kb-xg-tab.is-active {
  border-color: var(--border-subtle, #ececf0);
  background: var(--surface-1, #ffffff);
  color: var(--text-primary, #18181b);
}
.kb-xg-status {
  margin-left: auto;
  padding-bottom: 7px;
  color: var(--text-secondary, #52525b);
  font-size: calc(11px * var(--fs, 1));
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
@media (max-width: 640px) {
  .kb-xg-selected {
    display: none;
  }
  .kb-xg-cellname {
    flex-basis: 46px;
  }
  .kb-xg-tab {
    max-width: 110px;
  }
}
</style>
