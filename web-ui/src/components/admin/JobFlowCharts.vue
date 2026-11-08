<script setup lang="ts">
// 任务随时间的变化(卡 E):吞吐(完成 / 失败 / 取消的堆叠面积)和排队深度(桶末还在排队的任务数)。
// 任务页和系统状态的「任务」页签共用这一个组件;数据是 job_stats 带 range 返回的序列(服务端在 SQL 里分桶,不搬任务行)。
import { computed, ref, shallowRef, watch } from 'vue'
import { siteTimezone } from '@/utils/time'
import { KbChartCard, KbLineChart, formatDuration, timeLabel, type LineSeries } from '@kb-ui/index'
import { jobStats, type JobSeries, type JobSeriesRange } from '@/api/jobs'
import { useLiveRefresh } from '@/composables/useLiveRefresh'
import { failureOf } from '@/utils/loadState'

const props = withDefaults(defineProps<{ excludeKinds?: string[] }>(), { excludeKinds: () => [] })

const RANGES: { value: JobSeriesRange; label: string; text: string }[] = [
  { value: '24h', label: '24 小时', text: '近 24 小时' },
  { value: '7d', label: '7 天', text: '近 7 天' },
  { value: '30d', label: '30 天', text: '近 30 天' },
]
const range = ref<JobSeriesRange>('24h')
/** undefined = 还没读到;null = 读到了但后端没给序列(旧版后端) */
const series = shallowRef<JobSeries | null | undefined>(undefined)
const failure = ref('')
const rangeText = computed(() => RANGES.find((item) => item.value === range.value)?.text ?? '')

async function load() {
  const asked = range.value
  try {
    const result = await jobStats({ range: asked, exclude_kinds: props.excludeKinds })
    if (asked !== range.value) return
    series.value = result.series ?? null
    failure.value = ''
  } catch (err) {
    if (asked === range.value) failure.value = failureOf(err, '读取任务统计').message
  }
}
const live = useLiveRefresh({ load, interval: 30_000 })
watch([range, () => props.excludeKinds.join(',')], () => {
  series.value = undefined
  failure.value = ''
  void live.refresh('manual')
})

const buckets = computed(() => series.value?.buckets ?? [])
/** 横轴标签:24 小时写整点,7 天写「日期 整点」,30 天写日期 */
const labels = computed(() =>
  buckets.value.map((bucket) => (range.value === '24h' ? timeLabel(bucket.at, 'hour', siteTimezone.value).slice(6) : range.value === '7d' ? timeLabel(bucket.at, 'hour', siteTimezone.value) : timeLabel(bucket.at, 'day', siteTimezone.value))),
)
const total = (pick: (bucket: (typeof buckets.value)[number]) => number) => buckets.value.reduce((sum, bucket) => sum + pick(bucket), 0)
const busy = computed(() => total((bucket) => bucket.created + bucket.done + bucket.failed + bucket.canceled) > 0)
const state = computed<'ready' | 'loading' | 'empty' | 'error'>(() => (failure.value && series.value === undefined ? 'error' : series.value === undefined ? 'loading' : busy.value ? 'ready' : 'empty'))

const flowSeries = computed<LineSeries[]>(() => [
  { name: '完成', values: buckets.value.map((bucket) => bucket.done) },
  { name: '失败', values: buckets.value.map((bucket) => bucket.failed), color: 'var(--viz-6)' },
  { name: '取消', values: buckets.value.map((bucket) => bucket.canceled), color: 'var(--viz-other)' },
])
const flowHeadline = computed(() => {
  const done = total((bucket) => bucket.done)
  const failed = total((bucket) => bucket.failed)
  const spans = buckets.value.filter((bucket) => bucket.done > 0 && bucket.avg_ms !== null)
  const weight = spans.reduce((sum, bucket) => sum + bucket.done, 0)
  const avg = weight ? spans.reduce((sum, bucket) => sum + (bucket.avg_ms ?? 0) * bucket.done, 0) / weight : null
  return `${rangeText.value}完成 ${done.toLocaleString()} 个,失败 ${failed.toLocaleString()} 个${avg !== null ? `,平均用时 ${formatDuration(avg)}` : ''}`
})

const depthSeries = computed<LineSeries[]>(() => [{ name: '排队中', values: buckets.value.map((bucket) => bucket.queue_depth) }])
const depthHeadline = computed(() => {
  const now = buckets.value.at(-1)?.queue_depth ?? 0
  const peak = Math.max(0, ...buckets.value.map((bucket) => bucket.queue_depth))
  return now ? `现在排队 ${now} 个,${rangeText.value}最多 ${peak} 个` : `现在没有排队,${rangeText.value}最多 ${peak} 个`
})
</script>

<template>
  <section class="kb-jf" data-testid="job-flow" aria-label="任务趋势">
    <KbChartCard v-model:range="range" title="任务吞吐" :headline="flowHeadline" :ranges="RANGES" :state="state" empty-text="这段时间没有任务,有任务之后这里会显示每个时段完成、失败了多少。" :error-text="failure" data-testid="chart-flow" @retry="live.refresh('manual')">
      <KbLineChart :labels="labels" :series="flowSeries" label="任务吞吐" area="stacked" integer :height="200" />
      <template #footer>每个点是一个时段;悬停看完成 / 失败 / 取消和合计</template>
    </KbChartCard>
    <KbChartCard title="排队深度" :headline="depthHeadline" :state="state" empty-text="这段时间没有任务排过队。" :error-text="failure" data-testid="chart-depth" @retry="live.refresh('manual')">
      <KbLineChart :labels="labels" :series="depthSeries" label="排队深度" area="gradient" integer :floor="0" :height="200" />
      <template #footer>每个点是时段结束时还在排队的任务数;持续升高说明处理不过来</template>
    </KbChartCard>
  </section>
</template>

<style scoped>
.kb-jf { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: var(--gap); min-width: 0; }
</style>
