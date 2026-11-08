<script setup lang="ts">
// 柱状图(设计规范): 纯 token 柱图与堆叠柱图,不引第三方体积庞大的图表库。
// 堆叠模式(仪表盘「7 日进化活动」):纵轴按数据取整(10/20/50/100…),悬停任意一天显示当天明细,
// 没有悬停时默认突出峰值那天。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useReveal } from '../motion/useMotion'
import { axisAnchor, axisFontSize } from './chartFont'

export interface BarSeries {
  name: string
  color: string
  values: number[]
}

const props = withDefaults(
  defineProps<{
    labels: string[]
    values?: number[]
    series?: BarSeries[]
    max?: number
    /** 所有数据都是 0 时,在图中央显示的一句话 */
    emptyText?: string
  }>(),
  { values: () => [], series: () => [], max: undefined, emptyText: '' },
)

const isStacked = computed(() => props.series && props.series.length > 0)

/* ---- 堆叠图的几何(viewBox 560×190,7 根柱) ---- */
const LEFT = 50
const STEP = 74
const BAR = 34
const TOP = 20
const BOTTOM = 164

const columns = computed(() =>
  props.labels.map((day, index) => {
    let acc = 0
    const segments = props.series.map((s) => {
      const value = s.values[index] ?? 0
      const segment = { name: s.name, color: s.color, value, y0: acc, y1: acc + value }
      acc += value
      return segment
    })
    return { day, total: acc, segments }
  }),
)

/** 纵轴:4 格,每格取 1/2/5×10^n 的整数步长,保证最高柱不顶格。 */
const axis = computed(() => {
  const peak = Math.max(props.max ?? 0, ...columns.value.map((c) => c.total), 1)
  const raw = peak / 4
  const base = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 5, 10].map((m) => m * base).find((s) => s >= raw) ?? base * 10
  return { step, top: step * 4, ticks: [4, 3, 2, 1, 0].map((i) => ({ value: i * step, y: BOTTOM - ((BOTTOM - TOP) / 4) * i })) }
})
const scaleY = (value: number) => BOTTOM - Math.min(1, value / axis.value.top) * (BOTTOM - TOP)

const { target: chartEl, shown: inView } = useReveal(0.25)

/**
 * 坐标轴文字的字号(图内单位)。图是 viewBox 560 宽、width=100% 的 SVG,窄屏上整张图会缩小,写死的 10 在 390 宽手机上渲染后只有约 5.8px。
 * 量出实际缩放比例,把字号放大到渲染后约 11px(规则和上限见 chartFont.ts)。还没量到时按原来的 10。
 */
const VIEWBOX_WIDTH = 560
const labelSize = ref(axisFontSize(0))
let observer: ResizeObserver | undefined
function measure() {
  const svg = chartEl.value?.querySelector('svg')
  if (!svg) return
  labelSize.value = axisFontSize(svg.getBoundingClientRect().width / VIEWBOX_WIDTH)
}
onMounted(() => {
  measure()
  if (typeof ResizeObserver === 'undefined' || !chartEl.value) return
  observer = new ResizeObserver(measure)
  observer.observe(chartEl.value)
})
onBeforeUnmount(() => observer?.disconnect())
// 纵轴刻度右对齐的位置:字号放大后,最宽的刻度要右移才不被左边界裁掉;不越过第一根柱的起点(留 4 个单位空隙)
const axisX = computed(() => axisAnchor(labelSize.value, Math.max(1, ...axis.value.ticks.map((tick) => String(tick.value).length)), LEFT - 4))
const allZero = computed(() => (isStacked.value ? columns.value.every((column) => column.total === 0) : props.values.every((value) => !value)))
const hover = ref<number | null>(null)
const peakIndex = computed(() => {
  let best = 0
  columns.value.forEach((c, i) => {
    if (c.total > (columns.value[best]?.total ?? 0)) best = i
  })
  return best
})
const active = computed(() => hover.value ?? peakIndex.value)
const activeColumn = computed(() => columns.value[active.value])
const tip = computed(() => {
  const column = activeColumn.value
  if (!column) return null
  return {
    day: column.day,
    total: column.total,
    items: column.segments.filter((s) => s.value > 0).sort((a, b) => b.value - a.value),
  }
})
/** 提示气泡:未悬停时放在设计稿的固定位置(峰值日右侧偏上,不压住柱子);悬停别的柱子时才跟随那根柱子。
 *  left 用 calc 跟随 svg 在容器里的水平居中。 */
const tipStyle = computed(() => {
  if (hover.value === null) {
    return { left: 'calc(16px + (100% - 32px - 560px) / 2 + 284px)' }
  }
  const barLeft = LEFT + active.value * STEP
  const onRight = active.value < 3
  const x = onRight ? barLeft + BAR + 12 : barLeft - 12
  return {
    left: `calc(16px + (100% - 32px - 560px) / 2 + ${x}px)`,
    transform: onRight ? undefined : 'translateX(-100%)',
  }
})

/* ---- 简单柱图 ---- */
const computedMax = computed(() => props.max || Math.max(...props.values, 1))
const height = (value: number) => `${Math.max(4, Math.round((value / computedMax.value) * 100))}%`
</script>

<template>
  <div v-if="!isStacked" ref="chartEl" class="kb-bars" :class="{ 'is-in': inView, 'is-empty': allZero }">
    <div v-if="allZero && emptyText" class="kb-chart-empty">{{ emptyText }}</div>
    <div v-for="(label, index) in labels" :key="label" class="kb-bar" :title="`${label}:${values[index] ?? 0}`">
      <div class="kb-bar-fill" :style="{ height: height(values[index] ?? 0) }" style-allow="柱高来自数据"></div>
      <div class="kb-bar-label">{{ label }}</div>
    </div>
  </div>

  <div v-else ref="chartEl" class="kb-chart" :class="{ 'is-in': inView, 'is-empty': allZero }" @mouseleave="hover = null">
    <svg class="kb-chart-svg" width="100%" height="190" viewBox="0 0 560 190" role="group" aria-label="每日新增 insight 堆叠柱状图">
      <defs>
        <linearGradient v-for="(s, idx) in series" :id="`kb-bg${idx}`" :key="`grad-${idx}`" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" :stop-color="s.color" />
          <stop offset="1" :stop-color="s.color" stop-opacity=".72" />
        </linearGradient>
      </defs>

      <template v-for="tick in axis.ticks" :key="tick.value">
        <line x1="30" x2="560" :y1="tick.y" :y2="tick.y" stroke="var(--b)" stroke-width="1" :stroke-dasharray="tick.value === 0 ? undefined : '2 4'" />
        <text :x="axisX" :y="tick.y + 4" fill="var(--m2)" :font-size="labelSize" text-anchor="end">{{ tick.value }}</text>
      </template>

      <template v-for="(col, colIdx) in columns" :key="col.day">
        <g class="barg" :class="{ 'is-active': colIdx === active }" :style="{ '--i': colIdx }" style-allow="入场动画错峰">
          <rect
            v-for="(seg, sIdx) in col.segments.filter((s) => s.value > 0)"
            :key="`${colIdx}-${seg.name}`"
            :x="LEFT + colIdx * STEP"
            :y="scaleY(seg.y1)"
            :width="BAR"
            :height="Math.max(0, scaleY(seg.y0) - scaleY(seg.y1))"
            :rx="seg === col.segments.filter((s) => s.value > 0).at(-1) ? 4 : 0"
            :fill="`url(#kb-bg${series.findIndex((s) => s.name === seg.name)})`"
            :data-seg="sIdx"
          />
        </g>
        <text :x="LEFT + BAR / 2 + colIdx * STEP" y="182" fill="var(--m)" :font-size="labelSize" text-anchor="middle">{{ col.day }}</text>
        <!-- 整列热区:悬停 / 聚焦都能切换提示。
             热区能聚焦、有名字,就必须有角色(没有角色的 <rect> 上放 aria-label 是 ARIA 不允许的,axe aria-prohibited-attr);
             图表根节点也相应从 img 改成 group:img 的子孙在无障碍树里都被当作装饰,里面的可聚焦热区读屏读不到 -->
        <rect
          class="kb-chart-hit"
          role="graphics-symbol"
          :x="LEFT - 20 + colIdx * STEP"
          :y="TOP"
          :width="STEP"
          :height="BOTTOM - TOP + 20"
          fill="transparent"
          tabindex="0"
          :aria-label="`${col.day} 共 ${col.total} 条`"
          @mouseenter="hover = colIdx"
          @focus="hover = colIdx"
          @blur="hover = null"
        />
      </template>

      <line :x1="LEFT + BAR / 2 + active * STEP" :x2="LEFT + BAR / 2 + active * STEP" :y1="TOP" :y2="BOTTOM" stroke="var(--b2)" stroke-dasharray="3 3" class="kb-chart-cursor" />
    </svg>

    <div v-if="allZero && emptyText" class="kb-chart-empty">{{ emptyText }}</div>
    <div v-else-if="tip" class="tip kb-chart-tip" :style="tipStyle" style-allow="气泡位置跟随当前柱子">
      <div class="m kb-chart-tip-title">{{ tip.day }} · 共 {{ tip.total }} 条</div>
      <div v-for="item in tip.items" :key="item.name" class="row">
        <span class="dot" :style="{ background: item.color }" style-allow="项目颜色来自数据"></span>
        {{ item.name }}
        <b class="kb-spacer">{{ item.value }}</b>
      </div>
    </div>
  </div>
</template>
