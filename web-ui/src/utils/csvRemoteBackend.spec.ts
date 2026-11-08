/**
 * 服务端分页 CSV 数据源的接线：字段名转换、乐观锁参数、冲突与失败的区分。
 */
import { describe, expect, it, vi } from 'vitest'
import { CapabilityError } from '@/api/client'
import { RemoteTableConflict } from '@/editor/types'
import { createCsvRemoteBackend, isCsvConflict, type CapabilityCall } from './csvRemoteBackend'

const PAGE = {
  total_rows: 3,
  columns: 2,
  rows: [['a', 'b']],
  offset: 0,
  format: { encoding: 'gb18030', encoding_label: 'GB18030', delimiter: ';', newline: 'crlf', trailing_newline: true },
  sha256: 'abc',
  version: 4,
}

describe('createCsvRemoteBackend', () => {
  it('1. read：参数原样带上，后端的蛇形字段转成编辑器契约的驼峰', async () => {
    const call = vi.fn(async () => PAGE) as unknown as CapabilityCall
    const page = await createCsvRemoteBackend(call, '_global', '评测.csv').read(500, 500)
    expect(call).toHaveBeenCalledWith('csv_read', { collection: '_global', path: '评测.csv', offset: 500, limit: 500 })
    expect(page).toEqual({
      totalRows: 3,
      columns: 2,
      rows: [['a', 'b']],
      offset: 0,
      format: { encoding: 'gb18030', encodingLabel: 'GB18030', delimiter: ';', newline: 'crlf', trailingNewline: true },
      sha256: 'abc',
      version: 4,
    })
  })

  it('2. edit：操作列表和乐观锁（版本号 + 内容哈希）一起提交', async () => {
    const call = vi.fn(async () => ({ changed: true, version: 5, sha256: 'def', embedded: 2 })) as unknown as CapabilityCall
    const result = await createCsvRemoteBackend(call, 'c', 'a.csv').edit([{ op: 'delete_row', row: 1 }], { version: 4, sha256: 'abc' })
    expect(call).toHaveBeenCalledWith('csv_edit', { collection: 'c', path: 'a.csv', ops: [{ op: 'delete_row', row: 1 }], expected_version: 4, expected_sha256: 'abc' })
    expect(result).toEqual({ changed: true, version: 5, sha256: 'def', embedded: 2 })
  })

  it('3. 版本冲突（409 / conflict）与文件被别的程序改了（哈希对不上）都是乐观锁冲突', async () => {
    for (const err of [new CapabilityError('version conflict', 'conflict', 409), new CapabilityError('x', 'conflict', 400), new CapabilityError('这个文件在你打开之后已被改动(可能有人保存过)', 'invalid_input', 400)]) {
      const call = (async () => {
        throw err
      }) as CapabilityCall
      await expect(createCsvRemoteBackend(call, 'c', 'a.csv').edit([], { version: 1, sha256: '' })).rejects.toBeInstanceOf(RemoteTableConflict)
      expect(isCsvConflict(err)).toBe(true)
    }
  })

  it('4. 其它失败不是冲突：带上服务端说的原因，不露英文类别前缀', async () => {
    const call = (async () => {
      throw new CapabilityError('invalid input: 文件有 40 MB,超过在线编辑的上限 32 MB;请下载后用 Excel 编辑', 'invalid_input', 400)
    }) as CapabilityCall
    const backend = createCsvRemoteBackend(call, 'c', 'a.csv')
    const failure = await backend.edit([], { version: 1, sha256: '' }).catch((err: Error) => err)
    expect(failure).not.toBeInstanceOf(RemoteTableConflict)
    expect((failure as Error).message).toContain('超过在线编辑的上限')
    expect((failure as Error).message).not.toContain('invalid input')
    const readFailure = await backend.read(0, 10).catch((err: Error) => err)
    expect((readFailure as Error).message).toContain('读取表格失败')
  })

  it('5. 没权限（403）也走统一的失败文案，不当成冲突', async () => {
    const call = (async () => {
      throw new CapabilityError('forbidden', 'forbidden', 403)
    }) as CapabilityCall
    expect(isCsvConflict(new CapabilityError('forbidden', 'forbidden', 403))).toBe(false)
    await expect(createCsvRemoteBackend(call, 'c', 'a.csv').edit([], { version: 1, sha256: '' })).rejects.toThrow()
  })
})
