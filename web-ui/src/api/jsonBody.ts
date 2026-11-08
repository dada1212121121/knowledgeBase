/**
 * 读响应体里的 JSON。
 *
 * 为什么不直接 `response.json`：Chromium 在网络线程之外的主线程上做 UTF-8 → UTF-16 解码，再 JSON.parse。
 * 一份 5 MB 的 CSV 预览（`file_preview` 把正文放在 JSON 里随响应下发，上限 8 MB）光解码就是 90~160 ms 的一条长任务（4× 降速实测），
 * JSON.parse 另算。所以先把响应体取成 ArrayBuffer（只是拷贝字节），超过阈值的交给同源模块 Worker 解码 + 解析，
 * 主线程只收一个结构化克隆的结果；小响应体仍在主线程解（从该版本起 Worker 比解析本身还慢）。
 * Worker 起不来、出错时退回主线程解析，结果相同。
 */
import type { JsonParseRequest, JsonParseResponse } from './jsonParse.worker'

/** 超过这么多字节才进 Worker（512 KB：主线程解码 + 解析在 4× 降速下约 15~30 ms，再大就开始接近长任务） */
export const JSON_WORKER_THRESHOLD = 512 * 1024

let worker: Worker | null = null
/** Worker 出过错就不再用，后面都在主线程解 */
let disabled = false
let seq = 0
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void; bytes: ArrayBuffer }>()

const parseHere = (bytes: ArrayBuffer): unknown => JSON.parse(new TextDecoder().decode(bytes))

function getWorker(): Worker | null {
  if (worker) return worker
  if (typeof Worker === 'undefined') return null
  try {
    worker = new Worker(new URL('./jsonParse.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    return null
  }
  worker.onmessage = (event: MessageEvent<JsonParseResponse>) => {
    const job = pending.get(event.data.id)
    if (!job) return
    pending.delete(event.data.id)
    // 解析失败（不是 JSON）：和主线程 JSON.parse 一样抛 SyntaxError，调用方的 catch 照常把它当“网关返回了非 JSON”
    if (event.data.error !== undefined) job.reject(new SyntaxError(event.data.error))
    else job.resolve(event.data.value)
  }
  // Worker 整体挂了（加载失败等）：手头的任务全部在主线程解，之后不再用它
  worker.onerror = () => {
    for (const [id, job] of pending) {
      pending.delete(id)
      try {
        job.resolve(parseHere(job.bytes))
      } catch (error) {
        job.reject(error)
      }
    }
    worker?.terminate()
    worker = null
    disabled = true
  }
  return worker
}

/** 把字节解析成 JSON 值；解析失败抛 SyntaxError */
export function parseJsonBytes(bytes: ArrayBuffer): Promise<unknown> {
  if (bytes.byteLength < JSON_WORKER_THRESHOLD || disabled) return new Promise((resolve) => resolve(parseHere(bytes)))
  const target = getWorker()
  if (!target) return new Promise((resolve) => resolve(parseHere(bytes)))
  return new Promise((resolve, reject) => {
    const id = (seq += 1)
    // 不转移所有权：Worker 挂了要能在主线程用同一份字节重新解
    pending.set(id, { resolve, reject, bytes })
    target.postMessage({ id, bytes } satisfies JsonParseRequest)
  })
}

/** 读响应体里的 JSON；响应体不是合法 JSON 时抛错（和 `response.json` 一样） */
export async function readJsonBody(response: Response): Promise<unknown> {
  // 极少数测试替身没有 arrayBuffer：退回 json
  if (typeof response.arrayBuffer !== 'function') return response.json()
  return parseJsonBytes(await response.arrayBuffer())
}
