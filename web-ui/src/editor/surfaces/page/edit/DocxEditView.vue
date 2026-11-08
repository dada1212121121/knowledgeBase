<script setup lang="ts">
/**
 * Word 画布编辑视图
 *
 * 引擎在 Worker 里排版并把每页像素画进传来的画布；这里只做五件事：
 * 1. 摆页面：按引擎给的页几何放一个白底 div，视口附近几页把画布挂进去（页窗口，长文档不常驻几十张大画布）；
 * 2. 画光标 / 选区：用引擎帧里的几何，不依赖浏览器原生选区；
 * 3. 隐藏 textarea 承接键盘与输入法（`attachDocxInput`，1:1 移植上游），输入框跟着光标走；
 * 4. 鼠标 / 触屏手势（`PagePointerController`）；
 * 5. 缩放：CSS transform 缩放页面列，同时按 `设备像素比 × 缩放` 让引擎重新出图，保证放大后文字不糊。
 *
 * 6. 页缩略图栏（补全）：引擎位图（独立只读光栅会话，见 thumbs/canvasThumbSource.ts），与滚动同步；
 *    缩放前后停在同一页同一处；编辑后节流失效、只重画改动页之后的缩略图。
 *
 * 结构与上游 `PeerlessPagedEditor.tsx` 对应（Apache-2.0，见 NOTICE），改成 Vue；状态机都在 engines/docx/vendor 里。
 * 工具栏、命令、保存、协同在别处（Surface / commands），本组件只管「画」和「输入」。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, shallowRef, watch } from 'vue'
import { KbIcon } from '@kb-ui/index'
import ViewerToolbar from '@/components/ViewerToolbar.vue'
import {
  createDocxPageQueries,
  docxQueryEngineReady,
  loadDocxQueryEngine,
  provisionalTextHitAtPoint,
  readDocxText,
  type DocxCollabHandle,
  type DocxEditEngine,
} from '../../../engines/docx'
import { admitInputIntents } from '../../../engines/docx/vendor/inputAdmission'
import type { PictureResizeHandle } from '../../../engines/docx/vendor/pictureResize'
import { shortcutCommand } from '../commands/shortcuts'
import RemotePresence from './RemotePresence.vue'
import { geometryMatchesDocument } from '../../../engines/docx/vendor/viewStore'
import type { PeerlessCompositionState } from '../../../engines/docx/vendor/composition'
import { attachDocxInput, type DocxInputHandle } from '../input/attachDocxInput'
import { PagePointerController, type PageGeometry, type PointerHost, type PointerUiState } from '../input/pointer'
import { findVerticalScrollParentOrRoot, viewportColumnBand } from '../input/viewport'
import type { CanvasStore } from './canvasStore'
import { nextPageWindow, pageAtViewport, SMALL_DOCUMENT_PAGES, visiblePageRange, type PageWindowRange } from './pageWindow'
import PageThumbnails from '../thumbs/PageThumbnails.vue'
import { createCanvasThumbSource, type CanvasThumbSource } from '../thumbs/canvasThumbSource'
import { captureAnchor, referenceLine, scrollTopForAnchor, type PageBox, type ReadingAnchor, type ReadingStart } from '../thumbs/scrollSync'
import { COMPACT_BELOW } from '../thumbs/types'

const props = withDefaults(
  defineProps<{
    engine: DocxEditEngine
    canvases: CanvasStore
    /** 打开时的缩放；之后由本组件维护并通过 `zoom` 事件上报 */
    initialZoom?: number
    readOnly?: boolean
    autoFocus?: boolean
    /** 执行一条 `docx.*` 命令（快捷键用）；返回前不阻塞输入 */
    runCommand?: (type: string, args?: unknown) => Promise<unknown>
    /** 已加入的协同房间：有就画别人的光标，并广播我的光标 */
    collab?: DocxCollabHandle | null
    /** 查找命中的高亮块（页内坐标）；当前命中 `current` 画得更醒目 */
    findRects?: ReadonlyArray<{ pageId: string; pageIndex: number; x: number; y: number; width: number; height: number; current: boolean }>
    /** 字体缺失提示：非空就在文档上方显示一条；用户可关掉。缺字体会让换行和分页与 Word 不同，必须明说，不能静默替换 */
    fontNotice?: string
    /** 缩略图栏：true / false = 用户选定；null = 默认收起（编辑时缩略图要另开一个引擎会话，用户需要才打开） */
    thumbs?: boolean | null
    /** 给缩略图的光栅会话取当前文档的字节快照；缺省 `engine.save`。只读查看传原件字节，就不会为缩略图去保存 */
    thumbSnapshot?: () => Promise<Uint8Array>
  }>(),
  { initialZoom: 1, readOnly: false, autoFocus: true, runCommand: undefined, collab: null, findRects: () => [], fontNotice: '', thumbs: null, thumbSnapshot: undefined },
)
const emit = defineEmits<{
  zoom: [scale: number]
  pageChange: [page: number, pages: number]
  /** 第一帧几何到达（页数已知；首帧为了快只排前几页，页数可能还是估的） */
  ready: []
  /** 整篇排版完成（页数是最终的）：切换版式后恢复阅读位置要等它，否则会夹到"前三页"里 */
  layoutReady: []
  recoverableText: [text: string]
  /** 用户关掉了字体提示 */
  dismissFontNotice: []
  /** 缩略图栏开关变了（含容器宽度变化带来的默认值变化）：外壳据此刷新工具栏高亮 */
  thumbs: [open: boolean]
}>()

const binding = props.engine.binding
/** 选中图片的八个缩放手柄（位置是相对图片框的比例；来自上游 PeerlessPagedEditor） */
const PICTURE_HANDLES: ReadonlyArray<{ handle: PictureResizeHandle; x: number; y: number; cursor: string }> = [
  { handle: 'nw', x: 0, y: 0, cursor: 'nw-resize' },
  { handle: 'n', x: 0.5, y: 0, cursor: 'ns-resize' },
  { handle: 'ne', x: 1, y: 0, cursor: 'ne-resize' },
  { handle: 'e', x: 1, y: 0.5, cursor: 'ew-resize' },
  { handle: 'se', x: 1, y: 1, cursor: 'se-resize' },
  { handle: 's', x: 0.5, y: 1, cursor: 'ns-resize' },
  { handle: 'sw', x: 0, y: 1, cursor: 'sw-resize' },
  { handle: 'w', x: 0, y: 0.5, cursor: 'ew-resize' },
]
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
const MIN_ZOOM = 0.5
const MAX_ZOOM = 2

/* ---------------- 视图快照 ---------------- */
const snapshot = shallowRef(binding.viewStore.getSnapshot())
const provisional = shallowRef(binding.viewStore.getProvisionalCaret?.() ?? null)
const geometry = computed(() => snapshot.value.geometry)
const pages = computed(() => geometry.value?.pages ?? [])
const extent = computed(() => {
  let width = 0
  let height = 0
  for (const { bounds } of pages.value) {
    width = Math.max(width, bounds.x + bounds.width)
    height = Math.max(height, bounds.y + bounds.height)
  }
  return { width: Math.max(width, geometry.value?.documentWidth ?? 0), height }
})
const matches = computed(() => geometryMatchesDocument(snapshot.value))

/* ---------------- 缩放 ---------------- */
const zoom = ref(props.initialZoom > 0 ? props.initialZoom : 1)
const devicePixelRatio = ref(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)

/** 用户手动缩放过没有：没有就是"适应宽度"的状态，切到轻预览时让对面用它自己的适应宽度，不硬套一个比例 */
let zoomTouched = false

/**
 * 缩放：页面整体变高 / 变矮，原来的 scrollTop 会指到别的地方（放大后"跳到后面几页"）。
 * 先记下视口中线所在的阅读位置（页 + 页内比例），DOM 随新缩放更新之后再把它放回中线，页码与阅读位置都不变。
 * 在最顶端（scrollTop = 0）时不锚定：保持在顶端，而不是被中线锚点推下去一截。
 */
function applyZoom(next: number, limit = true): void {
  const value = limit ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)) : Math.min(MAX_ZOOM, Math.max(0.25, next))
  if (!Number.isFinite(value) || Math.abs(value - zoom.value) < 0.001) return
  const scroller = scrollRef.value
  const anchor = scroller && scroller.scrollTop > 0 ? readingAnchor() : null
  zoom.value = value
  if (anchor) void nextTick(() => placeAnchor(anchor))
}
const userZoom = (next: number): void => {
  zoomTouched = true
  applyZoom(next)
}

/** 缩放变了：让引擎按新的像素密度重新出图，并通知外壳 */
watch(
  [zoom, devicePixelRatio],
  () => {
    binding.setRasterScale(devicePixelRatio.value * zoom.value)
    emit('zoom', zoom.value)
    scheduleMeasure()
  },
  { flush: 'post' },
)

/* ---------------- 阅读位置（缩放保持位置 / 往返高保真） ---------------- */

/** 各页在滚动内容里的位置（当前缩放下的像素）：页几何（文档坐标）× 缩放，再加上页面列在滚动内容里的上边距 */
function pageBoxes(): PageBox[] {
  const scroller = scrollRef.value
  const column = columnRef.value
  if (!scroller || !column) return []
  const columnTop = column.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
  return pages.value.map(({ bounds }) => ({ top: columnTop + bounds.y * zoom.value, height: bounds.height * zoom.value }))
}
function readingAnchor(): ReadingAnchor | null {
  const scroller = scrollRef.value
  return scroller ? captureAnchor(pageBoxes(), referenceLine(scroller.scrollTop, scroller.clientHeight)) : null
}
function placeAnchor(anchor: ReadingAnchor): void {
  const scroller = scrollRef.value
  if (!scroller) return
  scroller.scrollTop = scrollTopForAnchor(pageBoxes(), anchor, scroller.clientHeight, scroller.scrollHeight)
}

/* ---------------- DOM 引用 ---------------- */
const inputRef = ref<HTMLTextAreaElement | null>(null)
const scrollRef = ref<HTMLElement | null>(null)
const columnRef = ref<HTMLElement | null>(null)
const hostRef = ref<HTMLElement | null>(null)
const focused = ref(false)
const composition = ref<PeerlessCompositionState | null>(null)
const recoverable = ref<string[]>([])
const slots = new Map<string, HTMLElement>()
const setSlot = (pageId: string, element: unknown) => {
  if (element instanceof HTMLElement) slots.set(pageId, element)
  else slots.delete(pageId)
}

/* ---------------- 页窗口：只让引擎出视口附近几页 ---------------- */
const pageWindow = ref<PageWindowRange | null>(null)
let measureFrame: number | null = null

function scheduleMeasure(): void {
  if (measureFrame !== null) return
  measureFrame = requestAnimationFrame(measure)
}

function measure(): void {
  measureFrame = null
  const list = pages.value
  const scroller = scrollRef.value
  const column = columnRef.value
  if (!list.length || !scroller || !column) return
  let next: PageWindowRange
  if (list.length <= SMALL_DOCUMENT_PAGES) next = { start: 0, end: list.length - 1 }
  else {
    const band = viewportColumnBand(scroller, column)
    const top = (band.top - band.columnTop) / zoom.value
    const range = visiblePageRange(list, top, top + band.height / zoom.value)
    next = nextPageWindow(pageWindow.value, range.first, range.last, list.length)
  }
  const current = pageWindow.value
  if (!current || current.start !== next.start || current.end !== next.end) pageWindow.value = next
  // 当前页码：视口中线所在页
  const page = pageAtViewport(list, scroller.scrollTop, scroller.clientHeight, zoom.value)
  if (page !== currentPage.value || list.length !== totalPages.value) {
    currentPage.value = page
    totalPages.value = list.length
    emit('pageChange', page, list.length)
  }
}

const currentPage = ref(1)
const totalPages = ref(0)

/** 远端光标只换算当前挂载的页窗口（页序号，左闭右开）；文档不到 12 页时没有窗口，就是整篇 */
const presencePages = computed<readonly [number, number]>(() => {
  const list = pages.value
  const window = pageWindow.value
  if (!list.length) return [0, 0]
  if (!window) return [list[0]!.page.pageIndex, list.at(-1)!.page.pageIndex + 1]
  return [list[window.start]!.page.pageIndex, list[window.end]!.page.pageIndex + 1]
})

/** 光标所在页：不在窗口里也要挂画布，否则回显画在没有画布的页上 */
const caretPageId = computed(() => {
  const caret = geometry.value?.caret
  if (!caret) return undefined
  return pages.value.find(({ bounds }) => caret.y >= bounds.y && caret.y <= bounds.y + bounds.height)?.page.pageId
})
const shownPages = computed(() => {
  const window = pageWindow.value
  return pages.value.filter(
    ({ page }) => page.pageId === caretPageId.value || (!!window && page.pageIndex >= pages.value[window.start]!.page.pageIndex && page.pageIndex <= pages.value[window.end]!.page.pageIndex),
  )
})

/** 窗口变化时通知引擎，并回收窗口外的画布（上游同样的做法：不然几百页的文档滚一遍内存会爆） */
watch(
  [pageWindow, () => geometry.value?.identity.incarnation, () => geometry.value?.identity.epoch],
  () => {
    const window = pageWindow.value
    const list = pages.value
    if (!window || !list.length || !geometry.value) return
    binding.setDisplayWindow(list[window.start]!.page.pageIndex, list[window.end]!.page.pageIndex + 1)
  },
  { flush: 'post' },
)

function evictCanvases(): void {
  props.canvases.evict(new Set(shownPages.value.map(({ page }) => page.pageId)))
}

/** 把画布挂到各页的容器里（页面列表每次变化后同步一次，幂等） */
function syncCanvases(): void {
  for (const { page } of shownPages.value) {
    const slot = slots.get(page.pageId)
    if (!slot) continue
    const canvas = props.canvases.ensure(page)
    if (canvas.parentElement !== slot) {
      canvas.dataset.pageIndex = String(page.pageIndex)
      canvas.style.cssText = 'width:100%;height:100%;display:block'
      slot.appendChild(canvas)
    }
  }
}

/* ---------------- 页缩略图栏 ---------------- */

/** 输入停下多久后才让缩略图重画：连续打字时每个字都重画整页位图只会白占 CPU */
const THUMB_SETTLE_MS = 1500
/** 刚打开先让出首屏：首帧之后再等这么久才开始后台生成缩略图 */
const THUMB_START_DELAY_MS = 800

const bodyRef = ref<HTMLElement | null>(null)
/** 容器（不是屏幕）窄于阈值：缩略图栏改成文档下方的横条，默认收起 */
const compact = ref(false)
const userThumbs = ref<boolean | null>(props.thumbs)
/**
 * 编辑面默认收起：缩略图是引擎位图，要另开一个只读引擎会话（又一个 Worker + 文档副本）在后台光栅，
 * 不用它的人不该为它付内存和 CPU；只读预览的缩略图是 DOM 克隆，几乎没有成本，所以那边默认打开。
 * 用户点工具栏「缩略图」打开；高保真查看沿用轻预览里的选择（明确的 true / false）。
 */
const thumbsOpen = computed(() => userThumbs.value ?? false)
const thumbsRail = ref<{ invalidateFrom(index: number): void; invalidate(indices?: Iterable<number>): void } | null>(null)
const thumbAspects = computed(() => pages.value.map(({ bounds }) => (bounds.height > 0 ? bounds.width / bounds.height : 0)))
const thumbSource = shallowRef<CanvasThumbSource | null>(null)
/** 首帧后的让出期是否已过 / 输入是否已停：两者都满足才在后台生成缩略图 */
const thumbStartReady = ref(false)
const thumbQuiet = ref(true)
let thumbDirtyFrom = Number.POSITIVE_INFINITY
let thumbSettleTimer: ReturnType<typeof setTimeout> | null = null
let thumbStartTimer: ReturnType<typeof setTimeout> | null = null

watch(thumbsOpen, (open) => emit('thumbs', open))
watch(
  [thumbsOpen, () => pages.value.length > 0],
  ([open, has]) => {
    if (open && has) {
      if (thumbSource.value) return
      thumbSource.value = createCanvasThumbSource({
        snapshot: () => (props.thumbSnapshot ? props.thumbSnapshot() : props.engine.save()),
        pageWidth: (index) => pages.value[index]?.bounds.width ?? 816,
      })
    } else thumbSource.value = null
  },
  { immediate: true },
)

/** 栏开 / 关、横条 ↔ 纵栏会改变滚动区宽度：页面比容器宽了就缩到刚好放下，不让出横向滚动条 */
watch([thumbsOpen, compact], () => void nextTick(fitIfWider))

function measureCompact(): void {
  const width = bodyRef.value?.clientWidth ?? 0
  if (width > 0) compact.value = width < COMPACT_BELOW
}

/** 当前光标所在页（页数组里的下标），没有光标取 0 */
function caretPageIndex(): number {
  const index = pages.value.findIndex(({ page }) => page.pageId === caretPageId.value)
  return index < 0 ? 0 : index
}

/**
 * 文档内容变了：记下"最早可能变的页"（光标所在页——编辑只会让它和它后面的页变；协同里别人的修改不知道落在哪，从头算），
 * 暂停生成，等输入停下 `THUMB_SETTLE_MS` 再作废来源的快照并让这些页之后的缩略图重画。
 * 光标之前的页不重画；旧缩略图在新图到达前一直显示，不闪。
 */
function noteThumbEdit(from?: number): void {
  if (!thumbSource.value) return
  thumbDirtyFrom = Math.min(thumbDirtyFrom, from ?? (props.collab ? 0 : caretPageIndex()))
  thumbQuiet.value = false
  if (thumbSettleTimer) clearTimeout(thumbSettleTimer)
  thumbSettleTimer = setTimeout(flushThumbEdits, THUMB_SETTLE_MS)
}
function flushThumbEdits(): void {
  thumbSettleTimer = null
  if (Number.isFinite(thumbDirtyFrom)) {
    thumbSource.value?.markDirty()
    thumbsRail.value?.invalidateFrom(thumbDirtyFrom)
    thumbDirtyFrom = Number.POSITIVE_INFINITY
  }
  thumbQuiet.value = true
}
watch(
  () => snapshot.value.version,
  () => noteThumbEdit(),
)

function selectThumb(page: number): void {
  goTo(page)
  // 鼠标 / 键盘跳页之后把焦点还给文档，接着就能打字；触屏不抢焦点（会弹出软键盘）
  if (!props.readOnly && typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches) inputRef.value?.focus({ preventScroll: true })
}

/* ---------------- 查询引擎（临时光标）：用到才加载，空闲时预热 ---------------- */
const pageQueries = createDocxPageQueries()
const queryReady = ref(docxQueryEngineReady())
let warmHandle: number | null = null
function warmQueries(): void {
  if (!queryReady.value || warmHandle !== null) return
  const presented = shownPages.value.flatMap(({ displayPage }) => (displayPage && !displayPage.unbuilt ? [displayPage] : []))
  pageQueries.retain(presented)
  let index = 0
  const step = () => {
    const page = presented[index++]
    if (!page) {
      warmHandle = null
      return
    }
    pageQueries.get(page)?.hitTestRegions(0, 0, 0)
    warmHandle = index < presented.length ? scheduleIdle(step) : null
  }
  if (presented.length) warmHandle = scheduleIdle(step)
}
function scheduleIdle(callback: () => void): number {
  return typeof requestIdleCallback === 'function' ? requestIdleCallback(callback) : (setTimeout(callback, 32) as unknown as number)
}

/* ---------------- 指针 ---------------- */
const pointerUi = ref<PointerUiState>({ pictureDragging: false, picturePreview: null, pictureDropCaret: null, selectingPicture: 0, resizePreview: null })
const controller = new PagePointerController({
  binding,
  getZoom: () => zoom.value,
  getWidth: () => extent.value.width,
  focusInput: () => inputRef.value?.focus({ preventScroll: true }),
  isCompositionActive: () => composition.value?.phase === 'active',
  provisionalTextHit: (page: PageGeometry, x: number, y: number) => provisionalTextHitAtPoint(page, x, y, pageQueries),
  // 图片拖动 / 缩放：只读（含被收回编辑权）时不可动；意图带着图片版本号，版本过期引擎会拒绝，不会改错图
  pictures: {
    canMove: () => !props.readOnly && !binding.admission.getSnapshot().readOnly,
    canMoveInline: () => !props.readOnly && !binding.admission.getSnapshot().readOnly,
    move: (intent) => void binding.commands.submit(intent, { fence: true }),
    resize: (intent) => void binding.commands.submit(intent, { fence: true }),
  },
  onUiChange: (state) => (pointerUi.value = state),
})

/** 选中的图片及其所在页（画选中框 / 手柄）；跟着视图快照走，所以先读一次 snapshot 建立依赖 */
const selectedPic = computed(() => {
  void snapshot.value
  return controller.selectedPicture()
})
const selectedPicPage = computed(() => {
  const picture = selectedPic.value
  return picture ? pages.value.find((item) => item.page.pageIndex === picture.pageIndex) : undefined
})
const canResizePicture = computed(() => !!selectedPic.value && (selectedPic.value.rotation ?? 0) % 360 === 0)
function onHandleDown(event: PointerEvent, handle: PictureResizeHandle): void {
  event.stopPropagation()
  if (hostRef.value) controller.startResize(event, handle, event.currentTarget as unknown as PointerHost, hostRef.value as unknown as PointerHost)
}

const asHost = (event: Event) => event.currentTarget as unknown as PointerHost
const onMouseDown = (event: MouseEvent) => {
  // 保持焦点在隐藏输入框里，否则点页面会让输入法失去目标
  if (event.button === 0 && !(event.target as HTMLElement).closest('button, input, select, [data-docx-escape-layer]')) event.preventDefault()
}
const onPointerDown = (event: PointerEvent) => controller.onPointerDown(event, asHost(event))
const onPointerMove = (event: PointerEvent) => controller.onPointerMove(event, asHost(event))
const onPointerUp = (event: PointerEvent) => controller.onPointerUp(event, asHost(event))
const onPointerRelease = (event: PointerEvent) => controller.release(event, asHost(event))
const onLostCapture = (event: PointerEvent) => {
  if (event.target === event.currentTarget) controller.release(event, asHost(event))
}

/* ---------------- 无障碍：读取文档文本面板 ---------------- */
const readerOpen = ref(false)
const reader = ref({ text: [] as string[], total: 0, busy: false, error: '', offset: 0 })
let readerToken = 0
async function loadReader(): Promise<void> {
  const token = ++readerToken
  reader.value = { ...reader.value, text: [], busy: true, error: '' }
  try {
    const page = await readDocxText(props.engine.client, reader.value.offset)
    if (token === readerToken) reader.value = { ...reader.value, text: page.text, total: page.total, busy: false }
  } catch (error) {
    if (token === readerToken) reader.value = { ...reader.value, text: [], busy: false, error: error instanceof Error ? error.message : String(error) }
  }
}
function toggleReader(): void {
  readerOpen.value = !readerOpen.value
  if (readerOpen.value) {
    reader.value.offset = 0
    void loadReader()
  }
}
function readerStep(delta: number): void {
  reader.value.offset = Math.max(0, reader.value.offset + delta)
  void loadReader()
}

/* ---------------- 生命周期 ---------------- */
let input: DocxInputHandle | null = null
const cleanups: Array<() => void> = []
let firstGeometry = false
let layoutAnnounced = false
let layoutTimer: ReturnType<typeof setTimeout> | null = null
/** 整篇排版迟迟不完成时的兜底：照样宣布完成，让等它的外壳（切换版式后恢复阅读位置）继续 */
const LAYOUT_READY_FALLBACK_MS = 10_000
/** 切换版式带来的阅读位置：整篇排版完成之后才能放（前三页的临时布局里页码会被夹到第 3 页） */
let pendingStart: ReadingStart | null = null

function announceLayout(force = false): void {
  if (layoutAnnounced || !firstGeometry) return
  const current = geometry.value
  if (!force && (!current || !pages.value.length || current.layoutProvisional)) return
  layoutAnnounced = true
  emit('layoutReady')
  applyPendingStart()
}

function applyPendingStart(): void {
  const start = pendingStart
  if (!start || !layoutAnnounced) return
  pendingStart = null
  if (start.fit === false && start.scale) userZoom(start.scale)
  void nextTick(() => placeAnchor({ page: start.page, fraction: start.fraction }))
}

function readyCheck(): void {
  if (firstGeometry || !geometry.value || !pages.value.length) return
  firstGeometry = true
  fitIfWider()
  thumbStartTimer = setTimeout(() => (thumbStartReady.value = true), THUMB_START_DELAY_MS)
  // 极端情况下引擎一直报"临时布局"：不能让等它的外壳无限等，过一会儿照样放行
  layoutTimer = setTimeout(() => announceLayout(true), LAYOUT_READY_FALLBACK_MS)
  emit('ready')
  announceLayout()
  if (props.autoFocus) inputRef.value?.focus({ preventScroll: true })
}

/** 缩放到刚好放下整页宽度（可以小于 50%：手机竖屏） */
function fitWidth(): void {
  const scroller = scrollRef.value
  const width = extent.value.width
  zoomTouched = false
  if (scroller && width) applyZoom((scroller.clientWidth - 24) / width, false)
}

/** 页面比容器宽时缩小到刚好放下；窄页面保持 100% */
function fitIfWider(): void {
  const scroller = scrollRef.value
  const width = extent.value.width
  if (!scroller || !width) return
  const available = scroller.clientWidth - 24
  if (available > 0 && width * zoom.value > available) applyZoom(available / width, false)
}

onMounted(() => {
  measureCompact()
  const textarea = inputRef.value!
  input = attachDocxInput(textarea, {
    admission: binding.admission,
    viewStore: binding.viewStore,
    getCaretHost: () => columnRef.value,
    getZoom: () => zoom.value,
    onCompositionChange: (state) => (composition.value = state),
    onShortcut: (event) => {
      const command = shortcutCommand(event, isMac)
      if (!command || !props.runCommand) return false
      void props.runCommand(command.type, command.args)
      return true
    },
    onRecoverableText: (text) => {
      recoverable.value.push(text)
      emit('recoverableText', text)
    },
  })
  const onFocus = () => (focused.value = true)
  const onBlur = () => (focused.value = false)
  textarea.addEventListener('focus', onFocus)
  textarea.addEventListener('blur', onBlur)
  focused.value = document.activeElement === textarea
  cleanups.push(() => {
    textarea.removeEventListener('focus', onFocus)
    textarea.removeEventListener('blur', onBlur)
  })

  cleanups.push(
    binding.viewStore.subscribe(() => {
      snapshot.value = binding.viewStore.getSnapshot()
    }),
  )
  const offProvisional = binding.viewStore.subscribeProvisionalCaret?.(() => {
    provisional.value = binding.viewStore.getProvisionalCaret?.() ?? null
  })
  if (offProvisional) cleanups.push(offProvisional)

  // 每次按下（含不在页面上的）都要计数：双击判定要求两次点击之间没有别的按下
  const press = () => controller.notePress()
  document.addEventListener('pointerdown', press, true)
  cleanups.push(() => document.removeEventListener('pointerdown', press, true))
  // 触屏拖选择时阻止页面滚动
  const host = hostRef.value!
  const touchMove = (event: TouchEvent) => {
    if (controller.isTouchSelecting()) event.preventDefault()
  }
  host.addEventListener('touchmove', touchMove, { passive: false })
  cleanups.push(() => host.removeEventListener('touchmove', touchMove))

  // 滚动 / 尺寸变化 → 重算页窗口
  const scroller = scrollRef.value!
  scroller.addEventListener('scroll', scheduleMeasure, { passive: true })
  window.addEventListener('resize', scheduleMeasure)
  const observer =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          measureCompact()
          scheduleMeasure()
        })
  observer?.observe(scroller)
  if (bodyRef.value) observer?.observe(bodyRef.value)
  cleanups.push(() => {
    scroller.removeEventListener('scroll', scheduleMeasure)
    window.removeEventListener('resize', scheduleMeasure)
    observer?.disconnect()
  })

  // 屏幕像素密度变了（拖到另一块屏）：重新出图
  if (typeof matchMedia === 'function') {
    const watchDpr = () => {
      const media = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      const change = () => {
        devicePixelRatio.value = window.devicePixelRatio || 1
        watchDpr()
      }
      media.addEventListener('change', change, { once: true })
      cleanups.push(() => media.removeEventListener('change', change))
    }
    watchDpr()
  }

  if (!queryReady.value) {
    // 临时光标要用的查询引擎（另一份 wasm）：首屏之后再加载，不挡第一帧
    scheduleIdle(() => {
      void loadDocxQueryEngine().then(
        () => {
          queryReady.value = true
        },
        () => undefined,
      )
    })
  }
  readyCheck()
  scheduleMeasure()
  syncCanvases()
})

watch(geometry, () => {
  readyCheck()
  announceLayout()
  scheduleMeasure()
})
watch(shownPages, () => {
  evictCanvases()
  warmQueries()
})
watch(queryReady, warmQueries)
onUpdated(syncCanvases)

onBeforeUnmount(() => {
  if (layoutTimer) clearTimeout(layoutTimer)
  if (thumbSettleTimer) clearTimeout(thumbSettleTimer)
  if (thumbStartTimer) clearTimeout(thumbStartTimer)
  if (measureFrame !== null) cancelAnimationFrame(measureFrame)
  if (warmHandle !== null) typeof cancelIdleCallback === 'function' ? cancelIdleCallback(warmHandle) : clearTimeout(warmHandle)
  input?.dispose()
  input = null
  for (const stop of cleanups.splice(0)) stop()
  controller.dispose()
  pageQueries.dispose()
  props.canvases.dispose()
})

/* ---------------- 光标 / 选区绘制 ---------------- */
const caretRect = computed(() => {
  if (composition.value?.phase === 'active') return null
  const shown = provisional.value?.rect ?? (matches.value ? geometry.value?.caret : null)
  if (!shown) return null
  // 多个单元格被选中时不画光标（选区高亮已经说明了范围）
  if (!provisional.value && snapshot.value.editState?.tableContext?.hasMultiCellSelection === true) return null
  return shown
})
const selectionRects = computed(() => {
  if (composition.value?.phase === 'active' || provisional.value || !matches.value) return []
  return geometry.value?.selectionRects ?? []
})
/** 光标移动后重置闪烁相位，移动中的光标始终可见 */
const caretKey = computed(() => (caretRect.value ? `${caretRect.value.x},${caretRect.value.y}` : ''))

/* ---------------- 查找高亮 ---------------- */
const findBoxes = computed(() =>
  props.findRects.flatMap((rect) => {
    const page = pages.value.find((item) => item.page.pageId === rect.pageId && item.page.pageIndex === rect.pageIndex)
    return page ? [{ left: page.bounds.x + rect.x, top: page.bounds.y + rect.y, width: rect.width, height: rect.height, current: rect.current }] : []
  }),
)

/**
 * 把文档坐标里的 y（所有页纵向排在一起的坐标，未缩放）滚到视口上部三分之一处（查找跳转用）。
 * 用文档坐标而不是"某页 + 页内 y"：跳到还没建出来的页时，我们并不知道命中在哪一页，
 * 但引擎选中命中之后，帧里的光标 / 选区矩形永远是对的（已含页偏移），按它滚就不会落后一次。
 */
function revealDocumentY(y: number): boolean {
  const scroller = scrollRef.value
  if (!scroller || !Number.isFinite(y)) return false
  const top = y * zoom.value
  // 已经在可视区中间一带就不动，避免每次"下一个"都把页面拽一下
  if (top > scroller.scrollTop + 40 && top < scroller.scrollTop + scroller.clientHeight - 80) return true
  scroller.scrollTop = Math.max(0, top - scroller.clientHeight / 3)
  return true
}

/* ---------------- 页码 / 缩放工具条 ---------------- */
const pageDraft = ref('1')
watch(currentPage, (page) => (pageDraft.value = String(page)), { immediate: true })
const percent = computed(() => Math.round(zoom.value * 100))
function commitPageDraft(): void {
  const page = Number.parseInt(pageDraft.value, 10)
  if (Number.isFinite(page)) goTo(page)
  pageDraft.value = String(currentPage.value)
}

/* ---------------- 对外接口（Surface 用） ---------------- */
function goTo(page: number): void {
  const target = pages.value[Math.min(pages.value.length, Math.max(1, page)) - 1]
  const scroller = scrollRef.value
  if (target && scroller) scroller.scrollTop = Math.max(0, target.bounds.y * zoom.value - 8)
}
function selectAll(): void {
  admitInputIntents(
    binding.admission,
    [
      { kind: 'navigate', payload: { unit: 'document-boundary', direction: 'backward', extend: false } },
      { kind: 'navigate', payload: { unit: 'document-boundary', direction: 'forward', extend: true } },
    ],
    { inputTime: performance.now(), source: 'selection', fence: true },
  )
}
defineExpose({
  focus: () => inputRef.value?.focus({ preventScroll: true }),
  revealDocumentY,
  goTo,
  selectAll,
  getPage: () => currentPage.value,
  getPages: () => totalPages.value,
  getScale: () => zoom.value,
  zoomBy: (factor: number) => userZoom(zoom.value * factor),
  setZoom: (value: number) => userZoom(value),
  fit: fitWidth,
  isThumbsOpen: () => thumbsOpen.value,
  setThumbs: (open?: boolean) => {
    userThumbs.value = open ?? !thumbsOpen.value
  },
  /** 文档里有"不知道落在哪页"的整体改动（全部替换 / 接受全部修订）：从第 `from` 页起缩略图都重画 */
  markThumbsDirty: (from = 0) => noteThumbEdit(from),
  /** 当前阅读位置与缩放（切到轻预览前记下） */
  capturePosition: (): ReadingStart | null => {
    const anchor = readingAnchor()
    return anchor ? { ...anchor, scale: zoom.value, fit: !zoomTouched } : null
  },
  /** 恢复阅读位置（从轻预览切过来后）：先缩放再放回锚点；要在页几何到达之后调用 */
  restorePosition: (start: ReadingStart) => {
    pendingStart = start
    applyPendingStart()
  },
  scroller: scrollRef,
  column: columnRef,
  findScroller: () => (columnRef.value ? findVerticalScrollParentOrRoot(columnRef.value) : null),
  getRecoverableText: () => recoverable.value,
})
</script>

<template>
  <div class="kb-dex" data-testid="docx-edit-view" data-docx-worker-editor="true">
    <!-- 画布不能接收输入：这个看不见的 textarea 承接键盘 / 输入法 / 剪贴板，并跟着光标定位（输入法候选窗才出现在光标旁） -->
    <textarea
      ref="inputRef"
      class="paged-editor__input"
      aria-label="文档输入"
      rows="1"
      spellcheck="true"
      autocapitalize="sentences"
      autocorrect="on"
      :readonly="readOnly"
      style="position: fixed; left: 0; top: 0; width: 1px; height: 1px; opacity: 0; padding: 0; border: 0; resize: none; overflow: hidden; caret-color: transparent"
    />
    <ViewerToolbar aria-label="Word 工具栏">
      <template #start>
        <span class="kb-dex-group">
          <button type="button" class="btn sm kb-dex-btn" aria-label="上一页" :disabled="currentPage <= 1" @click="goTo(currentPage - 1)">
            <KbIcon name="chevron" :size="12" class="kb-dex-prev" />
          </button>
          <input
            v-model="pageDraft"
            class="kb-dex-page-input mono"
            inputmode="numeric"
            aria-label="当前页"
            @keydown.enter.prevent="commitPageDraft"
            @blur="commitPageDraft"
          />
          <span class="mono kb-dex-total">/ {{ totalPages || '—' }}</span>
          <button type="button" class="btn sm kb-dex-btn" aria-label="下一页" :disabled="currentPage >= totalPages" @click="goTo(currentPage + 1)">
            <KbIcon name="chevron" :size="12" class="kb-dex-next" />
          </button>
        </span>
      </template>
      <template #center>
        <span class="kb-dex-group">
          <button type="button" class="btn sm kb-dex-btn" aria-label="缩小" data-testid="docx-edit-zoom-out" @click="userZoom(zoom / 1.2)"><KbIcon name="minus" :size="12" /></button>
          <button type="button" class="mono kb-dex-zoom" title="恢复适应宽度" data-testid="docx-edit-zoom" @click="fitWidth">{{ percent }}%</button>
          <button type="button" class="btn sm kb-dex-btn" aria-label="放大" data-testid="docx-edit-zoom-in" @click="userZoom(zoom * 1.2)"><KbIcon name="plus" :size="12" /></button>
        </span>
      </template>
    </ViewerToolbar>
    <p v-if="fontNotice" class="kb-dex-font-notice" role="status" data-testid="docx-edit-font-notice">
      <span>{{ fontNotice }}</span>
      <button type="button" class="btn sm" aria-label="关闭字体提示" data-testid="docx-edit-font-notice-close" @click="emit('dismissFontNotice')">知道了</button>
    </p>
    <div ref="bodyRef" class="kb-dex-body" :class="{ 'is-compact': compact }">
    <PageThumbnails
      v-if="thumbsOpen && pages.length > 0"
      ref="thumbsRail"
      :count="pages.length"
      :current="currentPage"
      :aspects="thumbAspects"
      :source="thumbSource"
      :orientation="compact ? 'horizontal' : 'vertical'"
      :paused="!thumbStartReady || !thumbQuiet"
      :min-gap-ms="80"
      @select="selectThumb"
      @leave="inputRef?.focus({ preventScroll: true })"
    />
    <div ref="scrollRef" class="kb-dex-scroll" data-testid="docx-edit-scroll">
      <div ref="columnRef" class="kb-dex-column" :style="{ width: `${extent.width * zoom}px`, height: `${extent.height * zoom}px` }">
        <div
          ref="hostRef"
          class="kb-dex-pages"
          data-docx-pages-host
          :style="{ width: `${extent.width}px`, height: `${extent.height}px`, transform: `scale(${zoom})` }"
          @mousedown="onMouseDown"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerRelease"
          @lostpointercapture="onLostCapture"
        >
          <div
            v-for="item in pages"
            :key="item.page.pageId"
            :ref="(element) => setSlot(item.page.pageId, element)"
            v-memo="[item.page.pageId, item.page.pageIndex, item.bounds.x, item.bounds.y, item.bounds.width, item.bounds.height]"
            class="kb-dex-page canvas-page"
            :data-page-id="item.page.pageId"
            :data-page-index="item.page.pageIndex"
            :style="{ left: `${item.bounds.x}px`, top: `${item.bounds.y}px`, width: `${item.bounds.width}px`, height: `${item.bounds.height}px` }"
          />
          <div
            v-for="(box, index) in findBoxes"
            :key="`find-${index}`"
            class="kb-dex-find"
            :class="{ 'is-current': box.current }"
            aria-hidden="true"
            data-testid="docx-find-highlight"
            :style="{ left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` }"
          />
          <RemotePresence v-if="collab" :engine="engine" :handle="collab" :pages="presencePages" />
          <div
            v-for="(rect, index) in selectionRects"
            :key="`sel-${index}`"
            class="kb-dex-selection"
            aria-hidden="true"
            :style="{ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` }"
          />
          <div
            v-if="caretRect"
            :key="caretKey"
            class="kb-dex-caret"
            :class="{ 'is-focused': focused }"
            aria-hidden="true"
            data-testid="docx-edit-caret"
            :style="{ transform: `translate(${caretRect.x}px, ${caretRect.y}px)`, width: `${Math.max(1, caretRect.width)}px`, height: `${caretRect.height}px` }"
          />
          <div
            v-if="selectedPic && selectedPicPage"
            class="kb-dex-picture"
            aria-hidden="true"
            data-testid="docx-edit-picture"
            :style="{ left: `${selectedPicPage.bounds.x + selectedPic.rect.x}px`, top: `${selectedPicPage.bounds.y + selectedPic.rect.y}px`, width: `${selectedPic.rect.width}px`, height: `${selectedPic.rect.height}px` }"
          >
            <template v-if="canResizePicture">
              <div
                v-for="item in PICTURE_HANDLES"
                :key="item.handle"
                class="kb-dex-handle"
                :data-handle="item.handle"
                :style="{ left: `${item.x * 100}%`, top: `${item.y * 100}%`, cursor: item.cursor }"
                @pointerdown="onHandleDown($event, item.handle)"
              />
            </template>
          </div>
          <div
            v-if="pointerUi.resizePreview && selectedPicPage"
            class="kb-dex-picture-preview"
            aria-hidden="true"
            :style="{ left: `${selectedPicPage.bounds.x + pointerUi.resizePreview.rect.x}px`, top: `${selectedPicPage.bounds.y + pointerUi.resizePreview.rect.y}px`, width: `${pointerUi.resizePreview.rect.width}px`, height: `${pointerUi.resizePreview.rect.height}px` }"
          />
          <div
            v-if="pointerUi.picturePreview"
            class="kb-dex-picture-preview"
            aria-hidden="true"
            :style="{ left: `${pointerUi.picturePreview.x}px`, top: `${pointerUi.picturePreview.y}px`, width: `${pointerUi.picturePreview.width}px`, height: `${pointerUi.picturePreview.height}px` }"
          />
          <div
            v-if="pointerUi.pictureDropCaret"
            class="kb-dex-drop-caret"
            aria-hidden="true"
            :style="{ left: `${pointerUi.pictureDropCaret.x}px`, top: `${pointerUi.pictureDropCaret.y}px`, height: `${pointerUi.pictureDropCaret.height}px` }"
          />
        </div>
      </div>
    </div>
    </div>

    <!-- 读屏用：把文档文本按段读出来（画布没有可读的 DOM）。视觉上隐藏，键盘聚焦时才出现 -->
    <div class="sr-only kb-dex-sr">
      <button type="button" :aria-expanded="readerOpen" @click="toggleReader">读取文档文本</button>
      <section v-if="readerOpen" aria-label="文档文本" :aria-busy="reader.busy" :data-total="reader.total" :data-offset="reader.offset">
        <p v-if="reader.error" role="alert">{{ reader.error }}</p>
        <p v-for="(text, index) in reader.text" :key="index">{{ text }}</p>
        <button type="button" :disabled="reader.busy || reader.offset === 0" @click="readerStep(-32)">上一段</button>
        <button type="button" :disabled="reader.busy || reader.offset + 32 >= reader.total" @click="readerStep(32)">下一段</button>
      </section>
    </div>

    <!-- 引擎拒绝了一次输入法上屏时，把文字还给用户，不静默吞掉 -->
    <div v-for="(text, index) in recoverable" :key="`rec-${index}`" class="kb-dex-recover" role="status">
      <span>这段文字没能写进文档，已为你保留：</span>
      <textarea :value="text" readonly aria-label="未写入的文字" />
      <button type="button" @click="recoverable.splice(index, 1)">知道了</button>
    </div>
  </div>
</template>

<style scoped>
.kb-dex {
  /* 与审阅栏并排放在 .kb-dex-shell 里：自己占满剩余宽度，不再绝对定位铺满整个舞台 */
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.kb-dex-font-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 6px 12px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--warn, #b45309);
  background: color-mix(in srgb, var(--warn, #b45309) 10%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--warn, #b45309) 30%, transparent);
}
.kb-dex-font-notice span {
  flex: 1;
  min-width: 0;
}
.kb-dex-body {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
}
/* 窄容器（手机）：缩略图是文档下方的横条，和正文上下排列，不盖住正文 */
.kb-dex-body.is-compact {
  flex-direction: column;
}
.kb-dex-body.is-compact > :deep(.kb-pgt) {
  order: 2;
}
.kb-dex-scroll {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 12px 0;
  background: var(--surface-2, #ececec);
  overscroll-behavior: contain;
}
.kb-dex-column {
  position: relative;
  margin: 0 auto;
}
.kb-dex-pages {
  position: relative;
  transform-origin: top left;
  touch-action: pan-x pan-y;
  user-select: none;
  -webkit-user-select: none;
  cursor: text;
}
.kb-dex-page {
  position: absolute;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
  contain: strict;
}
.kb-dex-find {
  position: absolute;
  background: rgba(255, 220, 0, 0.35);
  pointer-events: none;
  mix-blend-mode: multiply;
}
.kb-dex-find.is-current {
  background: rgba(255, 150, 0, 0.5);
  outline: 1px solid rgba(255, 120, 0, 0.9);
}
.kb-dex-selection {
  position: absolute;
  background: rgba(59, 130, 246, 0.3);
  pointer-events: none;
  mix-blend-mode: multiply;
}
.kb-dex-caret {
  position: absolute;
  left: 0;
  top: 0;
  background: #111;
  pointer-events: none;
  will-change: transform;
}
.kb-dex-caret.is-focused {
  animation: kb-dex-blink 1.06s steps(1) infinite;
}
@keyframes kb-dex-blink {
  0%,
  50% {
    opacity: 1;
  }
  50.01%,
  100% {
    opacity: 0;
  }
}
.kb-dex-picture {
  position: absolute;
  outline: 2px solid #2563eb;
  pointer-events: none;
  z-index: 15;
}
.kb-dex-handle {
  position: absolute;
  width: 10px;
  height: 10px;
  transform: translate(-50%, -50%);
  background: #fff;
  border: 1.5px solid #2563eb;
  border-radius: 50%;
  box-sizing: border-box;
  box-shadow: 0 1px 2.5px rgba(0, 0, 0, 0.4);
  pointer-events: auto;
  touch-action: none;
}
.kb-dex-picture-preview {
  position: absolute;
  outline: 1px dashed rgb(59, 130, 246);
  background: rgba(59, 130, 246, 0.12);
  pointer-events: none;
  z-index: 16;
}
.kb-dex-drop-caret {
  position: absolute;
  width: 1px;
  background: #2563eb;
  pointer-events: none;
  z-index: 16;
}
.kb-dex-group {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.kb-dex-btn {
  min-width: var(--ctl-h);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.kb-dex-prev {
  transform: rotate(90deg);
}
.kb-dex-next {
  transform: rotate(-90deg);
}
.kb-dex-page-input {
  width: 3.2em;
  height: var(--ctl-h);
  padding: 0 4px;
  text-align: center;
  color: var(--text-primary);
  background: var(--surface-1);
  border: var(--hl) solid var(--border-subtle);
  border-radius: var(--r1);
  font-size: calc(12px * var(--fs));
}
.kb-dex-total {
  color: var(--text-tertiary);
  font-size: calc(12px * var(--fs));
  white-space: nowrap;
}
.kb-dex-zoom {
  min-width: 4.4em;
  height: var(--ctl-h);
  padding: 0 6px;
  color: var(--text-secondary);
  background: transparent;
  border: 0;
  border-radius: var(--r1);
  font-size: calc(12px * var(--fs));
  cursor: pointer;
}
.kb-dex-zoom:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}
.kb-dex-sr:not(:focus-within) {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.kb-dex-recover {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--accent-soft);
  font-size: 13px;
}
.kb-dex-recover textarea {
  flex: 1;
  height: 28px;
}
</style>
