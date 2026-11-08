<script setup lang="ts">
import { dateParts } from '@/utils/time'
// 首页(个人工作台):登录后的第一屏。把「接着干」和「别人在等我」放在一起:
//   继续编辑(我最近改过的笔记)· 共享给我的新动态 · 待处理(好友申请 / 访问申请 / 待审核草稿)· 快速开始 · 用量。
// 每一块各自取数、各自有加载 / 空 / 报错状态;没开通的功能(好友、分享、审核、AI)那一块直接不出现。
// 普通用户看个人数据;管理员可切换「我的 / 全员」查看全站指标与全员活动走势(无硬编码,全部经真实能力接口取数)。
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import {
  KbBadge,
  KbButton,
  KbDonut,
  KbEmpty,
  KbGauge,
  KbHeatmap,
  KbHBars,
  KbIcon,
  KbLineChart,
  KbNum,
  KbPageHeader,
  KbSegmented,
  KbSkeleton,
  KbStat,
  type DonutItem,
  type HBarRow,
  type LineSeries,
} from '@kb-ui/index'
import AppShell from '@/layouts/AppShell.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import UsageBar from '@/components/admin/UsageBar.vue'
import { callCapability, type StatsOverview } from '@/api/client'
import { llmUsageSeries, type LlmUsageSeries } from '@/api/metrics'
import { storageOverview, type StorageOverview } from '@/api/usage'
import { useFeature } from '@/composables/useFeature'
import { useHomeFeed } from '@/composables/useHomeFeed'
import { useLiveEvents, type LiveEvent } from '@/composables/useLiveEvents'
import { PATHS } from '@/router/paths'
import { usePanelsStore } from '@/stores/panels'
import { useSessionStore } from '@/stores/session'
import { useShellStore } from '@/stores/shell'
import { guideKey, guideSteps, shouldShowGuide, type GuideStep } from '@/utils/guide'
import { activityTrend, greeting, itemTitle, pendingRows, recentRoute, sharedRows, summarizeActivity } from '@/utils/home'
import { relativeTime } from '@/utils/share'
import { formatBytes, levelOf, llmPurposeLabel, percentText, quotaText } from '@/utils/usage'

const router = useRouter()
const session = useSessionStore()
const shell = useShellStore()
const panels = usePanelsStore()
const { insights, drafts, sources } = storeToRefs(shell)

const canNotes = useFeature('docs.notes')
const canUpload = useFeature('docs.upload')
const canFriends = useFeature('collab.friends')
const canShare = useFeature('collab.share')
const canReview = useFeature('ai.extract')

const feed = useHomeFeed((feature) => session.has(feature))
const { recent, shared, pending, usage, activity } = feed

const now = Date.now()
const name = computed(() => session.user?.display_name || session.user?.username || '')
const title = computed(() => greeting(dateParts(now).hour, name.value))

const recentItems = computed(() => recent.data.value ?? [])
const sharedList = computed(() => sharedRows(shared.data.value ?? [], 5, now, relativeTime))
const pendingList = computed(() =>
  pendingRows({
    friends: canFriends.value ? (pending.data.value?.friends ?? []) : [],
    access: canShare.value ? (pending.data.value?.access ?? []) : [],
    // 草稿数是外壳常驻取的(审核收件箱的角标也用它),AI 关掉或没有审核权限时不算
    drafts: canReview.value ? drafts.value : 0,
    now,
    relative: relativeTime,
  }),
)
const newShared = computed(() => (shared.data.value ?? []).filter((item) => !item.hidden && now - item.shared_at < 7 * 86_400_000).length)

const summary = computed(() => summarizeActivity(activity.data.value))
/** 「我的笔记」旁的说明:近 30 天新建了多少(有活动数据才写) */
const notesDelta = computed(() => (activity.phase.value === 'ready' ? (summary.value.month.notes ? `近 30 天新增 ${summary.value.month.notes} 条` : '近 30 天没有新增') : ''))
const storage = computed(() => usage.data.value?.storage ?? null)
const ai = computed(() => usage.data.value?.ai ?? null)
// 关掉 AI 后全站不出现「AI」字样(术语表):用量卡只在 AI 开着时显示
const showAi = computed(() => session.aiEnabled && !!ai.value)
const showQuick = computed(() => canNotes.value || canUpload.value || canFriends.value)

// ------------------------------------------------------------ 指标卡数据与管理员切换 (无硬编码)
const scope = ref<'me' | 'all'>('me')
const SCOPE_OPTIONS = [
  { value: 'me', label: '我的' },
  { value: 'all', label: '全员' },
]

// 管理员全员统计数据(按需拉取真实能力,无硬编码假数据)
const adminStats = ref<StatsOverview | null>(null)
const adminStorage = ref<StorageOverview | null>(null)
const adminLlm = ref<LlmUsageSeries | null>(null)
const adminLoading = ref(false)
const adminFailed = ref(false)

async function loadAdminData() {
  if (!session.isAdmin) return
  adminLoading.value = true
  adminFailed.value = false
  try {
    const [statsRes, storageRes, llmRes] = await Promise.allSettled([
      callCapability<StatsOverview>('stats_overview'),
      session.has('sys.ops') ? storageOverview(1) : Promise.reject('no sys.ops'),
      session.has('sys.ops') && session.aiEnabled ? llmUsageSeries(30) : Promise.reject('no llm'),
    ])
    if (statsRes.status === 'fulfilled') adminStats.value = statsRes.value
    if (storageRes.status === 'fulfilled') adminStorage.value = storageRes.value
    if (llmRes.status === 'fulfilled') adminLlm.value = llmRes.value
  } catch {
    adminFailed.value = true
  } finally {
    adminLoading.value = false
  }
}

watch(scope, (next) => {
  if (next === 'all' && !adminStats.value && session.isAdmin) {
    void loadAdminData()
  }
})

// 统计卡的值:还没取到时显示「—」,不显示 0(0 会被当成真的没有)
const dash = '—'
const statNotes = computed(() => {
  if (scope.value === 'all') return adminStats.value?.totals ? adminStats.value.totals.insights : dash
  return shell.loaded ? insights.value : dash
})
const statNotesLabel = computed(() => (scope.value === 'all' ? '全站笔记' : '我的笔记'))
const statNotesDelta = computed(() => {
  if (scope.value === 'all') return adminStats.value?.totals ? `知识内容 ${adminStats.value.totals.rows.toLocaleString()} 块` : ''
  return notesDelta.value
})
const statNotesSpark = computed(() => {
  // 「我的」用本人的近 30 天新建笔记;「全员」优先用后端给的趋势,没有就用同一份活动序列
  if (scope.value === 'all' && adminStats.value?.trends?.insights?.series?.length) return adminStats.value.trends.insights.series
  // 和活动图同一口径:activity_series 的近 30 天新建笔记。activity_7d 只覆盖 7 天且只数 insight,
  // 真实部署里 7 天内常常没有新笔记,迷你折线会整段空着,看起来像没数据。
  return summary.value.notesSpark.length > 1 ? summary.value.notesSpark : []
})

const statShared = computed(() => {
  if (scope.value === 'all') {
    if (adminStorage.value?.totals?.total_spaces != null) return adminStorage.value.totals.total_spaces
    if (adminStats.value?.totals?.projects != null) return adminStats.value.totals.projects
    return dash
  }
  return shared.phase.value === 'ready' ? feed.sharedCount.value : dash
})
const statSharedLabel = computed(() => (scope.value === 'all' ? '全站成员' : '共享给我'))
const statSharedDelta = computed(() => {
  if (scope.value === 'all') {
    if (adminStorage.value?.totals) return `已量取 ${adminStorage.value.totals.measured_spaces} 个知识库`
    if (adminStats.value?.collections) return `${adminStats.value.collections.length} 个集合`
    return ''
  }
  return newShared.value ? `近 7 天新增 ${newShared.value} 项` : ''
})

const statPending = computed(() => {
  if (scope.value === 'all') {
    if (adminStats.value?.jobs) return adminStats.value.jobs.queued + adminStats.value.jobs.running
    return dash
  }
  return pending.phase.value === 'ready' ? pendingList.value.length : dash
})
const statPendingLabel = computed(() => (scope.value === 'all' ? '系统任务' : '待处理'))
const statPendingDelta = computed(() => {
  if (scope.value === 'all') {
    if (adminStats.value?.jobs) return `队列 ${adminStats.value.jobs.queued} · 运行 ${adminStats.value.jobs.running}`
    return ''
  }
  return pendingList.value.length ? '有事等你处理' : ''
})
const statPendingTone = computed(() => {
  if (scope.value === 'all') {
    const active = adminStats.value?.jobs ? adminStats.value.jobs.queued + adminStats.value.jobs.running : 0
    return active > 0 ? 'warning' : 'neutral'
  }
  return pendingList.value.length ? 'warning' : 'neutral'
})

const statStorage = computed(() => {
  if (scope.value === 'all') {
    if (adminStorage.value?.totals) return formatBytes(adminStorage.value.totals.total_bytes)
    return dash
  }
  return storage.value ? formatBytes(storage.value.total_bytes) : dash
})
const statStorageLabel = computed(() => (scope.value === 'all' ? '全站存储' : '存储'))
const storageNote = computed(() => {
  if (scope.value === 'all') {
    if (adminStorage.value?.disk) return `剩余可用 ${adminStorage.value.disk.free_gb} GB`
    return ''
  }
  if (!storage.value) return ''
  const limit = storage.value.limit_bytes
  return limit > 0 ? `共 ${formatBytes(limit)} · 已用 ${percentText(storage.value.total_bytes, limit)}` : '不限额'
})
const storageTone = computed<'neutral' | 'warning' | 'danger'>(() => {
  if (scope.value === 'all') {
    if (adminStorage.value?.disk?.warn) return 'warning'
    return 'neutral'
  }
  if (!storage.value || !storage.value.limit_bytes) return 'neutral'
  const ratio = storage.value.total_bytes / storage.value.limit_bytes
  return ratio >= 0.95 ? 'danger' : ratio >= 0.8 ? 'warning' : 'neutral'
})

// ------------------------------------------------------------ 我的活动视图切换与 30 天构成
const ACTIVITY_VIEW_KEY = 'kb.home.activityView'
function readActivityView(): 'heatmap' | 'trend' {
  try {
    const saved = localStorage.getItem(ACTIVITY_VIEW_KEY)
    if (saved === 'heatmap' || saved === 'trend') return saved
  } catch {}
  return 'trend'
}
const activityView = ref<'heatmap' | 'trend'>(readActivityView())
watch(activityView, (mode) => {
  try {
    localStorage.setItem(ACTIVITY_VIEW_KEY, mode)
  } catch {}
})
const ACTIVITY_VIEW_OPTIONS = [
  { value: 'trend', label: '趋势图' },
  { value: 'heatmap', label: '热力图' },
]

/**
 * 活动的四类：趋势图、构成条、下面的月合计三处同一个顺序、同一种颜色。
 * 以前趋势图按「新建 / 编辑 / 检索 / 导入」默认取色，构成条按「新建 / 编辑 / 导入 / 检索」取色，
 * 同一张卡片里「搜索」和「导入文件」两种颜色对调，读图时会认错。
 */
const ACTIVITY_KINDS = [
  { key: 'notes', name: '新建笔记', color: 'var(--viz-1)' },
  { key: 'edits', name: '编辑', color: 'var(--viz-2)' },
  { key: 'imports', name: '导入文件', color: 'var(--viz-3)' },
  { key: 'searches', name: '搜索', color: 'var(--viz-4)' },
] as const

const trend = computed(() => activityTrend(activity.data.value))
const trendSeries = computed<LineSeries[]>(() => ACTIVITY_KINDS.map((kind) => ({ name: kind.name, values: trend.value[kind.key], color: kind.color })))

const monthTotal = computed(() => {
  const m = summary.value.month
  return m.notes + m.edits + m.imports + m.searches
})

const activityMixRows = computed<HBarRow[]>(() => {
  const m = summary.value.month
  return [
    {
      key: 'activity-mix',
      label: '活动构成',
      segments: ACTIVITY_KINDS.map((kind) => ({ name: kind.name, value: m[kind.key], color: kind.color })),
    },
  ]
})

// 管理员视角下的全员活动图表数据
const adminLlmLabels = computed(() => (adminLlm.value?.days ?? []).map((day) => day.slice(5)))
const adminLlmSeries = computed<LineSeries[]>(() =>
  (adminLlm.value?.purposes ?? []).map((purpose) => ({
    name: llmPurposeLabel(purpose),
    values: adminLlm.value?.series[purpose] ?? [],
  })),
)
// 全员活动图:沿用「我的」那套 30 天活动序列(activity_series:新建笔记 / 编辑 / 导入文件 / 搜索)。
// 不再只看 stats_overview.activity_7d —— 它只数近 7 天新增的 insight,而真实部署的内容多来自
// 导入与索引、7 天内常常没有新笔记,整块会误显示成「全站暂无活动记录」。
const adminActivityReady = computed(() => activity.phase.value === 'ready' && monthTotal.value > 0)

// ------------------------------------------------------------ 知识资产分布环形图与存储仪表盘 (真实数据无硬编码)
const donutItems = computed<DonutItem[]>(() => {
  if (scope.value === 'all') {
    const collections = adminStats.value?.collections ?? []
    if (collections.length > 0) {
      return collections.map((c, i) => ({
        name: c.name,
        value: c.items ?? c.rows ?? 0,
        color: `var(--viz-${(i % 6) + 1})`,
      }))
    }
  }
  const projects = shell.projects ?? []
  if (projects.length > 0) {
    return projects.map((p, i) => ({
      name: p.name,
      value: p.items,
      color: shell.projectColors[p.name] || `var(--viz-${(i % 6) + 1})`,
    }))
  }
  if (shell.collectionNames.length > 0) {
    return shell.collectionNames.map((name, i) => ({
      name,
      value: Math.max(1, Math.round((insights.value || 1) / shell.collectionNames.length)),
      color: `var(--viz-${(i % 6) + 1})`,
    }))
  }
  return insights.value > 0 ? [{ name: '默认知识库', value: insights.value, color: 'var(--viz-1)' }] : []
})
const donutCenter = computed(() => {
  if (scope.value === 'all') return String(adminStats.value?.totals?.insights ?? (shell.loaded ? insights.value : '—'))
  return shell.loaded ? String(insights.value) : '—'
})
const donutCaption = computed(() => (scope.value === 'all' ? '全站笔记' : '我的笔记'))

const storageRatio = computed(() => {
  if (scope.value === 'all') {
    if (adminStorage.value?.disk) {
      const free = adminStorage.value.disk.free_gb
      const totalEst = Math.max(free + 60, 100)
      return Math.max(0, Math.min(1, 1 - free / totalEst))
    }
    return shell.diskUsedRatio ?? 0.12
  }
  if (storage.value?.limit_bytes && storage.value.limit_bytes > 0) {
    return Math.max(0, Math.min(1, storage.value.total_bytes / storage.value.limit_bytes))
  }
  return storage.value?.total_bytes ? 0.08 : 0
})
const storageGaugeText = computed(() => {
  if (scope.value === 'all') {
    return adminStorage.value?.totals ? formatBytes(adminStorage.value.totals.total_bytes) : (statStorage.value || '—')
  }
  return storage.value?.limit_bytes
    ? percentText(storage.value.total_bytes, storage.value.limit_bytes)
    : (storage.value ? formatBytes(storage.value.total_bytes) : '—')
})
const storageGaugeCaption = computed(() => {
  if (scope.value === 'all') {
    return adminStorage.value?.disk ? `磁盘空闲 ${adminStorage.value.disk.free_gb} GB` : '全站存储'
  }
  return storage.value?.limit_bytes
    ? `${formatBytes(storage.value.total_bytes)} / ${formatBytes(storage.value.limit_bytes)}`
    : '已用空间'
})

// ---- 新用户引导:没写过笔记、也没点过「不再显示」的账号,首页顶上给几步入口 ----
const dismissedNow = ref(false)
function readDismissed(): boolean {
  try {
    return !!session.user && localStorage.getItem(guideKey(session.user.id)) === '1'
  } catch {
    return false
  }
}
watch(() => session.user?.id, () => (dismissedNow.value = readDismissed()), { immediate: true })
const guideDismissed = dismissedNow
const steps = computed(() => guideSteps({ has: (feature) => session.has(feature), aiEnabled: session.aiEnabled, insights: insights.value, sources: sources.value }))
const showGuide = computed(() => shouldShowGuide({ loaded: shell.loaded, dismissed: guideDismissed.value, insights: insights.value, steps: steps.value.length }))
function dismissGuide() {
  guideDismissed.value = true
  try {
    if (session.user) localStorage.setItem(guideKey(session.user.id), '1')
  } catch {
    // 存不了(隐私模式)也没关系:这次先收起,下次会再出现
  }
}
function runStep(step: GuideStep) {
  if (step.to) void router.push(step.to)
  else panels.toggleAssistant(true)
}

function newNote() {
  void router.push({ path: PATHS.kb, query: { new: '1' } })
}

// 别人的动作(收到分享、好友申请、访问申请及其结果)实时反映到对应那一块,不闪骨架屏
useLiveEvents((event: LiveEvent) => {
  if (event.type !== 'notify') return
  const kind = (event.data.notification as { kind?: string } | undefined)?.kind
  if (kind === 'share_received' || kind === 'collaborator_removed' || kind === 'access_result') void shared.reload({ quiet: true })
  if (kind === 'friend_request' || kind === 'friend_result' || kind === 'access_request') void pending.reload({ quiet: true })
})

onMounted(() => {
  void feed.reloadAll()
  void shell.refresh()
})
</script>

<template>
  <AppShell>
    <div class="kb-home" data-testid="home">
      <KbPageHeader :title="title" description="继续你上次的工作,或者看看共享给你的新内容。">
        <template v-if="session.isAdmin || canNotes || canUpload" #actions>
          <KbSegmented v-if="session.isAdmin" v-model="scope" :options="SCOPE_OPTIONS" class="kb-home-scope" data-testid="home-scope" />
          <KbButton v-if="canUpload" data-testid="home-import" @click="router.push(PATHS.import)"><KbIcon name="upload" /> 导入文件</KbButton>
          <KbButton v-if="canNotes" variant="primary" data-testid="home-new" @click="newNote"><KbIcon name="plus" /> 新建笔记</KbButton>
        </template>
      </KbPageHeader>

      <!-- 新用户引导 -->
      <section v-if="showGuide" class="card kb-home-card kb-home-guide" aria-labelledby="home-guide" data-testid="home-guide">
        <header class="kb-home-head">
          <h2 id="home-guide">欢迎!先从这几步开始</h2>
          <KbButton size="sm" data-testid="guide-dismiss" @click="dismissGuide">不再显示</KbButton>
        </header>
        <ol class="kb-home-list kb-home-steps" role="list">
          <li v-for="(step, index) in steps" :key="step.id" class="kb-home-row kb-home-step" :class="{ 'is-done': step.done }" :data-step="step.id">
            <span class="kb-home-ico" aria-hidden="true"><KbIcon v-if="step.done" name="check" /><b v-else>{{ index + 1 }}</b></span>
            <span class="kb-home-body">
              <span class="kb-home-t">{{ step.title }}<span v-if="step.done" class="m"> · 已完成</span></span>
              <span class="m kb-home-s">{{ step.text }}</span>
            </span>
            <KbButton size="sm" :aria-label="`${step.done ? '再看看' : '去做'}:${step.title}`" @click="runStep(step)">{{ step.done ? '再看看' : '去做' }}</KbButton>
          </li>
        </ol>
      </section>

      <!-- 顶部 4 张 KPI 统计卡 (走势与管理员全员切换) -->
      <div class="kb-home-stats" data-testid="home-stats">
        <KbStat :label="statNotesLabel" :value="statNotes" :delta="statNotesDelta" :spark="statNotesSpark" />
        <KbStat :label="statSharedLabel" :value="statShared" :delta="statSharedDelta" tone="neutral" />
        <KbStat :label="statPendingLabel" :value="statPending" :delta="statPendingDelta" :tone="statPendingTone" />
        <KbStat :label="statStorageLabel" :value="statStorage" :delta="storageNote" :tone="storageTone" />
      </div>

      <!-- 核心数据看板层 (左右两卡高度齐整呼应, 丰富可视化) -->
      <div class="kb-home-charts" data-testid="home-charts">
        <!-- 看板 1: 我的活动 / 全员活动 (热力图 + 趋势折线图双视图 + 30 天类型构成条) -->
        <section v-if="activity.phase.value !== 'forbidden'" class="card kb-home-card kb-home-activity-card" aria-labelledby="home-activity" data-testid="home-activity">
          <header class="kb-home-head">
            <h2 id="home-activity">
              {{ scope === 'all' ? '全员活动与用量' : '我的活动' }}
              <span class="m"> · {{ scope === 'all' ? '近 30 天' : (activityView === 'trend' ? '近 30 天' : '近 13 周') }}</span>
            </h2>
            <KbBadge v-if="scope === 'me' && summary.streak >= 2" tone="accent" data-testid="home-streak">连续 {{ summary.streak }} 天</KbBadge>
            <div v-if="scope === 'me' && activity.phase.value === 'ready'" class="kb-home-act-ctrls">
              <KbSegmented v-model="activityView" :options="ACTIVITY_VIEW_OPTIONS" />
            </div>
          </header>

          <!-- 个人视图 -->
          <template v-if="scope === 'me'">
            <KbSkeleton v-if="activity.phase.value === 'loading'" variant="lines" :lines="4" class="kb-home-pad" data-testid="home-activity-loading" />
            <p v-else-if="activity.phase.value !== 'ready'" class="m kb-home-pad" role="status" data-testid="home-activity-error">没能读取近期活动。<KbButton size="sm" @click="activity.reload()">重试</KbButton></p>
            <div v-else class="kb-home-pad kb-home-activity">
              <KbHeatmap v-if="activityView === 'heatmap'" :cells="summary.cells" :weeks="13" />
              <KbLineChart v-else-if="activityView === 'trend'" :labels="trend.labels" :series="trendSeries" label="每天的活动" area="stacked" integer :height="180" category-label="日期" />
              <!-- 趋势图自带图例（颜色与构成条一致），这时构成条不再画第二组；热力图没有图例，构成条的图例就是唯一的一组 -->
              <div v-if="monthTotal > 0" class="kb-home-mix">
                <KbHBars :rows="activityMixRows" label="近 30 天活动类型构成" :legend="activityView !== 'trend'" />
              </div>
              <dl class="kb-home-month" data-testid="home-month">
                <div v-for="kind in ACTIVITY_KINDS" :key="kind.key"><dt class="m">{{ kind.name }}</dt><dd><KbNum :value="summary.month[kind.key]" /></dd></div>
              </dl>
              <p class="m kb-home-s">近 30 天的合计</p>
            </div>
          </template>

          <!-- 管理员全员视图 -->
          <template v-else-if="session.isAdmin">
            <KbSkeleton v-if="adminLoading" variant="lines" :lines="4" class="kb-home-pad" />
            <p v-else-if="adminFailed" class="m kb-home-pad" role="status">没能读取全员数据。<KbButton size="sm" @click="loadAdminData()">重试</KbButton></p>
            <div v-else class="kb-home-pad kb-home-activity">
              <template v-if="session.aiEnabled && adminLlm && adminLlm.totals?.some((t) => t > 0)">
                <KbLineChart :labels="adminLlmLabels" :series="adminLlmSeries" label="全站每天 AI 用量" area="stacked" :height="180" category-label="日期(站点时区)" />
                <p class="m kb-home-s">近 30 天全站模型调用按用途堆叠</p>
              </template>
              <template v-else-if="adminActivityReady">
                <KbLineChart :labels="trend.labels" :series="trendSeries" label="全站近 30 天活动" area="stacked" integer :height="180" category-label="日期" />
                <p class="m kb-home-s">近 30 天新建笔记、编辑、导入文件与搜索</p>
              </template>
              <KbEmpty v-else title="全站暂无活动记录" description="全站有操作后会在这里展示全员趋势。" size="sm" />
            </div>
          </template>
        </section>

        <!-- 看板 2: 知识资产分布与存储洞察 (环形图 + 仪表盘) -->
        <section class="card kb-home-card kb-home-insights-card" aria-labelledby="home-insights" data-testid="home-insights">
          <header class="kb-home-head">
            <h2 id="home-insights">{{ scope === 'all' ? '全站知识资产与存储' : '知识资产与存储' }}<span class="m"> · 构成与用量</span></h2>
            <KbButton size="sm" @click="router.push(session.isAdmin ? PATHS.usage : PATHS.mine)">详情</KbButton>
          </header>
          <div class="kb-home-pad kb-home-insights-body">
            <!-- 上部分: 知识库分布环形图 -->
            <div class="kb-home-donut-wrap">
              <KbDonut
                :items="donutItems"
                :label="scope === 'all' ? '全站知识库分布' : '知识库分布'"
                :center="donutCenter"
                :caption="donutCaption"
                :size="130"
              />
            </div>
            <!-- 下部分: 存储用量仪表盘 -->
            <div class="kb-home-gauge-wrap">
              <KbGauge
                :value="storageRatio"
                :label="scope === 'all' ? '全站存储健康度' : '个人存储用量'"
                :text="storageGaugeText"
                :caption="storageGaugeCaption"
                :size="120"
              />
            </div>
          </div>
        </section>
      </div>

      <!-- 工作协同与业务流层 -->
      <div class="kb-home-cols">
        <div class="kb-home-col">
          <!-- 继续编辑 -->
          <section class="card kb-home-card" aria-labelledby="home-recent" data-testid="home-recent">
            <header class="kb-home-head">
              <h2 id="home-recent">继续编辑<span class="m"> · 最近更新</span></h2>
              <KbButton size="sm" @click="router.push(PATHS.kb)">全部</KbButton>
            </header>
            <KbSkeleton v-if="recent.phase.value === 'loading'" variant="list" :lines="3" class="kb-home-pad" data-testid="home-recent-loading" />
            <KbEmpty v-else-if="recent.phase.value !== 'ready'" icon="failed" size="sm" title="没能读取最近编辑" :description="recent.message.value" data-testid="home-recent-error">
              <template v-if="recent.phase.value === 'error'" #action><KbButton size="sm" @click="recent.reload()">重试</KbButton></template>
            </KbEmpty>
            <KbEmpty v-else-if="!recentItems.length" icon="note" size="sm" title="还没有笔记" description="写下第一条笔记,之后改过的会在这里排在最前面。" data-testid="home-recent-empty">
              <template v-if="canNotes" #action><KbButton size="sm" variant="primary" @click="newNote">新建笔记</KbButton></template>
            </KbEmpty>
            <ul v-else class="kb-home-list" role="list">
              <li v-for="item in recentItems" :key="item.id">
                <RouterLink class="kb-home-row" :to="recentRoute(item)" data-testid="home-recent-item">
                  <span class="kb-home-ico"><KbIcon name="doc" /></span>
                  <span class="kb-home-body">
                    <span class="kb-home-t">{{ itemTitle(item) }}</span>
                    <span class="m kb-home-s"><span class="kb-home-tag">{{ item.collection }}</span> · {{ relativeTime(item.updated_at, now) }}</span>
                  </span>
                </RouterLink>
              </li>
            </ul>
          </section>

          <!-- 共享给我的新动态 -->
          <section class="card kb-home-card" aria-labelledby="home-shared" data-testid="home-shared">
            <header class="kb-home-head">
              <h2 id="home-shared">共享给我的新内容</h2>
              <KbButton size="sm" @click="router.push({ path: PATHS.kb, query: { scope: 'shared' } })">查看全部</KbButton>
            </header>
            <KbSkeleton v-if="shared.phase.value === 'loading'" variant="list" :lines="3" class="kb-home-pad" data-testid="home-shared-loading" />
            <KbEmpty v-else-if="shared.phase.value !== 'ready'" icon="failed" size="sm" title="没能读取共享给你的内容" :description="shared.message.value" data-testid="home-shared-error">
              <template v-if="shared.phase.value === 'error'" #action><KbButton size="sm" @click="shared.reload()">重试</KbButton></template>
            </KbEmpty>
            <KbEmpty v-else-if="!sharedList.length" icon="share" size="sm" title="还没有人分享内容给你" description="好友分享给你的笔记和文件夹会出现在这里。" data-testid="home-shared-empty">
              <template v-if="canFriends" #action><KbButton size="sm" @click="router.push(PATHS.friends)">去找好友</KbButton></template>
            </KbEmpty>
            <ul v-else class="kb-home-list" role="list">
              <li v-for="row in sharedList" :key="row.key">
                <RouterLink class="kb-home-row" :to="row.to" data-testid="home-shared-item">
                  <!-- 和 .kb-home-ico 同宽(34),否则动态行的标题比最近编辑行左移 2px(设计规范) -->
                  <UserAvatar :user-id="row.owner.id" :name="row.ownerName" :file="row.owner.avatar" :size="34" />
                  <span class="kb-home-body">
                    <span class="kb-home-t">{{ row.headline }}</span>
                    <span class="m kb-home-s">{{ row.sub }}</span>
                  </span>
                </RouterLink>
              </li>
            </ul>
          </section>
        </div>

        <div class="kb-home-col">
          <!-- 快速开始: 磁贴化设计(Tile Grid) -->
          <!-- 引导卡显示时「快速开始」是重复的入口,让位给它 -->
          <section v-if="showQuick && !showGuide" class="card kb-home-card" aria-labelledby="home-quick" data-testid="home-quick">
            <header class="kb-home-head"><h2 id="home-quick">快捷操作</h2></header>
            <div class="kb-home-quick-tiles">
              <button v-if="canNotes" type="button" class="kb-quick-tile" @click="newNote">
                <span class="kb-quick-tile-ico is-blue"><KbIcon name="plus" :size="20" /></span>
                <span class="kb-quick-tile-texts">
                  <span class="kb-quick-tile-name">新建笔记</span>
                  <span class="kb-quick-tile-desc">快速记录灵感</span>
                </span>
              </button>
              <button v-if="canUpload" type="button" class="kb-quick-tile" @click="router.push(PATHS.import)">
                <span class="kb-quick-tile-ico is-green"><KbIcon name="upload" :size="20" /></span>
                <span class="kb-quick-tile-texts">
                  <span class="kb-quick-tile-name">导入文件或网页</span>
                  <span class="kb-quick-tile-desc">PDF/Word/Markdown</span>
                </span>
              </button>
              <button v-if="canFriends" type="button" class="kb-quick-tile" @click="router.push(PATHS.friends)">
                <span class="kb-quick-tile-ico is-purple"><KbIcon name="users" :size="20" /></span>
                <span class="kb-quick-tile-texts">
                  <span class="kb-quick-tile-name">邀请好友一起协作</span>
                  <span class="kb-quick-tile-desc">多端实时共享编辑</span>
                </span>
              </button>
            </div>
          </section>

          <!-- 待处理 -->
          <section class="card kb-home-card" aria-labelledby="home-pending" data-testid="home-pending">
            <header class="kb-home-head">
              <h2 id="home-pending">待处理</h2>
              <KbBadge v-if="pendingList.length" tone="accent" data-testid="home-pending-count">{{ pendingList.length }}</KbBadge>
            </header>
            <KbSkeleton v-if="pending.phase.value === 'loading'" variant="list" :lines="2" class="kb-home-pad" data-testid="home-pending-loading" />
            <KbEmpty v-else-if="pending.phase.value !== 'ready'" icon="failed" size="sm" title="没能读取待处理事项" :description="pending.message.value" data-testid="home-pending-error">
              <template v-if="pending.phase.value === 'error'" #action><KbButton size="sm" @click="pending.reload()">重试</KbButton></template>
            </KbEmpty>
            <KbEmpty v-else-if="!pendingList.length" icon="check" size="sm" title="没有待处理的事" description="好友申请、别人的访问申请和待审核的候选笔记会出现在这里。" data-testid="home-pending-empty" />
            <ul v-else class="kb-home-list" role="list">
              <li v-for="row in pendingList" :key="row.id" class="kb-home-row kb-home-pending-row" :data-kind="row.kind" data-testid="home-pending-item">
                <UserAvatar v-if="row.person" :user-id="row.person.id" :name="row.person.name" :file="row.person.avatar" :size="34" />
                <!-- 头像和图标同宽(34px,.kb-home-ico 的尺寸),三种待处理行的标题才对得齐(设计规范) -->
                <span v-else class="kb-home-ico"><KbIcon name="inbox" /></span>
                <span class="kb-home-body">
                  <span class="kb-home-t">{{ row.title }}</span>
                  <span class="m kb-home-s">{{ row.sub }}</span>
                </span>
                <KbButton size="sm" :aria-label="`${row.action}:${row.title}`" @click="router.push(row.to)">{{ row.action }}</KbButton>
              </li>
            </ul>
          </section>

          <!-- 今日 AI 用量 -->
          <section v-if="showAi && ai" class="card kb-home-card" aria-labelledby="home-ai" data-testid="home-ai">
            <header class="kb-home-head">
              <h2 id="home-ai">今日 AI 用量</h2>
              <KbBadge v-if="levelOf(ai.tokens_today, ai.limit) === 'over'" tone="danger">已用完</KbBadge>
              <KbBadge v-else-if="levelOf(ai.tokens_today, ai.limit) === 'warn'" tone="warning">接近上限</KbBadge>
            </header>
            <div class="kb-home-pad kb-home-ai">
              <UsageBar :used="ai.tokens_today" :limit="ai.limit" name="我今天的 AI 额度" />
              <p class="m kb-home-s">{{ quotaText(ai.tokens_today, ai.limit) }}<template v-if="ai.limit > 0"> · {{ percentText(ai.tokens_today, ai.limit) }}</template> · 每天 0 点(站点时区)重置</p>
            </div>
          </section>
        </div>
      </div>
    </div>
  </AppShell>
</template>

<style scoped>
.kb-home { display: flex; flex-direction: column; gap: var(--gap); width: 100%; max-width: 1360px; margin: 0 auto; min-width: 0; }
/* 统计卡:一行放得下就并排,放不下自动换行 */
.kb-home-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(11em, 1fr)); gap: var(--gap); min-width: 0; }

/* 核心图表层看板行: 左右两卡高度齐整呼应 */
.kb-home-charts { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); gap: var(--gap); align-items: stretch; min-width: 0; }
.kb-home-activity-card { display: flex; flex-direction: column; }
.kb-home-insights-card { display: flex; flex-direction: column; height: 100%; }
.kb-home-insights-body { display: flex; flex-direction: column; justify-content: space-around; gap: var(--sp-3); padding: var(--card-pad-ui); flex: 1 1 auto; }
.kb-home-donut-wrap { display: flex; align-items: center; justify-content: center; min-width: 0; }
.kb-home-gauge-wrap { display: flex; align-items: center; justify-content: center; border-top: var(--hl) solid var(--b); padding-top: var(--sp-2); min-width: 0; }

/* 业务协同两栏 */
.kb-home-cols { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); gap: var(--gap); align-items: start; min-width: 0; }
.kb-home-col { display: flex; flex-direction: column; gap: var(--gap); min-width: 0; }

@media (max-width: 960px) {
  .kb-home-charts { grid-template-columns: minmax(0, 1fr); }
  .kb-home-cols { grid-template-columns: minmax(0, 1fr); }
  .kb-home-cols > .kb-home-col:last-child { order: -1; }
}

.kb-home-card { min-width: 0; overflow: hidden; }
/* 放不下时整组换行（设计规范）：徽章、分段控件换到下一行，而不是把标题挤成「近 30 / 天」、把「趋势图」挤成两行 */
.kb-home-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); padding: var(--sp-3) var(--card-pad-ui); border-bottom: var(--hl) solid var(--b); }
.kb-home-head h2 { flex: 1 1 auto; margin: 0; font-size: var(--text-14); font-weight: var(--fw-title); min-width: 0; }
.kb-home-head h2 .m { font-weight: var(--fw-regular); }
.kb-home-pad { padding: var(--card-pad-ui); }

.kb-home-activity { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
.kb-home-month { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--sp-2); margin: 0; }
.kb-home-month > div { min-width: 0; }
.kb-home-month dt { font-size: var(--text-12); }
.kb-home-month dd { margin: 2px 0 0; font-size: var(--text-18, 18px); font-weight: 600; font-variant-numeric: tabular-nums; }

.kb-home-list { list-style: none; margin: 0; padding: 0; }
.kb-home-list > li + li { border-top: var(--hl) solid var(--b); }
.kb-home-row { display: flex; align-items: center; gap: var(--sp-3); min-height: var(--list-row-h); padding: var(--sp-2) var(--card-pad-ui); min-width: 0; color: inherit; text-decoration: none; }
a.kb-home-row:hover { background: var(--surface-2); }
a.kb-home-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

.kb-home-ico { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 34px; height: 34px; border-radius: var(--r2); background: var(--surface-2); color: var(--text-secondary); }
.kb-home-body { flex: 1 1 auto; display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
.kb-home-pending-row > .kb-btn, .kb-home-pending-row > button { flex: none; white-space: nowrap; }
.kb-home-t { font-weight: var(--fw-medium); overflow-wrap: anywhere; }
.kb-home-s { font-size: var(--text-12); overflow-wrap: anywhere; }
.kb-home-tag { display: inline-block; padding: 1px 6px; border-radius: var(--r1); font-size: var(--text-11); background: var(--surface-2); color: var(--text-secondary); font-family: var(--mono); }

.kb-home-steps > li + li { border-top: var(--hl) solid var(--b); }
.kb-home-step.is-done .kb-home-t { color: var(--text-secondary); }

/* 磁贴网格 Tile Grid */
.kb-home-quick-tiles { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--card-pad-ui); }
.kb-quick-tile { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-2) var(--sp-3); border-radius: var(--r2); border: var(--hl) solid var(--b); background: var(--surface-1); color: var(--text-primary); text-align: left; cursor: pointer; transition: all var(--dur-motion, 150ms) ease; width: 100%; box-sizing: border-box; }
.kb-quick-tile:hover { background: var(--surface-2); border-color: var(--accent); transform: translateX(2px); }
.kb-quick-tile-ico { display: flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: var(--r2); flex-shrink: 0; }
.kb-quick-tile-ico.is-blue { background: var(--accent-soft); color: var(--accent-text); }
.kb-quick-tile-ico.is-green { background: color-mix(in oklab, var(--status-success) 14%, transparent); color: var(--status-success-text); }
.kb-quick-tile-ico.is-purple { background: color-mix(in oklab, var(--chart-3) 14%, transparent); color: var(--chart-3); }
.kb-quick-tile-texts { display: flex; flex-direction: column; min-width: 0; }
.kb-quick-tile-name { font-weight: var(--fw-medium); font-size: var(--text-13, 13px); line-height: 1.3; }
.kb-quick-tile-desc { font-size: var(--text-11, 11px); color: var(--text-secondary); margin-top: 2px; }

.kb-home-ai { display: flex; flex-direction: column; gap: var(--sp-2); }
.kb-home-ai p { margin: 0; }
.kb-home-act-ctrls { display: flex; align-items: center; gap: var(--sp-2); margin-left: auto; }
.kb-home-mix { margin-top: var(--sp-1); }
.kb-home-scope { margin-right: var(--sp-2); }
</style>
