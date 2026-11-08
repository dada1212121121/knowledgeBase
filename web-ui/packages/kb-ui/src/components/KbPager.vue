<script setup lang="ts">
// 分页条(03 浏览器列表底部):「38 条中第 1–12 条  ‹ 1 2 3 4 ›  12 / 页 ⌄」。
import { computed } from 'vue'
import KbSelect from './KbSelect.vue'

const props = defineProps<{
  total: number
  page: number
  pageSize: number
  sizes?: number[]
}>()
const emit = defineEmits<{ 'update:page': [value: number]; 'update:pageSize': [value: number] }>()

const pages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)))
const from = computed(() => (props.total === 0 ? 0 : (props.page - 1) * props.pageSize + 1))
const to = computed(() => Math.min(props.total, props.page * props.pageSize))

/** 最多显示 5 个页码,当前页尽量居中;多出来的用省略号。 */
const numbers = computed<(number | '…')[]>(() => {
  const last = pages.value
  const current = props.page
  if (last <= 5) return Array.from({ length: last }, (_, index) => index + 1)
  const start = Math.min(Math.max(1, current - 1), last - 3)
  const list: (number | '…')[] = []
  for (let value = start; value < start + 3; value++) list.push(value)
  list.push('…', last)
  return start > 1 ? [1, ...(start > 2 ? (['…'] as const) : []), ...list] : list
})

const go = (value: number) => emit('update:page', Math.min(Math.max(1, value), pages.value))
const sizeOptions = computed(() => (props.sizes ?? [12, 24, 50, 100]).map((size) => ({ value: size, label: `${size} / 页` })))
</script>

<template>
  <div class="row m kb-pager">
    <span>{{ total }} 条中第 {{ from }}–{{ to }} 条</span>
    <span class="row kb-pager-ctrl">
      <button type="button" class="btn sm" :disabled="page <= 1" aria-label="上一页" @click="go(page - 1)">‹</button>
      <template v-for="(item, index) in numbers" :key="`${item}-${index}`">
        <span v-if="item === '…'" class="m">…</span>
        <button v-else type="button" class="btn sm" :class="{ 'is-current': item === page }" @click="go(item)">{{ item }}</button>
      </template>
      <button type="button" class="btn sm" :disabled="page >= pages" aria-label="下一页" @click="go(page + 1)">›</button>
      <KbSelect
        :model-value="pageSize"
        :options="sizeOptions"
        :display="`${pageSize} / 页`"
        size="sm"
        plain
        up
        align="end"
        @update:model-value="(value) => emit('update:pageSize', Number(value))"
      />
    </span>
  </div>
</template>
