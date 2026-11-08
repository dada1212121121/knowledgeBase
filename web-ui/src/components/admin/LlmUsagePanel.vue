<script setup lang="ts">
// AI 额度排行(管理组「存储与用量」的一页):按站点时区的日期看每个人用了多少内置模型的额度,和他每天的额度上限比。
// 数据来自 llm_usage_overview(功能点 sys.ops)。只有数字,看不到任何人问了什么。
import LlmTrendCard from '@/components/admin/LlmTrendCard.vue'
import { computed, ref } from 'vue'
import { KbBadge, KbButton, KbEmpty, KbResponsiveTable, KbStat, useToast, type RtColumn } from '@kb-ui/index'
import AdminLoadState from '@/components/admin/AdminLoadState.vue'
import UsageBar from '@/components/admin/UsageBar.vue'
import { llmUsageOverview } from '@/api/usage'
import { useLoadState } from '@/composables/useLoadState'
import { isDay, levelOf, llmAlertCounts, llmOwnerName, percentText, quotaText, shiftDay, siteDay, tokensText } from '@/utils/usage'
import { timezoneLabel } from '@/utils/time'

const toast = useToast()
/** 空 = 今天(由后端按站点时区算);选了日期就带上 */
const day = ref('')
const draft = ref('')
const dayError = ref('')
const { phase, data, message, reload } = useLoadState(() => llmUsageOverview(day.value || undefined), '读取额度用量', (text) => toast.push(text, 'warning'))
void reload()

const rows = computed(() => data.value?.ranking ?? [])
const counts = computed(() => llmAlertCounts(rows.value))
const today = siteDay(Date.now())
const shownDay = computed(() => data.value?.day ?? (day.value || today))

function pick(next: string) {
  if (!isDay(next)) {
    dayError.value = '日期格式不对,请选一个存在的日期。'
    return
  }
  dayError.value = ''
  draft.value = next
  day.value = next
  void reload()
}
const step = (delta: number) => pick(shiftDay(shownDay.value, delta))
const columns: RtColumn[] = [
  { key: 'owner', label: '用户', mobile: 'primary' },
  { key: 'usage', label: '今日额度' },
  { key: 'input_tokens', label: '输入', align: 'right' },
  { key: 'output_tokens', label: '输出', align: 'right' },
  { key: 'calls', label: '次数', align: 'right' },
]
const badge = (used: number, limit: number) => {
  const level = levelOf(used, limit)
  return level === 'over' ? { tone: 'danger' as const, text: '已超额' } : level === 'warn' ? { tone: 'warning' as const, text: '接近上限' } : null
}
</script>

<template>
  <div class="kb-su" data-testid="llm-panel">
    <LlmTrendCard />
    <div class="kb-su-bar" role="group" aria-label="选择日期">
      <KbButton aria-label="前一天" data-testid="llm-prev" @click="step(-1)">‹ 前一天</KbButton>
      <input
        class="kb-input kb-lu-date"
        type="date"
        :value="draft || shownDay"
        :max="today"
        aria-label="日期(站点时区)"
        data-testid="llm-day"
        @change="pick(($event.target as HTMLInputElement).value)"
      />
      <KbButton aria-label="后一天" :disabled="shownDay >= today" data-testid="llm-next" @click="step(1)">后一天 ›</KbButton>
      <KbButton class="kb-su-refresh" @click="reload({ quiet: true })">刷新</KbButton>
    </div>
    <p class="m kb-small kb-su-foot" data-testid="llm-day-hint">日期按站点时区({{ timezoneLabel() }})计,每天 0 点重置额度。输入是发给模型的内容量,输出是模型回复的内容量,两者之和就是已用额度。</p>
    <p v-if="dayError" class="kb-su-alert is-warn" role="alert" data-testid="llm-day-error">{{ dayError }}</p>

    <AdminLoadState v-if="phase !== 'ready' || !data" :phase="phase" :message="message" @retry="reload()" />

    <template v-else>
      <div v-if="counts.over || counts.warn" class="kb-su-alert is-warn" role="status" data-testid="llm-alert">
        <b>{{ counts.over ? `${counts.over} 位用户已超出当天额度` : '' }}{{ counts.over && counts.warn ? ',' : '' }}{{ counts.warn ? `${counts.warn} 位用了 90% 以上` : '' }}</b>
        <span>超额的人当天不能再用内置模型,第二天 0 点(站点时区)自动恢复。可以在用户详情里给他单独调高额度。</span>
      </div>

      <div class="kb-su-stats kb-lu-stats">
        <KbStat label="榜内合计用量" :value="tokensText(data.total_tokens)" :delta="`${shownDay} · 只统计榜内 ${counts.users} 人`" />
        <KbStat label="用过的人" :value="`${counts.users} 人`" delta="当天有调用的账号" />
        <KbStat label="需要关注" :value="`${counts.over + counts.warn} 人`" :delta="`${counts.over} 人超额 · ${counts.warn} 人接近上限`" :tone="counts.over ? 'danger' : counts.warn ? 'warning' : 'neutral'" />
      </div>

      <KbEmpty
        v-if="!rows.length"
        class="card"
        icon="database"
        title="这一天没有人用过内置模型"
        description="提炼、审核、深度检索、AI 助手的调用都会计入。换一天看看,或者确认模型已经配置。"
        data-testid="llm-empty"
      >
        <template #action><KbButton variant="primary" @click="pick(today)">回到今天</KbButton></template>
      </KbEmpty>

      <div v-else class="card kb-su-table">
        <KbResponsiveTable :columns="columns" :rows="rows" row-key="user_id" cards="auto" empty="没有数据">
          <template #cell-owner="{ row }">
            <div class="kb-su-owner">
              <b>{{ llmOwnerName(row) }}</b>
              <small class="m">{{ row.username ? `@${row.username}` : '' }}</small>
            </div>
          </template>
          <template #cell-usage="{ row }">
            <div class="kb-su-usage">
              <UsageBar :used="row.tokens" :limit="row.limit" :name="`${llmOwnerName(row)} 的 AI 额度`" />
              <div class="kb-su-usage-text">
                <span class="mono">{{ quotaText(row.tokens, row.limit) }}</span>
                <b v-if="row.limit > 0">{{ percentText(row.tokens, row.limit) }}</b>
                <KbBadge v-if="badge(row.tokens, row.limit)" :tone="badge(row.tokens, row.limit)!.tone">{{ badge(row.tokens, row.limit)!.text }}</KbBadge>
              </div>
            </div>
          </template>
          <template #cell-input_tokens="{ row }"><span class="mono">{{ tokensText(row.input_tokens) }}</span></template>
          <template #cell-output_tokens="{ row }"><span class="mono">{{ tokensText(row.output_tokens) }}</span></template>
          <template #cell-calls="{ row }"><span class="mono">{{ row.calls }}</span></template>

          <template #card="{ row }">
            <div class="kb-su-card" data-testid="llm-card">
              <div class="kb-su-card-head">
                <div class="kb-su-owner">
                  <b>{{ llmOwnerName(row) }}</b>
                  <small class="m">{{ row.username ? `@${row.username}` : '' }}</small>
                </div>
                <KbBadge v-if="badge(row.tokens, row.limit)" :tone="badge(row.tokens, row.limit)!.tone">{{ badge(row.tokens, row.limit)!.text }}</KbBadge>
              </div>
              <UsageBar :used="row.tokens" :limit="row.limit" :name="`${llmOwnerName(row)} 的 AI 额度`" />
              <div class="kb-su-usage-text">
                <span class="mono">{{ quotaText(row.tokens, row.limit) }}</span>
                <b v-if="row.limit > 0">{{ percentText(row.tokens, row.limit) }}</b>
              </div>
              <dl class="kb-su-parts">
                <div><dt>输入</dt><dd class="mono">{{ tokensText(row.input_tokens) }}</dd></div>
                <div><dt>输出</dt><dd class="mono">{{ tokensText(row.output_tokens) }}</dd></div>
                <div><dt>次数</dt><dd class="mono">{{ row.calls }}</dd></div>
              </dl>
            </div>
          </template>
        </KbResponsiveTable>
      </div>
      <p v-if="rows.length >= 100" class="m kb-small kb-su-foot">榜单最多列 100 人;合计只算榜内的人。</p>
    </template>
  </div>
</template>

<style>
.kb-lu-date{width:11em;max-width:100%}
.kb-lu-stats{grid-template-columns:repeat(3,minmax(0,1fr))}
@media (max-width:599px){.kb-lu-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.kb-lu-stats > :first-child{grid-column:span 2}}
</style>
