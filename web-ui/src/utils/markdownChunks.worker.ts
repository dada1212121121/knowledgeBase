/**
 * Markdown 解析 Worker：大篇笔记 / 文件的整篇解析都在这里做，主线程不背 100 ms 级的长任务。
 *   - `chunks`：解析并切成 HTML 段（阅读态渐进渲染用，见 MarkdownRead.vue）；
 *   - `links`：提取正文里的链接 / 图片 / 双链（链接体检用，见 useDocLinks.ts）。以前体检在主线程把 200 KB 正文又完整解析了一遍（60 ms 级）。
 *
 * 同源模块 Worker（`new Worker(new URL(...), { type: 'module' })`），满足生产 CSP 的 `script-src 'self'`，不用 blob: URL。
 * DOMPurify 需要 DOM，Worker 里没有，所以清洗仍在主线程按段做；这里只产出未清洗的 HTML 字符串。
 */
import { extractDocLinks, type DocLink } from './docLinks'
import { createMarkdownRenderer, renderMarkdownChunks, type MarkdownChunks } from './markdownRenderer'

export type MarkdownWorkerRequest = { id: number; kind: 'chunks'; source: string } | { id: number; kind: 'links'; source: string }

export interface MarkdownWorkerResponse {
  id: number
  chunks?: MarkdownChunks
  links?: DocLink[]
  error?: string
}

// 解析器实例建一次：Worker 里连着处理多篇文档时不必重复注册规则
const md = createMarkdownRenderer()

self.onmessage = (event: MessageEvent<MarkdownWorkerRequest>) => {
  const request = event.data
  const reply = (message: MarkdownWorkerResponse) => (self as unknown as Worker).postMessage(message)
  try {
    if (request.kind === 'links') reply({ id: request.id, links: extractDocLinks(request.source) })
    else reply({ id: request.id, chunks: renderMarkdownChunks(md, request.source) })
  } catch (error) {
    reply({ id: request.id, error: error instanceof Error ? error.message : String(error) })
  }
}
