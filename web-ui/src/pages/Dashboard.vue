<script setup lang="ts">
import { clockText, recentDayKeys } from '@/utils/time'
// 仪表盘(仪表盘设计稿):全部来自真实数据——stats_overview / job_list / job_stats / audit_list / list_projects /
// system_status / eval_history。任务只取第一页(运行中和排队的在前)加服务端统计,不再整份拉 job_list。后端还没提供的趋势类指标(知识条目周增量、P95 延迟、超 24h 草稿)只在
// 字段存在时显示,没有就留空,不再放示意数字。
import { computed, ref, shallowRef, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
import AppShell from '@/layouts/AppShell.vue'
import { KbBarChart, KbDonut, KbIcon, KbJobIcon, KbSelect, KbStat, type BarSeries } from '@kb-ui/index'
import { shareDonut } from '@/utils/dashboardCharts'
import OverviewAccounts from '@/components/admin/OverviewAccounts.vue'
import ActivityTrendCard from '@/components/admin/ActivityTrendCard.vue'
import AdminLoadState from '@/components/admin/AdminLoadState.vue'
import ResourceGaugesCard from '@/components/admin/ResourceGaugesCard.vue'
import {
  callCapability,
  type AuditEntry,
  type JobSummary,
  type Project,
  type StatsOverview,
} from '@/api/client'
import { useLiveEvents } from '@/composables/useLiveEvents'
import { useLiveRefresh } from '@/composables/useLiveRefresh'
import { AI_JOB_KINDS, jobList, jobStats, type JobStats } from '@/api/jobs'
import { PATHS } from '@/router/paths'
import { useShellStore } from '@/stores/shell'
import { failureOf, type LoadPhase } from '@/utils/loadState'
import { onlineCount, providerState, shortNote } from '@/utils/provider'
import { actorText, argsSummary, capabilityText, eventKindText, isAiCapability } from '@/utils/auditText'
import { isAiJob, isAiKind, jobKindText, kindInfo } from '@/utils/systemStatus'
import { useSessionStore } from '@/stores/session'

interface ComponentRow {
  kind: string
  name: string
  installed: boolean
  ready: boolean
  current: boolean
  detail: string | null
  model: string | null
}
interface SystemSnapshot {
  overview?: { components_ready?: [number, number] }
  resources?: {
    cpu?: { busy_ratio: number; cores?: number }
    memory?: { used_ratio: number }
    disk?: { used_ratio: number; free_gb?: number }
    gpu?: { name: string | null; utilization: number | null }
  }
  components?: ComponentRow[]
}
interface EvalRun {
  at: number
  hit_at_k: number
  k: number
  mrr: number
}

const router = useRouter()
const shell = useShellStore()
const session = useSessionStore()
/** AI 总开关:关掉后概览里不出现审核、大模型相关的统计和组件 */
const aiOn = computed(() => session.aiEnabled)
const { projectColors } = storeToRefs(shell)

const stats = ref<StatsOverview | null>(null)
const jobs = shallowRef<JobSummary[]>([])
/** 任务计数(服务端统计,按 AI 开关和所选项目筛过);读不到时退回按取到的那一页数 */
const jobTotals = shallowRef<JobStats | null>(null)
const audit = ref<AuditEntry[]>([])
const projects = ref<{ project: Project; collection: string; rows: number }[]>([])
const system = ref<SystemSnapshot | null>(null)
const evalRuns = ref<EvalRun[]>([])
const project = ref('')
// 第一次读取:读不到 stats_overview 就整页换成「出了什么事 + 重试」(403 单独说明没开通),
// 以前读不到时页面是一排 0 和「读取中…」,既不报错也不能重试。
const phase = ref<LoadPhase>('loading')
const message = ref('')
/** 已经读到过一次之后,后台刷新失败:保留旧数据,只提示一句 */
const refreshFailed = ref(false)
/** 次要数据(任务、事件、项目…)没读到的部分:对应卡片写「没能读到」而不是假装是空的 */
type Part = 'jobs' | 'audit' | 'projects' | 'system' | 'eval'
const failedParts = ref<Part[]>([])

const fmt = (value: number | null | undefined) => (value === null || value === undefined ? '—' : value.toLocaleString())
/** 页头的「更新于 00:42」:最近一次读到数据的时刻(站点时区),不是页面打开的时刻 */
const updatedAt = ref(Date.now())
const updatedText = computed(() => `更新于 ${clockText(updatedAt.value)}`)

/* ------------------------------------------------------------ 项目 / 集合归属 */
const projectOptions = computed(() => [
  { value: '', label: '全部项目' },
  ...projects.value.map((item) => ({ value: item.project.name, label: item.project.name })),
])
/** 集合属于哪个项目:`proj_xxx` 精确匹配,或 `项目名/…` 前缀 */
function ownerOf(collection: string | null | undefined): string {
  if (!collection) return ''
  const hit = projects.value.find(
    (item) => item.collection === collection || collection === item.project.name || collection.startsWith(`${item.project.name}/`),
  )
  return hit?.project.name ?? ''
}
const inScope = (collection: string | null | undefined) => !project.value || ownerOf(collection) === project.value
const colorOf = (name: string) => projectColors.value[name] ?? 'var(--viz-4)'

/* ------------------------------------------------------------ 7 日活动 */
const days = computed(() => {
  void stats.value
  return recentDayKeys(7)
})
const chartLabels = computed(() => days.value.map((day) => day.slice(5)))
const chartSeries = computed<BarSeries[]>(() => {
  const names = projects.value
    .map((item) => item.project.name)
    .sort((left, right) => left.localeCompare(right))
    .filter((name) => !project.value || name === project.value)
  const buckets = new Map<string, number[]>(names.map((name) => [name, days.value.map(() => 0)]))
  const other = days.value.map(() => 0)
  for (const item of stats.value?.activity_7d ?? []) {
    const index = days.value.indexOf(item.day)
    if (index < 0) continue
    const owner = ownerOf(item.collection)
    if (owner && buckets.has(owner)) buckets.get(owner)![index]! += item.insights
    else if (!owner && !project.value) other[index]! += item.insights
  }
  const series: BarSeries[] = names.map((name) => ({ name, color: colorOf(name), values: buckets.get(name)! }))
  if (other.some(Boolean)) series.push({ name: '全局', color: 'var(--viz-4)', values: other })
  return series
})
const dailyTotals = computed(() => days.value.map((_, index) => chartSeries.value.reduce((sum, s) => sum + (s.values[index] ?? 0), 0)))
const weekTotal = computed(() => dailyTotals.value.reduce((sum, value) => sum + value, 0))

/* ------------------------------------------------------------ 指标卡 */
const trends = computed(() => stats.value?.trends)
const lastEval = computed(() => evalRuns.value[0] ?? null)
const evalSpark = computed(() => [...evalRuns.value].reverse().map((run) => run.hit_at_k))
const p95 = computed(() => trends.value?.search_p95)

/* ------------------------------------------------------------ 集合 */
const reindexProgress = (collection: string) => {
  const job = jobs.value.find(
    (item) => item.state === 'running' && ['reindex', 'migrate', 'embed'].includes(item.kind) && item.collection === collection,
  )
  if (!job) return null
  return job.progress_total ? Math.min(100, Math.round((job.progress_done / job.progress_total) * 100)) : 0
}
const collectionRows = computed(() =>
  (stats.value?.collections ?? [])
    .filter((item) => inScope(item.name))
    .map((item) => {
      const progress = reindexProgress(item.name)
      return {
        name: item.name,
        rows: item.rows,
        busy: progress !== null,
        text: progress !== null ? `重建中 ${progress}%` : '已建好',
        percent: progress ?? 100,
      }
    }),
)
const shownCollections = computed(() => collectionRows.value.slice(0, 7))
const share = computed(() => {
  const list = projects.value
    .filter((item) => !project.value || item.project.name === project.value)
    .map((item) => ({ name: item.project.name, rows: item.rows }))
    .filter((item) => item.rows > 0)
    .sort((left, right) => left.name.localeCompare(right.name))
  return list
})
const shareTotal = computed(() => share.value.reduce((sum, item) => sum + item.rows, 0))
// 环形图只列占比最大的几个项目,其余并成「其它」;项目色和上面 7 日柱图是同一套
const shareItems = computed(() => shareDonut(share.value, colorOf))

/* ------------------------------------------------------------ 任务队列 */
// AI 总开关关掉后,自动提炼 / 审核类任务不在概览里出现
const jobScope = computed(() => jobs.value.filter((job) => inScope(job.collection) && (aiOn.value || !isAiJob(job.kind))))
const jobCounts = computed(() => {
  const counted = jobTotals.value?.by_state
  if (counted) return { running: counted.running ?? 0, queued: counted.queued ?? 0 }
  return {
    running: jobScope.value.filter((job) => job.state === 'running').length,
    queued: jobScope.value.filter((job) => job.state === 'queued').length,
  }
})
const dashJobs = computed(() => {
  const rank = (job: JobSummary) => (job.state === 'running' ? 0 : job.state === 'queued' ? 1 : 2)
  return [...jobScope.value]
    .sort((left, right) => rank(left) - rank(right) || (rank(left) < 2 ? left.created_at - right.created_at : (right.finished_at ?? right.created_at) - (left.finished_at ?? left.created_at)))
    .slice(0, 7)
    .map((job) => {
      const percent = job.progress_total ? Math.round((job.progress_done / job.progress_total) * 100) : null
      const ago = Date.now() - (job.finished_at ?? job.created_at)
      const age = ago < 3_600_000 ? `${Math.max(1, Math.round(ago / 60_000))} 分钟前` : ago < 86_400_000 ? `${Math.round(ago / 3_600_000)} 小时前` : `${Math.round(ago / 86_400_000)} 天前`
      const tone: 'danger' | 'success' | 'accent' | 'idle' =
        job.state === 'failed' ? 'danger' : job.state === 'done' ? 'success' : job.state === 'running' ? 'accent' : 'idle'
      return {
        id: job.id,
        kind: jobKindText(job.kind),
        target: job.collection ?? '全部',
        tone,
        text: job.state === 'running' ? `${percent ?? 0}%` : job.state === 'queued' ? '排队' : job.state === 'failed' ? '失败' : job.state === 'done' ? age : '已取消',
      }
    })
})

/* ------------------------------------------------------------ 最近事件 */
interface EventRow {
  key: string
  at: number
  /** 中文名;原始标识放 raw,只进 title,出了问题查日志时对得上 */
  name: string
  raw: string
  detail: string
  dot: string
}
/** 失败的写原因(后端给的是中文就直接用);成功的把参数翻成一行人话,认不得的键不露出来 */
function describe(entry: AuditEntry): string {
  if (!entry.ok && entry.error) return entry.error
  return argsSummary(entry.args_json)
}
// 状态点只是装饰:失败用红点,名字后面还有「失败」二字,不靠颜色传达
const dotFor = (ok: boolean) => (ok ? 'var(--m)' : 'var(--r)')
const HAS_CJK = /[\u4e00-\u9fff]/
const events = computed<EventRow[]>(() => {
  const fromStats = (stats.value?.recent_events ?? [])
    // 会话结束触发的是自动提炼,AI 总开关关掉后不列
    .filter((event) => aiOn.value || event.kind !== 'session_end')
    .map((event) => ({
      key: `e-${event.id}`,
      at: event.received_at,
      name: eventKindText(event.kind),
      raw: event.kind,
      // 后端给的结果如果不是中文(内部标识),不显示
      detail: event.result && HAS_CJK.test(event.result) ? event.result : '',
      dot: dotFor(true),
    }))
  const fromAudit = audit.value
    .filter((entry) => aiOn.value || !isAiCapability(entry.capability))
    .map((entry) => ({
      key: `a-${entry.id}`,
      at: entry.at,
      name: entry.ok ? capabilityText(entry.capability) : `${capabilityText(entry.capability)}失败`,
      raw: `${entry.capability} · ${actorText(entry.actor)}`,
      detail: describe(entry),
      dot: dotFor(entry.ok),
    }))
  return [...fromStats, ...fromAudit].sort((left, right) => right.at - left.at).slice(0, 9)
})

/* ------------------------------------------------------------ 模型与组件 */
/** 组件种类的中文名与系统状态页一致;认不得的种类写「其它组件」,不露后端的英文名 */
const kindLabel = (kind: string) => {
  const label = kindInfo(kind).label
  return label === kind ? '其它组件' : label
}
// 只列「正在使用」的组件(没装的备选后端不是故障,不上概览);AI 总开关关掉后云端模型 / 审核模型也不列
const inUse = computed(() =>
  (system.value?.components ?? []).filter((item) => (item.current || item.kind === 'sidecar') && (aiOn.value || !isAiKind(item.kind))),
)
const modelRows = computed(() =>
  inUse.value.slice(0, 6).map((item) => {
    const state = providerState(item)
    return {
      key: `${item.kind}-${item.name}`,
      label: kindLabel(item.kind),
      name: item.model ? `${item.name} · ${item.model}` : item.name,
      note: shortNote(item),
      full: [item.detail, state.hint].filter(Boolean).join(' —— '),
      dot: state.tone === 'success' ? 'var(--g)' : 'var(--y)',
      warn: state.broken,
    }
  }),
)
const online = computed(() => onlineCount(inUse.value))
const readyTag = computed(() => {
  if (!inUse.value.length) return null
  const { ok, total } = online.value
  return ok === total ? { text: '全部在线', tone: 'g' } : { text: `${ok} / ${total} 在线`, tone: 'y' }
})
/** 有独显/核显利用率就显示它,否则退回 CPU 占用 */
const load = computed(() => {
  const gpu = system.value?.resources?.gpu
  if (gpu?.utilization != null) return { label: `${gpu.name?.includes('Intel') ? '核显' : '显卡'}占用`, ratio: gpu.utilization }
  const cpu = system.value?.resources?.cpu
  return cpu ? { label: 'CPU 占用', ratio: cpu.busy_ratio } : null
})

const openCollection = (name: string) => void router.push({ path: PATHS.kb, query: { collection: name } })

/* ------------------------------------------------------------ 取数 */
async function refresh() {
  let overview: StatsOverview
  try {
    overview = await callCapability<StatsOverview>('stats_overview')
  } catch (err) {
    // 已经有数据时保持旧画面;一次都没成功过才换成整页报错
    if (phase.value === 'ready') {
      refreshFailed.value = true
      return
    }
    const failure = failureOf(err, '读取系统概览')
    phase.value = failure.phase
    message.value = failure.message
    return
  }
  // 次要数据逐个读:任何一个失败只影响自己的那张卡片,并保留上一次读到的内容
  const [listed, audits, projectList, snapshot, history] = await Promise.allSettled([
    loadJobs(),
    callCapability<{ entries: AuditEntry[] }>('audit_list', { page_size: 12 }),
    callCapability<{ projects: { project: Project; collection: string; rows: number }[] }>('list_projects'),
    callCapability<SystemSnapshot>('system_status'),
    callCapability<{ runs: EvalRun[] }>('eval_history'),
  ])
  const failed: Part[] = []
  if (listed.status === 'rejected') failed.push('jobs')
  if (audits.status === 'fulfilled') audit.value = audits.value.entries
  else failed.push('audit')
  if (projectList.status === 'fulfilled') projects.value = projectList.value.projects
  else failed.push('projects')
  if (snapshot.status === 'fulfilled') system.value = snapshot.value
  else failed.push('system')
  if (history.status === 'fulfilled') evalRuns.value = history.value.runs
  else failed.push('eval')
  stats.value = overview
  updatedAt.value = Date.now()
  failedParts.value = failed
  refreshFailed.value = false
  message.value = ''
  phase.value = 'ready'
}
/**
 * 任务卡:第一页(服务端按运行中 → 排队 → 最近结束的排好)+ 计数。选了项目时按这个项目的集合筛,
 * AI 总开关关闭时排除自动提炼 / 审核类任务。读失败时抛出,由 refresh 记到「没能读到」里。
 */
const scopeCollection = computed(() => (project.value ? (projects.value.find((item) => item.project.name === project.value)?.collection ?? '') : ''))
async function loadJobs() {
  const filter = { exclude_kinds: aiOn.value ? [] : [...AI_JOB_KINDS], collection: scopeCollection.value }
  const [listed, totals] = await Promise.all([jobList({ ...filter, page_size: 50 }), jobStats(filter).catch(() => null)])
  jobs.value = listed.jobs
  jobTotals.value = totals?.by_state ? totals : null
}
/** 点「重试」:回到骨架屏再读一次 */
async function init() {
  phase.value = 'loading'
  await live.refresh('manual')
}

/**
 * 刷新节奏(useLiveRefresh):页面可见时每 15 秒一次;没开通(403)重试也不会变,不再轮询。
 * 推送事件合并后再刷新:以前每个进度事件都整页重读 6 个接口,索引高峰时一秒好几次。
 * 列表里已有任务的进度直接改进度,不重读;列表里没有的任务开始跑了才刷新。
 */
const onList = (id: unknown) => typeof id === 'string' && jobs.value.some((job) => job.id === id)
const live = useLiveRefresh({
  load: () => refresh(),
  interval: () => (phase.value === 'forbidden' ? 0 : 15_000),
  events: (event) => event.type === 'job.done' || event.type === 'item.changed' || (event.type === 'job.progress' && !onList(event.data.job_id)),
})
useLiveEvents((event) => {
  if (event.type !== 'job.progress') return
  const data = event.data as { job_id?: string; done?: number; total?: number }
  if (!onList(data.job_id)) return
  jobs.value = jobs.value.map((job) =>
    job.id === data.job_id ? { ...job, progress_done: data.done ?? job.progress_done, progress_total: data.total ?? job.progress_total } : job,
  )
})
// 换项目只重读任务这一块(其余卡片在前端按项目筛)
watch(scopeCollection, () => void loadJobs().catch(() => (failedParts.value = [...new Set([...failedParts.value, 'jobs' as Part])])))
</script>

<template>
  <AppShell rail>
    <!-- 全局顶栏不再有「刷新」:系统概览是监控页,保留一个自己的 -->
    <template #actions>
      <button type="button" class="btn" @click="live.refresh('manual')"><KbIcon name="refresh" /> 刷新</button>
    </template>
    <div class="row">
      <div>
        <div class="kb-page-title">系统概览</div>
        <div class="m kb-page-sub">全站运行概况 · {{ updatedText }}</div>
      </div>
      <div v-if="phase === 'ready'" class="kb-spacer row">
        <KbSelect v-model="project" :options="projectOptions" align="end" />
      </div>
    </div>

    <AdminLoadState v-if="phase !== 'ready'" :phase="phase" :message="message" skeleton="card" @retry="init()" />

    <template v-else>
    <p v-if="refreshFailed" class="m kb-small" role="status" data-testid="overview-stale">最近一次刷新没成功,下面显示的是之前的数据,稍后会自动重试。</p>
    <OverviewAccounts />

    <div class="kb-grid kb-grid-5">
      <KbStat label="内容片段" :value="fmt(stats?.totals.rows)" :delta="trends?.rows?.delta ?? ''" tone="success" :spark="trends?.rows?.series" />
      <KbStat
        label="笔记"
        :value="fmt(stats?.totals.insights)"
        :delta="trends?.insights?.delta ?? (weekTotal ? `+${weekTotal} 近 7 天` : '')"
        tone="success"
        :spark="dailyTotals.some(Boolean) ? dailyTotals : undefined"
      />
      <KbStat
        v-if="aiOn"
        label="待审核候选笔记"
        :value="fmt(stats?.drafts_pending)"
        :delta="trends?.drafts?.stale_24h ? `${trends.drafts.stale_24h} 条超过 24 小时` : ''"
        tone="warning"
      />
      <KbStat
        label="慢查询耗时"
        :value="p95 ? `${p95.ms} 毫秒` : '—'"
        :delta="p95?.delta_ms != null ? `${p95.delta_ms > 0 ? '+' : ''}${p95.delta_ms} 毫秒` : p95 ? '' : '暂无统计'"
        :tone="p95?.delta_ms != null ? (p95.delta_ms <= 0 ? 'success' : 'danger') : 'neutral'"
        :spark="p95?.series"
      />
      <KbStat
        :label="`前 ${lastEval?.k ?? 5} 条命中率`"
        :value="lastEval ? `${Math.round(lastEval.hit_at_k * 100)}%` : '—'"
        :delta="lastEval ? `平均排名得分 ${lastEval.mrr.toFixed(3)}` : failedParts.includes('eval') ? '没能读到评测记录' : '还没跑过评测'"
        :spark="evalSpark.length > 1 ? evalSpark : undefined"
      />
    </div>

    <div class="kb-grid kb-grid-main-side">
      <div class="card dots key">
        <div class="ch">
          <span class="kb-ch-title">近 7 天新增笔记</span>
          <span class="m kb-light kb-ch-hint">· 每天新增的笔记数</span>
        </div>
        <!-- 图例放在头部下面、允许换行:集合多的时候放在头部同一行会把标题挤成竖排,还会盖到右边的卡片上 -->
        <div v-if="chartSeries.length" class="kb-chart-legend" data-testid="activity-legend">
          <span v-for="s in chartSeries" :key="s.name" class="row m kb-legend-item" :title="s.name">
            <span class="dot" :style="{ background: s.color }" style-allow="项目颜色来自数据"></span><span class="kb-legend-name">{{ s.name }}</span>
          </span>
        </div>
        <KbBarChart :labels="chartLabels" :series="chartSeries" empty-text="近 7 天还没有新增笔记" />
      </div>

      <div class="card">
        <div class="ch">
          模型与组件
          <div class="r"><span v-if="readyTag" class="tag" :class="readyTag.tone">{{ readyTag.text }}</span></div>
        </div>
        <div v-for="row in modelRows" :key="row.key" class="kb-model-row" :class="{ 'is-warn': row.warn }" :title="row.full">
          <span class="dot" :style="{ background: row.dot }" style-allow="状态点颜色来自数据"></span>
          <span class="m kb-model-label">{{ row.label }}</span>
          <span class="mono kb-ellipsis">{{ row.name }}</span>
          <span class="m kb-small kb-model-note">{{ row.note }}</span>
        </div>
        <div v-if="!modelRows.length" class="m kb-model-empty">{{ failedParts.includes('system') ? '没能读到模型和组件的状态,稍后会自动重试。' : '没有读到组件信息' }}</div>
        <div v-if="load" class="row m kb-load">
          <span class="kb-small">{{ load.label }}</span>
          <div class="bar kb-fill-x"><i :style="{ width: `${Math.round(load.ratio * 100)}%` }" style-allow="占用率来自数据"></i></div>
          <span class="mono">{{ Math.round(load.ratio * 100) }}%</span>
        </div>
      </div>
    </div>

    <div class="kb-grid kb-grid-triptych kb-grow">
      <div class="card kb-clip">
        <div class="ch">
          集合
          <div class="r m">{{ shownCollections.length }} / {{ collectionRows.length }}</div>
        </div>
        <div v-if="shareItems.length" class="kb-share-wrap" data-testid="share-donut">
          <div class="lbl kb-share-label">内容片段占比</div>
          <KbDonut :items="shareItems" label="各项目的内容片段占比" :center="fmt(project ? shareTotal : stats?.totals.rows)" caption="内容片段" :size="104" />
        </div>
        <div v-if="shownCollections.length" class="kb-ov-head kb-ov-coll" aria-hidden="true">
          <span>集合</span><span class="kb-ov-num">内容片段</span><span>索引</span><span></span>
        </div>
        <ul v-if="shownCollections.length" class="kb-ov-list">
          <li v-for="col in shownCollections" :key="col.name">
            <button type="button" class="kb-ov-item kb-ov-coll" @click="openCollection(col.name)">
              <span class="mono kb-ov-name" :title="col.name">{{ col.name }}</span>
              <span class="mono kb-ov-num" :aria-label="`${fmt(col.rows)} 个内容片段`">{{ fmt(col.rows) }}</span>
              <span class="tag kb-ov-tag" :class="col.busy ? 'y' : 'g'">{{ col.text }}</span>
              <span class="bar kb-ov-bar"><i :style="{ width: `${col.percent}%`, background: col.busy ? 'var(--y)' : undefined }" style-allow="进度来自数据"></i></span>
            </button>
          </li>
        </ul>
        <div v-if="!shownCollections.length" class="m kb-model-empty">{{ failedParts.includes('projects') ? '没能读到项目信息,稍后会自动重试。' : '还没有集合' }}</div>
      </div>

      <div class="card kb-clip">
        <div class="ch">
          任务队列
          <div class="r">
            <span v-if="jobCounts.running" class="tag ac">{{ jobCounts.running }} 个运行中</span>
            <span v-if="jobCounts.queued" class="tag">{{ jobCounts.queued }} 个排队</span>
          </div>
        </div>
        <ul v-if="dashJobs.length" class="kb-ov-list">
          <li v-for="item in dashJobs" :key="item.id">
            <button type="button" class="kb-ov-item kb-ov-job" @click="router.push(PATHS.tasks)">
              <span :class="`kb-job-icon is-${item.tone}`"><KbJobIcon :tone="item.tone" /></span>
              <span class="kb-ov-text"><b>{{ item.kind }}</b><small class="m kb-ellipsis" :title="item.target">{{ item.target }}</small></span>
              <span :class="`kb-job-state is-${item.tone}`">{{ item.text }}</span>
            </button>
          </li>
        </ul>
        <div v-if="!dashJobs.length" class="m kb-model-empty">{{ failedParts.includes('jobs') ? '没能读到任务,稍后会自动重试。' : '队列是空的' }}</div>
        <div v-if="aiOn" class="row kb-job-foot">
          <span class="tag" :class="{ y: (stats?.drafts_pending ?? 0) > 0 }">{{ stats?.drafts_pending ?? 0 }}</span>
          <span>条候选笔记待审核</span>
          <button type="button" class="btn sm pri kb-spacer" @click="router.push(PATHS.review)">去审核 →</button>
        </div>
      </div>

      <div class="card kb-clip">
        <div class="ch">
          最近事件
          <div class="r m">实时 <span class="dot kb-dot-ok"></span></div>
        </div>
        <ul v-if="events.length" class="kb-ov-list">
          <li v-for="ev in events" :key="ev.key" class="kb-ov-event">
            <span class="mono m kb-ov-time">{{ clockText(ev.at) }}</span>
            <span class="dot" :style="{ background: ev.dot }" style-allow="事件类型颜色"></span>
            <span class="kb-ov-evname" :title="ev.raw">{{ ev.name }}</span>
            <span class="t2 kb-ellipsis kb-ov-evdetail" :title="ev.detail">{{ ev.detail }}</span>
          </li>
        </ul>
        <div v-if="!events.length" class="m kb-model-empty">{{ failedParts.includes('audit') ? '没能读到最近的操作记录,稍后会自动重试。' : '还没有事件' }}</div>
      </div>
    </div>
    </template>

    <!-- 趋势与本机资源:放在最下面,上面的集合、任务、事件仍在首屏 -->
    <div v-if="phase === 'ready'" class="kb-grid kb-grid-main-side kb-ov-trend">
      <ActivityTrendCard />
      <ResourceGaugesCard
        :cpu="system?.resources?.cpu?.busy_ratio ?? null"
        :memory="system?.resources?.memory?.used_ratio ?? null"
        :disk="system?.resources?.disk?.used_ratio ?? null"
        :cores="system?.resources?.cpu?.cores ?? null"
        :disk-free-gb="system?.resources?.disk?.free_gb ?? null"
      />
    </div>
  </AppShell>
</template>

<style>
/* 「模型运行服务」六个字比原来的 62px 标签列宽,会压到后面的名字上:标签列按字数留宽 */
.kb-grid .kb-model-row{grid-template-columns:6px 7em minmax(0,1fr) minmax(0,auto)}
/* 概览底部三张列表卡:用 ul / button 排版而不是 table。手机上全局样式会把 table 拆成卡片列表,
   表头消失、列错位;这里窄屏自己换成「两行一条」。只用 token。 */
.kb-ov-list{list-style:none;margin:0;padding:0}
.kb-ov-list > li{border-bottom:var(--hl) solid var(--b)}
.kb-ov-list > li:last-child{border-bottom:0}
.kb-ov-item{display:grid;align-items:center;gap:var(--gap-xs) var(--gap-sm);width:100%;min-height:44px;padding:var(--gap-xs) 14px;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.kb-ov-item:hover{background:var(--table-row-hover)}
.kb-ov-item:focus-visible{outline:none;box-shadow:inset var(--accent-ring)}
.kb-ov-head{display:grid;gap:var(--gap-sm);padding:var(--gap-xs) 14px;font-size:calc(12px * var(--fs));color:var(--m);border-bottom:var(--hl) solid var(--b)}
.kb-ov-coll{grid-template-columns:minmax(0,1fr) auto auto 96px}
.kb-ov-head.kb-ov-coll{grid-template-columns:minmax(0,1fr) auto auto 96px}
.kb-ov-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-ov-num{text-align:right}
.kb-ov-tag{flex:0 0 auto;white-space:nowrap}
.kb-ov-bar{display:block}
.kb-ov-job{grid-template-columns:24px minmax(0,1fr) auto}
.kb-ov-text{display:flex;flex-direction:column;min-width:0}
.kb-ov-text small{font-size:calc(12px * var(--fs))}
.kb-ov-event{display:grid;grid-template-columns:auto auto auto minmax(0,1fr);align-items:center;gap:var(--gap-xs) var(--gap-sm);padding:var(--gap-xs) 14px;min-height:36px}
.kb-ov-evname{white-space:nowrap}
.kb-ov-evdetail{min-width:0}
@media (max-width:639px){
  .kb-ov-coll{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"name tag" "num bar"}
  .kb-ov-coll .kb-ov-name{grid-area:name}
  .kb-ov-coll .kb-ov-tag{grid-area:tag}
  .kb-ov-coll .kb-ov-num{grid-area:num;text-align:left}
  .kb-ov-coll .kb-ov-bar{grid-area:bar}
  .kb-ov-head.kb-ov-coll{display:none}
  .kb-ov-event{grid-template-columns:auto auto minmax(0,1fr);grid-template-areas:"time dot name" ". . detail"}
  .kb-ov-event .kb-ov-time{grid-area:time}
  .kb-ov-event .dot{grid-area:dot}
  .kb-ov-event .kb-ov-evname{grid-area:name}
  .kb-ov-event .kb-ov-evdetail{grid-area:detail}
}
</style>
