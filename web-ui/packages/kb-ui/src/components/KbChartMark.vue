<script setup lang="ts">
// 图例 / 提示气泡里的小标记:和折线上的点是同一个形状同一个颜色。
// 只靠颜色区分几条线,色觉不同的人和黑白打印都分不开,所以每条线另有自己的形状(见 chartMath.markerShape)。
import { computed } from 'vue'
import { markerPath, type MarkerShape } from './chartMath'

const props = withDefaults(defineProps<{ shape: MarkerShape; color: string; size?: number }>(), { size: 12 })
const d = computed(() => markerPath(props.shape, props.size / 2, props.size / 2, props.size / 2 - 2))
</script>

<template>
  <svg class="kb-mark" :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`" aria-hidden="true" focusable="false">
    <path :d="d" :style="{ fill: color }" />
  </svg>
</template>
