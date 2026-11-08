<script setup lang="ts">
/**
 * 表格大小选择面板（像 Word 那样）：一块 8 × 8 的小方格，鼠标划过的区域高亮，下面写「3 × 4 表格」，点一下就插入。
 *
 * 取代了原来「点表格按钮直接插入固定 3 × 3」：想要别的大小得先插入再一行行加。
 * 触屏没有「划过」：点哪一格就是哪个大小，面板底部的文字随手指落点更新；方向键 + 回车也能选（键盘用户）。
 * 面板不抢编辑器焦点（mousedown 不默认处理）。
 */
import { computed, ref } from 'vue'

const ROWS = 8
const COLS = 8
const emit = defineEmits<{ (e: 'pick', rows: number, cols: number): void }>()
/** 当前划到的格子（行、列都从 1 开始）；还没划到时先给 3 × 3 的默认提示，直接按回车也能插入常用大小 */
const hover = ref<{ row: number; col: number }>({ row: 3, col: 3 })
const label = computed(() => `${hover.value.row} × ${hover.value.col} 表格`)

function move(dRow: number, dCol: number) {
  hover.value = {
    row: Math.min(ROWS, Math.max(1, hover.value.row + dRow)),
    col: Math.min(COLS, Math.max(1, hover.value.col + dCol)),
  }
}
function onKeydown(event: KeyboardEvent) {
  const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
  const step = arrows[event.key]
  if (step) {
    event.preventDefault()
    move(step[0], step[1])
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    emit('pick', hover.value.row, hover.value.col)
  }
}
</script>

<template>
  <div class="kb-table-picker" role="group" aria-label="插入表格" data-testid="table-grid" @mousedown.prevent>
    <div class="kb-table-grid" tabindex="0" role="grid" :aria-label="`选择表格大小，当前 ${label}`" @mouseleave="hover = { row: 3, col: 3 }" @keydown="onKeydown">
      <template v-for="row in ROWS" :key="row">
        <button
          v-for="col in COLS"
          :key="`${row}-${col}`"
          type="button"
          tabindex="-1"
          class="kb-table-cell"
          :class="{ 'is-on': row <= hover.row && col <= hover.col }"
          :aria-label="`${row} 行 ${col} 列`"
          :data-testid="`table-cell-${row}-${col}`"
          @mouseenter="hover = { row, col }"
          @click="emit('pick', row, col)"
        ></button>
      </template>
    </div>
    <div class="kb-table-caption" data-testid="table-grid-label">{{ label }}</div>
  </div>
</template>

<style>
.kb-table-picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
}
.kb-table-grid {
  display: grid;
  grid-template-columns: repeat(8, 20px);
  gap: 3px;
  outline: none;
}
.kb-table-cell {
  width: 20px;
  height: 20px;
  padding: 0;
  background: transparent;
  border: var(--hl) solid var(--border-default);
  border-radius: 3px;
  cursor: pointer;
  transition: background-color var(--dur-instant) var(--ease-out), border-color var(--dur-instant) var(--ease-out);
}
/* 划过的区域整块高亮：左上角到当前格的矩形 */
.kb-table-cell.is-on {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  border-color: var(--accent);
}
.kb-table-grid:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
.kb-table-caption {
  color: var(--text-secondary);
  font-size: calc(13px * var(--fs));
  text-align: center;
  font-variant-numeric: tabular-nums;
}
@media (pointer: coarse) {
  .kb-table-grid {
    grid-template-columns: repeat(8, 30px);
    gap: 5px;
  }
  .kb-table-cell {
    width: 30px;
    height: 30px;
  }
}
</style>
