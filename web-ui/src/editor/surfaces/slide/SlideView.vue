<script setup lang="ts">
/**
 * 幻灯片视图：画布主视图 + 缩略图栏 + 备注栏 + 放映 + 缩放
 *
 * 外壳只认 `SlideBackend`（见 types.ts），不知道引擎。体验上的几个取舍：
 * - 一次只显示一页（和 PowerPoint 普通视图一致），翻页 / 缩放 / 窗口大小变化都不重新排版整份文档；
 * - 当前页优先：绘制当前页期间暂停后台队列，画完再让预渲染 / 缩略图接着跑；
 * - 缩放手势（滚轮、窗口拖拽）先改画布的 CSS 尺寸（GPU 拉伸，60 fps），停手 90 ms 后才按新比例重绘清晰位图；
 * - 位图缓存：画好的页留在 LRU 里，来回翻页直接贴图；相邻页在空闲时预渲染；
 * - 备注、命中高亮、读屏文字都从后端取，画布本身只是像素，所以另外放一份视觉隐藏的当前页文字给读屏器。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { KbIcon } from '@kb-ui/index'
import ViewerToolbar from '@/components/ViewerToolbar.vue'
import SlideEditBar from './SlideEditBar.vue'
import SlideEditLayer from './SlideEditLayer.vue'
import SlideOverlay from './SlideOverlay.vue'
import SlidePresence from './SlidePresence.vue'
import SlidePresent from './SlidePresent.vue'
import { SlideEditor, readImageFile } from './pptx-edit'
import { SlideRenderer } from './renderer'
import { IdleQueue, nearestFirst } from './scheduler'
import { yieldToMain } from '../../yieldToMain'
import { hitCandidates } from './hit'
import { classifyGesture } from './swipe'
import { peerInitial, peersBySlide, presenceBoxes } from './presence'
import { isEditBackend, type EditChange, type SlidePeer, type SlideBackend, type SlideFrame, type SlideLoader, type SlideMatch, type SlideRect, type SlideSummary } from './types'
import { clampZoom, cssSize, fitScale, paintScale, pixelSize, stepZoom, type FitMode } from './zoom'

const props = withDefaults(
  defineProps<{
    load: SlideLoader
    /** 画布的无障碍名称，一般是文件名 */
    label?: string
    /** 检索命中的文字 / 页码（页码 1 起） */
    hitText?: string
    hitSlide?: number | null
    /** 初始页（0 起）；有 hitSlide 时以命中为准 */
    initialSlide?: number
  }>(),
  { label: '演示文稿', hitText: '', hitSlide: null, initialSlide: 0 },
)
const emit = defineEmits<{
  ready: [slides: number]
  error: [message: string]
  slide: [index: number]
  /** 编辑后端的内容变了（本地修改 / 远端修改）；宿主据此标脏、刷新字数 */
  change: [change: EditChange]
}>()

/** 缩略图的 CSS 宽度与位图密度（密度封顶 1.5：几百页时位图总量可控） */
const THUMB_WIDTH = 144
const THUMB_DPR_CAP = 1.5
/** 缩放停手多久后才按新比例重绘 */
const REPAINT_DELAY = 90
/** 窄于它就是手机布局：目录变抽屉 */
const COMPACT_WIDTH = 760

const root = ref<HTMLElement | null>(null)
const stage = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const rail = ref<HTMLElement | null>(null)

const phase = ref<'loading' | 'ready' | 'error'>('loading')
const errorMessage = ref('')
const progress = ref(0)
const backend = shallowRef<SlideBackend | null>(null)
const renderer = shallowRef<SlideRenderer | null>(null)
const slides = shallowRef<readonly SlideSummary[]>([])
const current = ref(0)
const pageDraft = ref('1')
const scale = ref(1)
const fit = ref<FitMode | null>('page')
const railOpen = ref(false)
const notesOpen = ref(false)
const compact = ref(false)
const presenting = ref(false)
const hitFound = ref<boolean | null>(null)
const find = ref({ query: '', total: 0, index: -1 })
const highlights = shallowRef<{ rect: SlideRect; active: boolean }[]>([])
const notices = ref<string[]>([])
const pageError = ref('')
const srText = ref('')
const paintedCount = ref(0)
/** 编辑后端才有：选择 / 文字 / 拖动状态机（见 pptx-edit.ts） */
const editor = shallowRef<SlideEditor | null>(null)
const notesDraft = ref('')
/** 协同：别人的位置（后端的在线状态变了就整份换掉） */
const peers = shallowRef<readonly SlidePeer[]>([])
let offPeers: (() => void) | null = null
let notesTimer = 0
let offBackendChange: (() => void) | null = null

let railTouched = false
/** 备注栏的默认展开只在第一次量完布局时决定一次；之后展开 / 收起完全听用户的（布局变化会触发重新量，不能每次都改回去） */
let layoutDefaulted = false
let disposed = false
let abort: AbortController | null = null
let paintSeq = 0
let repaintTimer = 0
let resizeObserver: ResizeObserver | null = null
let currentFrame: SlideFrame | null = null
let matches: SlideMatch[] = []
let hitMatch: SlideMatch | null = null
let queue: IdleQueue<string> | null = null
let touchStart: { x: number; y: number; t: number; id: number } | null = null
const thumbs = new Map<number, HTMLCanvasElement>()

const dprNow = () => Math.min(window.devicePixelRatio || 1, 2)
const slideCount = computed(() => slides.value.length)
const size = computed(() => backend.value?.size ?? { width: 1280, height: 720 })
const sheet = computed(() => cssSize(size.value, scale.value))
const percent = computed(() => Math.round(scale.value * 100))
const hasNotes = computed(() => slides.value.some((slide) => slide.notes.trim()))
/** 编辑时备注栏总是可用（空白页也要能写备注） */
const notesAvailable = computed(() => hasNotes.value || !!editor.value)
const currentNotes = computed(() => slides.value[current.value]?.notes ?? '')
const currentTitle = computed(() => slides.value[current.value]?.title ?? '')
const peerPages = computed(() => peersBySlide(peers.value))
const peerBoxes = computed(() => (editor.value ? presenceBoxes(peers.value, editor.value.shapes.value, current.value) : []))
const thumbHeight = computed(() => Math.round((THUMB_WIDTH * size.value.height) / Math.max(1, size.value.width)))
const canvasLabel = computed(
  () => `${props.label}，第 ${current.value + 1} 张，共 ${slideCount.value} 张${currentTitle.value ? `：${currentTitle.value}` : ''}`,
)

function fail(message: string) {
  phase.value = 'error'
  errorMessage.value = message
  emit('error', message)
}

/* ---------------- 加载 ---------------- */

async function open() {
  disposed = false
  abort?.abort()
  abort = new AbortController()
  const signal = abort.signal
  phase.value = 'loading'
  progress.value = 0
  try {
    const loaded = await props.load({ signal, onProgress: (ratio) => (progress.value = ratio) })
    if (disposed || signal.aborted) {
      void Promise.resolve(loaded.dispose()).catch(() => undefined)
      return
    }
    backend.value = loaded
    renderer.value = new SlideRenderer(loaded)
    slides.value = loaded.slides()
    if (!slides.value.length) throw new Error('这份演示文稿里没有幻灯片')
    notices.value = [...(loaded.notices?.() ?? [])]
    queue = new IdleQueue<string>({ run: runJob })
    // 第一页画出来之前后台队列不许动：下面几段之间让出了主线程，队列的定时器会在这时趁虚而入，把邻页 / 缩略图排到第一页前面
    queue.pause()
    attachEditing(loaded)
    const wanted = props.hitSlide ? props.hitSlide - 1 : props.initialSlide
    current.value = clampIndex(wanted)
    pageDraft.value = String(current.value + 1)
    // 打开是一串同步工作（读形状 → 挂界面 → 量布局 → 画第一页），4× 降速下合在一起是一个 200 ms 的长任务；
    // 每段之间让出一次主线程，输入和画帧能插进来，每段各自远低于 100 ms
    await yieldToMain()
    if (disposed || signal.aborted) return
    phase.value = 'ready'
    // 协同：界面就绪后才告诉别人我在哪一页（attachEditing 里那次因为还没就绪被跳过了）
    announceCursor()
    await nextTick()
    await yieldToMain()
    if (disposed || signal.aborted) return
    measure()
    watchSize()
    await yieldToMain()
    if (disposed || signal.aborted) return
    // 第一页必须画出来才算打开成功：画不出来整体失败，交给上层走回退链
    await showCurrent(true)
    if (disposed) return
    queue.resume()
    emit('ready', slides.value.length)
    void showHit()
    scheduleBackground()
  } catch (error) {
    if (disposed || (error as Error)?.name === 'AbortError') return
    fail(error instanceof Error && error.message ? error.message : '这份演示文稿渲染失败（可能已损坏或格式过旧）')
  }
}

function clampIndex(value: number): number {
  const last = Math.max(0, slides.value.length - 1)
  return Math.min(last, Math.max(0, Number.isFinite(value) ? Math.round(value) : 0))
}

/* ---------------- 布局与缩放 ---------------- */

function viewport() {
  return { width: stage.value?.clientWidth ?? 0, height: stage.value?.clientHeight ?? 0 }
}

function measure() {
  const width = root.value?.clientWidth ?? 0
  const next = width > 0 && width < COMPACT_WIDTH
  compact.value = next
  if (!railTouched) railOpen.value = !next && phase.value === 'ready'
  if (!layoutDefaulted && phase.value === 'ready') {
    layoutDefaulted = true
    notesOpen.value = !next && notesAvailable.value
  }
  if (fit.value) applyScale(fitScale(viewport(), size.value, fit.value, next ? 8 : 16))
}

function applyScale(next: number) {
  const value = clampZoom(next)
  if (Math.abs(value - scale.value) < 0.0005) return
  scale.value = value
  scheduleRepaint()
}

function scheduleRepaint() {
  window.clearTimeout(repaintTimer)
  repaintTimer = window.setTimeout(() => {
    queue?.invalidate(pageKeys())
    void showCurrent().then(scheduleBackground)
  }, REPAINT_DELAY)
}

function zoomStep(direction: 1 | -1) {
  fit.value = null
  applyScale(stepZoom(scale.value, direction))
}
function zoomBy(factor: number) {
  fit.value = null
  applyScale(scale.value * factor)
}
function fitPage(mode: FitMode = 'page') {
  fit.value = mode
  applyScale(fitScale(viewport(), size.value, mode, compact.value ? 8 : 16))
}

function watchSize() {
  resizeObserver?.disconnect()
  if (!root.value || typeof ResizeObserver === 'undefined') return
  resizeObserver = new ResizeObserver(() => {
    if (phase.value === 'ready') measure()
  })
  resizeObserver.observe(root.value)
  if (stage.value) resizeObserver.observe(stage.value)
}

function onWheel(event: WheelEvent) {
  if (!(event.ctrlKey || event.metaKey)) return
  event.preventDefault()
  zoomBy(Math.exp(-event.deltaY * 0.01))
}

function onDoubleClick() {
  if (fit.value) {
    fit.value = null
    applyScale(Math.max(2, scale.value * 2))
  } else {
    fitPage()
  }
}

/* ---------------- 绘制当前页 ---------------- */

/**
 * 画当前页。`strict` 为真时失败向上抛（首次打开用），否则把失败记成这一页的提示，不影响浏览其他页。
 * 每次调用拿一个序号，晚到的旧结果直接丢弃：快速连翻几页时只有最后一页会被贴上去。
 */
async function showCurrent(strict = false) {
  const view = renderer.value
  const cv = canvas.value
  const be = backend.value
  if (!view || !cv || !be) return
  const index = current.value
  const ratio = dprNow()
  const targetScale = scale.value
  const token = ++paintSeq
  let rendered = view.cached(index, targetScale, ratio)
  if (!rendered) {
    // 当前页优先：后台队列让路
    queue?.pause()
    try {
      rendered = await view.render(index, targetScale, ratio)
    } catch (error) {
      if (token === paintSeq) {
        pageError.value = `第 ${index + 1} 张画不出来：${error instanceof Error ? error.message : String(error)}`
        queue?.resume()
      }
      if (strict) throw error
      return
    }
    queue?.resume()
  }
  if (token !== paintSeq || disposed) return
  pageError.value = ''
  // 同一个任务里改尺寸再贴图，中间不会有一帧空白
  cv.width = rendered.width
  cv.height = rendered.height
  cv.getContext('2d')?.drawImage(rendered.canvas as CanvasImageSource, 0, 0)
  currentFrame = rendered.frame
  srText.value = [currentTitle.value, be.slideText(index)].filter(Boolean).join('\n')
  paintedCount.value += 1
  refreshHighlights()
}

watch(current, (_now, before) => {
  // 先把上一页没提交的备注写回去（这时 current 已经变了，按旧页号写）
  commitNotes(before)
  pageDraft.value = String(current.value + 1)
  pageError.value = ''
  if (editor.value) {
    editor.value.clearSelection()
    editor.value.refresh()
  }
  notesDraft.value = currentNotes.value
  emit('slide', current.value)
  void showCurrent().then(scheduleBackground)
  void nextTick(() => rail.value?.querySelector<HTMLElement>('.is-on')?.scrollIntoView?.({ block: 'nearest' }))
})

/* ---------------- 后台：相邻页预渲染 + 缩略图 ---------------- */

const pageKeys = () => slides.value.map((_, i) => `p:${i}`)

function scheduleBackground() {
  if (!queue || !backend.value || phase.value !== 'ready') return
  const n = slides.value.length
  const at = current.value
  queue.invalidate(pageKeys())
  const keys: string[] = []
  for (const delta of [1, -1, 2]) {
    const i = at + delta
    if (i >= 0 && i < n) keys.push(`p:${i}`)
  }
  if (railOpen.value) for (const i of nearestFirst(n, at)) keys.push(`t:${i}`)
  queue.setOrder(keys)
}

async function runJob(key: string) {
  const [kind, raw] = key.split(':')
  const index = Number(raw)
  if (kind === 'p') {
    await renderer.value?.render(index, scale.value, dprNow())
    return
  }
  await renderThumb(index)
}

async function renderThumb(index: number) {
  const be = backend.value
  const target = thumbs.get(index)
  if (!be || !target) return
  const thumbScale = THUMB_WIDTH / Math.max(1, be.size.width)
  const ratio = Math.min(dprNow(), THUMB_DPR_CAP)
  const px = pixelSize(be.size, thumbScale, ratio)
  const frame = await be.frame(index)
  const off = document.createElement('canvas')
  off.width = px.width
  off.height = px.height
  const ctx = off.getContext('2d')
  if (!ctx) return
  await frame.paint(ctx, ratio, paintScale(be.size, thumbScale, ratio))
  if (disposed || thumbs.get(index) !== target) return
  target.width = px.width
  target.height = px.height
  target.getContext('2d')?.drawImage(off, 0, 0)
  off.width = 0
  off.height = 0
}

function setThumb(index: number, el: unknown) {
  if (el instanceof HTMLCanvasElement) thumbs.set(index, el)
  else thumbs.delete(index)
}

/* ---------------- 导航 ---------------- */

function goTo(target: number) {
  if (phase.value !== 'ready') return
  const index = clampIndex(target)
  if (index !== current.value) current.value = index
}
function pick(index: number) {
  goTo(index)
  if (compact.value) {
    railTouched = true
    railOpen.value = false
  }
}
function commitPageDraft() {
  const value = Number(pageDraft.value)
  if (Number.isFinite(value) && value >= 1) goTo(value - 1)
  pageDraft.value = String(current.value + 1)
}
function toggleRail() {
  railTouched = true
  railOpen.value = !railOpen.value
}
function toggleNotes() {
  notesOpen.value = !notesOpen.value
}
watch(railOpen, (open) => {
  if (open) scheduleBackground()
})

function canScroll(axis: 'x' | 'y'): boolean {
  const el = stage.value
  if (!el) return false
  return axis === 'x' ? el.scrollWidth > el.clientWidth + 1 : el.scrollHeight > el.clientHeight + 1
}

function onKeydown(event: KeyboardEvent) {
  if (presenting.value || event.ctrlKey || event.metaKey || event.altKey) return
  const target = event.target as HTMLElement | null
  if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
  // 编辑态：选中形状时方向键是微调、Delete 是删除，没选中时才轮到翻页
  if (editor.value?.shapeKeyDown(event)) {
    event.preventDefault()
    return
  }
  const key = event.key
  const step = (to: number) => {
    event.preventDefault()
    goTo(to)
  }
  if (key === 'PageDown') step(current.value + 1)
  else if (key === 'PageUp') step(current.value - 1)
  else if (key === 'Home') step(0)
  else if (key === 'End') step(slideCount.value - 1)
  else if (key === 'ArrowRight' && !canScroll('x')) step(current.value + 1)
  else if (key === 'ArrowLeft' && !canScroll('x')) step(current.value - 1)
  else if (key === 'ArrowDown' && !canScroll('y')) step(current.value + 1)
  else if (key === 'ArrowUp' && !canScroll('y')) step(current.value - 1)
  else if (key === ' ' && target === stage.value) step(current.value + (event.shiftKey ? -1 : 1))
  else if (key === '+' || key === '=') {
    event.preventDefault()
    zoomStep(1)
  } else if (key === '-') {
    event.preventDefault()
    zoomStep(-1)
  } else if (key === '0') {
    event.preventDefault()
    fitPage()
  }
}

/** 触屏横滑翻页：只在整页都看得见（没有横向滚动）时启用，放大后横滑是平移 */
function onPointerDown(event: PointerEvent) {
  if (event.pointerType !== 'touch') return
  touchStart = { x: event.clientX, y: event.clientY, t: performance.now(), id: event.pointerId }
}
function onPointerUp(event: PointerEvent) {
  const start = touchStart
  touchStart = null
  if (!start || start.id !== event.pointerId || canScroll('x')) return
  const gesture = classifyGesture({ dx: event.clientX - start.x, dy: event.clientY - start.y, dt: performance.now() - start.t })
  if (gesture === 'next') goTo(current.value + 1)
  else if (gesture === 'prev') goTo(current.value - 1)
}

/* ---------------- 放映 ---------------- */

function startPresent(from = current.value) {
  if (phase.value !== 'ready') return
  current.value = clampIndex(from)
  presenting.value = true
}
function endPresent(index: number) {
  presenting.value = false
  goTo(index)
  void nextTick(() => stage.value?.focus({ preventScroll: true }))
}

/* ---------------- 命中与查找高亮 ---------------- */

/**
 * 定位到检索命中。`slideNo`（1 起）和 `hitTextArg` 缺省时取组件属性；宿主在同一份文档里换了命中（点另一条搜索结果）
 * 会通过 `reveal` 带着新的页码和文字再来一次，不用重开文档。
 */
async function showHit(slideNo: number | null = props.hitSlide, hitTextArg: string = props.hitText) {
  hitMatch = null
  hitFound.value = null
  const text = hitTextArg?.trim()
  const be = backend.value
  if (!be || phase.value !== 'ready') return
  if (slideNo) goTo(slideNo - 1)
  if (!text) {
    refreshHighlights()
    return
  }
  // 有页码就只认那一页；没有页码（命中块没带锚点）就取全文第一处，并翻到那里
  const wanted = slideNo ? slideNo - 1 : null
  // 查找可能要问 Worker（异步）：期间又来了新的命中请求，旧结果作废
  const seq = ++hitSeq
  let found: SlideMatch | undefined
  for (const candidate of hitCandidates(text)) {
    found = (await be.search(candidate)).find((match) => wanted === null || match.slide === wanted)
    if (found) break
  }
  if (seq !== hitSeq || disposed) return
  hitMatch = found ?? null
  if (hitMatch && hitMatch.slide !== current.value) goTo(hitMatch.slide)
  hitFound.value = !!hitMatch
  refreshHighlights()
}
let hitSeq = 0
watch(
  () => [props.hitText, props.hitSlide],
  () => void nextTick(() => void showHit()),
)

function refreshHighlights() {
  const frame = currentFrame
  const list: { rect: SlideRect; active: boolean }[] = []
  if (frame?.textRects) {
    const activeMatch = matches[find.value.index]
    for (const match of matches) {
      if (match.slide !== current.value) continue
      for (const rect of frame.textRects(match)) list.push({ rect, active: match === activeMatch })
    }
    if (hitMatch && hitMatch.slide === current.value && !matches.length) {
      for (const rect of frame.textRects(hitMatch)) list.push({ rect, active: true })
    }
  }
  highlights.value = list
}

async function runFind(query: string): Promise<{ total: number; index: number }> {
  matches = []
  find.value = { query, total: 0, index: -1 }
  const be = backend.value
  if (!query.trim() || !be || phase.value !== 'ready') {
    refreshHighlights()
    return { total: 0, index: -1 }
  }
  // 查找可能要问 Worker（异步）：期间又发起了新的查找 / 清除，旧结果直接丢弃
  const seq = ++findSeq
  const found = await be.search(query)
  if (seq !== findSeq || disposed) return { total: find.value.total, index: find.value.index }
  matches = found
  const first = matches.findIndex((match) => match.slide >= current.value)
  find.value = { query, total: matches.length, index: matches.length ? Math.max(0, first) : -1 }
  revealFindMatch()
  return { total: find.value.total, index: find.value.index }
}
let findSeq = 0
function findStep(previous = false): { total: number; index: number } {
  const total = matches.length
  if (!total) return { total: 0, index: -1 }
  const index = (find.value.index + (previous ? -1 : 1) + total) % total
  find.value = { ...find.value, index }
  revealFindMatch()
  return { total, index }
}
function revealFindMatch() {
  const match = matches[find.value.index]
  if (match && match.slide !== current.value) goTo(match.slide)
  else refreshHighlights()
}
function clearFind() {
  findSeq += 1
  matches = []
  find.value = { query: '', total: 0, index: -1 }
  refreshHighlights()
}

/* ---------------- 内容变化（编辑 / 撤销 / 协同） ---------------- */

/** 后端内容变了：重新取目录，旧位图全部作废，重画当前页 */
function invalidate() {
  const be = backend.value
  if (!be) return
  slides.value = be.slides()
  if (current.value >= slides.value.length) current.value = Math.max(0, slides.value.length - 1)
  renderer.value?.invalidate()
  queue?.invalidate()
  notices.value = [...(be.notices?.() ?? [])]
  void showCurrent().then(scheduleBackground)
}

/* ---------------- 编辑 ---------------- */

/** 后端是编辑后端就建控制器、订阅它的变化 */
function attachEditing(loaded: SlideBackend) {
  if (!isEditBackend(loaded)) return
  editor.value = new SlideEditor({
    backend: loaded,
    index: () => current.value,
    scale: () => scale.value,
    gotoSlide: (index) => goTo(index),
  })
  notesDraft.value = loaded.slides()[current.value]?.notes ?? ''
  offBackendChange = loaded.onChange((change) => onEditChange(change))
  const collab = loaded.collab
  if (collab) {
    peers.value = collab.peers()
    offPeers = collab.onPeers(() => (peers.value = collab.peers()))
    announceCursor()
  }
}

/** 内容变了：重读目录、让受影响的页的位图作废、重画当前页，缩略图在后台补 */
function onEditChange(change: EditChange) {
  const be = backend.value
  if (!be || disposed) return
  // 只是状态变了（只读标志）：控制器自己订阅了后端会刷新，这里不用重画
  if (change.state) return
  slides.value = be.slides()
  if (current.value >= slides.value.length) current.value = Math.max(0, slides.value.length - 1)
  if (change.slides === 'all') {
    renderer.value?.invalidate()
    queue?.invalidate()
  } else {
    renderer.value?.invalidate(change.slides)
    queue?.invalidate(change.slides.flatMap((i) => [`p:${i}`, `t:${i}`]))
  }
  if (!notesFocused) notesDraft.value = currentNotes.value
  void showCurrent().then(scheduleBackground)
  emit('change', change)
}

let notesFocused = false
function onNotesFocus() {
  notesFocused = true
}
function onNotesBlur() {
  notesFocused = false
  commitNotes()
}
function onNotesInput(event: Event) {
  notesDraft.value = (event.target as HTMLTextAreaElement).value
  window.clearTimeout(notesTimer)
  notesTimer = window.setTimeout(() => commitNotes(), 600)
}
/** 备注写回；`page` 缺省 = 当前页（切页时传旧页号） */
function commitNotes(page = current.value) {
  window.clearTimeout(notesTimer)
  const active = editor.value
  const be = backend.value
  if (!active || !be || !isEditBackend(be) || active.readonly) return
  const summary = slides.value[page]
  if (!summary || summary.notes === notesDraft.value) return
  // setNotes 用当前页号：切页后要按旧页写，所以临时借 backend 直接写
  if (page === current.value) active.setNotes(notesDraft.value)
  else
    try {
      be.boundary()
      be.setNotes(page, notesDraft.value)
    } catch {
      /* 页已经不在了（被删除 / 移动）：草稿作废 */
    }
}

async function onPickImage(file: File, replace: boolean) {
  const active = editor.value
  if (!active) return
  try {
    const image = await readImageFile(file)
    if (replace) active.replacePicture(image)
    else active.insertPicture(image)
  } catch (error) {
    active.notice.value = error instanceof Error ? error.message : String(error)
  }
}

/** 把自己的位置（当前页 + 选中的形状）告诉别人 */
function announceCursor() {
  const be = backend.value
  if (!be || !isEditBackend(be) || !be.collab || phase.value !== 'ready') return
  be.collab.setCursor(current.value, editor.value?.selected.value.at(-1) ?? null)
}
watch(
  () => [current.value, editor.value?.selected.value.join(',') ?? ''],
  () => announceCursor(),
)

function undo(): boolean {
  return editor.value?.undo() ?? false
}
function redo(): boolean {
  return editor.value?.redo() ?? false
}

/* ---------------- 生命周期 ---------------- */

watch(
  () => props.load,
  () => void open(),
)

onMounted(() => void open())
onBeforeUnmount(() => {
  disposed = true
  abort?.abort()
  commitNotes()
  window.clearTimeout(repaintTimer)
  window.clearTimeout(notesTimer)
  resizeObserver?.disconnect()
  offBackendChange?.()
  offPeers?.()
  editor.value?.dispose()
  editor.value = null
  queue?.dispose()
  renderer.value?.dispose()
  const be = backend.value
  backend.value = null
  renderer.value = null
  thumbs.clear()
  currentFrame = null
  if (be) void Promise.resolve(be.dispose()).catch(() => undefined)
})

defineExpose({
  find: runFind,
  findStep,
  clearFind,
  getFindState: () => ({ ...find.value }),
  getFindMatches: () => matches.slice(),
  goTo,
  getSlide: () => current.value,
  getSlides: () => slides.value,
  getScale: () => scale.value,
  getBackend: () => backend.value,
  zoomStep,
  zoomBy,
  fit: fitPage,
  present: startPresent,
  toggleNotes,
  toggleRail,
  invalidate,
  reveal: (slideNo: number, text = '') => showHit(slideNo, text),
  undo,
  redo,
  getEditor: () => editor.value,
  refreshEditor: () => editor.value?.refresh(),
  isPresenting: () => presenting.value,
  getNotesOpen: () => notesOpen.value,
  focus: () => stage.value?.focus({ preventScroll: true }),
})
</script>

<template>
  <div
    ref="root"
    class="kb-sl"
    :class="{ 'is-rail': railOpen, 'is-compact': compact }"
    data-testid="slide-surface"
    :data-state="phase"
    :data-slide="current"
    :data-painted="paintedCount"
    :data-editing="editor ? (editor.readonly ? 'readonly' : 'true') : undefined"
    @keydown="onKeydown"
  >
    <ViewerToolbar label="幻灯片工具栏">
      <template #start>
        <button
          type="button"
          class="btn sm kb-sl-btn"
          :class="{ ac: railOpen }"
          :aria-pressed="railOpen"
          aria-label="幻灯片目录"
          title="幻灯片目录"
          data-testid="slide-rail-toggle"
          :disabled="phase !== 'ready'"
          @click="toggleRail"
        >
          <KbIcon name="list" :size="12" />
        </button>
        <span class="kb-sl-group">
          <button type="button" class="btn sm kb-sl-btn" aria-label="上一张" data-testid="slide-prev" :disabled="phase !== 'ready' || current <= 0" @click="goTo(current - 1)">
            <KbIcon name="chevron" :size="12" class="kb-sl-prev" />
          </button>
          <input
            v-model="pageDraft"
            class="kb-sl-page mono"
            inputmode="numeric"
            aria-label="当前页"
            data-testid="slide-page"
            :disabled="phase !== 'ready'"
            @keydown.enter.prevent="commitPageDraft"
            @blur="commitPageDraft"
          />
          <span class="mono kb-sl-total" data-testid="slide-total">/ {{ slideCount || '—' }}</span>
          <button type="button" class="btn sm kb-sl-btn" aria-label="下一张" data-testid="slide-next" :disabled="phase !== 'ready' || current >= slideCount - 1" @click="goTo(current + 1)">
            <KbIcon name="chevron" :size="12" class="kb-sl-next" />
          </button>
        </span>
      </template>
      <template #center>
        <span class="kb-sl-group">
          <button type="button" class="btn sm kb-sl-btn kb-sl-zoom-step" aria-label="缩小" :disabled="phase !== 'ready'" @click="zoomStep(-1)"><KbIcon name="minus" :size="12" /></button>
          <button type="button" class="mono kb-sl-zoom" title="恢复适应页面" data-testid="slide-zoom" :disabled="phase !== 'ready'" @click="fitPage()">{{ percent }}%</button>
          <button type="button" class="btn sm kb-sl-btn kb-sl-zoom-step" aria-label="放大" :disabled="phase !== 'ready'" @click="zoomStep(1)"><KbIcon name="plus" :size="12" /></button>
        </span>
        <span v-if="hitFound === false" class="tag" title="命中的句子不在这一页的可见文字里（多半是演讲者备注或图片中的文字）">命中在备注或图片中</span>
      </template>
      <template #tools>
        <button
          v-if="notesAvailable"
          type="button"
          class="btn sm kb-sl-btn"
          :class="{ ac: notesOpen }"
          :aria-pressed="notesOpen"
          data-testid="slide-notes-toggle"
          :disabled="phase !== 'ready'"
          @click="toggleNotes"
        >
          <KbIcon name="note" :size="12" /><span class="kb-sl-text">备注</span>
        </button>
        <button type="button" class="btn sm kb-sl-btn" aria-label="放映" title="从当前页放映" data-testid="slide-present-btn" :disabled="phase !== 'ready'" @click="startPresent()">
          <KbIcon name="play" :size="12" /><span class="kb-sl-text">放映</span>
        </button>
        <slot name="tools" />
      </template>
    </ViewerToolbar>

    <SlideEditBar v-if="editor" :editor="editor" @pick-image="onPickImage" />

    <div v-if="notices.length" class="kb-sl-notice" role="status" data-testid="slide-notice">{{ notices.join('；') }}</div>

    <div class="kb-sl-body">
      <aside v-show="railOpen && phase === 'ready'" ref="rail" class="kb-sl-rail" aria-label="幻灯片目录" data-testid="slide-rail">
        <div v-if="editor" class="kb-sl-railtools" role="toolbar" aria-label="页操作">
          <button type="button" class="btn sm" data-testid="slide-new" :disabled="editor.readonly" title="在当前页之后新建一页" @click="editor.insertSlide()">新建</button>
          <button type="button" class="btn sm" data-testid="slide-dup" :disabled="editor.readonly" title="复制当前页" @click="editor.duplicateSlide()">复制</button>
          <button type="button" class="btn sm" data-testid="slide-del" :disabled="editor.readonly || slideCount <= 1" title="删除当前页（可撤销）" @click="editor.deleteSlide()">删除</button>
          <button type="button" class="btn sm" data-testid="slide-up" :disabled="editor.readonly || current <= 0" title="当前页上移" @click="editor.moveSlide(-1)">上移</button>
          <button type="button" class="btn sm" data-testid="slide-down" :disabled="editor.readonly || current >= slideCount - 1" title="当前页下移" @click="editor.moveSlide(1)">下移</button>
        </div>
        <button
          v-for="(slide, i) in slides"
          :key="slide.id"
          type="button"
          class="kb-sl-thumb"
          :class="{ 'is-on': i === current, 'is-hidden': slide.hidden }"
          :aria-current="i === current ? 'true' : undefined"
          data-testid="slide-thumb"
          @click="pick(i)"
        >
          <canvas :ref="(el) => setThumb(i, el)" class="kb-sl-thumb-canvas" aria-hidden="true" :style="{ width: `${THUMB_WIDTH}px`, height: `${thumbHeight}px` }"></canvas>
          <span class="kb-sl-thumb-meta">
            <span class="mono kb-sl-thumb-no">{{ i + 1 }}</span>
            <span class="kb-sl-thumb-title">{{ slide.title || `第 ${i + 1} 张` }}</span>
            <span v-if="peerPages.get(i)?.length" class="kb-sl-peers" data-testid="slide-thumb-peers" :title="`正在看这一页：${peerPages.get(i)!.map((p) => p.name).join('、')}`">
              <i v-for="p in peerPages.get(i)!.slice(0, 3)" :key="p.id" class="kb-sl-peerdot" :style="{ background: p.color }" aria-hidden="true">{{ peerInitial(p.name) }}</i>
            </span>
            <span v-if="slide.hidden" class="kb-sl-vh">（放映时隐藏）</span>
          </span>
        </button>
      </aside>
      <div v-if="railOpen && compact && phase === 'ready'" class="kb-sl-scrim" @click="toggleRail"></div>

      <div class="kb-sl-main">
        <div
          ref="stage"
          class="kb-sl-stage"
          :class="{ 'is-fit': fit === 'page' }"
          tabindex="0"
          aria-label="幻灯片"
          data-testid="slide-stage"
          @wheel="onWheel"
          @dblclick="onDoubleClick"
          @pointerdown="onPointerDown"
          @pointerup="onPointerUp"
        >
          <div class="kb-sl-pad">
            <div class="kb-sl-sheet" :style="{ width: `${sheet.width}px`, height: `${sheet.height}px` }">
              <canvas
                ref="canvas"
                class="kb-sl-canvas"
                role="img"
                :aria-label="canvasLabel"
                data-testid="slide-canvas"
                :style="{ width: `${sheet.width}px`, height: `${sheet.height}px` }"
              ></canvas>
              <SlideOverlay :scale="scale" :width="sheet.width" :height="sheet.height" :highlights="highlights" />
              <SlidePresence v-if="peerBoxes.length" :boxes="peerBoxes" :scale="scale" />
              <SlideEditLayer v-if="editor && !editor.readonly" :editor="editor" :scale="scale" :width="sheet.width" :height="sheet.height" :slide-width="size.width" />
              <div v-if="pageError" class="kb-sl-page-error" role="alert" data-testid="slide-page-error">{{ pageError }}</div>
            </div>
          </div>
        </div>
        <div class="kb-sl-sr" aria-live="polite" data-testid="slide-sr">{{ srText }}</div>

        <section v-if="notesOpen && notesAvailable" class="kb-sl-notes" aria-label="演讲者备注" data-testid="slide-notes">
          <header class="kb-sl-notes-head">
            <b>第 {{ current + 1 }} 张 · 演讲者备注</b>
            <button type="button" class="btn sm" @click="toggleNotes">收起备注</button>
          </header>
          <textarea
            v-if="editor && !editor.readonly"
            class="kb-sl-notes-edit"
            data-testid="slide-notes-edit"
            aria-label="编辑演讲者备注"
            placeholder="点这里写备注"
            rows="3"
            :value="notesDraft"
            @input="onNotesInput"
            @focus="onNotesFocus"
            @blur="onNotesBlur"
          ></textarea>
          <p v-else-if="currentNotes.trim()" class="kb-sl-notes-text">{{ currentNotes }}</p>
          <p v-else class="kb-sl-notes-text kb-sl-notes-empty">这一页没有备注</p>
        </section>
      </div>
    </div>

    <div v-if="phase === 'loading'" class="kb-sl-state" role="status" data-testid="slide-loading">
      <div class="kb-sl-progress"><i :style="{ width: `${Math.max(6, Math.round(progress * 100))}%` }"></i></div>
      <span class="m">正在加载演示文稿…</span>
    </div>
    <div v-else-if="phase === 'error'" class="kb-sl-state" role="alert" data-testid="slide-error">
      <span>{{ errorMessage }}</span>
    </div>

    <SlidePresent v-if="presenting && backend && renderer" :backend="backend" :renderer="renderer" :slides="slides" :start="current" @exit="endPresent" @change="current = $event" />
  </div>
</template>

<style>
.kb-sl {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--surface-sunken);
  overflow: hidden;
}
.kb-sl-group {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.kb-sl-btn {
  flex: none;
  min-width: var(--ctl-h);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}
.kb-sl-prev {
  transform: rotate(90deg);
}
.kb-sl-next {
  transform: rotate(-90deg);
}
.kb-sl-page {
  width: 3.2em;
  height: var(--ctl-h);
  padding: 0 4px;
  text-align: center;
  color: var(--text-primary);
  background: var(--surface-1);
  border: var(--hl) solid var(--border-subtle);
  border-radius: var(--r1);
}
.kb-sl-total {
  color: var(--text-secondary);
  font-size: calc(12px * var(--fs));
  min-width: 4ch;
}
.kb-sl-zoom {
  min-width: 5ch;
  height: var(--ctl-h);
  padding: 0 6px;
  color: var(--text-secondary);
  background: transparent;
  border: 0;
  border-radius: var(--r1);
  cursor: pointer;
  font-size: calc(12px * var(--fs));
}
.kb-sl-zoom:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--surface-hover);
}
.kb-sl-notice {
  flex: none;
  padding: 6px 12px;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--status-warning) 8%, var(--surface-1));
  border-bottom: var(--hl) solid var(--border-subtle);
  font-size: calc(12px * var(--fs));
}
.kb-sl-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}
.kb-sl-rail {
  flex: none;
  width: 184px;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--surface-1);
  border-right: var(--hl) solid var(--border-subtle);
  box-sizing: border-box;
}
.kb-sl.is-compact .kb-sl-rail {
  position: absolute;
  z-index: 3;
  top: 0;
  bottom: 0;
  left: 0;
  width: min(220px, 72%);
  box-shadow: var(--sh3);
}
.kb-sl-scrim {
  position: absolute;
  inset: 0;
  z-index: 2;
  background: rgba(var(--shade), 0.35);
}
.kb-sl-thumb {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 6px;
  color: var(--text-secondary);
  background: transparent;
  border: 1.5px solid transparent;
  border-radius: var(--r1);
  cursor: pointer;
  text-align: left;
}
.kb-sl-thumb:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}
.kb-sl-thumb.is-on {
  color: var(--text-primary);
  background: var(--accent-soft);
  border-color: var(--accent);
}
.kb-sl-thumb.is-hidden .kb-sl-thumb-canvas {
  opacity: 0.45;
}
.kb-sl-thumb-canvas {
  display: block;
  background: #fff;
  border: var(--hl) solid var(--border-subtle);
  box-shadow: var(--sh1);
}
.kb-sl-thumb-meta {
  align-self: stretch;
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.kb-sl-thumb-no {
  flex: none;
  min-width: 2ch;
  color: var(--text-tertiary);
  font-size: calc(11px * var(--fs));
}
.kb-sl-thumb-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(12px * var(--fs));
}
.kb-sl-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.kb-sl-stage {
  flex: 1;
  min-height: 0;
  overflow: auto;
  outline: none;
  /* 整页可见（适应页面）时横滑留给我们翻页；放大后横向平移交给浏览器 */
  touch-action: pan-x pan-y pinch-zoom;
}
.kb-sl-stage.is-fit {
  touch-action: pan-y pinch-zoom;
}
.kb-sl-stage:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.kb-sl-pad {
  box-sizing: border-box;
  min-width: 100%;
  min-height: 100%;
  width: max-content;
  padding: 16px;
  display: flex;
}
.kb-sl.is-compact .kb-sl-pad {
  padding: 8px;
}
.kb-sl-sheet {
  position: relative;
  flex: none;
  /* 比视口小就居中，比视口大就从左上角开始（margin:auto 在溢出时不会把内容推到负坐标） */
  margin: auto;
  background: #fff;
  box-shadow: var(--sh2);
}
.kb-sl-canvas {
  display: block;
  background: #fff;
}
.kb-sl-page-error {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  text-align: center;
  color: var(--text-primary);
  background: color-mix(in srgb, var(--surface-1) 88%, transparent);
  font-size: calc(13px * var(--fs));
}
.kb-sl-sr,
.kb-sl-vh {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: pre-wrap;
  border: 0;
}
.kb-sl-notes {
  flex: none;
  max-height: 30%;
  overflow: auto;
  padding: 8px 14px 10px;
  background: var(--surface-1);
  border-top: var(--hl) solid var(--border-subtle);
  font-size: calc(13px * var(--fs));
}
.kb-sl-notes-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.kb-sl-notes-text {
  margin: 4px 0 0;
  color: var(--text-secondary);
  white-space: pre-wrap;
}
.kb-sl-notes-empty {
  color: var(--text-tertiary);
}
.kb-sl-notes-edit {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin-top: 4px;
  padding: 6px 8px;
  color: var(--text-primary);
  background: var(--surface-sunken);
  border: var(--hl) solid var(--border-subtle);
  border-radius: var(--r1);
  font: inherit;
  resize: vertical;
}
.kb-sl-railtools {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding-bottom: 6px;
  border-bottom: var(--hl) solid var(--border-subtle);
}
.kb-sl-state {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  text-align: center;
  background: var(--surface-sunken);
}
.kb-sl-progress {
  width: min(240px, 60%);
  height: 4px;
  background: var(--chart-track);
  border-radius: var(--r-pill);
  overflow: hidden;
}
.kb-sl-progress i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width var(--dur-base) var(--ease-out);
}
@media (pointer: coarse) {
  .kb-sl-btn,
  .kb-sl-zoom {
    min-height: 36px;
    min-width: 36px;
  }
  .kb-sl-thumb {
    min-height: 44px;
  }
}
@media (max-width: 520px) {
  .kb-sl-text,
  .kb-sl-zoom-step {
    display: none;
  }
}
</style>
