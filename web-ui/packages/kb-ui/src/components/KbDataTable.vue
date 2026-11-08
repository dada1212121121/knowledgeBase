<script setup lang="ts">
// 数据表格(设计规范):列定义 + 单元格插槽 + 空态 + 骨架 + 首次入场。
import { computed, ref, watch } from 'vue'
import KbEmpty from './KbEmpty.vue'
import KbSkeleton from './KbSkeleton.vue'
import type { Column } from './types'
import { useScrollFocus } from '../composables/useScrollFocus'

// 表格比容器宽时在 .kb-scroll 里滚动:溢出了就让它能被键盘聚焦(axe scrollable-region-focusable)
const scrollEl = ref<HTMLElement | null>(null)
const scrollable = useScrollFocus(scrollEl)

const props = withDefaults(
  defineProps<{
    columns: Column[]
    rows: unknown[]
    empty?: string
    rowKey?: string
    /** 行可点击 / 键盘选择(↑↓ Enter);配合 selected 高亮当前行 */
    selectable?: boolean
    selected?: string | null
    /** 首次加载中:显示骨架行,不显示空态 */
    loading?: boolean
    /** 表格比容器宽、横向滚动区能被键盘聚焦时读屏念的名字;不传就叫「数据表格」 */
    label?: string
  }>(),
  { empty: '暂无数据', rowKey: 'id', selectable: false, selected: null, loading: false, label: '数据表格' },
)
const emit = defineEmits<{ select: [row: unknown, index: number]; menu: [row: unknown, index: number, event: MouseEvent] }>()

// 行只在「第一次有数据」时依次升起;之后的轮询刷新不再重放(否则每 10 秒闪一次)
const entered = ref(false)
const animateRows = computed(() => !entered.value && props.rows.length > 0)
watch(
  () => props.rows.length,
  (length) => {
    if (length > 0) window.setTimeout(() => (entered.value = true), 900)
  },
  { immediate: true },
)

const keyOf = (row: unknown) => String((row as Record<string, unknown>)[props.rowKey] ?? '')

/** 表格内 ↑↓ 移动选择(行本身 tabindex=0,焦点跟着走)。 */
function onKey(event: KeyboardEvent, index: number) {
  if (!props.selectable) return
  const target = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : null
  if (target === null || target < 0 || target >= props.rows.length) return
  event.preventDefault()
  emit('select', props.rows[target], target)
  const next = (event.currentTarget as HTMLElement).parentElement?.children[target] as HTMLElement | undefined
  next?.focus()
}
</script>

<template>
  <div ref="scrollEl" class="kb-scroll" :tabindex="scrollable ? 0 : undefined" :role="scrollable ? 'region' : undefined" :aria-label="scrollable ? label : undefined">
    <table class="kb-table">
      <thead>
        <tr>
          <th
            v-for="column in columns"
            :key="column.key"
            :class="{ num: column.align === 'right' }"
            :style="column.width ? { width: column.width } : undefined"
          >
            {{ column.label }}
          </th>
        </tr>
      </thead>
      <tbody :class="{ stagger: animateRows }">
        <tr
          v-for="(row, index) in rows"
          :key="keyOf(row) || index"
          :class="{ 'is-clickable': selectable, sel: selectable && selected !== null && keyOf(row) === selected }"
          :tabindex="selectable ? 0 : undefined"
          :aria-selected="selectable ? keyOf(row) === selected : undefined"
          :style="animateRows ? { '--i': Math.min(index, 14) } : undefined"
          @click="selectable && emit('select', row, index)"
          @contextmenu.prevent="emit('menu', row, index, $event)"
          @keydown.enter.prevent="selectable && emit('select', row, index)"
          @keydown="onKey($event, index)"
        >
          <td v-for="column in columns" :key="column.key" :class="[{ num: column.align === 'right', clip: column.clip }, column.cellClass]">
            <slot :name="column.key" :row="row" :index="index" />
          </td>
        </tr>
      </tbody>
    </table>
    <KbSkeleton v-if="loading && !rows.length" :lines="5" height="14px" rows />
    <KbEmpty v-else-if="!rows.length" :title="empty" />
  </div>
</template>
