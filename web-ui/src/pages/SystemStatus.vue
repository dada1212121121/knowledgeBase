<script setup lang="ts">
// 系统状态(管理组,功能点 sys.ops):服务 / 资源 / 组件 / 任务 / 日志五页。给管理员看服务现在跑得怎么样。
//
// 数据来自后端一个 `system_status` 能力,每 10 秒自动刷新一次。
// 容错分三层(方案:各块独立加载与报错,不因一块失败整页空白):
//   1) 页面标题、页签、刷新按钮永远在;第一次读不到时只替换内容区(骨架 / 报错 + 重试 / 无权限);
//   2) 读到之后某一块缺失或形状不对(blockReady),只有那一块显示「没读到」+ 重新读取,别的块照常;
//   3) 之后的自动刷新失败,保留旧数据并说明「显示的是 12:30:05 的数据」,不清空页面。
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import AppShell from '@/layouts/AppShell.vue'
import AdminLoadState from '@/components/admin/AdminLoadState.vue'
import StatusBlockMissing from '@/components/admin/StatusBlockMissing.vue'
import StatusRows from '@/components/admin/StatusRows.vue'
import { KbBadge, KbButton, KbCard, KbEmpty, KbGauge, KbPageHeader, KbTabs, type TabItem } from '@kb-ui/index'
import JobFlowCharts from '@/components/admin/JobFlowCharts.vue'
import ResourceCharts from '@/components/admin/ResourceCharts.vue'
import IndexStatsPanel from '@/components/admin/IndexStatsPanel.vue'
import { AI_JOB_KINDS } from '@/api/jobs'
import { callCapability } from '@/api/client'
import { useFeature } from '@/composables/useFeature'
import { PATHS } from '@/router/paths'
import { useSessionStore } from '@/stores/session'
import { adminFailure } from '@/utils/adminFailure'
import { NO_ACCESS_TEXT, type Failure, type LoadPhase } from '@/utils/loadState'
import { relativeTime } from '@/utils/share'
import {
  attentionNotes,
  blockReady,
  bytesText,
  clockText,
  componentState,
  cpuRows,
  diskRows,
  envRows,
  gpuRows,
  groupComponents,
  ingestRows,
  isAiJob,
  jobKindText,
  jobStateRows,
  jobStateText,
  jobStateTone,
  kindInfo,
  LEVEL_TEXT,
  levelName,
  levelOf,
  llmRows,
  memoryRows,
  networkRows,
  readyCount,
  recentProblems,
  scaleRows,
  serviceRows,
  tabFromQuery,
  tailLines,
  totalOf,
  visibleComponents,
  BLOCK_NAME,
  type BlockKey,
  type SystemSnapshot,
  type TabId,
} from '@/utils/systemStatus'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const allowed = useFeature('sys.ops')
const canSettings = useFeature('sys.settings')
/** AI 总开关:关掉后,与 AI 有关的指标、组件、任务在这一页都不出现 */
const aiOn = computed(() => session.aiEnabled)

const REFRESH_MS = 10_000
const TABS: TabItem[] = [
  { value: 'service', label: '服务' },
  { value: 'resources', label: '资源' },
  { value: 'components', label: '组件' },
  { value: 'jobs', label: '任务' },
  { value: 'logs', label: '日志' },
]

const tab = ref<TabId>(tabFromQuery(route.query.tab))
watch(
  () => route.query.tab,
  (value) => {
    const next = tabFromQuery(value)
    if (next !== tab.value) tab.value = next
  },
)
watch(tab, (value) => {
  if (route.query.tab !== value) void router.replace({ query: { ...route.query, tab: value } })
})
const tabLabel = computed(() => TABS.find((item) => item.value === tab.value)?.label ?? '服务')

// ---------------------------------------------------------------- 取数

const status = ref<SystemSnapshot | null>(null)
const phase = ref<LoadPhase>('loading')
const message = ref('')
const loading = ref(false)
const updatedAt = ref(0)
/** 读到过数据之后的自动刷新失败了 */
const staleFailure = ref<Failure | null>(null)
let timer: number | undefined

async function refresh() {
  if (loading.value) return
  loading.value = true
  try {
    status.value = await callCapability<SystemSnapshot>('system_status')
    phase.value = 'ready'
    message.value = ''
    staleFailure.value = null
    updatedAt.value = Date.now()
  } catch (err) {
    const failure = adminFailure(err, '读取系统状态', { next: '请点「重试」;一直不行,说明守护进程可能没在运行,需要到服务器上检查。' })
    // 没有权限了(角色被改)就不能再展示旧数据;其它失败:有旧数据就留着并提示,没有就整块报错
    if (failure.phase === 'forbidden' || !status.value) {
      status.value = null
      phase.value = failure.phase
      message.value = failure.message
    } else {
      staleFailure.value = failure
    }
  } finally {
    loading.value = false
  }
}

/** 点「重试」/「重新读取」/「刷新」:第一次还没读到时先回到骨架屏,让人看到在重新读 */
function retry() {
  if (!status.value && phase.value !== 'forbidden') phase.value = 'loading'
  void refresh()
}

/**
 * 功能点是否开通要看**当前**的会话:刷新页面时会话还没取回来,`allowed` 先是 true、取回来之后才变成 false,
 * 所以「无权限」靠 effectivePhase 随它实时切换,而不是在挂载那一刻判断一次;没权限了就停掉轮询、丢掉旧数据。
 */
const effectivePhase = computed<LoadPhase>(() => (allowed.value ? phase.value : 'forbidden'))
const effectiveMessage = computed(() => (allowed.value ? message.value : NO_ACCESS_TEXT))

function start() {
  if (timer !== undefined) return
  void refresh()
  // 页面在后台时不刷新:没人在看,不必每 10 秒查一次磁盘和日志
  timer = window.setInterval(() => {
    if (document.visibilityState !== 'hidden') void refresh()
  }, REFRESH_MS)
}
function stop() {
  window.clearInterval(timer)
  timer = undefined
}
onMounted(() => {
  if (allowed.value) start()
})
watch(allowed, (value) => {
  if (value) start()
  else {
    stop()
    status.value = null
    phase.value = 'loading'
  }
})
onUnmounted(stop)

// ---------------------------------------------------------------- 各块

const ready = (key: BlockKey) => blockReady(status.value, key)
const snapshot = computed<SystemSnapshot>(() => status.value ?? {})

const notes = computed(() => attentionNotes(status.value, aiOn.value))
const service = computed(() => serviceRows(snapshot.value))
const scale = computed(() => scaleRows(snapshot.value))
const network = computed(() => networkRows(snapshot.value))
const llm = computed(() => llmRows(snapshot.value))

const cpu = computed(() => cpuRows(snapshot.value))
const memory = computed(() => memoryRows(snapshot.value))
const disk = computed(() => diskRows(snapshot.value))
const gpu = computed(() => gpuRows(snapshot.value))
const env = computed(() => envRows(snapshot.value))
const memoryLevel = computed(() => levelOf(snapshot.value.resources?.memory?.used_ratio))
const diskLevel = computed(() => levelOf(snapshot.value.resources?.disk?.used_ratio))
/** AI 总开关关闭后,任务趋势里不算自动提炼 / 审核类任务(和任务页同一口径) */
const hiddenKinds = computed(() => (aiOn.value ? [] : [...AI_JOB_KINDS]))

const components = computed(() => visibleComponents(snapshot.value.components, aiOn.value))
const groups = computed(() => groupComponents(components.value))
const readiness = computed(() => readyCount(components.value))

const queue = computed(() => jobStateRows(snapshot.value.jobs?.by_state))
const queueTotal = computed(() => totalOf(snapshot.value.jobs?.by_state))
const ingest = computed(() => ingestRows(snapshot.value.jobs?.ingest))
const recent = computed(() => (snapshot.value.jobs?.recent ?? []).filter((job) => aiOn.value || !isAiJob(job.kind)))

const problems = computed(() => recentProblems(snapshot.value.logs?.tail))
const tail = computed(() => tailLines(snapshot.value.logs?.tail))
const files = computed(() => snapshot.value.logs?.files ?? [])
</script>

<template>
  <AppShell>
    <template #breadcrumb>
      <span class="bc-item">系统状态</span>
      <span class="bc-sep">/</span>
      <span class="bc-current">{{ tabLabel }}</span>
    </template>

    <div class="kb-ss" data-testid="system-status">
      <KbPageHeader title="系统状态" description="服务现在跑得怎么样:资源够不够、组件是否就绪、任务有没有堆积、日志里有没有报错。每 10 秒自动刷新。">
        <template v-if="effectivePhase !== 'forbidden'" #actions>
          <span v-if="updatedAt" class="m kb-ss-updated" data-testid="status-updated">更新于 {{ clockText(updatedAt) }}</span>
          <KbButton class="kb-ss-refresh" :disabled="loading" data-testid="status-refresh" @click="retry">{{ loading ? '刷新中…' : '刷新' }}</KbButton>
        </template>
      </KbPageHeader>

      <KbTabs v-model="tab" :tabs="TABS" class="kb-sticky" data-testid="status-tabs" />

      <p v-if="staleFailure" class="kb-ss-stale" role="status" data-testid="status-stale">最近一次刷新没成功,下面显示的是 {{ clockText(updatedAt) }} 的数据,{{ REFRESH_MS / 1000 }} 秒后会自动再试。{{ staleFailure.message }}</p>

      <AdminLoadState v-if="!allowed || !status" :phase="effectivePhase" :message="effectiveMessage" skeleton="card" @retry="retry" />

      <template v-else>
        <!-- 服务 -->
        <template v-if="tab === 'service'">
          <section v-if="notes.length" class="card kb-ss-notes" role="status" data-testid="status-notes">
            <b>需要注意</b>
            <ul>
              <li v-for="item in notes" :key="item">{{ item }}</li>
            </ul>
          </section>
          <div class="kb-ss-grid">
            <template v-if="ready('overview')">
              <KbCard title="服务信息" data-testid="card-service"><StatusRows :rows="service" /></KbCard>
              <KbCard title="数据规模" data-testid="card-scale"><StatusRows :rows="scale" compact /></KbCard>
            </template>
            <StatusBlockMissing v-else :name="BLOCK_NAME.overview" @retry="retry" />
            <KbCard v-if="ready('network')" title="网络与访问" data-testid="card-network"><StatusRows :rows="network" /></KbCard>
            <StatusBlockMissing v-else :name="BLOCK_NAME.network" @retry="retry" />
            <KbCard v-if="aiOn && ready('network')" title="云端模型用量" subtitle="今日" data-testid="card-llm">
              <StatusRows :rows="llm" />
              <RouterLink class="kb-ss-link" :to="{ path: PATHS.usage, query: { tab: 'ai' } }">查看每个人的额度</RouterLink>
            </KbCard>
          </div>
        </template>

        <!-- 资源 -->
        <template v-else-if="tab === 'resources'">
        <ResourceCharts v-if="allowed" />
        <div class="kb-ss-grid is-3">
          <template v-if="ready('resources')">
            <KbCard title="处理器" subtitle="CPU" data-testid="card-cpu">
              <div class="kb-ss-gauge"><KbGauge :value="snapshot.resources?.cpu?.busy_ratio ?? 0" label="处理器使用率" :caption="`${snapshot.resources?.cpu?.cores ?? '—'} 核`" :size="112" /></div>
              <StatusRows :rows="cpu" />
            </KbCard>
            <KbCard title="内存" data-testid="card-memory">
              <template v-if="LEVEL_TEXT[memoryLevel]" #extra><KbBadge tone="warning" data-testid="level-memory">{{ LEVEL_TEXT[memoryLevel] }}</KbBadge></template>
              <div class="kb-ss-gauge"><KbGauge :value="snapshot.resources?.memory?.used_ratio ?? 0" label="内存使用率" :size="112" /></div>
              <StatusRows :rows="memory" compact />
            </KbCard>
            <KbCard title="磁盘" data-testid="card-disk">
              <template v-if="LEVEL_TEXT[diskLevel]" #extra><KbBadge :tone="diskLevel === 'full' ? 'danger' : 'warning'" data-testid="level-disk">{{ LEVEL_TEXT[diskLevel] }}</KbBadge></template>
              <div class="kb-ss-gauge"><KbGauge :value="snapshot.resources?.disk?.used_ratio ?? 0" label="磁盘使用率" :size="112" /></div>
              <StatusRows :rows="disk" />
              <p class="m kb-ss-foot">用到 90% 时,管理员头像上会出现提醒。</p>
            </KbCard>
            <KbCard title="显卡" data-testid="card-gpu">
              <StatusRows :rows="gpu" compact />
              <p v-if="snapshot.resources?.gpu?.note" class="m kb-ss-foot">{{ snapshot.resources.gpu.note }}</p>
            </KbCard>
          </template>
          <StatusBlockMissing v-else :name="BLOCK_NAME.resources" @retry="retry" />
          <KbCard v-if="ready('env')" title="加速与工具" data-testid="card-env"><StatusRows :rows="env" /></KbCard>
          <StatusBlockMissing v-else :name="BLOCK_NAME.env" @retry="retry" />
        </div>
        <!-- 向量表:碎片与索引覆盖只在「资源」页看,和磁盘 / 内存放一起 -->
        <IndexStatsPanel v-if="allowed && tab === 'resources'" />
        </template>

        <!-- 组件 -->
        <template v-else-if="tab === 'components'">
          <StatusBlockMissing v-if="!ready('components')" :name="BLOCK_NAME.components" @retry="retry" />
          <template v-else>
            <p v-if="readiness[1]" class="kb-ss-sum" data-testid="components-summary">
              <KbBadge :tone="readiness[0] === readiness[1] ? 'success' : 'warning'">{{ readiness[0] === readiness[1] ? '全部就绪' : '有组件没就绪' }}</KbBadge>
              <span class="m">{{ readiness[0] }} / {{ readiness[1] }} 个组件就绪</span>
            </p>
            <div v-if="groups.length" class="kb-ss-grid">
              <KbCard v-for="[kind, providers] in groups" :key="kind" :title="kindInfo(kind).label" :subtitle="`${providers.filter((item) => item.ready).length} / ${providers.length} 就绪`" :data-testid="`kind-${kind}`">
                <p v-if="kindInfo(kind).help" class="m kb-ss-kind">{{ kindInfo(kind).help }}</p>
                <ul class="kb-ss-list">
                  <li v-for="provider in providers" :key="provider.id" class="kb-ss-comp" data-testid="component">
                    <span class="kb-ss-comp-head">
                      <KbBadge :tone="componentState(provider).tone">{{ componentState(provider).text }}</KbBadge>
                      <b class="kb-ss-comp-name">{{ provider.name || provider.id }}</b>
                      <KbBadge v-if="provider.current" tone="accent">当前使用</KbBadge>
                    </span>
                    <span v-if="provider.detail ?? provider.model" class="m kb-ss-comp-detail">{{ provider.detail ?? provider.model }}</span>
                  </li>
                </ul>
              </KbCard>
            </div>
            <div v-else class="card"><KbEmpty icon="database" title="没有检测到组件" description="组件是文字识别、转写、索引、重排这些后台能力。到系统设置的「组件」页可以安装。" /></div>
            <p v-if="canSettings" class="m kb-ss-foot" data-testid="components-link">安装新组件、更换默认组件或下载离线模型,在系统设置里操作。<RouterLink class="kb-ss-link" :to="{ path: PATHS.settings, query: { tab: 'components' } }">去系统设置 → 组件</RouterLink></p>
          </template>
        </template>

        <!-- 任务 -->
        <template v-else-if="tab === 'jobs'">
        <JobFlowCharts :exclude-kinds="hiddenKinds" />
        <div class="kb-ss-grid is-3">
          <StatusBlockMissing v-if="!ready('jobs')" :name="BLOCK_NAME.jobs" @retry="retry" />
          <template v-else>
            <KbCard title="任务队列" :subtitle="`共 ${queueTotal} 个`" data-testid="card-queue">
              <StatusRows v-if="queue.length" :rows="queue" compact />
              <p v-else class="m">还没有任何任务。</p>
              <RouterLink class="kb-ss-link" :to="PATHS.tasks">查看全部任务</RouterLink>
            </KbCard>
            <KbCard title="导入队列" subtitle="正在解析的文件" data-testid="card-ingest">
              <StatusRows v-if="ingest.length" :rows="ingest" compact />
              <p v-else class="m" data-testid="ingest-idle">导入队列是空的,没有文件在等待解析。</p>
              <RouterLink class="kb-ss-link" :to="PATHS.importQueue">查看导入队列</RouterLink>
            </KbCard>
            <KbCard title="最近的任务" subtitle="最新 8 个" data-testid="card-recent">
              <ul v-if="recent.length" class="kb-ss-list">
                <li v-for="job in recent" :key="job.id" class="kb-ss-job" data-testid="recent-job">
                  <KbBadge :tone="jobStateTone(job.state)">{{ jobStateText(job.state) }}</KbBadge>
                  <span class="kb-ss-job-kind">{{ jobKindText(job.kind) }}</span>
                  <span class="m kb-ss-job-meta">{{ job.done }} / {{ job.total ?? '?' }} · {{ relativeTime(job.updated_at) }}</span>
                </li>
              </ul>
              <KbEmpty v-else icon="list" size="sm" title="还没有任务" description="导入文件、重建索引后,进度会出现在这里。">
                <template #action><RouterLink class="kb-btn is-sm" :to="PATHS.import">去导入</RouterLink></template>
              </KbEmpty>
            </KbCard>
          </template>
        </div>
        </template>

        <!-- 日志 -->
        <div v-else class="kb-ss-grid is-logs">
          <StatusBlockMissing v-if="!ready('logs')" :name="BLOCK_NAME.logs" @retry="retry" />
          <template v-else>
            <KbCard title="最近的警告和错误" data-testid="card-problems">
              <ul v-if="problems.length" class="kb-ss-list">
                <li v-for="(line, index) in problems" :key="index" class="kb-ss-problem" data-testid="problem">
                  <KbBadge :tone="line.level === 'ERROR' ? 'danger' : 'warning'">{{ levelName(line.level) }}</KbBadge>
                  <span class="m">{{ line.time }}</span>
                  <span class="kb-ss-problem-text">{{ line.text }}</span>
                </li>
              </ul>
              <p v-else class="m" data-testid="problems-none">最近没有警告或错误。</p>
            </KbCard>
            <KbCard title="日志文件" :subtitle="snapshot.logs?.dir" data-testid="card-files">
              <ul v-if="files.length" class="kb-ss-list">
                <li v-for="[name, size] in files" :key="name" class="kb-ss-file"><span class="mono">{{ name }}</span><span class="m">{{ bytesText(size) }}</span></li>
              </ul>
              <p v-else class="m" data-testid="files-none">日志目录里还没有日志文件。</p>
              <p class="m kb-ss-foot">要看更详细的日志,在服务器的 config.toml 里改日志级别([log] 一段),保存后几秒内自动生效。</p>
            </KbCard>
            <KbCard title="最近的日志" :subtitle="`最后 ${tail.length} 行`" class="kb-ss-tailcard" data-testid="card-tail">
              <div v-if="tail.length" class="kb-ss-tail mono" role="region" aria-label="最近的日志" tabindex="0" data-testid="log-tail">
                <div v-for="(line, index) in tail" :key="index" class="kb-ss-line"><span class="m">{{ line.time }}</span>{{ ' ' }}<span v-if="line.level" :class="`kb-ss-lv is-${line.level.toLowerCase()}`">{{ line.level }}</span>{{ line.level ? ' ' : '' }}{{ line.text }}</div>
              </div>
              <p v-else class="m" data-testid="tail-none">还没有日志输出。</p>
            </KbCard>
          </template>
        </div>
      </template>
    </div>
  </AppShell>
</template>

<style scoped>
.kb-ss { display: flex; flex-direction: column; gap: var(--gap); width: 100%; min-width: 0; flex: 0 0 auto; }
/* 带 overflow 的卡片放进纵向 flex 容器,WebKit 会把它压成 1px 高(内容全被裁掉);页面里的卡片一律不让收缩 */
.kb-ss > * { flex: 0 0 auto; min-width: 0; }
.kb-ss-updated { font-size: var(--text-12); }
/* 手机上页头操作区里「更新于 hh:mm:ss」文字 + 次要的「刷新」按钮:共用规则会把按钮拉成 258px 宽的大按钮,白占一行。
   文字占剩余宽度,按钮取自身宽度、靠右 */
@media (max-width: 599px) {
  .kb-ss-updated { flex: 1 1 auto; }
  .kb-ss-refresh { flex: 0 0 auto !important; }
}
.kb-ss-stale { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r2); background: var(--surface-2); color: var(--status-warning-text); font-size: var(--text-13); overflow-wrap: anywhere; }
.kb-ss-notes { padding: var(--card-pad-ui); display: flex; flex-direction: column; gap: var(--sp-2); border-color: var(--status-warning); }
.kb-ss-notes ul { margin: 0; padding-left: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--text-13); overflow-wrap: anywhere; }

/* 卡片网格:手机一列,平板两列,电脑按页面要求两三列 */
.kb-ss-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--gap); align-items: start; }
.kb-ss-grid > * { min-width: 0; }
@media (min-width: 840px) { .kb-ss-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (min-width: 1280px) { .kb-ss-grid.is-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
.kb-ss-grid.is-logs { grid-template-columns: minmax(0, 1fr); }
.kb-ss-tailcard { min-width: 0; }

.kb-ss-gauge { display: flex; justify-content: center; padding: var(--sp-2) 0 var(--sp-3); }
.kb-ss-foot { margin: var(--sp-3) 0 0; font-size: var(--text-12); overflow-wrap: anywhere; }
/* 文字链接:触屏上可点区域 ≥44px(按输入方式判断,不按屏宽) */
.kb-ss-link { display: inline-flex; align-items: center; margin-top: var(--sp-3); font-size: var(--text-13); color: var(--accent-text); }
.kb-ss-foot .kb-ss-link { margin-top: 0; margin-left: var(--sp-2); }
@media (pointer: coarse) { .kb-ss-link { min-height: 44px; } }
/* 进度条和下面的行之间留出空隙 */
.kb-ss :deep(.kb-progress) { margin-bottom: var(--sp-3); }
.kb-ss-sum { margin: 0; display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2); }
.kb-ss-kind { margin: 0 0 var(--sp-3); font-size: var(--text-12); }
.kb-ss-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
.kb-ss-comp { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
.kb-ss-comp-head { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2); min-width: 0; }
.kb-ss-comp-name { min-width: 0; overflow-wrap: anywhere; font-weight: var(--fw-medium); }
.kb-ss-comp-detail { font-size: var(--text-12); overflow-wrap: anywhere; }
.kb-ss-job { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2); min-width: 0; }
.kb-ss-job-kind { font-weight: var(--fw-medium); overflow-wrap: anywhere; }
.kb-ss-job-meta { margin-left: auto; font-size: var(--text-12); }
.kb-ss-file { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-3); min-width: 0; }
.kb-ss-file .mono { min-width: 0; overflow-wrap: anywhere; }
.kb-ss-problem { display: flex; align-items: baseline; flex-wrap: wrap; gap: var(--sp-2); min-width: 0; }
.kb-ss-problem-text { flex: 1 1 240px; min-width: 0; overflow-wrap: anywhere; font-size: var(--text-13); }

/* 日志尾部:自己滚动、自己换行,不把页面撑宽 */
.kb-ss-tail { max-height: 24em; overflow: auto; padding: var(--sp-3); border-radius: var(--r2); background: var(--surface-2); font-size: var(--text-12); line-height: var(--lh-body); }
.kb-ss-tail:focus-visible { outline: none; box-shadow: var(--ring); }
.kb-ss-line { white-space: pre-wrap; overflow-wrap: anywhere; }
.kb-ss-lv.is-error { color: var(--status-danger-text); }
.kb-ss-lv.is-warn { color: var(--status-warning-text); }
</style>
