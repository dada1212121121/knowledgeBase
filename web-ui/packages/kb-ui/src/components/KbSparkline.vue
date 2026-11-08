<script setup lang="ts">
// 迷你折线(设计规范):1px 线 + 渐变面积 + 末端点。数据不足时退化为水平线。
import { computed } from 'vue'
import { useReveal } from '../motion/useMotion'

const props = withDefaults(
  defineProps<{ values: number[]; width?: number; height?: number; gradientId: string; raw?: boolean }>(),
  { width: 110, height: 32, raw: false },
)

const { target, shown } = useReveal(0.2)

const points = computed(() => {
  const values = props.values.length ? props.values : [0, 0]
  const step = props.width / Math.max(values.length - 1, 1)
  if (props.raw) {
    return values.map((val, idx) => `${Math.round(idx * step)},${val}`)
  }
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const span = Math.max(max - min, 1)
  return values.map((value, index) => {
    const x = Math.round(index * step)
    const y = props.height - 6 - ((value - min) / span) * (props.height - 12)
    return `${x},${y.toFixed(1)}`
  })
})
const line = computed(() => points.value.join(' '))
const area = computed(() => `0,${props.height} ${line.value} ${props.width},${props.height}`)
const last = computed(() => {
  const parts = points.value[points.value.length - 1].split(',').map(Number)
  return { x: parts[0], y: parts[1] }
})
</script>

<template>
  <svg ref="target" class="spk" :class="{ 'is-in': shown }" :viewBox="`0 0 ${props.width} ${props.height}`" preserveAspectRatio="none">
    <defs>
      <linearGradient :id="props.gradientId" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style="stop-color: var(--accent-hover)" stop-opacity=".35" />
        <stop offset="1" style="stop-color: var(--accent-hover)" stop-opacity="0" />
      </linearGradient>
    </defs>
    <polygon :points="area" :fill="`url(#${props.gradientId})`" />
    <polyline :points="line" fill="none" style="stroke: var(--accent-hover)" stroke-width="1" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
    <circle :cx="last.x" :cy="last.y" r="2" style="fill: #fff; stroke: var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke" />
  </svg>
</template>
