<script setup lang="ts">
// 「按反馈调整权重」:搜索结果上点的「有用 / 无用」攒成反馈,按每个集合的有用率给出融合排序的权重建议。
// 先预演(不改任何设置),看过建议再应用;应用前后各跑一次评测,得分下降自动回滚。
//   - 还没预演过:一句说明 + 「预演」按钮(空状态给下一步);预演 / 应用失败的原因常驻在卡片里;
//   - 建议表用响应式表格(手机变卡片);分组统计和被跳过的原因折在「细节」里。
import { computed, ref } from 'vue'
import { KbBadge, KbButton, KbCard, KbEmpty, KbResponsiveTable, useConfirm, type RtColumn } from '@kb-ui/index'
import { callCapability } from '@/api/client'
import { actionFailure } from '@/utils/actionFailure'
import { applyOutcome, deltaText, percent, tuneSummary, weightText, type TuneResult, type WeightSuggestion } from '@/utils/settingsTune'

type Row = WeightSuggestion & Record<string, unknown>

const confirm = useConfirm()
const result = ref<TuneResult | null>(null)
const running = ref(false)
const error = ref('')

async function preview() {
  running.value = true
  error.value = ''
  try {
    result.value = await callCapability<TuneResult>('tune_retrieval', { dry_run: true, confirm: true })
  } catch (err) {
    error.value = actionFailure('预演', err)
  } finally {
    running.value = false
  }
}

/**
 * 应用建议。失败 / 被回滚时**向上抛**:确认框的 `action` 靠 reject 才会显示失败,
 * 否则会出现“提示已回滚、确认框却写着 ✓ 已应用”。
 */
async function apply() {
  const count = result.value?.suggestions.length ?? 0
  error.value = ''
  await confirm.ask({
    title: `应用 ${count} 条权重建议?`,
    message: '会写入 search.collection_weights 并立即生效;应用前后各跑一次评测,得分下降会自动回滚。',
    confirmText: '应用',
    doneText: '已应用',
    action: async () => {
      const applied = await callCapability<TuneResult>('tune_retrieval', { dry_run: false, confirm: true })
      result.value = applied
      if (applied.rolled_back) throw new Error('应用后评测得分下降,已自动回滚,权重没有改变')
      return applied.applied ? '权重已应用并立即生效' : '权重没有变化'
    },
  })
}

const columns: RtColumn[] = [
  { key: 'collection', label: '集合', mobile: 'primary' },
  { key: 'rate', label: '有用率' },
  { key: 'weight', label: '权重' },
  { key: 'delta', label: '调整' },
  { key: 'reason', label: '理由' },
]
const rows = computed(() => (result.value?.suggestions ?? []) as Row[])
const outcome = computed(() => (result.value ? applyOutcome(result.value) : null))
const canApply = computed(() => rows.value.length > 0 && !running.value && result.value?.applied !== true)
const hasDetails = computed(() => !!result.value && (result.value.skipped.length > 0 || result.value.groups.length > 0))
</script>

<template>
  <KbCard title="按反馈调整权重" class="kb-st-card" data-testid="tune-card">
    <p class="kb-st-note">
      根据你在搜索结果上点的「有用 / 无用」,算出每个集合在合并排序时该占多大权重。规则:样本不少于 5 条才给建议;单次调整不超过 ±0.2;幅度小于 0.05 算噪声不调。
      应用后写入 <code class="kb-mono kb-st-key">search.collection_weights</code>,立即生效。
    </p>

    <KbEmpty v-if="!result && !error" size="sm" icon="chart" title="还没有预演过" description="先预演一次看看建议。预演不会改任何设置。">
      <template #action><KbButton variant="primary" :disabled="running" data-testid="tune-preview" @click="preview">{{ running ? '计算中…' : '预演' }}</KbButton></template>
    </KbEmpty>

    <template v-else>
      <div class="kb-st-key-form">
        <KbButton :disabled="running" data-testid="tune-preview" @click="preview">{{ running ? '计算中…' : '重新预演' }}</KbButton>
        <KbButton variant="primary" :disabled="!canApply" data-testid="tune-apply" @click="apply">应用建议</KbButton>
        <span v-if="result" class="kb-hint kb-st-key-hint" data-testid="tune-summary">{{ tuneSummary(result) }}</span>
      </div>
      <p v-if="error" class="kb-st-inline-error" role="alert" data-testid="tune-error">{{ error }}</p>

      <KbResponsiveTable v-if="result" :columns="columns" :rows="rows" row-key="collection" empty="没有需要调整的集合(样本不足,或幅度太小)">
        <template #cell-collection="{ row }"><span class="kb-mono kb-st-block">{{ (row as Row).collection }}</span></template>
        <template #cell-rate="{ row }"><span class="kb-hint">{{ percent((row as Row).useful_rate) }}(样本 {{ (row as Row).samples }} 条)</span></template>
        <template #cell-weight="{ row }"><span class="kb-mono">{{ weightText(row as Row) }}</span></template>
        <template #cell-delta="{ row }"><KbBadge :tone="(row as Row).delta > 0 ? 'success' : 'danger'" class="kb-st-nowrap">{{ deltaText((row as Row).delta) }}</KbBadge></template>
        <template #cell-reason="{ row }"><span class="kb-hint kb-st-block">{{ (row as Row).reason }}</span></template>
      </KbResponsiveTable>

      <div v-if="outcome" class="kb-st-key-form" data-testid="tune-outcome">
        <KbBadge :tone="outcome.tone" class="kb-st-nowrap">{{ outcome.label }}</KbBadge>
        <span class="kb-hint kb-st-key-hint">{{ outcome.detail }}</span>
      </div>
      <p v-for="note in result?.notes ?? []" :key="note" class="kb-hint">{{ note }}</p>

      <details v-if="hasDetails" class="kb-st-details" data-testid="tune-details">
        <summary>细节:分组统计与被跳过的原因</summary>
        <ul class="kb-st-list">
          <li v-for="reason in result!.skipped" :key="reason" class="kb-hint">{{ reason }}</li>
          <li v-for="group in result!.groups.slice(0, 12)" :key="`${group.collection}-${group.kind}-${group.prefix}`" class="kb-st-mirror">
            <span class="kb-mono kb-hint kb-st-block">{{ group.collection }}</span>
            <KbBadge class="kb-st-nowrap">{{ group.kind }}</KbBadge>
            <span v-if="group.prefix" class="kb-mono kb-hint kb-st-block">{{ group.prefix }}</span>
            <span class="kb-hint">{{ group.useful }}/{{ group.total }} 有用({{ percent(group.rate) }})</span>
          </li>
        </ul>
      </details>
    </template>
  </KbCard>
</template>
