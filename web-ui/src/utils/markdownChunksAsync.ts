/**
 * Markdown 解析（Worker 版）：主线程只等结果。
 *
 * 没有 Worker（单测 / 老环境）、Worker 起不来或出错时退回主线程同步解析，结果一样（只是回到整篇一条任务，
 * 之后挂 DOM 仍然是分段的）。和 csvParseAsync.ts 同一套写法。
 */
import { extractDocLinks, type DocLink } from './docLinks'
import { createMarkdownRenderer, renderMarkdownChunks, type MarkdownChunks } from './markdownRenderer'
// 只取类型（编译后擦除），不会把 Worker 代码打进主线程
import type { MarkdownWorkerRequest, MarkdownWorkerResponse } from './markdownChunks.worker'

/** 体检链接要不要进 Worker：正文超过这么多字符才值得（从该版本起 Worker + 拷贝原文本身要几毫秒，小文档同步更快） */
export const LINKS_WORKER_THRESHOLD = 16_000

type Job = { request: MarkdownWorkerRequest; resolve: (response: MarkdownWorkerResponse) => void }

let worker: Worker | null = null
/** Worker 出过错就不再用，后面都同步解析 */
let disabled = false
let seq = 0
const pending = new Map<number, Job>()
let fallbackRenderer: ReturnType<typeof createMarkdownRenderer> | null = null

/** 在主线程把同一件事做完（没有 Worker 时的退路，结果与 Worker 里一致） */
function runHere(request: MarkdownWorkerRequest): MarkdownWorkerResponse {
  if (request.kind === 'links') return { id: request.id, links: extractDocLinks(request.source) }
  return { id: request.id, chunks: renderMarkdownChunks((fallbackRenderer ??= createMarkdownRenderer()), request.source) }
}

function getWorker(): Worker | null {
  if (worker) return worker
  if (typeof Worker === 'undefined') return null
  try {
    worker = new Worker(new URL('./markdownChunks.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    return null
  }
  worker.onmessage = (event: MessageEvent<MarkdownWorkerResponse>) => {
    const job = pending.get(event.data.id)
    if (!job) return
    pending.delete(event.data.id)
    job.resolve(event.data.error ? runHere(job.request) : event.data)
  }
  // Worker 整体挂了（加载失败等）：手头的任务全部同步解析，之后不再用它
  worker.onerror = () => {
    for (const [id, job] of pending) {
      pending.delete(id)
      job.resolve(runHere(job.request))
    }
    worker?.terminate()
    worker = null
    disabled = true
  }
  return worker
}

function call(build: (id: number) => MarkdownWorkerRequest): Promise<MarkdownWorkerResponse> {
  const id = (seq += 1)
  const request = build(id)
  const target = disabled ? null : getWorker()
  if (!target) return Promise.resolve(runHere(request))
  return new Promise((resolve) => {
    pending.set(id, { request, resolve })
    target.postMessage(request)
  })
}

/** 解析并分段；结果与 renderMarkdownChunks 完全相同 */
export async function renderMarkdownChunksAsync(source: string): Promise<MarkdownChunks> {
  return (await call((id) => ({ id, kind: 'chunks', source }))).chunks!
}

/** 提取正文里的链接；结果与 extractDocLinks 完全相同。小文档同步算，大文档进 Worker */
export async function extractDocLinksAsync(source: string): Promise<DocLink[]> {
  if (source.length < LINKS_WORKER_THRESHOLD) return extractDocLinks(source)
  return (await call((id) => ({ id, kind: 'links', source }))).links!
}
