/**
 * PPTX 只读 Worker 客户端与 Worker 版后端（假 Worker，不起 WASM）
 *
 * 核对我们自己写的部分：请求/应答按 id 配对、错误与崩溃的传递、打开的顺序
 * （有中文才登记中文度量 → 排第一页）、第一帧只用一次、排版出中文时补登记后重排、查找走 Worker、
 * 关闭即终止 Worker、Worker 起不来时返回 null 让调用方退回主线程。
 * 真实引擎的画面与行为在 e2e（--surface=pptx-read）里用真文件验。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReadOpenReply, ReadPrepareReply, ReadRequest, ReadResponse } from './pptxReadProtocol'

vi.mock('./pptxWasm', () => ({
  pptxWasmModule: () => Promise.resolve({} as WebAssembly.Module),
  prefetchPptxWasm: () => undefined,
}))
vi.mock('./fonts/pptxFonts', () => ({
  NATIVE_FONT_FAMILIES: ['Calibri'],
  loadLatinMetrics: () => Promise.resolve({ regular: new Uint8Array([1]), bold: new Uint8Array([2]) }),
  loadCjkMetrics: () => Promise.resolve(new Uint8Array([3, 3, 3])),
}))
const ensureText = vi.fn(async (_text: string) => undefined)
vi.mock('./fonts/glyphFaces', () => ({
  sharedGlyphFaces: () => ({ ensureCore: async () => undefined, ensureText, failures: new Set<string>() }),
}))
vi.mock('./pptxPeek', () => ({ peekDeckText: async () => '' }))

import { PptxReadClient, PptxReadWorkerBackend, ReadWorkerCrash, openPptxReadInWorker } from './pptxReadWorker'

type Handler = (request: ReadRequest) => unknown

/** 按请求类型回答的假 Worker；`calls` 记下收到的所有请求 */
class FakeWorker {
  onmessage: ((event: MessageEvent<ReadResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  terminated = false
  calls: Array<{ id: number } & ReadRequest> = []
  constructor(private readonly handler: Handler) {}
  postMessage(message: { id: number } & ReadRequest): void {
    this.calls.push(message)
    queueMicrotask(() => {
      if (this.terminated) return
      try {
        const value = this.handler(message)
        this.onmessage?.({ data: { id: message.id, ok: true, value } } as MessageEvent<ReadResponse>)
      } catch (error) {
        const e = error as Error
        this.onmessage?.({ data: { id: message.id, ok: false, error: { name: e.name, message: e.message } } } as MessageEvent<ReadResponse>)
      }
    })
  }
  terminate(): void {
    this.terminated = true
  }
}

const list = (text: string, width = 1280, height = 720) => ({ width, height, primitives: [{ kind: 'textBox', lines: [{ runs: [{ text }] }] }] }) as never

const summaries = [
  { id: 's0', title: '标题 0', notes: '', hidden: false },
  { id: 's1', title: '标题 1', notes: 'n', hidden: false },
]

function scripted(options: { needsCjk?: boolean; pages?: Record<number, string>; first?: string } = {}) {
  const open: ReadOpenReply = { summaries, notices: ['提示一'], deckText: '全文', needsCjk: options.needsCjk ?? false }
  const prepare: ReadPrepareReply = {
    firstList: list(options.first ?? 'first'),
    emuSize: { width: 12192000, height: 6858000 },
    texts: ['第一页文字', '第二页文字'],
  }
  const handler: Handler = (request) => {
    switch (request.op) {
      case 'init':
      case 'registerCjk':
        return null
      case 'open':
        return open
      case 'prepare':
        return prepare
      case 'layout':
        return list(options.pages?.[request.index] ?? `page-${request.index}`)
      case 'search':
        return [{ slide: 1, shapeId: 'sp', storyId: 'st', start: 0, end: 2, text: request.query }]
      case 'media':
        return new Uint8Array([7])
    }
  }
  return { open, prepare, handler }
}

beforeEach(() => {
  ensureText.mockClear()
})

describe('PptxReadClient', () => {
  it('回包按 id 配对，错误回包带上名字和信息', async () => {
    const worker = new FakeWorker((request) => {
      if (request.op === 'search') throw Object.assign(new Error('坏了'), { name: 'BadDeck' })
      return request.op === 'layout' ? request.index : null
    })
    const client = new PptxReadClient(worker as unknown as Worker)
    const [a, b] = await Promise.all([client.call<number>({ op: 'layout', index: 4 }), client.call<number>({ op: 'layout', index: 9 })])
    expect([a, b]).toEqual([4, 9])
    await expect(client.call({ op: 'search', query: 'x' })).rejects.toMatchObject({ name: 'BadDeck', message: '坏了' })
  })

  it('Worker 崩溃：在等的请求全部失败，之后的请求直接失败，Worker 被终止', async () => {
    const worker = new FakeWorker(() => new Promise(() => undefined))
    const client = new PptxReadClient(worker as unknown as Worker)
    // 不让假 Worker 应答：直接触发 error
    worker.postMessage = () => undefined
    const waiting = client.call({ op: 'layout', index: 0 })
    worker.onerror?.({ message: '脚本加载失败' } as ErrorEvent)
    await expect(waiting).rejects.toBeInstanceOf(ReadWorkerCrash)
    await expect(client.call({ op: 'layout', index: 1 })).rejects.toBeInstanceOf(ReadWorkerCrash)
    expect(worker.terminated).toBe(true)
  })
})

describe('PptxReadWorkerBackend', () => {
  async function opened(options: Parameters<typeof scripted>[0] = {}) {
    const { open, handler } = scripted(options)
    const worker = new FakeWorker(handler)
    const client = new PptxReadClient(worker as unknown as Worker)
    const backend = new PptxReadWorkerBackend(client, open)
    await backend.prepare()
    return { backend, worker }
  }

  it('准备：页面尺寸取第一页的排版结果，读屏文字与目录来自 Worker', async () => {
    const { backend } = await opened()
    expect(backend.size).toEqual({ width: 1280, height: 720 })
    expect(backend.slides().map((s) => s.title)).toEqual(['标题 0', '标题 1'])
    expect(backend.slideText(1)).toBe('第二页文字')
    expect(backend.slideText(9)).toBe('')
    expect(backend.notices()).toEqual(['提示一'])
    // 首页要用的字形先取，其余页的字形随后在后台取
    expect(ensureText.mock.calls.map((call) => call[0])).toEqual(['first', '全文'])
  })

  it('只有文字里有中文才先登记中文度量，并且在排第一页之前', async () => {
    const withCjk = await opened({ needsCjk: true })
    expect(withCjk.worker.calls.map((c) => c.op)).toEqual(['registerCjk', 'prepare'])
    const without = await opened({ needsCjk: false })
    expect(without.worker.calls.map((c) => c.op)).toEqual(['prepare'])
  })

  it('第一页的排版只用一次；之后再要第 0 页要重新排', async () => {
    const { backend, worker } = await opened()
    await backend.frame(0)
    await backend.frame(0)
    expect(worker.calls.filter((c) => c.op === 'layout')).toHaveLength(1)
    await backend.frame(1)
    expect(worker.calls.filter((c) => c.op === 'layout').map((c) => (c as { index: number }).index)).toEqual([0, 1])
  })

  it('排版出来才发现有中文（表格 / 图表里）：补登记中文度量后重排这一页，只补一次', async () => {
    const { backend, worker } = await opened({ pages: { 1: '表格里的中文' } })
    await backend.frame(1)
    expect(worker.calls.map((c) => c.op)).toEqual(['prepare', 'layout', 'registerCjk', 'layout'])
    await backend.frame(1)
    expect(worker.calls.filter((c) => c.op === 'registerCjk')).toHaveLength(1)
  })

  it('越界的页号和关闭之后取帧都抛错', async () => {
    const { backend } = await opened()
    await expect(backend.frame(5)).rejects.toThrow(/没有第 6 张/)
    backend.dispose()
    await expect(backend.frame(0)).rejects.toThrow(/已关闭/)
  })

  it('查找走 Worker；空查询不打扰 Worker', async () => {
    const { backend, worker } = await opened()
    expect(await backend.search('  ')).toEqual([])
    const found = await backend.search('关键词')
    expect(found).toHaveLength(1)
    expect(found[0]!.text).toBe('关键词')
    expect(worker.calls.filter((c) => c.op === 'search')).toHaveLength(1)
  })

  it('关闭：终止 Worker', async () => {
    const { backend, worker } = await opened()
    backend.dispose()
    expect(worker.terminated).toBe(true)
  })
})

describe('openPptxReadInWorker', () => {
  it('环境没有 Worker：返回 null（调用方退回主线程）', async () => {
    vi.stubGlobal('Worker', undefined)
    expect(await openPptxReadInWorker(new Uint8Array([1]))).toBeNull()
    vi.unstubAllGlobals()
  })

  it('Worker 构造就抛错：返回 null', async () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('不允许')
        }
      },
    )
    expect(await openPptxReadInWorker(new Uint8Array([1]))).toBeNull()
    vi.unstubAllGlobals()
  })

  it('打开过程中 Worker 崩溃：返回 null；文档本身的错误原样抛出', async () => {
    const { handler } = scripted()
    let fake: FakeWorker | null = null
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          fake = new FakeWorker((request) => {
            if (request.op === 'open') throw Object.assign(new Error('文件已损坏'), { name: 'BadDeck' })
            return handler(request)
          })
          return fake as never
        }
      },
    )
    await expect(openPptxReadInWorker(new Uint8Array([1]))).rejects.toThrow('文件已损坏')
    expect((fake as unknown as FakeWorker).terminated).toBe(true)

    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          fake = new FakeWorker((request) => {
            if (request.op === 'open') {
              queueMicrotask(() => fake!.onerror?.({ message: '崩了' } as ErrorEvent))
              return new Promise(() => undefined)
            }
            return handler(request)
          })
          fake.postMessage = ((message: { id: number } & ReadRequest) => {
            if (message.op === 'init') queueMicrotask(() => fake!.onmessage?.({ data: { id: message.id, ok: true, value: null } } as MessageEvent<ReadResponse>))
            else queueMicrotask(() => fake!.onerror?.({ message: '崩了' } as ErrorEvent))
          }) as never
          return fake as never
        }
      },
    )
    expect(await openPptxReadInWorker(new Uint8Array([1]))).toBeNull()
    vi.unstubAllGlobals()
  })
})
