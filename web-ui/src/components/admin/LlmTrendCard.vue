<script setup lang="ts">
// 全站 AI 用量趋势(存储与用量 · AI 用量页签,卡 G):最近 7 / 30 / 90 天每天用了多少 token,按用途堆叠。
// 数据是 llm_usage_series(管理员,按站点时区的日期,和页面上「今日用量」「每天 0 点重置」是同一个口径)。
import { computed, ref, shallowRef, watch } from 'vue'
import { KbChartCard, KbLineChart, compactNumber, type LineSeries } from '@kb-ui/index'
import { llmUsageSeries, type LlmUsageSeries } from '@/api/metrics'
import { useLiveRefresh } from '@/composables/useLiveRefresh'
import { failureOf } from '@/utils/loadState'
import { llmPurposeLabel } from '@/utils/usage'

const RANGES = [
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
]

const days = ref('30')
const data = shallowRef<LlmUsageSeries | undefined>(undefined)
const failure = ref('')
async function load() {
  const asked = days.value
  try {
    const result = await llmUsageSeries(Number(asked))
    if (asked !== days.value) return
    data.value = { days: result.days ?? [], purposes: result.purposes ?? [], series: result.series ?? {}, totals: result.totals ?? [] }
    failure.value = ''
  } catch (err) {
    if (asked === days.value) failure.value = failureOf(err, '读取 AI 用量趋势').message
  }
}
const live = useLiveRefresh({ load, interval: 300_000 })
watch(days, () => {
  data.value = undefined
  failure.value = ''
  void live.refresh('manual')
})

const labels = computed(() => (data.value?.days ?? []).map((day) => day.slice(5)))
const series = computed<LineSeries[]>(() => (data.value?.purposes ?? []).map((purpose) => ({ name: llmPurposeLabel(purpose), values: data.value?.series[purpose] ?? [] })))
const total = computed(() => (data.value?.totals ?? []).reduce((sum, value) => sum + value, 0))
const peak = computed(() => {
  const totals = data.value?.totals ?? []
  const at = totals.indexOf(Math.max(0, ...totals))
  return at >= 0 && totals[at] ? { day: data.value!.days[at]!, tokens: totals[at]! } : null
})
const headline = computed(() => (total.value ? `近 ${days.value} 天共用 ${compactNumber(total.value)}${peak.value ? `,最多的一天是 ${peak.value.day.slice(5)}(${compactNumber(peak.value.tokens)})` : ''}` : ''))
const state = computed<'ready' | 'loading' | 'empty' | 'error'>(() => (failure.value && data.value === undefined ? 'error' : data.value === undefined ? 'loading' : total.value ? 'ready' : 'empty'))
</script>

<template>
  <KbChartCard v-model:range="days" title="AI 用量趋势" :headline="headline" :ranges="RANGES" :state="state" empty-text="这段时间没有用过云端模型。" :error-text="failure" data-testid="llm-trend" @retry="live.refresh('manual')">
    <KbLineChart :labels="labels" :series="series" label="每天的 AI 用量" area="stacked" :format="compactNumber" :height="200" category-label="日期(站点时区)" />
    <template #footer>按用途堆叠;日期按 UTC 算,和每日额度的重置时间一致</template>
  </KbChartCard>
</template>
