<script setup lang="ts">
import { localeDateTime } from '@/utils/time'
// 分享治理(管理组「存储与用量」的一页):全站的分享链接。看得到谁分享了什么范围、有没有密码、被访问了多少次,
// 可以强制撤销。只有元数据:看不到链接令牌,也看不到被分享的内容(share_admin_list / share_admin_revoke,功能点 sys.ops)。
import { computed, ref } from 'vue'
import { KbBadge, KbButton, KbEmpty, KbInput, KbPager, KbResponsiveTable, KbSelect, KbStat, useConfirm, useToast, type RtColumn } from '@kb-ui/index'
import AdminLoadState from '@/components/admin/AdminLoadState.vue'
import { SHARE_ADMIN_PAGE_SIZE, shareAdminList, shareAdminRevoke, type AdminLink } from '@/api/usage'
import { useLoadState } from '@/composables/useLoadState'
import { timeAgo } from '@/utils/agent'
import { STATE_FILTERS, audienceText, canRevoke, filterLinks, isRisky, kindLabel, linkCounts, personText, roleText, stateText, type StateFilter } from '@/utils/shareAdmin'
import { failureOf } from '@/utils/loadState'

const toast = useToast()
const confirmer = useConfirm()
const page = ref(1)
const { phase, data, message, reload } = useLoadState(() => shareAdminList(page.value, SHARE_ADMIN_PAGE_SIZE), '读取分享链接', (text) => toast.push(text, 'warning'))
void reload()

const query = ref('')
const state = ref<StateFilter>('all')
const links = computed(() => data.value?.links ?? [])
const rows = computed(() => filterLinks(links.value, { query: query.value, state: state.value }))
const counts = computed(() => linkCounts(links.value))
const filtering = computed(() => query.value.trim() !== '' || state.value !== 'all')
const stateOptions = STATE_FILTERS.map((item) => ({ value: item.value, label: item.label }))
const revoking = ref<string | null>(null)

const columns: RtColumn[] = [
  { key: 'owner', label: '所有者', mobile: 'primary' },
  { key: 'what', label: '分享的内容' },
  { key: 'scope', label: '谁能打开' },
  { key: 'state', label: '状态' },
  { key: 'views', label: '访问', align: 'right' },
  { key: 'created', label: '创建' },
  { key: 'actions', label: '', align: 'right' },
]

const when = (at: number | null) => (at ? timeAgo(at) : '从未')
const title = (at: number | null) => (at ? localeDateTime(at, { hour12: false }) : '')

function clearFilters() {
  query.value = ''
  state.value = 'all'
}
function turn(next: number) {
  page.value = next
  void reload()
}

async function revoke(link: AdminLink) {
  const ok = await confirmer.ask({
    title: '强制撤销这条分享链接?',
    message: `「${kindLabel(link.kind)}」是 ${personText(link.owner)} 分享的。撤销后所有人立刻打不开,所有者也不能再恢复它,只能另建新链接。这个操作会记入审计日志。`,
    confirmText: '强制撤销',
    cancelText: '先不撤销',
    tone: 'danger',
  })
  if (!ok) return
  revoking.value = link.id
  try {
    await shareAdminRevoke(link.id)
    toast.push('已撤销')
    await reload({ quiet: true })
  } catch (err) {
    toast.push(failureOf(err, '撤销这条链接').message, 'danger')
  } finally {
    revoking.value = null
  }
}
</script>

<template>
  <div class="kb-su" data-testid="share-admin-panel">
    <AdminLoadState v-if="phase !== 'ready' || !data" :phase="phase" :message="message" @retry="reload()" />

    <template v-else>
      <div class="kb-su-stats kb-sa-stats">
        <KbStat label="全站链接" :value="`${data.total} 条`" :delta="`本页 ${links.length} 条`" />
        <KbStat label="本页有效" :value="`${counts.active} 条`" :delta="`${counts.passworded} 条设了密码`" />
        <KbStat label="有风险" :value="`${counts.risky} 条`" delta="任何人能开,而且没有密码" :tone="counts.risky ? 'warning' : 'neutral'" />
      </div>

      <KbEmpty
        v-if="!links.length"
        class="card"
        icon="share"
        title="还没有人创建过分享链接"
        description="用户在文档的「分享」里生成链接后,会列在这里。你可以随时强制撤销。"
        data-testid="share-admin-empty"
      >
        <template #action><KbButton variant="primary" @click="reload()">刷新</KbButton></template>
      </KbEmpty>

      <template v-else>
        <div class="kb-su-bar" role="search">
          <KbInput v-model="query" class="kb-su-search" placeholder="按所有者、创建者或链接尾号查找" enterkeyhint="search" aria-label="按所有者、创建者或链接尾号查找" />
          <KbSelect :model-value="state" :options="stateOptions" prefix="状态:" align="end" @update:model-value="(value) => (state = value as StateFilter)" />
          <KbButton class="kb-su-refresh" @click="reload({ quiet: true })">刷新</KbButton>
        </div>

        <div class="card kb-su-table">
          <KbResponsiveTable :columns="columns" :rows="rows" row-key="id" cards="auto" empty="没有符合条件的链接">
            <template #empty>
              <KbEmpty icon="search" title="没有符合条件的链接" description="换个关键字,或者清掉筛选再看。">
                <template #action><KbButton variant="primary" @click="clearFilters">清除筛选</KbButton></template>
              </KbEmpty>
            </template>

            <template #cell-owner="{ row }">
              <div class="kb-su-owner">
                <b>{{ personText(row.owner) }}</b>
                <small v-if="row.creator && row.creator.id !== row.owner?.id" class="m">创建者 {{ personText(row.creator) }}</small>
              </div>
            </template>
            <template #cell-what="{ row }">
              <span>{{ kindLabel(row.kind) }}</span>
              <small class="m mono"> · …{{ row.hint }}</small>
            </template>
            <template #cell-scope="{ row }">
              <div class="kb-sa-scope">
                <span>{{ audienceText(row.audience) }} · {{ roleText(row.role) }}</span>
                <KbBadge v-if="row.has_password" tone="neutral">有密码</KbBadge>
                <KbBadge v-else-if="isRisky(row)" tone="warning">无密码</KbBadge>
              </div>
            </template>
            <template #cell-state="{ row }"><KbBadge :tone="stateText(row.state).tone">{{ stateText(row.state).text }}</KbBadge></template>
            <template #cell-views="{ row }">
              <div class="kb-su-owner kb-sa-views">
                <span class="mono">{{ row.views }}</span>
                <small class="m" :title="title(row.last_view_at)">最近 {{ when(row.last_view_at) }}</small>
              </div>
            </template>
            <template #cell-created="{ row }"><span class="m kb-small" :title="title(row.created_at)">{{ when(row.created_at) }}</span></template>
            <template #cell-actions="{ row }">
              <KbButton v-if="canRevoke(row)" size="sm" variant="danger" :disabled="revoking === row.id" data-testid="share-admin-revoke" @click="revoke(row)">强制撤销</KbButton>
            </template>

            <template #card="{ row }">
              <div class="kb-su-card" data-testid="share-admin-card">
                <div class="kb-su-card-head">
                  <div class="kb-su-owner">
                    <b>{{ personText(row.owner) }}</b>
                    <small class="m">{{ kindLabel(row.kind) }} · …{{ row.hint }}</small>
                  </div>
                  <KbBadge :tone="stateText(row.state).tone">{{ stateText(row.state).text }}</KbBadge>
                </div>
                <div class="kb-sa-scope">
                  <span>{{ audienceText(row.audience) }} · {{ roleText(row.role) }}</span>
                  <KbBadge v-if="row.has_password" tone="neutral">有密码</KbBadge>
                  <KbBadge v-else-if="isRisky(row)" tone="warning">无密码</KbBadge>
                </div>
                <small class="m">访问 {{ row.views }} 次 · 最近 {{ when(row.last_view_at) }} · 创建于 {{ when(row.created_at) }}</small>
                <KbButton v-if="canRevoke(row)" size="sm" variant="danger" :disabled="revoking === row.id" data-testid="share-admin-revoke" @click="revoke(row)">强制撤销</KbButton>
              </div>
            </template>
          </KbResponsiveTable>
        </div>

        <KbPager v-if="data.total > SHARE_ADMIN_PAGE_SIZE" :total="data.total" :page="page" :page-size="SHARE_ADMIN_PAGE_SIZE" @update:page="turn" />
        <p v-if="filtering" class="m kb-small kb-su-foot">筛选只在当前这一页里查找。</p>
      </template>
    </template>
  </div>
</template>

<style>
.kb-sa-stats{grid-template-columns:repeat(3,minmax(0,1fr))}
.kb-sa-scope{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;min-width:0}
.kb-sa-views{align-items:flex-end}
@media (max-width:599px){.kb-sa-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.kb-sa-stats > :first-child{grid-column:span 2}}
</style>
