<script setup lang="ts">
/**
 * 自定义颜色选择器（字色 / 底色共用）
 *
 * 交互对齐 WPS / Word 的「其他颜色」：上面是常用扩展色，下面一条色相条 + 一块饱和度/亮度面板，
 * 可以按住拖动连续取色；也可以直接输 6 位 hex。选中的颜色只通过 pick 事件交给父组件，
 * 父组件再发 `mark.color` 命令——这里不碰编辑器状态和存储格式。
 *
 * 为什么不用 <input type="color">：系统取色器在桌面各平台长得不一样，手机上还会跳出原生对话框，
 * 打断「点开色板马上选」的节奏；内联面板也能保证和工具栏同一套主题、焦点与键盘操作。
 */
import { computed, ref, watch } from 'vue'
import { isHexColor, normalizeColorHex } from '@/utils/colorPalette'

type Hsv = { h: number; s: number; v: number }
type ColorProp = 'color' | 'background-color'

const props = defineProps<{
  /** 正在编辑的 prop；字色和底色用同一套面板，只是初始色 / 常用色不同 */
  prop: ColorProp
  /** 当前颜色（6 位 hex；父组件已把调色板 key 解析成色值） */
  value: string
}>()
const emit = defineEmits<{
  (e: 'pick', key: string): void
  (e: 'close'): void
}>()

/** 扩展常用色：桌面 8 列 × 4 行；触屏仍是一屏能滚完的 8 列。 */
const PRESETS: Record<ColorProp, string[]> = {
  color: [
    '#000000', '#374151', '#6b7280', '#9ca3af', '#d1d5db', '#f9fafb', '#7f1d1d', '#b91c1c',
    '#dc2626', '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#166534', '#16a34a',
    '#10b981', '#14b8a6', '#0891b2', '#0284c7', '#2563eb', '#4f46e5', '#6d28d9', '#7c3aed',
    '#a855f7', '#d946ef', '#db2777', '#e11d48', '#78350f', '#92400e', '#57534e', '#0f766e',
  ],
  'background-color': [
    '#ffffff', '#f9fafb', '#f3f4f6', '#e5e7eb', '#fff1f2', '#ffe4e6', '#fecdd3', '#fee2e2',
    '#ffedd5', '#fed7aa', '#fef3c7', '#fef9c3', '#ecfccb', '#dcfce7', '#d1fae5', '#ccfbf1',
    '#cffafe', '#e0f2fe', '#dbeafe', '#e0e7ff', '#ede9fe', '#f3e8ff', '#fae8ff', '#fce7f3',
    '#f5d0fe', '#fbcfe8', '#fda4af', '#fca5a5', '#fdba74', '#fde68a', '#bef264', '#a7f3d0',
  ],
}
const FALLBACK: Record<ColorProp, string> = { color: '#333333', 'background-color': '#fff3a3' }

const presets = computed(() => PRESETS[props.prop])
const initial = () => normalizeColorHex(props.value) ?? FALLBACK[props.prop]
const hex = ref(initial())
const hsv = ref<Hsv>(hexToHsv(hex.value))
const hexDraft = ref(hex.value)
const svArea = ref<HTMLElement | null>(null)
const dragging = ref<'sv' | 'hue' | null>(null)

const validHex = computed(() => normalizeColorHex(hexDraft.value) !== null)
const hueColor = computed(() => `hsl(${Math.round(hsv.value.h)} 100% 50%)`)
const svThumbStyle = computed(() => ({ left: `${hsv.value.s}%`, top: `${100 - hsv.value.v}%`, background: hex.value }))
const hueThumbStyle = computed(() => ({ left: `${(hsv.value.h / 360) * 100}%`, background: hex.value }))

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value))

function hexToRgb(value: string): { r: number; g: number; b: number } | null {
  const normalized = normalizeColorHex(value)
  if (!normalized) return null
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  }
}

function hexToHsv(value: string): Hsv {
  const rgb = hexToRgb(value)
  if (!rgb) return { h: 0, s: 0, v: 0 }
  const r = rgb.r / 255
  const g = rgb.g / 255
  const b = rgb.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  let h = 0
  if (delta) {
    if (max === r) h = ((g - b) / delta) % 6
    else if (max === g) h = (b - r) / delta + 2
    else h = (r - g) / delta + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h: h >= 360 ? 0 : h, s: max ? (delta / max) * 100 : 0, v: max * 100 }
}

function hsvToHex(value: Hsv): string {
  const s = clamp(value.s) / 100
  const v = clamp(value.v) / 100
  const h = ((value.h % 360) + 360) % 360
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  const channel = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0')
  return `#${channel(r!)}${channel(g!)}${channel(b!)}`
}

/** 把 HSV 同步到预览色和输入框；拖动过程中输入框跟着走，所见即所得 */
function syncFromHsv() {
  const next = hsvToHex(hsv.value)
  hex.value = next
  hexDraft.value = next
}

/** 从 hex 反向设置（输入框 / 外部值）；成功返回 true */
function setHex(value: string, syncDraft = true): boolean {
  const normalized = normalizeColorHex(value)
  if (!normalized) return false
  hex.value = normalized
  hsv.value = hexToHsv(normalized)
  if (syncDraft) hexDraft.value = normalized
  return true
}

watch(
  () => props.value,
  (value) => {
    const normalized = normalizeColorHex(value)
    if (normalized && normalized !== hex.value) setHex(normalized)
  },
)

function pointIn(event: PointerEvent, el: HTMLElement | null): { x: number; y: number } | null {
  if (!el) return null
  const rect = el.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  return { x: clamp(((event.clientX - rect.left) / rect.width) * 100), y: clamp(((event.clientY - rect.top) / rect.height) * 100) }
}

function dragSv(event: PointerEvent) {
  const point = pointIn(event, svArea.value)
  if (!point) return
  hsv.value = { ...hsv.value, s: point.x, v: 100 - point.y }
  syncFromHsv()
}

function startSv(event: PointerEvent) {
  if (event.button !== 0) return
  event.preventDefault()
  dragging.value = 'sv'
  svArea.value?.setPointerCapture(event.pointerId)
  dragSv(event)
}

const hueBar = ref<HTMLElement | null>(null)

function dragHue(event: PointerEvent) {
  const point = pointIn(event, hueBar.value)
  if (!point) return
  hsv.value = { ...hsv.value, h: (point.x / 100) * 360 }
  syncFromHsv()
}

function startHue(event: PointerEvent) {
  if (event.button !== 0) return
  event.preventDefault()
  dragging.value = 'hue'
  hueBar.value?.setPointerCapture(event.pointerId)
  dragHue(event)
}

function moveDrag(event: PointerEvent) {
  if (dragging.value === 'sv') dragSv(event)
  else if (dragging.value === 'hue') dragHue(event)
}

function endDrag(event: PointerEvent) {
  if (dragging.value === 'sv') svArea.value?.releasePointerCapture?.(event.pointerId)
  if (dragging.value === 'hue') hueBar.value?.releasePointerCapture?.(event.pointerId)
  dragging.value = null
}

function onSvKey(event: KeyboardEvent) {
  const step = event.shiftKey ? 10 : 2
  const next = { ...hsv.value }
  if (event.key === 'ArrowLeft') next.s = clamp(next.s - step)
  else if (event.key === 'ArrowRight') next.s = clamp(next.s + step)
  else if (event.key === 'ArrowUp') next.v = clamp(next.v + step)
  else if (event.key === 'ArrowDown') next.v = clamp(next.v - step)
  else return
  event.preventDefault()
  hsv.value = next
  syncFromHsv()
}

function onHueKey(event: KeyboardEvent) {
  const step = event.shiftKey ? 15 : 5
  const next = { ...hsv.value }
  if (event.key === 'ArrowLeft') next.h = (next.h - step + 360) % 360
  else if (event.key === 'ArrowRight') next.h = (next.h + step) % 360
  else if (event.key === 'Home') next.h = 0
  else if (event.key === 'End') next.h = 359
  else return
  event.preventDefault()
  hsv.value = next
  syncFromHsv()
}

function onHexInput(event: Event) {
  const value = (event.target as HTMLInputElement).value
  hexDraft.value = value
  // 只有完整的 6 位色才同步；输入到一半（#e5）不把面板闪成黑色
  if (isHexColor(value)) {
    const normalized = normalizeColorHex(value)!
    hex.value = normalized
    hsv.value = hexToHsv(normalized)
  }
}

function onHexBlur() {
  if (!setHex(hexDraft.value)) hexDraft.value = hex.value
}

function apply() {
  const normalized = normalizeColorHex(hexDraft.value)
  if (normalized) emit('pick', normalized)
}
</script>

<template>
  <div class="kb-color-picker" role="group" aria-label="自定义颜色" data-testid="editor-color-picker" @keydown.esc="emit('close')">
    <div class="kb-color-presets" role="group" aria-label="更多常用颜色">
      <button
        v-for="(preset, index) in presets"
        :key="preset"
        type="button"
        class="kb-color-preset"
        :class="{ 'is-current': hex === preset }"
        :style="{ background: preset }"
        :title="preset"
        :aria-label="`使用颜色 ${preset}`"
        :data-testid="`editor-color-preset-${index}`"
        @click="emit('pick', preset)"
      />
    </div>
    <div
      ref="svArea"
      class="kb-color-sv"
      :style="{ '--kb-hue': hueColor }"
      role="slider"
      tabindex="0"
      aria-label="饱和度和亮度：左右调饱和度，上下调亮度"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="Math.round(hsv.s)"
      :aria-valuetext="`饱和度 ${Math.round(hsv.s)}%，亮度 ${Math.round(hsv.v)}%`"
      data-testid="editor-color-sv"
      @pointerdown="startSv"
      @pointermove="moveDrag"
      @pointerup="endDrag"
      @pointercancel="endDrag"
      @keydown="onSvKey"
    >
      <span class="kb-color-sv-thumb" :style="svThumbStyle" aria-hidden="true" />
    </div>
    <div
      ref="hueBar"
      class="kb-color-hue"
      role="slider"
      tabindex="0"
      aria-label="色相"
      aria-valuemin="0"
      aria-valuemax="360"
      :aria-valuenow="Math.round(hsv.h)"
      data-testid="editor-color-hue"
      @pointerdown="startHue"
      @pointermove="moveDrag"
      @pointerup="endDrag"
      @pointercancel="endDrag"
      @keydown="onHueKey"
    >
      <span class="kb-color-hue-thumb" :style="hueThumbStyle" aria-hidden="true" />
    </div>
    <div class="kb-color-hex-row">
      <span class="kb-color-preview" :style="{ background: hex }" aria-hidden="true" />
      <input
        class="kb-color-hex"
        :value="hexDraft"
        type="text"
        inputmode="text"
        autocomplete="off"
        spellcheck="false"
        maxlength="7"
        aria-label="颜色十六进制值"
        :aria-invalid="!validHex"
        data-testid="editor-color-hex"
        @mousedown.stop
        @input="onHexInput"
        @blur="onHexBlur"
        @keydown.enter="apply"
      />
      <button type="button" class="kb-color-apply" :disabled="!validHex" data-testid="editor-color-apply" @click="apply">应用</button>
    </div>
  </div>
</template>

<style>
.kb-color-picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
  /* 和上面 8 列预设色块同宽（8×26 + 7×4），展开时面板不会突然变宽 */
  width: 236px;
  margin-top: 4px;
  padding-top: 10px;
  border-top: var(--hl) solid var(--border-subtle);
  box-sizing: border-box;
}
.kb-color-presets {
  display: grid;
  grid-template-columns: repeat(8, 26px);
  gap: 4px;
}
.kb-color-preset {
  width: 26px;
  height: 26px;
  padding: 0;
  border: var(--hl) solid var(--border-subtle);
  border-radius: var(--r1);
  cursor: pointer;
  transition: transform var(--dur-instant) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.kb-color-preset:hover {
  transform: scale(1.08);
  border-color: var(--border-strong);
}
.kb-color-preset.is-current {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.kb-color-sv {
  position: relative;
  height: 132px;
  border: var(--hl) solid var(--border-subtle);
  border-radius: var(--r2);
  cursor: crosshair;
  touch-action: none;
  background:
    linear-gradient(to top, black, transparent),
    linear-gradient(to right, white, var(--kb-hue, red));
}
.kb-color-sv:focus-visible,
.kb-color-hue:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.kb-color-sv-thumb {
  position: absolute;
  width: 14px;
  height: 14px;
  border: 2px solid white;
  border-radius: var(--r-pill);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.55), 0 1px 3px rgba(0, 0, 0, 0.4);
  transform: translate(-50%, -50%);
  pointer-events: none;
}
.kb-color-hue {
  position: relative;
  height: 12px;
  border-radius: var(--r-pill);
  cursor: pointer;
  touch-action: none;
  background: linear-gradient(
    to right,
    hsl(0 100% 50%),
    hsl(60 100% 50%),
    hsl(120 100% 50%),
    hsl(180 100% 50%),
    hsl(240 100% 50%),
    hsl(300 100% 50%),
    hsl(360 100% 50%)
  );
}
.kb-color-hue-thumb {
  position: absolute;
  top: 50%;
  width: 16px;
  height: 16px;
  border: 2px solid white;
  border-radius: var(--r-pill);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.55), 0 1px 3px rgba(0, 0, 0, 0.4);
  transform: translate(-50%, -50%);
  pointer-events: none;
}
.kb-color-hex-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.kb-color-preview {
  flex: 0 0 26px;
  width: 26px;
  height: 26px;
  border: var(--hl) solid var(--border-subtle);
  border-radius: var(--r1);
}
.kb-color-hex {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 8px;
  border: var(--hl) solid var(--border-default);
  border-radius: var(--r1);
  background: var(--surface-1);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: calc(12px * var(--fs));
}
.kb-color-hex[aria-invalid='true'] {
  border-color: var(--err, #b91c1c);
}
.kb-color-apply {
  flex: none;
  height: 30px;
  padding: 0 11px;
  border: 0;
  border-radius: var(--r1);
  background: var(--accent);
  color: var(--on-accent);
  font-size: calc(12px * var(--fs));
  cursor: pointer;
}
.kb-color-apply:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
@media (pointer: coarse) {
  /* 触屏按 8 列铺满：常见 390 宽正好 34px；320 这类窄屏随面板一起缩，避免横向溢出 */
  .kb-color-picker {
    width: min(314px, calc(100vw - 36px));
  }
  .kb-color-presets {
    grid-template-columns: repeat(8, minmax(0, 1fr));
    gap: 6px;
  }
  .kb-color-preset {
    width: 100%;
    height: auto;
    aspect-ratio: 1;
  }
  .kb-color-sv {
    height: 150px;
  }
  .kb-color-hue {
    height: 18px;
  }
  .kb-color-hex,
  .kb-color-apply {
    height: 40px;
  }
  .kb-color-preview {
    flex-basis: 34px;
    width: 34px;
    height: 34px;
  }
}
</style>
