<script setup lang="ts">
// 环形图:占比一眼看清。左边是环(中间放总数),右边是图例,图例每行都写着名字、数值和占比。
// 无障碍:环本身是装饰(aria-hidden),真正的数据在图例这个列表里,读屏软件和键盘用户读到的是同一份文字;
// 颜色之外,相邻两段之间留了缝,图例里每行都有数字,不靠颜色也读得出每段多大。
import { computed, ref } from 'vue'
import { useReveal } from '../motion/useMotion'
import KbNum from './KbNum.vue'
import { compactNumber, donutArcs, shareText } from './chartMath'

export interface DonutItem {
  name: string
  value: number
  /** 不给就按顺序取 --viz-1…6 */
  color?: string
  /** 「其它」这类汇总项:用中性灰,不占分类色 */
  other?: boolean
}

const props = withDefaults(
  defineProps<{
    items: DonutItem[]
    /** 图的名字,读屏软件读;例如「内容片段占比」 */
    label: string
    /** 环中间的大字;不给就显示总数 */
    center?: string
    /** 环中间的小字 */
    caption?: string
    size?: number
    format?: (value: number) => string
    emptyText?: string
  }>(),
  { center: undefined, caption: '', size: 120, format: compactNumber, emptyText: '还没有数据' },
)

const RADIUS = 42
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const PALETTE = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)', 'var(--viz-5)', 'var(--viz-6)']

const total = computed(() => props.items.reduce((sum, item) => sum + (item.value > 0 ? item.value : 0), 0))
// 颜色按「第几个分类」取,不是第几项:「其它」不占色板的位置,换了数据顺序颜色也稳定
const colored = computed(() => {
  let next = 0
  return props.items.map((item) => ({
    ...item,
    paint: item.color ?? (item.other ? 'var(--viz-other)' : PALETTE[next++ % PALETTE.length]!),
  }))
})
const arcs = computed(() => donutArcs(colored.value.map((item) => item.value), CIRCUMFERENCE, 2.5))
const rows = computed(() =>
  colored.value.map((item, index) => ({
    key: `${index}-${item.name}`,
    name: item.name,
    paint: item.paint,
    num: props.format(Math.max(0, item.value)),
    pct: shareText(item.value, total.value),
  })),
)

const hover = ref<number | null>(null)
const { target, shown } = useReveal(0.2)
const summary = computed(() => (total.value > 0 ? `${props.label},共 ${props.format(total.value)}` : `${props.label}:${props.emptyText}`))
</script>

<template>
  <figure ref="target" class="kb-donut" :class="{ 'is-in': shown, 'is-hover': hover !== null }" role="group" :aria-label="summary" :style="{ '--donut-size': `${size}px` }">
    <div class="kb-donut-plot">
      <svg class="kb-donut-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        <circle class="kb-donut-track" cx="50" cy="50" :r="RADIUS" />
        <circle
          v-for="arc in arcs"
          :key="arc.index"
          class="kb-donut-arc"
          :class="{ 'is-on': hover === arc.index }"
          cx="50"
          cy="50"
          :r="RADIUS"
          :style="{ stroke: rows[arc.index]?.paint }"
          :stroke-dasharray="`${arc.dash} ${arc.gap}`"
          :stroke-dashoffset="arc.offset"
          @mouseenter="hover = arc.index"
          @mouseleave="hover = null"
        />
      </svg>
      <div class="kb-donut-center">
        <span class="kb-donut-value"><KbNum :value="center ?? (total > 0 ? format(total) : '—')" /></span>
        <span v-if="caption" class="kb-donut-cap">{{ caption }}</span>
      </div>
    </div>

    <ul v-if="total > 0" class="kb-donut-legend">
      <li
        v-for="(row, index) in rows"
        :key="row.key"
        class="kb-donut-row"
        :class="{ 'is-on': hover === index }"
        @mouseenter="hover = index"
        @mouseleave="hover = null"
      >
        <i class="kb-donut-sw" :style="{ background: row.paint }"></i>
        <span class="kb-donut-name" :title="row.name">{{ row.name }}</span>
        <b class="kb-donut-num"><KbNum :value="row.num" /></b>
        <span class="kb-donut-pct">{{ row.pct }}</span>
      </li>
    </ul>
    <p v-else class="kb-donut-empty">{{ emptyText }}</p>
  </figure>
</template>
