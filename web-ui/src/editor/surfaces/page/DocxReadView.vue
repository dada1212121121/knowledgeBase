<script setup lang="ts">
/**
 * Word 只读视图（当前实现）
 *
 * 渲染交给 docx-preview（0 WASM），这里负责外壳之外的阅读体验：
 *  - 页码指示与跳页、缩放（适应宽度 / 50%~300%，CSS zoom，缩放不重排），滚动时更新当前页；
 *  - 搜索命中高亮（来自检索结果的 hitText）和查找栏的逐个命中；
 *  - 批注侧栏（只读）：从 OPC 包读出批注，点击定位到被批注的原文；
 *  - 复制：保留段落与表格形状，选区不含页眉页脚（全选除外）；
 * - 页缩略图栏（补全）：页面 DOM 的缩小克隆，后台生成、可见优先；与主视图滚动同步；
 *    缩放（含适应宽度随窗口变化）前后停在同一页同一处，也能记下 / 恢复阅读位置给「高保真查看」往返用。
 * 不执行任何文档脚本；链接只放行 http(s) / mailto，并强制 noopener。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { KbIcon } from '@kb-ui/index'
import ViewerToolbar from '@/components/ViewerToolbar.vue'
import { clearHighlight, findAllRanges, paintHighlight, paintHighlights, revealRange } from '@/utils/domHighlight'
import { fetchOriginal, OriginalError } from '@/utils/fetchOriginal'
import { anchorFromRange, rangeFromAnchor, type PageAnchor } from './docx-anchors'
import { readDocxMeta, type DocxComment, type DocxMeta } from './docx-meta'
import { naturalPageSizes, readPosition, restorePosition } from './docx-position'
import { pruneDocxForRender, warmDocxPruneWorker } from './docx-prune-async'
import { collectOutline, currentPage, DOCX_CLASS, pageElements, pageOfNode, renderDocx, revealPages, selectionClipboard, type OutlineEntry } from './docx-read'
import PageThumbnails from './thumbs/PageThumbnails.vue'
import { createDomThumbSource } from './thumbs/domThumbSource'
import type { ReadingStart } from './thumbs/scrollSync'
import { COMPACT_BELOW, type ThumbSource } from './thumbs/types'

const props = withDefaults(
  defineProps<{
    url: string
    hitText?: string
    hitPage?: number | null
    /** 已经读好的原件字节：从高保真查看回来时直接用，不再下载一遍 */
    buffer?: ArrayBuffer | null
    /** 缩略图栏：true / false = 用户选定；null = 按容器宽度（宽屏开、手机收起） */
    thumbs?: boolean | null
    /** 打开后恢复到这个阅读位置（从高保真查看回来）；有它就不再跳到搜索命中 */
    startAt?: ReadingStart | null
  }>(),
  { hitText: '', hitPage: null, buffer: null, thumbs: null, startAt: null },
)
const emit = defineEmits<{
  ready: [pages: number]
  error: [message: string]
  page: [page: number]
  selection: [payload: { anchor: PageAnchor; text: string; isEmpty: boolean }]
  /** 缩略图栏开关变了（含容器宽度变化带来的默认值变化）：外壳据此刷新工具栏高亮 */
  thumbs: [open: boolean]
}>()

const scroller = ref<HTMLElement | null>(null)
const body = ref<HTMLElement | null>(null)
const host = ref<HTMLElement | null>(null)
const styles = ref<HTMLElement | null>(null)
const phase = ref<'loading' | 'ready' | 'error'>('loading')
/** 页已经挂上并开始逐批显示：此时遮罩让位给已经出来的页（但 phase 仍是 loading，按钮保持禁用，直到全部页显示完） */
const pagesShowing = ref(false)
const errorMessage = ref('')
const progress = ref(0)
const pages = ref(0)
/** 文档里的图形个数（流程图、文本框）：轻只读画不全它们，> 0 时给一条提示 */
const shapes = ref(0)
const shapesNoticeClosed = ref(false)
const page = ref(1)
const pageDraft = ref('1')
const scale = ref(1)
const fitMode = ref(true)
const hitFound = ref<boolean | null>(null)
const comments = ref<DocxComment[]>([])
/** 批注 / 大纲等元信息读没读完：首屏之后空闲时才读，基线脚本据此确定长任务观测窗口的终点（data-meta） */
const metaState = ref<'pending' | 'done'>('pending')
const commentsOpen = ref(false)
const activeComment = ref('')
const find = ref({ query: '', total: 0, index: -1 })

let meta: DocxMeta = { comments: [], headingClasses: new Map() }
let abort: AbortController | null = null
let natural = 0
let resizeObserver: ResizeObserver | null = null
let resizeTimer = 0
let scrollFrame = 0
let findRanges: Range[] = []
let disposed = false
/** 每次 load 加 1：逐批显示途中换了文档，旧的那一轮据此认出自己过期 */
let loadSeq = 0
let outline: OutlineEntry[] = []
let idleHandle: { cancel: () => void } | null = null
/** 原件字节：高保真查看要用同一份，不重新下载；组件卸载时释放 */
let originalBuffer: ArrayBuffer | null = null

/* ---------------- 缩略图栏状态 ---------------- */

/** 容器（不是屏幕）窄于阈值：缩略图栏改成文档下方的横条，默认收起 */
const compact = ref(false)
const userThumbs = ref<boolean | null>(props.thumbs)
const thumbsOpen = computed(() => userThumbs.value ?? !compact.value)
/** 每页未缩放的版面尺寸：缩略图定纵横比和缩小倍数用，渲染后量一次 */
const naturalSizes = shallowRef<Array<{ width: number; height: number }>>([])
const aspects = computed(() => naturalSizes.value.map((size) => (size.height > 0 ? size.width / size.height : 0)))
/** 文档每重新渲染一次加 1：旧的缩略图来源指向已经被替换的页元素，必须换新 */
const renderEpoch = ref(0)
const thumbSource = computed<ThumbSource | null>(() => {
  void renderEpoch.value
  if (!thumbsOpen.value || phase.value !== 'ready' || !pages.value) return null
  return createDomThumbSource({
    pages: () => (host.value ? pageElements(host.value) : []),
    naturalSize: (index) => naturalSizes.value[index] ?? null,
    className: DOCX_CLASS,
  })
})
const thumbsRail = ref<{ invalidate(): void } | null>(null)
watch(thumbsOpen, (open) => emit('thumbs', open))
function setThumbs(open?: boolean) {
  userThumbs.value = open ?? !thumbsOpen.value
}
function measureCompact() {
  const width = body.value?.clientWidth ?? 0
  if (width > 0) compact.value = width < COMPACT_BELOW
}

/** 浏览器空闲时执行；不支持 requestIdleCallback（Safari）就延后一小会儿，同样让出首屏 */
function onIdle(task: () => void): { cancel: () => void } {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(task, { timeout: 1500 })
    return { cancel: () => window.cancelIdleCallback(id) }
  }
  const id = window.setTimeout(task, 200)
  return { cancel: () => window.clearTimeout(id) }
}
function cancelIdle() {
  idleHandle?.cancel()
  idleHandle = null
}

// 下限 0.3：手机宽度（约 350px）下整页 816px 的适应宽度比例是 0.43，低于 0.5 就会出现横向滚动条
const MIN = 0.3
const MAX = 3
const FIT_CAP = 1.25
const HIT = 'kb-hit'
const QUERY = 'kb-query'

const percent = computed(() => Math.round(scale.value * 100))

function fail(message: string) {
  phase.value = 'error'
  errorMessage.value = message
  emit('error', message)
}

async function load() {
  disposed = false
  const mine = ++loadSeq
  const stale = () => disposed || mine !== loadSeq
  cancelIdle()
  abort?.abort()
  abort = new AbortController()
  phase.value = 'loading'
  pagesShowing.value = false
  progress.value = 0
  hitFound.value = null
  comments.value = []
  metaState.value = 'pending'
  commentsOpen.value = false
  clearAllHighlights()
  // 样式瘦身的 Worker 提前起：模块文件在原件下载的同时就开始取
  warmDocxPruneWorker()
  try {
    const buffer = props.buffer ?? (await fetchOriginal(props.url, { signal: abort.signal, onProgress: (done, total) => (progress.value = total ? done / total : 0) }))
    if (disposed || !host.value || !styles.value) return
    originalBuffer = buffer
    // 去掉没人用的样式再交给 docx-preview（Worker 里做，见 docx-prune.ts）：Word 2010 模板的 349 KB styles.xml 光解析就是一条 100~200 ms 的长任务。
    // 渲染和读元信息都用瘦身后的字节；原件字节（originalBuffer）不动，高保真查看照旧用它
    const renderBuffer = await pruneDocxForRender(buffer)
    if (disposed || !host.value || !styles.value) return
    // stage：页数多的文档先整篇隐藏着挂上去（不布局），套好适应宽度的缩放，再一批一批显示——
    // 20 页整篇一次布局是 100~140 ms 的长任务，而且先 fit 再量尺寸会让整篇布局两遍
    const rendered = await renderDocx(renderBuffer, host.value, styles.value, { stage: true })
    shapes.value = rendered.shapes
    if (stale()) return
    pages.value = rendered.pages
    natural = rendered.naturalWidth
    fit()
    pagesShowing.value = true
    if (!(await revealPages(host.value, stale))) return
    phase.value = 'ready'
    // 元信息（批注、标题样式）不挡首屏：渲染完成、页面画出来之后等浏览器空闲再读，读完补批注数量与大纲
    cancelIdle()
    idleHandle = onIdle(() => {
      idleHandle = null
      void readDocxMeta(renderBuffer, DOCX_CLASS).then((value) => {
        if (disposed) return
        meta = value
        comments.value = value.comments
        outline = host.value ? collectOutline(host.value, value.headingClasses) : []
        metaState.value = 'done'
        emit('ready', pages.value)
      })
    })
    emit('ready', pages.value)
    await nextTick()
    // 缩放在显示之前就套好了（见上），这里整篇布局已经是干净的：量页面未缩放尺寸不会再触发新布局
    measureNatural()
    fit()
    renderEpoch.value += 1
    applyStart()
    watchSize()
    updatePage()
    // 从高保真查看回来是恢复阅读位置，不再把视线拽回搜索命中
    if (!props.startAt) showHit()
  } catch (error) {
    if (disposed || (error as Error)?.name === 'AbortError') return
    fail(error instanceof OriginalError ? error.message : '这份 Word 文档渲染失败(可能已损坏或格式过旧)')
  }
}

/* ---------------- 缩放 ---------------- */

/**
 * 缩放：CSS zoom 不重排，但页面整体变高 / 变矮，原来的 scrollTop 会指到别的地方（放大后"跳到后面几页"）。
 * 所以先记下视口中线所在的阅读位置（页 + 页内比例），缩放后把它放回中线，页码和阅读位置都不变。
 * 在最顶端（scrollTop = 0，刚打开或回到开头）时不锚定：保持在顶端，而不是被中线锚点推下去一截。
 * 适应宽度跟着窗口 / 栏宽变化的重算也走这里，所以开关缩略图栏不会让正文跳页。
 */
function applyScale(value: number) {
  const anchor = scroller.value && host.value && phase.value === 'ready' && scroller.value.scrollTop > 0 ? readPosition(scroller.value, host.value) : null
  scale.value = Math.min(MAX, Math.max(MIN, value))
  host.value?.style.setProperty('zoom', String(scale.value))
  if (anchor && scroller.value && host.value) restorePosition(scroller.value, host.value, anchor)
}

/** 渲染完成后量各页未缩放尺寸（屏幕尺寸 ÷ 当前缩放） */
function measureNatural() {
  naturalSizes.value = host.value ? naturalPageSizes(host.value, scale.value) : []
}

/** 打开时恢复阅读位置：缩放（若上次不是适应宽度）+ 页与页内比例 */
function applyStart() {
  const start = props.startAt
  if (!start || !scroller.value || !host.value) return
  if (start.fit === false && start.scale) {
    fitMode.value = false
    applyScale(start.scale)
  }
  restorePosition(scroller.value, host.value, { page: start.page, fraction: start.fraction })
}

/** 记下当前阅读位置（切到高保真查看前调用）；没有页返回 null */
function capturePosition(): ReadingStart | null {
  if (!scroller.value || !host.value || phase.value !== 'ready') return null
  const anchor = readPosition(scroller.value, host.value)
  return anchor ? { ...anchor, scale: scale.value, fit: fitMode.value } : null
}
function fit() {
  fitMode.value = true
  const width = scroller.value?.clientWidth ?? 0
  if (!natural || !width) return
  applyScale(Math.min(FIT_CAP, (width - 16) / natural))
}
function zoomBy(factor: number) {
  fitMode.value = false
  applyScale(scale.value * factor)
}
function onDoubleClick(event: MouseEvent) {
  if ((event.target as HTMLElement).closest('a')) return
  if (fitMode.value) zoomBy(1.8)
  else fit()
}
function onWheel(event: WheelEvent) {
  if (!(event.ctrlKey || event.metaKey)) return
  event.preventDefault()
  zoomBy(Math.exp(-event.deltaY * 0.01))
}
function watchSize() {
  resizeObserver?.disconnect()
  if (!scroller.value || typeof ResizeObserver === 'undefined') return
  resizeObserver = new ResizeObserver(() => {
    measureCompact()
    window.clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(() => {
      if (fitMode.value && phase.value === 'ready') fit()
    }, 100)
  })
  resizeObserver.observe(scroller.value)
  if (body.value) resizeObserver.observe(body.value)
}

/* ---------------- 页码 ---------------- */

function updatePage() {
  if (!scroller.value || !host.value || phase.value !== 'ready') return
  const next = currentPage(scroller.value, host.value) || 1
  if (next === page.value) return
  page.value = next
  pageDraft.value = String(next)
  emit('page', next)
}
function onScroll() {
  if (scrollFrame) return
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0
    updatePage()
  })
}
function goTo(target: number) {
  if (!host.value || !pages.value) return
  const index = Math.min(pages.value, Math.max(1, Math.round(target)))
  pageElements(host.value)[index - 1]?.scrollIntoView({ block: 'start' })
  page.value = index
  pageDraft.value = String(index)
  emit('page', index)
}
function commitPageDraft() {
  const value = Number(pageDraft.value)
  if (Number.isFinite(value) && value >= 1) goTo(value)
  else pageDraft.value = String(page.value)
}

/* ---------------- 命中 / 查找 / 锚点 ---------------- */

function clearAllHighlights() {
  clearHighlight(HIT)
  clearHighlight(QUERY)
}

function showHit() {
  clearHighlight(HIT)
  hitFound.value = null
  const text = props.hitText?.trim()
  if (!text || !host.value || phase.value !== 'ready') return
  const range = rangeFromAnchor(host.value, { kind: 'page', page: props.hitPage ?? 0, text })
  hitFound.value = !!range
  if (!range) return
  paintHighlight(HIT, range)
  revealRange(range)
  updatePage()
}
watch(
  () => [props.hitText, props.hitPage],
  () => void nextTick(showHit),
)
watch(
  () => props.url,
  () => void load(),
)

function paintFind() {
  paintHighlights(QUERY, findRanges)
  const current = findRanges[find.value.index]
  paintHighlight(HIT, current ?? null)
  if (current) {
    revealRange(current)
    updatePage()
  }
}

function runFind(query: string): { total: number; index: number } {
  findRanges = []
  find.value = { query, total: 0, index: -1 }
  if (!query.trim() || !host.value || phase.value !== 'ready') {
    clearAllHighlights()
    return { total: 0, index: -1 }
  }
  findRanges = findAllRanges(host.value, [query])
  // 从当前页往后找第一处，没有就回到第一处
  const first = findRanges.findIndex((range) => pageOfNode(host.value!, range.startContainer) >= page.value)
  find.value = { query, total: findRanges.length, index: findRanges.length ? Math.max(0, first) : -1 }
  paintFind()
  return { total: find.value.total, index: find.value.index }
}
function findStep(previous = false): { total: number; index: number } {
  const total = findRanges.length
  if (!total) return { total: 0, index: -1 }
  const next = (find.value.index + (previous ? -1 : 1) + total) % total
  find.value = { ...find.value, index: next }
  paintFind()
  return { total, index: next }
}
function clearFind() {
  findRanges = []
  find.value = { query: '', total: 0, index: -1 }
  clearAllHighlights()
  showHit()
}

function selectAnchor(anchor: PageAnchor): boolean {
  if (!host.value || phase.value !== 'ready') return false
  const range = rangeFromAnchor(host.value, anchor)
  if (range) {
    paintHighlight(HIT, range)
    revealRange(range)
    updatePage()
    return true
  }
  // 只有页码（大纲 / 批注没有可定位的文字）：翻到那一页
  if (anchor.page >= 1 && anchor.page <= pages.value) {
    goTo(anchor.page)
    return true
  }
  return false
}

function locateComment(comment: DocxComment) {
  activeComment.value = comment.id
  if (comment.quote) {
    selectAnchor({ kind: 'page', page: 0, text: comment.quote })
  }
}

/* ---------------- 选区 / 复制 / 键盘 ---------------- */

function selectionInfo(): { anchor: PageAnchor; text: string; isEmpty: boolean } | null {
  const selection = window.getSelection()
  if (!selection?.rangeCount || !host.value || !scroller.value) return null
  const range = selection.getRangeAt(0)
  if (!scroller.value.contains(range.commonAncestorContainer)) return null
  const anchor = anchorFromRange(range, host.value)
  return anchor ? { anchor, text: selection.toString(), isEmpty: selection.isCollapsed } : null
}
function emitSelection() {
  const info = selectionInfo()
  if (info) emit('selection', info)
}

function onCopy(event: ClipboardEvent) {
  const selection = window.getSelection()
  if (!selection?.rangeCount || selection.isCollapsed || !host.value || !event.clipboardData) return
  const clip = selectionClipboard(selection.getRangeAt(0), host.value)
  if (!clip) return
  event.clipboardData.setData('text/plain', clip.text)
  event.clipboardData.setData('text/html', clip.html)
  event.preventDefault()
}

function selectAll() {
  if (!host.value) return
  window.getSelection()?.selectAllChildren(host.value)
  emitSelection()
}
function onKeydown(event: KeyboardEvent) {
  // 在查看器里 Ctrl/⌘+A 只选文档，不选整个应用界面
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a') {
    event.preventDefault()
    selectAll()
  }
}

/** 文内链接（目录、书签）：不改地址栏的 hash，在文档里滚过去 */
function onClick(event: MouseEvent) {
  const anchor = (event.target as HTMLElement).closest?.('a[href^="#"]') as HTMLAnchorElement | null
  if (!anchor || !host.value) return
  event.preventDefault()
  const id = decodeURIComponent((anchor.getAttribute('href') ?? '').slice(1))
  const target = id ? Array.from(host.value.querySelectorAll<HTMLElement>('[id]')).find((el) => el.id === id) : null
  target?.scrollIntoView({ block: 'start' })
  updatePage()
}

function focus() {
  scroller.value?.focus()
}

onMounted(() => {
  // 先量容器宽再开始加载：手机上一开始就决定横条 / 收起，不会先画出纵栏再改
  measureCompact()
  void load()
})
onBeforeUnmount(() => {
  disposed = true
  originalBuffer = null
  cancelIdle()
  abort?.abort()
  resizeObserver?.disconnect()
  window.clearTimeout(resizeTimer)
  if (scrollFrame) cancelAnimationFrame(scrollFrame)
  clearAllHighlights()
})

defineExpose({
  find: runFind,
  findStep,
  clearFind,
  getFindState: () => ({ ...find.value }),
  selectAnchor,
  goTo,
  getPage: () => page.value,
  getPages: () => pages.value,
  getScale: () => scale.value,
  zoomBy,
  fit,
  focus,
  selectAll,
  selectionInfo,
  getOutline: () => outline,
  getComments: () => comments.value,
  /** 元信息是渲染之后异步读的，测试 / 外壳需要等它 */
  getMeta: () => meta,
  /** 缩略图栏：当前是否打开 / 开关（不传参数 = 取反） */
  isThumbsOpen: () => thumbsOpen.value,
  setThumbs,
  /** 当前阅读位置与缩放（切到高保真查看前记下） */
  capturePosition,
  /** 原件字节：高保真查看直接用，不重新下载 */
  getBuffer: () => originalBuffer,
  /** 把阅读位置放回去（外壳 restore 用） */
  restoreTo: (start: ReadingStart) => {
    if (!scroller.value || !host.value) return
    restorePosition(scroller.value, host.value, start)
  },
})
</script>

<template>
  <div class="kb-pgs" data-testid="page-surface" :data-meta="metaState">
    <ViewerToolbar label="Word 工具栏">
      <template #start>
        <span class="kb-pgs-group">
          <button type="button" class="btn sm kb-pgs-btn" aria-label="上一页" :disabled="phase !== 'ready' || page <= 1" @click="goTo(page - 1)">
            <KbIcon name="chevron" :size="12" class="kb-pgs-prev" />
          </button>
          <input
            v-model="pageDraft"
            class="kb-pgs-page mono"
            inputmode="numeric"
            aria-label="当前页"
            :disabled="phase !== 'ready'"
            @keydown.enter.prevent="commitPageDraft"
            @blur="commitPageDraft"
          />
          <span class="mono kb-pgs-total">/ {{ pages || '—' }}</span>
          <button type="button" class="btn sm kb-pgs-btn" aria-label="下一页" :disabled="phase !== 'ready' || page >= pages" @click="goTo(page + 1)">
            <KbIcon name="chevron" :size="12" class="kb-pgs-next" />
          </button>
        </span>
      </template>
      <template #center>
        <span class="kb-pgs-group kb-pgs-zoom-group">
          <button type="button" class="btn sm kb-pgs-btn" aria-label="缩小" :disabled="phase !== 'ready'" @click="zoomBy(1 / 1.2)"><KbIcon name="minus" :size="12" /></button>
          <button type="button" class="mono kb-pgs-zoom" title="恢复适应宽度" :disabled="phase !== 'ready'" @click="fit">{{ percent }}%</button>
          <button type="button" class="btn sm kb-pgs-btn" aria-label="放大" :disabled="phase !== 'ready'" @click="zoomBy(1.2)"><KbIcon name="plus" :size="12" /></button>
        </span>
        <span v-if="hitFound === false" class="tag kb-pgs-miss" title="命中的句子在渲染结果里没找到(可能是表格 / 文本框内的文字)">未能定位命中</span>
      </template>
      <template #tools>
        <button
          v-if="comments.length"
          type="button"
          class="btn sm kb-pgs-comments-btn"
          :class="{ ac: commentsOpen }"
          :aria-pressed="commentsOpen"
          data-testid="page-comments-toggle"
          @click="commentsOpen = !commentsOpen"
        >
          批注 {{ comments.length }}
        </button>
        <slot name="tools" />
      </template>
    </ViewerToolbar>
    <p v-if="phase === 'ready' && shapes > 0 && !shapesNoticeClosed" class="kb-pgs-shapes-notice" role="status" data-testid="page-shapes-notice">
      <span>此文档含 {{ shapes }} 个图形（流程图、文本框等），预览画不全它们，可能缺少连线或位置有偏差。可点「在线编辑」按 Word 版式查看，或下载原文件。</span>
      <button type="button" class="btn sm" aria-label="关闭提示" data-testid="page-shapes-notice-close" @click="shapesNoticeClosed = true">知道了</button>
    </p>

    <div ref="body" class="kb-pgs-body" :class="{ 'is-compact': compact }">
      <PageThumbnails
        v-if="thumbsOpen && phase === 'ready' && pages > 0"
        ref="thumbsRail"
        :count="pages"
        :current="page"
        :aspects="aspects"
        :source="thumbSource"
        :orientation="compact ? 'horizontal' : 'vertical'"
        @select="goTo"
        @leave="focus"
      />
      <div
        ref="scroller"
        class="kb-pgs-scroll"
        tabindex="0"
        aria-label="Word 文档"
        @wheel="onWheel"
        @dblclick="onDoubleClick"
        @scroll.passive="onScroll"
        @copy="onCopy"
        @keydown="onKeydown"
        @click="onClick"
        @mouseup="emitSelection"
        @keyup="emitSelection"
      >
        <div ref="styles" class="kb-pgs-styles"></div>
        <div ref="host" class="kb-pgs-host kb-dx-host"></div>
      </div>

      <aside v-if="commentsOpen && comments.length" class="kb-pgs-comments" role="complementary" aria-label="批注" data-testid="page-comments">
        <header class="kb-pgs-comments-head">
          <strong>批注</strong>
          <button type="button" class="btn sm kb-ghost" aria-label="收起批注" @click="commentsOpen = false">收起</button>
        </header>
        <ul class="kb-pgs-comment-list">
          <li v-for="comment in comments" :key="comment.id">
            <button type="button" class="kb-pgs-comment" :class="{ 'is-active': comment.id === activeComment }" @click="locateComment(comment)">
              <span class="kb-pgs-comment-meta">
                <b>{{ comment.author }}</b>
                <span v-if="comment.date" class="mono">{{ comment.date.slice(0, 10) }}</span>
              </span>
              <span v-if="comment.quote" class="kb-pgs-comment-quote">{{ comment.quote }}</span>
              <span class="kb-pgs-comment-text">{{ comment.text }}</span>
            </button>
          </li>
        </ul>
      </aside>
    </div>

    <div v-if="phase === 'loading' && !pagesShowing" class="kb-pgs-state" role="status">
      <div class="kb-pgs-progress"><i :style="{ width: `${Math.max(6, Math.round(progress * 100))}%` }"></i></div>
      <span class="m">正在加载文档…</span>
    </div>
    <div v-else-if="phase === 'error'" class="kb-pgs-state" role="alert">
      <span>{{ errorMessage }}</span>
    </div>
  </div>
</template>

<style>
.kb-pgs {
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
.kb-pgs-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}
/* 窄容器（手机）：缩略图是文档下方的横条，和正文上下排列，不盖住正文 */
.kb-pgs-body.is-compact {
  flex-direction: column;
}
.kb-pgs-body.is-compact > .kb-pgt {
  order: 2;
}
.kb-pgs-group {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.kb-pgs-btn {
  min-width: var(--ctl-h);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.kb-pgs-prev {
  transform: rotate(90deg);
}
.kb-pgs-next {
  transform: rotate(-90deg);
}
.kb-pgs-page {
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
.kb-pgs-total {
  color: var(--text-tertiary);
  font-size: calc(12px * var(--fs));
  white-space: nowrap;
}
.kb-pgs-zoom {
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
.kb-pgs-zoom:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--text-primary);
}
.kb-pgs-shapes-notice {
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
.kb-pgs-shapes-notice span {
  flex: 1;
  min-width: 0;
}
.kb-pgs-scroll {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  outline: none;
  touch-action: pan-x pan-y pinch-zoom;
}
.kb-pgs-host {
  width: max-content;
  min-width: 100%;
}
/* docx-preview 默认给 wrapper 一块灰底和 30px 内边距:换成主题底色,纸面保持白色 */
.kb-pgs .kbdocx-wrapper {
  background: transparent !important;
  padding: 12px 0 !important;
}
.kb-pgs .kbdocx-wrapper > section.kbdocx {
  background: #fff; /* tokens-allow: 纸面永远是白的 */
  color: #000; /* tokens-allow */
  box-shadow: var(--sh2) !important;
  margin-bottom: 14px !important;
}
/* 表格单元格不要继承应用的深色主题文字色(纸面是白的);run 上的显式颜色不受影响 */
.kb-pgs section.kbdocx td,
.kb-pgs section.kbdocx th,
.kb-pgs section.kbdocx p,
.kb-pgs section.kbdocx li {
  color: #000; /* tokens-allow */
}
/* 全站手机端把 table 改成卡片式 block/flex 布局;原貌渲染的文档表格要恢复成真表格 */
.kb-pgs section.kbdocx table { display: table !important; }
.kb-pgs section.kbdocx thead { display: table-header-group !important; }
.kb-pgs section.kbdocx tbody { display: table-row-group !important; }
.kb-pgs section.kbdocx tr { display: table-row !important; }
.kb-pgs section.kbdocx td,
.kb-pgs section.kbdocx th { display: table-cell !important; }

/* 逐批显示（docx-read.ts 的 revealPages）：还没轮到的页只有盒子没有内容，不参与布局；高度先按一页纸估，全部显示完摘掉标记后是真实高度 */
.kb-pgs-host.is-staging .kbdocx-wrapper > section.kbdocx:not(.is-shown) {
  content-visibility: hidden;
  contain-intrinsic-size: auto 1056px;
}
.kb-pgs-state {
  position: absolute;
  inset: 40px 0 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  text-align: center;
  background: var(--surface-sunken);
}
.kb-pgs-progress {
  width: min(240px, 60%);
  height: 4px;
  background: var(--chart-track);
  border-radius: var(--r-pill);
  overflow: hidden;
}
.kb-pgs-progress i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width var(--dur-base) var(--ease-out);
}

.kb-pgs-comments {
  flex: none;
  width: 300px;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--surface-1);
  border-left: var(--hl) solid var(--border-subtle);
}
.kb-pgs-comments-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: var(--hl) solid var(--border-subtle);
}
.kb-pgs-comment-list {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 6px;
  list-style: none;
  overflow: auto;
}
.kb-pgs-comment {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  padding: 8px;
  text-align: left;
  color: var(--text-primary);
  background: transparent;
  border: var(--hl) solid transparent;
  border-radius: var(--r2);
  cursor: pointer;
}
.kb-pgs-comment:hover,
.kb-pgs-comment.is-active {
  background: var(--surface-hover);
  border-color: var(--border-subtle);
}
.kb-pgs-comment-meta {
  display: flex;
  gap: 8px;
  align-items: baseline;
  color: var(--text-tertiary);
  font-size: calc(12px * var(--fs));
}
.kb-pgs-comment-quote {
  color: var(--text-tertiary);
  font-size: calc(12px * var(--fs));
  border-left: 2px solid var(--border-subtle);
  padding-left: 6px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.kb-pgs-comment-text {
  white-space: pre-wrap;
  word-break: break-word;
}
/* 高保真查看（PageSurface 适配器）：画布面挂在这个舞台里盖在轻预览之上，引擎排完第一帧才可见；
   加载提示盖在最上面，让用户知道点击有反应（引擎冷启动要几秒） */
.kb-pgs-hifi-stage {
  position: absolute;
  inset: 0;
  z-index: 4;
  background: var(--surface-sunken);
}
.kb-pgs-hifi-stage:not(.is-live) {
  visibility: hidden;
  pointer-events: none;
}
/* 高保真查看出错退回轻预览时的提示：盖在宿主区顶部，不改变正文布局 */
.kb-pgs-hifi-notice {
  position: absolute;
  inset: 0 0 auto 0;
  z-index: 6;
  background: color-mix(in srgb, var(--warn, #b45309) 10%, var(--surface-1));
}
.kb-pgs-hifi-loading {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--surface-sunken) 82%, transparent);
  font-size: calc(13px * var(--fs));
}
@media (max-width: 700px) {
  /* 窄屏：批注栏盖在文档上，不挤压阅读宽度 */
  .kb-pgs-comments {
    position: absolute;
    inset: 0 0 0 auto;
    width: min(320px, 100%);
    z-index: 3;
  }
}
@media (pointer: coarse) {
  .kb-pgs-btn,
  .kb-pgs-zoom,
  .kb-pgs-page {
    min-width: 36px;
    min-height: 36px;
  }
  /* 百分比按钮不是 .btn,没有全局的可点区域外扩:视觉 36px,伪元素外扩到 44px */
  .kb-pgs-zoom {
    position: relative;
  }
  .kb-pgs-zoom::before {
    content: '';
    position: absolute;
    inset: -4px;
  }
}
@media (max-width: 520px) {
  .kb-pgs-zoom-group {
    display: none;
  }
}
</style>
