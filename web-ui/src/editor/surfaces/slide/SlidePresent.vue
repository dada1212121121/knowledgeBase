<script setup lang="ts">
/**
 * 放映模式
 *
 * - 全屏：优先用浏览器 Fullscreen API；不支持或被拒绝（iOS Safari 不让非视频元素全屏、被嵌在受限 iframe）
 *   时退成铺满视口的固定层，功能一样，只是没有隐藏浏览器地址栏。
 * - 键盘：→ ↓ PageDown 空格 回车 下一页；← ↑ PageUp 退格 上一页；Home / End；Esc 退出。
 *   浏览器全屏时 Esc 会先被浏览器吃掉去退出全屏，这里监听 fullscreenchange 同步关掉放映。
 * - 触屏：左右滑翻页；轻点左 1/3 上一页、其余下一页；控制条轻点后出现，几秒后自动收起。
 * - 隐藏页跳过。
 * 画布用和主视图同一个 SlideRenderer（位图缓存共享，只是目标比例不同）；翻页前预渲染下一页。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { KbIcon } from '@kb-ui/index'
import type { SlideRenderer } from './renderer'
import { classifyGesture, tapTarget } from './swipe'
import type { SlideBackend, SlideSummary } from './types'
import { MAX_ZOOM, fitScale, cssSize } from './zoom'

const props = defineProps<{
  backend: SlideBackend
  renderer: SlideRenderer
  slides: readonly SlideSummary[]
  /** 从第几页开始（0 起） */
  start: number
}>()
const emit = defineEmits<{ exit: [index: number]; change: [index: number] }>()

const root = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const index = ref(props.start)
const controlsShown = ref(true)
const fullscreen = ref(false)
const viewport = ref({ width: window.innerWidth, height: window.innerHeight })
let hideTimer = 0
let paintSeq = 0
let down: { x: number; y: number; t: number; id: number } | null = null
let disposed = false

const dpr = () => Math.min(window.devicePixelRatio || 1, 2)

function visibleOrder(): number[] {
  const list: number[] = []
  props.slides.forEach((slide, i) => {
    if (!slide.hidden || i === index.value) list.push(i)
  })
  return list
}

/** 下一页 / 上一页（跳过隐藏页）；到头了返回 null */
function neighbour(direction: 1 | -1): number | null {
  const order = visibleOrder()
  const at = order.indexOf(index.value)
  const next = order[at + direction]
  return next === undefined ? null : next
}

function scaleFor(): number {
  return fitScale(viewport.value, props.backend.size, 'page', 0, MAX_ZOOM)
}

async function show() {
  const cv = canvas.value
  if (!cv || disposed) return
  const token = ++paintSeq
  const scale = scaleFor()
  const ratio = dpr()
  try {
    const rendered = await props.renderer.render(index.value, scale, ratio)
    if (token !== paintSeq || disposed) return
    cv.width = rendered.width
    cv.height = rendered.height
    cv.getContext('2d')?.drawImage(rendered.canvas as CanvasImageSource, 0, 0)
    const css = cssSize(props.backend.size, scale)
    cv.style.width = `${css.width}px`
    cv.style.height = `${css.height}px`
  } catch {
    // 单页画不出来就停在上一页的画面，不退出放映
    return
  }
  // 预渲染下一页：翻页时直接贴图
  const next = neighbour(1)
  if (next !== null) void props.renderer.render(next, scale, ratio).catch(() => undefined)
}

function go(target: number | null) {
  if (target === null || target === index.value) return
  index.value = target
  emit('change', target)
}
const next = () => go(neighbour(1))
const prev = () => go(neighbour(-1))

function exit() {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
  emit('exit', index.value)
}

function onKey(event: KeyboardEvent) {
  if (event.ctrlKey || event.metaKey || event.altKey) return
  const key = event.key
  if (key === 'Escape') {
    event.preventDefault()
    exit()
  } else if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n', 'N'].includes(key)) {
    event.preventDefault()
    next()
  } else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p', 'P'].includes(key)) {
    event.preventDefault()
    prev()
  } else if (key === 'Home') {
    event.preventDefault()
    go(visibleOrder()[0] ?? 0)
  } else if (key === 'End') {
    event.preventDefault()
    go(visibleOrder().at(-1) ?? 0)
  }
}

function pokeControls() {
  controlsShown.value = true
  window.clearTimeout(hideTimer)
  hideTimer = window.setTimeout(() => (controlsShown.value = false), 2600)
}

function onPointerDown(event: PointerEvent) {
  if ((event.target as HTMLElement).closest('.kb-sl-pres-bar')) return
  down = { x: event.clientX, y: event.clientY, t: performance.now(), id: event.pointerId }
}
function onPointerUp(event: PointerEvent) {
  const start = down
  down = null
  if (!start || start.id !== event.pointerId) return
  const gesture = classifyGesture({ dx: event.clientX - start.x, dy: event.clientY - start.y, dt: performance.now() - start.t })
  if (gesture === 'next') next()
  else if (gesture === 'prev') prev()
  else if (gesture === 'tap') {
    // 触屏轻点 = 翻页；鼠标点击也一样（和 PowerPoint 放映一致），同时唤出控制条
    pokeControls()
    if (tapTarget(event.clientX, viewport.value.width) === 'prev') prev()
    else next()
  }
}

function onResize() {
  viewport.value = { width: root.value?.clientWidth || window.innerWidth, height: root.value?.clientHeight || window.innerHeight }
}
function onFullscreenChange() {
  const active = document.fullscreenElement === root.value
  // 之前在全屏、现在不在了 = 用户按 Esc / 浏览器按钮退出，同步关掉放映
  if (fullscreen.value && !active) emit('exit', index.value)
  fullscreen.value = active
  onResize()
}

watch(index, () => void show())
watch(viewport, () => void show(), { deep: true })

onMounted(async () => {
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('resize', onResize)
  document.addEventListener('fullscreenchange', onFullscreenChange)
  await nextTick()
  onResize()
  root.value?.focus({ preventScroll: true })
  try {
    // 必须在用户手势触发的同一个调用栈附近调用；被拒绝就用固定层兜底
    await root.value?.requestFullscreen?.()
    fullscreen.value = document.fullscreenElement === root.value
  } catch {
    fullscreen.value = false
  }
  onResize()
  void show()
  pokeControls()
})
onBeforeUnmount(() => {
  disposed = true
  window.removeEventListener('keydown', onKey, true)
  window.removeEventListener('resize', onResize)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  window.clearTimeout(hideTimer)
  if (document.fullscreenElement === root.value) void document.exitFullscreen().catch(() => undefined)
})
</script>

<template>
  <div
    ref="root"
    class="kb-sl-pres"
    data-testid="slide-present"
    role="dialog"
    aria-modal="true"
    aria-label="幻灯片放映"
    tabindex="-1"
    @pointerdown="onPointerDown"
    @pointerup="onPointerUp"
    @pointermove="pokeControls"
  >
    <canvas ref="canvas" class="kb-sl-pres-canvas" role="img" :aria-label="`第 ${index + 1} 张，共 ${slides.length} 张${slides[index]?.title ? '：' + slides[index]!.title : ''}`"></canvas>
    <div class="kb-sl-pres-bar" :class="{ 'is-shown': controlsShown }" role="toolbar" aria-label="放映控制">
      <button type="button" class="kb-sl-pres-btn" aria-label="上一张" :disabled="neighbour(-1) === null" data-testid="slide-present-prev" @click="prev">
        <KbIcon name="chevron" :size="16" class="kb-sl-prev" />
      </button>
      <span class="mono kb-sl-pres-no" data-testid="slide-present-no">{{ index + 1 }} / {{ slides.length }}</span>
      <button type="button" class="kb-sl-pres-btn" aria-label="下一张" :disabled="neighbour(1) === null" data-testid="slide-present-next" @click="next">
        <KbIcon name="chevron" :size="16" class="kb-sl-next" />
      </button>
      <button type="button" class="kb-sl-pres-btn" aria-label="退出放映" data-testid="slide-present-exit" @click="exit">
        <KbIcon name="close" :size="16" />
      </button>
    </div>
  </div>
</template>

<style>
.kb-sl-pres {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
  outline: none;
  /* 横向滑动由我们自己处理成翻页，纵向交给浏览器（不会误触发下拉刷新以外的东西） */
  touch-action: pan-y;
  user-select: none;
  -webkit-user-select: none;
}
.kb-sl-pres-canvas {
  display: block;
  max-width: 100%;
  max-height: 100%;
}
.kb-sl-pres-bar {
  position: absolute;
  left: 50%;
  bottom: max(16px, env(safe-area-inset-bottom));
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  color: #fff;
  background: rgba(20, 20, 24, 0.82);
  border-radius: 999px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.18s ease;
}
.kb-sl-pres-bar.is-shown,
.kb-sl-pres-bar:focus-within {
  opacity: 1;
  pointer-events: auto;
}
.kb-sl-pres-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 36px;
  min-height: 36px;
  padding: 0;
  color: inherit;
  background: transparent;
  border: 0;
  border-radius: 999px;
  cursor: pointer;
}
.kb-sl-pres-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.16);
}
.kb-sl-pres-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.kb-sl-pres-no {
  min-width: 6ch;
  text-align: center;
  font-size: 13px;
}
.kb-sl-pres .kb-sl-prev {
  transform: rotate(90deg);
}
.kb-sl-pres .kb-sl-next {
  transform: rotate(-90deg);
}
@media (prefers-reduced-motion: reduce) {
  .kb-sl-pres-bar {
    transition: none;
  }
}
</style>
