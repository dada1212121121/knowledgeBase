/** 修订的纯逻辑与控制器单测。真引擎上的"开修订改一段 → 出现插入 / 删除标记 → 接受 / 拒绝"在 e2e。 */
import { describe, expect, it, vi } from 'vitest'
import { DocxRevisionController, mergeAdjacent, previewText, revisionLabel, summarizeByAuthor, toRevisionViews, type RawRevision, type RevisionBackend } from './docx-revisions'

const r = (revisionId: string, author: string, kind = 'insertion', preview = '文字'): RawRevision => ({ revisionId, author, date: '2026-01-01T00:00:00Z', kind, story: 'body', preview })

describe('纯逻辑', () => {
  it('种类翻成人话；不认识的原样带种类名，不丢', () => {
    expect(revisionLabel('insertion')).toBe('插入')
    expect(revisionLabel('deletion')).toBe('删除')
    expect(revisionLabel('pPrChange')).toBe('段落格式变化')
    expect(revisionLabel('somethingNew')).toBe('修订（somethingNew）')
  })

  it('按作者统计，多的在前，同数按名字', () => {
    expect(summarizeByAuthor([r('1', '乙'), r('2', '甲'), r('3', '甲'), r('4', '丙')])).toEqual([
      { author: '甲', count: 2 },
      { author: '丙', count: 1 },
      { author: '乙', count: 1 },
    ])
    expect(summarizeByAuthor([])).toEqual([])
  })

  it('标记是不是我做的', () => {
    const views = toRevisionViews([r('1', '甲'), r('2', '乙')], '甲')
    expect(views.map((view) => view.mine)).toEqual([true, false])
    expect(views[0]!.label).toBe('插入')
  })

  it('预览：压缩空白、截断、空的给占位', () => {
    expect(previewText('  a \n\n b  ')).toBe('a b')
    expect(previewText('')).toBe('（无文字）')
    expect(previewText('字'.repeat(100), 10)).toBe(`${'字'.repeat(10)}…`)
  })
})

function setup(initial: RawRevision[], options: { editable?: boolean } = {}) {
  const state = { revisions: [...initial] }
  const decided: string[] = []
  const backend: RevisionBackend = {
    read: vi.fn(async () => [...state.revisions]),
    decide: vi.fn(async (id, accept) => {
      decided.push(`${accept ? 'accept' : 'reject'}:${id}`)
      if (!state.revisions.some((revision) => revision.revisionId === id)) return { ok: false, reason: '这条修订已经不存在' }
      state.revisions = state.revisions.filter((revision) => revision.revisionId !== id)
      return { ok: true }
    }),
    reveal: vi.fn(async () => true),
  }
  let editable = options.editable ?? true
  const changes: number[] = []
  const controller = new DocxRevisionController(backend, { me: '甲', editable: () => editable, onChange: (list) => changes.push(list.length) })
  return { controller, backend, state, decided, changes, setEditable: (value: boolean) => (editable = value) }
}

describe('DocxRevisionController', () => {
  it('刷新后列出修订并通知', async () => {
    const { controller, changes } = setup([r('1', '甲'), r('2', '乙', 'deletion')])
    await controller.refresh()
    expect(controller.current.map((view) => view.label)).toEqual(['插入', '删除'])
    expect(changes).toEqual([2])
  })

  it('接受一条：提交后刷新，列表里少一条', async () => {
    const { controller, decided } = setup([r('1', '乙'), r('2', '乙')])
    await controller.refresh()
    expect((await controller.decide('1', true)).ok).toBe(true)
    expect(decided).toEqual(['accept:1'])
    expect(controller.current.map((view) => view.revisionId)).toEqual(['2'])
  })

  it('拒绝一条', async () => {
    const { controller, decided } = setup([r('1', '乙')])
    await controller.refresh()
    await controller.decide('1', false)
    expect(decided).toEqual(['reject:1'])
  })

  it('只读：不提交', async () => {
    const { controller, backend } = setup([r('1', '乙')], { editable: false })
    await controller.refresh()
    const result = await controller.decide('1', true)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('只读')
    expect(backend.decide).not.toHaveBeenCalled()
    expect((await controller.decideAll(true)).ok).toBe(false)
  })

  it('这条已被别人处理：把原因带出来，并刷新让列表是真实状态', async () => {
    const { controller, state } = setup([r('1', '乙')])
    await controller.refresh()
    state.revisions = []
    const result = await controller.decide('1', true)
    expect(result).toEqual({ ok: false, reason: '这条修订已经不存在' })
    expect(controller.current).toHaveLength(0)
  })

  it('后端抛异常：变成失败结果，不冒出去', async () => {
    const { controller, backend } = setup([r('1', '乙')])
    await controller.refresh()
    vi.mocked(backend.decide).mockRejectedValueOnce(new Error('Worker 忙'))
    expect(await controller.decide('1', true)).toEqual({ ok: false, reason: 'Worker 忙' })
  })

  it('全部接受：逐条提交，返回条数', async () => {
    const { controller, decided } = setup([r('1', '乙'), r('2', '乙'), r('3', '丙')])
    const result = await controller.decideAll(true)
    expect(result).toEqual({ ok: true, done: 3 })
    expect(decided).toEqual(['accept:1', 'accept:2', 'accept:3'])
    expect(controller.current).toHaveLength(0)
  })

  it('只处理某个作者的（筛选）', async () => {
    const { controller, decided } = setup([r('1', '乙'), r('2', '丙'), r('3', '乙')])
    const result = await controller.decideAll(false, (revision) => revision.author === '乙')
    expect(result).toEqual({ ok: true, done: 2 })
    expect(decided).toEqual(['reject:1', 'reject:3'])
    expect(controller.current.map((view) => view.revisionId)).toEqual(['2'])
  })

  it('全部处理中途某条在读到列表后被别人处理掉了：跳过它继续，不算失败', async () => {
    const { controller, backend, state } = setup([r('1', '乙'), r('2', '乙'), r('3', '乙')])
    // 先取出原实现再覆盖：vi.fn 的 mockImplementation 会替换掉自己，直接引用 backend.decide 会无限递归
    const original = vi.mocked(backend.decide).getMockImplementation()!
    vi.mocked(backend.decide).mockImplementation(async (id, accept) => {
      if (id === '2') state.revisions = state.revisions.filter((revision) => revision.revisionId !== '2')
      return original(id, accept)
    })
    const result = await controller.decideAll(true)
    expect(result).toEqual({ ok: true, done: 2 })
  })

  it('全部处理遇到真正的失败：停下，不带着旧 id 硬往下做；返回已完成几条', async () => {
    const { controller, backend } = setup([r('1', '乙'), r('2', '乙'), r('3', '乙')])
    vi.mocked(backend.decide).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, reason: '版本过期' })
    const result = await controller.decideAll(true)
    expect(result).toMatchObject({ ok: false, reason: '版本过期', done: 1 })
    expect(backend.decide).toHaveBeenCalledTimes(2)
  })

  it('读的过程中又来刷新：不并发读，读完再读一次', async () => {
    const { controller, backend, state } = setup([r('1', '乙')])
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let reads = 0
    vi.mocked(backend.read).mockImplementation(async () => {
      reads += 1
      if (reads === 1) await gate
      return [...state.revisions]
    })
    const first = controller.refresh()
    state.revisions.push(r('2', '乙'))
    const second = controller.refresh()
    release()
    await Promise.all([first, second])
    expect(reads).toBe(2)
    expect(controller.current).toHaveLength(2)
  })
})

describe('mergeAdjacent（引擎在修订模式下把每个键入的字符各记成一个插入）', () => {
  const at = (id: string, from: number, to: number, over: Partial<RawRevision> = {}): RawRevision => ({
    ...r(id, '甲', 'insertion', id),
    range: { story: 'body', start: { paraId: 'p1', offset: from }, end: { paraId: 'p1', offset: to } },
    ...over,
  })

  it('首尾相接的同作者同种类单字插入合成一条，文字拼起来', () => {
    const merged = mergeAdjacent([' ', 'A', 'D', 'D', 'E', 'D'].map((char, index) => at(`i${index}`, 10 + index, 11 + index, { preview: char })))
    expect(merged).toHaveLength(1)
    expect(merged[0]!.preview).toBe(' ADDED')
    expect(merged[0]!.ids).toEqual(['i0', 'i1', 'i2', 'i3', 'i4', 'i5'])
    expect(merged[0]!.range).toMatchObject({ start: { offset: 10 }, end: { offset: 16 } })
  })

  it('中间隔着别的字（不相接）不合并', () => {
    expect(mergeAdjacent([at('a', 0, 1), at('b', 5, 6)])).toHaveLength(2)
  })

  it('不同作者 / 不同种类 / 不同段 不合并', () => {
    expect(mergeAdjacent([at('a', 0, 1), at('b', 1, 2, { author: '乙' })])).toHaveLength(2)
    expect(mergeAdjacent([at('a', 0, 1), at('b', 1, 2, { kind: 'deletion' })])).toHaveLength(2)
    const otherParagraph = at('b', 1, 2)
    otherParagraph.range = { story: 'body', start: { paraId: 'p2', offset: 1 }, end: { paraId: 'p2', offset: 2 } }
    expect(mergeAdjacent([at('a', 0, 1), otherParagraph])).toHaveLength(2)
  })

  it('段落属性 / 表格行修订不合并；没有范围的修订也不合并（保守）', () => {
    expect(mergeAdjacent([at('a', 0, 1, { kind: 'pPrChange' }), at('b', 1, 2, { kind: 'pPrChange' })])).toHaveLength(2)
    expect(mergeAdjacent([r('x', '甲'), r('y', '甲')])).toHaveLength(2)
  })

  it('不改传入的修订对象', () => {
    const input = [at('a', 0, 1), at('b', 1, 2)]
    const snapshot = JSON.stringify(input)
    mergeAdjacent(input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it('接受 / 拒绝合并的一条：背后每个引擎修订都处理，缺一个就会留下半截修订', async () => {
    const decided: string[] = []
    const revisions = [at('i0', 0, 1), at('i1', 1, 2), at('i2', 2, 3)]
    const state = { list: [...revisions] }
    const backend: RevisionBackend = {
      read: async () => state.list.map((revision) => ({ ...revision, range: revision.range ? { ...revision.range } : undefined })),
      decide: async (id, accept) => {
        decided.push(`${accept ? 'accept' : 'reject'}:${id}`)
        state.list = state.list.filter((revision) => revision.revisionId !== id)
        return { ok: true }
      },
      reveal: async () => true,
    }
    const controller = new DocxRevisionController(backend, { me: '甲', editable: () => true, onChange: () => undefined })
    await controller.refresh()
    expect(controller.current).toHaveLength(1)
    await controller.decide('i0', true)
    expect(decided).toEqual(['accept:i0', 'accept:i1', 'accept:i2'])
    expect(controller.current).toHaveLength(0)
  })

  it('合并的一条处理到一半失败：停下并返回失败（后面的不再处理）', async () => {
    const calls: string[] = []
    const backend: RevisionBackend = {
      read: async () => [at('i0', 0, 1), at('i1', 1, 2), at('i2', 2, 3)],
      decide: async (id) => {
        calls.push(id)
        return id === 'i1' ? { ok: false, reason: '版本过期' } : { ok: true }
      },
      reveal: async () => true,
    }
    const controller = new DocxRevisionController(backend, { me: '甲', editable: () => true, onChange: () => undefined })
    await controller.refresh()
    expect(await controller.decide('i0', true)).toEqual({ ok: false, reason: '版本过期' })
    expect(calls).toEqual(['i0', 'i1'])
  })
})
