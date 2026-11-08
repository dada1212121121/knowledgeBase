<script setup lang="ts">
// 活跃度热力格(设计规范;参考 uilab「打卡热力格」):一列一周、一行一天(周一在最上),按次数分四档。
// 传入 `cells`(按日期升序的 { date, value }),组件自己按「周 × 日」排布;
// 最左一列从该周周一排起,前面不属于数据范围的格子是空位(不画色块)。
// 没有更早的数据就让左侧空着——不编造历史。
import { computed } from 'vue'
import { useReveal } from '../motion/useMotion'

export interface HeatCell {
  /** YYYY-MM-DD */
  date: string
  value: number
}

const props = withDefaults(defineProps<{ cells: HeatCell[]; weeks?: number }>(), { weeks: 16 })

const { target, shown } = useReveal(0.2)

const parse = (date: string) => {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y!, (m ?? 1) - 1, d ?? 1)
}
/** 周一=0 … 周日=6 */
const weekday = (date: Date) => (date.getDay() + 6) % 7

const max = computed(() => Math.max(...props.cells.map((cell) => cell.value), 1))
const level = (value: number) => {
  if (!value) return 0
  const ratio = value / max.value
  return ratio > 0.75 ? 4 : ratio > 0.5 ? 3 : ratio > 0.25 ? 2 : 1
}

/** 网格:从「最后一天所在周」往前数 weeks 周;每格 { col, row, value|null } */
const grid = computed(() => {
  if (!props.cells.length) return [] as { col: number; row: number; value: number | null; label: string }[]
  const byDate = new Map(props.cells.map((cell) => [cell.date, cell.value]))
  const last = parse(props.cells[props.cells.length - 1]!.date)
  const lastRow = weekday(last)
  const out: { col: number; row: number; value: number | null; label: string }[] = []
  for (let col = 0; col < props.weeks; col++) {
    for (let row = 0; row < 7; row++) {
      const back = (props.weeks - 1 - col) * 7 + (lastRow - row)
      const day = new Date(last)
      day.setDate(last.getDate() - back)
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
      // 今天之后的格子不存在
      if (back < 0) continue
      const value = byDate.get(key)
      out.push({ col, row, value: value ?? null, label: key })
    }
  }
  return out
})
</script>

<template>
  <div ref="target" class="kb-heat" :class="{ 'is-in': shown }" :style="{ '--heat-cols': weeks }">
    <i
      v-for="cell in grid"
      :key="cell.label"
      :class="{ 'is-void': cell.value === null }"
      :data-level="cell.value === null ? 0 : level(cell.value)"
      :style="{ gridColumn: cell.col + 1, gridRow: cell.row + 1, '--i': cell.col }"
      :title="cell.value === null ? undefined : `${cell.label}:${cell.value}`"
    ></i>
  </div>
</template>
