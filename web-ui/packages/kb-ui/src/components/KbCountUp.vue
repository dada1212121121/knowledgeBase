<script setup lang="ts">
// 数字滚动(uilab「操作卡片」:总数滚过去而不是跳):值变化时从当前显示值缓出到新值。
// 首次出现从 0 滚起(进入视口后);不允许动画时直接显示。
// 值在已经显示之后又变了(刷新拿到新数据):除了滚动,数字还会闪一下强调色并上浮一点(.is-bump),让人注意到「这个数变了」。
// `data-value` 始终是目标值(滚动中途读文字读不准,测试和读屏之外的脚本读它)。
import { onBeforeUnmount, ref, watch } from 'vue'
import { easeOutCubic, motionAllowed, tokenMs, useReveal } from '../motion/useMotion'

const props = withDefaults(
  defineProps<{ value: number; decimals?: number; duration?: number; locale?: boolean }>(),
  { decimals: 0, duration: 0, locale: true },
)

const { target, shown } = useReveal(0.2)
// 允许动画时从 0 起步(进入视口后滚到目标值);否则直接显示目标值——避免「先闪最终值再跳回 0」
const display = ref(motionAllowed() ? 0 : props.value)
let frame = 0
let startedFrom = 0
/** 是否已经滚到过一次目标值:之后再变化才算「更新」,要闪 */
let settledOnce = false
const bump = ref(false)
let bumpTimer: ReturnType<typeof setTimeout> | undefined

function format(n: number): string {
  const fixed = n.toFixed(props.decimals)
  if (!props.locale) return fixed
  return Number(fixed).toLocaleString('en-US', { minimumFractionDigits: props.decimals, maximumFractionDigits: props.decimals })
}

function flash() {
  if (bumpTimer) clearTimeout(bumpTimer)
  bump.value = false
  // 下一帧再加类,同一个元素连续变化时动画才会重播
  requestAnimationFrame(() => {
    bump.value = true
    bumpTimer = setTimeout(() => (bump.value = false), tokenMs('--dur-slow', 320) * 2)
  })
}

function run(to: number) {
  cancelAnimationFrame(frame)
  if (!motionAllowed()) {
    display.value = to
    return
  }
  const from = display.value
  startedFrom = from
  if (from === to) {
    settledOnce = true
    return
  }
  if (settledOnce) flash()
  settledOnce = true
  const duration = props.duration || tokenMs('--dur-page', 420) * 1.6
  const began = performance.now()
  const step = (now: number) => {
    // rAF 的时间戳可能比调用时的 performance.now 早一点,进度会是负数——必须夹紧到 [0,1]
    const t = Math.min(1, Math.max(0, (now - began) / duration))
    display.value = startedFrom + (to - startedFrom) * easeOutCubic(t)
    if (t < 1) frame = requestAnimationFrame(step)
  }
  frame = requestAnimationFrame(step)
}

watch(
  [shown, () => props.value],
  ([visible, value]) => {
    if (visible) run(value)
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  if (bumpTimer) clearTimeout(bumpTimer)
})
</script>

<template>
  <span ref="target" class="kb-countup" :class="{ 'is-bump': bump }" :data-value="value">{{ format(display) }}</span>
</template>
