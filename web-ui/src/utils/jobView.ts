// 任务列表在手机上的卡片:进度条要不要画、时间行写什么。
// 排队中的任务还没开始,画 0% 的进度条和"开始 — · 耗时 —"没有任何信息,还让每张卡片多出两行。
import type { JobSummary } from '@/api/client'
import { briefCount, briefItems, type FileChange, type JobBrief, type JobFileRow } from '@/api/jobs'
import { jobStateText, jobStateTone, type StatusRow } from './systemStatus'

export type JobTimeInput = Pick<JobSummary, 'state' | 'created_at' | 'started_at' | 'finished_at'>

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * 返回这张卡片要不要画进度条,以及时间行的文字。
 * - 排队中(没有开始):不画进度条;写"排队中 · 已等 N"(从入队时刻算)。
 * - 开始过的(运行中 / 暂停 / 完成 / 失败 / 取消):画进度条;写"开始 <时刻> · 耗时 <时长>"(运行中算到现在)。
 * - 没开始就结束的(排队时被取消或失败):不画进度条,写"未开始"。
 * `clock` 把时间戳格式化成界面上的时刻(今天只写时分,其他天带日期),由调用方给,这里不碰时区和当前日期。
 */
export function jobCardTimes(job: JobTimeInput, now: number, clock: (at: number) => string): { showBar: boolean; line: string } {
  if (!job.started_at) {
    if (job.state === 'queued') return { showBar: false, line: `排队中 · 已等 ${duration(now - job.created_at)}` }
    return { showBar: false, line: '未开始' }
  }
  // 运行中的任务"耗时"算到现在;结束的算到结束时刻。措辞和桌面表格的「耗时」列一致,不另起一个"已运行"
  const end = job.finished_at !== null && job.state !== 'running' && job.state !== 'paused' ? job.finished_at : now
  return { showBar: true, line: `开始 ${clock(job.started_at)} · 耗时 ${duration(end - job.started_at)}` }
}

const MODE_TEXT: Record<string, string> = { full: '全量', incremental: '增量' }
const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/**
 * 任务详情卡(任务页点一行看到的):这个任务做什么、做到哪了、出了什么错。
 * 数据来自 `job_get {brief: true}`:payload / checkpoint 已在服务端截短(数组超过 10 项写成 {total, items})。
 * 只列有值的行,索引任务和别的任务字段不一样,缺的不写「—」占位。
 */
export function jobDetailRows(job: JobBrief, now: number, clock: (at: number) => string): StatusRow[] {
  const payload = asRecord(job.payload)
  const checkpoint = asRecord(job.checkpoint)
  const rows: StatusRow[] = [{ key: 'state', label: '状态', value: jobStateText(job.state), tone: jobStateTone(job.state) }]
  rows.push({ key: 'target', label: '目标', value: job.collection ?? '全部' })
  const mode = typeof payload.mode === 'string' ? (MODE_TEXT[payload.mode] ?? payload.mode) : ''
  const files = briefCount(payload.paths)
  if (mode || files !== null) {
    const scope = files ? `${files} 个文件` : mode === '全量' ? '整个项目' : ''
    rows.push({ key: 'mode', label: '方式', value: [mode, scope].filter(Boolean).join(' · ') })
  }
  const done = num(checkpoint.done) ?? job.progress_done
  const total = num(checkpoint.total) ?? job.progress_total
  if (total || done) {
    const rate = job.rate ? ` · ${job.rate.toFixed(1)} 块/秒` : ''
    rows.push({ key: 'progress', label: '进度', value: `${done} / ${total ?? '?'}${rate}`, mono: true })
  }
  const embedded = num(checkpoint.embedded)
  if (embedded) rows.push({ key: 'embedded', label: '写入向量', value: `${embedded} 块`, mono: true })
  const deleted = num(checkpoint.deleted_chunks)
  if (deleted) rows.push({ key: 'deleted', label: '清掉旧内容', value: `${deleted} 块`, mono: true })
  const errors = num(checkpoint.errors)
  if (errors) rows.push({ key: 'errors', label: '出错的文件', value: `${errors} 个`, tone: 'warning' })
  rows.push({ key: 'created', label: '入队', value: clock(job.created_at), mono: true })
  if (job.started_at) rows.push({ key: 'started', label: '开始', value: clock(job.started_at), mono: true })
  if (job.finished_at) rows.push({ key: 'finished', label: '结束', value: clock(job.finished_at), mono: true })
  if (job.started_at) {
    const end = job.finished_at && job.state !== 'running' && job.state !== 'paused' ? job.finished_at : now
    rows.push({ key: 'took', label: '耗时', value: duration(end - job.started_at), mono: true })
  } else if (job.state === 'queued') {
    rows.push({ key: 'waited', label: '已等', value: duration(now - job.created_at), mono: true })
  }
  return rows
}

/** 出错样例(检查点里的 error_samples),最多 10 条,每条已在服务端截到 500 字。 */
export function jobErrorSamples(job: JobBrief): string[] {
  return briefItems(asRecord(job.checkpoint).error_samples).filter((item): item is string => typeof item === 'string' && item.trim() !== '')
}

/**
 * 从任务中提取涉及的文件清单:
 * 优先取 payload.paths(或超长截断时的 items),其次 checkpoint.paths。
 */
export function jobTargetFiles(job: JobBrief): string[] {
  const payload = asRecord(job.payload)
  const checkpoint = asRecord(job.checkpoint)
  const paths = briefItems(payload.paths)
  if (paths.length) {
    return paths.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
  }
  const cpPaths = briefItems(checkpoint.paths)
  if (cpPaths.length) {
    return cpPaths.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
  }
  if (typeof payload.path === 'string' && payload.path.trim()) {
    return [payload.path.trim()]
  }
  return []
}

/**
 * 是否是经验笔记任务:提取 insight_id
 */
export function jobTargetInsight(job: JobBrief): string | null {
  const payload = asRecord(job.payload)
  if (typeof payload.insight_id === 'string' && payload.insight_id.trim()) {
    return payload.insight_id.trim()
  }
  return null
}

/**
 * 判断字符串是否像单个文件路径(如 crates/kb-cli/src/main.rs, README.md 等)
 */
export function isFilePath(str: string | null | undefined): boolean {
  if (!str) return false
  const trimmed = str.trim()
  if (trimmed.includes(' 个文件') || trimmed.startsWith('笔记 ') || trimmed.startsWith('批次 ') || trimmed === '全量索引') return false
  // 任务详情里还有不是路径的描述,别让它们变成指向不存在文件的链接:
  // git 区间「diff 3da960b..HEAD」(结尾 .HEAD 像扩展名)、评测摘要「hit@5 1.00 · MRR 0.927」(结尾 .927 像扩展名)
  if (trimmed.startsWith('diff ') || trimmed.includes(' · ')) return false
  // 带空格又没有目录分隔符的是一句话,不是路径
  if (/\s/.test(trimmed) && !trimmed.includes('/')) return false
  // 扩展名里至少要有一个字母:纯数字的「.927」「.5」是小数,不是扩展名(「.7z」「.3gp」有字母,照旧算)
  return trimmed.includes('/') || /\.[a-zA-Z0-9_-]*[a-zA-Z][a-zA-Z0-9_-]*$/.test(trimmed)
}

/**
 * 判断字符串是否是多个文件(如 "3 个文件 (a.rs 等)")
 */
export function isMultiFiles(str: string | null | undefined): boolean {
  if (!str) return false
  return str.includes(' 个文件')
}

/**
 * 从 "笔记 in_xxxx" 中提取 id
 */
export function extractInsightId(str: string | null | undefined): string | null {
  if (!str) return null
  const m = str.trim().match(/^笔记\s+([a-zA-Z0-9_-]+)/)
  return m ? m[1] : null
}

/** 变化类型的中文名;顺序也是详情里统计的书写顺序(先新增,失败放最后) */
export const FILE_CHANGE_TEXT: Record<FileChange, string> = {
  new: '新增',
  update: '更新',
  meta: '只改元数据',
  delete: '删除',
  skip: '未变化',
  error: '失败',
}
const FILE_CHANGE_ORDER: FileChange[] = ['new', 'update', 'meta', 'delete', 'skip', 'error']
const FILE_CHANGE_TONE: Record<FileChange, 'neutral' | 'accent' | 'success' | 'warning' | 'danger'> = {
  new: 'success',
  update: 'accent',
  meta: 'neutral',
  delete: 'warning',
  skip: 'neutral',
  error: 'danger',
}

/** 徽标上的文字;后端将来加了新的变化类型也不至于显示空白 */
export function fileChangeText(change: FileChange | string): string {
  return FILE_CHANGE_TEXT[change as FileChange] ?? change
}

export function fileChangeTone(change: FileChange | string): 'neutral' | 'accent' | 'success' | 'warning' | 'danger' {
  return FILE_CHANGE_TONE[change as FileChange] ?? 'neutral'
}

/** 一行右侧的数字摘要:只写这个文件真的写过的块,没写就不占地方 */
export function jobFileSummary(file: JobFileRow): string {
  if (file.change === 'skip') return '内容未变'
  if (file.change === 'error') return '处理失败'
  const parts: string[] = []
  if (file.chunks) parts.push(`写入 ${file.chunks} 块`)
  if (file.meta_chunks) parts.push(`元数据 ${file.meta_chunks} 块`)
  if (file.deleted_chunks) parts.push(`删除 ${file.deleted_chunks} 块`)
  return parts.join(' · ') || (file.change === 'delete' ? '删除' : '未写入')
}

/**
 * 「新增 3 · 更新 12 · 失败 1」这样的统计。
 * 只写出现过的类型,不把 0 也列出来;skip(未变化)放在删除之后、失败之前。
 */
export function jobFileCountsText(counts: Partial<Record<FileChange, number>> | null | undefined): string {
  if (!counts) return ''
  return FILE_CHANGE_ORDER.filter((change) => (counts[change] ?? 0) > 0)
    .map((change) => `${FILE_CHANGE_TEXT[change]} ${counts[change]}`)
    .join(' · ')
}
