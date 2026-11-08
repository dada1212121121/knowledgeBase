// 文件操作状态机:能力和文案都以服务端 file_actions 为准,这里只验证「怎么问、怎么调、怎么回」。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileActions, FileOp } from '@/components/fileops/types'

const push = vi.fn()
const callCapability = vi.fn()
vi.mock('@kb-ui/index', () => ({ useToast: () => ({ push }) }))
vi.mock('@/api/client', () => {
  class CapabilityError extends Error {
    code: string
    status: number
    constructor(message: string, code = '', status = 500) {
      super(message)
      this.code = code
      this.status = status
    }
    get isConflict() {
      return this.status === 409
    }
  }
  return { callCapability, CapabilityError }
})

const { useFileActions } = await import('./useFileActions')
const { CapabilityError } = await import('@/api/client')

function actions(overrides: Partial<FileActions> = {}): FileActions {
  return {
    collection: 'kb',
    path: 'docs/a.md',
    origin: 'upload',
    managed: true,
    folder: false,
    files: 1,
    fingerprint: { value: 'fp1', files: 1 },
    delete: { allowed: true, reason: null },
    move: { allowed: true, reason: null },
    ...overrides,
  }
}
function op(overrides: Partial<FileOp> = {}): FileOp {
  return { id: 'fop_1', collection: 'kb', kind: 'delete_file', state: 'done', total: 1, done: 1, failed: 0, error: null, created_at: 1, finished_at: 2, ...overrides }
}
const target = { collection: 'kb', path: 'docs/a.md', name: 'a.md' }

beforeEach(() => {
  push.mockReset()
  callCapability.mockReset()
})

describe('useFileActions', () => {
  it('打开菜单先问服务端能否删 / 移,并保留指纹', async () => {
    callCapability.mockResolvedValueOnce(actions())
    const fetcher = useFileActions()
    await fetcher.openSheet(target)
    expect(callCapability).toHaveBeenCalledWith('file_actions', { collection: 'kb', path: 'docs/a.md' })
    expect(fetcher.menu.value?.actions.fingerprint.value).toBe('fp1')
  })

  it('单文件删除带指纹,成功后提示 30 天可恢复并通知刷新', async () => {
    callCapability.mockResolvedValueOnce(actions()).mockResolvedValueOnce(op())
    const onChanged = vi.fn()
    const fetcher = useFileActions({ onChanged })
    await fetcher.openSheet(target)
    fetcher.start('delete')
    await fetcher.confirmDelete()
    expect(callCapability).toHaveBeenLastCalledWith('delete_file', { collection: 'kb', path: 'docs/a.md', fingerprint: 'fp1' })
    expect(push).toHaveBeenCalledWith('已移到回收站,30 天内可以恢复')
    expect(onChanged).toHaveBeenCalledWith(target)
    expect(fetcher.dialog.value).toBeNull()
  })

  it('本地目录只移除索引:文案不能误导成能恢复', async () => {
    callCapability.mockResolvedValueOnce(actions({ origin: 'local_dir', managed: false })).mockResolvedValueOnce(op())
    const fetcher = useFileActions()
    await fetcher.openSheet(target)
    fetcher.start('delete')
    await fetcher.confirmDelete()
    expect(push).toHaveBeenCalledWith('已从索引移除,原件没有改动')
  })

  it('混合来源的文件夹不把话说满:回收站与只移索引都要讲到', async () => {
    callCapability.mockResolvedValueOnce(actions({ folder: true, files: 4, origin: 'unknown' })).mockResolvedValueOnce(op({ kind: 'delete_folder', done: 4, total: 4 }))
    const fetcher = useFileActions()
    await fetcher.openSheet({ ...target, path: 'docs', name: 'docs', folder: true })
    fetcher.start('delete')
    await fetcher.confirmDelete()
    const [message] = push.mock.calls.at(-1) ?? []
    expect(message).toContain('上传 / 压缩包副本在回收站')
    expect(message).toContain('其余只移除了索引')
  })

  it('文件夹删除走 delete_folder,部分成功保留错误并提示数量', async () => {
    callCapability.mockResolvedValueOnce(actions({ folder: true, files: 3 })).mockResolvedValueOnce(op({ state: 'partial', total: 3, done: 2, failed: 1, error: 'locked.md' }))
    const fetcher = useFileActions()
    await fetcher.openSheet({ ...target, path: 'docs', name: 'docs', folder: true })
    fetcher.start('delete')
    await fetcher.confirmDelete()
    expect(callCapability).toHaveBeenLastCalledWith('delete_folder', { collection: 'kb', path: 'docs', fingerprint: 'fp1' })
    expect(push).toHaveBeenCalledWith('部分删除成功:2/3 项,locked.md', 'warning', 6000)
    // 部分成功不自动关对话框,让用户看到还有哪些没处理
    expect(fetcher.dialog.value).toBe('delete')
  })

  it('禁用项不弹对话框,只说明原因', async () => {
    callCapability.mockResolvedValueOnce(actions({ delete: { allowed: false, reason: '只能由管理员操作' } }))
    const fetcher = useFileActions()
    await fetcher.openSheet(target)
    fetcher.start('delete')
    expect(fetcher.dialog.value).toBeNull()
    expect(push).toHaveBeenCalledWith('只能由管理员操作', 'warning')
  })

  it('移动把目标目录和新名字一起提交,回滚显示为错误', async () => {
    callCapability
      .mockResolvedValueOnce(actions())
      .mockResolvedValueOnce(op({ kind: 'move_file', state: 'rolled_back', error: '磁盘写满' }))
    const fetcher = useFileActions()
    await fetcher.openSheet(target)
    fetcher.start('move')
    await fetcher.confirmMove('kb', ' archive ', ' b.md ')
    expect(callCapability).toHaveBeenLastCalledWith('move_file', {
      collection: 'kb',
      path: 'docs/a.md',
      target_dir: ' archive ',
      new_name: 'b.md',
      fingerprint: 'fp1',
    })
    expect(fetcher.error.value).toBe('磁盘写满')
  })

  it('跨知识库移动提交目标 collection', async () => {
    callCapability
      .mockResolvedValueOnce(actions())
      .mockResolvedValueOnce(op({ kind: 'move_file', state: 'done' }))
    const fetcher = useFileActions()
    await fetcher.openSheet(target)
    fetcher.start('move')
    await fetcher.confirmMove('proj_other', 'archive', 'a.md')
    expect(callCapability).toHaveBeenLastCalledWith('move_file', {
      collection: 'kb',
      path: 'docs/a.md',
      target_collection: 'proj_other',
      target_dir: 'archive',
      new_name: 'a.md',
      fingerprint: 'fp1',
    })
  })

  it('409 统一提示刷新,不把服务端冲突当成普通失败', async () => {
    callCapability.mockResolvedValueOnce(actions()).mockRejectedValueOnce(new CapabilityError('fingerprint mismatch', 'conflict', 409))
    const fetcher = useFileActions()
    await fetcher.openSheet(target)
    fetcher.start('delete')
    await fetcher.confirmDelete()
    expect(fetcher.error.value).toContain('请刷新后再试')
  })
})
