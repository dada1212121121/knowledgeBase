<script setup lang="ts">
// 审核收件箱顶部的「审核结果」(卡 H):草稿现在各处于什么状态(环形图),通过率写在结论里。
// 数据是收件箱列表本来就带回来的各状态数量(counts),不另外请求。
// 通过率 = (已通过 + 修订通过) / 已经有结论的(通过 + 修订通过 + 驳回 + 重复);待审的不算,没人看过就谈不上通过。
import { computed } from 'vue'
import { KbChartCard, KbDonut, type DonutItem } from '@kb-ui/index'
import { stateText } from '@/utils/review'

const props = defineProps<{ counts: Record<string, number>; loading?: boolean }>()

const COLORS: Record<string, string> = { pending: 'var(--viz-3)', approved: 'var(--viz-2)', revised: 'var(--viz-1)', rejected: 'var(--viz-6)', duplicate: 'var(--viz-other)' }
const ORDER = ['approved', 'revised', 'pending', 'rejected', 'duplicate']
const count = (state: string) => Math.max(0, Number(props.counts[state]) || 0)
const items = computed<DonutItem[]>(() => ORDER.filter((key) => count(key) > 0).map((key) => ({ name: stateText(key), value: count(key), color: COLORS[key] })))
const total = computed(() => items.value.reduce((sum, item) => sum + item.value, 0))
const headline = computed(() => {
  const passed = count('approved') + count('revised')
  const decided = passed + count('rejected') + count('duplicate')
  const rate = decided ? `通过率 ${Math.round((passed / decided) * 100)}%` : '还没有审过的'
  return `共 ${total.value.toLocaleString()} 条候选笔记,${count('pending') ? `${count('pending').toLocaleString()} 条待审` : '没有待审的'},${rate}`
})
const state = computed<'ready' | 'loading' | 'empty'>(() => (props.loading && !total.value ? 'loading' : total.value ? 'ready' : 'empty'))
</script>

<template>
  <KbChartCard title="审核结果" :headline="headline" :state="state" empty-text="还没有候选笔记,自动提炼出来之后这里会显示审核情况。" :min-height="120" data-testid="draft-stats">
    <KbDonut :items="items" label="候选笔记按状态的数量" :size="104" caption="候选" />
  </KbChartCard>
</template>
