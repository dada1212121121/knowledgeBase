// 异步解析入口：没有 Worker 的环境（jsdom）退回同步解析，结果与 parseTable 相同；小表不进 Worker。
import { describe, expect, it, vi } from 'vitest'
import { CSV_WORKER_THRESHOLD, parseTableAsync } from './csvParseAsync'
import { parseTable } from './csvText'

describe('parseTableAsync', () => {
  it('没有 Worker 时同步解析，大表小表结果都与 parseTable 相同', async () => {
    const small = 'a,b\n1,2\n'
    const big = `h1,h2\n${'"x,1",y\n'.repeat(Math.ceil(CSV_WORKER_THRESHOLD / 8) + 10)}`
    for (const text of [small, big]) {
      const table = await parseTableAsync(text, false)
      expect(table.rows.length).toBe(parseTable(text, false).rows.length)
      expect(table.text).toBe(text)
    }
  })

  it('小表不起 Worker；大表交给 Worker，并按 Worker 回来的结构拼回原文', async () => {
    const created: { onmessage: ((event: MessageEvent) => void) | null; posted: unknown[] }[] = []
    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: (() => void) | null = null
      posted: unknown[] = []
      constructor() {
        created.push(this)
      }
      postMessage(message: { id: number; text: string; tsv: boolean }) {
        this.posted.push(message)
        const { text: _text, ...table } = parseTable(message.text, message.tsv)
        void _text
        queueMicrotask(() => this.onmessage?.({ data: { id: message.id, table } } as MessageEvent))
      }
      terminate() {}
    }
    vi.stubGlobal('Worker', FakeWorker)
    vi.resetModules()
    const fresh = await import('./csvParseAsync')
    await fresh.parseTableAsync('a,b\n', false)
    expect(created).toHaveLength(0)
    const big = `h1,h2\n${'1,2\n'.repeat(Math.ceil(fresh.CSV_WORKER_THRESHOLD / 4) + 10)}`
    const table = await fresh.parseTableAsync(big, false)
    expect(created).toHaveLength(1)
    expect(table.text).toBe(big)
    expect(table.rows.length).toBe(parseTable(big, false).rows.length)
    vi.unstubAllGlobals()
  })
})
