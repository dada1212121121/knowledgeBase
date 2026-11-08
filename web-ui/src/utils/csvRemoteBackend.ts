// 服务端分页的 CSV / TSV 数据源：把 `csv_read` / `csv_edit` 两个能力包成统一外壳认识的 RemoteTableBackend。
//
// 为什么单独成文件：编辑器（src/editor/）不认识网络层，页面把能力调用包好交给它；
// 这里集中处理「后端字段名 → 编辑器契约」的转换，以及哪些错误算乐观锁冲突，便于单测，也不让 Browser.vue 再长一块。
import { CapabilityError } from '@/api/client'
import { failureOf } from '@/utils/loadState'
import { RemoteTableConflict, type RemoteTableBackend } from '@/editor/types'

/** 能力调用函数（页面里是带「管理员查看」头的 callCapability） */
export type CapabilityCall = <T>(name: string, args: Record<string, unknown>) => Promise<T>

interface CsvPageResponse {
  total_rows: number
  columns: number
  rows: string[][]
  offset: number
  format: { encoding: string; encoding_label: string; delimiter: string; newline: string; trailing_newline: boolean }
  sha256: string
  version: number
}

/**
 * 服务端 `edit_csv` 在「内容哈希对不上」（文件在你打开之后被别人或别的程序改了，版本号可能没变）时
 * 报的是 invalid_input 而不是 409。提示语以 crates/kb-service/src/edit_csv.rs 为准，改那边要同步这里。
 */
export const EXTERNAL_CHANGE_HINT = '在你打开之后已被改动'

/** 乐观锁冲突：版本号对不上（409 / conflict），或内容哈希对不上 */
export function isCsvConflict(err: unknown): boolean {
  return err instanceof CapabilityError && (err.isConflict || err.code === 'conflict' || err.message.includes(EXTERNAL_CHANGE_HINT))
}

export function createCsvRemoteBackend(call: CapabilityCall, collection: string, path: string): RemoteTableBackend {
  return {
    read: async (offset, limit) => {
      try {
        const page = await call<CsvPageResponse>('csv_read', { collection, path, offset, limit })
        return {
          totalRows: page.total_rows,
          columns: page.columns,
          rows: page.rows,
          offset: page.offset,
          format: {
            encoding: page.format.encoding,
            encodingLabel: page.format.encoding_label,
            delimiter: page.format.delimiter,
            newline: page.format.newline,
            trailingNewline: page.format.trailing_newline,
          },
          sha256: page.sha256,
          version: page.version,
        }
      } catch (err) {
        throw new Error(failureOf(err, '读取表格').message)
      }
    },
    edit: async (ops, expected) => {
      try {
        return await call<{ changed: boolean; version: number; sha256: string; embedded: number }>('csv_edit', {
          collection,
          path,
          ops,
          expected_version: expected.version,
          expected_sha256: expected.sha256,
        })
      } catch (err) {
        if (isCsvConflict(err)) {
          throw new RemoteTableConflict('这个文件刚被别人保存过（版本冲突）。你的修改还在表格里，没有保存；可以复制出来，放弃后重新打开再改。')
        }
        throw new Error(failureOf(err, '保存').message)
      }
    },
  }
}
