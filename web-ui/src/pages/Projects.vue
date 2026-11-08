<script setup lang="ts">
// 项目与集合(管理组,功能点 sources.local):
//   项目 = 管理员在服务器上登记的代码目录;集合 = 知识库里的一组内容。
// 这一页整理的是「项目」卡片和「集合」表;中间「服务器目录与 Git 来源」是另一块(useSources),互不影响。
//
// 项目、集合各自独立加载:一边读不到,另一边照常显示(各自的骨架 / 报错 + 重试 / 空状态);
// 没有 sources.local 功能点直接显示未开通,不请求接口。
// 危险操作都先确认并写清后果:移除项目、删除集合;更换索引模型先估算再确认,后台执行。
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppShell from '@/layouts/AppShell.vue'
import AdminLoadState from '@/components/admin/AdminLoadState.vue'
import FileStatusBars from '@/components/admin/FileStatusBars.vue'
import StatusRows from '@/components/admin/StatusRows.vue'
import {
  useConfirm,
  KbBadge,
  KbButton,
  KbDialog,
  KbEmpty,
  KbFormRow,
  KbIcon,
  KbInput,
  KbPageHeader,
  KbProgress,
  KbResponsiveTable,
  KbSelect,
  KbSwitch,
  useToast,
  type RtColumn,
} from '@kb-ui/index'
import { callCapability, type JobSummary, type Project, type ProjectInfo, type StatsOverview } from '@/api/client'
import AddDataDialog from '@/components/AddDataDialog.vue'
import SourceDetail from '@/components/import/SourceDetail.vue'
import SourceTable from '@/components/import/SourceTable.vue'
import { useFeature } from '@/composables/useFeature'
import { useSources } from '@/composables/useSources'
import { PATHS } from '@/router/paths'
import { useSessionStore } from '@/stores/session'
import { adminFailure } from '@/utils/adminFailure'
import { SERVER_KINDS, isServerKind, type SourceRow } from '@/utils/importSources'
import { NO_ACCESS_TEXT, type LoadPhase } from '@/utils/loadState'
import {
  EMBEDDERS,
  HOOKS_ENABLE_MESSAGE,
  HOOKS_MANAGED_BY_OTHER_TEXT,
  collectionKind,
  collectionsSummary,
  deleteCollectionMessage,
  embedderName,
  globsText,
  hasMigrating,
  indexedText,
  modelText,
  pageSummary,
  parseGlobs,
  planRows,
  projectRows,
  projectSwitches,
  sameModel,
  sortProjects,
  statusView,
  migrationPercent,
  type CollectionRow,
  type MigrationPlan,
  type SwitchRow,
} from '@/utils/projectsPage'
import { relativeTime } from '@/utils/share'

const router = useRouter()
const toast = useToast()
const session = useSessionStore()
const allowed = useFeature('sources.local')
/** AI 总开关:关掉后,「允许发给云端模型」「自动提炼」两行在这一页任何位置都不出现 */
const aiOn = computed(() => session.aiEnabled)

// 服务器目录与 Git 来源:读的是服务器上的目录和外部仓库,只有管理员(sources.local)能管;普通用户在「导入」页处理自己的网页 / 文件 / 笔记
const sourceStore = useSources()
const serverSources = computed(() => sourceStore.sources.value.filter((item) => isServerKind(item.kind)))
const sourceDetail = ref<SourceRow | null>(null)
const addingSource = ref(false)
async function removeSource() {
  if (sourceDetail.value && (await sourceStore.remove(sourceDetail.value))) sourceDetail.value = null
}

const projects = ref<ProjectInfo[]>([])
const collections = ref<CollectionRow[]>([])
const jobs = ref<JobSummary[]>([])
const embedder = ref('')
const busy = ref('')
/** 操作(保存 / 投递 / 移除…)失败的说明:就地显示在页面顶部,不会自己消失 */
const actionError = ref('')

const projectsPhase = ref<LoadPhase>('loading')
const projectsMessage = ref('')
const collectionsPhase = ref<LoadPhase>('loading')
const collectionsMessage = ref('')

const showAdd = ref(false)
const addBusy = ref(false)
const newPath = ref('')
const newName = ref('')

const editing = ref<Project | null>(null)
const form = ref({ include: '', exclude: '', allow_cloud_llm: false, extract_enabled: false, reindex: true })

const migrating = ref<CollectionRow | null>(null)
const plan = ref<MigrationPlan | null>(null)
const planLoading = ref(false)
const planError = ref('')
const migrateError = ref('')
const targetEmbedder = ref<string | number>('')
let estimateSeq = 0

const sortedProjects = computed(() => sortProjects(projects.value))
/** 文件状态条要的:项目名 + 它的集合名 */
const fileStatusProjects = computed(() => projects.value.map((item) => ({ name: item.project.name, collection: item.collection })))
const summary = computed(() => pageSummary(projects.value.length, collections.value.length, embedder.value))

// ---------------------------------------------------------------- 取数

const fail = (err: unknown, doing: string) => {
  actionError.value = adminFailure(err, doing).message
}

async function loadProjects() {
  try {
    const listed = await callCapability<{ projects?: ProjectInfo[] }>('list_projects')
    projects.value = listed.projects ?? []
    projectsPhase.value = 'ready'
    projectsMessage.value = ''
  } catch (err) {
    const failure = adminFailure(err, '读取项目')
    // 已经有数据了(操作之后的刷新失败):留着旧数据,在页面顶上说明;还没有数据:这一块整块报错
    if (projectsPhase.value === 'ready') actionError.value = failure.message
    else {
      projectsPhase.value = failure.phase
      projectsMessage.value = failure.message
    }
  }
}

async function loadCollections() {
  try {
    const [catalog, jobList, overview] = await Promise.all([
      callCapability<{ collections?: CollectionRow[] }>('list_collections'),
      // 只用来画「更换索引模型」的进度:只要还在跑 / 排队的迁移任务,不整份拉全部历史任务(上万个,卡 A)
      callCapability<{ jobs?: JobSummary[] }>('job_list', { states: ['running', 'queued'], kinds: ['migrate'], page_size: 200 }).catch(() => ({ jobs: [] as JobSummary[] })),
      // 概览只用来显示「当前索引模型」,读不到或缺字段不该让集合读取失败
      callCapability<StatsOverview>('stats_overview').catch(() => null),
    ])
    collections.value = catalog.collections ?? []
    jobs.value = jobList.jobs ?? []
    embedder.value = overview?.embedder?.id ?? ''
    collectionsPhase.value = 'ready'
    collectionsMessage.value = ''
  } catch (err) {
    const failure = adminFailure(err, '读取集合')
    if (collectionsPhase.value === 'ready') actionError.value = failure.message
    else {
      collectionsPhase.value = failure.phase
      collectionsMessage.value = failure.message
    }
  }
}

const reloadAll = () => Promise.all([loadProjects(), loadCollections()])

function retryProjects() {
  projectsPhase.value = 'loading'
  void loadProjects()
}
function retryCollections() {
  collectionsPhase.value = 'loading'
  void loadCollections()
}

// 有集合正在更换索引模型时,隔一会儿刷新一次集合,进度才会动、完成后状态才会变回「就绪」
let timer: number | undefined
let polling = false
/**
 * 功能点是否开通要看**当前**的会话:刷新页面时会话还没取回来,`allowed` 先是 true、取回来之后才变成 false;
 * 模板按 `allowed` 实时切换「无权限」,没权限了就停掉轮询。
 */
function start() {
  if (timer !== undefined) return
  void sourceStore.refresh()
  void reloadAll()
  timer = window.setInterval(async () => {
    if (polling || !hasMigrating(collections.value) || document.visibilityState === 'hidden') return
    polling = true
    try {
      await loadCollections()
    } finally {
      polling = false
    }
  }, 10_000)
}
function stop() {
  window.clearInterval(timer)
  timer = undefined
}
onMounted(() => {
  if (allowed.value) start()
})
watch(allowed, (value) => (value ? start() : stop()))
onUnmounted(stop)

// ---------------------------------------------------------------- 项目

async function addProject() {
  if (!newPath.value.trim() || addBusy.value) return
  addBusy.value = true
  actionError.value = ''
  try {
    await callCapability('add_project', { path: newPath.value.trim(), name: newName.value.trim() || undefined })
    newPath.value = ''
    newName.value = ''
    showAdd.value = false
    await reloadAll()
    toast.push('项目已添加,索引任务已入队')
  } catch (err) {
    fail(err, '添加项目')
  } finally {
    addBusy.value = false
  }
}

/** 云端模型 / 自动提炼开关:直接保存,不重建索引 */
async function quickToggle(item: ProjectInfo, field: 'allow_cloud_llm' | 'extract_enabled', value: boolean) {
  busy.value = item.project.id
  actionError.value = ''
  try {
    await callCapability('update_project', {
      project: item.project.name,
      include: item.project.include,
      exclude: item.project.exclude,
      allow_cloud_llm: field === 'allow_cloud_llm' ? value : item.project.allow_cloud_llm,
      extract_enabled: field === 'extract_enabled' ? value : item.project.extract_enabled,
      reindex: false,
    })
    await loadProjects()
  } catch (err) {
    fail(err, '保存设置')
  } finally {
    busy.value = ''
  }
}

async function confirmHooks(item: ProjectInfo) {
  const installed = item.project.hooks_installed
  const ok = await useConfirm().ask({
    title: installed ? `关闭「${item.project.name}」提交后自动索引?` : `开启「${item.project.name}」提交后自动索引?`,
    message: installed ? '关闭后,在这个目录里 git commit 不会再自动更新知识库。需要时仍可点「增量索引」。' : HOOKS_ENABLE_MESSAGE,
    confirmText: installed ? '关闭' : '开启',
    tone: installed ? 'danger' : 'default',
  })
  if (ok) await toggleHooks(item)
}

async function toggleHooks(item: ProjectInfo) {
  busy.value = item.project.id
  actionError.value = ''
  try {
    const installing = !item.project.hooks_installed
    const result = await callCapability<{ managed_by_other?: boolean } | null>(installing ? 'install_hooks' : 'uninstall_hooks', { project: item.project.name })
    await loadProjects()
    // hooksPath 被 husky 之类托管时后端不改它,也不会记成已安装:开关留在关,不能再报「已开启」
    if (installing && result?.managed_by_other === true) toast.push(HOOKS_MANAGED_BY_OTHER_TEXT, 'warning', 9000)
    else toast.push(installing ? '已开启提交后自动索引' : '已关闭提交后自动索引')
  } catch (err) {
    fail(err, '修改提交后自动索引')
  } finally {
    busy.value = ''
  }
}

function flip(item: ProjectInfo, row: SwitchRow, value: boolean) {
  // 置灰的开关(非 git 目录)KbSwitch 本身不会触发;这里再挡一道,免得以后换了开关组件就悄悄发请求
  if (row.disabled) return
  if (row.key === 'hooks') void confirmHooks(item)
  else void quickToggle(item, row.key === 'cloud' ? 'allow_cloud_llm' : 'extract_enabled', value)
}

function openEdit(item: ProjectInfo) {
  editing.value = item.project
  form.value = {
    include: globsText(item.project.include),
    exclude: globsText(item.project.exclude),
    allow_cloud_llm: item.project.allow_cloud_llm,
    extract_enabled: item.project.extract_enabled,
    reindex: true,
  }
}

async function saveEdit() {
  if (!editing.value) return
  busy.value = editing.value.id
  actionError.value = ''
  try {
    const result = await callCapability<{ job_id: string | null }>('update_project', {
      project: editing.value.name,
      include: parseGlobs(form.value.include),
      exclude: parseGlobs(form.value.exclude),
      allow_cloud_llm: form.value.allow_cloud_llm,
      extract_enabled: form.value.extract_enabled,
      reindex: form.value.reindex,
    })
    editing.value = null
    await loadProjects()
    toast.push(result.job_id ? '已保存,重建索引已入队' : '已保存')
  } catch (err) {
    fail(err, '保存项目')
  } finally {
    busy.value = ''
  }
}

async function reindex(item: ProjectInfo, mode: 'incremental' | 'full') {
  busy.value = item.project.id
  actionError.value = ''
  try {
    await callCapability('reindex_project', { project: item.project.name, mode })
    toast.push(`${item.project.name}:${mode === 'full' ? '全量重建' : '增量索引'}已入队,进度在「任务」页`)
  } catch (err) {
    fail(err, '投递索引任务')
  } finally {
    busy.value = ''
  }
}

async function removeProject(item: ProjectInfo) {
  busy.value = item.project.id
  try {
    const ok = await useConfirm().ask({
      title: `移除项目「${item.project.name}」?`,
      message: '项目的登记信息、它的集合和已建好的索引都会删除,不能恢复;服务器上目录里的文件不受影响。',
      confirmText: '移除',
      tone: 'danger',
      doneText: '项目已移除',
      action: () => callCapability('remove_project', { project: item.project.name }),
    })
    if (!ok) return
    await reloadAll()
  } finally {
    busy.value = ''
  }
}

// ---------------------------------------------------------------- 集合

const collectionColumns: RtColumn[] = [
  { key: 'name', label: '集合', cellClass: 'mono', mobile: 'primary' },
  { key: 'type', label: '类型', mobile: 'meta' },
  { key: 'model', label: '索引模型', cellClass: 'mono m', mobile: 'meta' },
  { key: 'rows', label: '内容片段', cellClass: 'mono', align: 'right', mobile: 'meta' },
  { key: 'table', label: '存储表', cellClass: 'mono m', clip: true, mobile: 'hidden' },
  { key: 'status', label: '状态', mobile: 'meta' },
  { key: 'actions', label: '操作', align: 'right', mobile: 'hidden' },
]
const collectionRows = computed(() => collections.value as unknown as Record<string, unknown>[])
const asRow = (row: unknown) => row as CollectionRow

async function removeCollection(item: CollectionRow) {
  busy.value = item.name
  try {
    const ok = await useConfirm().ask({
      title: `删除集合「${item.name}」?`,
      message: deleteCollectionMessage(item),
      confirmText: '删除',
      tone: 'danger',
      doneText: '集合已删除',
      action: () => callCapability('delete_collection', { collection: item.name }),
    })
    if (!ok) return
    await reloadAll()
  } finally {
    busy.value = ''
  }
}

function openMigration(item: CollectionRow) {
  migrating.value = item
  plan.value = null
  planError.value = ''
  migrateError.value = ''
  // 默认选第一个和当前不同的模型;选了和当前相同的没有意义
  targetEmbedder.value = EMBEDDERS.find((name) => !sameModel(item, name)) ?? EMBEDDERS[0]
  void estimate()
}

function closeMigration() {
  estimateSeq += 1
  migrating.value = null
  plan.value = null
  planError.value = ''
  migrateError.value = ''
}

function pickTarget(value: string | number) {
  targetEmbedder.value = value
  void estimate()
}

/** 估算要做多少事。连续切换模型时,晚到的旧结果不能盖掉新结果(用序号判断) */
async function estimate() {
  const item = migrating.value
  if (!item) return
  const seq = ++estimateSeq
  plan.value = null
  planError.value = ''
  migrateError.value = ''
  const to = String(targetEmbedder.value)
  if (sameModel(item, to)) {
    planLoading.value = false
    return
  }
  planLoading.value = true
  try {
    const result = await callCapability<MigrationPlan>('migrate_plan', { collection: item.name, to })
    if (seq === estimateSeq) plan.value = result
  } catch (err) {
    if (seq === estimateSeq) planError.value = adminFailure(err, '估算').message
  } finally {
    if (seq === estimateSeq) planLoading.value = false
  }
}

async function runMigration() {
  const item = migrating.value
  if (!item || !plan.value) return
  busy.value = item.name
  migrateError.value = ''
  try {
    const result = await callCapability<{ job_id: string }>('migrate_model', { collection: item.name, to: String(targetEmbedder.value) })
    toast.push(`已开始更换「${item.name}」的索引模型,进度在「任务」页(任务编号 ${result.job_id})`)
    closeMigration()
    await loadCollections()
  } catch (err) {
    migrateError.value = adminFailure(err, '更换索引模型').message
  } finally {
    busy.value = ''
  }
}

const embedderOptions = computed(() =>
  EMBEDDERS.map((name) => ({ value: name as string, label: migrating.value && sameModel(migrating.value, name) ? `${name}(当前)` : name })),
)
const canMigrate = computed(() => !!plan.value && !planLoading.value && !busy.value)
</script>

<template>
  <AppShell>
    <div class="kb-pj" data-testid="projects">
      <KbPageHeader title="项目与集合" description="项目是管理员在服务器上登记的代码目录;集合是知识库里的一组内容,每个项目会生成自己的集合。">
        <template v-if="allowed" #actions>
          <KbButton variant="primary" data-testid="project-add" @click="showAdd = !showAdd">添加项目</KbButton>
        </template>
        <p v-if="allowed && projectsPhase === 'ready' && collectionsPhase === 'ready'" class="m kb-pj-summary" data-testid="projects-summary">{{ summary }}</p>
      </KbPageHeader>

      <AdminLoadState v-if="!allowed" phase="forbidden" :message="NO_ACCESS_TEXT" />

      <template v-else>
        <div v-if="actionError" class="card kb-pj-alert" role="alert" data-testid="project-error">
          <span class="kb-pj-alert-text">{{ actionError }}</span>
          <KbButton size="sm" data-testid="project-error-close" @click="actionError = ''">知道了</KbButton>
        </div>

        <section v-if="showAdd" class="card kb-pj-add" data-testid="project-add-card">
          <h2 class="kb-pj-h">添加项目</h2>
          <p class="m kb-pj-lead">填服务器上的目录。会按 .gitignore 和排除规则扫描,添加后马上开始一次全量索引。</p>
          <KbFormRow label="目录" hint="服务器上的绝对路径,例如 /srv/workspace/my-project">
            <KbInput v-model="newPath" placeholder="/srv/workspace/my-project" />
          </KbFormRow>
          <KbFormRow label="显示名" hint="留空就用目录名">
            <KbInput v-model="newName" placeholder="可选" />
          </KbFormRow>
          <div class="kb-pj-btns">
            <KbButton @click="showAdd = false">取消</KbButton>
            <KbButton variant="primary" :disabled="!newPath.trim() || addBusy" data-testid="project-add-go" @click="addProject">{{ addBusy ? '添加中…' : '添加并索引' }}</KbButton>
          </div>
        </section>

        <!-- 项目 -->
        <section class="kb-pj-sec" data-testid="projects-section">
          <div class="kb-pj-secbar"><h2 class="kb-pj-h">项目</h2><span v-if="projectsPhase === 'ready'" class="m">{{ projects.length }} 个</span></div>
          <p v-if="projectsPhase === 'ready' && projects.length" class="m kb-pj-lead" data-testid="projects-lead">每个项目可以设置只索引哪些文件(include)、不索引哪些文件(exclude),点「编辑」修改;留空表示全部文件。增量索引只处理改动过的文件,全量重建会重新处理所有文件,大项目要几分钟。</p>
          <AdminLoadState v-if="projectsPhase === 'loading' || projectsPhase === 'error' || projectsPhase === 'forbidden'" :phase="projectsPhase" :message="projectsMessage" skeleton="card" @retry="retryProjects" />
          <div v-else-if="!projects.length" class="card" data-testid="projects-empty">
            <KbEmpty icon="folder" title="还没有项目" description="把服务器上的一个代码目录登记进来,按 .gitignore 和排除规则扫描并建立索引。">
              <template #action><KbButton variant="primary" @click="showAdd = true">添加项目</KbButton></template>
            </KbEmpty>
          </div>
          <div v-else class="kb-grid kb-grid-3 kb-pj-grid">
            <article v-for="item in sortedProjects" :key="item.project.id" class="card kb-pj-card" data-testid="project-card" :data-project="item.project.name">
              <header class="kb-pj-head">
                <h3 class="kb-pj-name">{{ item.project.name }}</h3>
                <span class="m kb-pj-indexed">{{ indexedText(item.project.last_indexed_at, relativeTime) }}</span>
              </header>
              <p class="mono m kb-pj-path">{{ item.project.root_path }}</p>
              <StatusRows :rows="projectRows(item)" />
              <ul class="kb-pj-switches">
                <li v-for="row in projectSwitches(item, aiOn)" :key="row.key" class="kb-pj-sw" :data-testid="`switch-${row.key}`">
                  <div class="kb-pj-sw-text">
                    <span>{{ row.label }}</span>
                    <small class="m">{{ row.help }}</small>
                    <small v-if="row.note" :id="`sw-note-${item.project.id}-${row.key}`" class="kb-pj-sw-note" data-testid="switch-note">{{ row.note }}</small>
                  </div>
                  <KbSwitch
                    :model-value="row.on"
                    :disabled="busy === item.project.id || !!row.disabled"
                    :aria-label="row.label"
                    :aria-describedby="row.note ? `sw-note-${item.project.id}-${row.key}` : undefined"
                    @update:model-value="(value: boolean) => flip(item, row, value)"
                  />
                </li>
              </ul>
              <footer class="kb-pj-actions">
                <KbButton size="sm" :disabled="busy === item.project.id" data-testid="project-reindex" @click="reindex(item, 'incremental')"><KbIcon name="refresh" :size="14" />增量索引</KbButton>
                <KbButton size="sm" :disabled="busy === item.project.id" data-testid="project-rebuild" @click="reindex(item, 'full')">全量重建</KbButton>
                <KbButton size="sm" :disabled="busy === item.project.id" data-testid="project-edit" @click="openEdit(item)">编辑</KbButton>
                <KbButton size="sm" variant="danger" :disabled="busy === item.project.id" data-testid="project-remove" @click="removeProject(item)"><KbIcon name="trash" :size="14" />移除</KbButton>
              </footer>
            </article>
          </div>
        </section>

        <!-- 服务器目录与 Git 来源(原在「导入」页的数据源里,移到管理组) -->
        <section class="card kb-clip kb-srv-card" data-testid="server-sources">
          <div class="ch">
            服务器目录与 Git 来源<span class="m kb-light">· {{ serverSources.length }} 个</span>
            <div class="r">
              <KbButton size="sm" :disabled="!serverSources.length" data-testid="server-sync-all" @click="sourceStore.syncAll(serverSources)">全部同步</KbButton>
              <KbButton size="sm" variant="primary" data-testid="server-add" @click="addingSource = true">+ 添加来源</KbButton>
            </div>
          </div>
          <p class="m kb-srv-note">读取服务器上的目录和外部 Git 仓库,只有管理员能添加。普通用户在「导入」页处理自己的网页、文件和笔记。</p>
          <KbEmpty v-if="sourceStore.error.value" icon="failed" size="sm" title="没能读取数据来源" :description="sourceStore.error.value" data-testid="server-sources-error">
            <template #action><KbButton size="sm" @click="sourceStore.refresh">重新加载</KbButton></template>
          </KbEmpty>
          <SourceTable v-else :rows="serverSources" :stats="sourceStore.statsById.value" :busy="sourceStore.busy.value" :loading="sourceStore.loading.value" empty="还没有服务器目录或 Git 来源" @open="(row) => (sourceDetail = row)" @sync="sourceStore.sync" />
        </section>

        <!-- 集合 -->
        <section class="kb-pj-sec" data-testid="collections-section">
          <div class="kb-pj-secbar"><h2 class="kb-pj-h">集合</h2><span v-if="collectionsPhase === 'ready'" class="m" data-testid="collections-summary">{{ collectionsSummary(collections) }}</span></div>
          <AdminLoadState v-if="collectionsPhase === 'loading' || collectionsPhase === 'error' || collectionsPhase === 'forbidden'" :phase="collectionsPhase" :message="collectionsMessage" skeleton="table" @retry="retryCollections" />
          <div v-else class="card kb-pj-colls">
            <p class="m kb-pj-lead">更换索引模型:先估算工作量,确认后在后台执行,期间搜索照常使用旧索引。</p>
            <KbResponsiveTable class="kb-pj-table" :columns="collectionColumns" :rows="collectionRows" row-key="name" empty="还没有集合">
              <template #empty>
                <KbEmpty icon="folder" title="还没有集合" description="添加项目或导入文件后,会自动生成集合。">
                  <template #action><KbButton variant="primary" @click="router.push(PATHS.import)">去导入</KbButton></template>
                </KbEmpty>
              </template>
              <template #cell-name="{ row }">{{ asRow(row).name }}</template>
              <template #cell-type="{ row }"><KbBadge>{{ collectionKind(asRow(row)) }}</KbBadge></template>
              <template #cell-model="{ row }">{{ modelText(asRow(row)) }}</template>
              <template #cell-rows="{ row }">{{ asRow(row).rows.toLocaleString('en-US') }}</template>
              <template #cell-table="{ row }">{{ asRow(row).active_table }}</template>
              <template #cell-status="{ row }">
                <span class="kb-pj-status">
                  <KbBadge :tone="statusView(asRow(row), jobs).tone" class="kb-pj-badge">{{ statusView(asRow(row), jobs).text }}</KbBadge>
                  <span v-if="statusView(asRow(row), jobs).target" class="m kb-pj-target">{{ statusView(asRow(row), jobs).target }}</span>
                </span>
              </template>
              <template #cell-actions="{ row }">
                <span class="kb-pj-rowbtns">
                  <KbButton size="sm" :disabled="!!asRow(row).migrating_to || busy === asRow(row).name" data-testid="collection-migrate" @click="openMigration(asRow(row))">更换索引模型</KbButton>
                  <KbButton size="sm" variant="danger" :disabled="busy === asRow(row).name" data-testid="collection-delete" @click="removeCollection(asRow(row))"><KbIcon name="trash" :size="14" />删除</KbButton>
                </span>
              </template>
              <!-- 手机上的集合卡:名字 + 类型 + 状态,一行模型和片段数,更换中显示进度,操作按钮整行排开 -->
              <template #card="{ row }">
                <div class="kb-pj-ccard" data-testid="collection-card">
                  <div class="kb-pj-ccard-head">
                    <b class="mono kb-pj-ccard-name">{{ asRow(row).name }}</b>
                    <KbBadge class="kb-pj-badge">{{ collectionKind(asRow(row)) }}</KbBadge>
                    <KbBadge :tone="statusView(asRow(row), jobs).tone" class="kb-pj-badge">{{ statusView(asRow(row), jobs).text }}</KbBadge>
                  </div>
                  <div class="m kb-pj-ccard-line">{{ modelText(asRow(row)) }} · {{ asRow(row).rows.toLocaleString('en-US') }} 个内容片段</div>
                  <template v-if="asRow(row).migrating_to">
                    <div class="m kb-pj-ccard-line">{{ statusView(asRow(row), jobs).target }}</div>
                    <KbProgress v-if="migrationPercent(jobs, asRow(row).name) !== null" :value="migrationPercent(jobs, asRow(row).name) ?? 0" label="迁移进度" />
                  </template>
                  <div class="kb-pj-ccard-actions">
                    <KbButton size="sm" :disabled="!!asRow(row).migrating_to || busy === asRow(row).name" data-testid="collection-migrate" @click="openMigration(asRow(row))">更换索引模型</KbButton>
                    <KbButton size="sm" variant="danger" :disabled="busy === asRow(row).name" data-testid="collection-delete" @click="removeCollection(asRow(row))"><KbIcon name="trash" :size="14" />删除</KbButton>
                  </div>
                </div>
              </template>
            </KbResponsiveTable>
          </div>
        </section>

        <!-- 项目里的文件去哪了:进了库的、被跳过的各多少 -->
        <FileStatusBars v-if="projects.length" :projects="fileStatusProjects" />

        <SourceDetail v-if="sourceDetail" :source="sourceDetail" :busy="sourceStore.busy.value === sourceDetail.id" @close="sourceDetail = null" @sync="sourceStore.sync(sourceDetail)" @remove="removeSource" />
        <AddDataDialog v-if="addingSource" :collections="sourceStore.collections.value" :max-file-mb="sourceStore.maxFileMb.value" :kinds="[...SERVER_KINDS]" initial-kind="local_dir" @close="addingSource = false" @added="sourceStore.refresh" />

        <!-- 编辑项目 -->
        <KbDialog v-if="editing" :title="`编辑项目 · ${editing.name}`" @close="editing = null">
          <KbFormRow label="只索引这些文件" hint="用逗号分隔的匹配规则,例如 src/**, docs/**;留空就是全部文件(include)">
            <KbInput v-model="form.include" placeholder="src/**, docs/**" />
          </KbFormRow>
          <KbFormRow label="不索引这些文件" hint="用逗号分隔的匹配规则,会和全站的排除规则合并(exclude)">
            <KbInput v-model="form.exclude" placeholder="vendor/**, *.min.js" />
          </KbFormRow>
          <template v-if="aiOn">
            <KbFormRow label="允许发给云端模型" hint="打开后,这个项目的代码片段可以发给云端模型,用于自动提炼(allow_cloud_llm)">
              <KbSwitch v-model="form.allow_cloud_llm" aria-label="允许发给云端模型" />
            </KbFormRow>
            <KbFormRow label="自动提炼" hint="提交代码或会话结束后,自动整理出候选笔记,放进审核收件箱(extract_enabled)">
              <KbSwitch v-model="form.extract_enabled" aria-label="自动提炼" />
            </KbFormRow>
          </template>
          <KbFormRow label="保存后重建索引" hint="改了上面的规则,建议重建一次,让已有内容跟上新规则">
            <KbSwitch v-model="form.reindex" aria-label="保存后重建索引" />
          </KbFormRow>
          <div class="kb-pj-btns">
            <KbButton @click="editing = null">取消</KbButton>
            <KbButton variant="primary" :disabled="busy === editing.id" data-testid="project-save" @click="saveEdit">保存</KbButton>
          </div>
        </KbDialog>

        <!-- 更换索引模型(先估算,再确认) -->
        <KbDialog v-if="migrating" :title="`更换索引模型 · ${migrating.name}`" @close="closeMigration">
          <p class="m kb-pj-lead">把这个集合的索引换成另一个模型重新建一遍。后台会新建一份索引再切换,期间搜索照常使用旧索引;旧索引会保留,可以回滚。进度在「任务」页看。</p>
          <KbFormRow label="新的索引模型" :hint="`现在用的是 ${embedderName(migrating.embedder_id)}。选好后会先估算工作量,确认了才开始。`">
            <KbSelect :model-value="targetEmbedder" :options="embedderOptions" aria-label="新的索引模型" @update:model-value="pickTarget" />
          </KbFormRow>
          <p v-if="sameModel(migrating, String(targetEmbedder))" class="kb-pj-same" role="status" data-testid="migrate-same">和现在用的模型相同,不需要更换。换一个不同的模型再看估算。</p>
          <div v-else-if="planLoading" class="m" role="status" data-testid="migrate-loading">正在估算工作量…</div>
          <div v-else-if="planError" class="kb-pj-fail" role="alert" data-testid="migrate-plan-error">
            <span>{{ planError }}</span>
            <KbButton size="sm" data-testid="migrate-retry" @click="estimate">重新估算</KbButton>
          </div>
          <StatusRows v-else-if="plan" :rows="planRows(plan)" data-testid="migrate-plan" />
          <p v-if="migrateError" class="kb-pj-fail-text" role="alert" data-testid="migrate-error">{{ migrateError }}</p>
          <div class="kb-pj-btns">
            <KbButton @click="closeMigration">取消</KbButton>
            <KbButton variant="primary" :disabled="!canMigrate" data-testid="migrate-go" @click="runMigration">确认更换(后台执行)</KbButton>
          </div>
        </KbDialog>
      </template>
    </div>
  </AppShell>
</template>

<style scoped>
/* 页面内容区是纵向 flex 且自己滚动;带 overflow: clip 的卡片在 WebKit 里会被 flex 收缩到 0 高(内容全被裁掉),所以不让它收缩 */
.kb-srv-card { flex: 0 0 auto; }
.kb-srv-note { margin: 0; padding: var(--sp-2) var(--card-pad-ui); font-size: var(--text-12); }

.kb-pj { display: flex; flex-direction: column; gap: var(--gap); width: 100%; min-width: 0; flex: 0 0 auto; }
.kb-pj > * { flex: 0 0 auto; min-width: 0; }
.kb-pj-summary { margin: var(--sp-1) 0 0; font-size: var(--text-13); overflow-wrap: anywhere; }
.kb-pj-h { margin: 0; font-size: var(--text-16); font-weight: var(--fw-title); line-height: var(--lh-tight); }
.kb-pj-lead { margin: 0; font-size: var(--text-12); overflow-wrap: anywhere; }
.kb-pj-sec { display: flex; flex-direction: column; gap: var(--sp-3); }
.kb-pj-secbar { display: flex; align-items: baseline; flex-wrap: wrap; gap: var(--sp-2); }
.kb-pj-btns { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: var(--sp-2); }
.kb-pj-alert { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-3); padding: var(--card-pad-ui); border-color: var(--status-danger); }
.kb-pj-alert-text { flex: 1 1 240px; min-width: 0; color: var(--status-danger-text); font-size: var(--text-13); overflow-wrap: anywhere; }
.kb-pj-add { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--card-pad-ui); }

/* 项目卡片 */
.kb-pj-grid > * { min-width: 0; }
.kb-pj-card { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--card-pad-ui); min-width: 0; }
.kb-pj-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3); min-width: 0; }
.kb-pj-name { margin: 0; flex: 1 1 auto; min-width: 0; font-size: var(--text-16); font-weight: var(--fw-title); overflow-wrap: anywhere; }
.kb-pj-indexed { font-size: var(--text-12); }
.kb-pj-path { margin: 0; font-size: var(--text-12); overflow-wrap: anywhere; }
.kb-pj-switches { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
.kb-pj-sw { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-3); padding-top: var(--sp-3); border-top: var(--hl) solid var(--b); min-width: 0; }
.kb-pj-sw-text { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; font-size: var(--text-13); }
.kb-pj-sw-text small { font-size: var(--text-12); line-height: var(--lh-body); overflow-wrap: anywhere; }
.kb-pj-sw-text .kb-pj-sw-note { color: var(--status-warning-text); }
.kb-pj-sw > :last-child { flex: 0 0 auto; }
/* 卡片在栅格里被拉成等高,但内容长短不一:操作行要贴底,否则同一行三张卡的主按钮不在一条线上 */
.kb-pj-actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-top: auto; }

/* 集合 */
.kb-pj-colls { padding: var(--card-pad-ui); display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
.kb-pj-table { min-width: 0; }
.kb-pj-status { display: inline-flex; align-items: center; flex-wrap: wrap; gap: var(--sp-1) var(--sp-2); }
.kb-pj-badge { flex: 0 0 auto; white-space: nowrap; }
.kb-pj-target { font-size: var(--text-12); }
.kb-pj-rowbtns { display: inline-flex; gap: var(--sp-2); }
.kb-pj-ccard { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
.kb-pj-ccard-head { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2); min-width: 0; }
.kb-pj-ccard-name { flex: 1 1 100%; min-width: 0; overflow-wrap: anywhere; }
.kb-pj-ccard-line { font-size: var(--text-13); overflow-wrap: anywhere; }
.kb-pj-ccard-actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); padding-top: var(--sp-1); }

/* 更换索引模型对话框 */
.kb-pj-same { margin: 0; font-size: var(--text-13); color: var(--status-warning-text); }
.kb-pj-fail { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-3); font-size: var(--text-13); color: var(--status-danger-text); }
.kb-pj-fail-text { margin: 0; font-size: var(--text-13); color: var(--status-danger-text); overflow-wrap: anywhere; }
</style>
