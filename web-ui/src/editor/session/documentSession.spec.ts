import { describe, expect, it, vi } from 'vitest'
import { EditorDocumentSession, type SessionSaveRequest, type SessionTransport } from './DocumentSession'
import type {
  EditorCommand,
  EditorOpenRequest,
  EditorPermissions,
  EditorSource,
  SaveResult,
  SessionEvent,
} from '../types'

const FULL: EditorPermissions = { read: true, write: true, comment: true, ai: true, export: true }

function makeRequest(overrides: Partial<EditorOpenRequest> = {}): EditorOpenRequest {
  const source: EditorSource = { kind: 'text', text: '# 标题\n正文', name: 'note.md', sha256: 'abc123' }
  return {
    fileId: 'f1',
    collection: 'c1',
    format: 'md',
    source,
    readonly: false,
    revision: 7,
    permissions: FULL,
    ...overrides,
  }
}

/** 假保存通道：记录每次请求，按 handler 返回结果 */
function makeTransport(handler: (req: SessionSaveRequest) => Promise<SaveResult>) {
  const calls: SessionSaveRequest[] = []
  const transport: SessionTransport = {
    save: (req) => {
      calls.push(req)
      return handler(req)
    },
  }
  return { transport, calls }
}

const ok = (revision: number): SaveResult => ({ ok: true, revision, sha256: `sha${revision}` })

describe('EditorDocumentSession：会话生命周期', () => {
  it('39. 初始不脏；markDirty 只广播一次，重复置脏不重复通知', () => {
    const session = new EditorDocumentSession({ request: makeRequest() })
    expect(session.dirty).toBe(false)
    expect(session.phase).toBe('idle')

    const events: SessionEvent[] = []
    session.subscribe((event) => events.push(event))
    events.length = 0 // 丢弃订阅时的首帧

    session.markDirty()
    session.markDirty()
    expect(session.dirty).toBe(true)
    expect(events.filter((event) => event.dirty)).toHaveLength(1)
  })

  it('40. 没有改动时保存直接返回 unchanged，不发请求', async () => {
    const { transport, calls } = makeTransport(async () => ok(8))
    const session = new EditorDocumentSession({ request: makeRequest(), transport })
    const result = await session.save()
    expect(result.ok).toBe(true)
    expect(result.unchanged).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('41. 保存成功推进 revision、刷新 sha256 并清掉脏标记', async () => {
    const { transport, calls } = makeTransport(async () => ok(8))
    const session = new EditorDocumentSession({
      request: makeRequest(),
      transport,
      snapshot: () => ({ kind: 'text', text: '# 改过的标题', name: 'note.md' }),
    })
    session.markDirty()
    const result = await session.save({ reason: 'manual' })

    expect(result.ok).toBe(true)
    expect(session.revision).toBe(8)
    expect(session.sha256).toBe('sha8')
    expect(session.dirty).toBe(false)
    expect(session.phase).toBe('ready')
    // 传给服务端的必须是乐观锁版本与最新内容
    expect(calls[0]!.revision).toBe(7)
    expect(calls[0]!.source).toEqual({ kind: 'text', text: '# 改过的标题', name: 'note.md' })
    expect(calls[0]!.options).toEqual({ reason: 'manual' })
  })

  it('41b. 保存请求在途时又有改动，完成后仍保持脏标记', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { transport } = makeTransport(async () => {
      await gate
      return ok(8)
    })
    const session = new EditorDocumentSession({
      request: makeRequest(),
      transport,
      snapshot: () => ({ kind: 'text', text: '# 改过的标题', name: 'note.md' }),
    })
    session.markDirty()
    const pending = session.save({ reason: 'manual' })
    // 快照已经取走、请求还没回来时用户继续输入：这一拍不能算已保存
    session.markDirty()
    release!()
    const result = await pending

    expect(result.ok).toBe(true)
    expect(session.revision).toBe(8)
    expect(session.dirty).toBe(true)
    expect(session.phase).toBe('ready')
  })

  it('42. 服务端 409 进入 conflict 阶段，并带回服务端版本信息', async () => {
    const transport: SessionTransport = {
      save: async () => {
        throw Object.assign(new Error('文档已被他人修改，请重新加载'), { status: 409 })
      },
    }
    const session = new EditorDocumentSession({ request: makeRequest(), transport })
    session.markDirty()
    const result = await session.save()

    expect(result.ok).toBe(false)
    expect(result.conflict).toBeDefined()
    expect(result.conflict?.message).toContain('已被他人修改')
    expect(session.phase).toBe('conflict')
    expect(session.dirty).toBe(true)
    expect(session.error).toContain('已被他人修改')
  })

  it('43. 保存结果里带 conflict 时同样进入 conflict 阶段（非异常路径）', async () => {
    const { transport } = makeTransport(async () => ({
      ok: false,
      revision: 7,
      sha256: 'abc123',
      conflict: { serverRevision: 9, holderName: '张三', message: '版本冲突' },
    }))
    const session = new EditorDocumentSession({ request: makeRequest(), transport })
    session.markDirty()
    await session.save()
    expect(session.phase).toBe('conflict')
    expect(session.error).toBe('版本冲突')
  })

  it('44. 连按两次保存复用同一个请求，不会产生假冲突', async () => {
    // 用对象持有 resolve，避免 TS 把闭包里赋值的变量窄化成 never
    const deferred: { resolve?: (value: SaveResult) => void } = {}
    const { transport, calls } = makeTransport(
      () =>
        new Promise<SaveResult>((resolve) => {
          deferred.resolve = resolve
        }),
    )
    const session = new EditorDocumentSession({ request: makeRequest(), transport })
    session.markDirty()

    const first = session.save()
    const second = session.save()
    expect(calls).toHaveLength(1)
    deferred.resolve?.(ok(8))
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(session.revision).toBe(8)
  })

  it('45. 只读会话拒绝保存且不发请求', async () => {
    const { transport, calls } = makeTransport(async () => ok(8))
    const session = new EditorDocumentSession({
      request: makeRequest({ readonly: true }),
      transport,
    })
    expect(session.readonly).toBe(true)
    const result = await session.save()
    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('46. 缺 write 权限同样视为只读（宁可多拒一次也不越权）', () => {
    const session = new EditorDocumentSession({
      request: makeRequest({ permissions: { ...FULL, write: false } }),
    })
    expect(session.readonly).toBe(true)
  })

  it('47. undo / redo 委托 History，栈空时无副作用', async () => {
    const session = new EditorDocumentSession({ request: makeRequest() })
    const value = { text: 'a' }
    await session.undo()
    expect(session.dirty).toBe(false)

    session.undoStack.record({
      step: {
        undo: () => {
          value.text = 'a'
        },
        redo: () => {
          value.text = 'ab'
        },
      },
    })
    value.text = 'ab'
    await session.undo()
    expect(value.text).toBe('a')
    expect(session.dirty).toBe(true)
    await session.redo()
    expect(value.text).toBe('ab')
  })

  it('48. 只读会话不执行撤销（防止只读态被本地栈改脏）', async () => {
    const session = new EditorDocumentSession({ request: makeRequest({ readonly: true }) })
    const spy = vi.fn()
    session.undoStack.record({ step: { undo: spy, redo: spy } })
    await session.undo()
    expect(spy).not.toHaveBeenCalled()
  })

  it('49. subscribe 立即推一次当前状态，退订后不再收到通知', () => {
    const session = new EditorDocumentSession({ request: makeRequest() })
    const seen: SessionEvent[] = []
    const off = session.subscribe((event) => seen.push(event))
    expect(seen).toHaveLength(1)
    expect(seen[0]!.phase).toBe('idle')
    expect(seen[0]!.revision).toBe(7)

    session.markReady()
    expect(seen).toHaveLength(2)
    expect(seen[1]!.phase).toBe('ready')

    off()
    session.markDirty()
    expect(seen).toHaveLength(2)
  })

  it('50. destroy 后进入 destroyed 阶段，后续命令被拒绝', async () => {
    const session = new EditorDocumentSession({ request: makeRequest() })
    session.destroy()
    expect(session.phase).toBe('destroyed')
    const result = await session.execute({ id: 'x', type: 'text.insert', source: 'user' })
    expect(result.ok).toBe(false)
    expect(await session.save()).toEqual({ ok: false, revision: 7, sha256: 'abc123' })
  })

  it('51. 没有 snapshot 时用原始 source 作为保存内容', async () => {
    const { transport, calls } = makeTransport(async () => ok(2))
    const request = makeRequest()
    const session = new EditorDocumentSession({ request, transport })
    session.markDirty()
    await session.save()
    expect(calls[0]!.source).toBe(request.source)
  })

  it('52. 冲突后接受服务端版本会清栈并回到 ready', async () => {
    const { transport } = makeTransport(async () => ({
      ok: false,
      revision: 7,
      sha256: 'abc123',
      conflict: { serverRevision: 11, message: '冲突' },
    }))
    const session = new EditorDocumentSession({ request: makeRequest(), transport })
    session.markDirty()
    await session.save()
    expect(session.phase).toBe('conflict')

    session.acceptServerRevision(11, 'sha11')
    expect(session.revision).toBe(11)
    expect(session.sha256).toBe('sha11')
    expect(session.dirty).toBe(false)
    expect(session.phase).toBe('ready')
    expect(session.canUndo).toBe(false)
  })

  it('53. scrollTo 走只读安全命令，不会把会话弄脏', async () => {
    const session = new EditorDocumentSession({ request: makeRequest() })
    const dispatch = vi.fn(async (_command: EditorCommand) => ({ ok: true }))
    const { CommandBus } = await import('./CommandBus')
    session.attachBus(
      new CommandBus({
        readonly: () => session.readonly,
        permissions: () => FULL,
        dispatch,
      }),
    )
    await session.scrollTo({ kind: 'text', block: 'b1', offset: 12 })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0]![0]).toMatchObject({ type: 'nav.scrollToAnchor', readonlySafe: true })
    expect(session.dirty).toBe(false)
  })
})

describe('EditorDocumentSession：事件类型', () => {
  it('脏标记变化发 dirty、选区变化发 selection（Host 据此刷新工具栏高亮与大纲）', () => {
    const session = new EditorDocumentSession({ request: makeRequest() })
    const types: string[] = []
    session.subscribe((event) => types.push(event.type))
    types.length = 0
    session.markDirty()
    session.setSelection(null)
    expect(types).toEqual(['dirty', 'selection'])
  })
})

describe('EditorDocumentSession：内容面自带保存通道', () => {
  it('设置后保存不取快照、不走 transport，成功照常推进 revision 并清脏', async () => {
    const { transport, calls } = makeTransport(async () => ok(99))
    const snapshot = vi.fn(() => ({ kind: 'text', text: 'x', name: 'a.csv' }) as EditorSource)
    const session = new EditorDocumentSession({ request: makeRequest({ format: 'csv' }), transport, snapshot })
    const handler = vi.fn(async () => ({ ...ok(8), embedded: 3 }))
    session.setSaveHandler(handler)
    session.markDirty()
    const result = await session.save({ reason: 'manual' })
    expect(result).toMatchObject({ ok: true, revision: 8, embedded: 3 })
    expect(handler).toHaveBeenCalledWith({ reason: 'manual' })
    expect(calls).toHaveLength(0)
    expect(snapshot).not.toHaveBeenCalled()
    expect(session.revision).toBe(8)
    expect(session.dirty).toBe(false)
  })

  it('没有 transport 也能靠自带通道保存', async () => {
    const session = new EditorDocumentSession({ request: makeRequest({ format: 'csv' }) })
    session.setSaveHandler(async () => ok(8))
    session.markDirty()
    expect((await session.save()).ok).toBe(true)
  })

  it('通道返回冲突：进入 conflict，保持脏（草稿还在内容面里）', async () => {
    const session = new EditorDocumentSession({ request: makeRequest({ format: 'csv' }) })
    session.setSaveHandler(async () => ({ ok: false, revision: 7, sha256: '', conflict: { serverRevision: 8, message: '刚被别人保存过' } }))
    session.markDirty()
    const result = await session.save()
    expect(result.conflict?.message).toContain('别人')
    expect(session.phase).toBe('conflict')
    expect(session.dirty).toBe(true)
    expect(session.error).toContain('别人')
  })

  it('通道抛出 409 同样进入 conflict；其它异常进入 error；传 null 撤销后回到 transport', async () => {
    const session = new EditorDocumentSession({ request: makeRequest({ format: 'csv' }) })
    session.setSaveHandler(async () => {
      throw Object.assign(new Error('版本冲突'), { status: 409 })
    })
    session.markDirty()
    await session.save()
    expect(session.phase).toBe('conflict')
    session.setSaveHandler(async () => {
      throw new Error('网络断了')
    })
    await session.save()
    expect(session.phase).toBe('error')
    session.setSaveHandler(null)
    expect((await session.save()).ok).toBe(false) // 既没有通道也没有 transport
  })
})
