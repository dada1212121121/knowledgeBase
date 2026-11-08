/**
 * Word 样式瘦身 Worker：在这里解 zip、去掉没人用的样式、重新打包，主线程只收结果（见 docx-prune.ts）。
 *
 * 同源模块 Worker（`new Worker(new URL(...), { type: 'module' })`），满足生产 CSP 的 `script-src 'self'`，不用 blob: URL。
 */
import { pruneDocx } from './docx-prune'

export interface DocxPruneRequest {
  id: number
  bytes: ArrayBuffer
}

export interface DocxPruneResponse {
  id: number
  /** 瘦身后的 docx；null = 不需要 / 没法瘦身，用原文件 */
  bytes: ArrayBuffer | null
}

self.onmessage = async (event: MessageEvent<DocxPruneRequest>) => {
  const { id, bytes } = event.data
  const pruned = await pruneDocx(bytes)
  ;(self as unknown as Worker).postMessage({ id, bytes: pruned } satisfies DocxPruneResponse, pruned ? [pruned] : [])
}
