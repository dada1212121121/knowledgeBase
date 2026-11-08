<script setup lang="ts">
import { localeDateTime } from '@/utils/time'
// 审计日志(管理组「审计 / 批次」的一页,功能点 sys.ops):谁、什么时候、做了什么、成没成。
// 后端写的是能力名、用户 id 和原始参数 JSON,这里翻成中文显示(utils/auditText),原文只放进 title。
// 读不到时整块写原因并给重试(以前请求失败被吞掉,页面停在骨架屏);没有开通功能点时说明原因。
import { computed, onMounted, ref, watch } from 'vue'
import { KbBadge, KbButton, KbEmpty, KbPager, KbResponsiveTable, KbSelect, type RtColumn } from '@kb-ui/index'
import AdminLoadState from '@/components/admin/AdminLoadState.vue'
import { callCapability, type AuditEntry } from '@/api/client'
import { useFeature } from '@/composables/useFeature'
import { userList } from '@/utils/adminApi'
import AuditStatsCards from '@/components/admin/AuditStatsCards.vue'
import { AUDIT_FILTERS, actorText, argsSummary, capabilityText } from '@/utils/auditText'
import { failureOf, type LoadPhase } from '@/utils/loadState'

const phase = ref<LoadPhase>('loading')
const message = ref('')
const entries = ref<AuditEntry[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(24)
const capability = ref('')
/** 翻页 / 换筛选时保留旧列表,读到了再换;读失败时旧列表仍在,只提示 */
const stale = ref(false)

const filterOptions = [{ value: '', label: '全部操作' }, ...AUDIT_FILTERS]

async function load() {
  if (!entries.value.length) phase.value = 'loading'
  try {
    const reply = await callCapability<{ entries: AuditEntry[]; total: number }>('audit_list', {
      page: page.value,
      page_size: pageSize.value,
      ...(capability.value ? { capability: capability.value } : {}),
    })
    entries.value = reply.entries
    total.value = reply.total
    stale.value = false
    phase.value = 'ready'
  } catch (err) {
    const failure = failureOf(err, '读取审计日志')
    if (entries.value.length && failure.phase === 'error') {
      stale.value = true
      return
    }
    entries.value = []
    phase.value = failure.phase
    message.value = failure.message
  }
}

// 操作者是用户 id;有「用户」功能时顺手查一次名字(查不到就只显示 id 末六位,不影响日志本身)
const canUsers = useFeature('sys.users')
const names = ref(new Map<string, string>())
async function loadNames() {
  if (!canUsers.value) return
  try {
    const reply = await userList({ page_size: 200 })
    names.value = new Map(reply.users.map((user) => [user.id, user.display_name || user.username]))
  } catch {
    names.value = new Map()
  }
}

onMounted(() => {
  void load()
  void loadNames()
})
watch(capability, () => {
  page.value = 1
  void load()
})
watch([page, pageSize], () => void load())

const columns: RtColumn[] = [
  { key: 'at', label: '时间', cellClass: 'mono m', mobile: 'meta' },
  { key: 'actor', label: '操作者', mobile: 'meta' },
  { key: 'capability', label: '操作', mobile: 'primary' },
  { key: 'ok', label: '结果', mobile: 'meta' },
  // 手机卡片里没有值的行不占位(桌面表格仍显示「—」,列才对得齐)
  { key: 'batch', label: '所属批次', cellClass: 'mono m', mobile: 'meta', hideWhen: (row) => !(row as unknown as AuditEntry).batch_id },
  { key: 'args', label: '详情', clip: true, cellClass: 'm', mobile: 'meta', hideWhen: (row) => !detail(row as unknown as AuditEntry) },
]
type Row = Record<string, unknown>
const rows = computed(() => entries.value as unknown as Row[])
const asEntry = (row: Row) => row as unknown as AuditEntry

const timeText = (at: number) => localeDateTime(at, { hour12: false })
/** 失败的写原因(后端的中文原因直接用);成功的写参数摘要;都没有就留空 */
const detail = (entry: AuditEntry) => (!entry.ok && entry.error ? entry.error : argsSummary(entry.args_json))
const resultText = (entry: AuditEntry) => (entry.ok ? (entry.dry_run ? '试运行' : '成功') : '失败')

const filtering = computed(() => capability.value !== '')
</script>

<template>
  <div class="kb-ap" data-testid="audit-panel">
    <AdminLoadState v-if="phase !== 'ready'" :phase="phase" :message="message" skeleton="table" @retry="load()" />

    <template v-else>
      <AuditStatsCards />
      <div class="kb-ap-bar">
        <span class="kb-ap-title">调用记录</span>
        <KbSelect v-model="capability" :options="filterOptions" prefix="操作:" align="end" aria-label="按操作筛选" />
      </div>
      <p v-if="stale" class="m kb-small" role="status" data-testid="audit-stale">最近一次刷新没成功,下面显示的是之前的数据。<KbButton size="sm" @click="load()">重新读取</KbButton></p>

      <KbEmpty
        v-if="!entries.length"
        class="card"
        icon="database"
        :title="filtering ? '这个操作还没有记录' : '还没有调用记录'"
        :description="filtering ? '换一个操作,或者回到全部操作再看。' : '用户和外部程序每做一次操作,这里就多一条,方便事后追查。'"
        data-testid="audit-empty"
      >
        <template v-if="filtering" #action><KbButton variant="primary" @click="capability = ''">看全部操作</KbButton></template>
      </KbEmpty>

      <div v-else class="card kb-ap-card">
        <KbResponsiveTable :columns="columns" :rows="rows" empty="还没有调用记录" label="调用记录">
          <template #cell-at="{ row }">{{ timeText(asEntry(row).at) }}</template>
          <template #cell-actor="{ row }"><span :title="asEntry(row).actor">{{ actorText(asEntry(row).actor, names) }}</span></template>
          <template #cell-capability="{ row }"><b :title="asEntry(row).capability">{{ capabilityText(asEntry(row).capability) }}</b></template>
          <template #cell-ok="{ row }">
            <KbBadge :tone="asEntry(row).ok ? 'success' : 'danger'">{{ resultText(asEntry(row)) }}</KbBadge>
          </template>
          <template #cell-batch="{ row }">{{ asEntry(row).batch_id ?? '—' }}</template>
          <template #cell-args="{ row }"><span :title="asEntry(row).args_json">{{ detail(asEntry(row)) || '—' }}</span></template>
        </KbResponsiveTable>
        <KbPager v-model:page="page" v-model:page-size="pageSize" :total="total" :sizes="[24, 50, 100]" />
      </div>
    </template>
  </div>
</template>

<style>
/* 审计日志:自己撑开高度,由外层内容区滚动。以前套在会收缩的 flex 卡片里,手机上筛选框被压成一条缝 */
.kb-ap{display:flex;flex-direction:column;gap:var(--gap-md,12px);min-width:0}
.kb-ap-bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--gap-sm,8px)}
.kb-ap-title{font-weight:600}
.kb-ap-card{flex:0 0 auto;padding:0;overflow:hidden}
</style>
