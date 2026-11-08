<script setup lang="ts">
// 16×16 线性图标(路径表见 icons.ts)。
import { iconPaths, type IconName } from './icons'

const props = withDefaults(defineProps<{ name: IconName; size?: number }>(), { size: 16 })
</script>

<template>
  <svg
    :width="props.size"
    :height="props.size"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path v-for="(d, index) in iconPaths[props.name]" :key="index" :d="d" />
  </svg>
</template>
