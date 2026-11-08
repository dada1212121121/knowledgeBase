<script setup lang="ts">
import { localeDateTime } from '@/utils/time'
// 存储用量面板(管理组「存储与用量」的一页):磁盘剩余、全站占用、每个人占了多少(笔记 / 原件 / 向量索引 / 代理工作目录)、
// 配额使用率与告警(超 90%)。数据来自 storage_overview(功能点 sys.ops);只有统计数字,没有任何人的内容。
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { KbBadge, KbButton, KbDonut, KbEmpty, KbHBars, KbInput, KbResponsiveTable, KbSelect, KbStat, KbSwitch, useToast, type RtColumn } from '@kb-ui/index'
import { compositionOf, topUsersBars } from '@/utils/storageCharts'
import AdminLoadState from '@/components/admin/AdminLoadState.vue'
import UsageBar from '@/components/admin/UsageBar.vue'
import { storageOverview, type StorageRow } from '@/api/usage'
import { useLoadState } from '@/composables/useLoadState'
import { PATHS } from '@/router/paths'
import { timeAgo } from '@/utils/agent'
import {
  PART_LABELS,
  SORT_LABELS,
  alertCounts,
  diskLevel,
  filterStorage,
  formatBytes,
  gbText,
  levelOf,
  ownerHandle,
  ownerName,
  partsOf,
  percentText,
  sortStorage,
  vectorShare,
  type StorageSort,
} from '@/utils/usage'

const toast = useToast()
const { phase, data, message, reload } = useLoadState(() => storageOverview(), '读取存储用量', (text) => toast.push(text, 'warning'))
void reload()

const query = ref('')
const sortKey = ref<StorageSort>('total')
const desc = ref(true)
const onlyAlerts = ref(false)

const top = computed(() => data.value?.top ?? [])
const rows = computed(() => sortStorage(filterStorage(top.value, { query: query.value, onlyAlerts: onlyAlerts.value }), sortKey.value, desc.value))
const counts = computed(() => alertCounts(top.value))
const attention = computed(() => counts.value.over + counts.value.warn)
const disk = computed(() => (data.value ? diskLevel(data.value.disk) : 'ok'))
/** 磁盘告警的两句话:现状 + 怎么办。暂停上传时说明哪些操作不受影响。 */
const diskText = computed(() => {
  const info = data.value?.disk
  if (!info || disk.value === 'ok') return ''
  const left = `剩余 ${gbText(info.free_gb)},`
  return disk.value === 'paused'
    ? `${left}低于保留空间 ${gbText(info.reserve_gb)}。读取、删除和编辑笔记不受影响。请清理磁盘或扩容;也可以调低保留空间:`
    : `${left}不到保留空间(${gbText(info.reserve_gb)})的 2 倍。请尽快清理磁盘或扩容;也可以调整保留空间:`
})
const filtering = computed(() => query.value.trim() !== '' || onlyAlerts.value)
const truncated = computed(() => !!data.value && data.value.totals.total_spaces > top.value.length)

// 图表看的是完整的统计结果(不受下面的筛选和排序影响):筛选只是在找人,图要回答「空间都去哪了、谁占得多」
const composition = computed(() => compositionOf(top.value))
const compositionTotal = computed(() => composition.value.reduce((sum, item) => sum + item.value, 0))
const bars = computed(() => topUsersBars(top.value))
// 说明写在图下面而不是卡片标题旁:标题旁的小字在平板和手机上会被藏掉,而「竖线是什么」是读这张图必须知道的
const barsNote = computed(() => {
  const parts = bars.value.some((bar) => bar.limit) ? ['竖线是各自的存储上限,条超过竖线就是已超额。'] : []
  if (truncated.value && data.value) parts.push(`只统计了占用最多的前 ${top.value.length} 位,全站还有 ${data.value.totals.total_spaces - top.value.length} 个知识库没有列出。`)
  return parts.join('')
})

const sortOptions = SORT_LABELS.map((item) => ({ value: item.value, label: item.label }))
const columns: RtColumn[] = [
  { key: 'owner', label: '用户', mobile: 'primary' },
  { key: 'usage', label: '已用 / 配额' },
  ...PART_LABELS.map((part) => ({ key: part.key, label: part.label, align: 'right' as const })),
  { key: 'measured_at', label: '统计于' },
]

const levelBadge = (row: StorageRow) => {
  const level = levelOf(row.total_bytes, row.limit_bytes)
  return level === 'over' ? { tone: 'danger' as const, text: '已超额' } : level === 'warn' ? { tone: 'warning' as const, text: '接近上限' } : null
}
const limitText = (row: StorageRow) => (row.limit_bytes > 0 ? formatBytes(row.limit_bytes) : '不限')
const measuredText = (at: number) => (at ? timeAgo(at) : '还没统计')
const measuredTitle = (at: number) => (at ? localeDateTime(at, { hour12: false }) : '')

function clearFilters() {
  query.value = ''
  onlyAlerts.value = false
}
</script>

<template>
  <div class="kb-su" data-testid="storage-panel">
    <AdminLoadState v-if="phase !== 'ready' || !data" :phase="phase" :message="message" @retry="reload()" />

    <template v-else>
      <!-- 磁盘告警:已暂停上传是全站性的事,放最上面 -->
      <div v-if="disk !== 'ok'" class="kb-su-alert" :class="disk === 'paused' ? 'is-danger' : 'is-warn'" role="alert" data-testid="disk-alert">
        <b>{{ disk === 'paused' ? '磁盘空间不足,全站已经暂停上传' : '磁盘剩余空间不多了' }}</b>
        <span>{{ diskText }}<RouterLink :to="PATHS.params">系统参数 → 存储与上传</RouterLink>。</span>
      </div>

      <div v-if="attention > 0" class="kb-su-alert is-warn" role="status" data-testid="quota-alert">
        <b>{{ counts.over ? `${counts.over} 位用户已超出存储配额` : '' }}{{ counts.over && counts.warn ? ',' : '' }}{{ counts.warn ? `${counts.warn} 位用户用了 90% 以上` : '' }}</b>
        <span>超额的人不能再上传或新建内容,已有内容仍可读、可删。可以在用户详情里给他单独调高配额。</span>
        <KbButton size="sm" @click="onlyAlerts = !onlyAlerts">{{ onlyAlerts ? '看全部' : '只看这些人' }}</KbButton>
      </div>

      <div class="kb-su-stats">
        <KbStat
          label="磁盘剩余"
          :value="gbText(data.disk.free_gb)"
          :delta="data.disk.reserve_gb > 0 ? `保留空间 ${gbText(data.disk.reserve_gb)}` : '没有设置保留空间'"
          :tone="disk === 'paused' ? 'danger' : disk === 'warn' ? 'warning' : 'neutral'"
        />
        <KbStat label="全站占用" :value="formatBytes(data.totals.total_bytes)" :delta="`${data.totals.measured_spaces} / ${data.totals.total_spaces} 个知识库已统计`" />
        <KbStat label="其中向量索引" :value="formatBytes(data.totals.vectors_bytes)" :delta="`占 ${vectorShare(data.totals)}%`" />
        <KbStat
          label="需要关注"
          :value="`${attention} 人`"
          :delta="attention ? `${counts.over} 人超额 · ${counts.warn} 人接近上限` : '没有人接近上限'"
          :tone="counts.over ? 'danger' : counts.warn ? 'warning' : 'neutral'"
        />
      </div>

      <KbEmpty
        v-if="!top.length"
        class="card"
        icon="database"
        title="还没有统计到任何知识库的占用"
        description="占用由后台定时统计,新部署或刚注册的用户要等第一轮统计跑完才会出现,通常几分钟。"
      >
        <template #action><KbButton variant="primary" @click="reload()">刷新</KbButton></template>
      </KbEmpty>

      <template v-else>
        <div class="kb-su-charts" data-testid="storage-charts">
          <div class="card kb-su-chart">
            <div class="ch">占用构成<span class="m kb-light">· 按分项合计</span></div>
            <div class="kb-su-chart-body">
              <KbDonut :items="composition" label="全站占用构成" :format="formatBytes" :center="formatBytes(compositionTotal)" caption="合计" :size="132" />
            </div>
          </div>
          <div class="card kb-su-chart">
            <div class="ch">占用最多的 {{ bars.length }} 位</div>
            <div class="kb-su-chart-body">
              <KbHBars :rows="bars" label="各人占用,按分项堆叠" legend :format="formatBytes" :note="barsNote" />
            </div>
          </div>
        </div>

        <div class="kb-su-bar" role="search">
          <KbInput v-model="query" class="kb-su-search" placeholder="按用户名或昵称查找" enterkeyhint="search" aria-label="按用户名或昵称查找" />
          <KbSelect :model-value="sortKey" :options="sortOptions" prefix="排序:" align="end" @update:model-value="(value) => (sortKey = value as StorageSort)" />
          <KbButton :aria-label="desc ? '当前是倒序,点击改为正序' : '当前是正序,点击改为倒序'" @click="desc = !desc">{{ desc ? '倒序' : '正序' }}</KbButton>
          <span class="kb-su-switch"><KbSwitch v-model="onlyAlerts" aria-label="只看接近上限或超额的人" /><span>只看告警</span></span>
          <KbButton class="kb-su-refresh" @click="reload({ quiet: true })">刷新</KbButton>
        </div>

        <div class="card kb-su-table">
          <KbResponsiveTable :columns="columns" :rows="rows" row-key="space_id" cards="auto" empty="没有符合条件的用户">
            <template #empty>
              <KbEmpty icon="search" title="没有符合条件的用户" description="换个关键字,或者清掉筛选再看。">
                <template #action><KbButton variant="primary" @click="clearFilters">清除筛选</KbButton></template>
              </KbEmpty>
            </template>

            <template #cell-owner="{ row }">
              <div class="kb-su-owner">
                <b>{{ ownerName(row) }}</b>
                <small class="m">{{ ownerHandle(row) }}</small>
              </div>
            </template>
            <template #cell-usage="{ row }">
              <div class="kb-su-usage">
                <UsageBar :used="row.total_bytes" :limit="row.limit_bytes" :name="`${ownerName(row)} 的存储`" />
                <div class="kb-su-usage-text">
                  <span class="mono">{{ formatBytes(row.total_bytes) }} / {{ limitText(row) }}</span>
                  <b v-if="row.limit_bytes > 0">{{ percentText(row.total_bytes, row.limit_bytes) }}</b>
                  <KbBadge v-if="levelBadge(row)" :tone="levelBadge(row)!.tone">{{ levelBadge(row)!.text }}</KbBadge>
                </div>
              </div>
            </template>
            <template #cell-notes="{ row }"><span class="mono">{{ formatBytes(partsOf(row).notes) }}</span></template>
            <template #cell-originals="{ row }"><span class="mono">{{ formatBytes(partsOf(row).originals) }}</span></template>
            <template #cell-vectors="{ row }"><span class="mono">{{ formatBytes(partsOf(row).vectors) }}</span></template>
            <template #cell-workspace="{ row }"><span class="mono">{{ formatBytes(partsOf(row).workspace) }}</span></template>
            <template #cell-measured_at="{ row }">
              <span class="m kb-small" :title="measuredTitle(row.measured_at)">{{ measuredText(row.measured_at) }}</span>
            </template>

            <!-- 手机:一张卡片讲完一个人 -->
            <template #card="{ row }">
              <div class="kb-su-card" data-testid="storage-card">
                <div class="kb-su-card-head">
                  <div class="kb-su-owner">
                    <b>{{ ownerName(row) }}</b>
                    <small class="m">{{ ownerHandle(row) }}</small>
                  </div>
                  <KbBadge v-if="levelBadge(row)" :tone="levelBadge(row)!.tone">{{ levelBadge(row)!.text }}</KbBadge>
                </div>
                <UsageBar :used="row.total_bytes" :limit="row.limit_bytes" :name="`${ownerName(row)} 的存储`" />
                <div class="kb-su-usage-text">
                  <span class="mono">{{ formatBytes(row.total_bytes) }} / {{ limitText(row) }}</span>
                  <b v-if="row.limit_bytes > 0">{{ percentText(row.total_bytes, row.limit_bytes) }}</b>
                </div>
                <dl class="kb-su-parts">
                  <div v-for="part in PART_LABELS" :key="part.key">
                    <dt>{{ part.label }}</dt>
                    <dd class="mono">{{ formatBytes(partsOf(row)[part.key]) }}</dd>
                  </div>
                </dl>
                <small class="m">统计于 {{ measuredText(row.measured_at) }}</small>
              </div>
            </template>
          </KbResponsiveTable>
        </div>

        <dl class="kb-su-legend">
          <div v-for="part in PART_LABELS" :key="part.key">
            <dt>{{ part.label }}</dt>
            <dd>{{ part.hint }}</dd>
          </div>
        </dl>
        <p v-if="truncated && !filtering" class="m kb-small kb-su-foot" data-testid="storage-truncated">
          只列出占用最多的 {{ top.length }} 个知识库,全站共 {{ data.totals.total_spaces }} 个。
        </p>
        <p v-if="filtering" class="m kb-small kb-su-foot">筛选只在上面列出的 {{ top.length }} 个知识库里查找。</p>
      </template>
    </template>
  </div>
</template>

<style>
.kb-su{display:flex;flex-direction:column;gap:var(--gap-md,12px);min-width:0}
.kb-su-alert{display:flex;flex-wrap:wrap;align-items:center;gap:var(--gap-sm,8px) var(--gap-md,12px);padding:12px var(--card-pad-x,16px);border-radius:var(--r2);border:var(--hl) solid var(--b2);font-size:calc(13px*var(--fs))}
.kb-su-alert > span{flex:1 1 16em;min-width:0;color:var(--text-secondary)}
.kb-su-alert.is-warn{border-color:color-mix(in oklab,var(--status-warning) 45%,transparent);background:color-mix(in oklab,var(--status-warning) 10%,transparent)}
.kb-su-alert.is-warn > b{color:var(--status-warning-text)}
.kb-su-alert.is-danger{border-color:color-mix(in oklab,var(--status-danger) 45%,transparent);background:color-mix(in oklab,var(--status-danger) 10%,transparent)}
.kb-su-alert.is-danger > b{color:var(--status-danger-text)}
.kb-su-alert a{color:var(--accent-text,var(--accent))}
.kb-su-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--gap-md,12px)}
.kb-su-charts{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:var(--gap-md,12px);align-items:stretch}
.kb-su-chart{min-width:0;overflow:hidden}
.kb-su-chart-body{padding:var(--card-pad,16px)}
.kb-su-bar{display:flex;flex-wrap:wrap;align-items:center;gap:var(--gap-sm,8px)}
.kb-su-search{flex:1 1 14em;min-width:0}
.kb-su-search input,input.kb-su-search{width:100%}
.kb-su-switch{display:inline-flex;align-items:center;gap:var(--gap-sm,8px);font-size:calc(13px*var(--fs))}
.kb-su-refresh{margin-left:auto}
.kb-su-table{padding:0;overflow:hidden}
.kb-su-owner{display:flex;flex-direction:column;min-width:0}
.kb-su-owner b,.kb-su-owner small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-su-usage{display:flex;flex-direction:column;gap:6px;min-width:12em}
.kb-su-usage-text{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;font-size:calc(12px*var(--fs));color:var(--text-secondary)}
.kb-su-card{display:flex;flex-direction:column;gap:8px;min-width:0}
.kb-su-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.kb-su-parts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 12px;margin:0;font-size:calc(12px*var(--fs))}
.kb-su-parts > div{display:flex;justify-content:space-between;gap:8px;min-width:0}
.kb-su-parts dt{color:var(--text-tertiary)}
.kb-su-parts dd{margin:0}
.kb-su-foot{margin:0}
.kb-su-legend{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:6px 16px;margin:0;font-size:calc(12px*var(--fs));color:var(--text-tertiary)}
.kb-su-legend dt{color:var(--text-secondary);font-weight:600}
.kb-su-legend dd{margin:0}
@media (max-width:1023px){.kb-su-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:839px){.kb-su-charts{grid-template-columns:minmax(0,1fr)}}
/* 手机:搜索框独占一行;排序下拉 + 正序按钮一行;只看告警(左)+ 刷新(右)一行。
   原来是 flex-wrap:搜索框旁边挤着排序下拉,剩下三个落到第二行,大小不一、右边留空。
   DOM 顺序是 搜索 / 排序 / 正序 / 只看告警 / 刷新,网格按这个顺序自然排成三行 */
@media (max-width:599px){
  .kb-su-bar{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--gap-sm,8px)}
  .kb-su-search{grid-column:1 / -1}
  .kb-su-bar > .kb-select{min-width:0}
  .kb-su-bar > .kb-select .btn{width:100%;justify-content:space-between}
  .kb-su-refresh{margin-left:0}
}
</style>
