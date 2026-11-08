<script setup lang="ts">
/**
 * 画布上的编辑交互层
 *
 * 只做"事件翻译 + 画出控制器的状态"：指针 / 键盘 / 输入法事件翻译成 `SlideEditor` 的调用，
 * 选中框、控制点、吸附线、光标、选区、输入法预编辑文字照控制器的状态画出来。所有判断（点中了什么、拖动阈值、
 * 能不能缩放）都在控制器里，这里没有业务逻辑，也就不需要在组件里再测一遍。
 *
 * 文字输入走一个看不见的 <textarea>（浏览器输入法只认真实的可编辑元素），放在光标位置，
 * 这样输入法的候选框会出现在光标旁边，而不是页面角落。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import SlideOverlay from './SlideOverlay.vue'
import type { HandleId } from './overlay'
import type { SlideEditor } from './pptx-edit'

const props = defineProps<{
  editor: SlideEditor
  /** 画布 CSS 尺寸 / 幻灯片逻辑尺寸 */
  scale: number
  width: number
  height: number
  /** 幻灯片逻辑宽度：换算屏幕坐标用（CSS 尺寸是取整的，直接除 scale 会有零点几像素的误差） */
  slideWidth: number
}>()

const root = ref<HTMLElement | null>(null)
const input = ref<HTMLTextAreaElement | null>(null)
const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

const state = props.editor
let lastDown = { t: 0, x: 0, y: 0 }
let capturedId = -1

function toSlide(event: { clientX: number; clientY: number }) {
  const rect = root.value!.getBoundingClientRect()
  const k = rect.width / props.slideWidth || props.scale || 1
  return { x: (event.clientX - rect.left) / k, y: (event.clientY - rect.top) / k }
}

function capture(event: PointerEvent) {
  try {
    root.value?.setPointerCapture(event.pointerId)
    capturedId = event.pointerId
  } catch {
    capturedId = -1
  }
}

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0) return
  // 连击计数：pointerdown 的 detail 恒为 0，自己按时间和位置算（400 ms、6 px 内算连击）
  const now = performance.now()
  const double = now - lastDown.t < 400 && Math.hypot(event.clientX - lastDown.x, event.clientY - lastDown.y) < 6
  lastDown = { t: double ? 0 : now, x: event.clientX, y: event.clientY }
  const result = state.pointerDown(toSlide(event), { shift: event.shiftKey, detail: double ? 2 : 1 })
  if (result !== 'none') {
    capture(event)
    event.preventDefault()
  }
  // 点在空白处：焦点回到舞台，方向键 / Delete 继续可用
  void nextTick(() => (state.text.value ? input.value?.focus({ preventScroll: true }) : root.value?.closest<HTMLElement>('.kb-sl-stage')?.focus({ preventScroll: true })))
}

function onPointerMove(event: PointerEvent) {
  if (capturedId !== event.pointerId) return
  state.pointerMove(toSlide(event), { alt: event.altKey, shift: event.shiftKey })
}

function onPointerUp(event: PointerEvent) {
  if (capturedId !== event.pointerId) return
  capturedId = -1
  try {
    root.value?.releasePointerCapture(event.pointerId)
  } catch {
    /* 已经释放 */
  }
  state.pointerUp()
}

function onPointerCancel() {
  capturedId = -1
  state.cancelGesture()
}

function onHandleDown(handle: HandleId, event: PointerEvent) {
  state.startResize(handle, toSlide(event), { shift: event.shiftKey })
  capture(event)
  event.preventDefault()
}

/* ---------------- 隐藏输入框 ---------------- */

function onBeforeInput(event: InputEvent) {
  const handled = state.beforeInput({
    inputType: event.inputType,
    data: event.data,
    isComposing: event.isComposing,
    dataTransferText: event.dataTransfer?.getData('text/plain') || undefined,
  })
  if (handled) event.preventDefault()
}

function onKeydown(event: KeyboardEvent) {
  // 撤销 / 重做 / 保存 / 查找留给外壳的快捷键处理（它挂在更外层，焦点在编辑器内部时会拦截）
  if (state.textKeyDown(event)) event.preventDefault()
}

function onCompositionStart() {
  state.compositionStart()
}
function onCompositionUpdate(event: CompositionEvent) {
  state.compositionUpdate(event.data)
}
function onCompositionEnd(event: CompositionEvent) {
  state.compositionEnd(event.data)
  if (input.value) input.value.value = ''
}

/** 没在组字时输入框里不该留任何内容：我们自己接管了所有写入 */
function onInput() {
  if (!state.isComposing && input.value) input.value.value = ''
}

function onPaste(event: ClipboardEvent) {
  event.preventDefault()
  const pasted = event.clipboardData?.getData('text/plain') ?? ''
  if (pasted) state.beforeInput({ inputType: 'insertFromPaste', data: pasted })
}
function onCopy(event: ClipboardEvent) {
  event.preventDefault()
  event.clipboardData?.setData('text/plain', state.selectedText())
}
function onCut(event: ClipboardEvent) {
  event.preventDefault()
  event.clipboardData?.setData('text/plain', state.cutSelection())
}

function focusInput() {
  void nextTick(() => input.value?.focus({ preventScroll: true }))
}
watch(
  () => state.text.value?.storyId,
  (story) => {
    if (story) focusInput()
  },
)

/* ---------------- 要画的东西 ---------------- */

const caretStyle = computed(() => {
  const caret = state.caret.value
  if (!caret) return null
  return { left: `${caret.x * props.scale}px`, top: `${caret.y * props.scale}px`, height: `${Math.max(2, caret.height * props.scale)}px` }
})
const caretKey = computed(() => `${state.caret.value?.x}:${state.caret.value?.y}`)
const hasRange = computed(() => {
  const text = state.text.value
  return !!text && text.anchor !== text.focus
})
const preeditStyle = computed(() => {
  const caret = state.caret.value
  if (!caret) return null
  const size = Math.max(10, caret.height * props.scale * 0.8)
  return { left: `${caret.x * props.scale}px`, top: `${caret.y * props.scale}px`, height: `${caret.height * props.scale}px`, fontSize: `${size}px`, lineHeight: `${caret.height * props.scale}px` }
})
const rectStyle = (rect: { x: number; y: number; width: number; height: number }) => ({
  left: `${rect.x * props.scale}px`,
  top: `${rect.y * props.scale}px`,
  width: `${rect.width * props.scale}px`,
  height: `${rect.height * props.scale}px`,
})
/** 选中框：拖动时画预览位置；其余形状（没选中的）不画 */
const boxRect = computed(() => state.box.value)
const showHandles = computed(() => state.resizable.value && !state.preview.value?.size)

onBeforeUnmount(() => {
  capturedId = -1
})

defineExpose({ focusInput })
</script>

<template>
  <div
    ref="root"
    class="kb-sl-edit"
    data-testid="slide-edit-layer"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @lostpointercapture="onPointerCancel"
  >
    <div v-for="(rect, index) in state.selRects.value" :key="`t${index}`" class="kb-sl-textsel" :style="rectStyle(rect)"></div>

    <SlideOverlay
      :scale="scale"
      :width="width"
      :height="height"
      :box="boxRect"
      :guides="state.guides.value"
      :coarse="coarse"
      :resizable="showHandles"
      @handle-down="onHandleDown"
    />

    <div v-if="caretStyle && !state.preedit.value" :key="caretKey" class="kb-sl-caret" :class="{ 'is-range': hasRange }" :style="caretStyle" data-testid="slide-caret"></div>
    <div v-if="state.preedit.value && preeditStyle" class="kb-sl-preedit" :style="preeditStyle" data-testid="slide-preedit" aria-hidden="true">{{ state.preedit.value }}</div>

    <textarea
      v-if="state.text.value"
      ref="input"
      class="kb-sl-input"
      data-testid="slide-input"
      aria-label="文字输入"
      autocomplete="off"
      autocorrect="off"
      autocapitalize="off"
      spellcheck="false"
      :style="caretStyle ?? undefined"
      @beforeinput="onBeforeInput"
      @keydown="onKeydown"
      @compositionstart="onCompositionStart"
      @compositionupdate="onCompositionUpdate"
      @compositionend="onCompositionEnd"
      @input="onInput"
      @paste="onPaste"
      @copy="onCopy"
      @cut="onCut"
    ></textarea>
  </div>
</template>

<style>
.kb-sl-edit {
  position: absolute;
  inset: 0;
  cursor: default;
  user-select: none;
  -webkit-user-select: none;
}
.kb-sl-textsel {
  position: absolute;
  pointer-events: none;
  background: color-mix(in srgb, var(--accent) 30%, transparent);
}
.kb-sl-caret {
  position: absolute;
  width: 0;
  border-left: 1.5px solid var(--accent);
  pointer-events: none;
  animation: kb-sl-blink 1.1s steps(1) infinite;
}
.kb-sl-caret.is-range {
  animation: none;
  opacity: 0.7;
}
.kb-sl-preedit {
  position: absolute;
  white-space: pre;
  pointer-events: none;
  color: #111;
  background: #fff;
  border-bottom: 1px solid currentColor;
}
/* 看不见但真实存在的输入框:输入法的候选窗口跟着它的位置走 */
.kb-sl-input {
  position: absolute;
  width: 1px;
  min-height: 1px;
  padding: 0;
  border: 0;
  resize: none;
  overflow: hidden;
  opacity: 0;
  background: transparent;
  color: transparent;
  caret-color: transparent;
  pointer-events: none;
}
@keyframes kb-sl-blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .kb-sl-caret {
    animation: none;
  }
}
</style>
