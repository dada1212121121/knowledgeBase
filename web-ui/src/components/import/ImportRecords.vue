<script setup lang="ts">
// 导入记录:原「上传与解析队列」页,现在是「导入」页里的一个页签。
// 默认看「最近一个批次」;batch=all 看全部文件;filter 预设筛选(指标卡点进来用)。
// 数据:list_ingest / get_batch_progress;动作:retry_ingest / release_quarantine / pause_batch / resume_batch / cancel_batch;
// 实时进度走 WS 的 `ingest.stage` / `ingest.status`。点一行去单文件时间线,点批次号去批次流水线。
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { KbBadge, KbButton, KbEmpty, KbIcon, KbProgress, KbResponsiveTable, KbSegmented, useConfirm, useToast, type RtColumn } from '@kb-ui/index'
import { useLiveEvents } from '@/composables/useLiveEvents'
import { useLiveRefresh } from '@/composables/useLiveRefresh'
import { importBatch, importFile } from '@/router/paths'
import { useUploadStore } from '@/stores/upload'
import { relativePathOf, uploadFile } from '@/api/upload'
import { fileChip, formatSize } from '@/utils/files'
import { contentText, countRecords, etaText, filterRecords, formatElapsed, overallPercent, stageDots, stateTag, type IngestFileRow, type RecordFilter, type StageProgress } from '@/utils/ingest'
import { useViewCall } from '@/composables/useViewCall'

interface BatchProgress {
  batch: string
  collection: string
  state: 'running' | 'paused' | 'canceled' | 'done'
  stage: string
  done: number
  total: number
  chunks: number
  vectors: number
  throughput_cps: number
  eta_s: number | null
  elapsed_s: number
  current_files: string[]
  backend: string
  stages: StageProgress[]
}

const props = withDefaults(defineProps<{ filter: RecordFilter; batch: string; readonly?: boolean; viewAs?: string }>(), {
  readonly: false,
  viewAs: '',
})
const emit = defineEmits<{ 'update:filter': [value: RecordFilter] }>()
/** 管理员只读查看:所有读取带目标用户;动作入口在只读模式下不渲染,这里也再挡一层 */
const callCapability = useViewCall(() => props.viewAs)

const toast = useToast()
const router = useRouter()
const uploads = useUploadStore()

const files = ref<IngestFileRow[]>([])
const total = ref(0)
const loading = ref(true)
const error = ref('')
const busy = ref('')
const progress = ref<BatchProgress | null>(null)
const activeBatch = ref('')
const sourceNames = ref<Record<string, string>>({})

const counts = computed(() => countRecords(files.value))
const filterOptions = computed(() => [
  { value: 'all', label: `全部 ${counts.value.all}` },
  { value: 'active', label: `进行中 ${counts.value.active}` },
  { value: 'failed', label: `失败 ${counts.value.failed}` },
  { value: 'quarantined', label: `隔离 ${counts.value.quarantined}` },
])
const rows = computed(() => filterRecords(files.value, props.filter))

const columns: RtColumn[] = [
  { key: 'rel_path', label: '文件', mobile: 'primary' },
  { key: 'source', label: '数据源', cellClass: 'm', mobile: 'meta' },
  { key: 'content', label: '内容', cellClass: 'm mono', mobile: 'meta' },
  { key: 'state', label: '状态', mobile: 'meta' },
  { key: 'elapsed', label: '耗时', cellClass: 'mono m', mobile: 'meta' },
  { key: 'reason', label: '原因', cellClass: 'm kb-rec-reason', mobile: 'meta' },
]
const as = (row: unknown) => row as IngestFileRow
/** 类型徽标按文件名取;压缩包里的文件(`a.zip › x/y.sql`)显示压缩包自己的类型 */
const chipOf = (file: IngestFileRow) => fileChip((file.rel_path.split(' › ')[0] ?? '').split('/').pop() ?? '')
const sourceOf = (file: IngestFileRow) => (file.source_id && sourceNames.value[file.source_id]) || file.collection

const percent = computed(() => overallPercent(progress.value?.stages ?? [], counts.value))
const dots = computed(() => stageDots(progress.value?.stages ?? []))
const dotColor = { done: 'var(--g)', active: 'var(--ac)', idle: 'var(--m2)' } as const
/** 本机浏览器正在传的字节(来自上传 store;不是本页批次的话就是 0) */
const uploadBytes = computed(() => ({ all: uploads.totalBytes, sent: uploads.sentBytes, show: !props.readonly && uploads.hasActive && uploads.totalBytes > 0 }))
const progressNote = computed(() => [uploadBytes.value.show ? `上传 ${formatSize(uploadBytes.value.sent)} / ${formatSize(uploadBytes.value.all)}` : '', progress.value?.eta_s != null ? `剩余约 ${etaText(progress.value.eta_s)}` : ''].filter(Boolean).join(' · '))
const batchState = computed(() => progress.value?.state ?? 'running')

async function refresh() {
  loading.value = true
  try {
    // 范围:batch=all → 全部文件;batch=<id> → 指定批次;否则取最近一个带批次的文件所在的批次
    let batch = props.batch === 'all' ? '' : props.batch
    if (!props.batch) {
      const recent = await callCapability<{ files: IngestFileRow[] }>('list_ingest', { page_size: 50 })
      batch = recent.files.find((file) => file.batch_id)?.batch_id ?? ''
    }
    activeBatch.value = batch
    const listed = await callCapability<{ files: IngestFileRow[]; total: number }>('list_ingest', { ...(batch ? { batch_id: batch } : {}), page_size: 200 })
    files.value = listed.files ?? []
    total.value = listed.total ?? files.value.length
    error.value = ''
  } catch (err) {
    // 有旧数据就留着(实时刷新失败不该把整张表换成报错),一次都没成功才整块报错
    if (!files.value.length) error.value = err instanceof Error && /[\u4e00-\u9fff]/.test(err.message) ? err.message : '读取导入记录失败。检查网络后重试。'
  } finally {
    loading.value = false
  }
}

async function loadSources() {
  try {
    const listed = await callCapability<{ sources: { id: string; name: string }[] }>('list_sources')
    sourceNames.value = Object.fromEntries(listed.sources.map((item) => [item.id, item.name]))
  } catch {
    // 没有数据源名字就退回显示集合名
  }
}

async function loadProgress(batch: string) {
  if (!batch) {
    progress.value = null
    return
  }
  activeBatch.value = batch
  try {
    progress.value = await callCapability<BatchProgress>('get_batch_progress', { batch })
  } catch {
    // 没有进度信息(批次已清理)不影响列表
    progress.value = null
  }
}

async function load() {
  await refresh()
  await loadProgress(activeBatch.value)
}

async function act(name: string, args: Record<string, unknown>, done: string) {
  if (props.readonly) return
  busy.value = String(args.id ?? args.batch ?? name)
  try {
    await callCapability(name, args)
    toast.push(done)
    await load()
  } catch (err) {
    toast.push(`${done}失败:${err instanceof Error ? err.message : '请稍后再试'}`, 'danger')
  } finally {
    busy.value = ''
  }
}

const retry = (file: IngestFileRow) => act('retry_ingest', { ids: [file.id] }, `已重新入队 ${file.rel_path}`)
const release = (file: IngestFileRow) => act('release_quarantine', { id: file.id }, `已释放 ${file.rel_path}`)
async function retryFailed() {
  const ids = files.value.filter((file) => file.state === 'failed').map((file) => file.id)
  if (ids.length) await act('retry_ingest', { ids }, `已重新入队 ${ids.length} 个失败文件`)
}
const pause = () => (activeBatch.value ? act('pause_batch', { batch: activeBatch.value }, '已暂停') : undefined)
const resume = () => (activeBatch.value ? act('resume_batch', { batch: activeBatch.value }, '已继续') : undefined)
async function cancel() {
  if (props.readonly || !activeBatch.value) return
  const ok = await useConfirm().ask({ title: '取消这个批次?', message: '在途文件会回滚,已完成的文件保留。', confirmText: '取消批次', cancelText: '再想想', tone: 'danger' })
  if (!ok) return
  await act('cancel_batch', { batch: activeBatch.value }, '已取消')
}

/* ---------------- 导入后的引用体检 ---------------- */
// 只检查 Markdown:解析器只把 Markdown 当文档,表格 / 代码里的方括号不是引用。
// 每篇先取图谱里的出链,再用 check_links 实时确认目标还在不在;查不到的服务 / 旧批次直接跳过。
interface AuditLink {
  href: string
  line: number
  label: string
  state: string
  reason: string
  /** 目标类型与解析后的落点:补传时直接放到这个路径,而不是让用户猜目录 */
  targetKind: 'file' | 'note'
  targetCollection: string
  targetPath: string
}
interface AuditDoc {
  collection: string
  path: string
  links: AuditLink[]
}
const auditDocs = ref<AuditDoc[]>([])
const auditOpen = ref(false)
const auditing = ref(false)
const auditError = ref('')
const auditMissing = computed(() => auditDocs.value.reduce((sum, doc) => sum + doc.links.length, 0))
const auditFiles = computed(() => auditDocs.value.length)
/** 能通过「补传」修的文件断链(笔记断链不能靠上传修);按 collection + 路径去重。 */
const auditUploadTargets = computed(() => {
  const targets = new Map<string, { collection: string; path: string }>()
  for (const doc of auditDocs.value) {
    for (const link of doc.links) {
      if (link.state !== 'missing' || link.targetKind !== 'file' || !link.targetPath) continue
      targets.set(`${link.targetCollection}\u0000${link.targetPath}`, { collection: link.targetCollection, path: link.targetPath })
    }
  }
  return [...targets.values()]
})
const auditUploadInput = ref<HTMLInputElement | null>(null)
const auditUploading = ref(false)

async function auditLinks() {
  if (auditing.value) return
  auditing.value = true
  auditError.value = ''
  try {
    const docs = files.value
      .filter((file) => file.state === 'done' && /\.md$/i.test(file.rel_path) && !file.rel_path.includes(' › '))
      .slice(0, 50)
    const found: AuditDoc[] = []
    for (const doc of docs) {
      let outbound: { href: string; line: number; label: string; target_kind: string; target_collection: string | null; target_id: string | null }[] = []
      try {
        const graph = await callCapability<{ outbound?: typeof outbound }>('doc_links', {
          collection: doc.collection,
          path: doc.rel_path,
          direction: 'from',
          limit: 200,
        })
        outbound = graph.outbound ?? []
      } catch {
        // 文件刚导入还没进链接索引:跳过,不把「暂时没有图谱」当成断链
        continue
      }
      const targets = outbound.filter((link) => (link.target_kind === 'file' || link.target_kind === 'note') && link.target_id)
      if (!targets.length) continue
      const checked = await callCapability<{ items?: { state: string; reason?: string }[] }>('check_links', {
        targets: targets.map((link) =>
          link.target_kind === 'note'
            ? { kind: 'note', collection: '', path: '', note_id: link.target_id }
            : { kind: 'file', collection: link.target_collection ?? doc.collection, path: link.target_id, note_id: null },
        ),
      })
      const links = targets
        .map((link, index) => ({
          href: link.href,
          line: link.line,
          label: link.label,
          state: checked.items?.[index]?.state ?? 'unknown',
          reason: checked.items?.[index]?.reason ?? '暂时无法检查',
          targetKind: link.target_kind as 'file' | 'note',
          targetCollection: link.target_collection ?? doc.collection,
          targetPath: link.target_kind === 'file' ? (link.target_id ?? '') : '',
        }))
        .filter((link) => link.state !== 'ok')
      if (links.length) found.push({ collection: doc.collection, path: doc.rel_path, links })
    }
    auditDocs.value = found
    auditOpen.value = true
  } catch (err) {
    auditError.value = err instanceof Error ? err.message : '引用体检失败,请稍后再试'
  } finally {
    auditing.value = false
  }
}

/**
 * 选文件补传:文件按名字对应到断链路径,上传时直接指定目标路径。
 *
 * 不要求用户重选原目录结构:导入记录里已经知道目标落在哪,补传只缺内容本身。
 * 同名目标有多个时优先用相对路径后缀匹配,仍然对不上就跳过并明确说出来,绝不猜。
 */
async function uploadAuditFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const picked = [...(input.files ?? [])]
  input.value = ''
  if (!picked.length || auditUploading.value) return
  const byName = new Map<string, { collection: string; path: string }[]>()
  for (const target of auditUploadTargets.value) {
    const name = target.path.split('/').pop() ?? target.path
    const list = byName.get(name) ?? []
    list.push(target)
    byName.set(name, list)
  }
  const used = new Set<string>()
  const jobs: { file: File; target: { collection: string; path: string } }[] = []
  const unmatched: string[] = []
  for (const file of picked) {
    const candidates = byName.get(file.name) ?? []
    const suffix = relativePathOf(file).replace(/\\/g, '/')
    const target =
      candidates.find((item) => !used.has(`${item.collection}\u0000${item.path}`) && (item.path === suffix || item.path.endsWith(`/${suffix}`))) ??
      candidates.find((item) => !used.has(`${item.collection}\u0000${item.path}`))
    if (!target) {
      unmatched.push(file.name)
      continue
    }
    used.add(`${target.collection}\u0000${target.path}`)
    jobs.push({ file, target })
  }
  if (!jobs.length) {
    toast.push(unmatched.length ? `没有找到这些文件对应的断链路径:${unmatched.slice(0, 3).join('、')}` : '没有可补传的断链', 'danger')
    return
  }
  auditUploading.value = true
  let done = 0
  let failed = 0
  let firstError = ''
  for (const job of jobs) {
    try {
      await uploadFile(job.file, { collection: job.target.collection, relPath: job.target.path })
      done += 1
    } catch (err) {
      failed += 1
      if (!firstError) firstError = err instanceof Error ? err.message : String(err)
    }
  }
  auditUploading.value = false
  const extra = [unmatched.length ? `${unmatched.length} 个对不上路径` : '', failed ? `${failed} 个失败` : ''].filter(Boolean).join(',')
  toast.push(`已补传 ${done} 个${extra ? `(${extra})` : ''}${firstError ? `:${firstError}` : ''}`, failed || unmatched.length ? 'danger' : 'success')
  // 文件已经落盘;重新体检能看到目标从 missing 变 ok(图谱索引慢的时候最多保持旧结果,不会误报为已修好)
  if (done) await auditLinks()
}

watch(() => props.batch, () => void load())
// 上传队列有变化时自动刷新(上传完成后队列里会出现新文件);只读查看没有别的上传,不必跟着自己的队列刷
watch(() => uploads.summary.done, () => !props.readonly && void refresh())

useLiveEvents((event) => {
  if (event.type === 'ingest.stage') {
    const data = event.data as unknown as BatchProgress
    if (!activeBatch.value || data.batch === activeBatch.value) progress.value = data
    return
  }
  if (event.type === 'ingest.status') {
    const data = event.data as { file_id: string; state: IngestFileRow['state'] }
    const file = files.value.find((item) => item.id === data.file_id)
    if (file) file.state = data.state
    return
  }
})
// 任务完成、上传进度的推送很密(上传每个分片一次):合并后再刷新列表,不在每个事件上重读(卡 A,useLiveRefresh)。
// 只靠推送,不轮询;挂载时的第一次读取在下面的 onMounted 里
useLiveRefresh({ load: () => refresh(), interval: 0, immediate: false, events: ['job.done', 'upload.progress'] })

onMounted(async () => {
  void loadSources()
  await load()
})
onUnmounted(() => {
  progress.value = null
})
</script>

<template>
  <div class="kb-rec" data-testid="import-records">
    <KbEmpty v-if="error" icon="failed" title="没能读取导入记录" :description="error" data-testid="records-error">
      <template #action><KbButton variant="primary" @click="load">重新加载</KbButton></template>
    </KbEmpty>

    <template v-else>
      <!-- 批次与操作 -->
      <div class="kb-rec-head">
        <span class="m kb-rec-batch" data-testid="records-scope">
          <template v-if="activeBatch">
            批次 <RouterLink v-if="!readonly" class="mono kb-link" :to="importBatch(activeBatch)" title="查看实时流水线">{{ activeBatch.slice(0, 8) }}</RouterLink><span v-else class="mono">{{ activeBatch.slice(0, 8) }}</span>
            <template v-if="!readonly"> · <button type="button" class="kb-link" :disabled="batchState === 'canceled'" @click="cancel">整批撤销</button></template>
          </template>
          <template v-else>全部入库文件 · 共 {{ total.toLocaleString() }} 个</template>
        </span>
        <span v-if="!readonly" class="kb-rec-actions">
          <KbButton size="sm" :disabled="!counts.done || auditing" data-testid="records-link-audit" @click="auditLinks">{{ auditing ? '检查中…' : '引用体检' }}</KbButton>
          <KbButton size="sm" :disabled="!counts.failed || !!busy" data-testid="records-retry-failed" @click="retryFailed"><KbIcon name="refresh" :size="14" /> 重试失败 {{ counts.failed }}</KbButton>
          <KbButton v-if="batchState === 'paused'" size="sm" :disabled="!activeBatch" @click="resume">继续</KbButton>
          <KbButton v-else size="sm" :disabled="!activeBatch || batchState !== 'running'" @click="pause">暂停</KbButton>
        </span>
      </div>

      <!-- 总体进度(实时阶段并在这里) -->
      <div class="card kb-rec-overall" data-testid="records-overall">
        <div class="kb-rec-overall-top">
          <b>总体进度</b>
          <span class="m">{{ counts.done }} / {{ counts.all }} 完成 · {{ counts.failed }} 失败 · {{ counts.quarantined }} 隔离</span>
          <span v-if="progressNote" class="m mono">{{ progressNote }}</span>
        </div>
        <KbProgress :value="percent" label="总体进度" />
        <div v-if="dots.length" class="kb-rec-stages">
          <span v-for="dot in dots" :key="dot.key" class="kb-rec-stage">
            <span class="dot" :style="{ background: dotColor[dot.state] }" style-allow="阶段圆点颜色按完成度"></span>
            <span class="m">{{ dot.label }}</span>
            <b class="mono">{{ dot.text }}</b>
          </span>
        </div>
      </div>

      <!-- 引用体检:只提示,不自动改导入的文件;目标文件需要人从原目录补传 -->
      <div v-if="auditOpen || auditError" class="card kb-rec-audit" data-testid="records-link-audit-panel">
        <div class="ch">
          <span>引用体检</span>
          <span class="m">{{ auditError ? auditError : auditFiles ? `${auditFiles} 篇有断链 · 共 ${auditMissing} 处` : '没有发现断链' }}</span>
          <span class="r">
            <KbButton v-if="auditUploadTargets.length" size="sm" :disabled="auditUploading" data-testid="records-link-upload" @click="auditUploadInput?.click()">
              {{ auditUploading ? '补传中…' : `选文件补传 ${auditUploadTargets.length}` }}
            </KbButton>
            <button type="button" class="kb-link" @click="auditOpen = false">收起</button>
          </span>
        </div>
        <p v-if="!auditError && auditFiles" class="m kb-rec-audit-note">断链只在导入结果里提示,不会自动改正文。选择文件补传时,系统会按下面的目标路径放置;对不上路径的文件不会被猜着上传。</p>
        <ul v-if="!auditError" class="kb-rec-audit-list">
          <li v-for="doc in auditDocs" :key="`${doc.collection}:${doc.path}`">
            <div class="kb-rec-audit-doc mono">{{ doc.collection }}/{{ doc.path }}</div>
            <div v-for="link in doc.links" :key="`${link.line}:${link.href}`" class="kb-rec-audit-link">
              <span class="m">第 {{ link.line }} 行</span>
              <code>{{ link.href }}</code>
              <span class="kb-danger">{{ link.reason }}</span>
              <span v-if="link.targetKind === 'file' && link.targetPath" class="m">目标:{{ link.targetCollection }}/{{ link.targetPath }}</span>
            </div>
          </li>
        </ul>
        <input ref="auditUploadInput" class="kb-rec-audit-input" type="file" multiple aria-label="选择要补传的文件" @change="uploadAuditFiles" />
      </div>

      <div class="card kb-rec-files">
        <div class="ch">逐文件状态<div class="r"><KbSegmented :model-value="filter" :options="filterOptions" @update:model-value="(value: string) => emit('update:filter', value as RecordFilter)" /></div></div>
        <KbResponsiveTable
          :columns="columns"
          :rows="(rows as unknown as Record<string, unknown>[])"
          :loading="loading"
          empty="导入记录是空的:拖入文件或添加数据后,每个文件的解析进度会出现在这里"
          clickable
          @row-click="(row) => !readonly && router.push(importFile(as(row).id))"
        >
          <template #cell-rel_path="{ row }">
            <span class="kb-rec-file">
              <span class="kb-fmt mono" :class="`is-${chipOf(as(row)).tone}`">{{ chipOf(as(row)).label }}</span>
              <span class="kb-rec-name" :title="as(row).rel_path">{{ as(row).rel_path }}</span>
            </span>
          </template>
          <template #cell-source="{ row }">{{ sourceOf(as(row)) }}</template>
          <template #cell-content="{ row }">{{ contentText(as(row)) }}</template>
          <template #cell-state="{ row }"><KbBadge :tone="stateTag(as(row).state).tone">{{ stateTag(as(row).state).text }}</KbBadge></template>
          <template #cell-elapsed="{ row }">{{ formatElapsed(as(row).elapsed_ms) }}</template>
          <template #cell-reason="{ row }"><span :class="{ 'kb-danger': as(row).state === 'failed' }" :title="as(row).error ?? ''">{{ as(row).error ?? '' }}</span></template>

          <template #card="{ row }">
            <div class="kb-rec-card" data-testid="record-card">
              <div class="kb-rec-file">
                <span class="kb-fmt mono" :class="`is-${chipOf(as(row)).tone}`">{{ chipOf(as(row)).label }}</span>
                <span class="kb-rec-name" :title="as(row).rel_path">{{ as(row).rel_path }}</span>
                <KbBadge :tone="stateTag(as(row).state).tone">{{ stateTag(as(row).state).text }}</KbBadge>
              </div>
              <div class="m kb-rec-line">{{ sourceOf(as(row)) }} · {{ contentText(as(row)) }} · {{ formatElapsed(as(row).elapsed_ms) }}</div>
              <div v-if="as(row).error" class="kb-danger kb-rec-line" :title="as(row).error ?? ''">{{ as(row).error }}</div>
            </div>
          </template>

          <template v-if="!readonly" #row-actions="{ row }">
            <KbButton v-if="as(row).state === 'failed'" size="sm" :disabled="busy === as(row).id" data-testid="record-retry" @click="retry(as(row))"><KbIcon name="refresh" :size="14" /> 重试</KbButton>
            <KbButton v-else-if="as(row).state === 'quarantined'" size="sm" :disabled="busy === as(row).id" data-testid="record-release" @click="release(as(row))">释放</KbButton>
          </template>
        </KbResponsiveTable>
        <div v-if="total > files.length" class="m kb-rec-more">仅显示前 {{ files.length }} 个(共 {{ total.toLocaleString() }} 个)</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.kb-rec { display: flex; flex-direction: column; gap: var(--gap); min-width: 0; }
.kb-rec-head { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2) var(--sp-3); }
.kb-rec-batch { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.kb-rec-audit { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--card-pad-ui); min-width: 0; }
.kb-rec-audit-list { display: flex; flex-direction: column; gap: var(--sp-3); margin: 0; padding: 0; list-style: none; }
.kb-rec-audit-doc { font-weight: 600; overflow-wrap: anywhere; }
.kb-rec-audit-link { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-2); padding: 2px 0; }
.kb-rec-audit-link code { overflow-wrap: anywhere; }
.kb-rec-audit-input { display: none; }
.kb-rec-actions { display: inline-flex; gap: var(--sp-2); flex-wrap: wrap; }
.kb-rec-overall { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--card-pad-ui); min-width: 0; }
.kb-rec-overall-top { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-1) var(--sp-3); }
.kb-rec-stages { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-4); }
.kb-rec-stage { display: inline-flex; align-items: center; gap: var(--sp-2); }
.kb-rec-files { min-width: 0; overflow: hidden; }
.kb-rec-file { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
.kb-rec-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-rec-card { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
.kb-rec-line { font-size: var(--text-12); overflow-wrap: anywhere; }
.kb-rec-more { padding: var(--sp-3) var(--card-pad-ui); }
.kb-link { background: none; border: 0; padding: 0; color: var(--accent-text); cursor: pointer; text-decoration: underline; font: inherit; }
.kb-link:disabled { color: var(--text-tertiary); cursor: default; text-decoration: none; }
@media (pointer: coarse) {
  .kb-link { min-height: 44px; display: inline-flex; align-items: center; }
}
</style>
