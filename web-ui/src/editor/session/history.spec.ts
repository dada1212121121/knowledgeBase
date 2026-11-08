import { describe, expect, it } from 'vitest'
import { History } from './History'

/** 建一个可断言的步骤：把值写回 store，同时记录调用顺序 */
function makeStep(store: { value: string }, from: string, to: string, trail: string[]) {
  return {
    undo: () => {
      store.value = from
      trail.push(`undo:${to}->${from}`)
    },
    redo: () => {
      store.value = to
      trail.push(`redo:${from}->${to}`)
    },
  }
}

describe('History：按内容面实现的撤销栈', () => {
  it('14. 记录后可以撤销，撤销后再重做', async () => {
    const store = { value: 'a' }
    const trail: string[] = []
    const history = new History({ now: () => 0 })

    store.value = 'ab'
    history.record({ step: makeStep(store, 'a', 'ab', trail) })
    expect(history.canUndo).toBe(true)
    expect(history.canRedo).toBe(false)

    expect(await history.undo()).toBe(true)
    expect(store.value).toBe('a')
    expect(history.canRedo).toBe(true)

    expect(await history.redo()).toBe(true)
    expect(store.value).toBe('ab')
  })

  it('15. 空栈时 undo/redo 返回 false，不抛异常', async () => {
    const history = new History()
    expect(await history.undo()).toBe(false)
    expect(await history.redo()).toBe(false)
  })

  it('16. 合并窗口内相同 mergeKey 的步骤合并为一条历史', async () => {
    const store = { value: '' }
    const trail: string[] = []
    let clock = 0
    const history = new History({ now: () => clock, mergeWindowMs: 400 })

    store.value = 'a'
    history.record({ mergeKey: 'insert', step: makeStep(store, '', 'a', trail), at: 0 })
    clock = 100
    store.value = 'ab'
    history.record({ mergeKey: 'insert', step: makeStep(store, 'a', 'ab', trail), at: 100 })
    clock = 200
    store.value = 'abc'
    history.record({ mergeKey: 'insert', step: makeStep(store, 'ab', 'abc', trail), at: 200 })

    expect(history.depth).toBe(1)
    // 合并条目的撤销要逆序执行：abc→ab，ab→a，a→''
    expect(await history.undo()).toBe(true)
    expect(store.value).toBe('')
    expect(trail).toEqual(['undo:abc->ab', 'undo:ab->a', 'undo:a->'])
  })

  it('17. 超出合并窗口的同类操作不再合并', () => {
    const store = { value: '' }
    const trail: string[] = []
    const history = new History({ now: () => 0, mergeWindowMs: 400 })
    history.record({ mergeKey: 'insert', step: makeStep(store, '', 'a', trail), at: 0 })
    history.record({ mergeKey: 'insert', step: makeStep(store, 'a', 'ab', trail), at: 401 })
    expect(history.depth).toBe(2)
  })

  it('18. 不同 mergeKey 不合并（加粗与键入是两步撤销）', () => {
    const store = { value: '' }
    const trail: string[] = []
    const history = new History({ now: () => 0 })
    history.record({ mergeKey: 'insert', step: makeStep(store, '', 'a', trail), at: 0 })
    history.record({ mergeKey: 'marks', step: makeStep(store, 'a', 'ab', trail), at: 1 })
    expect(history.depth).toBe(2)
  })

  it('19. 新的本地操作会清空重做链', async () => {
    const store = { value: 'a' }
    const trail: string[] = []
    const history = new History({ now: () => 0 })
    store.value = 'ab'
    history.record({ step: makeStep(store, 'a', 'ab', trail) })
    await history.undo()
    expect(history.canRedo).toBe(true)

    store.value = 'ax'
    history.record({ step: makeStep(store, 'a', 'ax', trail) })
    expect(history.canRedo).toBe(false)
    expect(history.redoDepth).toBe(0)
  })

  it('20. 远端协同变更只计数、绝不入栈（避免撤掉别人的修改）', async () => {
    const history = new History()
    history.recordRemote()
    history.recordRemote()
    expect(history.remoteChanges).toBe(2)
    expect(history.depth).toBe(0)
    expect(await history.undo()).toBe(false)
  })

  it('21. 撤销过程中触发的 record 被忽略（否则一次撤销会产生新历史，形成死循环）', async () => {
    const store = { value: 'a' }
    const history = new History({ now: () => 0 })
    let reentered = 0

    history.record({
      step: {
        undo: () => {
          store.value = 'a'
          // 模拟 Surface 在撤销回调里又发了一次变更通知
          history.record({ step: { undo: () => undefined, redo: () => undefined }, at: 0 })
          reentered += 1
        },
        redo: () => {
          store.value = 'ab'
        },
      },
      at: 0,
    })

    await history.undo()
    expect(reentered).toBe(1)
    expect(history.depth).toBe(0)
  })

  it('22. 超过 limit 时丢弃最旧条目', async () => {
    const store = { value: '' }
    const trail: string[] = []
    const history = new History({ limit: 2, mergeWindowMs: 0, now: () => 0 })
    for (let i = 0; i < 5; i += 1) {
      history.record({ step: makeStep(store, String(i), String(i + 1), trail), at: i })
    }
    expect(history.depth).toBe(2)
    // 剩下的两条应是最后两次（3→4、4→5）
    await history.undo()
    await history.undo()
    expect(await history.undo()).toBe(false)
  })

  it('23. peek 标签供 UI 显示「撤销：加粗」', () => {
    const store = { value: '' }
    const trail: string[] = []
    const history = new History({ now: () => 0 })
    history.record({ label: '加粗', step: makeStep(store, '', 'a', trail), at: 0 })
    expect(history.peekUndoLabel()).toBe('加粗')
    expect(history.peekRedoLabel()).toBeUndefined()
  })

  it('24. clear 同时清空双向栈与远端计数', () => {
    const store = { value: '' }
    const trail: string[] = []
    const history = new History({ now: () => 0 })
    history.record({ step: makeStep(store, '', 'a', trail), at: 0 })
    history.recordRemote()
    history.clear()
    expect(history.depth).toBe(0)
    expect(history.redoDepth).toBe(0)
    expect(history.remoteChanges).toBe(0)
    expect(history.snapshot().undo).toHaveLength(0)
  })
})
