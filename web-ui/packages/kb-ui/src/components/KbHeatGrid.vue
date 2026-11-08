<script setup lang="ts">
// 行 × 列的热力矩阵(例如「周几 × 几点」的调用次数)。和 KbHeatmap(日历式,一列一周)是两种东西:
// 这里行和列都有名字,颜色按这张表里的最大值分五档(0 一档单独留空)。
// - 格子按列错开弹出(kb-cell-in,进入视口才开始;减弱动效时直接出现);
// - 悬停 / 触屏长按看「周二 14 点:128 次」(title);
// - 图是装饰(aria-hidden),读屏用的是最忙的几个格子加总数的一段文字。
import { computed } from 'vue'
import { useReveal } from '../motion/useMotion'
import { compactNumber } from './chartMath'

const props = withDefaults(
  defineProps<{
    rows: string[]
    cols: string[]
    /** values[行][列];缺的按 0 */
    values: (number | null | undefined)[][]
    /** 这张图是什么(读屏) */
    label: string
    /** 数字的写法 */
    format?: (value: number) => string
    /** 单位,写在悬停提示里(次 / 个) */
    unit?: string
    /** 列标签每隔几列写一个;不给就按列数自动(超过 12 列时隔 3 列) */
    colEvery?: number
    emptyText?: string
  }>(),
  { format: compactNumber, unit: '次', colEvery: 0, emptyText: '还没有数据' },
)

const { target, shown } = useReveal(0.2)

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
const matrix = computed(() => props.rows.map((_, row) => props.cols.map((__, col) => num(props.values[row]?.[col]))))
const max = computed(() => Math.max(0, ...matrix.value.flat()))
const total = computed(() => matrix.value.flat().reduce((sum, value) => sum + value, 0))
const level = (value: number) => {
  if (!value || !max.value) return 0
  const ratio = value / max.value
  return ratio > 0.75 ? 4 : ratio > 0.5 ? 3 : ratio > 0.25 ? 2 : 1
}
const every = computed(() => props.colEvery || (props.cols.length > 12 ? 3 : 1))

/** 最忙的 3 个格子(读屏摘要用);并列时靠前的在前 */
const busiest = computed(() =>
  matrix.value
    .flatMap((line, row) => line.map((value, col) => ({ row, col, value })))
    .filter((cell) => cell.value > 0)
    .sort((left, right) => right.value - left.value || left.row - right.row || left.col - right.col)
    .slice(0, 3),
)
const summary = computed(() => {
  if (!total.value) return `${props.label}:${props.emptyText}`
  const top = busiest.value.map((cell) => `${props.rows[cell.row]} ${props.cols[cell.col]}(${props.format(cell.value)}${props.unit})`).join('、')
  return `${props.label}:共 ${props.format(total.value)}${props.unit},最多的是 ${top}`
})
</script>

<template>
  <figure ref="target" class="kb-heatgrid" :class="{ 'is-in': shown }" role="group" :aria-label="summary" :style="{ '--hg-cols': cols.length }">
    <div v-if="total" class="kb-heatgrid-plot" aria-hidden="true">
      <template v-for="(name, row) in rows" :key="name">
        <span class="kb-heatgrid-row m">{{ name }}</span>
        <i
          v-for="(col, at) in cols"
          :key="`${name}-${col}`"
          :data-level="level(matrix[row]![at]!)"
          :style="{ '--i': at }"
          :title="matrix[row]![at] ? `${name} ${col}:${format(matrix[row]![at]!)}${unit}` : undefined"
        ></i>
      </template>
      <span></span>
      <span v-for="(col, at) in cols" :key="`h-${col}`" class="kb-heatgrid-col m">{{ at % every === 0 ? col : '' }}</span>
    </div>
    <div v-else class="kb-heatgrid-empty">{{ emptyText }}</div>
    <div v-if="total" class="kb-heatgrid-legend m" aria-hidden="true">
      少
      <i data-level="0"></i><i data-level="1"></i><i data-level="2"></i><i data-level="3"></i><i data-level="4"></i>
      多
    </div>
    <p class="kb-sr">{{ summary }}</p>
  </figure>
</template>
