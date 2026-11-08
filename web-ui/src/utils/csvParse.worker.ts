/**
 * CSV 解析 Worker：大表打开时把整份解析挪出主线程。
 *
 * 只做 parseTable 一件事。结果是类型数组，按「可转移对象」传回主线程（零拷贝）；原文主线程本来就有，不传回去。
 * 同源模块 Worker（`new Worker(new URL(...), { type: 'module' })`），满足生产 CSP 的 `script-src 'self'`，不用 blob: URL。
 */
import { parseTable, type CsvTable } from './csvText'

export interface CsvParseRequest {
  id: number
  text: string
  tsv: boolean
}

/** 去掉原文后的表结构；数组都是恰好大小的独立缓冲区，可以整块转移 */
export type CsvParsedTable = Omit<CsvTable, 'text'>

export interface CsvParseResponse {
  id: number
  table?: CsvParsedTable
  error?: string
}

const ARRAY_KEYS = ['recStart', 'recEnd', 'recTermEnd', 'recField', 'fieldStart', 'fieldEnd', 'fieldQuoted', 'rows'] as const

self.onmessage = (event: MessageEvent<CsvParseRequest>) => {
  const { id, text, tsv } = event.data
  try {
    const parsed = parseTable(text, tsv)
    // 解析器返回的是大缓冲区上的视图（按上限分配后截取）；复制成恰好大小再转移，主线程不背多余内存
    const table = { ...parsed } as Record<string, unknown>
    delete table.text
    const transfer: ArrayBuffer[] = []
    for (const key of ARRAY_KEYS) {
      const copy = parsed[key].slice()
      table[key] = copy
      transfer.push(copy.buffer as ArrayBuffer)
    }
    ;(self as unknown as Worker).postMessage({ id, table: table as unknown as CsvParsedTable } satisfies CsvParseResponse, transfer)
  } catch (error) {
    ;(self as unknown as Worker).postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies CsvParseResponse)
  }
}
