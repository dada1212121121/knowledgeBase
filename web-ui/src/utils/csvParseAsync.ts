/**
 * CSV 异步解析：超过阈值的文本在 Worker 里解析，主线程只等结果。
 *
 * 为什么有阈值：起 Worker、把原文拷过去本身要几毫秒，小表同步解析更快；
 * 5 MB / 40 万字段的表同步解析在 4× 降速的手机级 CPU 上是一段 100 多毫秒的长任务（打字、滚动都卡住）。
 * 没有 Worker（单测 / 老环境）、Worker 起不来或出错时退回同步解析，结果一样。
 */
import { parseTable, type CsvTable } from './csvText'
// 只取类型（编译后擦除），不会把 Worker 代码打进主线程
import type { CsvParseRequest, CsvParseResponse } from './csvParse.worker'

/** 超过这么多字符才进 Worker（约 256 KB 的 ASCII） */
export const CSV_WORKER_THRESHOLD = 256 * 1024

let worker: Worker | null = null
/** Worker 出过错就不再用，后面都同步解析 */
let disabled = false
let seq = 0
const pending = new Map<number, { resolve: (table: CsvTable) => void; text: string; tsv: boolean }>()

function getWorker(): Worker | null {
  if (worker) return worker
  if (typeof Worker === 'undefined') return null
  try {
    worker = new Worker(new URL('./csvParse.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    return null
  }
  worker.onmessage = (event: MessageEvent<CsvParseResponse>) => {
    const job = pending.get(event.data.id)
    if (!job) return
    pending.delete(event.data.id)
    job.resolve(event.data.table ? { ...event.data.table, text: job.text } : parseTable(job.text, job.tsv))
  }
  // Worker 整体挂了（加载失败等）：手头的任务全部同步解析，之后不再用它
  worker.onerror = () => {
    for (const [id, job] of pending) {
      pending.delete(id)
      job.resolve(parseTable(job.text, job.tsv))
    }
    worker?.terminate()
    worker = null
    disabled = true
  }
  return worker
}

/** 解析整份文字；结果与 parseTable 完全相同 */
export function parseTableAsync(text: string, tsv: boolean): Promise<CsvTable> {
  if (text.length < CSV_WORKER_THRESHOLD || disabled) return Promise.resolve(parseTable(text, tsv))
  const target = getWorker()
  if (!target) return Promise.resolve(parseTable(text, tsv))
  return new Promise((resolve) => {
    const id = (seq += 1)
    pending.set(id, { resolve, text, tsv })
    target.postMessage({ id, text, tsv } satisfies CsvParseRequest)
  })
}
