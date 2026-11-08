<script setup lang="ts">
// 导入(.5):原来的「数据源」「解析队列」两页合成一页。
//   上面:拖入区(手机是「选择文件」)+ 粘贴网址 + 支持的格式;
//   中间:四个指标(点一下直接看对应的失败 / 隔离 / 进行中的文件);
//   下面:「导入记录」(每个文件的解析进度,失败可重试)和「数据来源」(网页 / 上传 / 压缩包 / 笔记,同步与移除)。
// 服务器目录和 Git 仓库读的是服务器上的东西,归管理员,在「管理 → 项目与集合」里管。
// 旧地址 /import/queue、/ingest 仍然进这一页(落在「导入记录」),详情页(单文件时间线 / 批次流水线)是子页。
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { KbButton, KbDropzone, KbEmpty, KbIcon, KbPageHeader, KbSegmented, KbSelect, KbTabs, PHONE_QUERY, useMedia, type TabItem } from '@kb-ui/index'
import { normalizeFolder, withFolderPrefix } from '@/utils/uploadFolder'
import AppShell from '@/layouts/AppShell.vue'
import AddDataDialog from '@/components/AddDataDialog.vue'
import ImportOverview from '@/components/import/ImportOverview.vue'
import ImportRecords from '@/components/import/ImportRecords.vue'
import SourceDetail from '@/components/import/SourceDetail.vue'
import SourceTable from '@/components/import/SourceTable.vue'
import { requestUpload } from '@/api/upload'
import { useFeature } from '@/composables/useFeature'
import { useSources } from '@/composables/useSources'
import { PATHS } from '@/router/paths'
import { FORMAT_CHIPS } from '@/utils/files'
import { SOURCE_FILTERS, USER_KINDS, isServerKind, matchesFilter, normalizeWebUrl, type SourceFilter, type SourceRow } from '@/utils/importSources'
import { parseRecordFilter, type RecordFilter } from '@/utils/ingest'

const route = useRoute()
const router = useRouter()
const phone = useMedia(PHONE_QUERY)
const canServerSources = useFeature('sources.local')
const store = useSources()
const { sources, statsById, collections, loading, error, busy, counts, maxFileMb, providers, aiExtractDefault } = store

// ---- 地址里的状态:?tab=records|sources、?batch=、?filter=(旧队列页的地址进来也是这几个参数) ----
const tab = computed<'records' | 'sources'>(() => (route.query.tab === 'sources' ? 'sources' : 'records'))
const recordFilter = computed<RecordFilter>(() => parseRecordFilter(route.query.filter))
const batch = computed(() => (typeof route.query.batch === 'string' ? route.query.batch : ''))
function setQuery(patch: Record<string, string | undefined>) {
  const query = { ...route.query, ...patch }
  for (const key of Object.keys(query)) if (query[key] === undefined || query[key] === '') delete query[key]
  void router.replace({ path: PATHS.import, query })
}
const setTab = (value: string) => setQuery({ tab: value === 'sources' ? 'sources' : undefined })
const setFilter = (value: RecordFilter) => setQuery({ filter: value === 'all' ? undefined : value })
/** 指标卡:直接看对应状态的文件(全部批次) */
const showRecords = (filter: RecordFilter) => setQuery({ tab: undefined, batch: 'all', filter: filter === 'all' ? undefined : filter })

// ---- 来源:普通用户只处理自己的(网页 / 上传 / 压缩包 / 笔记) ----
const sourceFilter = ref<SourceFilter>('all')
const mySources = computed(() => sources.value.filter((item) => !isServerKind(item.kind)))
const visibleSources = computed(() => mySources.value.filter((item) => matchesFilter(item, sourceFilter.value)))
const syncing = ref(false)
async function syncAll() {
  syncing.value = true
  try {
    await store.syncAll(mySources.value)
  } finally {
    syncing.value = false
  }
}

const tabs = computed<TabItem[]>(() => [
  { value: 'records', label: '导入记录', count: counts.value?.total },
  { value: 'sources', label: '数据来源', count: mySources.value.length },
])

const fmt = (value: number) => value.toLocaleString()
const subtitle = computed(() => {
  const parts = [`${mySources.value.length} 个数据来源`, `${fmt(counts.value?.total ?? store.totalFiles.value)} 个文件`]
  if (store.rate.value) parts.push(`解析成功率 ${store.rate.value}`)
  return parts.join(' · ')
})

// ---- 目标目录与子文件夹配置 ----
const TARGET_COLLECTION_KEY = 'kb.import.targetCollection'
const TARGET_FOLDER_KEY = 'kb.import.targetFolder'

const targetCollection = ref<string>(
  (typeof route.query.collection === 'string' && route.query.collection) ||
    (() => {
      try {
        return localStorage.getItem(TARGET_COLLECTION_KEY) || ''
      } catch {
        return ''
      }
    })() ||
    collections.value[0] ||
    '_global',
)

watch(
  collections,
  (list) => {
    if (!targetCollection.value && list.length > 0) {
      targetCollection.value = list[0]!
    } else if (targetCollection.value && list.length > 0 && !list.includes(targetCollection.value)) {
      targetCollection.value = list[0]!
    }
  },
  { immediate: true },
)

watch(
  () => route.query.collection,
  (queryCol) => {
    if (typeof queryCol === 'string' && queryCol) {
      targetCollection.value = queryCol
    }
  },
)

watch(targetCollection, (val) => {
  try {
    if (val) localStorage.setItem(TARGET_COLLECTION_KEY, val)
  } catch {
    /* 隐私模式 */
  }
})

const targetFolder = ref<string>(
  (typeof route.query.folder === 'string' && route.query.folder) ||
    (() => {
      try {
        return localStorage.getItem(TARGET_FOLDER_KEY) || ''
      } catch {
        return ''
      }
    })() ||
    '',
)

watch(targetFolder, (val) => {
  try {
    localStorage.setItem(TARGET_FOLDER_KEY, val)
  } catch {
    /* 隐私模式 */
  }
})

const collectionOptions = computed(() =>
  collections.value.map((name) => ({
    value: name,
    label: name === '_global' ? '_global (通用默认)' : name,
  })),
)

// ---- 拖入区 / 粘贴网址 ----
const dropTitle = computed(() => {
  const dest = targetCollection.value || '_global'
  const sub = targetFolder.value.trim() ? ` / ${targetFolder.value.trim()}` : ''
  return phone.value ? `选择要导入的文件 (到 ${dest}${sub})` : `拖入文件或文件夹即可添加到 ${dest}${sub}`
})
const dropNote = computed(() => {
  const parts = [phone.value ? '支持多选' : '支持多选 · 整个文件夹', '.zip 自动解包']
  const mb = maxFileMb.value
  if (mb) parts.push(`单文件 ≤ ${mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`}`)
  return parts.join(' · ')
})
/** 点「选择文件 / 选择文件夹」:加上目标文件夹前缀,并指定目标集合交由上传流程入队。 */
const onPick = (files: File[]) => {
  const norm = normalizeFolder(targetFolder.value)
  const target = norm.ok ? norm.folder : ''
  const prefixed = withFolderPrefix(files, target)
  requestUpload(prefixed, { collection: targetCollection.value || undefined })
}

const webText = ref('')
const webError = ref('')
function addWeb() {
  const url = normalizeWebUrl(webText.value)
  if (!url) {
    webError.value = '这不像一个网址。请粘贴以 http:// 或 https:// 开头的地址,例如 https://docs.example.com/'
    return
  }
  webError.value = ''
  // 抓取深度、目标集合还要用户确认,所以带着网址打开「添加数据」,而不是静默提交
  addInitial.value = { kind: 'web', uri: url }
  showAdd.value = true
  webText.value = ''
}

/** 格式覆盖:文本 / 文档 / 邮件压缩包是内置抽取器(恒支持);OCR 与转写看当前后端是否就绪 */
const coverage = computed(() => {
  const local = (kind: string) => {
    const current = providers.value.find((item) => item.kind === kind && item.current)
    return { note: current?.id ?? '', tag: current?.ready ? '本地' : '未启用', tone: current?.ready ? 'accent' : 'neutral' }
  }
  return [
    { label: '代码 · Markdown · 文本', note: '', tag: '已支持', tone: 'success' },
    { label: 'PDF · Office · HTML · EPUB', note: '文字层', tag: '已支持', tone: 'success' },
    { label: '邮件 · 压缩包', note: '递归', tag: '已支持', tone: 'success' },
    { label: '图片 / 扫描件 OCR', ...local('ocr') },
    { label: '音频 / 视频转写', ...local('transcribe') },
  ] as { label: string; note: string; tag: string; tone: 'success' | 'accent' | 'neutral' }[]
})

// ---- 添加数据 / 来源详情 ----
const showAdd = ref(false)
const addInitial = ref<{ kind: 'upload' | 'web'; uri: string }>({ kind: 'upload', uri: '' })
function openAdd() {
  addInitial.value = { kind: 'upload', uri: '' }
  showAdd.value = true
}
const detail = ref<SourceRow | null>(null)
async function removeDetail() {
  if (detail.value && (await store.remove(detail.value))) detail.value = null
}
/** 详情里改了 AI 规范化:先换成后端返回的新行(抽屉立刻反映),再刷新列表 */
async function onDetailUpdated(updated: SourceRow) {
  detail.value = updated
  await store.refresh()
  detail.value = sources.value.find((item) => item.id === updated.id) ?? updated
}

onMounted(() => void store.refresh())
</script>

<template>
  <AppShell roomy>
    <template #breadcrumb>
      <span>导入</span>
      <span>/</span>
      <b>{{ tab === 'records' ? '导入记录' : '数据来源' }}</b>
    </template>
    <template #actions><span class="kb-none"></span></template>

    <div class="kb-imp" data-testid="import">
      <KbPageHeader title="导入" :description="subtitle">
        <template #actions>
          <KbButton :disabled="!mySources.length || syncing" data-testid="import-sync-all" @click="syncAll"><KbIcon name="refresh" :size="14" /> 全部同步</KbButton>
          <KbButton variant="primary" data-testid="import-add" @click="openAdd">+ 添加数据</KbButton>
        </template>
      </KbPageHeader>

      <!-- 上面:拖入区 + 粘贴网址 + 支持的格式 -->
      <section class="kb-imp-intake">
        <div class="kb-imp-drop">
          <!-- 目标目录与子文件夹配置 -->
          <div class="card kb-imp-dest-bar" data-testid="import-destination-bar">
            <div class="kb-imp-dest-header">
              <KbIcon name="folder" :size="16" />
              <span class="kb-imp-dest-heading">导入存放位置</span>
            </div>
            <div class="kb-imp-dest-row">
              <div class="kb-imp-dest-col">
                <label class="kb-imp-dest-label" for="import-dest-col">目标集合 / 目录</label>
                <KbSelect
                  id="import-dest-col"
                  v-model="targetCollection"
                  :options="collectionOptions"
                  class="kb-imp-dest-select"
                  data-testid="import-target-collection"
                />
              </div>
              <div class="kb-imp-dest-col">
                <label class="kb-imp-dest-label" for="import-dest-folder">子目录 / 文件夹 (可选)</label>
                <input
                  id="import-dest-folder"
                  v-model="targetFolder"
                  class="kb-input kb-imp-dest-input"
                  placeholder="如: 文档、财务/月报 (留空为根目录)"
                  data-testid="import-target-folder"
                />
              </div>
            </div>
          </div>

          <KbDropzone :title="dropTitle" :description="dropNote" :folder="!phone" data-testid="import-drop" @files="onPick">
            <span v-for="chip in FORMAT_CHIPS" :key="chip.label" class="kb-fmt mono" :class="`is-${chip.tone}`">{{ chip.label }}</span>
          </KbDropzone>
          <form class="card kb-imp-web" data-testid="import-web" @submit.prevent="addWeb">
            <label class="kb-imp-web-label" for="import-web-url">或者导入一个网页</label>
            <div class="kb-imp-web-row">
              <input id="import-web-url" v-model="webText" class="kb-input kb-imp-web-input" type="text" inputmode="url" autocomplete="off" placeholder="https://docs.example.com/" :aria-invalid="!!webError" @input="webError = ''" />
              <KbButton type="submit" :disabled="!webText.trim()" data-testid="import-web-go">抓取</KbButton>
            </div>
            <p v-if="webError" class="kb-imp-web-error" role="alert" data-testid="import-web-error">{{ webError }}</p>
          </form>
        </div>
        <details class="card kb-imp-cover" :open="!phone">
          <summary>支持的格式</summary>
          <div class="kb-imp-cover-rows">
            <div v-for="row in coverage" :key="row.label" class="kb-imp-cover-row">
              <span>{{ row.label }}</span>
              <span v-if="row.note" class="m">{{ row.note }}</span>
              <span class="tag" :class="{ g: row.tone === 'success', ac: row.tone === 'accent' }">{{ row.tag }}</span>
            </div>
          </div>
        </details>
      </section>

      <!-- 中间:四个指标 -->
      <div class="kb-imp-metrics" data-testid="import-metrics">
        <button type="button" class="card metric kb-imp-metric" @click="showRecords('all')"><div class="m kb-small">文件总数</div><div class="v">{{ counts ? fmt(counts.total) : fmt(store.totalFiles.value) }}</div><div class="m kb-delta-note">{{ mySources.length }} 个来源</div></button>
        <button type="button" class="card metric kb-imp-metric" data-testid="metric-pending" @click="showRecords('active')"><div class="m kb-small">待解析</div><div class="v">{{ counts ? fmt(counts.pending) : '—' }}</div><div class="m kb-delta-note">{{ counts?.pending ? '队列处理中' : '队列是空的' }}</div></button>
        <button type="button" class="card metric kb-imp-metric" data-testid="metric-failed" @click="showRecords('failed')"><div class="m kb-small">解析失败</div><div class="v">{{ counts ? fmt(counts.failed) : '—' }}</div><div class="m kb-delta-note">{{ counts?.failed ? '可重试' : '没有失败' }}</div></button>
        <button type="button" class="card metric kb-imp-metric" data-testid="metric-quarantined" @click="showRecords('quarantined')"><div class="m kb-small">已隔离</div><div class="v">{{ counts ? fmt(counts.quarantined) : '—' }}</div><div class="m kb-delta-note">超限或格式异常</div></button>
      </div>

      <!-- 导入概况:文件处于什么状态、最近每小时进来多少、失败最多的原因 -->
      <ImportOverview />

      <!-- 下面:导入记录 / 数据来源 -->
      <KbTabs :model-value="tab" :tabs="tabs" class="kb-sticky" @update:model-value="setTab" />

      <ImportRecords v-if="tab === 'records'" :filter="recordFilter" :batch="batch" @update:filter="setFilter" />

      <section v-else class="kb-imp-sources" data-testid="import-sources">
        <KbEmpty v-if="error" icon="failed" title="没能读取数据来源" :description="error" data-testid="sources-error">
          <template #action><KbButton variant="primary" @click="store.refresh">重新加载</KbButton></template>
        </KbEmpty>
        <template v-else>
          <div class="kb-imp-src-bar">
            <KbSegmented v-model="sourceFilter" :options="SOURCE_FILTERS" />
            <p v-if="canServerSources" class="m kb-imp-server-note" data-testid="server-note">服务器目录和 Git 仓库在 <RouterLink :to="PATHS.projects">管理 → 项目与集合</RouterLink> 里管理。</p>
          </div>
          <div class="card kb-imp-src-card">
            <SourceTable :rows="visibleSources" :stats="statsById" :busy="busy" :loading="loading" empty="还没有数据来源:拖入文件、粘贴一个网址或点「添加数据」" @open="(row) => (detail = row)" @sync="store.sync" />
          </div>
        </template>
      </section>
    </div>

    <SourceDetail v-if="detail" :source="detail" :busy="busy === detail.id" @close="detail = null" @sync="store.sync(detail)" @remove="removeDetail" @updated="onDetailUpdated" />

    <AddDataDialog v-if="showAdd" :collections="collections" :max-file-mb="maxFileMb" :kinds="[...USER_KINDS]" :initial-kind="addInitial.kind" :initial-uri="addInitial.uri" :initial-collection="targetCollection" :ai-extract-default="aiExtractDefault" @close="showAdd = false" @added="store.refresh" />
  </AppShell>
</template>

<style scoped>
.kb-imp { display: flex; flex-direction: column; gap: var(--gap); width: 100%; min-width: 0; }
/* 上面一行:左边拖入区 + 网址,右边支持的格式;窄屏上下排 */
.kb-imp-intake { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: var(--gap); align-items: start; min-width: 0; }
.kb-imp-drop { display: flex; flex-direction: column; gap: var(--gap); min-width: 0; }
.kb-imp-dest-bar { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3) var(--card-pad-ui); background: var(--surface-1); }
.kb-imp-dest-header { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--text-13); font-weight: var(--fw-title); color: var(--text-primary); }
.kb-imp-dest-row { display: flex; gap: var(--sp-3); align-items: flex-end; flex-wrap: wrap; }
.kb-imp-dest-col { display: flex; flex-direction: column; gap: 4px; flex: 1 1 160px; min-width: 0; }
.kb-imp-dest-label { font-size: var(--text-12); color: var(--text-secondary); font-weight: var(--fw-medium); }
.kb-imp-dest-select, .kb-imp-dest-input { width: 100%; box-sizing: border-box; }
.kb-imp-web { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--card-pad-ui); min-width: 0; }
.kb-imp-web-label { font-size: var(--text-13); color: var(--text-secondary); }
.kb-imp-web-row { display: flex; gap: var(--sp-2); min-width: 0; }
.kb-imp-web-input { flex: 1 1 auto; min-width: 0; }
.kb-imp-web-error { margin: 0; color: var(--status-danger-text); font-size: var(--text-13); }
.kb-imp-cover { min-width: 0; padding: 0; }
.kb-imp-cover summary { cursor: pointer; padding: var(--sp-3) var(--card-pad-ui); font-weight: var(--fw-title); font-size: var(--text-14); min-height: 2.5em; display: flex; align-items: center; }
.kb-imp-cover-rows { display: flex; flex-direction: column; border-top: var(--hl) solid var(--b); }
.kb-imp-cover-row { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--card-pad-ui); font-size: var(--text-13); }
.kb-imp-cover-row > :first-child { flex: 1 1 auto; min-width: 0; }
.kb-imp-cover-row + .kb-imp-cover-row { border-top: var(--hl) solid var(--b); }
.kb-imp-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(10.5em, 1fr)); gap: var(--gap); min-width: 0; }
.kb-imp-metric { text-align: left; cursor: pointer; font: inherit; color: inherit; }
.kb-imp-metric:focus-visible { outline: none; box-shadow: var(--accent-ring); }
.kb-imp-sources { display: flex; flex-direction: column; gap: var(--gap); min-width: 0; }
.kb-imp-src-bar { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2) var(--sp-4); }
.kb-imp-server-note { margin: 0; font-size: var(--text-13); }
.kb-imp-src-card { min-width: 0; overflow: hidden; }
@media (max-width: 839px) {
  .kb-imp-intake { grid-template-columns: minmax(0, 1fr); }
}
@media (pointer: coarse) {
  .kb-imp-cover summary { min-height: 44px; }
}
@media (max-width: 639px) {
  /* 手机上「抓取」按钮被放大到 44px,输入框还是 28px,并排差 16px(视觉基线规范) */
  .kb-imp-web-row .kb-input { height: 44px; min-height: 44px; }
}
</style>
