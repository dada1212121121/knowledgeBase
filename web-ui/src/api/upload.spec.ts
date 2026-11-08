// upload.ts 的契约:分片失败重试 3 次、断点续传只补缺失分片、预检秒传不传字节。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PART_ATTEMPTS, putPart, sha256Hex, uploadFile, type UploadPhase } from './upload'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  FakeXhr.script = []
  FakeXhr.opened = []
  localStorage.clear()
})

/** 按脚本回放的 XMLHttpRequest:每次 send 取一步,可以先报几次上传进度,再给出响应或网络错误。 */
type XhrStep = { progress?: number[]; status?: number; body?: string; networkError?: boolean }
class FakeXhr {
  static script: XhrStep[] = []
  static opened: string[] = []
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number }) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeout: (() => void) | null = null
  onabort: (() => void) | null = null
  withCredentials = false
  status = 0
  responseText = ''
  open(method: string, url: string) {
    FakeXhr.opened.push(`${method} ${url}`)
  }
  setRequestHeader() {}
  getResponseHeader() {
    return 'application/json'
  }
  send() {
    const step = FakeXhr.script.shift() ?? { status: 200, body: JSON.stringify({ ok: true, data: { part_no: 0, parts_received: 1, parts_total: 1 } }) }
    queueMicrotask(() => {
      for (const loaded of step.progress ?? []) this.upload.onprogress?.({ lengthComputable: true, loaded })
      if (step.networkError) this.onerror?.()
      else {
        this.status = step.status ?? 200
        this.responseText = step.body ?? ''
        this.onload?.()
      }
    })
  }
}

/** jsdom 的 Blob 没有 arrayBuffer;给测试用的 blob 补一个(真实浏览器原生就有)。 */
function withBytes(blob: Blob, bytes: Uint8Array): Blob {
  Object.defineProperty(blob, 'arrayBuffer', {
    value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    configurable: true,
  })
  return blob
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('sha256Hex', () => {
  it('与标准测试向量一致', async () => {
    const digest = await sha256Hex(withBytes(new Blob(['abc']), new TextEncoder().encode('abc')))
    expect(digest).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('putPart', () => {
  it('前两次失败,第三次成功(正好 3 次)', async () => {
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls += 1
      if (calls < PART_ATTEMPTS) return new Response('boom', { status: 503 })
      return json(200, { ok: true, data: { part_no: 0, parts_received: 1, parts_total: 1 } })
    }) as unknown as typeof fetch
    const ack = await putPart('u1', 0, new Blob(['x']))
    expect(ack.parts_received).toBe(1)
    expect(calls).toBe(PART_ATTEMPTS)
  })

  it('三次都失败就放弃', async () => {
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls += 1
      return new Response('boom', { status: 503 })
    }) as unknown as typeof fetch
    await expect(putPart('u1', 0, new Blob(['x']))).rejects.toThrow()
    expect(calls).toBe(PART_ATTEMPTS)
  })

  it('4xx 不重试(重试也没用)', async () => {
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls += 1
      return json(400, { ok: false, error: { code: 'invalid_input', message: '分片大小不符' } })
    }) as unknown as typeof fetch
    await expect(putPart('u1', 0, new Blob(['x']))).rejects.toThrow('分片大小不符')
    expect(calls).toBe(1)
  })
})

describe('uploadFile', () => {
  const file = withBytes(
    new File([new Uint8Array([1, 2, 3, 4])], 'a.md', { lastModified: 1 }),
    new Uint8Array([1, 2, 3, 4]),
  ) as File

  it('续传:只补传缺失的分片', async () => {
    const calls: string[] = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.endsWith('/uploads/precheck')) {
        return json(200, { ok: true, data: { results: [{ rel_path: 'a.md', size: 4, sha256: 'x', status: 'new', existing: null }] } })
      }
      if (url.endsWith('/uploads') && init?.method === 'POST') {
        return json(200, {
          ok: true,
          data: {
            upload_id: 'u1',
            batch_id: 'b1',
            name: 'a.md',
            rel_path: 'a.md',
            chunk_size: 2,
            parts_total: 2,
            received: [0],
            received_bytes: 2,
            dedup: 'new',
            existing: null,
          },
        })
      }
      if (url.includes('/parts/')) {
        return json(200, { ok: true, data: { part_no: 1, parts_received: 2, parts_total: 2 } })
      }
      if (url.endsWith('/complete')) {
        return json(200, {
          ok: true,
          data: { upload_id: 'u1', batch_id: 'b1', collection: '_global', files: [], skipped: [], job_id: null },
        })
      }
      return json(404, { ok: false, error: { code: 'not_found', message: 'unexpected' } })
    }) as unknown as typeof fetch

    const completed = await uploadFile(file, { collection: '_global' })
    expect(completed.batch_id).toBe('b1')
    const parts = calls.filter((call) => call.includes('/parts/'))
    expect(parts).toHaveLength(1)
    expect(parts[0]).toContain('/parts/1')
  })

  it('秒传:预检说同内容时不传字节也能完成', async () => {
    const calls: string[] = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.endsWith('/uploads/precheck')) {
        return json(200, {
          ok: true,
          data: {
            results: [
              { rel_path: 'a.md', size: 4, sha256: 'x', status: 'same_content', existing: { id: 'f1', rel_path: 'a.md', size: 4, state: 'done' } },
            ],
          },
        })
      }
      if (url.endsWith('/uploads') && init?.method === 'POST') {
        return json(200, {
          ok: true,
          data: {
            upload_id: 'u2',
            batch_id: 'b2',
            name: 'a.md',
            rel_path: 'a.md',
            chunk_size: 2,
            parts_total: 2,
            received: [],
            received_bytes: 0,
            dedup: 'same_content',
            existing: null,
          },
        })
      }
      if (url.endsWith('/complete')) {
        return json(200, {
          ok: true,
          data: {
            upload_id: 'u2',
            batch_id: 'b2',
            collection: '_global',
            files: [],
            skipped: [{ rel_path: 'a.md', reason: 'same_content', existing: null }],
            job_id: null,
          },
        })
      }
      return json(404, { ok: false, error: { code: 'not_found', message: 'unexpected' } })
    }) as unknown as typeof fetch

    const completed = await uploadFile(file, { collection: '_global' })
    expect(completed.skipped[0].reason).toBe('same_content')
    // 秒传走“零分片”路径:一片都不传,直接 complete
    expect(calls.some((call) => call.includes('/parts/'))).toBe(false)
    expect(calls.some((call) => call.endsWith('/complete'))).toBe(true)
  })
})

describe('sha256Hex 缓存', () => {
  const bytesOf = (text: string) => new TextEncoder().encode(text)

  it('同一个文件对象只读取、计算一次(预检和上传各算一遍等于白等)', async () => {
    let reads = 0
    const blob = new Blob(['abc'])
    Object.defineProperty(blob, 'arrayBuffer', {
      value: async () => {
        reads += 1
        return bytesOf('abc').buffer
      },
    })
    const [first, second] = await Promise.all([sha256Hex(blob), sha256Hex(blob)])
    await sha256Hex(blob)
    expect(first).toBe(second)
    expect(reads).toBe(1)
  })

  it('读取失败不缓存:重试时重新读,不会永远拿到同一个失败', async () => {
    let reads = 0
    const blob = new Blob(['abc'])
    Object.defineProperty(blob, 'arrayBuffer', {
      value: async () => {
        reads += 1
        if (reads === 1) throw new Error('读不了')
        return bytesOf('abc').buffer
      },
    })
    await expect(sha256Hex(blob)).rejects.toThrow('读不了')
    await expect(sha256Hex(blob)).resolves.toMatch(/^[0-9a-f]{64}$/)
    expect(reads).toBe(2)
  })

  it('不同的文件对象各算各的', async () => {
    const a = withBytes(new Blob(['abc']), bytesOf('abc'))
    const b = withBytes(new Blob(['abd']), bytesOf('abd'))
    expect(await sha256Hex(a)).not.toBe(await sha256Hex(b))
  })
})

describe('putPart 字节级进度', () => {
  it('给了 onSent 就走 XMLHttpRequest,边传边报字节,不碰 fetch', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    FakeXhr.script = [{ progress: [1, 3], status: 200, body: JSON.stringify({ ok: true, data: { part_no: 0, parts_received: 1, parts_total: 2 } }) }]
    const sent: number[] = []
    const ack = await putPart('u1', 0, new Blob(['abcd']), (value) => sent.push(value))
    expect(ack.parts_received).toBe(1)
    // 开始时归零,然后是 1、3 两次真实进度
    expect(sent).toEqual([0, 1, 3])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(FakeXhr.opened).toEqual(['PUT /api/v1/uploads/u1/parts/0'])
  })

  it('已送出的字节不会超过分片本身的大小', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    FakeXhr.script = [{ progress: [999] }]
    const sent: number[] = []
    await putPart('u1', 0, new Blob(['abcd']), (value) => sent.push(value))
    expect(Math.max(...sent)).toBe(4)
  })

  it('失败重试时进度从 0 重新算(否则重试一次总进度就会虚高)', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    FakeXhr.script = [
      { progress: [3], status: 503, body: 'boom' },
      { progress: [2], status: 200, body: JSON.stringify({ ok: true, data: { part_no: 0, parts_received: 1, parts_total: 1 } }) },
    ]
    const sent: number[] = []
    await putPart('u1', 0, new Blob(['abcd']), (value) => sent.push(value))
    expect(sent).toEqual([0, 3, 0, 2])
  })

  it('网络中断当作可重试的错误,三次都断就放弃', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    FakeXhr.script = [{ networkError: true }, { networkError: true }, { networkError: true }]
    await expect(putPart('u1', 0, new Blob(['abcd']), () => undefined)).rejects.toThrow('网络中断')
    expect(FakeXhr.opened).toHaveLength(PART_ATTEMPTS)
  })

  it('4xx 同样不重试', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    FakeXhr.script = [{ status: 400, body: JSON.stringify({ ok: false, error: { code: 'invalid_input', message: '分片大小不符' } }) }]
    await expect(putPart('u1', 0, new Blob(['abcd']), () => undefined)).rejects.toThrow('分片大小不符')
    expect(FakeXhr.opened).toHaveLength(1)
  })
})

describe('uploadFile 阶段与进度', () => {
  const file = withBytes(
    new File([new Uint8Array([1, 2, 3, 4])], 'p.md', { lastModified: 7 }),
    new Uint8Array([1, 2, 3, 4]),
  ) as File

  function route(options: { received?: number[]; status?: 'new' | 'same_content' } = {}) {
    const status = options.status ?? 'new'
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/uploads/precheck')) {
        return json(200, { ok: true, data: { results: [{ rel_path: 'p.md', size: 4, sha256: 'x', status, existing: null }] } })
      }
      if (url.endsWith('/uploads') && init?.method === 'POST') {
        const received = options.received ?? []
        return json(200, {
          ok: true,
          data: { upload_id: 'u9', batch_id: 'b9', name: 'p.md', rel_path: 'p.md', chunk_size: 2, parts_total: 2, received, received_bytes: received.length * 2, dedup: status, existing: null },
        })
      }
      if (url.endsWith('/complete')) {
        return json(200, { ok: true, data: { upload_id: 'u9', batch_id: 'b9', collection: '_global', files: [], skipped: [], job_id: null } })
      }
      return json(404, { ok: false, error: { code: 'not_found', message: 'unexpected' } })
    }) as unknown as typeof fetch
  }
  const part = (progress: number[]): XhrStep => ({ progress, status: 200, body: JSON.stringify({ ok: true, data: { part_no: 0, parts_received: 1, parts_total: 2 } }) })

  it('阶段依次是 校验 → 预检 → 传输 → 合并;百分比到合并完成才是 100', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    route()
    FakeXhr.script = [part([1, 2]), part([1, 2])]
    const phases: UploadPhase[] = []
    const percents: number[] = []
    const bytes: [number, number][] = []
    await uploadFile(file, {
      collection: '_global',
      onPhase: (value) => phases.push(value),
      onProgress: (value) => percents.push(value),
      onBytes: (sent, total) => bytes.push([sent, total]),
    })
    expect(phases).toEqual(['hashing', 'checking', 'sending', 'merging'])
    // 传输期间最高 99;只有最后一次(合并校验通过之后)是 100
    expect(percents.slice(0, -1).every((value) => value <= 99)).toBe(true)
    expect(percents.at(-1)).toBe(100)
    expect([...percents].sort((a, b) => a - b)).toEqual(percents)
    expect(bytes.at(-1)).toEqual([4, 4])
    // 传到一半(第一个分片的 1 个字节)也有汇报,不是等整片传完才动
    expect(bytes.some(([sent]) => sent === 1)).toBe(true)
  })

  it('续传:进度从已收到的分片开始,不是从 0', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    route({ received: [0] })
    FakeXhr.script = [part([1, 2])]
    const bytes: [number, number][] = []
    await uploadFile(file, { collection: '_global', onBytes: (sent, total) => bytes.push([sent, total]) })
    expect(bytes[0]).toEqual([2, 4])
    expect(FakeXhr.opened).toEqual(['PUT /api/v1/uploads/u9/parts/1'])
  })

  it('秒传:没有「传输」阶段,一个字节也不发', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    route({ status: 'same_content' })
    const phases: UploadPhase[] = []
    await uploadFile(file, { collection: '_global', onPhase: (value) => phases.push(value), onBytes: () => undefined })
    expect(phases).toEqual(['hashing', 'checking', 'merging'])
    expect(FakeXhr.opened).toEqual([])
  })

  it('不要字节级进度时仍然用 fetch(老调用方行为不变)', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    route()
    const calls: string[] = []
    const base = globalThis.fetch
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
      if (String(input).includes('/parts/')) return json(200, { ok: true, data: { part_no: 0, parts_received: 1, parts_total: 2 } })
      return base(input, init)
    }) as unknown as typeof fetch
    await uploadFile(file, { collection: '_global', onProgress: () => undefined })
    expect(FakeXhr.opened).toEqual([])
    expect(calls.filter((call) => call.includes('/parts/'))).toHaveLength(2)
  })
})
