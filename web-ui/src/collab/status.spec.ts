import { describe, expect, it } from 'vitest'
import { peersOf, splitStack, stackOf, statusText } from './status'

const base = { status: 'synced', end: null, offlineReason: null, pendingLocal: false, writable: true, ready: true, readonlyReason: null, attempt: 0 } as const

describe('peersOf', () => {
  it('去重同一个用户的多个标签页、去掉我自己、没有身份的不算,按名字排序', () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, { user: { id: 'usr_me', name: '我', color: '#111' } }],
      [2, { user: { id: 'usr_b', name: 'Bob', color: '#222' } }],
      [3, { user: { id: 'usr_b', name: 'Bob', color: '#222' } }],
      [4, { user: { id: 'usr_a', name: 'Alice', color: '#333' } }],
      [5, { cursor: {} }],
      [6, { user: { id: '', name: 'x' } }],
    ])
    expect(peersOf(states, 1).map((peer) => peer.id)).toEqual(['usr_a', 'usr_b'])
  })
  it('名字缺了显示「协作者」,不露内部编号', () => {
    const peers = peersOf(new Map([[2, { user: { id: 'usr_x' } }]]), 1)
    expect(peers[0]!.name).toBe('协作者')
  })
})

describe('stackOf(头像堆:我排第一)', () => {
  const alice = { id: 'usr_a', name: 'Alice', color: '#333' }
  const bob = { id: 'usr_b', name: 'Bob', color: '#222' }
  const me = { id: 'usr_me', name: '我自己', color: '#111' }
  it('我排第一并标记 me,别人按原顺序跟在后面', () => {
    const stack = stackOf([alice, bob], me)
    expect(stack.map((p) => p.id)).toEqual(['usr_me', 'usr_a', 'usr_b'])
    expect(stack[0]!.me).toBe(true)
    expect(stack.slice(1).every((p) => !p.me)).toBe(true)
  })
  it('同一个账号在别的标签页开着:只算一个,不会出现两个"我"', () => {
    const stack = stackOf([{ ...me, name: '我自己(另一个标签页)' }, alice], me)
    expect(stack.map((p) => p.id)).toEqual(['usr_me', 'usr_a'])
  })
  it('还没收到自己的身份时只显示别人,不凭空造一个', () => {
    expect(stackOf([alice], null)).toEqual([alice])
  })
  it('一个人也没有(只有我)时堆里就是我一个', () => {
    expect(stackOf([], me).map((p) => p.id)).toEqual(['usr_me'])
  })
})

describe('splitStack(超出折成 +N)', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => i)
  it('不超过上限时全显示', () => {
    expect(splitStack(ids(4), 4)).toEqual({ shown: ids(4), more: 0 })
  })
  it('只多一个人时直接显示他,不出现无信息量的 +1', () => {
    expect(splitStack(ids(5), 4)).toEqual({ shown: ids(5), more: 0 })
  })
  it('多出两个及以上才折成 +N', () => {
    const result = splitStack(ids(7), 4)
    expect(result.shown).toEqual(ids(4))
    expect(result.more).toBe(3)
  })
})

describe('statusText', () => {
  it('正常 / 同步中 / 只读', () => {
    expect(statusText(base)).toBe('已同步 · 多人编辑中')
    expect(statusText({ ...base, status: 'syncing' })).toBe('正在同步…')
    expect(statusText({ ...base, status: 'syncing', ready: false })).toBe('正在准备文档…')
    expect(statusText({ ...base, writable: false })).toContain('只读')
    expect(statusText({ ...base, writable: false, readonlyReason: '文档太大' })).toBe('只读:文档太大')
  })
  it('断线:说清改动还在本地、恢复后自动合并', () => {
    expect(statusText({ ...base, status: 'offline', attempt: 2, pendingLocal: true })).toContain('第 2 次重连')
    expect(statusText({ ...base, status: 'offline', pendingLocal: true })).toContain('恢复后自动合并')
    expect(statusText({ ...base, status: 'offline' })).toContain('恢复后自动继续')
  })
  it('断线:有具体原因就用原因(握手被拒 / 网络断开),不重复交代「自动合并」', () => {
    const reason = '连不上协作服务,正在重试。你的修改先留在本页,连上后会自动合并。'
    const text = statusText({ ...base, status: 'offline', offlineReason: reason, attempt: 3, pendingLocal: true })
    expect(text).toContain('连不上协作服务')
    expect(text).toContain('第 3 次重连')
    expect(text.match(/合并/g)).toHaveLength(1)
  })
  it('被终止:直接说原因', () => {
    expect(statusText({ ...base, end: { kind: 'denied', code: 4403, message: '你对这篇文档的权限被收回了', reopenable: false } })).toBe('你对这篇文档的权限被收回了')
  })
})
