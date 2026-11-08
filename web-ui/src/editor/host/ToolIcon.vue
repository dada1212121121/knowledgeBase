<script setup lang="ts">
// 工具栏线性图标：路径来自 toolIcons.ts；颜色跟随按钮的 currentColor，深浅主题、激活态自动一致
import type { ToolIconPaths } from './toolIcons'

withDefaults(defineProps<{ paths: ToolIconPaths; size?: number }>(), { size: 16 })
</script>

<template>
  <svg
    class="kb-tool-icon"
    :width="size"
    :height="size"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path v-for="(d, index) in paths" :key="index" :d="d" />
  </svg>
</template>
