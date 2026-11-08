<script setup lang="ts">
import { siteTimezone } from '@/utils/time'
// 导入概况(导入页顶部,卡 G):文件现在处于什么状态(环形图)、最近 24 小时每小时进来多少(成功 / 失败 / 其他的堆叠面积)、
// 失败最多的几种原因。数据是 ingest_stats(服务端按状态、按小时在 SQL 里数好)。有任务完成或上传进度时合并后刷新。
import { computed, shallowRef } from 'vue'
import { KbChartCard, KbDonut, KbLineChart, timeLabel, type DonutItem, type LineSeries } from '@kb-ui/index'
import { ingestStats, type IngestStats } from '@/api/metrics'
import { useLiveRefresh } from '@/composables/useLiveRefresh'
import { failureOf } from '@/utils/loadState'
import { ingestStateText } from '@/utils/systemStatus'

const data = shallowRef<IngestStats | undefined>(undefined)
const failure = shallowRef('')

async function load() {
  try {
    const result = await ingestStats(24)
    // 旧后端 / 异常回答缺字段时按空处理,模板里不用处处判断
    data.value = { by_state: result.by_state ?? [], start: result.start ?? 0, step_ms: result.step_ms ?? 3_600_000, buckets: result.buckets ?? [], top_errors: result.top_errors ?? [] }
    failure.value = ''
  } catch (err) {
    failure.value = failureOf(err, '读取导入概况').message
  }
}
const live = useLiveRefresh({ load, interval: 30_000, events: ['job.done', 'upload.progress'] })

/** 状态的颜色:成功绿、失败红、排队黄,处理中的两步用蓝和青,跳过灰、隔离紫 */
const COLORS: Record<string, string> = {
  done: 'var(--viz-2)',
  failed: 'var(--viz-6)',
  queued: 'var(--viz-3)',
  extracting: 'var(--viz-1)',
  chunking: 'var(--viz-1)',
  embedding: 'var(--viz-5)',
  skipped: 'var(--viz-other)',
  quarantined: 'var(--viz-4)',
}
const items = computed<DonutItem[]>(() => (data.value?.by_state ?? []).map((row) => ({ name: ingestStateText(row.state), value: row.count, color: COLORS[row.state] })))
const total = computed(() => items.value.reduce((sum, item) => sum + item.value, 0))

const buckets = computed(() => data.value?.buckets ?? [])
const labels = computed(() => buckets.value.map((bucket) => timeLabel(bucket.at, 'hour', siteTimezone.value).slice(6)))
const series = computed<LineSeries[]>(() => [
  { name: '成功', values: buckets.value.map((bucket) => bucket.done), color: 'var(--viz-2)' },
  { name: '失败', values: buckets.value.map((bucket) => bucket.failed), color: 'var(--viz-6)' },
  { name: '处理中 / 跳过', values: buckets.value.map((bucket) => Math.max(0, bucket.total - bucket.done - bucket.failed)), color: 'var(--viz-3)' },
])
const hourly = computed(() => buckets.value.reduce((sum, bucket) => sum + bucket.total, 0))
const trendHeadline = computed(() => {
  const done = buckets.value.reduce((sum, bucket) => sum + bucket.done, 0)
  const failed = buckets.value.reduce((sum, bucket) => sum + bucket.failed, 0)
  return `近 24 小时进来 ${hourly.value.toLocaleString()} 个文件,成功 ${done.toLocaleString()} 个,失败 ${failed.toLocaleString()} 个`
})
const stateHeadline = computed(() => {
  const failed = data.value?.by_state.find((row) => row.state === 'failed')?.count ?? 0
  const waiting = (data.value?.by_state ?? []).filter((row) => ['queued', 'extracting', 'chunking', 'embedding'].includes(row.state)).reduce((sum, row) => sum + row.count, 0)
  return `共 ${total.value.toLocaleString()} 个文件,${waiting ? `${waiting.toLocaleString()} 个还在处理` : '没有在处理的'},${failed ? `${failed.toLocaleString()} 个失败` : '没有失败的'}`
})

const state = (empty: boolean) => (failure.value && data.value === undefined ? 'error' : data.value === undefined ? 'loading' : empty ? 'empty' : 'ready')
const stateOfStates = computed(() => state(total.value === 0) as 'ready' | 'loading' | 'empty' | 'error')
const stateOfTrend = computed(() => state(hourly.value === 0) as 'ready' | 'loading' | 'empty' | 'error')
</script>

<template>
  <section class="kb-io" data-testid="import-overview" aria-label="导入概况">
    <KbChartCard title="文件状态" :headline="stateHeadline" :state="stateOfStates" empty-text="还没有导入过文件,导入之后这里会显示各状态的文件数。" :error-text="failure" :min-height="140" data-testid="chart-ingest-states" @retry="live.refresh('manual')">
      <KbDonut :items="items" label="各状态的文件数" :size="112" caption="文件" />
      <template v-if="data?.top_errors.length" #footer>
        <div class="kb-io-errors" data-testid="ingest-top-errors">
          <b>失败最多的原因</b>
          <ul>
            <li v-for="row in data.top_errors" :key="row.error"><span>{{ row.error }}</span><span class="mono">× {{ row.count }}</span></li>
          </ul>
        </div>
      </template>
    </KbChartCard>
    <KbChartCard title="每小时导入" :headline="trendHeadline" :state="stateOfTrend" empty-text="最近 24 小时没有文件进来。" :error-text="failure" :min-height="140" data-testid="chart-ingest-hourly" @retry="live.refresh('manual')">
      <KbLineChart :labels="labels" :series="series" label="每小时导入的文件" area="stacked" integer :height="170" category-label="时间" />
    </KbChartCard>
  </section>
</template>

<style scoped>
.kb-io { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: var(--gap); min-width: 0; }
.kb-io-errors { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
.kb-io-errors ul { margin: 0; padding: 0; list-style: none; }
.kb-io-errors li { display: flex; justify-content: space-between; gap: var(--sp-3); min-width: 0; }
.kb-io-errors li > span:first-child { min-width: 0; overflow-wrap: anywhere; }
</style>
