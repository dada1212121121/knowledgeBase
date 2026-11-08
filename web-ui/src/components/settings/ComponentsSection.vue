<script setup lang="ts">
// 「组件」分区:环境检测(本机硬件、已装工具)+ 嵌入 + 重排。
//   - 嵌入这张卡把「当前用的是什么」(只读参数)和「本机有哪些引擎」合在一起,以前是两张同名的卡;
//   - 嵌入 / 重排只读:后端不支持一键切换(换嵌入模型要先迁移已有集合,重排写在 config.toml 里);
//   - 读取有加载(骨架)/ 报错(重试)/ 没开通三种状态,由 AdminLoadState 统一给。
import { computed, onMounted } from 'vue'
import { KbBadge, KbButton, KbCard } from '@kb-ui/index'
import AdminLoadState from '@/components/admin/AdminLoadState.vue'
import FieldCards from './FieldCards.vue'
import ProviderList from './ProviderList.vue'
import { useProviders } from '@/composables/useProviders'
import type { Draft } from '@/utils/settingsFields'
import { envRows, kindLabel, kindSummary, recsOfKinds } from '@/utils/settingsComponents'

defineProps<{ aiOn: boolean; draft: Draft; errors: Record<string, string> }>()
const emit = defineEmits<{ update: [path: string, value: string | boolean] }>()

const providers = useProviders()
onMounted(() => void providers.reload())

const ready = computed(() => providers.phase.value === 'ready')
const rows = computed(() => envRows(providers.env.value))
const ofKind = (kind: string) => providers.providers.value.filter((item) => item.kind === kind)
const recs = computed(() => recsOfKinds(providers.recommendations.value, ['embed', 'rerank']))
</script>

<template>
  <AdminLoadState v-if="!ready" :phase="providers.phase.value === 'ready' ? 'loading' : providers.phase.value" :message="providers.message.value" skeleton="card" @retry="providers.reload()" />

  <template v-else>
    <KbCard title="环境检测" class="kb-st-card" data-testid="env-card">
      <p class="kb-st-note">按本机硬件看哪些组件跑得动。这里只给建议,不会自己改任何设置。</p>
      <dl class="kb-st-env">
        <div v-for="row in rows" :key="row.label" class="kb-st-env-item">
          <dt class="kb-hint">{{ row.label }}</dt>
          <dd class="kb-mono">{{ row.value }}</dd>
        </div>
      </dl>
      <div v-if="recs.length" class="kb-st-in" data-testid="recommendations">
        <div v-for="item in recs" :key="`${item.kind}-${item.provider}`" class="kb-st-rec">
          <KbBadge :tone="item.already_current ? 'success' : 'warning'">{{ item.already_current ? '已采用' : '建议' }}</KbBadge>
          <span class="kb-mono">{{ item.provider }}</span>
          <span class="kb-hint">{{ kindLabel(item.kind) }}:{{ item.reason }}</span>
        </div>
      </div>
      <p v-if="providers.recommendationsFailed.value" class="kb-hint" data-testid="recommendations-failed">推荐暂时读不到,不影响下面的操作。</p>
      <template #footer>
        <KbButton size="sm" data-testid="env-recheck" @click="providers.reload()">重新检测</KbButton>
      </template>
    </KbCard>

    <p v-if="providers.actionError.value" class="kb-st-inline-error" role="alert" data-testid="provider-error">{{ providers.actionError.value }}</p>

    <p v-if="providers.backendWarnings.value.length" class="kb-hint" data-testid="backend-warnings">
      有一个后端声明没读成(其余照常):{{ providers.backendWarnings.value.join(';') }}。改好 <code>&lt;KB_HOME&gt;/backends/</code> 下那份 manifest 再点「重新检测」。
    </p>

    <FieldCards section="components" v-bind="{ aiOn, draft, errors }" @update="(path, value) => emit('update', path, value)">
      <template #in-embed>
        <p class="kb-hint">{{ kindSummary(providers.providers.value, 'embed') }} · 本机有这些嵌入引擎:</p>
        <ProviderList :providers="ofKind('embed')" :busy="providers.busy.value" />
      </template>
    </FieldCards>

    <KbCard title="重排" class="kb-st-card" data-group="rerank">
      <p class="kb-st-note">重排会对初步搜索结果再排一次序,更准但更慢。开关和参数写在 config.toml 的 [rerank] 里(rerank.mode 可选 auto / on / off),改完立即生效。</p>
      <p class="kb-hint">{{ kindSummary(providers.providers.value, 'rerank') }}</p>
      <ProviderList :providers="ofKind('rerank')" :busy="providers.busy.value" />
    </KbCard>
  </template>
</template>

<style>
.kb-st-env{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--gap-sm,8px) var(--gap-md,12px);margin:0}
.kb-st-env-item{display:flex;flex-direction:column;gap:2px;min-width:0}
.kb-st-env-item dd{margin:0;overflow-wrap:anywhere}
.kb-st-rec{display:flex;align-items:center;gap:var(--gap-sm,8px);flex-wrap:wrap;min-width:0}
.kb-st-rec .kb-hint{min-width:0;overflow-wrap:anywhere}
</style>
