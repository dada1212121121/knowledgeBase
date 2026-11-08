<script setup lang="ts">
// 表单行(设计规范):label + 控件 + 说明。页面只放控件,不写视觉。
defineProps<{ label: string; hint?: string }>()
</script>

<template>
  <div class="kb-form-wide kb-stack" style="gap: var(--gap-xs)">
    <div class="kb-row">
      <label class="kb-hint">{{ label }}</label>
      <span v-if="$slots.extra" class="kb-spacer"><slot name="extra" /></span>
    </div>
    <slot />
    <div v-if="hint" class="kb-hint">{{ hint }}</div>
  </div>
</template>
