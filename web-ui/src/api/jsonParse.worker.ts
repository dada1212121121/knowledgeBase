/**
 * JSON 解析 Worker：大响应体（几 MB 的文件预览正文）的 UTF-8 解码 + JSON.parse 在这里做。
 *
 * 同源模块 Worker（`new Worker(new URL(...), { type: 'module' })`），满足生产 CSP 的 `script-src 'self'`，不用 blob: URL。
 */
export interface JsonParseRequest {
  id: number
  bytes: ArrayBuffer
}

export interface JsonParseResponse {
  id: number
  value?: unknown
  /** 解析失败的说明（与主线程 JSON.parse 抛的是同一类错误：SyntaxError） */
  error?: string
}

self.onmessage = (event: MessageEvent<JsonParseRequest>) => {
  const { id, bytes } = event.data
  try {
    ;(self as unknown as Worker).postMessage({ id, value: JSON.parse(new TextDecoder().decode(bytes)) } satisfies JsonParseResponse)
  } catch (error) {
    ;(self as unknown as Worker).postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies JsonParseResponse)
  }
}
