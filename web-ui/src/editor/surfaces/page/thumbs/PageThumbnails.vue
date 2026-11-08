<script setup lang="ts">
/**
 * 页缩略图栏（补全）：Word 分页文档的只读预览与画布编辑共用
 *
 * 交互与幻灯片目录保持一致（同样的缩略图宽度、选中色、编号），差别是页是纵向排版的长文档：
 *  - 缩略图后台生成（见 thumbQueue.ts）：可见的先生成，做好的缓存，栏滚动时按新的可见范围重排；
 *  - 点缩略图跳到那一页；当前页高亮（`aria-current="page"`）并随主视图滚动自动滚进栏的可见区；
 *  - 键盘：Tab 进栏落在当前页上，↑↓（横条里 ←→）移动焦点，Home / End / PageUp / PageDown，Enter 或空格跳页，Esc 回到正文；
 *  - 宽屏是左侧纵栏，窄屏（手机）是文档下方的横条——横条与正文上下排列，不盖住正文。
 * 缩略图从哪来由 `source` 决定（DOM 克隆 / 引擎位图），栏本身不认识文档。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, watch } from 'vue'
import { revealOffset, visibleRange } from './scrollSync'
import { ThumbQueue } from './thumbQueue'
import { thumbBoxFor, type ThumbOrientation, type ThumbSource } from './types'

const props = withDefaults(
  defineProps<{
    /** 总页数 */
    count: number
    /** 当前页（1 起） */
    current: number
    /** 每页的宽高比（宽 / 高）；缺省按 Letter */
    aspects?: readonly number[]
    source: ThumbSource | null
    orientation?: ThumbOrientation
    /** 缓存的缩略图条数上限 */
    cacheLimit?: number
    /** 两次开工之间的最短间隔（毫秒）：编辑时大批页面同时过期，不连着占满 CPU */
    minGapMs?: number
    /** 暂停后台生成（用户正在输入 / 文档刚打开还没空闲）：已有的缩略图照常显示 */
    paused?: boolean
  }>(),
  { aspects: () => [], orientation: 'vertical', cacheLimit: 80, minGapMs: 0, paused: false },
)
const emit = defineEmits<{
  select: [page: number]
  /** Esc：焦点回到正文 */
  leave: []
}>()

const list = ref<HTMLElement | null>(null)
const tabStop = ref(Math.max(0, props.current - 1))
const slots = new Map<number, HTMLElement>()
const buttons = new Map<number, HTMLElement>()

const vertical = computed(() => props.orientation === 'vertical')
const aspectSignature = computed(() => props.aspects.join(','))
const dpr = () => Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1)

function boxOf(index: number): { width: number; height: number } {
  return thumbBoxFor(props.aspects[index] ?? NaN, props.orientation)
}
function slotStyle(index: number): Record<string, string> {
  const box = boxOf(index)
  return { width: `${box.width}px`, height: `${box.height}px` }
}

/* ---------------- 生成队列 ---------------- */

let queue: ThumbQueue<HTMLElement> | null = null
let activeSource: ThumbSource | null = null

function place(index: number, artifact: HTMLElement): void {
  const slot = slots.get(index)
  if (!slot) return
  slot.replaceChildren(artifact)
  slot.dataset.state = 'ready'
}

function buildQueue(): void {
  queue?.dispose()
  queue = null
  activeSource?.dispose?.()
  activeSource = props.source
  for (const slot of slots.values()) {
    slot.replaceChildren()
    slot.dataset.state = 'pending'
  }
  const source = props.source
  if (!source) return
  queue = new ThumbQueue<HTMLElement>({
    limit: props.cacheLimit,
    minGapMs: props.minGapMs,
    render: (index, signal) => source.render(index, { ...boxOf(index), dpr: dpr() }, signal),
    onReady: (index, artifact) => place(index, artifact),
    onEvict: (index, artifact) => {
      // 被淘汰 / 被新图替换：如果槽里放的还是它就清空槽，再交给来源释放资源
      const slot = slots.get(index)
      if (slot && artifact.parentElement === slot) {
        slot.replaceChildren()
        slot.dataset.state = 'pending'
      }
      artifact.remove()
      source.release?.(artifact)
    },
    onError: (index) => {
      const slot = slots.get(index)
      if (slot) slot.dataset.state = 'error'
    },
  })
  if (props.paused) queue.pause()
  queue.setCount(props.count)
  measure()
}

function setSlot(index: number, element: unknown): void {
  if (element instanceof HTMLElement) {
    slots.set(index, element)
    // 槽被重建（v-for 重排）而缓存里已有图：补挂回去
    const cached = queue?.get(index)
    if (cached && cached.parentElement !== element) place(index, cached)
  } else slots.delete(index)
}
function setButton(index: number, element: unknown): void {
  if (element instanceof HTMLElement) buttons.set(index, element)
  else buttons.delete(index)
}

/* ---------------- 可见范围 ---------------- */

let measureFrame = 0
function scheduleMeasure(): void {
  if (measureFrame) return
  measureFrame = requestAnimationFrame(() => {
    measureFrame = 0
    measure()
  })
}

/** 沿滚动方向读第 index 项的起点 / 长度；纵栏用 offsetTop / offsetHeight，横条用 offsetLeft / offsetWidth */
function startOf(index: number): number {
  const item = buttons.get(index)?.parentElement
  if (!item) return 0
  return vertical.value ? item.offsetTop : item.offsetLeft
}
function sizeOf(index: number): number {
  const item = buttons.get(index)?.parentElement
  if (!item) return 0
  return vertical.value ? item.offsetHeight : item.offsetWidth
}

function measure(): void {
  const element = list.value
  if (!element || !queue) return
  const offset = vertical.value ? element.scrollTop : element.scrollLeft
  const view = vertical.value ? element.clientHeight : element.clientWidth
  // 栏还没有尺寸（jsdom / display:none）：按当前页附近估一个范围，别让队列空等
  const range = view > 0 ? visibleRange(props.count, startOf, sizeOf, offset, view) : props.count ? { first: Math.max(0, props.current - 3), last: Math.min(props.count - 1, props.current + 3) } : null
  queue.setView(range, props.current - 1)
}

/* ---------------- 当前页跟随 ---------------- */

let lastUserScroll = 0
function noteUserScroll(): void {
  lastUserScroll = Date.now()
}

/** 当前页的缩略图不完全可见就滚进来；用户刚自己滚过栏的一小会儿内不抢滚动条 */
function reveal(index: number): void {
  const element = list.value
  const item = buttons.get(index)?.parentElement
  if (!element || !item) return
  if (Date.now() - lastUserScroll < 600) return
  const view = vertical.value ? element.clientHeight : element.clientWidth
  if (view <= 0) return
  const offset = vertical.value ? element.scrollTop : element.scrollLeft
  const next = revealOffset({ start: vertical.value ? item.offsetTop : item.offsetLeft, size: vertical.value ? item.offsetHeight : item.offsetWidth, offset, view })
  if (Math.abs(next - offset) < 1) return
  if (vertical.value) element.scrollTop = next
  else element.scrollLeft = next
}

watch(
  () => props.current,
  (page) => {
    // 焦点不在栏里时，Tab 停靠点跟着当前页走（Tab 进栏就落在当前页上）
    if (!list.value?.contains(document.activeElement)) tabStop.value = page - 1
    void nextTick(() => {
      reveal(page - 1)
      measure()
    })
  },
)

/* ---------------- 键盘 ---------------- */

function focusItem(index: number): void {
  const target = Math.min(props.count - 1, Math.max(0, index))
  tabStop.value = target
  void nextTick(() => {
    const button = buttons.get(target)
    button?.focus({ preventScroll: true })
    // 键盘移动是用户意图：不受"刚滚过"限制，直接滚进可见区
    lastUserScroll = 0
    reveal(target)
  })
}

function onKeydown(event: KeyboardEvent): void {
  if (event.ctrlKey || event.metaKey || event.altKey) return
  const at = tabStop.value
  const page = Math.max(1, Math.floor((vertical.value ? (list.value?.clientHeight ?? 0) / (sizeOf(0) || 1) : (list.value?.clientWidth ?? 0) / (sizeOf(0) || 1)) || 4))
  let target: number | null = null
  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowRight':
      target = at + 1
      break
    case 'ArrowUp':
    case 'ArrowLeft':
      target = at - 1
      break
    case 'Home':
      target = 0
      break
    case 'End':
      target = props.count - 1
      break
    case 'PageDown':
      target = at + page
      break
    case 'PageUp':
      target = at - page
      break
    case 'Escape':
      event.preventDefault()
      emit('leave')
      return
    default:
      return
  }
  event.preventDefault()
  focusItem(target)
}

function select(index: number): void {
  tabStop.value = index
  emit('select', index + 1)
}

/* ---------------- 生命周期 ---------------- */

let observer: ResizeObserver | null = null

onMounted(() => {
  buildQueue()
  if (typeof ResizeObserver !== 'undefined' && list.value) {
    observer = new ResizeObserver(scheduleMeasure)
    observer.observe(list.value)
  }
  void nextTick(() => {
    measure()
    reveal(props.current - 1)
  })
})
onUpdated(scheduleMeasure)
onBeforeUnmount(() => {
  if (measureFrame) cancelAnimationFrame(measureFrame)
  observer?.disconnect()
  queue?.dispose()
  queue = null
  activeSource?.dispose?.()
  activeSource = null
})

watch(() => props.source, buildQueue)
watch(
  () => props.paused,
  (paused) => (paused ? queue?.pause() : queue?.resume()),
)
watch(
  () => props.count,
  (count) => {
    queue?.setCount(count)
    tabStop.value = Math.min(tabStop.value, Math.max(0, count - 1))
    void nextTick(measure)
  },
)
// 纵横比或方向变了：盒子尺寸变了，已经生成的图尺寸不对，全部重画
watch([aspectSignature, () => props.orientation], () => {
  queue?.invalidate()
  void nextTick(measure)
})

defineExpose({
  /** 这些页（0 起）的内容变了；不传 = 全部。旧图继续显示，新图画好再换 */
  invalidate: (indices?: Iterable<number>) => queue?.invalidate(indices),
  /** 从第 index 页（0 起）往后都失效 */
  invalidateFrom: (index: number) => queue?.invalidateFrom(index),
  pause: () => queue?.pause(),
  resume: () => queue?.resume(),
  /** 已缓存的缩略图条数（测试 / 诊断） */
  cached: () => queue?.size ?? 0,
})
</script>

<template>
  <aside class="kb-pgt" :class="`is-${orientation}`" aria-label="页面缩略图" data-testid="page-thumbs" :data-orientation="orientation">
    <ol ref="list" class="kb-pgt-list" @scroll.passive="scheduleMeasure" @wheel.passive="noteUserScroll" @touchmove.passive="noteUserScroll" @keydown="onKeydown">
      <li v-for="n in count" :key="n" class="kb-pgt-item">
        <button
          :ref="(element) => setButton(n - 1, element)"
          type="button"
          class="kb-pgt-thumb"
          :class="{ 'is-on': n === current }"
          :aria-current="n === current ? 'page' : undefined"
          :tabindex="n - 1 === tabStop ? 0 : -1"
          :data-page="n"
          data-testid="page-thumb"
          @click="select(n - 1)"
          @focus="tabStop = n - 1"
        >
          <span :ref="(element) => setSlot(n - 1, element)" class="kb-pgt-slot" :style="slotStyle(n - 1)" data-state="pending" aria-hidden="true"></span>
          <span class="mono kb-pgt-no" aria-hidden="true">{{ n }}</span>
          <!-- 可访问名称用按钮内容而不是 aria-label：可见的只有页码数字，aria-label 与它对不上会被 axe 判 label-content-name-mismatch -->
          <span class="kb-pgt-name">第 {{ n }} 页，共 {{ count }} 页</span>
        </button>
      </li>
    </ol>
  </aside>
</template>

<style>
.kb-pgt {
  flex: none;
  display: flex;
  min-width: 0;
  min-height: 0;
  background: var(--surface-1);
  box-sizing: border-box;
}
.kb-pgt.is-vertical {
  width: 184px;
  border-right: var(--hl) solid var(--border-subtle);
}
.kb-pgt.is-horizontal {
  width: 100%;
  border-top: var(--hl) solid var(--border-subtle);
}
.kb-pgt-list {
  flex: 1;
  min-width: 0;
  min-height: 0;
  margin: 0;
  padding: 8px;
  list-style: none;
  display: flex;
  gap: 6px;
  position: relative;
  box-sizing: border-box;
  overscroll-behavior: contain;
}
.kb-pgt.is-vertical .kb-pgt-list {
  flex-direction: column;
  overflow-y: auto;
  overflow-x: hidden;
}
.kb-pgt.is-horizontal .kb-pgt-list {
  flex-direction: row;
  overflow-x: auto;
  overflow-y: hidden;
  touch-action: pan-x;
}
.kb-pgt-item {
  flex: none;
  display: flex;
}
.kb-pgt-thumb {
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
}
.kb-pgt-thumb:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}
.kb-pgt-thumb.is-on {
  color: var(--text-primary);
  background: var(--accent-soft);
  border-color: var(--accent);
}
/* 只给读屏看的页名（视觉隐藏） */
.kb-pgt-name {
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
.kb-pgt-no {
  font-size: calc(11px * var(--fs));
  color: var(--text-tertiary);
}
/* 纸面永远是白的，深色模式只改界面不改文档 */
.kb-pgt-slot {
  position: relative;
  display: block;
  flex: none;
  overflow: hidden;
  background: #fff; /* tokens-allow: 纸面永远是白的 */
  border: var(--hl) solid var(--border-subtle);
  box-shadow: var(--sh1);
  box-sizing: content-box;
}
.kb-pgt-slot[data-state='error'] {
  background: repeating-linear-gradient(135deg, #f3f3f3 0 6px, #e9e9e9 6px 12px); /* tokens-allow: 纸面占位 */
}
.kb-pgt-slot canvas,
.kb-pgt-slot img {
  display: block;
  width: 100%;
  height: 100%;
}
.kb-pgt-clip {
  position: absolute;
  inset: 0;
  display: block;
  overflow: hidden;
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
}
/* 克隆页的版式：docx-preview 把这几条写在 section.kbdocx 上，克隆体换成了 div，在这里照抄 */
.kb-pgt-sheet {
  box-sizing: border-box;
  display: flex;
  flex-flow: column nowrap;
  position: absolute;
  top: 0;
  left: 0;
  overflow: hidden;
  background: #fff; /* tokens-allow: 纸面永远是白的 */
  color: #000; /* tokens-allow */
  pointer-events: none;
}
.kb-pgt-sheet > article {
  margin-bottom: auto;
  z-index: 1;
}
.kb-pgt-sheet > footer {
  z-index: 1;
}
.kb-pgt-sheet td,
.kb-pgt-sheet th,
.kb-pgt-sheet p,
.kb-pgt-sheet li {
  color: #000; /* tokens-allow */
}
/* 全站手机端把 table 改成卡片式 block/flex 布局;文档里的表格要恢复成真表格(与正文同样处理) */
.kb-pgt-sheet table { display: table !important; }
.kb-pgt-sheet thead { display: table-header-group !important; }
.kb-pgt-sheet tbody { display: table-row-group !important; }
.kb-pgt-sheet tr { display: table-row !important; }
.kb-pgt-sheet td,
.kb-pgt-sheet th { display: table-cell !important; }

.kb-pgt-thumb {
  position: relative;
}
/* 横条里省高度：页码叠在缩略图右下角，不单占一行 */
.kb-pgt.is-horizontal .kb-pgt-thumb {
  padding: 4px;
}
.kb-pgt.is-horizontal .kb-pgt-no {
  position: absolute;
  right: 6px;
  bottom: 6px;
  padding: 0 4px;
  line-height: 1.5;
  color: var(--text-primary);
  background: color-mix(in srgb, var(--surface-1) 85%, transparent);
  border-radius: var(--r1);
}
@media (pointer: coarse) {
  .kb-pgt-thumb {
    min-width: 44px;
    min-height: 44px;
  }
}
</style>
