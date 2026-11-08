<script setup lang="ts">
// 图片查看器:滚轮 / 捏合缩放(以指针为中心)、拖动平移、双击在「适应」与「100%」间切换、
// 键盘 + − 0 1。不加依赖;缩放改图片的实际宽高、平移用 translate。原图加载失败时 emit('broken') 让外层显示占位。
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { KbIcon } from '@kb-ui/index'

const props = defineProps<{ src: string; alt?: string }>()
const emit = defineEmits<{ broken: [] }>()

const stage = ref<HTMLElement | null>(null)
const image = ref<HTMLImageElement | null>(null)
const natural = ref({ width: 0, height: 0 })
const scale = ref(1)
const x = ref(0)
const y = ref(0)
const fitScale = ref(1)
const dragging = ref(false)

const MAX = 16

// 缩放用实际宽高而不是 transform: scale:Chrome 对「只改了 transform」的绝对定位图片不会重算父元素的可滚动溢出,
// 适应窗口(缩小)后 stage 仍按缩放前(scale=1)的范围报 scrollWidth > clientWidth——裁切巡检(clipcheck)在基线上就是红的,
// 虽然画面上什么也没被裁。改宽高会触发布局,溢出范围随之正确;平移仍是 transform(只挪位置,不影响范围)。
const imageStyle = computed(() => {
  const { width, height } = natural.value
  return {
    ...(width ? { width: `${width * scale.value}px`, height: `${height * scale.value}px` } : {}),
    transform: x.value === 0 && y.value === 0 ? 'translate(-50%, -50%)' : `translate(calc(-50% + ${x.value}px), calc(-50% + ${y.value}px))`,
  }
})
const percent = computed(() => `${Math.round(scale.value * 100)}%`)
const atFit = computed(() => Math.abs(scale.value - fitScale.value) < 0.001)

function measureFit() {
  const box = stage.value
  if (!box || !natural.value.width) return
  const next = Math.min(1, (box.clientWidth - 16) / natural.value.width, (box.clientHeight - 16) / natural.value.height)
  const wasFit = atFit.value || scale.value === 1
  fitScale.value = next
  if (wasFit) fit()
}
function fit() {
  scale.value = fitScale.value
  x.value = 0
  y.value = 0
}
function actual() {
  scale.value = 1
  x.value = 0
  y.value = 0
}
function onLoad() {
  const element = image.value
  if (!element) return
  natural.value = { width: element.naturalWidth, height: element.naturalHeight }
  measureFit()
}
/** 以 (cx, cy)(相对舞台中心)为不动点缩放 */
function zoomAt(factor: number, cx = 0, cy = 0) {
  const next = Math.min(MAX, Math.max(fitScale.value * 0.5, scale.value * factor))
  const ratio = next / scale.value
  x.value = cx - (cx - x.value) * ratio
  y.value = cy - (cy - y.value) * ratio
  scale.value = next
}
function centerOf(event: { clientX: number; clientY: number }) {
  const box = stage.value!.getBoundingClientRect()
  return { cx: event.clientX - box.left - box.width / 2, cy: event.clientY - box.top - box.height / 2 }
}
function onWheel(event: WheelEvent) {
  event.preventDefault()
  const { cx, cy } = centerOf(event)
  zoomAt(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0025)), cx, cy)
}
function onDouble(event: MouseEvent) {
  if (atFit.value) {
    const { cx, cy } = centerOf(event)
    const target = Math.max(1, fitScale.value * 2)
    zoomAt(target / scale.value, cx, cy)
  } else fit()
}

const pointers = new Map<number, { x: number; y: number }>()
let lastDistance = 0
function onDown(event: PointerEvent) {
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  dragging.value = pointers.size === 1
  lastDistance = 0
}
function onMove(event: PointerEvent) {
  const previous = pointers.get(event.pointerId)
  if (!previous) return
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()]
    const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y)
    if (lastDistance) {
      const mid = centerOf({ clientX: (a!.x + b!.x) / 2, clientY: (a!.y + b!.y) / 2 })
      zoomAt(distance / lastDistance, mid.cx, mid.cy)
    }
    lastDistance = distance
  } else if (pointers.size === 1) {
    x.value += event.clientX - previous.x
    y.value += event.clientY - previous.y
  }
}
function onUp(event: PointerEvent) {
  pointers.delete(event.pointerId)
  dragging.value = false
  lastDistance = 0
}
function onKey(event: KeyboardEvent) {
  if (event.key === '+' || event.key === '=') zoomAt(1.25)
  else if (event.key === '-') zoomAt(1 / 1.25)
  else if (event.key === '0') fit()
  else if (event.key === '1') actual()
  else return
  event.preventDefault()
}

let observer: ResizeObserver | null = null
function bind(element: HTMLElement | null) {
  observer?.disconnect()
  if (element && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(measureFit)
    observer.observe(element)
  }
}
watch(stage, bind, { flush: 'post' })
watch(() => props.src, () => (natural.value = { width: 0, height: 0 }))
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div class="kb-iv">
    <div
      ref="stage"
      class="kb-iv-stage"
      :class="{ 'is-dragging': dragging }"
      tabindex="0"
      role="img"
      :aria-label="alt ?? '图片'"
      @wheel="onWheel"
      @dblclick="onDouble"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
      @keydown="onKey"
    >
      <img
        ref="image"
        class="kb-iv-img"
        :src="src"
        :alt="alt ?? ''"
        draggable="false"
        :style="imageStyle"
        style-allow="缩放与平移由用户操作决定"
        @load="onLoad"
        @error="emit('broken')"
      />
    </div>
    <div class="kb-iv-tools" role="toolbar" aria-label="图片缩放">
      <button type="button" class="btn sm kb-iv-btn" aria-label="缩小" @click="zoomAt(1 / 1.25)"><KbIcon name="minus" :size="12" /></button>
      <button type="button" class="mono kb-iv-pct" title="适应窗口" @click="fit">{{ percent }}</button>
      <button type="button" class="btn sm kb-iv-btn" aria-label="放大" @click="zoomAt(1.25)"><KbIcon name="plus" :size="12" /></button>
      <button type="button" class="btn sm kb-iv-btn kb-iv-actual" title="原始大小" @click="actual">1:1</button>
    </div>
  </div>
</template>

<style>
.kb-iv {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: calc(var(--row-h) * 8);
  display: flex;
  border: var(--hl) solid var(--b2);
  border-radius: var(--r2);
  background: var(--surface-sunken);
  overflow: hidden;
}
.kb-iv-stage {
  position: relative;
  flex: 1;
  overflow: hidden;
  outline: none;
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.kb-iv-stage.is-dragging {
  cursor: grabbing;
}
.kb-iv-stage:focus-visible {
  box-shadow: inset 0 0 0 2px var(--accent);
}
.kb-iv-img {
  position: absolute;
  left: 50%;
  top: 50%;
  max-width: none;
  transform-origin: center center;
  will-change: transform;
  background: repeating-conic-gradient(rgba(var(--ink), 0.06) 0% 25%, transparent 0% 50%) 50% / 16px 16px;
}
.kb-iv-tools {
  position: absolute;
  right: 10px;
  bottom: 10px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  background: var(--surface-3);
  border: var(--hl) solid var(--b2);
  border-radius: var(--r2);
  box-shadow: var(--sh2);
}
.kb-iv-btn {
  min-width: var(--ctl-h);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.kb-iv-pct {
  min-width: 4ch;
  height: var(--ctl-h);
  color: var(--t2);
  background: transparent;
  border: 0;
  cursor: pointer;
  font-size: calc(12px * var(--fs));
}
@media (pointer: coarse) {
  .kb-iv-btn,
  .kb-iv-pct {
    min-width: 36px;
    min-height: 36px;
  }
  /* 百分比按钮不是 .btn,没有全局的可点区域外扩:视觉 36px,伪元素外扩到 44px */
  .kb-iv-pct {
    position: relative;
  }
  .kb-iv-pct::before {
    content: '';
    position: absolute;
    inset: -4px;
  }
}
</style>
