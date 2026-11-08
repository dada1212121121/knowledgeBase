import { describe, expect, it, vi } from 'vitest'
import { CommandBus, isReadonlySafeCommand } from './CommandBus'
import type { CommandResult, EditorCommand, EditorPermissions } from '../types'

const FULL: EditorPermissions = { read: true, write: true, comment: true, ai: true, export: true }

function cmd(overrides: Partial<EditorCommand> = {}): EditorCommand {
  return { id: `c_${Math.random().toString(36).slice(2)}`, type: 'text.insert', source: 'user', ...overrides }
}

/** 构造总线：默认出口把收到的命令记进 calls，并按 result 返回 */
function makeBus(
  options: {
    readonly?: boolean
    permissions?: EditorPermissions
    result?: CommandResult
    dispatch?: (command: EditorCommand) => Promise<CommandResult>
  } = {},
) {
  const calls: EditorCommand[] = []
  const bus = new CommandBus({
    readonly: () => options.readonly ?? false,
    permissions: () => options.permissions ?? FULL,
    dispatch:
      options.dispatch ??
      (async (command) => {
        calls.push(command)
        return options.result ?? { ok: true }
      }),
  })
  return { bus, calls }
}

describe('CommandBus：唯一修改入口', () => {
  it('1. 只读会话拒绝修改类命令，且不会抵达 Surface 出口', async () => {
    const { bus, calls } = makeBus({ readonly: true })
    const result = await bus.execute(cmd({ type: 'text.insert' }))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('只读')
    expect(calls).toHaveLength(0)
  })

  it('2. 只读会话仍允许只读安全命令（view./nav./search./zoom./copy）', async () => {
    const { bus, calls } = makeBus({ readonly: true })
    for (const type of ['view.zoom', 'nav.scrollToAnchor', 'search.next', 'copy', 'sheet.select']) {
      expect(isReadonlySafeCommand(cmd({ type }))).toBe(true)
      const result = await bus.execute(cmd({ type }))
      expect(result.ok).toBe(true)
    }
    expect(calls).toHaveLength(5)
  })

  it('3. 无 read 权限时任何命令（含只读命令）都被拒绝', async () => {
    const { bus } = makeBus({ permissions: { ...FULL, read: false } })
    const result = await bus.execute(cmd({ type: 'view.zoom' }))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('无权读取')
  })

  it('4. 非只读但缺 write 权限时拒绝修改命令，只读命令照常', async () => {
    const { bus } = makeBus({ permissions: { ...FULL, write: false } })
    expect((await bus.execute(cmd({ type: 'text.bold' }))).ok).toBe(false)
    expect((await bus.execute(cmd({ type: 'view.next' }))).ok).toBe(true)
  })

  it('5. AI 来源在未开启 AI 权限时被拒绝，用户来源不受影响', async () => {
    const { bus } = makeBus({ permissions: { ...FULL, ai: false } })
    const ai = await bus.execute(cmd({ type: 'text.replace', source: 'ai' }))
    expect(ai.ok).toBe(false)
    expect(ai.reason).toContain('AI')
    expect((await bus.execute(cmd({ type: 'text.replace', source: 'user' }))).ok).toBe(true)
  })

  it('6. 注册的前缀处理器优先于默认出口', async () => {
    const { bus, calls } = makeBus()
    const handler = vi.fn(async () => ({ ok: true, data: 'handled' }))
    bus.register('text.', handler)
    const result = await bus.execute(cmd({ type: 'text.insert' }))
    expect(result.data).toBe('handled')
    expect(handler).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(0)
  })

  it('7. 更具体的前缀优先匹配（text.marks. 覆盖 text.）', async () => {
    const { bus } = makeBus()
    bus.register('text.', async () => ({ ok: true, data: 'generic' }))
    bus.register('text.marks.', async () => ({ ok: true, data: 'specific' }))
    expect((await bus.execute(cmd({ type: 'text.marks.bold' }))).data).toBe('specific')
    expect((await bus.execute(cmd({ type: 'text.insert' }))).data).toBe('generic')
  })

  it('8. 同一会话的写命令按到达顺序串行落地', async () => {
    const order: number[] = []
    const { bus } = makeBus({
      dispatch: async (command) => {
        const value = Number(command.args)
        // 靠前的命令故意更慢，验证串行而不是并发
        await new Promise((resolve) => setTimeout(resolve, value === 1 ? 20 : 1))
        order.push(value)
        return { ok: true }
      },
    })
    await Promise.all([
      bus.execute(cmd({ type: 'text.insert', args: 1 })),
      bus.execute(cmd({ type: 'text.insert', args: 2 })),
      bus.execute(cmd({ type: 'text.insert', args: 3 })),
    ])
    expect(order).toEqual([1, 2, 3])
  })

  it('9. 只读安全命令走快通道，不被挂起的写命令阻塞', async () => {
    // 用对象持有 resolve，避免 TS 把闭包里赋值的变量窄化成 never
    const deferred: { release?: () => void } = {}
    const { bus } = makeBus({
      dispatch: (command) =>
        command.type === 'text.insert'
          ? new Promise<CommandResult>((resolve) => {
              deferred.release = () => resolve({ ok: true })
            })
          : Promise.resolve({ ok: true })
    })
    const write = bus.execute(cmd({ type: 'text.insert' }))
    const read = await bus.execute(cmd({ type: 'view.zoom' }))
    expect(read.ok).toBe(true)
    deferred.release?.()
    await write
  })

  it('10. 处理器抛异常时返回 ok:false，且不打断后续队列', async () => {
    const { bus } = makeBus({
      dispatch: async (command) => {
        if (command.type === 'text.bad') throw new Error('引擎崩溃')
        return { ok: true }
      },
    })
    const bad = await bus.execute(cmd({ type: 'text.bad' }))
    expect(bad.ok).toBe(false)
    expect(bad.reason).toBe('引擎崩溃')
    expect((await bus.execute(cmd({ type: 'text.good' }))).ok).toBe(true)
  })

  it('11. 审计只保留最近 N 条，记录来源与结果', async () => {
    const { bus } = makeBus()
    const bus2 = new CommandBus({
      readonly: () => false,
      permissions: () => FULL,
      dispatch: async () => ({ ok: true }),
      auditLimit: 3,
    })
    for (const id of ['a', 'b', 'c', 'd']) {
      await bus2.execute({ id, type: 'text.insert', source: 'user' })
    }
    const audit = bus2.getAudit()
    expect(audit).toHaveLength(3)
    expect(audit.map((item) => item.id)).toEqual(['b', 'c', 'd'])
    expect(audit[0]!.source).toBe('user')
    expect(audit[0]!.ok).toBe(true)

    // 被守卫拒绝的命令同样要留痕，否则事后查不出「AI 改动为什么没生效」
    await bus.execute(cmd({ type: 'text.insert' }))
    expect(bus.getAudit()).toHaveLength(1)
  })

  it('12. dispose 之后拒绝一切命令并清空审计', async () => {
    const { bus } = makeBus()
    await bus.execute(cmd())
    bus.dispose()
    const result = await bus.execute(cmd())
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('已关闭')
    expect(bus.getAudit()).toHaveLength(0)
  })

  it('13. drain 会等待已排队的写命令全部落地', async () => {
    const done: number[] = []
    const { bus } = makeBus({
      dispatch: async (command) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        done.push(Number(command.args))
        return { ok: true }
      },
    })
    void bus.execute(cmd({ type: 'text.insert', args: 1 }))
    void bus.execute(cmd({ type: 'text.insert', args: 2 }))
    await bus.drain()
    expect(done).toEqual([1, 2])
  })
})
