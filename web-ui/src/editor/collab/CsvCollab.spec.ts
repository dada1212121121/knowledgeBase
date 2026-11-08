/**
 * CSV 协同适配器
 *
 * 用一个真的 Y.Text 守住三件事：本地编辑只产生最小文本补丁；远端文本变化会刷新网格；
 * 只读房间拒绝写入。没有伪协同，也没有用「整表重写」掩盖冲突。
 */
import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { CsvCollab } from './CsvCollab'

function room(initial: string, name = 'a.csv') {
  const doc = new Y.Doc()
  const text = doc.getText('content')
  text.insert(0, initial)
  return { doc, text, adapter: new CsvCollab({ text, name }) }
}

describe('CsvCollab', () => {
  it('1. 初始解析与网格适配', () => {
    const { adapter } = room('name,qty\n苹果,3\n香蕉,5\n')
    const sheet = adapter.sheets()[0]
    expect(sheet.rowCount).toBe(3)
    expect(sheet.cell(1, 0)?.text).toBe('苹果')
    expect(adapter.revision()).toBe(0)
  })

  it('2. 改一格只对文本做最小补丁，其它字节不动', () => {
    const source = '\uFEFFa,b\r\n1,2\r\n3,4\r\n'
    const { adapter, text } = room(source)
    expect(adapter.apply([{ row: 1, col: 1, text: '9' }])).toBe(true)
    expect(text.toString()).toBe('\uFEFFa,b\r\n1,9\r\n3,4\r\n')
    expect(adapter.snapshot().text).toBe('\uFEFFa,b\r\n1,9\r\n3,4\r\n')
    expect(adapter.revision()).toBeGreaterThan(0)
  })

  it('3. 远端改文本 → 订阅者收到通知，网格重新解析', () => {
    const { adapter, text } = room('a,b\n1,2\n')
    const seen = vi.fn()
    const off = adapter.subscribe(seen)
    text.insert(text.length, '5,6\n')
    expect(seen).toHaveBeenCalled()
    expect(adapter.sheets()[0].cell(2, 0)?.text).toBe('5')
    off()
    text.insert(text.length, '7,8\n')
    expect(seen).toHaveBeenCalledTimes(1)
    adapter.destroy()
  })

  it('4. 两处不同格子各自补丁，文本合并后都保留', () => {
    const { adapter, text } = room('a,b,c\n1,2,3\n')
    adapter.apply([{ row: 0, col: 0, text: 'A' }])
    adapter.apply([{ row: 1, col: 2, text: 'C' }])
    expect(text.toString()).toBe('A,b,c\n1,2,C\n')
  })

  it('5. 同一格连改以最后一次为准，一次事务只落最终值', () => {
    const { adapter, text } = room('a,b\n1,2\n')
    adapter.apply([
      { row: 0, col: 0, text: 'x' },
      { row: 0, col: 0, text: 'y' },
    ])
    expect(text.toString()).toBe('y,b\n1,2\n')
  })

  it('6. 只读房间拒绝写入，也拒绝追加', () => {
    const doc = new Y.Doc()
    const text = doc.getText('content')
    text.insert(0, 'a,b\n1,2\n')
    const adapter = new CsvCollab({ text, name: 'a.csv', readonly: () => true })
    expect(adapter.readonly()).toBe(true)
    expect(adapter.apply([{ row: 0, col: 0, text: 'x' }])).toBe(false)
    expect(text.toString()).toBe('a,b\n1,2\n')
  })

  it('7. 协同没有本地撤销栈：undo/redo 明确返回 false，不覆盖别人', () => {
    const { adapter } = room('a,b\n1,2\n')
    expect(adapter.undo()).toBe(false)
    expect(adapter.redo()).toBe(false)
  })

  it('8. destroy 后退订，不再对已卸载视图发通知', () => {
    const { adapter, text } = room('a,b\n1,2\n')
    const seen = vi.fn()
    adapter.subscribe(seen)
    adapter.destroy()
    text.insert(text.length, '3,4\n')
    expect(seen).not.toHaveBeenCalled()
  })
})

describe('splicesFromDelta', () => {
  it('retain / delete / insert 转成正文坐标的替换；相邻的删 + 插并成一笔', async () => {
    const { splicesFromDelta } = await import('./CsvCollab')
    expect(splicesFromDelta([{ retain: 4 }, { delete: 2 }, { insert: '新值' }], 0)).toEqual([{ index: 4, remove: 2, insert: '新值' }])
    expect(splicesFromDelta([{ retain: 4 }, { insert: '新值' }, { delete: 2 }], 0)).toEqual([{ index: 4, remove: 2, insert: '新值' }])
    expect(splicesFromDelta([{ retain: 1 }, { insert: 'x' }, { retain: 3 }, { delete: 1 }], 0)).toEqual([
      { index: 1, remove: 0, insert: 'x' },
      { index: 5, remove: 1, insert: '' },
    ])
    // 房间里有 BOM：下标减掉它；动到 BOM 本身返回 null
    expect(splicesFromDelta([{ retain: 5 }, { insert: 'y' }], 1)).toEqual([{ index: 4, remove: 0, insert: 'y' }])
    expect(splicesFromDelta([{ delete: 1 }], 1)).toBeNull()
    expect(splicesFromDelta([{ insert: { embed: true } }], 0)).toBeNull()
  })
})

/**
 * 行操作：删除行是对房间文本的最小删除，别人立刻看到；
 * 插入行先是本机的「待写入空行」，填了内容才作为一次文本插入发出去。
 */
describe('CsvCollab 行操作', () => {
  /** 两个客户端各持一份 Y.Doc，更新互相转发（模拟房间） */
  function pair(initial: string, live = true) {
    const left = new Y.Doc()
    const right = new Y.Doc()
    left.getText('content').insert(0, initial)
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left))
    // live = false 时断开：两边各自改完再手动互相同步，模拟真正的并发
    const wire = () => {
      left.on('update', (update: Uint8Array) => Y.applyUpdate(right, update))
      right.on('update', (update: Uint8Array) => Y.applyUpdate(left, update))
    }
    if (live) wire()
    return {
      a: new CsvCollab({ text: left.getText('content'), name: 'a.csv' }),
      b: new CsvCollab({ text: right.getText('content'), name: 'a.csv' }),
      textA: left.getText('content'),
      textB: right.getText('content'),
      sync: () => {
        Y.applyUpdate(right, Y.encodeStateAsUpdate(left))
        Y.applyUpdate(left, Y.encodeStateAsUpdate(right))
      },
    }
  }

  it('1. 删除若干行：房间文本只少了那几行，对端立即看到', () => {
    const { a, b, textA, textB } = pair('h1,h2\r\n1,2\r\n3,4\r\n5,6\r\n')
    expect(a.deleteRows(1, 2)).toBe(true)
    expect(textA.toString()).toBe('h1,h2\r\n5,6\r\n')
    expect(textB.toString()).toBe('h1,h2\r\n5,6\r\n')
    expect(b.sheets()[0].rowCount).toBe(2)
    expect(b.sheets()[0].cell(1, 0)?.text).toBe('5')
  })

  it('2. 删最后一行（末尾没有换行）：结尾仍然没有换行', () => {
    const { a, textB } = pair('a,b\n1,2\n3,4')
    a.deleteRows(2, 2)
    expect(textB.toString()).toBe('a,b\n1,2')
  })

  it('3. 待写入的空行只在本机：对端行数不变；填了内容才一次性出现在对端', () => {
    const { a, b, textB } = pair('a,b\n1,2\n')
    expect(a.insertRows(1, 1)).toBe(true)
    expect(a.sheets()[0].rowCount).toBe(3)
    expect(b.sheets()[0].rowCount).toBe(2)
    expect(textB.toString()).toBe('a,b\n1,2\n')
    expect(a.apply([{ row: 1, col: 0, text: 'X' }, { row: 1, col: 1, text: 'Y' }])).toBe(true)
    expect(textB.toString()).toBe('a,b\nX,Y\n1,2\n')
    expect(b.sheets()[0].rowCount).toBe(3)
    expect(b.sheets()[0].cell(1, 1)?.text).toBe('Y')
    // 本机：写进去的行不再重复显示
    expect(a.sheets()[0].rowCount).toBe(3)
  })

  it('4. 两个人同时：A 删第 1 行、B 改第 3 行的格子，合并后两个改动都在', () => {
    const { a, b, textA, textB, sync } = pair('a,b\n1,2\n3,4\n5,6\n', false)
    a.deleteRows(1, 1)
    b.apply([{ row: 2, col: 1, text: 'B' }])
    sync()
    expect(textA.toString()).toBe(textB.toString())
    expect(textA.toString()).toBe('a,b\n3,B\n5,6\n')
  })

  it('5. 别人把表删短了：本机待写入空行的位置夹回有效范围，不指向不存在的行', () => {
    const { a, b } = pair('a\n1\n2\n3\n')
    a.insertRows(4, 1) // 加在最后
    expect(a.sheets()[0].rowCount).toBe(5)
    b.deleteRows(2, 3)
    const sheet = a.sheets()[0]
    expect(sheet.rowCount).toBe(3)
    expect(sheet.cell(2, 0)?.background).toBeDefined()
  })

  it('6. 只读房间拒绝行操作', () => {
    const doc = new Y.Doc()
    const text = doc.getText('content')
    text.insert(0, 'a\n1\n')
    const adapter = new CsvCollab({ text, name: 'a.csv', readonly: () => true })
    expect(adapter.insertRows(0, 1)).toBe(false)
    expect(adapter.deleteRows(0, 0)).toBe(false)
    expect(text.toString()).toBe('a\n1\n')
  })

  it('7. 一次删除是一个事务：对端只收到一次更新', () => {
    const { a, b } = pair('a\n1\n2\n3\n')
    const seen = vi.fn()
    b.subscribe(seen)
    a.deleteRows(1, 3)
    expect(seen).toHaveBeenCalledTimes(1)
  })
})
