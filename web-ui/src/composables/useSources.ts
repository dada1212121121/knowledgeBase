// 数据来源的数据与操作(原来散在 Sources.vue 里):列表、解析队列计数、同步 / 移除、格式覆盖。
// 「导入」页(网页 / 上传 / 压缩包 / 笔记)和「管理 → 项目与集合」里的服务器目录 / Git 来源共用这一份,各取各的类型。
import { computed, ref } from 'vue'
import { useConfirm, useToast } from '@kb-ui/index'
import { callCapability } from '@/api/client'
import { successRate, removeSourceMessage, type SourceRow, type SourceStats } from '@/utils/importSources'

export interface QueueCounts {
  total: number
  pending: number
  failed: number
  quarantined: number
}

/** 格式覆盖里的识别后端(OCR / 转写)。 */
export interface ProviderRow {
  kind: string
  id: string
  ready: boolean
  current: boolean
}

export function useSources() {
  const toast = useToast()
  const sources = ref<SourceRow[]>([])
  const statsById = ref<Record<string, SourceStats>>({})
  const collections = ref<string[]>([])
  const loading = ref(true)
  /** 一次都没取成功才有值(取成功过之后刷新失败不覆盖旧数据,见 refresh) */
  const error = ref('')
  const busy = ref('')
  const counts = ref<QueueCounts | null>(null)
  const maxFileMb = ref<number | null>(null)
  const providers = ref<ProviderRow[]>([])
  /** 新建网页来源时「AI 规范化」的默认值(后端 `[web_extract] enabled_by_default`;旧后端没有就按开) */
  const aiExtractDefault = ref(true)

  const totalFiles = computed(() => sources.value.reduce((sum, item) => sum + item.files, 0))
  const rate = computed(() => successRate(counts.value))

  /** 解析队列各状态的文件数(list_ingest 按 state 过滤后的 total;某一次失败不影响其它) */
  async function loadCounts() {
    const total = (state?: string) =>
      callCapability<{ total: number }>('list_ingest', { ...(state ? { state } : {}), page: 1, page_size: 1 })
        .then((result) => result.total)
        .catch(() => null)
    const [all, queued, extracting, chunking, embedding, failed, quarantined] = await Promise.all([undefined, 'queued', 'extracting', 'chunking', 'embedding', 'failed', 'quarantined'].map(total))
    const pending = [queued, extracting, chunking, embedding].reduce<number>((sum, value) => sum + (value ?? 0), 0)
    counts.value = { total: all ?? totalFiles.value, pending, failed: failed ?? 0, quarantined: quarantined ?? 0 }
  }

  /** 拖放区说明里的单文件上限、格式覆盖里的 OCR / 转写是否就绪。读不到就不写,不编数字。 */
  async function loadAux() {
    const [config, status] = await Promise.all([
      callCapability<{ upload?: { max_file_mb?: number } }>('get_config').catch(() => null),
      callCapability<{ components?: ProviderRow[] }>('system_status').catch(() => null),
    ])
    maxFileMb.value = config?.upload?.max_file_mb ?? null
    providers.value = status?.components ?? []
  }

  async function refresh() {
    loading.value = true
    try {
      const [listed, catalog] = await Promise.all([
        callCapability<{ sources?: SourceRow[]; items?: { source: SourceRow; stats: SourceStats | null }[]; ai_extract_default?: boolean }>('list_sources'),
        callCapability<{ collections?: { name: string }[] }>('list_collections'),
      ])
      sources.value = listed.sources ?? []
      aiExtractDefault.value = listed.ai_extract_default ?? true
      statsById.value = Object.fromEntries((listed.items ?? []).filter((item) => item.stats).map((item) => [item.source.id, item.stats as SourceStats]))
      collections.value = (catalog.collections ?? []).map((item) => item.name)
      error.value = ''
      void loadCounts()
      void loadAux()
    } catch (err) {
      // 取成功过就留着旧列表(只在失败那一刻提示),一次都没成功才整块报错
      if (!sources.value.length) error.value = err instanceof Error && /[\u4e00-\u9fff]/.test(err.message) ? err.message : '读取数据来源失败。检查网络后重试。'
      else toast.push('刷新数据来源失败,下面显示的是之前的列表', 'warning')
    } finally {
      loading.value = false
    }
  }

  async function sync(source: SourceRow) {
    busy.value = source.id
    try {
      const outcome = await callCapability<{ queued: number; job_id: string | null; ai_job_id?: string | null }>('sync_source', { id: source.id })
      const ai = outcome.ai_job_id ? ',AI 规范化在后台进行' : ''
      toast.push(`已同步 ${source.name}:${outcome.queued > 0 ? `入队 ${outcome.queued} 个文件` : '没有新文件'}${ai}`, 'success')
      await refresh()
    } catch (err) {
      toast.push(`同步失败:${err instanceof Error ? err.message : '请稍后再试'}`, 'danger')
    } finally {
      busy.value = ''
    }
  }

  /** 全部同步:逐个触发,一个失败不连累后面的;失败的条数一并提示。 */
  async function syncAll(list: SourceRow[] = sources.value) {
    let failed = 0
    for (const item of list) {
      try {
        await callCapability('sync_source', { id: item.id })
      } catch {
        failed += 1
      }
    }
    toast.push(failed ? `已触发同步,${failed} 个失败` : `已触发 ${list.length} 个数据源的同步`, failed ? 'warning' : 'success')
    await refresh()
  }

  /** 移除:要确认(它索引出来的块、向量与文件都会清掉);返回是否真的移除了。 */
  async function remove(source: SourceRow): Promise<boolean> {
    busy.value = source.id
    try {
      const ok = await useConfirm().ask({
        title: `移除数据源「${source.name}」?`,
        message: removeSourceMessage(source.kind),
        confirmText: '移除',
        tone: 'danger',
        doneText: '已移除',
        action: () => callCapability('remove_source', { id: source.id }),
      })
      if (!ok) return false
      toast.push(`已移除 ${source.name}`)
      await refresh()
      return true
    } finally {
      busy.value = ''
    }
  }

  return { sources, statsById, collections, loading, error, busy, counts, maxFileMb, providers, aiExtractDefault, totalFiles, rate, refresh, sync, syncAll, remove }
}
