<script setup lang="ts">
// 阶段时间线(设计规范,用于单文件下钻 / 版本历史)。
import type { Step } from './types'
defineProps<{ steps: Step[] }>()
</script>

<template>
  <div class="kb-timeline">
    <div
      v-for="(step, index) in steps"
      :key="index"
      class="kb-step"
      :class="{ 'is-done': step.state === 'done', 'is-current': step.state === 'current', 'is-failed': step.state === 'failed' }"
    >
      <div style="font-weight: 500">{{ step.title }}</div>
      <div v-if="step.detail" class="kb-hint">{{ step.detail }}</div>
    </div>
  </div>
</template>
