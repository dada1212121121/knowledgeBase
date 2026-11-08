<script setup lang="ts">
import { isComposing } from '../composables/ime'
// 过滤输入框(03 浏览器列表顶部):搜索图标 + 文本 + 已生效的过滤条件(kind:x / dir:x / tag:x)。
// 在输入框里敲 `kind:insight tag:uds dir:src/ 关键词` 回车,页面解析成条件;条件点 × 删除。
import KbIcon from './KbIcon.vue'

export interface FilterChip {
  key: string
  label: string
}

defineProps<{ modelValue: string; chips: FilterChip[]; placeholder?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string]; submit: []; remove: [key: string] }>()
</script>

<template>
  <label class="inp kb-filter">
    <span class="m"><KbIcon name="search" :size="14" /></span>
    <input
      class="kb-filter-input"
      type="text"
      enterkeyhint="search"
      :value="modelValue"
      :placeholder="placeholder ?? '筛选…'"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.enter.prevent="!isComposing($event) && emit('submit')"
      @keydown.backspace="!modelValue && chips.length && emit('remove', chips[chips.length - 1]!.key)"
    />
    <button
      v-for="chip in chips"
      :key="chip.key"
      type="button"
      class="tag ac kb-chip"
      :title="`移除 ${chip.label}`"
      @click.prevent="emit('remove', chip.key)"
    >
      {{ chip.label }}<span class="kb-chip-x">×</span>
    </button>
  </label>
</template>
