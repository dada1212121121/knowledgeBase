/**
 * Word 样式瘦身（Worker 版）：主线程只等结果，拿不到就用原文件。
 *
 * 瘦身只是优化，不是渲染的前提：没有 Worker（单测 / 老环境）、Worker 起不来、超时、文件太小或太大，都直接返回原字节，
 * 不在主线程补做（补做就把省下的长任务又还回去了）。
 */
import type { DocxPruneRequest, DocxPruneResponse } from './docx-prune.worker'

/** 小于它的文件没有值得瘦身的样式表；大于它的文件打包要多占好几倍内存，放弃 */
export const PRUNE_MIN_BYTES = 8 * 1024
export const PRUNE_MAX_BYTES = 32 * 1024 * 1024
/** Worker 迟迟不回就放弃，用原文件（不能让一个可选的优化挡住阅读） */
const PRUNE_TIMEOUT_MS = 8000

let worker: Worker | null = null
let disabled = false
let seq = 0
const pending = new Map<number, (bytes: ArrayBuffer | null) => void>()

function getWorker(): Worker | null {
  if (worker) return worker
  if (disabled || typeof Worker === 'undefined') return null
  try {
    worker = new Worker(new URL('./docx-prune.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    disabled = true
    return null
  }
  worker.onmessage = (event: MessageEvent<DocxPruneResponse>) => {
    const done = pending.get(event.data.id)
    if (!done) return
    pending.delete(event.data.id)
    done(event.data.bytes)
  }
  worker.onerror = () => {
    for (const [id, done] of pending) {
      pending.delete(id)
      done(null)
    }
    worker?.terminate()
    worker = null
    disabled = true
  }
  return worker
}

/** 提前把 Worker 起起来：模块文件在原件下载的同时就开始取，原件到手时已经就绪 */
export function warmDocxPruneWorker(): void {
  getWorker()
}

/** 返回用于渲染的字节：瘦身过的新字节，或者原字节 */
export function pruneDocxForRender(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  if (buffer.byteLength < PRUNE_MIN_BYTES || buffer.byteLength > PRUNE_MAX_BYTES) return Promise.resolve(buffer)
  const target = getWorker()
  if (!target) return Promise.resolve(buffer)
  return new Promise((resolve) => {
    const id = (seq += 1)
    const timer = window.setTimeout(() => {
      pending.delete(id)
      resolve(buffer)
    }, PRUNE_TIMEOUT_MS)
    pending.set(id, (bytes) => {
      window.clearTimeout(timer)
      resolve(bytes ?? buffer)
    })
    // 拷贝而不是转移：原件字节还要给批注 / 高保真查看用
    target.postMessage({ id, bytes: buffer } satisfies DocxPruneRequest)
  })
}
