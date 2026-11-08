/** Word 评论的纯逻辑与控制器单测。真引擎上的新建 / 回复 / 解决 / 另一窗口实时看到在 e2e。 */
import { describe, expect, it, vi } from 'vitest'
import { DocxCommentController, type CommentBackend, type CommentSnapshot } from './docx-comment-controller'
import { buildThreads, COMMENT_MAX_CHARS, commentPermissions, commentText, relativeTime, splitByState, validateCommentText, type RawComment } from './docx-comments'

const c = (id: string, author: string, date: string, body: unknown, over: Partial<RawComment> = {}): RawComment => ({ id, author, date, done: false, parentId: null, body, ...over })

describe('commentText', () => {
  it('字符串原样；结构体取所有 text 叶子按段落拼', () => {
    expect(commentText('你好')).toBe('你好')
    expect(commentText({ content: [{ content: [{ content: [{ type: 'text', text: '第一段' }] }] }, { content: [{ content: [{ type: 'text', text: '第二段' }] }] }] })).toBe('第一段\n第二段')
    expect(commentText(null)).toBe('')
    expect(commentText(42)).toBe('')
    expect(commentText({})).toBe('')
  })
})

describe('buildThreads', () => {
  const positions = new Map([['a', 5], ['b', 1]])
  it('根评论按文档位置排序，回复按时间挂在根下', () => {
    const threads = buildThreads(
      [c('a', '甲', '2026-01-01T00:00:00Z', 'A'), c('b', '乙', '2026-01-02T00:00:00Z', 'B'), c('r2', '丙', '2026-01-04T00:00:00Z', '后回', { parentId: 'b' }), c('r1', '甲', '2026-01-03T00:00:00Z', '先回', { parentId: 'b' })],
      positions,
      '甲',
    )
    expect(threads.map((thread) => thread.root.id)).toEqual(['b', 'a'])
    expect(threads[0]!.replies.map((reply) => reply.text)).toEqual(['先回', '后回'])
    expect(threads[0]!.replies[0]!.mine).toBe(true)
    expect(threads[0]!.root.mine).toBe(false)
  })

  it('回复指向不存在的评论：当作独立的根显示，不丢', () => {
    const threads = buildThreads([c('x', '甲', '2026-01-01T00:00:00Z', '孤儿', { parentId: 'gone' })], new Map(), '甲')
    expect(threads).toHaveLength(1)
    expect(threads[0]!.root.text).toBe('孤儿')
  })

  it('回复的回复并到最顶层的根下面', () => {
    const threads = buildThreads([c('a', '甲', '1', 'A'), c('b', '乙', '2', 'B', { parentId: 'a' }), c('c', '丙', '3', 'C', { parentId: 'b' })], new Map([['a', 0]]), '甲')
    expect(threads).toHaveLength(1)
    expect(threads[0]!.replies.map((reply) => reply.id)).toEqual(['b', 'c'])
  })

  it('循环引用不会死循环', () => {
    const threads = buildThreads([c('a', '甲', '1', 'A', { parentId: 'b' }), c('b', '乙', '2', 'B', { parentId: 'a' })], new Map(), '甲')
    expect(threads.length).toBeGreaterThan(0)
  })

  it('没有位置的排最后；同位置按时间', () => {
    const threads = buildThreads([c('late', '甲', '2026-02-01', 'L'), c('early', '甲', '2026-01-01', 'E'), c('placed', '甲', '2026-03-01', 'P')], new Map([['placed', 0]]), '甲')
    expect(threads.map((thread) => thread.root.id)).toEqual(['placed', 'early', 'late'])
  })

  it('已解决的线程分到另一组', () => {
    const threads = buildThreads([c('a', '甲', '1', 'A', { done: true }), c('b', '甲', '2', 'B')], new Map(), '甲')
    const { open, resolved } = splitByState(threads)
    expect(open.map((thread) => thread.root.id)).toEqual(['b'])
    expect(resolved.map((thread) => thread.root.id)).toEqual(['a'])
  })

  it('空输入', () => {
    expect(buildThreads([], new Map(), '甲')).toEqual([])
  })
})

describe('validateCommentText / permissions / relativeTime', () => {
  it('空白、过长拒绝；正常通过', () => {
    expect(validateCommentText('   ')).toContain('不能为空')
    expect(validateCommentText('好')).toBeNull()
    expect(validateCommentText('字'.repeat(COMMENT_MAX_CHARS))).toBeNull()
    expect(validateCommentText('字'.repeat(COMMENT_MAX_CHARS + 1))).toContain('太长')
  })

  it('只读什么都不能做；能编辑的可评论 / 解决，但只能删自己的', () => {
    const mine = { id: '1', author: '甲', date: '', text: '', mine: true }
    const theirs = { ...mine, id: '2', author: '乙', mine: false }
    const readonly = commentPermissions(false)
    expect([readonly.canComment, readonly.canResolve, readonly.canDelete(mine)]).toEqual([false, false, false])
    const editor = commentPermissions(true)
    expect([editor.canComment, editor.canResolve, editor.canDelete(mine), editor.canDelete(theirs)]).toEqual([true, true, true, false])
  })

  it('相对时间', () => {
    const now = Date.parse('2026-11-04T12:00:00Z')
    expect(relativeTime('2026-11-04T11:59:50Z', now)).toBe('刚刚')
    expect(relativeTime('2026-11-04T11:30:00Z', now)).toBe('30 分钟前')
    expect(relativeTime('2026-11-04T09:00:00Z', now)).toBe('3 小时前')
    expect(relativeTime('2026-11-01T12:00:00Z', now)).toBe('3 天前')
    expect(relativeTime('not a date', now)).toBe('')
  })
})

/* ---------------- 控制器 ---------------- */

function fakeBackend(initial: RawComment[] = []) {
  const state = { comments: [...initial], positions: new Map<string, number>(), nextId: 100 }
  const calls: string[] = []
  const backend: CommentBackend = {
    read: vi.fn(async () => ({ comments: [...state.comments], positions: state.positions }) as CommentSnapshot),
    add: vi.fn(async (text, author) => {
      calls.push(`add:${text}`)
      const id = String(state.nextId++)
      state.comments.push(c(id, author, new Date().toISOString(), text))
      state.positions.set(id, state.positions.size)
      return { ok: true }
    }),
    reply: vi.fn(async (parentId, text, author) => {
      calls.push(`reply:${parentId}:${text}`)
      if (!state.comments.some((comment) => comment.id === parentId)) return { ok: false, reason: '评论不存在' }
      state.comments.push(c(String(state.nextId++), author, new Date().toISOString(), text, { parentId }))
      return { ok: true }
    }),
    setDone: vi.fn(async (id, done) => {
      calls.push(`done:${id}:${done}`)
      const target = state.comments.find((comment) => comment.id === id)
      if (!target) return { ok: false, reason: '评论不存在' }
      target.done = done
      return { ok: true }
    }),
    remove: vi.fn(async (id) => {
      calls.push(`remove:${id}`)
      state.comments = state.comments.filter((comment) => comment.id !== id)
      return { ok: true }
    }),
    reveal: vi.fn(async () => true),
  }
  return { backend, state, calls }
}

function setup(options: { initial?: RawComment[]; editable?: boolean } = {}) {
  const fake = fakeBackend(options.initial)
  const changes: number[] = []
  let editable = options.editable ?? true
  const controller = new DocxCommentController(fake.backend, { me: '甲', editable: () => editable, onChange: (threads) => changes.push(threads.length) })
  return { ...fake, controller, changes, setEditable: (value: boolean) => (editable = value) }
}

describe('DocxCommentController', () => {
  it('新建：前后空白去掉再提交，成功后刷新出新线程', async () => {
    const { controller, calls } = setup()
    const result = await controller.add('  需要核对数字  ')
    expect(result.ok).toBe(true)
    expect(calls).toEqual(['add:需要核对数字'])
    expect(controller.current).toHaveLength(1)
    expect(controller.current[0]!.root).toMatchObject({ text: '需要核对数字', author: '甲', mine: true })
  })

  it('空内容 / 过长：不发给引擎，也不刷新', async () => {
    const { controller, backend } = setup()
    expect((await controller.add('  ')).ok).toBe(false)
    expect((await controller.add('字'.repeat(COMMENT_MAX_CHARS + 1))).ok).toBe(false)
    expect(backend.add).not.toHaveBeenCalled()
    expect(backend.read).not.toHaveBeenCalled()
  })

  it('只读：所有动作都拒绝，一条都不发给引擎', async () => {
    const mine = c('1', '甲', '1', 'A')
    const { controller, backend } = setup({ initial: [mine], editable: false })
    await controller.refresh()
    const thread = controller.current[0]!
    for (const result of [await controller.add('x'), await controller.reply('1', 'x'), await controller.setDone('1', true), await controller.remove(thread.root), await controller.removeThread(thread)]) {
      expect(result).toEqual({ ok: false, reason: expect.stringContaining('只读') })
    }
    expect(backend.add).not.toHaveBeenCalled()
    expect(backend.reply).not.toHaveBeenCalled()
    expect(backend.setDone).not.toHaveBeenCalled()
    expect(backend.remove).not.toHaveBeenCalled()
  })

  it('权限在每次动作时现取：中途被收回编辑权，下一个动作就被拒', async () => {
    const { controller, setEditable } = setup()
    expect((await controller.add('第一条')).ok).toBe(true)
    setEditable(false)
    expect((await controller.add('第二条')).ok).toBe(false)
  })

  it('回复：父评论存在才发；回复挂在线程下', async () => {
    const { controller, calls } = setup({ initial: [c('1', '乙', '2026-01-01', '问题')] })
    await controller.refresh()
    expect((await controller.reply('1', '好的')).ok).toBe(true)
    expect(calls).toContain('reply:1:好的')
    expect(controller.current[0]!.replies.map((reply) => reply.text)).toEqual(['好的'])
  })

  it('回复一条已经被别人删掉的评论：不发给引擎，说明原因', async () => {
    const { controller, backend } = setup({ initial: [c('1', '乙', '1', '问题')] })
    await controller.refresh()
    const result = await controller.reply('gone', 'x')
    expect(result).toEqual({ ok: false, reason: '要回复的评论已经不在了' })
    expect(backend.reply).not.toHaveBeenCalled()
  })

  it('解决 / 重开：状态跟着刷新；别人的评论也能解决', async () => {
    const { controller } = setup({ initial: [c('1', '乙', '1', '问题')] })
    await controller.refresh()
    await controller.setDone('1', true)
    expect(controller.current[0]!.root.done).toBe(true)
    await controller.setDone('1', false)
    expect(controller.current[0]!.root.done).toBe(false)
  })

  it('引擎拒绝（评论已被别人删了）：带着原因返回，并刷新让列表反映真实状态', async () => {
    const { controller, backend, state } = setup({ initial: [c('1', '乙', '1', '问题')] })
    await controller.refresh()
    state.comments = []
    vi.mocked(backend.read).mockClear()
    const result = await controller.setDone('1', true)
    expect(result).toEqual({ ok: false, reason: '评论不存在' })
    expect(backend.read).toHaveBeenCalled()
    expect(controller.current).toHaveLength(0)
  })

  it('后端抛异常：变成失败结果而不是异常冒出去，仍然刷新', async () => {
    const { controller, backend } = setup()
    vi.mocked(backend.add).mockRejectedValueOnce(new Error('Worker 没响应'))
    const result = await controller.add('x')
    expect(result).toEqual({ ok: false, reason: 'Worker 没响应' })
    expect(backend.read).toHaveBeenCalled()
  })

  it('只能删自己写的', async () => {
    const { controller, backend } = setup({ initial: [c('1', '甲', '1', '我的'), c('2', '乙', '2', '他的')] })
    await controller.refresh()
    const [mine, theirs] = ['1', '2'].map((id) => controller.current.find((thread) => thread.root.id === id)!)
    expect((await controller.remove(theirs!.root)).reason).toContain('只能删除自己写的')
    expect(backend.remove).not.toHaveBeenCalled()
    expect((await controller.remove(mine!.root)).ok).toBe(true)
    expect(controller.current.map((thread) => thread.root.id)).toEqual(['2'])
  })

  it('删线程：先删回复再删根；线程里有别人的回复就整体拒绝，一条都不删', async () => {
    const own = setup({ initial: [c('1', '甲', '1', '根'), c('2', '甲', '2', '自己回', { parentId: '1' })] })
    await own.controller.refresh()
    expect((await own.controller.removeThread(own.controller.current[0]!)).ok).toBe(true)
    expect(own.calls).toEqual(['remove:2', 'remove:1'])
    expect(own.controller.current).toHaveLength(0)

    const mixed = setup({ initial: [c('1', '甲', '1', '根'), c('2', '乙', '2', '别人回', { parentId: '1' })] })
    await mixed.controller.refresh()
    const result = await mixed.controller.removeThread(mixed.controller.current[0]!)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('乙')
    expect(mixed.backend.remove).not.toHaveBeenCalled()
  })

  it('删线程中途失败：停下，不去删根（不留下没有根的回复）', async () => {
    const { controller, backend } = setup({ initial: [c('1', '甲', '1', '根'), c('2', '甲', '2', '回1', { parentId: '1' }), c('3', '甲', '3', '回2', { parentId: '1' })] })
    await controller.refresh()
    vi.mocked(backend.remove).mockResolvedValueOnce({ ok: false, reason: '版本过期' })
    const result = await controller.removeThread(controller.current[0]!)
    expect(result).toEqual({ ok: false, reason: '版本过期' })
    expect(backend.remove).toHaveBeenCalledTimes(1)
  })

  it('读的过程中又来刷新：不并发读，读完再读一次，最后一次请求之后的状态一定被读到', async () => {
    const { controller, backend, state } = setup({ initial: [c('1', '乙', '1', 'A')] })
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let reads = 0
    vi.mocked(backend.read).mockImplementation(async () => {
      reads += 1
      if (reads === 1) await gate
      return { comments: [...state.comments], positions: new Map() }
    })
    const first = controller.refresh()
    state.comments.push(c('2', '乙', '2', 'B'))
    const second = controller.refresh()
    release()
    await Promise.all([first, second])
    expect(reads).toBe(2)
    expect(controller.current).toHaveLength(2)
  })

  it('点评论：转给后端去选中并滚到锚点', async () => {
    const { controller, backend } = setup()
    expect(await controller.reveal('7')).toBe(true)
    expect(backend.reveal).toHaveBeenCalledWith('7')
  })
})
