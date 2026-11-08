// 读原件字节(`GET /api/v1/raw`):PDF / Office 在服务端是 attachment,但 fetch 不受 Content-Disposition 影响,
// 所以查看器自己拿 ArrayBuffer 渲染。带会话 cookie、可取消、有进度、有大小上限。

export class OriginalError extends Error {
  constructor(
    message: string,
    /** HTTP 状态码;网络错误 / 取消为 0 */
    readonly status = 0,
  ) {
    super(message)
    this.name = 'OriginalError'
  }
}

export interface FetchOptions {
  signal?: AbortSignal
  /** 超过就放弃(默认 64 MB,与服务端 `MAX_RAW_BYTES` 一致) */
  maxBytes?: number
  onProgress?: (loaded: number, total: number) => void
}

/** `fetchOriginalHead` 的结果:开头一段字节 + 原件是否更长 */
export interface OriginalHead {
  bytes: Uint8Array
  truncated: boolean
}

export const MAX_ORIGINAL_BYTES = 64 * 1024 * 1024

export async function fetchOriginal(url: string, options: FetchOptions = {}): Promise<ArrayBuffer> {
  const limit = options.maxBytes ?? MAX_ORIGINAL_BYTES
  let response: Response
  try {
    response = await fetch(url, { credentials: 'same-origin', signal: options.signal })
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error
    throw new OriginalError('网络错误,读不到原件')
  }
  if (!response.ok) {
    if (response.status === 413) throw new OriginalError('原件超过 64 MB,不在页内渲染,请下载后查看', 413)
    if (response.status === 404) throw new OriginalError('找不到原件(文件已移动或被删除)', 404)
    if (response.status === 401 || response.status === 403) throw new OriginalError('没有读取原件的权限,请重新登录', response.status)
    throw new OriginalError(`读取原件失败(HTTP ${response.status})`, response.status)
  }
  const total = Number(response.headers.get('content-length')) || 0
  if (total > limit) throw new OriginalError('原件太大,不在页内渲染,请下载后查看', 413)
  const body = response.body
  if (!body) return response.arrayBuffer()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.byteLength
    if (loaded > limit) {
      void reader.cancel()
      throw new OriginalError('原件太大,不在页内渲染,请下载后查看', 413)
    }
    options.onProgress?.(loaded, total || loaded)
  }
  const out = new Uint8Array(loaded)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out.buffer
}

/** 只要开头 `maxBytes` 字节(大日志 / 未知二进制):读够就取消请求,不把整个文件拉下来。 */
export async function fetchOriginalHead(url: string, maxBytes: number, signal?: AbortSignal): Promise<OriginalHead> {
  let response: Response
  try {
    response = await fetch(url, { credentials: 'same-origin', signal })
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error
    throw new OriginalError('网络错误,读不到原件')
  }
  if (!response.ok) {
    if (response.status === 413) throw new OriginalError('原件超过 64 MB,不在页内预览,请下载后查看', 413)
    if (response.status === 404) throw new OriginalError('找不到原件(文件已移动或被删除)', 404)
    throw new OriginalError(`读取原件失败(HTTP ${response.status})`, response.status)
  }
  const body = response.body
  if (!body) {
    const all = new Uint8Array(await response.arrayBuffer())
    return { bytes: all.subarray(0, maxBytes), truncated: all.byteLength > maxBytes }
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.byteLength
    if (loaded >= maxBytes) {
      truncated = true
      void reader.cancel()
      break
    }
  }
  const out = new Uint8Array(Math.min(loaded, maxBytes))
  let offset = 0
  for (const chunk of chunks) {
    const room = out.byteLength - offset
    if (room <= 0) break
    out.set(chunk.subarray(0, room), offset)
    offset += Math.min(chunk.byteLength, room)
  }
  return { bytes: out, truncated: truncated && loaded > maxBytes ? true : truncated }
}
