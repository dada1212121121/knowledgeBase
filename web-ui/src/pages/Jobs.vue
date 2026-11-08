<script setup lang="ts">
import { clockText, isToday, stampText } from '@/utils/time'
// 任务 / 审计日志 / 批次(任务审计设计稿):三个页签共用一个页面,/jobs 与 /audit 都进这里。
// 任务页签:指标 + 图表 + 任务表(服务端分页,点行看详情)+ 最近写入批次;审计与批次页签是完整列表。
//
// 卡 A:任务能累积到上万个(生产上 1.4 万,整份 4 MB),以前每 10 秒、每完成一个任务都整份重取。现在:
// 表格一页 50 个(job_list 分页,筛选在服务端),指标和图表用 job_stats(SQL 聚合),
// 详情用 job_get 的摘要模式;刷新节奏走 useLiveRefresh(可见才轮询、事件合并)。
import { PATHS } from '@/router/paths'
import { computed, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import AppShell from '@/layouts/AppShell.vue'
import { KbBadge, KbButton, KbDialog, KbDonut, KbEmpty, KbHBars, KbJobIcon, KbNum, KbPager, KbResponsiveTable, KbSelect, KbSheet, KbSkeleton, KbTabs, PHONE_QUERY, useMedia, useToast, type RtColumn, type TabItem } from '@kb-ui/index'
import type { BatchView, JobSummary } from '@/api/client'
import { AI_JOB_KINDS, jobBrief, jobFiles, jobList, jobStats, type FileChange, type JobBrief, type JobFileRow, type JobState, type JobStats } from '@/api/jobs'
import { useLiveEvents } from '@/composables/useLiveEvents'
import { useLiveRefresh } from '@/composables/useLiveRefresh'
import { useFeature } from '@/composables/useFeature'
import { useShellStore } from '@/stores/shell'
import AuditPanel from '@/components/admin/AuditPanel.vue'
import BatchPanel from '@/components/admin/BatchPanel.vue'
import JobFiles from '@/components/admin/JobFiles.vue'
import JobFlowCharts from '@/components/admin/JobFlowCharts.vue'
import StatusRows from '@/components/admin/StatusRows.vue'
import { useSessionStore } from '@/stores/session'
import { jobKindText } from '@/utils/systemStatus'
import { extractInsightId, isFilePath, isMultiFiles, jobCardTimes, jobDetailRows, jobErrorSamples, jobTargetFiles, jobTargetInsight } from '@/utils/jobView'
import { durationDistribution, kindGroups, stateBreakdown } from '@/utils/jobCharts'
import { useViewCall } from '@/composables/useViewCall'

/** 嵌入管理员查看弹窗时复用本页:只读、不接管地址栏、所有调用带目标用户。 */
const props = withDefaults(defineProps<{ embedded?: boolean; readonly?: boolean; viewAs?: string }>(), {
  embedded: false,
  readonly: false,
  viewAs: '',
})
const callCapability = useViewCall(() => props.viewAs)
const callOptions = computed(() => (props.viewAs ? { adminView: props.viewAs } : {}))

const route = useRoute()
const router = useRouter()
const toast = useToast()
const shell = useShellStore()
const session = useSessionStore()
/** 系统状态页(服务日志)只对有运维权限的人开放;没有就不放这个链接 */
const canOps = useFeature('sys.ops')

type Tab = 'jobs' | 'audit' | 'batches'
const tab = ref<Tab>(props.embedded ? 'jobs' : route.path === PATHS.audit ? (route.query.tab === 'batches' ? 'batches' : 'audit') : 'jobs')

/** 当前这一页的任务(服务端已经按「运行中 → 排队 → 最近结束的」排好、按筛选条件过滤好) */
const pageJobs = shallowRef<JobSummary[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(50)
/** 指标卡和图表的数字(服务端聚合);和表格的筛选无关,回答的是「整体怎么样」 */
const stats = shallowRef<JobStats | null>(null)
const live = shallowRef<Record<string, { done: number; total: number | null; rate: number | null }>>({})
const batches = ref<BatchView[]>([])
const batchTotal = ref(0)
const selectedId = ref<string | null>(null)
const stateFilter = ref('all')
const kindFilter = ref('all')
/** 第一次取回之前显示骨架屏;取不到(一次都没成功过)显示整块报错 + 重试;成功过之后再失败只提示「显示的是旧数据」 */
const jobsLoaded = ref(false)
const batchesLoaded = ref(false)
const loadError = ref('')
const refreshFailed = ref(false)
const newTask = ref('')
const phone = useMedia(PHONE_QUERY)
/** 手机上点一张任务卡,详情放进底部弹层(桌面上详情卡就在表格下面) */
const detailOpen = ref(false)

/**
 * AI 总开关关闭后,自动提炼 / 审核类任务不出现(术语表:关闭后界面无 AI 相关内容;
 * 系统状态页的「最近任务」也是同样处理)。列表和统计都让服务端排除,数字和表格对得上。
 */
const excludeKinds = computed(() => (session.aiEnabled ? [] : [...AI_JOB_KINDS]))

/* ---------------------------------------------------------------- 格式化 */
function stamp(at: number | null) {
  if (!at) return '—'
  return isToday(at) ? clockText(at) : stampText(at)
}
function duration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
const percent = (job: JobSummary) => {
  const entry = live.value[job.id]
  const done = entry?.done ?? job.progress_done
  const total = entry?.total ?? job.progress_total
  if (job.state === 'done') return 100
  return total ? Math.min(100, Math.round((done / total) * 100)) : 0
}
const elapsed = (job: JobSummary) => (job.started_at ? duration((job.finished_at ?? Date.now()) - job.started_at) : '—')
/** 手机卡片:排队中的任务没有进度可言,不画 0% 的进度条,时间行写已等多久(utils/jobView.ts) */
const cardTimes = (job: JobSummary) => jobCardTimes(job, Date.now(), stamp)

/* ---------------------------------------------------------------- 筛选 */
// 类型筛选按中文名合并:evolve 和 extract 在界面上都叫「自动提炼」,选它两种都要(utils/jobCharts.ts)
const kindGroupList = computed(() => kindGroups(stats.value?.kinds ?? []))
const kindOptions = computed(() => [{ value: 'all', label: '全部类型' }, ...kindGroupList.value.map((group) => ({ value: group.label, label: group.label }))])
const selectedKinds = computed(() => (kindFilter.value === 'all' ? [] : (kindGroupList.value.find((group) => group.label === kindFilter.value)?.kinds ?? [])))
const stateOptions = [
  { value: 'all', label: '全部' },
  { value: 'running', label: '运行中' },
  { value: 'queued', label: '排队' },
  { value: 'done', label: '完成' },
  { value: 'failed', label: '失败' },
  { value: 'canceled', label: '已取消' },
]
/** 这一次要的那一页;请求回来时条件已经变了(用户又点了筛选)就丢掉,免得旧结果闪一下 */
const listQuery = computed(() => ({
  page: page.value,
  page_size: pageSize.value,
  states: stateFilter.value === 'all' ? [] : [stateFilter.value as JobState],
  kinds: selectedKinds.value,
  exclude_kinds: excludeKinds.value,
}))

/* ---------------------------------------------------------------- 指标与图表 */
const count = (state: JobState) => stats.value?.by_state?.[state] ?? 0
const metrics = computed(() => {
  const value = stats.value
  const running = count('running')
  const queued = count('queued')
  const recent = value?.recent
  const failed = recent?.failed ?? 0
  const done = recent?.done ?? 0
  const first = value?.queue?.first_running
  const oldest = value?.queue?.oldest_queued_at
  const pending = value?.pending
  return {
    running,
    runningNote: running && first ? `${jobKindText(first.kind)} · ${first.collection ?? '全部'}` : '空闲',
    queued,
    queuedNote: queued && oldest ? `最早已等 ${duration(Date.now() - oldest)}` : '队列是空的',
    pending: pending?.chunks ?? 0,
    // 待补向量不是「任务」,是文本阶段先写进去、还没补向量的块;ETA 只在有运行中任务时才有
    pendingNote: pending?.chunks
      ? `${pending.files} 个文件${pending.eta_secs ? ` · 预计 ${duration(pending.eta_secs * 1000)}` : ''}`
      : '没有待补内容',
    failed,
    failedNote: failed + done ? `失败率 ${((failed / (failed + done)) * 100).toFixed(1)}%` : '近 24h 没有任务',
    done,
    doneNote: recent?.avg_ms ? `平均 ${duration(recent.avg_ms)}` : '—',
  }
})
// 图表:状态分布看全部任务(不受表格的状态 / 类型筛选影响),用时分布只看已完成的;AI 总开关关闭后 AI 任务本来就不在统计里
const stateItems = computed(() => stateBreakdown(stats.value?.by_state ?? {}))
const durationRows = computed(() => durationDistribution(stats.value?.durations?.buckets ?? []))
const durationNote = computed(() => {
  const durations = stats.value?.durations
  if (typeof durations?.median_ms !== 'number') return ''
  const p95 = typeof durations.p95_ms === 'number' ? `,95% 在 ${duration(durations.p95_ms)} 内跑完` : ''
  return `一般要跑多久:中位数 ${duration(durations.median_ms)}${p95}。`
})

// mobile:手机上卡片的版式在模板的 card 插槽里自己排(状态图标 + 类型 + 进度条),这里只标哪些列在卡片里算次要信息
const columns: RtColumn[] = [
  { key: 'icon', label: '', width: '24px', cellClass: 'kb-job-cell', mobile: 'hidden' },
  { key: 'id', label: 'ID', cellClass: 'mono m', mobile: 'meta' },
  { key: 'kind', label: '类型', mobile: 'primary' },
  { key: 'target', label: '目标', mobile: 'meta' },
  { key: 'detail', label: '详情', clip: true, cellClass: 'm kb-detail-cell', mobile: 'meta' },
  { key: 'progress', label: '进度', cellClass: 'kb-progress-cell', mobile: 'meta' },
  // 开始 / 耗时是纯数字列:按 视觉基线规范「数字列右对齐」右对齐,位数不同时右边缘才齐
  { key: 'started', label: '开始', cellClass: 'mono m', align: 'right', mobile: 'meta' },
  { key: 'took', label: '耗时', cellClass: 'mono m', align: 'right', mobile: 'meta' },
]
const STATE_TEXT: Record<string, string> = { running: '运行中', queued: '排队', done: '完成', failed: '失败', canceled: '已取消' }
/**
 * 「详情」列显示什么:失败的任务先显示失败原因(error),其它显示 detail。
 * 以前一律 detail 优先,失败的任务只要带着 detail,原因就被盖住,用户看不到它为什么失败。
 */
const detailText = (job: JobSummary): string => (job.state === 'failed' ? (job.error ?? job.detail ?? '') : (job.detail ?? job.error ?? ''))
const stateText = (job: JobSummary) => STATE_TEXT[job.state] ?? job.state
const stateTone = (job: JobSummary) => (job.state === 'failed' ? 'danger' : job.state === 'done' ? 'success' : job.state === 'running' ? 'accent' : ('neutral' as const))
const tone = (job: JobSummary) => (job.state === 'failed' ? 'danger' : job.state === 'done' ? 'success' : job.state === 'running' ? 'accent' : 'idle')
const batchRows = computed(() => batches.value.slice(0, 8))
const selected = computed(() => pageJobs.value.find((job) => job.id === selectedId.value) ?? null)
function pickJob(row: JobSummary) {
  selectedId.value = row.id
  if (phone.value) detailOpen.value = true
}

/* ---------------------------------------------------------------- 详情 */
// 详情只取选中的那一个,而且是摘要(索引任务的参数里有整份文件清单,单个最大 3.45 MB)
const detail = shallowRef<JobBrief | null>(null)
const detailLoading = ref(false)
const detailFailed = ref(false)
let detailSeq = 0
async function loadDetail() {
  const id = selectedId.value
  const seq = ++detailSeq
  if (!id) {
    detail.value = null
    return
  }
  detailLoading.value = !detail.value || detail.value.id !== id
  try {
    const found = await jobBrief(id, callOptions.value)
    if (seq !== detailSeq) return
    detail.value = found
    detailFailed.value = false
  } catch {
    if (seq !== detailSeq) return
    detailFailed.value = true
  } finally {
    if (seq === detailSeq) detailLoading.value = false
  }
}
/* ------------------------------------------------------- 改动的文件(job_files) */
// 摘要模式把 payload.paths 截到 10 条,全量索引几千个文件看不全;逐文件结果单独分页取。
// 老任务没有这张表的记录,这里返回空清单,组件会回退到任务参数里的路径。
const changedFiles = shallowRef<JobFileRow[]>([])
const changedTotal = ref(0)
const changedCounts = shallowRef<Partial<Record<FileChange, number>>>({})
const changedPage = ref(0)
const changedLoading = ref(false)
const changedFailed = ref(false)
/** 当前清单属于哪个任务:换任务时先清空,免得读出来之前显示上一个任务的文件 */
const changedJobId = ref<string | null>(null)
let changedSeq = 0

async function loadChangedFiles(reset = true) {
  const id = selectedId.value
  const seq = ++changedSeq
  if (!id) {
    changedFiles.value = []
    changedTotal.value = 0
    changedCounts.value = {}
    changedJobId.value = null
    changedPage.value = 0
    return
  }
  if (reset && changedJobId.value !== id) {
    changedFiles.value = []
    changedTotal.value = 0
    changedCounts.value = {}
    changedJobId.value = id
    changedFailed.value = false
  }
  changedLoading.value = true
  try {
    const found = await jobFiles(id, reset ? 1 : changedPage.value + 1, 200, callOptions.value)
    if (seq !== changedSeq || id !== selectedId.value) return
    changedFiles.value = reset ? found.items : [...changedFiles.value, ...found.items]
    changedTotal.value = found.total
    changedCounts.value = found.counts
    changedPage.value = found.page
    changedFailed.value = false
  } catch {
    if (seq !== changedSeq || id !== selectedId.value) return
    changedFailed.value = true
    if (reset) {
      changedFiles.value = []
      changedTotal.value = 0
      changedCounts.value = {}
    }
  } finally {
    if (seq === changedSeq) changedLoading.value = false
  }
}

// 选中换了、或者选中的任务状态变了(跑完了 / 失败了),重读一次详情和文件清单
watch(() => `${selectedId.value}|${selected.value?.state ?? ''}`, () => {
  void loadDetail()
  void loadChangedFiles()
})
const detailRows = computed(() => (detail.value ? jobDetailRows({ ...detail.value, ...(selected.value ?? {}) }, Date.now(), stamp) : []))
const errorSamples = computed(() => (detail.value ? jobErrorSamples(detail.value) : []))
const failure = computed(() => (selected.value?.state === 'failed' ? (selected.value.error ?? detail.value?.error ?? '') : ''))
const targetFiles = computed(() => (detail.value ? jobTargetFiles(detail.value) : []))
const targetInsight = computed(() => (detail.value ? jobTargetInsight(detail.value) : null))

const filesDialogOpen = ref(false)
const dialogJob = shallowRef<JobSummary | null>(null)
const dialogDetail = shallowRef<JobBrief | null>(null)
const dialogLoading = ref(false)
const dialogFileRows = shallowRef<JobFileRow[]>([])
const dialogFileTotal = ref(0)
const dialogFileCounts = shallowRef<Partial<Record<FileChange, number>>>({})
const dialogFilePage = ref(0)
const dialogFilesLoading = ref(false)
const dialogFilesFailed = ref(false)
let dialogSeq = 0

/** 对话框里的清单:和详情卡同一套分页,几千个文件也不会一次塞进 DOM */
async function loadDialogFiles(reset = true) {
  const job = dialogJob.value
  if (!job) return
  const seq = ++dialogSeq
  if (reset) {
    dialogFileRows.value = []
    dialogFileTotal.value = 0
    dialogFileCounts.value = {}
  }
  dialogFilesLoading.value = true
  try {
    const found = await jobFiles(job.id, reset ? 1 : dialogFilePage.value + 1, 200, callOptions.value)
    if (seq !== dialogSeq) return
    dialogFileRows.value = reset ? found.items : [...dialogFileRows.value, ...found.items]
    dialogFileTotal.value = found.total
    dialogFileCounts.value = found.counts
    dialogFilePage.value = found.page
    dialogFilesFailed.value = false
  } catch {
    if (seq === dialogSeq) dialogFilesFailed.value = true
  } finally {
    if (seq === dialogSeq) dialogFilesLoading.value = false
  }
}

async function openFilesDialog(job: JobSummary) {
  dialogSeq += 1 // 上一个对话框还没回来的请求作废
  dialogJob.value = job
  filesDialogOpen.value = true
  dialogFilesFailed.value = false
  void loadDialogFiles()
  // 摘要(路径清单 / 经验笔记)和逐文件记录一起取,谁先回来都行
  if (detail.value && detail.value.id === job.id) {
    dialogDetail.value = detail.value
    return
  }
  dialogLoading.value = true
  try {
    dialogDetail.value = await jobBrief(job.id, callOptions.value)
  } catch {
    dialogDetail.value = null
  } finally {
    dialogLoading.value = false
  }
}

const dialogFallbackPaths = computed(() => (dialogDetail.value ? jobTargetFiles(dialogDetail.value) : []))
const dialogInsight = computed(() => (dialogDetail.value ? jobTargetInsight(dialogDetail.value) : null))
/** 三种来源至少有一个,否则对话框直接说「没有记录」 */
const dialogHasFiles = computed(
  () =>
    dialogFileTotal.value > 0 ||
    dialogFileRows.value.length > 0 ||
    dialogFilesFailed.value ||
    dialogFallbackPaths.value.length > 0 ||
    Boolean(dialogInsight.value),
)

// 失败任务的单元格显示的是失败原因(例如「sidecar timeout · 重试 1/3」),它不是文件也不是笔记:
// isFilePath 只看有没有「/」或扩展名,原因里的「1/3」会被当成路径,变成指向不存在文件的新标签页链接,
// 还会盖住整行的点击(点原因文字不再选中这一行,详情卡打不开)。所以失败原因一律按普通文字显示
const cellShowsError = (row: JobSummary): boolean => row.state === 'failed' && !!row.error
function isCellLinkableFile(row: JobSummary): boolean {
  return !cellShowsError(row) && isFilePath(detailText(row))
}
function isCellMultiFiles(row: JobSummary): boolean {
  return !cellShowsError(row) && isMultiFiles(detailText(row))
}
function cellInsightId(row: JobSummary): string | null {
  return cellShowsError(row) ? null : extractInsightId(detailText(row))
}

/* ---------------------------------------------------------------- 批次 / 审计 */
const batchState = (batch: BatchView) => {
  if (batch.reverted_at) return { text: '已撤销', tone: 'y' }
  if (!batch.changes.length) return { text: '只读', tone: 'm' }
  if (!batch.changes.some((change) => change.revertible)) return { text: '已提交', tone: 'g' }
  // 删除 / 驳回类的批次回滚会改回数据,用黄色提醒
  const risky = batch.changes.some((change) => /delete|reject/.test(change.op ?? ''))
  return { text: '可回滚', tone: risky ? 'y' : 'g' }
}
/** 最近写入批次的小表(任务页签底部) */
const batchColumns: RtColumn[] = [
  { key: 'id', label: '批次', cellClass: 'mono m', mobile: 'meta' },
  { key: 'actor', label: '来源', cellClass: 'kb-src-cell', mobile: 'meta' },
  { key: 'description', label: '操作', cellClass: 'mono kb-op-cell', mobile: 'primary' },
  { key: 'protocol', label: 'MCP 协议', cellClass: 'mono m', mobile: 'hidden' },
  { key: 'state', label: '状态', mobile: 'meta' },
]

/* ---------------------------------------------------------------- 取数 */
const safe = <T,>(promise: Promise<T>) => promise.catch(() => null)

async function loadJobs() {
  const query = listQuery.value
  const key = JSON.stringify(query)
  try {
    const [listed, summary] = await Promise.all([jobList(query, callOptions.value), jobStats({ exclude_kinds: query.exclude_kinds }, callOptions.value)])
    // 请求在路上时条件变了:丢掉这份结果,useLiveRefresh 会紧接着按新条件再取一次
    if (key !== JSON.stringify(listQuery.value)) return
    pageJobs.value = listed.jobs
    total.value = listed.total
    stats.value = summary
    // 刚取回的进度是最新的:推送攒下的旧进度清掉,免得盖住它(也让这张表不随时间变大)
    live.value = {}
    // 这一页翻没了(任务变少、筛选后不够那么多页):退到最后一页
    const last = Math.max(1, Math.ceil(listed.total / pageSize.value))
    if (page.value > last) page.value = last
    if (!selectedId.value || !listed.jobs.some((job) => job.id === selectedId.value)) selectedId.value = listed.jobs[0]?.id ?? null
    jobsLoaded.value = true
    loadError.value = ''
    refreshFailed.value = false
  } catch (err) {
    // 一次都没成功过:整块报错并给重试;成功过(轮询失败)就保留旧数据,只提示一句
    if (jobsLoaded.value) refreshFailed.value = true
    else loadError.value = err instanceof Error && /[\u4e00-\u9fff]/.test(err.message) ? err.message : '读取任务失败。检查网络后重试,仍然不行请到系统状态页看看服务是否正常。'
  }
}
async function retryJobs() {
  loadError.value = ''
  jobsLoaded.value = false
  await liveJobs.refresh('manual')
}
async function refreshBatches() {
  const result = await safe(callCapability<{ batches: BatchView[]; total: number }>('batch_list', { page: 1, page_size: 20 }))
  if (result) {
    batches.value = result.batches
    batchTotal.value = result.total
    batchesLoaded.value = true
  }
}
async function cancel(job: JobSummary) {
  if (props.readonly) return
  try {
    await callCapability('job_cancel', { id: job.id })
    toast.push(`已取消 ${job.id}`)
    await liveJobs.refresh('manual')
    void shell.refresh(true)
  } catch (err) {
    toast.push(err instanceof Error ? err.message : '取消失败,请稍后再试', 'danger')
  }
}
/* 新任务:对已登记的项目发起索引(能力层目前只有这一类可由用户直接排队的任务) */
const projectNames = ref<string[]>([])
const newTaskOptions = computed(() =>
  projectNames.value.flatMap((name) => [
    { value: `incremental:${name}`, label: `增量索引 · ${name}` },
    { value: `full:${name}`, label: `全量索引 · ${name}` },
  ]),
)
async function startTask(value: string | number) {
  if (props.readonly) return
  const [mode, ...rest] = String(value).split(':')
  const name = rest.join(':')
  newTask.value = ''
  if (!name) return
  try {
    await callCapability('reindex_project', { project: name, mode })
    toast.push(`${name}:${mode === 'full' ? '全量' : '增量'}索引已入队`)
    await liveJobs.refresh('manual')
    void shell.refresh(true)
  } catch (err) {
    toast.push(err instanceof Error ? err.message : '没能投递任务,请稍后再试', 'danger')
  }
}

/* ---------------------------------------------------------------- 页签 */
const tabs = computed<TabItem[]>(() => [
  { value: 'jobs', label: '任务', count: stats.value?.total ?? 0 },
  { value: 'audit', label: '审计日志' },
  { value: 'batches', label: '批次', count: batchTotal.value },
])
function onTab(value: string) {
  if (props.embedded) return
  tab.value = value as Tab
  if (value === 'jobs') void router.replace({ path: PATHS.tasks })
  else void router.replace({ path: PATHS.audit, query: value === 'batches' ? { tab: 'batches' } : {} })
}
watch(
  () => [route.path, route.query.tab],
  () => {
    if (props.embedded) return
    tab.value = route.path === PATHS.audit ? (route.query.tab === 'batches' ? 'batches' : 'audit') : 'jobs'
  },
)

/* ---------------------------------------------------------------- 刷新节奏 */
const onPage = (id: unknown) => typeof id === 'string' && pageJobs.value.some((job) => job.id === id)
/** 有任务在跑或在排队时 10 秒一次,空闲时 30 秒一次(状态变化本来就有推送,轮询只是兜底) */
const busy = () => count('running') + count('queued') > 0
const liveJobs = useLiveRefresh({
  load: () => loadJobs(),
  interval: () => (busy() ? 10_000 : 30_000),
  // 任务结束要刷新;进度事件只在「这一页上没有这个任务」时刷新(新任务开始跑了),页上的任务进度直接更新进度条
  events: (event) => event.type === 'job.done' || (event.type === 'job.progress' && !onPage(event.data.job_id)),
})
// 换筛选回到第一页;翻页、换筛选、AI 开关变化都立刻按新条件取
watch([stateFilter, kindFilter], () => (page.value = 1))
watch(() => JSON.stringify(listQuery.value), () => void liveJobs.refresh('manual'))

void (async () => {
  if (props.readonly) {
    // 只读查看没有「新任务」,就不要为它去读项目列表(那个能力也不在只读白名单里)
    await refreshBatches()
    return
  }
  const [projects] = await Promise.all([safe(callCapability<{ projects: { project: { name: string } }[] }>('list_projects')), refreshBatches()])
  projectNames.value = projects?.projects.map((item) => item.project.name) ?? []
})()
useLiveEvents((event) => {
  if (event.type !== 'job.progress') return
  const data = event.data as { job_id?: string; done?: number; total?: number; rate?: number }
  if (data.job_id && onPage(data.job_id)) live.value = { ...live.value, [data.job_id]: { done: data.done ?? 0, total: data.total ?? null, rate: data.rate ?? null } }
})
</script>

<template>
  <component :is="embedded ? 'div' : AppShell" v-bind="embedded ? {} : { bare: true, rail: true }" :class="{ 'kb-jobs-embed': embedded }">
    <template #breadcrumb><b>{{ tab === 'jobs' ? '任务' : '审计 / 批次' }}</b></template>
    <template #actions><span class="kb-none"></span></template>

    <div class="kb-jobs" data-testid="jobs" :class="{ 'is-embedded': embedded }">
      <KbTabs v-if="!embedded" :model-value="tab" :tabs="tabs" @update:model-value="onTab" />

      <!-- 筛选和「+ 新任务」单独一行:放在页签右侧时,手机上会被挤出屏幕(新任务根本点不到) -->
      <div v-if="tab === 'jobs'" class="kb-jobs-bar" data-testid="jobs-bar">
        <KbSelect v-model="stateFilter" :options="stateOptions" prefix="状态: " size="sm" aria-label="按状态筛选" />
        <KbSelect v-model="kindFilter" :options="kindOptions" display="类型" size="sm" aria-label="按类型筛选" />
        <span class="kb-spacer"></span>
        <KbSelect v-if="!readonly" v-model="newTask" :options="newTaskOptions" display="+ 新任务" size="sm" primary :caret="false" align="end" aria-label="新任务" @update:model-value="startTask" />
      </div>

      <div class="content">
        <!-- 任务 -->
        <template v-if="tab === 'jobs'">
          <KbEmpty v-if="loadError" icon="failed" title="没能读取任务" :description="loadError" data-testid="jobs-error">
            <template #action><KbButton variant="primary" @click="retryJobs">重新加载</KbButton></template>
          </KbEmpty>
          <template v-else>
            <p v-if="refreshFailed" class="m kb-jobs-stale" role="status" data-testid="jobs-stale">最近一次刷新没成功,下面显示的是之前的数据,稍后会自动重试。</p>
            <div class="kb-grid kb-grid-5">
              <div class="card metric"><div class="k">运行中</div><div class="v kb-accent"><KbNum :value="metrics.running" /></div><div class="s">{{ metrics.runningNote }}</div></div>
              <div class="card metric"><div class="k">排队</div><div class="v"><KbNum :value="metrics.queued" /></div><div class="s">{{ metrics.queuedNote }}</div></div>
              <div class="card metric" data-testid="jobs-pending"><div class="k">待补向量</div><div class="v"><KbNum :value="metrics.pending" /></div><div class="s">{{ metrics.pendingNote }}</div></div>
              <div class="card metric"><div class="k">24h 失败</div><div class="v kb-danger"><KbNum :value="metrics.failed" /></div><div class="s">{{ metrics.failedNote }}</div></div>
              <div class="card metric"><div class="k">24h 完成</div><div class="v"><KbNum :value="metrics.done" /></div><div class="s up">{{ metrics.doneNote }}</div></div>
            </div>

            <div v-if="stateItems.length" class="kb-jobs-charts" data-testid="jobs-charts">
              <div class="card" data-testid="jobs-state-chart">
                <div class="ch">任务状态<span class="m kb-light">· 共 {{ stats?.total ?? 0 }} 个</span></div>
                <div class="kb-jobs-chart-body">
                  <KbDonut :items="stateItems" label="各状态的任务数" :size="112" caption="任务" :format="(value: number) => `${value}`" />
                </div>
              </div>
              <div class="card" data-testid="jobs-duration-chart">
                <div class="ch">完成任务用时</div>
                <div class="kb-jobs-chart-body">
                  <!-- 中位数和 P95 写在图下面的说明里:卡片标题旁的小字在平板和手机上会被藏掉 -->
                  <KbHBars v-if="durationRows.length" :rows="durationRows" label="已完成任务的用时分布" :format="(value: number) => `${value}`" :note="durationNote" />
                  <p v-else class="m kb-jobs-chart-empty">还没有完成的任务,有了之后这里会显示一般要跑多久。</p>
                </div>
              </div>
            </div>

            <div class="card">
              <KbResponsiveTable
                class="kb-jobs-table"
                :columns="columns"
                :rows="(pageJobs as unknown as Record<string, unknown>[])"
                :loading="!jobsLoaded"
                :selected="selectedId ? [selectedId] : []"
                clickable
                empty="没有符合条件的任务"
                @row-click="(row) => pickJob(row as unknown as JobSummary)"
              >
                <template #cell-icon="{ row }">
                  <span :class="`kb-job-icon is-${tone(row as unknown as JobSummary)}`"><KbJobIcon :tone="tone(row as unknown as JobSummary)" /></span>
                </template>
                <template #cell-id="{ row }">{{ (row as unknown as JobSummary).id }}</template>
                <template #cell-kind="{ row }">{{ jobKindText((row as unknown as JobSummary).kind) }}</template>
                <template #cell-target="{ row }">{{ (row as unknown as JobSummary).collection ?? '全部' }}</template>
                <template #cell-detail="{ row }">
                  <RouterLink
                    v-if="isCellLinkableFile(row as unknown as JobSummary)"
                    :to="{ path: PATHS.kb, query: { collection: (row as unknown as JobSummary).collection ?? undefined, path: detailText(row as unknown as JobSummary) } }"
                    target="_blank"
                    class="kb-file-link mono"
                    :title="`在知识库中打开: ${detailText(row as unknown as JobSummary)}`"
                    data-testid="job-cell-link"
                    @click.stop
                  >
                    {{ detailText(row as unknown as JobSummary) }}
                  </RouterLink>
                  <RouterLink
                    v-else-if="cellInsightId(row as unknown as JobSummary)"
                    :to="{ path: PATHS.kb, query: { collection: (row as unknown as JobSummary).collection ?? undefined, item: cellInsightId(row as unknown as JobSummary)! } }"
                    target="_blank"
                    class="kb-file-link"
                    :title="`在知识库中打开: ${detailText(row as unknown as JobSummary)}`"
                    data-testid="job-cell-insight-link"
                    @click.stop
                  >
                    {{ detailText(row as unknown as JobSummary) }}
                  </RouterLink>
                  <button
                    v-else-if="isCellMultiFiles(row as unknown as JobSummary)"
                    type="button"
                    class="kb-files-trigger-btn mono"
                    :title="`查看涉及的具体文件`"
                    data-testid="job-cell-files-btn"
                    @click.stop="openFilesDialog(row as unknown as JobSummary)"
                  >
                    {{ detailText(row as unknown as JobSummary) }}
                  </button>
                  <span v-else :title="detailText(row as unknown as JobSummary)">{{ detailText(row as unknown as JobSummary) }}</span>
                </template>
                <template #cell-progress="{ row }">
                  <div class="row">
                    <div class="bar kb-fill-x"><i :class="`is-${tone(row as unknown as JobSummary)}`" :style="{ width: `${percent(row as unknown as JobSummary)}%` }" style-allow="进度来自数据"></i></div>
                    <span class="mono m kb-pct">{{ percent(row as unknown as JobSummary) }}%</span>
                  </div>
                </template>
                <template #cell-started="{ row }">{{ stamp((row as unknown as JobSummary).started_at) }}</template>
                <template #cell-took="{ row }">{{ elapsed(row as unknown as JobSummary) }}</template>
                <!-- 手机上的卡片:状态图标 + 类型 + 状态,目标和详情一行,进度条,开始 / 耗时 -->
                <template #card="{ row }">
                  <div class="kb-job-card" data-testid="job-card">
                    <div class="kb-job-card-head">
                      <span :class="`kb-job-icon is-${tone(row as unknown as JobSummary)}`"><KbJobIcon :tone="tone(row as unknown as JobSummary)" /></span>
                      <b>{{ jobKindText((row as unknown as JobSummary).kind) }}</b>
                      <KbBadge :tone="stateTone(row as unknown as JobSummary)">{{ stateText(row as unknown as JobSummary) }}</KbBadge>
                      <span class="mono m kb-job-card-id">{{ (row as unknown as JobSummary).id }}</span>
                    </div>
                    <div class="kb-job-card-line">{{ (row as unknown as JobSummary).collection ?? '全部' }}<template v-if="detailText(row as unknown as JobSummary)"> · <RouterLink v-if="isCellLinkableFile(row as unknown as JobSummary)" :to="{ path: PATHS.kb, query: { collection: (row as unknown as JobSummary).collection ?? undefined, path: detailText(row as unknown as JobSummary) } }" target="_blank" class="kb-file-link mono m" @click.stop>{{ detailText(row as unknown as JobSummary) }}</RouterLink><button v-else-if="isCellMultiFiles(row as unknown as JobSummary)" type="button" class="kb-files-trigger-btn mono m" @click.stop="openFilesDialog(row as unknown as JobSummary)">{{ detailText(row as unknown as JobSummary) }}</button><span v-else class="m">{{ detailText(row as unknown as JobSummary) }}</span></template></div>
                    <div v-if="cardTimes(row as unknown as JobSummary).showBar" class="row kb-job-card-bar">
                      <div class="bar kb-fill-x"><i :class="`is-${tone(row as unknown as JobSummary)}`" :style="{ width: `${percent(row as unknown as JobSummary)}%` }" style-allow="进度来自数据"></i></div>
                      <span class="mono m kb-pct">{{ percent(row as unknown as JobSummary) }}%</span>
                    </div>
                    <div class="m kb-job-card-time">{{ cardTimes(row as unknown as JobSummary).line }}</div>
                  </div>
                </template>
              </KbResponsiveTable>
              <!-- 一页 50 个;总数超过一页才出分页条 -->
              <div v-if="total > pageSize" class="kb-jobs-pager" data-testid="jobs-pager">
                <KbPager v-model:page="page" v-model:page-size="pageSize" :total="total" :sizes="[50, 100, 200]" />
              </div>
            </div>

            <!-- 任务随时间的变化:放在任务表下面,核心的表格仍在首屏 -->
            <JobFlowCharts v-if="!embedded" :exclude-kinds="excludeKinds" />

            <div class="kb-grid kb-grid-2 kb-grow kb-jobs-bottom">
              <div v-if="!phone" class="card kb-clip" data-testid="job-detail-card">
                <div class="ch">
                  <template v-if="selected">{{ jobKindText(selected.kind) }} · <span class="mono">{{ selected.id }}</span></template><template v-else>任务详情</template>
                  <div class="r">
                    <button v-if="!readonly && selected && ['queued', 'running'].includes(selected.state)" type="button" class="btn sm" @click="cancel(selected)">取消</button>
                  </div>
                </div>
                <div class="kb-job-detail">
                  <KbSkeleton v-if="detailLoading" variant="lines" :lines="4" />
                  <p v-else-if="!selected" class="m">点上面表格里的一个任务,这里显示它的详情。</p>
                  <p v-else-if="detailFailed && !detail" class="m" role="status">没能读取这个任务的详情,稍后会自动重试。</p>
                  <template v-else-if="detail">
                    <p v-if="failure" class="kb-job-failure" role="alert" data-testid="job-failure">{{ failure }}</p>
                    <StatusRows :rows="detailRows" compact />
                    <JobFiles
                      :job-id="detail.id"
                      :files="changedFiles"
                      :total="changedTotal"
                      :counts="changedCounts"
                      :fallback-paths="targetFiles"
                      :insight-id="targetInsight"
                      :collection="detail.collection ?? selected?.collection ?? null"
                      :loading="changedLoading"
                      :failed="changedFailed"
                      @more="loadChangedFiles(false)"
                    />
                    <div v-if="errorSamples.length" class="kb-job-samples" data-testid="job-error-samples">
                      <b>出错的文件(前 {{ errorSamples.length }} 个)</b>
                      <ul class="code mono"><li v-for="(line, index) in errorSamples" :key="index">{{ line }}</li></ul>
                    </div>
                    <RouterLink v-if="canOps && !embedded" class="btn sm kb-job-logs" :to="{ path: PATHS.system, query: { tab: 'logs' } }" data-testid="job-logs-link">查看服务日志</RouterLink>
                  </template>
                </div>
              </div>

              <div class="card kb-clip">
                <div class="ch">最近写入批次<div class="r m">审计 · 按 actor</div></div>
                <KbResponsiveTable :columns="batchColumns" :rows="(batchRows as unknown as Record<string, unknown>[])" :loading="!batchesLoaded" empty="还没有写入批次">
                  <template #cell-id="{ row }">{{ (row as unknown as BatchView).id }}</template>
                  <!-- 这两列在窄面板里会被省略号截断(来源 / 操作说明常常超出列宽),挂 title 保证完整内容可读 -->
                  <template #cell-actor="{ row }"><span :title="(row as unknown as BatchView).actor">{{ (row as unknown as BatchView).actor }}</span></template>
                  <template #cell-description="{ row }"><span :title="(row as unknown as BatchView).description">{{ (row as unknown as BatchView).description }}</span></template>
                  <template #cell-protocol="{ row }">{{ (row as unknown as BatchView).protocol ?? '—' }}</template>
                  <template #cell-state="{ row }"><span class="tag" :class="batchState(row as unknown as BatchView).tone">{{ batchState(row as unknown as BatchView).text }}</span></template>
                </KbResponsiveTable>
              </div>
            </div>
          </template>
        </template>

        <!-- 审计日志、批次:各自的组件(读取状态、中文显示、撤销确认都在组件里) -->
        <AuditPanel v-else-if="tab === 'audit'" />
        <BatchPanel v-else />
      </div>
    </div>

    <!-- 手机:点任务卡看详情 -->
    <KbSheet v-if="detailOpen && phone && selected" :title="`${jobKindText(selected.kind)} · ${selected.id}`" @close="detailOpen = false">
      <div class="kb-job-detail kb-job-detail-sheet" data-testid="job-detail-sheet">
        <KbSkeleton v-if="detailLoading" variant="lines" :lines="4" />
        <p v-else-if="detailFailed && !detail" class="m" role="status">没能读取这个任务的详情,稍后会自动重试。</p>
        <template v-else-if="detail">
          <p v-if="failure" class="kb-job-failure" role="alert">{{ failure }}</p>
          <StatusRows :rows="detailRows" compact />
          <JobFiles
            :job-id="detail.id"
            :files="changedFiles"
            :total="changedTotal"
            :counts="changedCounts"
            :fallback-paths="targetFiles"
            :insight-id="targetInsight"
            :collection="detail.collection ?? selected?.collection ?? null"
            :loading="changedLoading"
            :failed="changedFailed"
            @more="loadChangedFiles(false)"
          />
          <div v-if="errorSamples.length" class="kb-job-samples">
            <b>出错的文件(前 {{ errorSamples.length }} 个)</b>
            <ul class="code mono"><li v-for="(line, index) in errorSamples" :key="index">{{ line }}</li></ul>
          </div>
        </template>
      </div>
      <template #footer>
        <KbButton v-if="!readonly && ['queued', 'running'].includes(selected.state)" @click="cancel(selected)">取消任务</KbButton>
        <KbButton variant="primary" @click="detailOpen = false">关闭</KbButton>
      </template>
    </KbSheet>
    <!-- 点击多文件详情时弹出的具体文件清单对话框 -->
    <KbDialog
      v-if="filesDialogOpen && dialogJob"
      :title="`任务涉及的文件 · ${dialogJob.id}`"
      :subtitle="dialogJob.collection ? `集合: ${dialogJob.collection}` : undefined"
      width="600px"
      data-testid="job-files-dialog"
      @close="filesDialogOpen = false"
    >
      <div class="kb-job-files-dialog-body">
        <KbSkeleton v-if="dialogLoading && !dialogHasFiles" variant="lines" :lines="4" />
        <JobFiles
          v-else-if="dialogHasFiles"
          :job-id="dialogJob.id"
          :files="dialogFileRows"
          :total="dialogFileTotal"
          :counts="dialogFileCounts"
          :fallback-paths="dialogFallbackPaths"
          :insight-id="dialogInsight"
          :collection="dialogJob.collection ?? dialogDetail?.collection ?? null"
          :loading="dialogFilesLoading"
          :failed="dialogFilesFailed"
          @more="loadDialogFiles(false)"
        />
        <p v-else-if="dialogLoading" class="m kb-light">正在读取…</p>
        <p v-else class="m kb-light">该任务未记录具体文件路径清单。</p>
      </div>
      <template #footer>
        <KbButton variant="primary" @click="filesDialogOpen = false">关闭</KbButton>
      </template>
    </KbDialog>
  </component>
</template>

<style scoped>
/* 弹窗里没有外壳提供高度:根节点和内容区自己撑满,超出时在 .content 里滚 */
.kb-jobs-embed { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; min-height: 0; overflow: hidden; }
.kb-jobs-embed > .kb-jobs { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; min-height: 0; }
.kb-jobs-embed .content { flex: 1 1 auto; min-height: 0; overflow-x: hidden; overflow-y: auto; }
/* 筛选条:单独一行,窄屏自动折行(不再塞在页签右侧被挤出屏幕) */
.kb-jobs-bar { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2); padding: var(--sp-3) var(--card-px) 0; }
.kb-jobs-stale { margin: 0; }
.kb-jobs-pager { padding: var(--sp-3) var(--card-pad-ui); border-top: var(--hl) solid var(--b); }
/* 详情卡和最近批次:按内容撑高。全局的 .kb-grow 让它「铺满视口剩下的高度」,但上面已经有指标、图表和一整页表格,
   剩下的高度是 0,两张卡会被压成一条线(内容区本来就能滚动,这里不需要铺满) */
.kb-jobs .kb-jobs-bottom { flex: none; min-height: auto; }
.kb-jobs .kb-jobs-bottom > .card { min-height: auto; }
.kb-jobs-pad { padding: var(--card-pad-ui); }
/* 状态分布与用时分布:窄屏上下排,宽屏并排;卡片不收缩,免得 WebKit 把带 overflow 的卡压成 1px */
.kb-jobs-charts { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--gap); }
.kb-jobs-charts > .card { min-width: 0; flex: 0 0 auto; }
.kb-jobs-chart-body { padding: var(--card-pad-ui); }
.kb-jobs-chart-empty { margin: 0; font-size: var(--text-13); }
@media (min-width: 840px) { .kb-jobs-charts { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
/* 手机上的任务卡 */
.kb-job-card { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
.kb-job-card-head { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2); min-width: 0; }
.kb-job-card-id { margin-left: auto; font-size: var(--text-12); }
.kb-job-card-line { overflow-wrap: anywhere; }
.kb-job-card-bar { align-items: center; gap: var(--sp-2); }
.kb-job-card-time { font-size: var(--text-12); }
.kb-batch-row { flex-wrap: wrap; row-gap: var(--sp-1); padding-block: var(--sp-2); }
.kb-batch-desc { min-width: 0; overflow-wrap: anywhere; }
/* 任务详情:失败原因整段显示(表格里只露一行);出错样例是服务端截短过的,长行在框里折行 */
.kb-job-detail { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--card-pad-ui); min-width: 0; }
.kb-job-detail-sheet { padding: 0; }
.kb-job-failure { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r2); background: color-mix(in oklab, var(--status-danger) 12%, transparent); color: var(--status-danger-text); overflow-wrap: anywhere; white-space: pre-wrap; }
.kb-job-samples { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
.kb-job-samples ul { margin: 0; padding: var(--sp-2) var(--sp-3); list-style: none; max-height: 12em; overflow: auto; }
.kb-job-samples li { overflow-wrap: anywhere; }
.kb-job-logs { align-self: flex-start; }
.kb-file-link {
  color: var(--accent-text);
  text-decoration: underline;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.kb-file-link:hover {
  filter: brightness(1.15);
}
.kb-files-trigger-btn {
  background: none;
  border: 0;
  padding: 0;
  color: var(--accent-text);
  cursor: pointer;
  text-decoration: underline;
  font: inherit;
  text-align: left;
}
.kb-files-trigger-btn:hover {
  filter: brightness(1.15);
}
.kb-job-files-dialog-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-height: 120px;
}
/* 手机上全局规则给 .ch 定了固定高度并 overflow:hidden(单行标题条);这里的标题条带着过滤框,要折成两行,
   所以必须放开高度和裁剪,否则折下去的那一行被切掉,手机上没法按能力名过滤 */
.kb-tab-card > .ch { flex-wrap: wrap; row-gap: var(--sp-2); height: auto; min-height: 40px; padding-block: var(--sp-2); overflow: visible; white-space: normal; }
@media (max-width: 599px) {
  .kb-capability { width: 100%; }
  .kb-tab-card > .ch .r { width: 100%; margin-left: 0; }
}
</style>
