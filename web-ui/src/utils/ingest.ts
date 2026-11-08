// 解析队列 / 文件时间线共用的小工具:状态徽标、进行中状态集合、耗时文案;导入记录(原队列页)的纯逻辑也在这里。
import { formatSize } from './files'

export type IngestState = 'queued' | 'extracting' | 'chunking' | 'embedding' | 'done' | 'failed' | 'quarantined' | 'skipped'

/** 还没跑完的状态(队列页的「进行中」筛选) */
export const ACTIVE_STATES: IngestState[] = ['queued', 'extracting', 'chunking', 'embedding']

/** 状态徽标:成功 / 进行中(◐)/ 排队(○)/ 失败(✕)/ 隔离 / 跳过 */
export function stateTag(state: IngestState): { tone: 'success' | 'accent' | 'warning' | 'danger' | 'neutral'; text: string } {
  switch (state) {
    case 'done':
      return { tone: 'success', text: '● 成功' }
    case 'extracting':
      return { tone: 'accent', text: '◐ 解析中' }
    case 'chunking':
      return { tone: 'accent', text: '◐ 分块' }
    case 'embedding':
      return { tone: 'accent', text: '◐ 向量化' }
    case 'queued':
      return { tone: 'warning', text: '○ 排队' }
    case 'failed':
      return { tone: 'danger', text: '✕ 失败' }
    case 'quarantined':
      return { tone: 'warning', text: '隔离' }
    default:
      return { tone: 'neutral', text: '跳过' }
  }
}

/** 0.6 s / 800 ms / —(没有数据) */
export const formatElapsed = (ms: number | null | undefined) =>
  ms == null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`

// ---------------------------------------------------------------- 导入记录(原解析队列页的纯逻辑,现在是「导入」页里的一个页签)

/** 一个入库文件(`list_ingest` 的一行)。 */
export interface IngestFileRow {
  id: string
  batch_id: string | null
  source_id?: string | null
  collection: string
  rel_path: string
  size: number
  state: IngestState
  error: string | null
  chunks: number
  vectors: number
  /** 抽取元信息(JSON 文本;页数 / 表数 / 幻灯片 / 时长)。 */
  extract_meta?: string | null
  elapsed_ms: number | null
}

export type RecordFilter = 'all' | 'active' | 'failed' | 'quarantined'
export const RECORD_FILTERS: readonly RecordFilter[] = ['all', 'active', 'failed', 'quarantined']

/** 地址里的 ?filter= 只认这几个值,其它当「全部」。 */
export const parseRecordFilter = (raw: unknown): RecordFilter => RECORD_FILTERS.find((item) => item === raw) ?? 'all'

export interface RecordCounts {
  all: number
  done: number
  active: number
  failed: number
  quarantined: number
}

export function countRecords(files: Pick<IngestFileRow, 'state'>[]): RecordCounts {
  const count = (states: IngestState[]) => files.filter((file) => states.includes(file.state)).length
  return { all: files.length, done: count(['done']), active: count(ACTIVE_STATES), failed: count(['failed']), quarantined: count(['quarantined']) }
}

export function filterRecords<T extends Pick<IngestFileRow, 'state'>>(files: T[], filter: RecordFilter): T[] {
  if (filter === 'all') return files
  if (filter === 'active') return files.filter((file) => ACTIVE_STATES.includes(file.state))
  return files.filter((file) => file.state === filter)
}

/** 抽取元信息(后端在抽取阶段从锚点统计出来:页数 / 表数 / 幻灯片 / 是否要 OCR)。坏数据当没有。 */
export interface ExtractMeta {
  pages?: number
  sheets?: number
  slides?: number
  needs_ocr?: boolean
}
export function parseExtractMeta(raw: string | null | undefined): ExtractMeta | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as ExtractMeta) : null
  } catch {
    return null
  }
}

/** 「内容」列:优先显示页数 / 表数 / 幻灯片,没有再退回块数 / 文件大小;失败的没有内容。 */
export function contentText(file: Pick<IngestFileRow, 'state' | 'extract_meta' | 'chunks' | 'size'>): string {
  if (file.state === 'failed') return '—'
  const meta = parseExtractMeta(file.extract_meta)
  if (meta) {
    // 「需 OCR」优先:图片的锚点恒为第 1 页,先看页数会把它显示成「1 页」
    if (meta.needs_ocr) return '需 OCR'
    if (meta.slides) return `${meta.slides} 页幻灯片`
    if (meta.sheets) return `${meta.sheets} 表`
    if (meta.pages) return `${meta.pages} 页`
  }
  return file.state === 'done' ? `${file.chunks.toLocaleString()} 块` : formatSize(file.size)
}

/** 剩余时间:45 秒 / 2 分 / 2 分 5 秒;没有估计返回空串。 */
export function etaText(seconds: number | null | undefined): string {
  if (seconds == null) return ''
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes} 分${rest ? ` ${rest} 秒` : ''}`
}

export interface StageProgress {
  stage: string
  label: string
  files: number
  done: number
  chunks: number
  vectors: number
  percent: number
}

/** 总体进度条:有批次进度就取各阶段(不含「可检索」)的平均,否则用已完成文件占比。 */
export function overallPercent(stages: Pick<StageProgress, 'stage' | 'percent'>[], counts: Pick<RecordCounts, 'all' | 'done'>): number {
  const own = stages.filter((stage) => stage.stage !== 'searchable')
  if (own.length) return Math.round(own.reduce((sum, stage) => sum + stage.percent, 0) / own.length)
  return counts.all ? Math.round((counts.done / counts.all) * 100) : 0
}

/** 阶段圆点:全部完成 = 绿,有进展 = 主色,没开始 = 灰;文字是「已完成 / 总数」。 */
export function stageDots(stages: StageProgress[]): { key: string; label: string; text: string; state: 'done' | 'active' | 'idle' }[] {
  return stages
    .filter((stage) => stage.stage !== 'searchable')
    .map((stage) => ({
      key: stage.stage,
      label: stage.label,
      text: `${stage.done}/${stage.files}`,
      state: stage.files > 0 && stage.done >= stage.files ? 'done' : stage.done > 0 ? 'active' : 'idle',
    }))
}
