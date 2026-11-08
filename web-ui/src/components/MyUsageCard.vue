<script setup lang="ts">
// 我的用量(个人设置里的一张卡片):我的存储占了多少、今天用了多少 AI token。数据来自 usage_mine,只有我自己的。
// 超额时说清后果和出路:存储超额不能再上传 / 新建,AI 超额当天不能再用,站点时区 0 点恢复。
import { computed } from 'vue'
import { KbBadge, KbButton, KbCard, KbSkeleton, useToast } from '@kb-ui/index'
import UsageBar from '@/components/admin/UsageBar.vue'
import { usageMine } from '@/api/usage'
import { useSessionStore } from '@/stores/session'
import { useLoadState } from '@/composables/useLoadState'
import { PART_LABELS, formatBytes, levelOf, partsOf, percentText, quotaText } from '@/utils/usage'
import { timezoneLabel } from '@/utils/time'

const toast = useToast()
// AI 总开关关掉后,界面任何位置都不出现「AI」字样(术语表设计规范):今日 AI 额度整块不显示,存储照常
const aiOn = computed(() => useSessionStore().aiEnabled)
// 存储明细里的「代理工作目录」是助手功能的占用:AI 关掉后用户看不到助手,再出现这个词只会困惑;但它计入总量和配额,
// 整行删掉会让明细加起来对不上,所以换成中性的「其它」
const partLabels = computed(() =>
  PART_LABELS.map((part) => (part.key === 'workspace' && !aiOn.value ? { ...part, label: '其它', hint: '不属于笔记、原件和索引的其它占用' } : part)),
)
const { phase, data, message, reload } = useLoadState(() => usageMine(), '读取我的用量', (text) => toast.push(text, 'warning'))
void reload()

const storageLevel = computed(() => (data.value ? levelOf(data.value.storage.total_bytes, data.value.storage.limit_bytes) : 'ok'))
const aiLevel = computed(() => (data.value ? levelOf(data.value.ai.tokens_today, data.value.ai.limit) : 'ok'))
const badge = (level: string) => (level === 'over' ? { tone: 'danger' as const, text: '已超额' } : level === 'warn' ? { tone: 'warning' as const, text: '接近上限' } : null)
</script>

<template>
  <KbCard class="kb-me-card" aria-labelledby="me-usage" data-testid="my-usage">
    <header class="kb-me-head"><b id="me-usage">我的用量</b></header>

    <div v-if="phase === 'loading'" class="kb-me-pad" data-testid="my-usage-loading"><KbSkeleton variant="lines" :lines="3" /></div>
    <div v-else-if="phase !== 'ready' || !data" class="kb-me-pad" role="alert" data-testid="my-usage-error">
      <p class="kb-me-bad">{{ message }}</p>
      <KbButton size="sm" @click="reload()">重试</KbButton>
    </div>

    <div v-else class="kb-mu">
      <section class="kb-mu-block" aria-labelledby="mu-storage">
        <div class="kb-mu-top">
          <b id="mu-storage">存储</b>
          <KbBadge v-if="badge(storageLevel)" :tone="badge(storageLevel)!.tone">{{ badge(storageLevel)!.text }}</KbBadge>
        </div>
        <UsageBar :used="data.storage.total_bytes" :limit="data.storage.limit_bytes" name="我的存储" />
        <div class="kb-mu-line">
          <span class="mono">{{ formatBytes(data.storage.total_bytes) }} / {{ data.storage.limit_bytes > 0 ? formatBytes(data.storage.limit_bytes) : '不限' }}</span>
          <b v-if="data.storage.limit_bytes > 0">{{ percentText(data.storage.total_bytes, data.storage.limit_bytes) }}</b>
        </div>
        <dl class="kb-mu-parts">
          <div v-for="part in partLabels" :key="part.key">
            <dt :title="part.hint">{{ part.label }}</dt>
            <dd class="mono">{{ formatBytes(partsOf(data.storage)[part.key]) }}</dd>
          </div>
        </dl>
        <p v-if="storageLevel === 'over'" class="kb-me-bad" role="status" data-testid="my-usage-storage-over">
          存储已经超出配额:现在不能再上传或新建内容,已有内容仍可查看和删除。删掉不用的文件后会自动恢复,也可以联系管理员调高配额。
        </p>
      </section>

      <section v-if="aiOn" class="kb-mu-block" aria-labelledby="mu-ai" data-testid="my-usage-ai">
        <div class="kb-mu-top">
          <b id="mu-ai">今日 AI</b>
          <KbBadge v-if="badge(aiLevel)" :tone="badge(aiLevel)!.tone">{{ badge(aiLevel)!.text }}</KbBadge>
        </div>
        <UsageBar :used="data.ai.tokens_today" :limit="data.ai.limit" name="我今天的 AI 额度" />
        <div class="kb-mu-line">
          <span class="mono">{{ quotaText(data.ai.tokens_today, data.ai.limit) }}</span>
          <b v-if="data.ai.limit > 0">{{ percentText(data.ai.tokens_today, data.ai.limit) }}</b>
        </div>
        <p class="m kb-small kb-mu-note">{{ data.ai.day }}({{ timezoneLabel() }})的用量,每天 0 点重置。</p>
        <p v-if="aiLevel === 'over'" class="kb-me-bad" role="status" data-testid="my-usage-ai-over">今天的 AI 额度用完了:提炼、审核、深度检索等内置模型功能暂停到明天,其它功能不受影响。</p>
      </section>
    </div>
  </KbCard>
</template>

<style>
.kb-mu{display:flex;flex-direction:column;gap:var(--gap-lg,16px);padding:var(--card-pad,16px)}
.kb-mu-block{display:flex;flex-direction:column;gap:8px;min-width:0}
.kb-mu-top{display:flex;align-items:center;gap:8px}
.kb-mu-line{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;font-size:calc(13px*var(--fs));color:var(--text-secondary)}
.kb-mu-parts{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:4px 12px;margin:0;font-size:calc(12px*var(--fs))}
.kb-mu-parts > div{display:flex;justify-content:space-between;gap:8px;min-width:0}
.kb-mu-parts dt{color:var(--text-tertiary)}
.kb-mu-parts dd{margin:0}
.kb-mu-note{margin:0}
</style>
