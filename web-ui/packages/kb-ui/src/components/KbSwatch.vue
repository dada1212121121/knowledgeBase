<script setup lang="ts">
// 色板(设计规范): accent 名或自定义 hex。
defineProps<{ color: string; label?: string; active: boolean; custom?: boolean }>()
const emit = defineEmits<{ select: [] }>()
</script>

<template>
  <span
    v-if="custom"
    class="sw8 swc"
    :class="{ on: active }"
    :title="label ?? '自定义'"
    @click="emit('select')"
  ></span>
  <span
    v-else
    class="sw8"
    :class="{ on: active }"
    :data-accent="color"
    :title="label"
    @click="emit('select')"
  >
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M2.5 6.3l2.3 2.3 4.7-5" />
    </svg>
  </span>
</template>
