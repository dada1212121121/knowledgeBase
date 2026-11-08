<script setup lang="ts">
import { dayKey } from '@/utils/time'
// 个人设置里的「访问令牌」:列表(名称 / 类型 / 是否包含共享内容 / 创建与最近使用 / 状态)、新建、撤销。
// 受 `api.tokens` 功能点控制(没开通的账号整张卡片不出现,由 Me.vue 判断)。
// 四种状态:加载(骨架屏)、空(给下一步)、报错(人话 + 重试)、无权限(403)。
import { computed, onMounted, ref } from 'vue'
import { KbBadge, KbButton, KbCard, KbEmpty, KbResponsiveTable, KbSkeleton, useConfirm, type RtColumn } from '@kb-ui/index'
import TokenCreateDialog from './TokenCreateDialog.vue'
import { AccountError, type ApiToken } from '@/api/client'
import { tokenRevoke, tokensList } from '@/api/tokens'
import { timeAgo } from '@/utils/agent'
import { explainTokenError, SCOPE_LABEL } from '@/utils/tokens'

const confirm = useConfirm()
const tokens = ref<ApiToken[]>([])
const loading = ref(true)
const failure = ref<{ message: string; forbidden: boolean } | null>(null)
const creating = ref(false)

async function load() {
  if (!tokens.value.length) loading.value = true
  try {
    tokens.value = await tokensList()
    failure.value = null
  } catch (err) {
    failure.value = { message: `${explainTokenError(err)}`, forbidden: err instanceof AccountError && err.status === 403 }
  } finally {
    loading.value = false
  }
}
onMounted(load)

const columns: RtColumn[] = [
  { key: 'name', label: '名称', mobile: 'primary' },
  { key: 'scope', label: '类型' },
  { key: 'shared', label: '共享给我的内容' },
  { key: 'created_at', label: '创建于' },
  { key: 'last_used', label: '最近使用' },
  { key: 'state', label: '状态' },
]
const rows = computed(() => tokens.value.map((token) => ({ ...token, state: token.revoked_at ? 'revoked' : 'active' }) as Record<string, unknown> & ApiToken))
const activeCount = computed(() => tokens.value.filter((token) => !token.revoked_at).length)

// 日期按术语表写成 2026-10-19(超过一年的日期要带年份)
const day = (at: number) => {
  return dayKey(at)
}

async function revoke(token: ApiToken) {
  const ok = await confirm.ask({
    title: `撤销令牌「${token.name}」?`,
    message: '正在用它的 MCP 客户端或脚本会立刻失去访问权限,不能恢复;需要的话只能重新创建一个。',
    confirmText: '撤销',
    tone: 'danger',
    doneText: '令牌已撤销',
    action: async () => {
      try {
        await tokenRevoke(token.id)
      } catch (err) {
        // 就地显示在确认框里,可重试
        throw new Error(explainTokenError(err))
      }
    },
  })
  if (ok) await load()
}
</script>

<template>
  <KbCard class="kb-me-card kb-me-wide" aria-labelledby="me-tokens" data-testid="token-card">
    <header class="kb-me-head">
      <b id="me-tokens">访问令牌</b>
      <span class="kb-spacer"></span>
      <KbButton v-if="!loading && !failure" size="sm" variant="primary" data-testid="token-new" @click="creating = true">新建令牌</KbButton>
    </header>
    <div class="kb-me-form kb-me-flat">
      <p class="m kb-small">给脚本、MCP 客户端(Kiro、Claude Code 等)用的长期凭证。令牌只会在创建时显示一次,可以随时撤销;撤销后用它的客户端立即失效。</p>

      <KbSkeleton v-if="loading" variant="table" :lines="3" />

      <div v-else-if="failure" data-testid="token-failure">
        <p class="kb-me-bad" role="alert">{{ failure.message }}</p>
        <div v-if="!failure.forbidden" class="kb-me-actions"><KbButton @click="load">重试</KbButton></div>
      </div>

      <KbEmpty v-else-if="!tokens.length" icon="key" title="还没有访问令牌" description="创建后复制到 MCP 客户端或脚本的配置里,就能用它访问你的知识库。" size="sm">
        <template #action><KbButton variant="primary" @click="creating = true">新建令牌</KbButton></template>
      </KbEmpty>

      <template v-else>
        <KbResponsiveTable :columns="columns" :rows="rows" empty="还没有访问令牌">
          <template #cell-name="{ row }"><b class="kb-tk-name" :class="{ 'is-revoked': row.revoked_at }">{{ row.name }}</b></template>
          <template #cell-scope="{ row }"><KbBadge>{{ SCOPE_LABEL[row.scope ?? row.scopes] ?? row.scope }}</KbBadge></template>
          <template #cell-shared="{ row }">
            <KbBadge v-if="row.include_shared" tone="warning" data-testid="token-shared-badge">包含</KbBadge>
            <span v-else class="m">不包含</span>
          </template>
          <template #cell-created_at="{ row }"><span class="m">{{ day(row.created_at) }}</span></template>
          <template #cell-last_used="{ row }"><span class="m">{{ row.last_used ? timeAgo(row.last_used) : '从未使用' }}</span></template>
          <template #cell-state="{ row }"><KbBadge :tone="row.revoked_at ? 'danger' : 'success'">{{ row.revoked_at ? '已撤销' : '有效' }}</KbBadge></template>
          <template #row-actions="{ row }">
            <KbButton v-if="!row.revoked_at" size="sm" variant="danger" :aria-label="`撤销令牌:${row.name}`" data-testid="token-revoke" @click="revoke(row)">撤销</KbButton>
          </template>
        </KbResponsiveTable>
        <p class="m kb-small">{{ activeCount }} 个有效令牌。</p>
      </template>
    </div>

    <TokenCreateDialog v-if="creating" @close="creating = false" @created="load" />
  </KbCard>
</template>

<style>
.kb-tk-name.is-revoked {
  color: var(--text-tertiary);
  text-decoration: line-through;
}
</style>
