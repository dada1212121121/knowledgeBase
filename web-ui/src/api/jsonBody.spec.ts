// 响应体 JSON 解析：大小响应体、非法 JSON、没有 arrayBuffer 的替身都要和 response.json 行为一致。
import { describe, expect, it } from 'vitest'
import { JSON_WORKER_THRESHOLD, parseJsonBytes, readJsonBody } from './jsonBody'

const encode = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer

describe('jsonBody', () => {
  it('小响应体：与 response.json() 同一个结果（含中文、转义换行）', async () => {
    const body = { ok: true, data: { text: '你好\r\n世界 "引号"', n: 3 } }
    expect(await readJsonBody(new Response(JSON.stringify(body)))).toEqual(body)
  })

  it('超过阈值的响应体：结果相同（jsdom 没有 Worker，退回主线程解析）', async () => {
    const content = '甲,乙\r\n'.repeat(Math.ceil(JSON_WORKER_THRESHOLD / 4))
    const body = { ok: true, data: { content, rows: [1, 2, 3] } }
    const bytes = encode(JSON.stringify(body))
    expect(bytes.byteLength).toBeGreaterThan(JSON_WORKER_THRESHOLD)
    expect(await parseJsonBytes(bytes)).toEqual(body)
  })

  it('不是 JSON：抛 SyntaxError，调用方照旧当作「网关返回了非 JSON」', async () => {
    await expect(readJsonBody(new Response('<html>oops</html>'))).rejects.toBeInstanceOf(SyntaxError)
    await expect(parseJsonBytes(encode('x'.repeat(JSON_WORKER_THRESHOLD + 1)))).rejects.toBeInstanceOf(SyntaxError)
  })

  it('带 UTF-8 BOM 的响应体也能解（与 fetch 的 UTF-8 解码一致）', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"a":1}')]).buffer as ArrayBuffer
    expect(await parseJsonBytes(bytes)).toEqual({ a: 1 })
  })

  it('没有 arrayBuffer 的响应替身退回 json()', async () => {
    const fake = { json: async () => ({ ok: true }) } as unknown as Response
    expect(await readJsonBody(fake)).toEqual({ ok: true })
  })
})
