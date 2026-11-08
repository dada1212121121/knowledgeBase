<script setup lang="ts">
// 审计页顶部的两张图(卡 H):什么时候调用最多(周几 × 几点的热力),哪些操作用得最多(横条,失败的单独着色)。
// 数据是 audit_stats:服务端在 SQL 里数好,并且不含页面自动刷新用的读取(它们的次数只反映页面开了多久)。
import { computed, ref, shallowRef, watch } from 'vue'
import { KbChartCard, KbHBars, KbHeatGrid, type HBarRow } from '@kb-ui/index'
import { auditStats, type AuditStats } from '@/api/metrics'
import { useLiveRefresh } from '@/composables/useLiveRefresh'
import { capabilityText } from '@/utils/auditText'
import { failureOf } from '@/utils/loadState'

const RANGES = [
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
]
const days = ref('30')
const data = shallowRef<AuditStats | undefined>(undefined)
const failure = shallowRef('')

async function load() {
  const asked = days.value
  try {
    const result = await auditStats(Number(asked))
    if (asked !== days.value) return
    // 旧后端 / 异常回答缺字段时按空处理
    data.value = { days: result.days ?? Number(asked), heat: result.heat ?? [], top: result.top ?? [], total: result.total ?? 0, failed: result.failed ?? 0 }
    failure.value = ''
  } catch (err) {
    if (asked === days.value) failure.value = failureOf(err, '读取审计概况').message
  }
}
const live = useLiveRefresh({ load, interval: 60_000 })
watch(days, () => {
  data.value = undefined
  failure.value = ''
  void live.refresh('manual')
})

const ROWS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const COLS = Array.from({ length: 24 }, (_, hour) => String(hour))

const total = computed(() => data.value?.total ?? 0)
const state = computed<'ready' | 'loading' | 'empty' | 'error'>(() => (failure.value && data.value === undefined ? 'error' : data.value === undefined ? 'loading' : total.value === 0 ? 'empty' : 'ready'))

/** 最忙的那个钟点,写进结论里,图是装饰,结论才是读屏用户听到的 */
const busiest = computed(() => {
  let best = { row: -1, col: -1, value: 0 }
  ;(data.value?.heat ?? []).forEach((line, row) => line.forEach((value, col) => value > best.value && (best = { row, col, value })))
  return best.row < 0 ? '' : `最忙的是${ROWS[best.row]} ${best.col} 点`
})
const heatHeadline = computed(() => (total.value ? `近 ${days.value} 天共 ${total.value.toLocaleString()} 次操作,${busiest.value}` : ''))
const rows = computed<HBarRow[]>(() =>
  (data.value?.top ?? []).map((row) => ({
    key: row.capability,
    label: capabilityText(row.capability),
    segments: [
      { name: '成功', value: Math.max(0, row.count - row.failed), color: 'var(--viz-2)' },
      { name: '失败', value: row.failed, color: 'var(--viz-6)' },
    ].filter((segment) => segment.value > 0),
    totalText: row.count.toLocaleString(),
  })),
)
const topHeadline = computed(() => {
  const failed = data.value?.failed ?? 0
  return total.value ? `${failed ? `其中 ${failed.toLocaleString()} 次失败` : '没有失败的'},次数最多的是「${capabilityText(data.value?.top[0]?.capability ?? '')}」` : ''
})
</script>

<template>
  <section class="kb-au" data-testid="audit-stats" aria-label="审计概况">
    <KbChartCard v-model:range="days" title="什么时候用得最多" :headline="heatHeadline" :ranges="RANGES" :state="state" empty-text="这段时间还没有操作记录" @retry="live.refresh('manual')">
      <KbHeatGrid :rows="ROWS" :cols="COLS" :values="data?.heat ?? []" label="按周几和几点统计的操作次数" unit="次" :col-every="3" />
    </KbChartCard>
    <KbChartCard title="用得最多的操作" :headline="topHeadline" :state="state" empty-text="这段时间还没有操作记录" @retry="live.refresh('manual')">
      <KbHBars :rows="rows" label="用得最多的操作" legend />
    </KbChartCard>
  </section>
</template>

<style scoped>
.kb-au { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: var(--gap); min-width: 0; }
</style>
