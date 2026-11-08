<script setup lang="ts">
// 任务状态图标(05 任务 / 02 仪表盘任务队列共用):运行中=半填充圆,排队=虚线圆,失败=叉,完成=勾。
withDefaults(defineProps<{ tone: 'accent' | 'idle' | 'danger' | 'success'; size?: number }>(), { size: 14 })
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="kb-job-svg" aria-hidden="true">
    <template v-if="tone === 'accent'"><circle cx="8" cy="8" r="5.5" /><path d="M8 2.5a5.5 5.5 0 010 11z" fill="currentColor" /></template>
    <circle v-else-if="tone === 'idle'" cx="8" cy="8" r="5.5" stroke-dasharray="2.2 2.2" />
    <template v-else-if="tone === 'danger'"><circle cx="8" cy="8" r="5.5" fill="currentColor" fill-opacity=".16" /><path d="M6 6l4 4M10 6l-4 4" /></template>
    <template v-else><circle cx="8" cy="8" r="5.5" fill="currentColor" fill-opacity=".16" /><path d="M5.5 8.2l1.7 1.7 3.3-3.6" /></template>
  </svg>
</template>
