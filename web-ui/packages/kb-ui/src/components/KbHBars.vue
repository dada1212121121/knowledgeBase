<script setup lang="ts">
// 横向条:每行一个名字 + 一根(可堆叠的)条 + 右边的总数。
// 三种用法:① 堆叠(每人的存储按 笔记/原件/向量/工作目录 拆开)② 带上限刻度(配额线,超过的行标红)③ 单色直方(名次分布、耗时分布)。
// 所有行共用同一把尺子,条的长短才能互相比;条越界(超过上限)时尺子自动放大,配额线不会被推出图外。
// 无障碍:条是装饰(aria-hidden);每行另有一段读屏文字写明拆分,图例也是真正的列表。
import { computed } from 'vue'
import { compactNumber } from './chartMath'

export interface HBarSegment {
  name: string
  value: number
  color?: string
}
export interface HBarRow {
  key: string
  label: string
  /** 名字后面的小字,例如 @用户名 */
  sub?: string
  segments: HBarSegment[]
  /** 上限(配额)。0 或不给 = 没有上限 */
  limit?: number
  /** 右边的总数文字;不给就用 format(总和) */
  totalText?: string
}

const props = withDefaults(
  defineProps<{
    rows: HBarRow[]
    /** 图的名字,读屏软件读 */
    label: string
    /** 共用尺子的最大值;不给就取所有行的总和与上限里最大的 */
    max?: number
    /** 显示图例(堆叠时需要;单色直方不需要) */
    legend?: boolean
    format?: (value: number) => string
    note?: string
    emptyText?: string
  }>(),
  { max: undefined, legend: false, format: compactNumber, note: '', emptyText: '还没有数据' },
)

const PALETTE = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)', 'var(--viz-5)', 'var(--viz-6)']

// 分段的颜色按名字取:同一个名字在每一行里颜色一致,图例才对得上
const names = computed(() => [...new Set(props.rows.flatMap((row) => row.segments.map((segment) => segment.name)))])
const paintOf = (segment: HBarSegment) => segment.color ?? PALETTE[Math.max(0, names.value.indexOf(segment.name)) % PALETTE.length]!
// 图例的颜色跟条一致:这个名字的分段自己给了颜色(例如失败固定用红)就用它,否则按名字取色板
const legendItems = computed(() =>
  names.value.filter(Boolean).map((name) => {
    const given = props.rows.flatMap((row) => row.segments).find((segment) => segment.name === name && segment.color)
    return { name, paint: paintOf({ name, value: 0, color: given?.color }) }
  }),
)

const totalOf = (row: HBarRow) => row.segments.reduce((sum, segment) => sum + (segment.value > 0 ? segment.value : 0), 0)
const scale = computed(() => Math.max(props.max ?? 0, ...props.rows.map((row) => Math.max(totalOf(row), row.limit ?? 0)), 1))

const view = computed(() =>
  props.rows.map((row) => {
    const total = totalOf(row)
    const parts = row.segments.filter((segment) => segment.value > 0)
    const over = !!row.limit && row.limit > 0 && total >= row.limit
    return {
      key: row.key,
      label: row.label,
      sub: row.sub ?? '',
      over,
      totalText: row.totalText ?? props.format(total),
      limitAt: row.limit && row.limit > 0 ? (row.limit / scale.value) * 100 : null,
      parts: parts.map((segment) => ({ name: segment.name, paint: paintOf(segment), width: (segment.value / scale.value) * 100, text: props.format(segment.value) })),
      // 读屏用:「笔记 3 GB、原件 70 GB;配额 100 GB」
      spoken: [parts.map((segment) => `${segment.name ? `${segment.name} ` : ''}${props.format(segment.value)}`).join('、'), row.limit && row.limit > 0 ? `上限 ${props.format(row.limit)}` : ''].filter(Boolean).join(';'),
    }
  }),
)
</script>

<template>
  <figure class="kb-hbars" role="group" :aria-label="label">
    <ul v-if="legend && legendItems.length && rows.length" class="kb-hbars-legend">
      <li v-for="item in legendItems" :key="item.name"><i :style="{ background: item.paint }"></i>{{ item.name }}</li>
    </ul>
    <ul v-if="rows.length" class="kb-hbars-list">
      <li v-for="row in view" :key="row.key" class="kb-hbars-row" :class="{ 'is-over': row.over }">
        <div class="kb-hbars-head">
          <span class="kb-hbars-label" :title="row.label">{{ row.label }}<small v-if="row.sub" class="kb-hbars-sub">{{ row.sub }}</small></span>
          <span class="kb-hbars-total">{{ row.totalText }}</span>
        </div>
        <div class="kb-hbars-track" aria-hidden="true">
          <i v-for="part in row.parts" :key="part.name" class="kb-hbars-seg" :title="`${part.name ? `${part.name} ` : ''}${part.text}`" :style="{ width: `${part.width}%`, background: part.paint }"></i>
          <b v-if="row.limitAt !== null" class="kb-hbars-limit" :style="{ left: `${row.limitAt}%` }"></b>
        </div>
        <span class="kb-sr">{{ row.spoken }}</span>
      </li>
    </ul>
    <p v-else class="kb-hbars-empty">{{ emptyText }}</p>
    <p v-if="note && rows.length" class="kb-hbars-note">{{ note }}</p>
  </figure>
</template>
