<script setup lang="ts">
/**
 * Grid Surface 视图
 *
 * 由一个 canvas + 一条公式栏 + 一排工作表标签组成：
 * - canvas 只画可见区，滚动通过原生滚动容器驱动，scroll 回调不写响应式状态；
 * - 选区 / 编辑框 / 公式栏是 DOM，输入法、复制粘贴、无障碍都交给浏览器；
 * - 组件不碰网络和版本，编辑只 emit 语义事件，由 Surface 控制器落到 codec / engine。
 *
 * 数据源 `GridSheet` 是只读的：父组件收到 edit 后替换 sheet，本组件不深拷贝整张表。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { HEADER_HEIGHT, HEADER_WIDTH, GridGeometry } from './geometry'
import { columnLabel, paintGrid, type GridPalette } from './painter'
import { parseClipboard, pasteMatrix, serializeHtml, serializeTsv } from './clipboard'
import { expandMerged, moveSelection, normalizeRange, resolveGridKey, selectAll, selectColumn, selectRow } from './selection'
import type { CellCoord, GridEdit, GridKeyAction, GridSelection, GridSheet, GridViewport } from './types'

const props = withDefaults(
  defineProps<{
    sheet: GridSheet
    /** 工作表标签；只有一张时可以不传 */
    sheets?: readonly { name: string }[]
    activeSheet?: number
    readonly?: boolean
    /** 画布的无障碍名称 */
    label?: string
    /** 数据源是可变对象时用它触发重绘（sheet 身份不变） */
    revision?: number
    /** 只有格子内容变了（分页表读进来一页）：重画就行，不用重建几何、不动选区与查找结果 */
    dataTick?: number
    /** 底部状态栏的补充说明（编码 / 读取进度 / 改动摘要） */
    note?: string
    /** 数据源支持插入 / 删除行：打开行右键菜单 */
    rowOps?: boolean
  }>(),
  { sheets: () => [], activeSheet: 0, readonly: false, label: '表格', revision: 0, dataTick: 0, note: '', rowOps: false },
)

const emit = defineEmits<{
  edit: [edits: GridEdit[]]
  /** 视口滚到了 [firstRow, lastRow)：分页数据源据此按需取页 */
  visible: [range: { firstRow: number; lastRow: number }]
  /** 右键菜单里选了行操作 */
  rowAction: [action: 'insertAbove' | 'insertBelow' | 'delete']
  selection: [payload: { row: number; col: number; text: string; range: { top: number; left: number; bottom: number; right: number } }]
  selectSheet: [index: number]
  findRequest: []
  undo: []
  redo: []
}>()

const root = ref<HTMLElement | null>(null)
const bodyEl = ref<HTMLElement | null>(null)
const scroller = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const editorInput = ref<HTMLTextAreaElement | null>(null)

/** 只读开关可由命令层随时切换，不重建组件 */
const localReadonly = ref(props.readonly)
watch(
  () => props.readonly,
  (value) => (localReadonly.value = value),
)

/** 选区是组件里唯一需要响应式的网格状态（很小，不涉及单元格数据） */
const selection = ref<GridSelection>({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } })
const formulaText = ref('')
const editing = ref(false)
const editingCell = ref<CellCoord | null>(null)
const editText = ref('')
const findQuery = ref('')
const findMatches = ref<CellCoord[]>([])
const findIndex = ref(-1)
/** 编辑框在滚动后要重新定位；只在编辑时递增，平时不触发重渲染 */
const editTick = ref(0)
const viewWidth = ref(0)
const viewHeight = ref(0)
const spacerWidth = ref(0)
const spacerHeight = ref(0)

/** 滚动位置刻意放在普通对象里：每帧只重绘 canvas，不触发 Vue patch */
let viewport: GridViewport = { scrollTop: 0, scrollLeft: 0, width: 0, height: 0 }
let geometry = new GridGeometry({ rowCount: 0, colCount: 0 })
let raf = 0
/** 上一次通知过的可见行区间：没变就不重复通知 */
let lastVisible: { firstRow: number; lastRow: number } | null = null
let dragPointer: number | null = null
let destroyed = false
let palette: GridPalette = {
  background: '#ffffff',
  text: '#18181b',
  gridline: 'rgba(0,0,0,.08)',
  headerBackground: '#f5f5f6',
  headerText: '#52525b',
  selectionFill: 'rgba(79,70,229,.12)',
  selectionBorder: '#4f46e5',
  activeBorder: '#4f46e5',
}

const activeCell = computed(() => selection.value.focus)
const activeLabel = computed(() => `${columnLabel(activeCell.value.col)}${activeCell.value.row + 1}`)
const tabs = computed(() => (props.sheets.length ? props.sheets : [{ name: props.sheet.name }]))
const selectedSummary = computed(() => {
  const range = normalizeRange(selection.value, bounds())
  const rows = range.bottom - range.top + 1
  const cols = range.right - range.left + 1
  return rows === 1 && cols === 1 ? activeLabel.value : `${rows} 行 × ${cols} 列`
})
const canvasStyle = computed(() => ({ width: `${viewWidth.value}px`, height: `${viewHeight.value}px`, marginTop: `-${viewHeight.value}px` }))
const editorStyle = computed(() => {
  // 依赖 editTick：滚动时编辑框跟着单元格走，但平时不因滚动重渲染整个模板
  void editTick.value
  const cell = editingCell.value
  if (!cell) return {}
  const rect = geometry.cellRect(cell.row, cell.col)
  return {
    left: `${rect.x - viewport.scrollLeft + HEADER_WIDTH}px`,
    top: `${rect.y - viewport.scrollTop + HEADER_HEIGHT}px`,
    width: `${Math.max(80, rect.width)}px`,
    height: `${Math.max(22, rect.height)}px`,
  }
})

function bounds() {
  return { rowCount: props.sheet.rowCount, colCount: props.sheet.colCount }
}

function readPalette(): GridPalette {
  const style = getComputedStyle(document.documentElement)
  const pick = (name: string, fallback: string) => {
    const value = style.getPropertyValue(name).trim()
    // color-mix / var 在 canvas 里不一定能解析，拿不到确定的颜色就用兜底
    return value && !value.includes('var(') && !value.includes('color-mix(') ? value : fallback
  }
  return {
    background: pick('--surface-1', '#ffffff'),
    text: pick('--text-primary', '#18181b'),
    gridline: pick('--border-subtle', 'rgba(0,0,0,.08)'),
    headerBackground: pick('--surface-2', '#f5f5f6'),
    headerText: pick('--text-secondary', '#52525b'),
    selectionFill: 'rgba(79,70,229,.13)',
    selectionBorder: pick('--accent', '#4f46e5'),
    activeBorder: pick('--accent', '#4f46e5'),
  }
}

function rebuild() {
  const sheet = props.sheet
  geometry = new GridGeometry({
    rowCount: sheet.rowCount,
    colCount: sheet.colCount,
    rowHeight: sheet.rowHeight ? (row) => sheet.rowHeight?.(row) : undefined,
    colWidth: sheet.columnWidth ? (col) => sheet.columnWidth?.(col) : undefined,
  })
  spacerWidth.value = geometry.contentWidth + HEADER_WIDTH
  spacerHeight.value = geometry.contentHeight + HEADER_HEIGHT
  const maxRow = Math.max(0, sheet.rowCount - 1)
  const maxCol = Math.max(0, sheet.colCount - 1)
  const top = Math.min(Math.max(0, selection.value.focus.row), maxRow)
  const left = Math.min(Math.max(0, selection.value.focus.col), maxCol)
  selection.value = { anchor: { row: top, col: left }, focus: { row: top, col: left } }
  findMatches.value = []
  findIndex.value = -1
  // 数据源换了一版（保存后重读、撤销…）：可见区间不变也要让它重新判断要不要取页
  lastVisible = null
  syncFormula()
  scheduleDraw()
}

function syncFormula() {
  const { row, col } = selection.value.focus
  const cell = props.sheet.cell(row, col)
  formulaText.value = cell?.raw ?? cell?.text ?? ''
}

function emitSelection() {
  const range = normalizeRange(selection.value, bounds())
  const cell = props.sheet.cell(selection.value.focus.row, selection.value.focus.col)
  emit('selection', { row: selection.value.focus.row, col: selection.value.focus.col, text: cell?.text ?? '', range })
}

function setSelection(next: GridSelection, redraw = true) {
  const b = bounds()
  if (b.rowCount <= 0 || b.colCount <= 0) return
  const row = Math.min(Math.max(0, next.focus.row), b.rowCount - 1)
  const col = Math.min(Math.max(0, next.focus.col), b.colCount - 1)
  const merged = expandMerged({ row, col }, props.sheet.mergedRanges?.())
  if (merged && !editing.value) {
    selection.value = { anchor: { row: merged.top, col: merged.left }, focus: { row: merged.bottom, col: merged.right } }
  } else {
    selection.value = { anchor: { ...next.anchor }, focus: { row, col } }
  }
  syncFormula()
  emitSelection()
  if (redraw) {
    scrollActiveIntoView()
    scheduleDraw()
  }
}

function scrollActiveIntoView() {
  const el = scroller.value
  if (!el) return
  // 隐藏/首帧尺寸为 0 时不要滚动：否则会把 scrollLeft 推到很远，等真正显示时选区跑到屏幕外
  if (el.clientWidth <= HEADER_WIDTH || el.clientHeight <= HEADER_HEIGHT) return
  const contentW = el.clientWidth - HEADER_WIDTH
  const contentH = el.clientHeight - HEADER_HEIGHT
  const target = geometry.scrollToCell(selection.value.focus.row, selection.value.focus.col, {
    scrollTop: el.scrollTop,
    scrollLeft: el.scrollLeft,
    width: contentW,
    height: contentH,
  })
  if (target.scrollTop !== el.scrollTop) el.scrollTop = target.scrollTop
  if (target.scrollLeft !== el.scrollLeft) el.scrollLeft = target.scrollLeft
  viewport = { ...viewport, ...target }
}

function paint() {
  const el = canvas.value
  const host = scroller.value
  if (!el || !host || destroyed) return
  const dpr = window.devicePixelRatio || 1
  const width = host.clientWidth
  const height = host.clientHeight
  if (width <= 0 || height <= 0) return
  viewWidth.value = width
  viewHeight.value = height
  const bufferWidth = Math.max(1, Math.round(width * dpr))
  const bufferHeight = Math.max(1, Math.round(height * dpr))
  if (el.width !== bufferWidth) el.width = bufferWidth
  if (el.height !== bufferHeight) el.height = bufferHeight
  const ctx = el.getContext('2d')
  if (!ctx) return
  viewport = { ...viewport, width, height }
  const shown = geometry.visibleRange({ scrollTop: viewport.scrollTop, scrollLeft: viewport.scrollLeft, width: Math.max(0, width - HEADER_WIDTH), height: Math.max(0, height - HEADER_HEIGHT) }, 0)
  if (!lastVisible || lastVisible.firstRow !== shown.firstRow || lastVisible.lastRow !== shown.lastRow) {
    lastVisible = { firstRow: shown.firstRow, lastRow: shown.lastRow }
    emit('visible', lastVisible)
  }
  paintGrid({
    ctx,
    geometry,
    sheet: props.sheet,
    viewport,
    selection: selection.value,
    palette,
    dpr,
    highlights: findMatches.value.map(({ row, col }) => ({ top: row, left: col, bottom: row, right: col })),
  })
}

function scheduleDraw() {
  if (raf) return
  const run = () => {
    raf = 0
    paint()
  }
  raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : (setTimeout(run, 16) as unknown as number)
}

function onScroll() {
  const el = scroller.value
  if (!el) return
  viewport = { ...viewport, scrollTop: el.scrollTop, scrollLeft: el.scrollLeft }
  if (editing.value) editTick.value += 1
  scheduleDraw()
}

function onResize() {
  const host = scroller.value
  if (!host) return
  viewport = { ...viewport, width: host.clientWidth, height: host.clientHeight }
  scheduleDraw()
}

function contentPoint(event: PointerEvent | MouseEvent): { x: number; y: number } {
  const el = canvas.value
  const rect = el?.getBoundingClientRect()
  return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
}

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0) return
  root.value?.focus()
  const point = contentPoint(event)
  const el = scroller.value
  if (!el) return
  if (point.x < HEADER_WIDTH && point.y < HEADER_HEIGHT) {
    setSelection(selectAll(bounds()))
    return
  }
  const contentY = point.y - HEADER_HEIGHT + el.scrollTop
  const contentX = point.x - HEADER_WIDTH + el.scrollLeft
  if (point.x < HEADER_WIDTH) {
    const row = geometry.rowAtY(contentY)
    if (row >= 0) setSelection(selectRow(row, bounds().colCount))
    return
  }
  if (point.y < HEADER_HEIGHT) {
    const col = geometry.colAtX(contentX)
    if (col >= 0) setSelection(selectColumn(col, bounds().rowCount))
    return
  }
  const hit = geometry.hitTest(contentX, contentY)
  if (!hit) return
  setSelection({ anchor: hit, focus: hit })
  dragPointer = event.pointerId
  canvas.value?.setPointerCapture?.(event.pointerId)
}

function onPointerMove(event: PointerEvent) {
  if (dragPointer === null || event.pointerId !== dragPointer) return
  const point = contentPoint(event)
  const el = scroller.value
  if (!el) return
  const contentY = point.y - HEADER_HEIGHT + el.scrollTop
  const contentX = point.x - HEADER_WIDTH + el.scrollLeft
  const hit = geometry.hitTest(Math.max(0, contentX), Math.max(0, contentY))
  if (!hit) return
  setSelection({ anchor: selection.value.anchor, focus: hit }, false)
}

function onPointerUp(event: PointerEvent) {
  if (dragPointer !== null) {
    canvas.value?.releasePointerCapture?.(event.pointerId)
    dragPointer = null
    scheduleDraw()
  }
}

function onDoubleClick(event: MouseEvent) {
  const point = contentPoint(event)
  if (point.x < HEADER_WIDTH || point.y < HEADER_HEIGHT) return
  // 真实鼠标的 pointerdown 已经负责选中；这里只开编辑框，避免双击时二次改选区
  openEditor()
}

function moveBy(action: Extract<GridKeyAction, { kind: 'move' | 'page' }>) {
  const pageSize = Math.max(1, Math.floor((viewHeight.value - HEADER_HEIGHT) / 24) - 1)
  const next = moveSelection(selection.value, action, { bounds: bounds(), pageSize, mergedRanges: props.sheet.mergedRanges?.() })
  setSelection(next)
}

function selectedMatrix(): string[][] {
  const range = normalizeRange(selection.value, bounds())
  const rows: string[][] = []
  for (let row = range.top; row <= range.bottom; row += 1) {
    const values: string[] = []
    for (let col = range.left; col <= range.right; col += 1) values.push(props.sheet.cell(row, col)?.text ?? '')
    rows.push(values)
  }
  return rows
}

function clearSelection() {
  const range = normalizeRange(selection.value, bounds())
  const edits: GridEdit[] = []
  for (let row = range.top; row <= range.bottom; row += 1) {
    for (let col = range.left; col <= range.right; col += 1) {
      // 已经是空的格子清空没有意义；整表全选清空时也不会为百万个空格子造出同样多的编辑对象
      if (props.sheet.cell(row, col)?.text) edits.push({ row, col, text: '' })
    }
  }
  if (edits.length) emit('edit', edits)
}

async function copySelection(cut: boolean) {
  const tsv = serializeTsv(selectedMatrix())
  try {
    await navigator.clipboard?.writeText(tsv)
  } catch {
    // 无剪贴板权限（http / 测试）时退回浏览器 copy 事件；copy 事件里会再写一次
  }
  if (cut) clearSelection()
}

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard?.readText()
    if (text) applyPaste(text)
  } catch {
    // 没权限时等用户按 Ctrl+V，让 paste 事件带数据来
  }
}

function applyPaste(text: string, html = '') {
  const matrix = parseClipboard(text, html)
  if (!matrix.length) return
  const cells = pasteMatrix(matrix, selection.value.focus).filter((cell) => cell.row < props.sheet.rowCount && cell.col < props.sheet.colCount)
  if (cells.length) emit('edit', cells)
}

function onCopyEvent(event: ClipboardEvent) {
  const matrix = selectedMatrix()
  event.clipboardData?.setData('text/plain', serializeTsv(matrix))
  event.clipboardData?.setData('text/html', serializeHtml(matrix))
  event.preventDefault()
}

function onPasteEvent(event: ClipboardEvent) {
  applyPaste(event.clipboardData?.getData('text/plain') ?? '', event.clipboardData?.getData('text/html') ?? '')
  event.preventDefault()
}

function onKeyDown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null
  if (target?.closest('input, textarea')) return
  if (editing.value) return
  const action = resolveGridKey(event)
  if (!action) return
  event.preventDefault()
  if (action.kind === 'move' || action.kind === 'page') {
    moveBy(action)
    return
  }
  if (action.kind === 'edit') {
    openEditor(event.key.length === 1 ? event.key : undefined)
    return
  }
  if (action.kind === 'clear') {
    clearSelection()
    return
  }
  if (action.kind === 'copy') {
    void copySelection(false)
    return
  }
  if (action.kind === 'cut') {
    void copySelection(true)
    return
  }
  if (action.kind === 'paste') {
    void pasteFromClipboard()
    return
  }
  if (action.kind === 'selectAll') {
    setSelection(selectAll(bounds()))
    return
  }
  if (action.kind === 'find') {
    emit('findRequest')
    return
  }
  if (action.kind === 'undo') {
    emit('undo')
    return
  }
  if (action.kind === 'redo') {
    emit('redo')
  }
}

function openEditor(seed?: string) {
  if (localReadonly.value || props.sheet.rowCount === 0) return
  const cell = selection.value.focus
  editingCell.value = { ...cell }
  const current = props.sheet.cell(cell.row, cell.col)
  editText.value = seed ?? current?.raw ?? current?.text ?? ''
  editing.value = true
  editTick.value += 1
  void nextTick(() => {
    editorInput.value?.focus()
    if (seed) editorInput.value?.setSelectionRange(seed.length, seed.length)
  })
}

function closeEditor() {
  editing.value = false
  editingCell.value = null
  editText.value = ''
  root.value?.focus()
}

function commitEditor(move: 'down' | 'right' | 'none') {
  const cell = editingCell.value
  if (!cell) return
  const value = editText.value
  const current = props.sheet.cell(cell.row, cell.col)
  const before = current?.raw ?? current?.text ?? ''
  closeEditor()
  if (value !== before) emit('edit', [{ ...cell, text: value }])
  if (move === 'down') moveBy({ kind: 'move', rowDelta: 1, colDelta: 0, extend: false, jump: false })
  else if (move === 'right') moveBy({ kind: 'move', rowDelta: 0, colDelta: 1, extend: false, jump: false })
}

function onEditorKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeEditor()
    return
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    commitEditor('down')
    return
  }
  if (event.key === 'Tab') {
    event.preventDefault()
    commitEditor('right')
  }
}

function commitFormula() {
  if (localReadonly.value) return
  const cell = selection.value.focus
  const current = props.sheet.cell(cell.row, cell.col)
  const before = current?.raw ?? current?.text ?? ''
  if (formulaText.value !== before) emit('edit', [{ ...cell, text: formulaText.value }])
  else syncFormula()
}

function onFormulaKeyDown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    event.preventDefault()
    commitFormula()
    root.value?.focus()
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    syncFormula()
    root.value?.focus()
  }
}

/** 查找：跨整张表按行优先扫描，最多 1000 条，避免大表在输入时卡住 */
function find(query: string): { total: number; index: number } {
  findQuery.value = query
  if (!query) {
    findMatches.value = []
    findIndex.value = -1
    scheduleDraw()
    return { total: 0, index: -1 }
  }
  const needle = query.toLocaleLowerCase()
  const matches: CellCoord[] = []
  // 分页表只扫已读入的行（scanRanges）；其余数据源扫全表
  const ranges = props.sheet.scanRanges?.() ?? [[0, props.sheet.rowCount] as const]
  scan: for (const [start, end] of ranges) {
    for (let row = start; row < Math.min(end, props.sheet.rowCount); row += 1) {
      for (let col = 0; col < props.sheet.colCount; col += 1) {
        const text = props.sheet.cell(row, col)?.text
        if (text && text.toLocaleLowerCase().includes(needle)) matches.push({ row, col })
        if (matches.length >= 1000) break scan
      }
    }
  }
  findMatches.value = matches
  findIndex.value = matches.length ? 0 : -1
  if (matches.length) {
    const hit = matches[0]!
    setSelection({ anchor: hit, focus: hit })
  }
  scheduleDraw()
  return { total: matches.length, index: findIndex.value }
}

function findStep(previous = false): { total: number; index: number } {
  if (!findMatches.value.length) return { total: 0, index: -1 }
  const delta = previous ? -1 : 1
  findIndex.value = (findIndex.value + delta + findMatches.value.length) % findMatches.value.length
  const hit = findMatches.value[findIndex.value]!
  setSelection({ anchor: hit, focus: hit })
  return { total: findMatches.value.length, index: findIndex.value }
}

function clearFind() {
  findQuery.value = ''
  findMatches.value = []
  findIndex.value = -1
  scheduleDraw()
}

function focus() {
  root.value?.focus()
}

function getSelection() {
  return { ...selection.value, anchor: { ...selection.value.anchor }, focus: { ...selection.value.focus } }
}

function reveal(row: number, col: number) {
  setSelection({ anchor: { row, col }, focus: { row, col } })
}

function getViewport() {
  return { ...viewport }
}

function setReadonly(value: boolean) {
  localReadonly.value = value
  if (value) closeEditor()
}

function selectAllCells() {
  setSelection(selectAll(bounds()))
}

/* ---------------- 行右键菜单（插入 / 删除行） ---------------- */

const menu = ref<{ x: number; y: number } | null>(null)
const menuFirst = ref<HTMLButtonElement | null>(null)

function closeMenu() {
  menu.value = null
}

function onContextMenu(event: MouseEvent) {
  // 数据源不支持行操作、或只读：不接管，让浏览器自己的菜单出来
  if (!props.rowOps || localReadonly.value) return
  const el = scroller.value
  const body = bodyEl.value
  if (!el || !body) return
  const point = contentPoint(event)
  if (point.y < HEADER_HEIGHT) return
  event.preventDefault()
  const row = geometry.rowAtY(point.y - HEADER_HEIGHT + el.scrollTop)
  if (row >= 0) {
    const range = normalizeRange(selection.value, bounds())
    // 在选区之外右击：先选中被点的行（行头选整行，格子选这一格），菜单操作的就是它
    if (row < range.top || row > range.bottom) {
      if (point.x < HEADER_WIDTH) setSelection(selectRow(row, bounds().colCount))
      else {
        const col = Math.max(0, geometry.colAtX(point.x - HEADER_WIDTH + el.scrollLeft))
        setSelection({ anchor: { row, col }, focus: { row, col } })
      }
    }
  }
  const box = body.getBoundingClientRect()
  // 菜单约 168×112：贴边时往里收一点，别被裁掉
  menu.value = { x: Math.min(event.clientX - box.left, Math.max(0, box.width - 176)), y: Math.min(event.clientY - box.top, Math.max(0, box.height - 120)) }
  void nextTick(() => menuFirst.value?.focus())
}

function runRowAction(action: 'insertAbove' | 'insertBelow' | 'delete') {
  closeMenu()
  emit('rowAction', action)
  root.value?.focus()
}

function onMenuKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape' || event.key === 'Tab') {
    event.preventDefault()
    closeMenu()
    root.value?.focus()
    return
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  const items = [...((event.currentTarget as HTMLElement).querySelectorAll('button') as NodeListOf<HTMLButtonElement>)]
  const at = items.indexOf(document.activeElement as HTMLButtonElement)
  items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
}

function onDocumentPointerDown(event: PointerEvent) {
  if (!menu.value) return
  if (event.target instanceof Element && event.target.closest('.kb-gs-menu')) return
  closeMenu()
}

watch(
  () => props.dataTick,
  () => {
    // 分页表读进来一页：当前格的公式栏内容可能刚好是这页的，重取；其余只重画
    syncFormula()
    scheduleDraw()
  },
)

defineExpose({
  focus,
  getSelection,
  setSelection,
  selectAll: selectAllCells,
  reveal,
  getViewport,
  setReadonly,
  find,
  findStep,
  clearFind,
  getFindState: () => ({ query: findQuery.value, total: findMatches.value.length, index: findIndex.value }),
  openEditor,
  contentPoint,
})

// 首帧前先填公式栏，避免挂载后第一帧闪一下空值
syncFormula()

let resizeObserver: ResizeObserver | null = null
let themeObserver: MutationObserver | null = null
onMounted(() => {
  palette = readPalette()
  rebuild()
  resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null
  if (scroller.value && resizeObserver) resizeObserver.observe(scroller.value)
  window.addEventListener('resize', onResize)
  document.addEventListener('pointerdown', onDocumentPointerDown)
  themeObserver = typeof MutationObserver === 'function' ? new MutationObserver(() => {
    palette = readPalette()
    scheduleDraw()
  }) : null
  themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-tone', 'data-theme', 'data-accent'] })
  onResize()
})

onBeforeUnmount(() => {
  destroyed = true
  if (raf) cancelAnimationFrame(raf)
  resizeObserver?.disconnect()
  themeObserver?.disconnect()
  window.removeEventListener('resize', onResize)
  document.removeEventListener('pointerdown', onDocumentPointerDown)
})

watch(
  [() => props.sheet, () => props.revision],
  () => rebuild(),
)
</script>

<template>
  <div ref="root" class="kb-gs" :class="{ 'is-readonly': localReadonly }" tabindex="0" :aria-label="label" @keydown="onKeyDown">
    <div class="kb-gs-formula">
      <span class="kb-gs-cellname" aria-hidden="true">{{ activeLabel }}</span>
      <input
        v-model="formulaText"
        class="kb-gs-formula-input"
        :readonly="localReadonly"
        aria-label="公式栏"
        spellcheck="false"
        @keydown="onFormulaKeyDown"
      />
      <span class="kb-gs-selected" aria-live="polite">{{ selectedSummary }}</span>
    </div>

    <div ref="bodyEl" class="kb-gs-body">
      <div ref="scroller" class="kb-gs-scroll" role="presentation" @scroll="onScroll">
        <canvas
          ref="canvas"
          class="kb-gs-canvas"
          :style="canvasStyle"
          role="grid"
          :aria-label="label"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
          @dblclick="onDoubleClick"
          @contextmenu="onContextMenu"
          @copy="onCopyEvent"
          @cut="onCopyEvent"
          @paste="onPasteEvent"
        />
        <div class="kb-gs-spacer" :style="{ width: `${spacerWidth}px`, height: `${spacerHeight}px` }" aria-hidden="true" />
      </div>
      <div v-if="menu" class="kb-gs-menu" role="menu" aria-label="行操作" data-testid="grid-row-menu" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }" @keydown="onMenuKeyDown">
        <button ref="menuFirst" type="button" role="menuitem" class="kb-gs-menuitem" data-action="row.insertAbove" @click="runRowAction('insertAbove')">在上方插入行</button>
        <button type="button" role="menuitem" class="kb-gs-menuitem" data-action="row.insertBelow" @click="runRowAction('insertBelow')">在下方插入行</button>
        <button type="button" role="menuitem" class="kb-gs-menuitem is-danger" data-action="row.delete" @click="runRowAction('delete')">删除选中的行</button>
      </div>
      <textarea
        v-if="editing"
        ref="editorInput"
        v-model="editText"
        class="kb-gs-editor"
        :style="editorStyle"
        :readonly="localReadonly"
        aria-label="单元格编辑"
        spellcheck="false"
        @keydown="onEditorKeyDown"
        @blur="commitEditor('none')"
      />
    </div>

    <div class="kb-gs-tabs">
      <div class="kb-gs-tablist" role="tablist" aria-label="工作表">
        <button
          v-for="(tab, index) in tabs"
          :key="`${tab.name}-${index}`"
          class="kb-gs-tab"
          :class="{ 'is-active': index === activeSheet }"
          role="tab"
          :aria-selected="index === activeSheet"
          type="button"
          @click="emit('selectSheet', index)"
        >
          {{ tab.name }}
        </button>
      </div>
      <span v-if="note" class="kb-gs-note" data-testid="grid-note" :title="note">{{ note }}</span>
      <span class="kb-gs-status" aria-live="polite">{{ selectedSummary }}</span>
    </div>
  </div>
</template>

<style>
/* Host 的舞台高度是 flex 分配出来的（height:auto），子元素再写 height:100% 会解析成 auto；
   网格自己把舞台变成纵向 flex，让画布区拿到确定高度。 */
.kb-editor-stage.kb-gs-surface {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.kb-editor-stage.kb-gs-surface > .kb-gs {
  flex: 1 1 auto;
  height: auto;
  min-height: 0;
}
.kb-gs {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: var(--surface-1);
  color: var(--text-primary);
  outline: none;
}
.kb-gs:focus-visible {
  box-shadow: inset 0 0 0 1px var(--accent);
}
.kb-gs-formula {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  min-height: 32px;
  padding: 0 8px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--surface-2);
}
.kb-gs-cellname {
  flex: 0 0 56px;
  color: var(--text-secondary);
  font-size: calc(12px * var(--fs));
  font-variant-numeric: tabular-nums;
}
.kb-gs-formula-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 24px;
  padding: 0 6px;
  border: 1px solid var(--border-default);
  border-radius: var(--r-sm, 6px);
  background: var(--surface-1);
  color: var(--text-primary);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: calc(12px * var(--fs));
}
.kb-gs-selected {
  flex: 0 0 auto;
  color: var(--text-tertiary);
  font-size: calc(11px * var(--fs));
  font-variant-numeric: tabular-nums;
}
.kb-gs-body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
}
.kb-gs-scroll {
  position: absolute;
  inset: 0;
  overflow: auto;
  overscroll-behavior: contain;
}
.kb-gs-canvas {
  position: sticky;
  top: 0;
  left: 0;
  z-index: 1;
  display: block;
  max-width: none;
  touch-action: none;
}
.kb-gs-spacer {
  pointer-events: none;
}
.kb-gs-editor {
  position: absolute;
  z-index: 5;
  margin: 0;
  padding: 2px 4px;
  border: 2px solid var(--accent);
  border-radius: 0;
  outline: none;
  resize: none;
  overflow: hidden;
  background: var(--surface-1);
  color: var(--text-primary);
  font: inherit;
  font-size: calc(12px * var(--fs));
  line-height: 1.4;
  box-shadow: var(--shadow-sm, 0 1px 2px rgb(0 0 0 / 18%));
}
.kb-gs-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  min-height: 30px;
  padding: 0 8px;
  border-top: 1px solid var(--border-subtle);
  background: var(--surface-2);
}
.kb-gs-tablist {
  display: flex;
  align-items: center;
  gap: 4px;
}
.kb-gs-tab {
  height: 22px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: var(--r-sm, 6px);
  background: transparent;
  color: var(--text-secondary);
  font-size: calc(12px * var(--fs));
  cursor: pointer;
}
.kb-gs-tab:hover {
  background: var(--surface-3);
}
.kb-gs-tab.is-active {
  border-color: var(--border-default);
  background: var(--surface-1);
  color: var(--text-primary);
}
.kb-gs-note {
  flex: 1 1 auto;
  min-width: 0;
  margin-left: 12px;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: calc(11px * var(--fs));
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-gs-menu {
  position: absolute;
  z-index: 8;
  display: flex;
  flex-direction: column;
  min-width: 164px;
  padding: 4px;
  border: var(--hl) solid var(--border-default);
  border-radius: var(--r2);
  background: var(--surface-3);
  box-shadow: var(--sh3);
}
.kb-gs-menuitem {
  padding: 6px 10px;
  border: 0;
  border-radius: var(--r1);
  background: transparent;
  color: var(--text-primary);
  font-size: calc(13px * var(--fs));
  text-align: left;
  cursor: pointer;
}
.kb-gs-menuitem:hover,
.kb-gs-menuitem:focus-visible {
  background: var(--accent-soft);
  outline: none;
}
.kb-gs-menuitem.is-danger {
  color: var(--status-danger-text);
}
.kb-gs-status {
  margin-left: auto;
  color: var(--text-tertiary);
  font-size: calc(11px * var(--fs));
  font-variant-numeric: tabular-nums;
}
@media (max-width: 640px) {
  .kb-gs-selected {
    display: none;
  }
  .kb-gs-cellname {
    flex-basis: 44px;
  }
}
</style>
