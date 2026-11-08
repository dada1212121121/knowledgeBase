<script setup lang="ts">
// 系统状态 · 资源页签的曲线区(卡 E):处理器、内存、磁盘、本服务进程四张图,共用一个时间范围。
// 数据是 metrics_series(守护进程每 10 秒采一次、每分钟落一行);1 小时的图每 10 秒刷新并带「现在」光圈,更长的每分钟刷新。
// 刚部署或刚重启时库里还没有历史:24 小时以上的图写一句「采样刚开始」,不画一条孤零零的点。
import { computed, ref, shallowRef, watch } from 'vue'
import { KbChartCard, KbLineChart, KbSegmented, formatBytes, formatPercent, timeLabels, type LineSeries } from '@kb-ui/index'
import { siteTimezone } from '@/utils/time'
import { diskFullIn, metricsSeries, type MetricsRange, type MetricsSeries } from '@/api/metrics'
import { useLiveRefresh } from '@/composables/useLiveRefresh'
import { failureOf } from '@/utils/loadState'

const RANGES: { value: MetricsRange; label: string; text: string }[] = [
  { value: '1h', label: '1 小时', text: '过去 1 小时' },
  { value: '24h', label: '24 小时', text: '过去 24 小时' },
  { value: '7d', label: '7 天', text: '过去 7 天' },
  { value: '30d', label: '30 天', text: '过去 30 天' },
]
const range = ref<MetricsRange>('1h')
const data = shallowRef<MetricsSeries | null>(null)
const failure = ref('')
const rangeText = computed(() => RANGES.find((item) => item.value === range.value)?.text ?? '')

async function load() {
  const asked = range.value
  try {
    const result = await metricsSeries(asked)
    if (asked !== range.value) return
    data.value = result
    failure.value = ''
  } catch (err) {
    if (asked === range.value) failure.value = failureOf(err, '读取资源曲线').message
  }
}
const live = useLiveRefresh({ load, interval: () => (range.value === '1h' ? 10_000 : 60_000) })
watch(range, () => {
  data.value = null
  failure.value = ''
  void live.refresh('manual')
})

const points = computed(() => data.value?.points ?? [])
const labels = computed(() => timeLabels(points.value.map((point) => point.at), siteTimezone.value))
/** 有至少两个点才画线;刚开始采样时 24 小时以上的图是空的 */
const enough = computed(() => points.value.length >= 2)
const state = computed<'ready' | 'loading' | 'empty' | 'error'>(() => (failure.value && !data.value ? 'error' : !data.value ? 'loading' : enough.value ? 'ready' : 'empty'))
const emptyText = computed(() => (range.value === '1h' ? '采样刚开始,约 20 秒后这里出现曲线。' : '采样刚开始,几分钟后这里会出现曲线;更长的范围要攒够时间。'))
const live1h = computed(() => range.value === '1h')
const last = computed(() => data.value?.now ?? points.value.at(-1) ?? null)

const peak = (pick: (point: (typeof points.value)[number]) => number) => Math.max(0, ...points.value.map(pick))

const cpuSeries = computed<LineSeries[]>(() => {
  const list: LineSeries[] = [{ name: '处理器', values: points.value.map((point) => point.cpu) }]
  // 1 小时是 10 秒一个点,本身就是瞬时值;更长的范围每个点是平均,另画一条桶内峰值,尖峰才不会被抹平
  if (!live1h.value) list.push({ name: '峰值', values: points.value.map((point) => point.cpu_max), color: 'var(--viz-3)' })
  return list
})
const cpuHeadline = computed(() => (last.value ? `现在 ${formatPercent(last.value.cpu)},${rangeText.value}峰值 ${formatPercent(peak((point) => point.cpu_max))},共 ${data.value?.cores ?? '—'} 核` : ''))

const memorySeries = computed<LineSeries[]>(() => [
  { name: '已用内存', values: points.value.map((point) => gb(point.mem_used)) },
  { name: '本服务', values: points.value.map((point) => gb(point.proc_rss)), color: 'var(--viz-5)' },
])
const memoryHeadline = computed(() => {
  const now = last.value
  if (!now) return ''
  return `已用 ${formatBytes(now.mem_used)} / ${formatBytes(now.mem_total)}(${formatPercent(now.mem_total ? now.mem_used / now.mem_total : 0)}),本服务占 ${formatBytes(now.proc_rss)}`
})

const diskSeries = computed<LineSeries[]>(() => [{ name: '磁盘已用', values: points.value.map((point) => gb(point.disk_used)) }])
const diskHeadline = computed(() => {
  const now = last.value
  if (!now) return ''
  const base = `已用 ${formatBytes(now.disk_used)} / ${formatBytes(now.disk_total)}(${formatPercent(now.disk_total ? now.disk_used / now.disk_total : 0)})`
  // 增长速度要看足够长的数据:7 天和 30 天的图才给「预计写满」
  const left = range.value === '7d' || range.value === '30d' ? diskFullIn(points.value) : null
  if (left === null) return base
  const days = left / 86_400_000
  return `${base},按这段时间的增长速度${days < 1 ? '不到 1 天' : `约 ${Math.round(days)} 天`}后写满`
})

const procSeries = computed<LineSeries[]>(() => [{ name: '本服务处理器', values: points.value.map((point) => point.proc_cpu) }])
const procHeadline = computed(() => (last.value ? `本服务现在占整机处理器的 ${formatPercent(last.value.proc_cpu, 1)},${rangeText.value}峰值 ${formatPercent(peak((point) => point.proc_cpu), 1)}` : ''))

/** 内存和磁盘按 GB 画:纵轴刻度按十进制取整(0 / 20 / 40 / 60),按字节画再格式化会出现 19 GB、37 GB 这种刻度 */
const GB = 1024 ** 3
const gb = (bytes: number) => bytes / GB
const gbText = (value: number) => (value >= 10 ? `${Math.round(value)} GB` : `${Math.round(value * 10) / 10} GB`)
const pct0 = (value: number) => formatPercent(value)
const pct1 = (value: number) => formatPercent(value, 1)
</script>

<template>
  <section class="kb-rc" data-testid="resource-charts" aria-label="资源曲线">
    <div class="kb-rc-bar">
      <KbSegmented v-model="range" :options="RANGES" />
      <span v-if="live1h" class="m kb-rc-note">每 10 秒一个点,实时刷新</span>
      <span v-else class="m kb-rc-note">每分钟记一次,曲线按时间段取平均</span>
    </div>
    <div class="kb-rc-grid">
      <KbChartCard title="处理器使用率" :headline="cpuHeadline" :state="state" :empty-text="emptyText" :error-text="failure" data-testid="chart-cpu" @retry="live.refresh('manual')">
        <KbLineChart :labels="labels" :series="cpuSeries" label="处理器使用率" area="gradient" :live="live1h" :floor="0" :ceil="1" :format="pct0" :height="190" />
      </KbChartCard>
      <KbChartCard title="内存" :headline="memoryHeadline" :state="state" :empty-text="emptyText" :error-text="failure" data-testid="chart-memory" @retry="live.refresh('manual')">
        <KbLineChart :labels="labels" :series="memorySeries" label="内存使用量" area="gradient" :live="live1h" :floor="0" :format="gbText" :height="190" />
      </KbChartCard>
      <KbChartCard title="磁盘" :headline="diskHeadline" :state="state" :empty-text="emptyText" :error-text="failure" data-testid="chart-disk" @retry="live.refresh('manual')">
        <KbLineChart :labels="labels" :series="diskSeries" label="磁盘使用量" area="gradient" :format="gbText" :height="190" />
      </KbChartCard>
      <KbChartCard title="本服务占用" :headline="procHeadline" :state="state" :empty-text="emptyText" :error-text="failure" data-testid="chart-proc" @retry="live.refresh('manual')">
        <KbLineChart :labels="labels" :series="procSeries" label="本服务处理器占用" area="gradient" :live="live1h" :floor="0" :format="pct1" :height="190" />
      </KbChartCard>
    </div>
  </section>
</template>

<style scoped>
.kb-rc { display: flex; flex-direction: column; gap: var(--gap); min-width: 0; }
.kb-rc-bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); }
.kb-rc-note { font-size: var(--text-12); }
.kb-rc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: var(--gap); min-width: 0; }
</style>
