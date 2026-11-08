<script setup lang="ts">
// 提交按钮(参考 uilab「按钮文字滚动切换」「保存按钮变进度环」):
//   空闲 → 忙(文字淡出、转圈) → 完成(文字向上滚走,「✓ 已保存」从下面滚进来) → 约 1.6 秒后滚回。
// 用法:<KbSubmitButton :busy="saving" :done-at="savedAt" label="保存 ⌘S" done-label="已保存" @click="save" />
// 父组件保存成功后给 done-at 赋 Date.now 即可触发完成态。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import KbIcon from './KbIcon.vue'

const props = withDefaults(
  defineProps<{ label: string; doneLabel?: string; busy?: boolean; doneAt?: number; disabled?: boolean; size?: 'md' | 'sm'; variant?: 'primary' | 'default' }>(),
  { doneLabel: '已完成', busy: false, doneAt: 0, disabled: false, size: 'sm', variant: 'primary' },
)
defineEmits<{ click: [event: MouseEvent] }>()

const showDone = ref(false)
// 按钮宽度跟随「当前这行文字」,切换时平滑撑开 / 收回(而不是被看不见的那行撑宽)
const textA = ref<HTMLElement | null>(null)
const textB = ref<HTMLElement | null>(null)
const widthA = ref(0)
const widthB = ref(0)
let observer: ResizeObserver | null = null
function measure() {
  widthA.value = textA.value?.offsetWidth ?? 0
  widthB.value = textB.value?.offsetWidth ?? 0
}
const rollWidth = computed(() => {
  const w = showDone.value && !props.busy ? widthB.value : widthA.value
  return w ? { width: `${w}px` } : undefined
})
onMounted(async () => {
  await nextTick()
  measure()
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(measure)
    if (textA.value) observer.observe(textA.value)
    if (textB.value) observer.observe(textB.value)
  }
})
watch(() => [props.label, props.doneLabel], () => nextTick(measure))
let timer = 0
watch(
  () => props.doneAt,
  (value) => {
    if (!value) return
    showDone.value = true
    window.clearTimeout(timer)
    timer = window.setTimeout(() => (showDone.value = false), 1600)
  },
)
onBeforeUnmount(() => {
  window.clearTimeout(timer)
  observer?.disconnect()
})
</script>

<template>
  <button
    type="button"
    class="btn kb-submit"
    :class="{ sm: size === 'sm', pri: variant === 'primary', 'is-busy': busy, 'is-done': showDone && !busy, 'is-idle': disabled }"
    :disabled="busy || disabled"
    :aria-busy="busy"
    @click="$emit('click', $event)"
  >
    <span class="kb-roll" :style="rollWidth" style-allow="宽度跟随当前文字">
      <span class="kb-roll-line kb-roll-a"><span ref="textA" class="kb-roll-text">{{ label }}</span></span>
      <span class="kb-roll-line kb-roll-b"><span ref="textB" class="kb-roll-text"><KbIcon name="check" :size="14" />{{ doneLabel }}</span></span>
    </span>
    <span class="kb-spinner kb-submit-spin" aria-hidden="true"></span>
  </button>
</template>
