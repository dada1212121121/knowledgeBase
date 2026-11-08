<script setup lang="ts">
// 漏斗(导入流水线:排队 → 解析 → 向量化 → 完成):一段一行,条长按「占第一段的比例」,
// 段与段之间写「转化率」(进入下一步的占比)。失败 / 跳过这类旁路段用 tone="danger" / "muted",不参与转化率。
// 条从左长出来(kb-grow-x,按行错开),进入视口才开始;减弱动效时直接是最终状态。
// 图是装饰,读屏用的是每一段的名字和数量(列表本身就是数据)。
import { computed } from 'vue'
import { useReveal } from '../motion/useMotion'
import { compactNumber, shareText } from './chartMath'

export interface FunnelStage {
  name: string
  value: number
  /** danger = 失败(红);muted = 跳过 / 隔离(灰);不给 = 主线(按顺序取色板) */
  tone?: 'danger' | 'muted'
}

const props = withDefaults(defineProps<{ stages: FunnelStage[]; label: string; format?: (value: number) => string; emptyText?: string }>(), {
  format: compactNumber,
  emptyText: '还没有数据',
})
const { target, shown } = useReveal(0.2)

const PALETTE = ['var(--viz-1)', 'var(--viz-5)', 'var(--viz-4)', 'var(--viz-2)']
const base = computed(() => Math.max(0, ...props.stages.filter((stage) => !stage.tone).map((stage) => stage.value), ...props.stages.map((stage) => stage.value)))

const rows = computed(() => {
  let main = 0
  let previous: number | null = null
  return props.stages.map((stage) => {
    const value = Number.isFinite(stage.value) && stage.value > 0 ? stage.value : 0
    const paint = stage.tone === 'danger' ? 'var(--viz-6)' : stage.tone === 'muted' ? 'var(--viz-other)' : PALETTE[main++ % PALETTE.length]!
    // 转化率:只在主线段之间算(这一段 ÷ 上一个主线段)
    let rate = ''
    if (!stage.tone) {
      if (previous !== null && previous > 0) rate = shareText(value, previous)
      previous = value
    }
    return { name: stage.name, value, paint, width: base.value ? Math.max(value ? 1.5 : 0, (value / base.value) * 100) : 0, text: props.format(value), rate, tone: stage.tone ?? '' }
  })
})
const hasData = computed(() => base.value > 0)
</script>

<template>
  <figure ref="target" class="kb-funnel" :class="{ 'is-in': shown }" role="group" :aria-label="hasData ? label : `${label}:${emptyText}`">
    <ul v-if="hasData" class="kb-funnel-list">
      <li v-for="(row, index) in rows" :key="row.name" class="kb-funnel-row" :class="row.tone && `is-${row.tone}`" :style="{ '--i': index }">
        <div class="kb-funnel-head">
          <span>{{ row.name }}</span>
          <b>{{ row.text }}</b>
        </div>
        <div class="kb-funnel-track" aria-hidden="true"><i :style="{ width: `${row.width}%`, background: row.paint }"></i></div>
        <span v-if="row.rate" class="m kb-funnel-rate">进入这一步的占 {{ row.rate }}</span>
      </li>
    </ul>
    <div v-else class="kb-funnel-empty">{{ emptyText }}</div>
  </figure>
</template>
