<script setup lang="ts">
// 行内分段控件(设计规范,设置页的 .segx)。
defineProps<{
  modelValue: string
  options: { value: string; label: string; radiusIcon?: string }[]
  axis?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <span class="segx" :data-axis="axis">
    <i
      v-for="option in options"
      :key="option.value"
      :data-v="option.value"
      :class="{ on: option.value === modelValue }"
      @click="emit('update:modelValue', option.value)"
    >
      <span v-if="option.radiusIcon != null" class="rdi" :style="{ 'border-radius': option.radiusIcon }"></span>
      {{ option.label }}
    </i>
  </span>
</template>
