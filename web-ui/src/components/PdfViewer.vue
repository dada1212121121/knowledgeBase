<script setup lang="ts">
// PDF 查看器(pdf.js,Apache-2.0):真实页面渲染 + 文字层(可选中复制)+ 链接 + 查找高亮。
//   - 原件直接交给 pdf.js 按 URL 加载:服务端 `/download` 支持 Range,首屏只取需要的段,
//     不再像以前那样先 `fetch` 整份 PDF 到 ArrayBuffer(大扫描件在慢网下会卡几十秒);
//   - 页面由 pdf_viewer 虚拟化渲染:只画可见页,几百页的 PDF 也不卡;
//   - 缩放:适应宽度(默认,宽屏封顶 1.6×)/ ± / Ctrl+滚轮 / 双指捏合;
//   - 缩略图:宽屏常驻左侧,窄屏是抽屉;
//   - 命中联动:`hitText` + `hitPage` 让搜索结果的句子在页面上高亮并翻到那一页;
//   - 深色主题下可「反色阅读」(只反转页面位图,文字层不受影响)。
// 失败(加密 / 损坏 / 过大 / 无权限)时 emit('error'),由外层退回文字层视图。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { KbIcon, isComposing } from '@kb-ui/index'
import ViewerToolbar from '@/components/ViewerToolbar.vue'
import 'pdfjs-dist/legacy/web/pdf_viewer.css'
import { documentParams, loadPdfJs, type PdfJsLib, type PdfViewerModule } from '@/utils/pdfjs'

const props = defineProps<{
  url: string
  /** 命中的句子(搜索结果联动);为空则不高亮 */
  hitText?: string
  /** 命中所在页(1 起) */
  hitPage?: number | null
  /** 统一外壳已提供查找栏时，隐藏查看器自己的查找入口，避免两个查找状态各算一套计数 */
  hideFind?: boolean
}>()
const emit = defineEmits<{
  ready: [pages: number]
  error: [message: string]
  page: [page: number]
}>()

type Phase = 'loading' | 'ready' | 'error'
const phase = ref<Phase>('loading')
const errorMessage = ref('')
const progress = ref(0)

const pane = ref<HTMLElement | null>(null)
const container = ref<HTMLDivElement | null>(null)
const viewerEl = ref<HTMLDivElement | null>(null)
const thumbsEl = ref<HTMLElement | null>(null)

const pages = ref(0)
const page = ref(1)
const pageDraft = ref('1')
const scale = ref(1)
const fitMode = ref(true)
const thumbsOpen = ref(false)
let thumbsTouched = false
const compactThumbs = ref(false)
const findOpen = ref(false)
const findQuery = ref('')
const findInput = ref<HTMLInputElement | null>(null)
const matches = ref({ current: 0, total: 0 })
const notFound = ref(false)
const hitActive = ref(false)
const aspect = ref(1.414)

const INVERT_KEY = 'kb.pdf.invert'
const invert = ref(readInvert())
function readInvert(): boolean {
  try {
    return localStorage.getItem(INVERT_KEY) === '1'
  } catch {
    return false
  }
}
function toggleInvert() {
  invert.value = !invert.value
  try {
    localStorage.setItem(INVERT_KEY, invert.value ? '1' : '0')
  } catch {
    /* 隐私模式 */
  }
}

let lib: PdfJsLib | null = null
let viewerLib: PdfViewerModule | null = null
let pdfDoc: Awaited<ReturnType<PdfJsLib['getDocument']>['promise']> | null = null
let loadingTask: ReturnType<PdfJsLib['getDocument']> | null = null
let eventBus: InstanceType<PdfViewerModule['EventBus']> | null = null
let pdfViewer: InstanceType<PdfViewerModule['PDFViewer']> | null = null
let resizeObserver: ResizeObserver | null = null
let thumbObserver: IntersectionObserver | null = null
const renderedThumbs = new Set<number>()
let disposed = false

const MIN_SCALE = 0.4
const MAX_SCALE = 5
const FIT_CAP = 1.6
const clampScale = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
const scaleLabel = computed(() => `${Math.round(scale.value * 100)}%`)

function fail(message: string) {
  phase.value = 'error'
  errorMessage.value = message
  emit('error', message)
}

function describe(error: unknown): string {
  const name = (error as { name?: string })?.name
  const status = Number((error as { status?: unknown })?.status)
  if (status === 401 || status === 403) return '没有权限读取这份 PDF,请重新登录后再试'
  if (status === 404) return '找不到 PDF 文件'
  if (status === 413) return 'PDF 文件太大,无法在页内打开'
  if (status === 416) return 'PDF 文件读取失败(服务器不支持分段读取)'
  if (name === 'PasswordException') return '这份 PDF 有密码保护,页内无法渲染'
  if (name === 'InvalidPDFException') return 'PDF 文件已损坏或不是有效的 PDF'
  if (name === 'MissingPDFException') return '找不到 PDF 文件'
  return 'PDF 渲染失败'
}

async function load() {
  teardown()
  disposed = false
  phase.value = 'loading'
  progress.value = 0
  try {
    const loaded = await loadPdfJs()
    if (disposed) return
    lib = loaded.pdfjs
    viewerLib = loaded.viewer
    // 直接把 URL 交给 pdf.js:它自己发 Range 请求,首屏不必等整份文件下载完。
    // 服务端 `/api/v1/download` 无 64 MB 上限并支持单段 Range;分享页的 `/raw` 仍是整份。
    loadingTask = lib.getDocument(documentParams(props.url))
    loadingTask.onProgress = ({ loaded: done, total }: { loaded: number; total: number }) => {
      if (!disposed) progress.value = total ? done / total : 0
    }
    pdfDoc = await loadingTask.promise
    if (disposed || !container.value || !viewerEl.value) return
    await setupViewer()
  } catch (error) {
    if (disposed || (error as Error)?.name === 'AbortError') return
    fail(describe(error))
  }
}

async function setupViewer() {
  if (!viewerLib || !pdfDoc || !container.value || !viewerEl.value) return
  const { EventBus, PDFViewer, PDFLinkService, PDFFindController, LinkTarget } = viewerLib
  eventBus = new EventBus()
  const linkService = new PDFLinkService({
    eventBus,
    externalLinkTarget: LinkTarget.BLANK,
    externalLinkRel: 'noopener noreferrer nofollow',
  })
  const findController = new PDFFindController({ linkService, eventBus })
  pdfViewer = new PDFViewer({
    container: container.value,
    viewer: viewerEl.value,
    eventBus,
    linkService,
    findController,
    textLayerMode: 1,
  })
  linkService.setViewer(pdfViewer)
  eventBus.on('pagesinit', () => {
    if (disposed) return
    applyFit()
    pages.value = pdfDoc!.numPages
    phase.value = 'ready'
    emit('ready', pages.value)
    void nextTick(() => {
      observeThumbs()
      void showHit()
    })
  })
  eventBus.on('pagechanging', (event: { pageNumber: number }) => {
    page.value = event.pageNumber
    pageDraft.value = String(event.pageNumber)
    emit('page', event.pageNumber)
    thumbsEl.value?.querySelector(`[data-page="${event.pageNumber}"]`)?.scrollIntoView({ block: 'nearest' })
  })
  eventBus.on('scalechanging', (event: { scale: number }) => (scale.value = event.scale))
  eventBus.on('updatefindmatchescount', (event: { matchesCount: { current: number; total: number } }) => {
    matches.value = { ...event.matchesCount }
  })
  eventBus.on('updatefindcontrolstate', (event: { state: number; matchesCount: { current: number; total: number } }) => {
    matches.value = { ...event.matchesCount }
    notFound.value = event.state === 1 // FindState.NOT_FOUND
  })
  linkService.setDocument(pdfDoc)
  pdfViewer.setDocument(pdfDoc)
  const first = await pdfDoc.getPage(1)
  const viewport = first.getViewport({ scale: 1 })
  aspect.value = viewport.height / viewport.width
  watchSize()
}

/** 适应宽度;宽屏上封顶,免得一页 A4 被放成 2 倍高 */
function applyFit() {
  if (!pdfViewer) return
  pdfViewer.currentScaleValue = 'page-width'
  if (pdfViewer.currentScale > FIT_CAP) pdfViewer.currentScale = FIT_CAP
}

let resizeTimer = 0
function watchSize() {
  const element = pane.value
  if (!element || typeof ResizeObserver === 'undefined') return
  resizeObserver?.disconnect()
  resizeObserver = new ResizeObserver(() => {
    measurePane(element)
    window.clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(() => {
      if (fitMode.value && phase.value === 'ready') applyFit()
    }, 120)
  })
  resizeObserver.observe(element)
  measurePane(element)
}
/** 窗格宽(不是视口宽)决定缩略图是常驻列还是抽屉;没手动开关过时,宽的默认展开、窄的默认收起 */
function measurePane(element: HTMLElement) {
  compactThumbs.value = element.clientWidth < 760
  if (!thumbsTouched) thumbsOpen.value = !compactThumbs.value
}
function toggleThumbs() {
  thumbsTouched = true
  thumbsOpen.value = !thumbsOpen.value
}

function teardown() {
  disposed = true
  window.clearTimeout(resizeTimer)
  resizeObserver?.disconnect()
  resizeObserver = null
  thumbObserver?.disconnect()
  thumbObserver = null
  renderedThumbs.clear()
  try {
    pdfViewer?.cleanup()
    pdfViewer?.setDocument(null as never)
  } catch {
    /* 已销毁 */
  }
  pdfViewer = null
  eventBus = null
  void loadingTask?.destroy()
  loadingTask = null
  pdfDoc = null
  if (viewerEl.value) viewerEl.value.replaceChildren()
}

/* ---------------- 页码 / 缩放 ---------------- */
function goTo(target: number) {
  if (!pdfViewer || !pages.value) return
  const next = Math.min(pages.value, Math.max(1, Math.round(target)))
  pdfViewer.currentPageNumber = next
  pageDraft.value = String(next)
}
function commitDraft() {
  const value = Number(pageDraft.value)
  if (Number.isFinite(value)) goTo(value)
  else pageDraft.value = String(page.value)
}
function zoomBy(factor: number) {
  if (!pdfViewer) return
  fitMode.value = false
  pdfViewer.currentScale = clampScale(pdfViewer.currentScale * factor)
}
function fit() {
  fitMode.value = true
  applyFit()
}

/* Ctrl/⌘ + 滚轮(触控板捏合也是这个事件)缩放;不带修饰键就是正常滚动 */
function onWheel(event: WheelEvent) {
  if (!(event.ctrlKey || event.metaKey) || !pdfViewer) return
  event.preventDefault()
  zoomBy(Math.exp(-event.deltaY * 0.01))
}

/* 双指捏合:每次移动按当前两指距离相对起点的比例设 scale(pdf.js 先拉伸已有位图,再补渲染,观感连续) */
const touches = new Map<number, { x: number; y: number }>()
let pinchStart = 0
let pinchScale = 1
let pinchFrame = 0
function distance(): number {
  const [a, b] = [...touches.values()]
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
}
function onPointerDown(event: PointerEvent) {
  if (event.pointerType !== 'touch') return
  touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
  if (touches.size === 2 && pdfViewer) {
    pinchStart = distance()
    pinchScale = pdfViewer.currentScale
  }
}
function onPointerMove(event: PointerEvent) {
  if (!touches.has(event.pointerId)) return
  touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
  if (touches.size !== 2 || !pdfViewer || !pinchStart) return
  const ratio = distance() / pinchStart
  window.cancelAnimationFrame(pinchFrame)
  pinchFrame = window.requestAnimationFrame(() => {
    if (!pdfViewer) return
    fitMode.value = false
    pdfViewer.currentScale = clampScale(pinchScale * ratio)
  })
}
function onPointerEnd(event: PointerEvent) {
  touches.delete(event.pointerId)
  if (touches.size < 2) pinchStart = 0
}

/* 双击 / 双击屏幕:适应宽度 ⇄ 放大到 2 倍(手机上比捏合更省事) */
function onDoubleClick(event: MouseEvent) {
  if (!pdfViewer || (event.target as HTMLElement).closest('a')) return
  if (fitMode.value) {
    fitMode.value = false
    pdfViewer.currentScale = clampScale(pdfViewer.currentScale * 2)
  } else {
    fit()
  }
}

function onKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null
  if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    // 统一外壳里查找栏属于 Host；这里再拦一次会让 Chrome 的 Ctrl+F 永远打不开
    if (props.hideFind) return
    event.preventDefault()
    openFind()
  } else if (event.key === '+' || event.key === '=') {
    event.preventDefault()
    zoomBy(1.2)
  } else if (event.key === '-') {
    event.preventDefault()
    zoomBy(1 / 1.2)
  } else if (event.key === '0') {
    event.preventDefault()
    fit()
  }
}

/* ---------------- 缩略图(按需渲染) ---------------- */
function observeThumbs() {
  thumbObserver?.disconnect()
  const root = thumbsEl.value
  if (!root || typeof IntersectionObserver === 'undefined') return
  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const number = Number((entry.target as HTMLElement).dataset.page)
        thumbObserver?.unobserve(entry.target)
        void renderThumb(number, entry.target.querySelector('canvas'))
      }
    },
    { root, rootMargin: '200px 0px' },
  )
  root.querySelectorAll('[data-page]').forEach((element) => thumbObserver?.observe(element))
}
async function renderThumb(number: number, canvas: HTMLCanvasElement | null) {
  if (!pdfDoc || !canvas || renderedThumbs.has(number)) return
  renderedThumbs.add(number)
  try {
    const target = await pdfDoc.getPage(number)
    const base = target.getViewport({ scale: 1 })
    const ratio = window.devicePixelRatio || 1
    const viewport = target.getViewport({ scale: (96 * ratio) / base.width })
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    const context = canvas.getContext('2d')
    if (!context) return
    await target.render({ canvasContext: context, canvas, viewport }).promise
  } catch {
    renderedThumbs.delete(number)
  }
}
watch(thumbsOpen, (open) => {
  if (open) void nextTick(observeThumbs)
})
function pickThumb(number: number) {
  goTo(number)
  if (compactThumbs.value) {
    thumbsTouched = true
    thumbsOpen.value = false
  }
}

/* ---------------- 查找 / 命中高亮 ---------------- */
function dispatchFind(query: string, options: { highlightAll: boolean; again?: boolean; previous?: boolean }) {
  eventBus?.dispatch('find', {
    source: pdfViewer,
    type: options.again ? 'again' : '',
    query,
    caseSensitive: false,
    entireWord: false,
    highlightAll: options.highlightAll,
    findPrevious: !!options.previous,
    matchDiacritics: false,
  })
}
function openFind() {
  findOpen.value = true
  void nextTick(() => {
    findInput.value?.focus()
    findInput.value?.select()
  })
}
function closeFind() {
  findOpen.value = false
  findQuery.value = ''
  matches.value = { current: 0, total: 0 }
  notFound.value = false
  dispatchFind('', { highlightAll: false })
}
function submitFind(previous = false) {
  const query = findQuery.value.trim()
  if (!query) return
  hitActive.value = false
  dispatchFind(query, { highlightAll: true, again: true, previous })
}
watch(findQuery, (query) => {
  if (!findOpen.value) return
  hitActive.value = false
  dispatchFind(query.trim(), { highlightAll: true })
})

/** 试一个 needle:命中返回 true。pdf.js 的查找是异步的,结果从 updatefindcontrolstate 回来。 */
function tryNeedle(needle: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!eventBus) return resolve(false)
    const bus = eventBus
    const timer = window.setTimeout(() => done(false), 4000)
    const handler = (event: { state: number }) => {
      if (event.state === 3) return // PENDING
      done(event.state !== 1) // 1 = NOT_FOUND
    }
    function done(found: boolean) {
      window.clearTimeout(timer)
      bus.off('updatefindcontrolstate', handler)
      resolve(found)
    }
    bus.on('updatefindcontrolstate', handler)
    dispatchFind(needle, { highlightAll: false })
  })
}
async function showHit() {
  if (!pdfViewer || phase.value !== 'ready') return
  const text = (props.hitText ?? '').replace(/\s+/g, ' ').trim()
  if (props.hitPage) goTo(props.hitPage)
  if (!text) return
  // 由长到短:抽取块可能跨行 / 被截断,整句找不到就退到前缀
  const sizes = [...new Set([Math.min(text.length, 240), 96, 48, 28, 16, 8])].filter((size) => size <= text.length || size === text.length)
  for (const size of sizes) {
    const needle = text.slice(0, size).trim()
    if (needle.length < Math.min(8, text.length)) continue
    if (await tryNeedle(needle)) {
      hitActive.value = true
      return
    }
  }
  dispatchFind('', { highlightAll: false })
  hitActive.value = false
}
function clearHit() {
  hitActive.value = false
  dispatchFind('', { highlightAll: false })
}
watch(
  () => [props.hitText, props.hitPage],
  () => void showHit(),
)

watch(
  () => props.url,
  () => void load(),
)
onMounted(() => void load())
onBeforeUnmount(() => {
  teardown()
  window.cancelAnimationFrame(pinchFrame)
})

/**
 * 统一外壳的查找通道
 *
 * pdf.js 的查找是事件驱动的：dispatch 之后要等 `updatefindcontrolstate` 才拿到 total/current。
 * 这里把「派发 + 等结果」包成一个 Promise，Host 的搜索栏就能像代码/文本面一样直接渲染计数。
 * 超时也要 resolve：加密页或扫描件可能永远不返回结果，查找栏不能一直转圈。
 */
function awaitFindResult(timeout = 2500): Promise<{ total: number; index: number }> {
  return new Promise((resolve) => {
    const bus = eventBus
    if (!bus) return resolve({ total: 0, index: -1 })
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      bus.off('updatefindmatchescount', onCount)
      bus.off('updatefindcontrolstate', onState)
      resolve({ total: matches.value.total, index: matches.value.current > 0 ? matches.value.current - 1 : -1 })
    }
    const onCount = () => {
      // 页数多时 pdf.js 会分页回报，给它一个很短的聚合窗口再收口
      window.setTimeout(finish, 40)
    }
    const onState = (event: { state: number }) => {
      if (event.state === 3) return // PENDING
      window.setTimeout(finish, 40)
    }
    const timer = window.setTimeout(finish, timeout)
    bus.on('updatefindmatchescount', onCount)
    bus.on('updatefindcontrolstate', onState)
  })
}

/** 统一查找：只派发，不打开查看器自己的查找面板；命中由 pdf.js 高亮 */
async function find(query: string): Promise<{ total: number; index: number }> {
  findQuery.value = query
  hitActive.value = false
  matches.value = { current: 0, total: 0 }
  const result = awaitFindResult()
  if (eventBus) dispatchFind(query, { highlightAll: true })
  return result
}

/** 下一个 / 上一个：沿用 pdf.js 的 again 语义 */
async function findStep(previous = false): Promise<{ total: number; index: number }> {
  const query = findQuery.value.trim()
  if (!query) return { total: 0, index: -1 }
  hitActive.value = false
  const result = awaitFindResult()
  if (eventBus) dispatchFind(query, { highlightAll: true, again: true, previous })
  return result
}

function clearFind(): void {
  findQuery.value = ''
  findOpen.value = false
  matches.value = { current: 0, total: 0 }
  notFound.value = false
  if (eventBus) dispatchFind('', { highlightAll: false })
}

function getFindState(): { query: string; total: number; index: number } {
  return { query: findQuery.value, total: matches.value.total, index: matches.value.current > 0 ? matches.value.current - 1 : -1 }
}

/** 选区锚点：页码 + 相对页面左上角的 rect（按 1 倍缩放归一，缩放后仍能落回同一处） */
function selectionInfo(): { anchor: { kind: 'pdf'; page: number; rect: { x: number; y: number; width: number; height: number } }; text: string; isEmpty: boolean } | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  const root = container.value
  if (!root || !root.contains(range.commonAncestorContainer)) return null
  const node = range.startContainer
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement
  const pageEl = element?.closest('.page') as HTMLElement | null
  if (!pageEl) return null
  const pageNumber = Number(pageEl.dataset.pageNumber ?? 0)
  if (!pageNumber) return null
  const pageRect = pageEl.getBoundingClientRect()
  const rect = range.getBoundingClientRect()
  const ratio = scale.value || 1
  return {
    anchor: {
      kind: 'pdf',
      page: pageNumber,
      rect: {
        x: (rect.left - pageRect.left) / ratio,
        y: (rect.top - pageRect.top) / ratio,
        width: Math.max(1, rect.width / ratio),
        height: Math.max(1, rect.height / ratio),
      },
    },
    text: selection.toString(),
    isEmpty: selection.isCollapsed,
  }
}

/** 跳到 PDF 锚点；页面尚未渲染时等一帧再滚动，失败返回 false 让调用方如实报 anchor_lost */
function selectAnchor(anchor: { kind: 'pdf'; page: number; rect?: { x: number; y: number; width: number; height: number } }): boolean {
  if (!pages.value) return false
  goTo(anchor.page)
  if (!anchor.rect) return true
  window.setTimeout(() => {
    const pageEl = container.value?.querySelector(`.page[data-page-number="${anchor.page}"]`) as HTMLElement | null
    if (!pageEl) return
    const ratio = scale.value || 1
    pageEl.scrollIntoView({ block: 'center' })
    const pageRect = pageEl.getBoundingClientRect()
    const targetY = pageRect.top + anchor.rect!.y * ratio
    const paneRect = container.value?.getBoundingClientRect()
    if (paneRect) container.value!.scrollTop += targetY - paneRect.top - paneRect.height / 3
  }, 120)
  return true
}

defineExpose({ goTo, showHit, openFind, zoomBy, fit, find, findStep, clearFind, getFindState, selectionInfo, selectAnchor, getPage: () => page.value, getPages: () => pages.value, getScale: () => scale.value })
</script>

<template>
  <div class="kb-pv" :class="{ 'is-invert': invert, 'is-thumbs': thumbsOpen, 'is-compact': compactThumbs }">
    <ViewerToolbar label="PDF 工具栏" class="kb-pv-bar">
      <template #start>
        <button
          type="button"
          class="btn sm kb-pv-btn"
          :class="{ ac: thumbsOpen }"
          :aria-pressed="thumbsOpen"
          aria-label="缩略图"
          title="缩略图"
          :disabled="phase !== 'ready'"
          @click="toggleThumbs"
        >
          <KbIcon name="sidebar" :size="12" />
        </button>
        <span class="kb-pv-group">
          <button type="button" class="btn sm kb-pv-btn" aria-label="上一页" :disabled="phase !== 'ready' || page <= 1" @click="goTo(page - 1)">
            <KbIcon name="chevron" :size="12" class="kb-pv-prev" />
          </button>
          <input
            v-model="pageDraft"
            class="kb-pv-page mono"
            inputmode="numeric"
            aria-label="页码"
            :disabled="phase !== 'ready'"
            @keydown.enter.prevent="!isComposing($event) && commitDraft()"
            @blur="commitDraft"
          />
          <span class="mono kb-pv-total">/ {{ pages || '–' }}</span>
          <button type="button" class="btn sm kb-pv-btn" aria-label="下一页" :disabled="phase !== 'ready' || page >= pages" @click="goTo(page + 1)">
            <KbIcon name="chevron" :size="12" class="kb-pv-next" />
          </button>
        </span>
      </template>
      <template #center>
        <span class="kb-pv-group kb-pv-zoom-group">
          <button type="button" class="btn sm kb-pv-btn" aria-label="缩小" :disabled="phase !== 'ready'" @click="zoomBy(1 / 1.2)">
            <KbIcon name="minus" :size="12" />
          </button>
          <button type="button" class="mono kb-pv-zoom" :title="fitMode ? '当前为适应宽度' : '点击恢复适应宽度'" :disabled="phase !== 'ready'" @click="fit">
            {{ scaleLabel }}
          </button>
          <button type="button" class="btn sm kb-pv-btn" aria-label="放大" :disabled="phase !== 'ready'" @click="zoomBy(1.2)">
            <KbIcon name="plus" :size="12" />
          </button>
        </span>
      </template>
      <template #tools>
        <button v-if="!hideFind" type="button" class="btn sm kb-pv-btn" :class="{ ac: findOpen }" aria-label="查找" title="查找 (Ctrl/⌘ F)" :disabled="phase !== 'ready'" @click="findOpen ? closeFind() : openFind()">
          <KbIcon name="search" :size="12" />
        </button>
        <button type="button" class="btn sm kb-pv-btn kb-pv-invert" :class="{ ac: invert }" :aria-pressed="invert" aria-label="反色阅读" title="反色阅读(深色主题下更护眼)" :disabled="phase !== 'ready'" @click="toggleInvert">
          <KbIcon name="eye" :size="12" />
        </button>
        <slot name="tools" />
      </template>
    </ViewerToolbar>

    <div v-if="findOpen && !hideFind" class="kb-pv-find" role="search">
      <input
        ref="findInput"
        v-model="findQuery"
        class="kb-pv-find-input"
        type="search"
        placeholder="在文档中查找"
        aria-label="在文档中查找"
        @keydown.enter.prevent="!isComposing($event) && submitFind($event.shiftKey)"
        @keydown.esc.prevent="closeFind"
      />
      <span class="mono kb-pv-find-count" :class="{ 'is-none': notFound }">
        {{ notFound ? '无结果' : matches.total ? `${matches.current} / ${matches.total}` : '' }}
      </span>
      <button type="button" class="btn sm kb-pv-btn" aria-label="上一个" :disabled="!matches.total" @click="submitFind(true)">↑</button>
      <button type="button" class="btn sm kb-pv-btn" aria-label="下一个" :disabled="!matches.total" @click="submitFind(false)">↓</button>
      <button type="button" class="btn sm kb-pv-btn" aria-label="关闭查找" @click="closeFind"><KbIcon name="close" :size="12" /></button>
    </div>

    <div ref="pane" class="kb-pv-pane">
      <aside v-show="thumbsOpen && phase === 'ready'" ref="thumbsEl" class="kb-pv-thumbs" aria-label="页面缩略图">
        <button
          v-for="n in pages"
          :key="n"
          type="button"
          class="kb-pv-thumb"
          :class="{ 'is-on': n === page }"
          :data-page="n"
          :aria-label="`第 ${n} 页`"
          :aria-current="n === page"
          @click="pickThumb(n)"
        >
          <span class="kb-pv-thumb-paper" :style="{ aspectRatio: `1 / ${aspect}` }"><canvas></canvas></span>
          <span class="mono kb-pv-thumb-no">{{ n }}</span>
        </button>
      </aside>
      <div v-if="thumbsOpen && compactThumbs && phase === 'ready'" class="kb-pv-scrim" @click="toggleThumbs"></div>

      <div
        ref="container"
        class="kb-pv-container"
        tabindex="0"
        role="document"
        aria-label="PDF 页面"
        @wheel="onWheel"
        @dblclick="onDoubleClick"
        @keydown="onKeydown"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerEnd"
        @pointercancel="onPointerEnd"
      >
        <div ref="viewerEl" class="pdfViewer"></div>
      </div>

      <div v-if="hitActive && phase === 'ready'" class="kb-pv-hit">
        <span>命中 · 第 {{ page }} 页</span>
        <button type="button" aria-label="清除高亮" @click="clearHit"><KbIcon name="close" :size="10" /></button>
      </div>

      <div v-if="phase === 'loading'" class="kb-pv-state" role="status">
        <div class="kb-pv-bar-progress"><i :style="{ width: `${Math.max(6, Math.round(progress * 100))}%` }"></i></div>
        <span class="m">正在加载 PDF…</span>
      </div>
      <div v-else-if="phase === 'error'" class="kb-pv-state is-error" role="alert">
        <span>{{ errorMessage }}</span>
      </div>
    </div>
  </div>
</template>

<style>
.kb-pv {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: var(--surface-sunken);
  border: var(--hl) solid var(--b2);
  border-radius: var(--r2);
  overflow: hidden;
}
.kb-pv-bar,
.kb-pv-find {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: var(--surface-1);
  border-bottom: var(--hl) solid var(--b);
  overflow-x: auto;
  scrollbar-width: none;
}
.kb-pv-bar::-webkit-scrollbar,
.kb-pv-find::-webkit-scrollbar {
  display: none;
}
.kb-pv-group {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.kb-pv-btn {
  flex: none;
  min-width: var(--ctl-h);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.kb-pv-prev {
  transform: rotate(90deg);
}
.kb-pv-next {
  transform: rotate(-90deg);
}
.kb-pv-page {
  width: 3.4em;
  height: var(--ctl-h);
  text-align: center;
  color: var(--t);
  background: var(--input-bg);
  border: var(--hl) solid var(--b2);
  border-radius: var(--r1);
  font-size: calc(12px * var(--fs));
}
.kb-pv-page:focus {
  outline: none;
  border-color: var(--ac);
}
.kb-pv-total {
  color: var(--m);
  font-size: calc(12px * var(--fs));
  min-width: 3ch;
}
.kb-pv-zoom {
  min-width: 4.4em;
  height: var(--ctl-h);
  padding: 0 6px;
  color: var(--t2);
  background: transparent;
  border: 0;
  border-radius: var(--r1);
  font-size: calc(12px * var(--fs));
  cursor: pointer;
}
.kb-pv-zoom:hover:not(:disabled) {
  background: var(--hover);
  color: var(--t);
}
.kb-pv-find-input {
  flex: 1 1 160px;
  min-width: 0;
  height: var(--ctl-h);
  padding: 0 8px;
  color: var(--t);
  background: var(--input-bg);
  border: var(--hl) solid var(--b2);
  border-radius: var(--r1);
}
.kb-pv-find-input:focus {
  outline: none;
  border-color: var(--ac);
}
.kb-pv-find-count {
  flex: none;
  min-width: 6ch;
  text-align: right;
  color: var(--m);
  font-size: calc(12px * var(--fs));
}
.kb-pv-find-count.is-none {
  color: var(--status-danger-text, var(--r));
}
.kb-pv-pane {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}
/* pdf_viewer 要求容器 absolute;左侧缩略图常驻时给它让出位置 */
.kb-pv-container {
  position: absolute;
  inset: 0;
  overflow: auto;
  outline: none;
  touch-action: pan-x pan-y;
  background: var(--surface-sunken);
}
.kb-pv.is-thumbs:not(.is-compact) .kb-pv-container {
  left: 124px;
}
.kb-pv-container .pdfViewer {
  --page-bg-color: #fff; /* tokens-allow: 纸面永远是白的,与主题无关 */
  padding: 12px 0;
}
.kb-pv-container .pdfViewer .page {
  margin: 0 auto 12px;
  border: 0;
  box-shadow: var(--sh2);
  background-clip: content-box;
}
.kb-pv.is-invert .kb-pv-container .pdfViewer .page canvas {
  filter: invert(0.92) hue-rotate(180deg);
}
.kb-pv-container .pdfViewer .textLayer .highlight {
  background-color: color-mix(in srgb, var(--status-warning) 45%, transparent);
  border-radius: 2px;
}
.kb-pv-container .pdfViewer .textLayer .highlight.selected {
  background-color: color-mix(in srgb, var(--accent) 50%, transparent);
  outline: 2px solid var(--accent);
}
.kb-pv.is-thumbs:not(.is-compact) .kb-pv-hit {
  left: 138px;
}
.kb-pv-thumbs {
  position: absolute;
  z-index: 3;
  top: 0;
  bottom: 0;
  left: 0;
  width: 124px;
  overflow-y: auto;
  padding: 10px 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  background: var(--surface-1);
  border-right: var(--hl) solid var(--b);
}
.kb-pv.is-compact .kb-pv-thumbs {
  width: min(160px, 46%);
  box-shadow: var(--sh3);
}
.kb-pv-scrim {
  position: absolute;
  inset: 0;
  z-index: 2;
  background: rgba(var(--shade), 0.35);
}
.kb-pv-thumb {
  flex: none;
  width: 96px;
  padding: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: 0;
  color: var(--m);
  cursor: pointer;
}
.kb-pv-thumb-paper {
  display: block;
  width: 100%;
  background: #fff; /* tokens-allow: 缩略图纸面 */
  border: 2px solid transparent;
  border-radius: var(--r-xs);
  box-shadow: var(--sh1);
  overflow: hidden;
}
.kb-pv-thumb-paper canvas {
  display: block;
  width: 100%;
  height: 100%;
}
.kb-pv.is-invert .kb-pv-thumb-paper canvas {
  filter: invert(0.92) hue-rotate(180deg);
}
.kb-pv-thumb.is-on .kb-pv-thumb-paper {
  border-color: var(--accent);
}
.kb-pv-thumb.is-on {
  color: var(--t);
}
.kb-pv-thumb-no {
  font-size: calc(11px * var(--fs));
}
.kb-pv-hit {
  position: absolute;
  z-index: 1;
  left: 14px;
  bottom: 14px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 4px 10px;
  color: var(--ac2);
  background: var(--surface-3);
  border: var(--hl) solid var(--accent-soft-border);
  border-radius: var(--r-pill);
  box-shadow: var(--sh2);
  font-size: calc(12px * var(--fs));
}
.kb-pv-hit button {
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 20px;
  color: inherit;
  background: transparent;
  border: 0;
  border-radius: 50%;
  cursor: pointer;
}
.kb-pv-state {
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
.kb-pv-state.is-error {
  color: var(--t2);
}
.kb-pv-bar-progress {
  width: min(240px, 60%);
  height: 4px;
  background: var(--chart-track);
  border-radius: var(--r-pill);
  overflow: hidden;
}
.kb-pv-bar-progress i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width var(--dur-base) var(--ease-out);
}
@media (pointer: coarse) {
  .kb-pv-btn,
  .kb-pv-page,
  .kb-pv-zoom {
    min-height: 36px;
    min-width: 36px;
  }
  .kb-pv-page {
    font-size: calc(16px * var(--fs));
  }
  /* 百分比按钮不是 .btn,没有全局的可点区域外扩:视觉 36px,伪元素外扩到 44px */
  .kb-pv-zoom {
    position: relative;
  }
  .kb-pv-zoom::before {
    content: '';
    position: absolute;
    inset: -4px;
  }
}
/* 手机:± / 缩放百分比 / 反色收起来(捏合、双击已经够用),工具栏一行放得下 */
@media (max-width: 520px) {
  .kb-pv-bar,
  .kb-pv-find {
    gap: 4px;
  }
  .kb-pv-zoom-group,
  .kb-pv-invert {
    display: none;
  }
}
</style>
