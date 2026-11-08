<script setup lang="ts">
// 环形仪表:一个 0–1 的比例(处理器、内存、磁盘、配额用了多少)。
// - 270° 的弧,缺口在下方;中间是大数字(数字滚动),下面一行小字;
// - 阈值着色:到 80% 变警告色、到 90% 变危险色;颜色之外还有文字(aria-label 和 title 里写「偏高 / 接近上限」),不只靠颜色;
// - 入场:进入视口才开始,弧线从 0 弹簧式扫到当前值(motion 令牌:--dur-page / --ease-spring-soft);
//   之后数值变化时弧线平滑过渡。减弱动效时令牌归零,直接到位;
// - 图是装饰(aria-hidden),真实数据在外层 role="img" 的 aria-label 里。
import { computed } from 'vue'
import KbCountUp from './KbCountUp.vue'
import { useReveal } from '../motion/useMotion'
import { formatPercent, levelOf, type Level } from './chartFormat'

const props = withDefaults(
  defineProps<{
    /** 0–1 的比例;超过 1 画满(文字照实写),小于 0 当 0 */
    value: number
    /** 这个仪表量的是什么,读屏软件读(例如「处理器使用率」) */
    label: string
    /** 中间的大字;不给就是百分数(数字滚动) */
    text?: string
    /** 大字下面的小字(例如「16 核」「38 / 62 GB」) */
    caption?: string
    /** 直径(像素) */
    size?: number
    /** 警告 / 危险阈值;给 null 表示这个仪表不分级(例如只是占比,不是用量) */
    warn?: number | null
    danger?: number | null
  }>(),
  { text: '', caption: '', size: 120, warn: 0.8, danger: 0.9 },
)

const { target, shown } = useReveal(0.25)

const R = 44
const CIRC = 2 * Math.PI * R
/** 弧占整圈的比例:270° */
const SPAN = 0.75
const ratio = computed(() => (Number.isFinite(props.value) ? Math.min(1, Math.max(0, props.value)) : 0))
const level = computed<Level>(() => (props.warn === null || props.danger === null ? 'ok' : levelOf(props.value, props.warn, props.danger)))
const LEVEL_TEXT: Record<Level, string> = { ok: '', warn: '偏高', danger: '接近上限' }
const levelText = computed(() => LEVEL_TEXT[level.value])
// 还没进入视口时弧是空的;进入后扫到当前值
const filled = computed(() => (shown.value ? ratio.value : 0) * SPAN * CIRC)
const shownText = computed(() => props.text || formatPercent(props.value))
const summary = computed(() => `${props.label}:${shownText.value}${props.caption ? `(${props.caption})` : ''}${levelText.value ? `,${levelText.value}` : ''}`)
const plain = computed(() => !props.text && Number.isFinite(props.value))
</script>

<template>
  <figure ref="target" class="kb-gauge" :class="[`is-${level}`, { 'is-in': shown }]" role="img" :aria-label="summary" :title="levelText ? summary : undefined" :style="{ '--gauge-size': `${size}px` }">
    <svg class="kb-gauge-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <circle class="kb-gauge-track" cx="50" cy="50" :r="R" :stroke-dasharray="`${SPAN * CIRC} ${CIRC}`" />
      <circle class="kb-gauge-arc" cx="50" cy="50" :r="R" :style="{ strokeDasharray: `${filled} ${CIRC}` }" />
    </svg>
    <div class="kb-gauge-center" aria-hidden="true">
      <b class="kb-gauge-value"><template v-if="plain"><KbCountUp :value="Math.round(value * 100)" />%</template><template v-else>{{ shownText }}</template></b>
      <span v-if="caption" class="m kb-gauge-caption">{{ caption }}</span>
    </div>
  </figure>
</template>
