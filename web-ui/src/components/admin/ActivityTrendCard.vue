<script setup lang="ts">
// 活动趋势(系统概览,卡 F):最近 7 / 30 / 90 天每天的新建笔记、编辑、导入文件、搜索,堆叠面积(顺序与颜色和首页活动卡一致)。
// 数据是 activity_series(当前知识库,服务端按天归桶);结论写这段时间的合计。
import { computed, ref, shallowRef, watch } from 'vue'
import { KbChartCard, KbLineChart, type LineSeries } from '@kb-ui/index'
import { activitySeries, type ActivitySeries } from '@/api/metrics'
import { useLiveRefresh } from '@/composables/useLiveRefresh'
import { failureOf } from '@/utils/loadState'

const RANGES = [
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
]
const days = ref('30')
const data = shallowRef<ActivitySeries | null | undefined>(undefined)
const failure = ref('')

async function load() {
  const asked = days.value
  try {
    const result = await activitySeries(Number(asked))
    if (asked !== days.value) return
    data.value = result
    failure.value = ''
  } catch (err) {
    if (asked === days.value) failure.value = failureOf(err, '读取活动趋势').message
  }
}
// 按天的数据变化很慢:五分钟看一次就够
const live = useLiveRefresh({ load, interval: 300_000 })
watch(days, () => {
  data.value = undefined
  failure.value = ''
  void live.refresh('manual')
})

const sum = (list: number[] | undefined) => (list ?? []).reduce((total, value) => total + value, 0)
const labels = computed(() => (data.value?.days ?? []).map((day) => day.slice(5)))
const series = computed<LineSeries[]>(() => [
  { name: '新建笔记', values: data.value?.notes ?? [] },
  { name: '编辑', values: data.value?.edits ?? [] },
  { name: '导入文件', values: data.value?.imports ?? [] },
  { name: '搜索', values: data.value?.searches ?? [] },
])
const quiet = computed(() => sum(data.value?.notes) + sum(data.value?.edits) + sum(data.value?.imports) + sum(data.value?.searches) === 0)
const state = computed<'ready' | 'loading' | 'empty' | 'error'>(() => (failure.value && data.value === undefined ? 'error' : data.value === undefined ? 'loading' : quiet.value ? 'empty' : 'ready'))
const headline = computed(() => `近 ${days.value} 天:新建 ${sum(data.value?.notes).toLocaleString()} 条笔记,编辑 ${sum(data.value?.edits).toLocaleString()} 次,导入 ${sum(data.value?.imports).toLocaleString()} 个文件,搜索 ${sum(data.value?.searches).toLocaleString()} 次`)
</script>

<template>
  <KbChartCard v-model:range="days" title="活动趋势" :headline="headline" :ranges="RANGES" :state="state" empty-text="这段时间还没有活动,有了之后这里会显示每天的新建、编辑、导入和搜索。" :error-text="failure" data-testid="activity-trend" @retry="live.refresh('manual')">
    <KbLineChart :labels="labels" :series="series" label="每天的活动" area="stacked" integer :height="220" category-label="日期" />
    <template #footer>每个点是一天;悬停看当天每一类和合计</template>
  </KbChartCard>
</template>
