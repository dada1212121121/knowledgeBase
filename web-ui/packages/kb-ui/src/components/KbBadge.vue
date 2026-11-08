<script setup lang="ts">
// 徽标(设计规范):neutral | accent | success | warning | danger。
withDefaults(defineProps<{ tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' }>(), { tone: 'neutral' })
const toneClass = { neutral: '', accent: 'ac', success: 'g', warning: 'y', danger: 'r' } as const
</script>

<template>
  <span class="tag" :class="toneClass[tone]"><slot /></span>
</template>
