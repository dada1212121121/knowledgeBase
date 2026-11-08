<script setup lang="ts">
// 折线图:几条指标随时间(或随运行次数)怎么变。
// - 按容器的真实像素宽度画(不是缩放的 viewBox),手机上轴文字也是 11px,不会缩成看不清;
// - 每条线除了颜色还有自己的点形(圆 / 方 / 菱 / 三角),只靠颜色分不开的人也能分;
// - 缺数据的点断开,不把两边连起来冒充连续;可以给某条线标出「回落」的点(红圈 + 提示里写明);
// - 鼠标悬停 / 触屏点按 / 键盘方向键都能看每一期的数值;
// - 无障碍:图本身是装饰(aria-hidden),完整数据是一份读屏专用的逐期文字(.kb-sr 里的列表),外层是可聚焦的分组。
// - 面积:`area` 为 true(只有一条线时)或 'gradient' 是线下一层渐变(上深下透);'stacked' 是堆叠面积,
//   各层累加,提示里除了每层自己的值还有合计。
// - 入场:进入视口才开始画一次(线从左到右描出来,面积和点跟着淡入);减弱动效时直接是最终状态(motion 令牌归零)。
// - `live`:最新一个点带一圈呼吸光圈,表示「这是现在」(监控类实时图用)。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import KbChartMark from './KbChartMark.vue'
import { useReveal } from '../motion/useMotion'
import { areaPath, bandPath, compactNumber, linePath, markerPath, markerShape, niceAxis, stackValues, type Pt } from './chartMath'

export interface LineSeries {
  name: string
  /** 与 labels 一一对应;null / undefined = 这一期没有数据 */
  values: (number | null | undefined)[]
  /** 不给就按顺序取 --viz-1…6 */
  color?: string
  /** 要标成「回落」的位置(下标) */
  flags?: number[]
  /** 回落时提示里写的话 */
  flagNote?: string
}

const props = withDefaults(
  defineProps<{
    labels: string[]
    series: LineSeries[]
    /** 图的名字,读屏软件读 */
    label: string
    format?: (value: number) => string
    height?: number
    /** 轴的硬边界:比例类指标不能画到 0 以下 / 100% 以上 */
    floor?: number
    ceil?: number
    /** 面积:true = 只有一条线时线下铺一层渐变;'gradient' = 每条线都铺;'stacked' = 堆叠面积 */
    area?: boolean | 'gradient' | 'stacked'
    /** 最新一个点带呼吸光圈(实时监控图) */
    live?: boolean
    /** 数的是「个数」:纵轴刻度只取整数(数据很小时不出现 0.5、1.5) */
    integer?: boolean
    /** 读屏表格第一列的列名 */
    categoryLabel?: string
    emptyText?: string
  }>(),
  { format: compactNumber, height: 200, floor: undefined, ceil: undefined, area: false, live: false, integer: false, categoryLabel: '时间', emptyText: '还没有数据' },
)

const PALETTE = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)', 'var(--viz-5)', 'var(--viz-6)']
const RIGHT = 14
const TOP = 12
const BOTTOM = 26
const INSET = 12
const CHAR_PX = 6.6

const host = ref<HTMLElement | null>(null)
// jsdom / 还没量到时用 480:够单测里画出来,真实浏览器挂载后立刻量到真实宽度
const width = ref(480)
let observer: ResizeObserver | undefined
onMounted(() => {
  const measure = () => {
    const measured = host.value?.clientWidth ?? 0
    if (measured > 0) width.value = measured
  }
  measure()
  if (typeof ResizeObserver !== 'undefined' && host.value) {
    observer = new ResizeObserver(measure)
    observer.observe(host.value)
  }
})
onBeforeUnmount(() => observer?.disconnect())

const count = computed(() => props.labels.length)
const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const finite = computed(() => props.series.flatMap((item) => item.values).filter(isNum))
const hasData = computed(() => finite.value.length > 0 && count.value > 0)
const uid = useId()
const { target: revealEl, shown: inView } = useReveal(0.25)
const areaMode = computed<'none' | 'gradient' | 'stacked'>(() =>
  props.area === 'stacked' ? 'stacked' : props.area === 'gradient' || (props.area === true && props.series.length === 1) ? 'gradient' : 'none',
)
const stacked = computed(() => areaMode.value === 'stacked')
// 堆叠时:每层的累计值(缺的按 0);轴按最高的累计值算,下沿固定从 0 起
const stackTops = computed(() => stackValues(props.series.map((item) => item.values.slice(0, count.value))))
const axis = computed(() => {
  const found = stacked.value
    ? niceAxis(0, Math.max(0, ...(stackTops.value.at(-1) ?? [0])), 4, { floor: 0, ceil: props.ceil })
    : niceAxis(Math.min(...finite.value), Math.max(...finite.value), 4, { floor: props.floor, ceil: props.ceil })
  // 个数类:步长不到 1 时改成每格 1(最小到 2,免得只有 0 和 1 两条线)
  if (props.integer && found.step < 1) {
    const max = Math.max(2, Math.ceil(found.max))
    return { min: 0, max, step: 1, ticks: Array.from({ length: max + 1 }, (_, at) => at) }
  }
  return found
})
const tickText = computed(() => axis.value.ticks.map((tick) => props.format(tick)))
const left = computed(() => Math.max(28, Math.max(...tickText.value.map((text) => text.length)) * CHAR_PX + 14))
const plotW = computed(() => Math.max(40, width.value - left.value - RIGHT))
const plotH = computed(() => Math.max(40, props.height - TOP - BOTTOM))
const span = computed(() => Math.max(1e-9, axis.value.max - axis.value.min))

const xAt = (index: number) => (count.value <= 1 ? left.value + plotW.value / 2 : left.value + INSET + ((plotW.value - 2 * INSET) * index) / (count.value - 1))
const yAt = (value: number) => TOP + plotH.value * (1 - (value - axis.value.min) / span.value)
const baseY = computed(() => TOP + plotH.value)

const lines = computed(() => {
  // 堆叠:线画在累计高度上,每层面积夹在「上一层累计」和「本层累计」之间
  const tops: (Pt | null)[][] = stackTops.value.map((cumulative) => props.labels.map((_, at) => ({ x: xAt(at), y: yAt(cumulative[at] ?? 0) })))
  const floorLine: (Pt | null)[] = props.labels.map((_, at) => ({ x: xAt(at), y: baseY.value }))
  return props.series.map((item, index) => {
    const own: (Pt | null)[] = props.labels.map((_, at) => {
      const value = item.values[at]
      return isNum(value) ? { x: xAt(at), y: yAt(value) } : null
    })
    const points = stacked.value ? tops[index]! : own
    const areaD = stacked.value ? bandPath(points, index === 0 ? floorLine : tops[index - 1]!) : areaMode.value === 'gradient' ? areaPath(points, baseY.value) : ''
    return {
      name: item.name,
      paint: item.color ?? PALETTE[index % PALETTE.length]!,
      shape: markerShape(index),
      points,
      d: linePath(points),
      areaD,
      gradId: `kb-line-grad-${uid}-${index}`,
      flags: new Set(item.flags ?? []),
      flagNote: item.flagNote ?? '比前一期低',
      // 线多了用虚线区分;堆叠面积每层有自己的色块,不需要(虚线叠在色块边上很乱)
      dashed: !stacked.value && index > 0 && props.series.length > 3,
    }
  })
})
// 实时光圈:第一条线最后一个有数据的点
const nowPoint = computed(() => {
  if (!props.live) return null
  const points = lines.value[stacked.value ? lines.value.length - 1 : 0]?.points ?? []
  for (let at = points.length - 1; at >= 0; at -= 1) if (points[at]) return { ...points[at]!, paint: lines.value[stacked.value ? lines.value.length - 1 : 0]!.paint }
  return null
})
const anyFlag = computed(() => lines.value.some((line) => line.flags.size > 0))

// 横轴标签:从最后一期往前每隔 step 个画一个(最新一期最重要,必须在);间距不够就自动抽稀
const labelStep = computed(() => {
  if (count.value <= 1) return 1
  const pitch = (plotW.value - 2 * INSET) / (count.value - 1)
  const wanted = Math.max(...props.labels.map((text) => text.length)) * CHAR_PX + 10
  return Math.max(1, Math.ceil(wanted / Math.max(1, pitch)))
})
const showLabel = (index: number) => (count.value - 1 - index) % labelStep.value === 0

const active = ref<number | null>(null)
const colW = computed(() => (count.value > 1 ? (plotW.value - 2 * INSET) / (count.value - 1) : plotW.value))
const manyPoints = computed(() => count.value > 24 || stacked.value)

const tip = computed(() => {
  const at = active.value
  if (at === null || at < 0 || at >= count.value) return null
  const x = xAt(at)
  return {
    title: props.labels[at] ?? '',
    x,
    right: x > width.value / 2,
    rows: lines.value.map((line) => {
      const value = props.series.find((item) => item.name === line.name)?.values[at]
      return { name: line.name, paint: line.paint, shape: line.shape, text: isNum(value) ? props.format(value) : '—', flag: line.flags.has(at) ? line.flagNote : '' }
    }),
    // 堆叠面积:各层相加才是整体,提示里补一行合计
    total: stacked.value ? props.format(stackTops.value.at(-1)?.[at] ?? 0) : '',
  }
})
// 提示气泡的宽度随内容变(几条线、有没有回落说明),不能按「过了中线就翻到左边」猜:
// 手机上图只有 300 多像素,气泡在中线附近时右边放不下,会伸到卡片外面去。所以量出气泡实际宽度,放得下右边就放右边,
// 否则放左边,最后再夹在图的范围内。还没量到时(第一次出现 / 单测环境)按 160 估。
const tipEl = ref<HTMLElement | null>(null)
const tipW = ref(160)
watch(
  tip,
  async (value) => {
    if (!value) return
    await nextTick()
    const measured = tipEl.value?.offsetWidth ?? 0
    if (measured > 0) tipW.value = measured
  },
  { flush: 'post' },
)
const tipStyle = computed(() => {
  const value = tip.value
  if (!value) return undefined
  let at = value.x + 12
  if (at + tipW.value > width.value) at = value.x - 12 - tipW.value
  return { left: `${Math.max(0, Math.min(at, width.value - tipW.value))}px` }
})

function step(delta: number) {
  const last = count.value - 1
  if (last < 0) return
  active.value = active.value === null ? (delta > 0 ? 0 : last) : Math.min(last, Math.max(0, active.value + delta))
}
function onKey(event: KeyboardEvent) {
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') step(1)
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') step(-1)
  else if (event.key === 'Home') active.value = 0
  else if (event.key === 'End') active.value = count.value - 1
  else if (event.key === 'Escape') active.value = null
  else return
  event.preventDefault()
}
// 点按先于聚焦:点了某一期,随后的聚焦不要把它盖回最后一期
const onFocus = () => {
  if (active.value === null && count.value > 0) active.value = count.value - 1
}

const cell = (item: LineSeries, index: number) => {
  const value = item.values[index]
  return isNum(value) ? `${props.format(value)}${item.flags?.includes(index) ? `(${item.flagNote ?? '比前一期低'})` : ''}` : '没有数据'
}
const groupLabel = computed(() => (hasData.value ? `${props.label},共 ${count.value} 期,可用方向键逐期查看` : `${props.label}:${props.emptyText}`))
</script>

<template>
  <figure
    ref="host"
    class="kb-line"
    :class="{ 'is-in': inView, 'is-stacked': stacked }"
    role="group"
    :aria-label="groupLabel"
    :tabindex="hasData ? 0 : undefined"
    @keydown="onKey"
    @focus="onFocus"
    @blur="active = null"
    @pointerleave="active = null"
  >
    <template v-if="hasData">
      <svg ref="revealEl" class="kb-line-svg" :width="width" :height="height" :viewBox="`0 0 ${width} ${height}`" aria-hidden="true" focusable="false">
        <defs v-if="areaMode === 'gradient'">
          <!-- 线下面积:上深下透,颜色跟线走 -->
          <linearGradient v-for="line in lines" :id="line.gradId" :key="line.gradId" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" :style="{ stopColor: line.paint }" stop-opacity=".34" />
            <stop offset="1" :style="{ stopColor: line.paint }" stop-opacity="0" />
          </linearGradient>
        </defs>
        <g v-for="(tick, index) in axis.ticks" :key="tick">
          <line :class="tick === axis.min ? 'kb-line-base' : 'kb-line-grid'" :x1="left" :x2="left + plotW" :y1="yAt(tick)" :y2="yAt(tick)" />
          <text class="kb-line-tick" :x="left - 8" :y="yAt(tick) + 4" text-anchor="end">{{ tickText[index] }}</text>
        </g>
        <template v-for="(text, index) in labels" :key="`${index}-${text}`">
          <text v-if="showLabel(index)" class="kb-line-tick" :x="xAt(index)" :y="height - 6" text-anchor="middle">{{ text }}</text>
        </template>

        <line v-if="tip" class="kb-line-cursor" :x1="tip.x" :x2="tip.x" :y1="TOP" :y2="baseY" />

        <g v-for="line in lines" :key="line.name">
          <path v-if="line.areaD" class="kb-line-area" :class="{ 'is-band': stacked }" :d="line.areaD" :style="{ fill: stacked ? line.paint : `url(#${line.gradId})` }" />
          <path class="kb-line-path" :class="{ 'is-dash': line.dashed }" :d="line.d" :pathLength="line.dashed ? undefined : 1" :style="{ stroke: line.paint }" />
          <template v-for="(point, index) in line.points" :key="index">
            <template v-if="point">
              <path v-if="!manyPoints || active === index" class="kb-line-dot" :d="markerPath(line.shape, point.x, point.y, active === index ? 5 : 3.5)" :style="{ fill: line.paint }" />
              <circle v-if="line.flags.has(index)" class="kb-line-flag" :cx="point.x" :cy="point.y" r="8" />
            </template>
          </template>
        </g>

        <g v-if="nowPoint" class="kb-line-nowwrap">
          <circle class="kb-line-now" :cx="nowPoint.x" :cy="nowPoint.y" r="5" :style="{ stroke: nowPoint.paint }" />
        </g>

        <rect
          v-for="(_, index) in labels"
          :key="`hit-${index}`"
          :x="xAt(index) - colW / 2"
          :y="TOP"
          :width="colW"
          :height="plotH + BOTTOM"
          fill="transparent"
          @pointerenter="active = index"
          @pointermove="active = index"
          @pointerdown="active = index"
        />
      </svg>

      <div v-if="tip" ref="tipEl" class="kb-line-tip" :style="tipStyle" aria-hidden="true">
        <div class="m kb-line-tip-title">{{ tip.title }}</div>
        <template v-for="row in tip.rows" :key="row.name">
          <div class="kb-line-tip-row">
            <KbChartMark :shape="row.shape" :color="row.paint" />
            <span>{{ row.name }}</span>
            <b>{{ row.text }}</b>
          </div>
          <div v-if="row.flag" class="kb-line-tip-flag">{{ row.name }}{{ row.flag }}</div>
        </template>
        <div v-if="tip.total" class="kb-line-tip-row kb-line-tip-total">
          <span></span>
          <span>合计</span>
          <b>{{ tip.total }}</b>
        </div>
      </div>

      <div class="kb-line-legend" aria-hidden="true">
        <span v-for="line in lines" :key="line.name"><KbChartMark :shape="line.shape" :color="line.paint" />{{ line.name }}</span>
        <span v-if="anyFlag"><svg class="kb-mark" width="12" height="12" viewBox="0 0 12 12" focusable="false"><circle class="kb-line-flag" cx="6" cy="6" r="4.5" /></svg>比前一期低</span>
      </div>

      <!-- 读屏用的文字版数据。不用 <table>:手机上全局样式会把 table 拆成块(表头消失、行列错位),结构恰好在最需要的地方丢掉 -->
      <div class="kb-sr">
        <p>{{ label }}</p>
        <ul>
          <li v-for="(text, index) in labels" :key="`${index}-${text}`">{{ categoryLabel }} {{ text }}:{{ series.map((item) => `${item.name} ${cell(item, index)}`).join(';') }}</li>
        </ul>
      </div>
    </template>
    <div v-else class="kb-line-empty">{{ emptyText }}</div>
  </figure>
</template>
