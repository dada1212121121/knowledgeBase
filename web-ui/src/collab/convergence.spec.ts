// 多人并发编辑的收敛性:几个端对着同一个假房间同时改,最后所有端和房间必须一模一样,而且谁的修改都不能无声地丢。
// 夹具见 peers.testkit.ts:端可以「挂起」,挂起期间双方停在同一个版本上各改各的,放行后才互相看到,造出的是真并发。
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { FakeRoom } from '../../e2e/collab-room.mjs'
import { disposeAll, joinPeer, settle, type Peer } from './peers.testkit'
import { peersOf } from './status'

const alive: Peer[] = []
afterEach(() => disposeAll(alive))

async function join(room: FakeRoom, id: string, name = id, writable = true) {
  const peer = joinPeer(room, { id, name }, writable)
  alive.push(peer)
  await settle()
  return peer
}

/** 所有端和房间的正文必须完全一致 */
function expectConverged(room: FakeRoom, ...peers: Peer[]) {
  for (const peer of peers) expect(peer.text(), peer.who.id).toBe(room.text())
}

describe('同时输入', () => {
  it.each(['out-first', 'in-first'] as const)('两个人在同一个位置同时打字(放行顺序 %s):都收敛,两边打的字都在', async (order) => {
    const room = new FakeRoom({ kind: 'text', text: '前|后' })
    const a = await join(room, 'usr_a', 'Alice')
    const b = await join(room, 'usr_b', 'Bob')
    a.socket().hold()
    b.socket().hold()
    a.provider.doc.getText('text').insert(1, 'AAA')
    b.provider.doc.getText('text').insert(1, 'BBB')
    // 此刻谁也没看到对方的
    expect(a.text()).toBe('前AAA|后')
    expect(b.text()).toBe('前BBB|后')
    a.socket().release(order)
    b.socket().release(order)
    await settle()
    expectConverged(room, a, b)
    expect(room.text()).toContain('AAA')
    expect(room.text()).toContain('BBB')
    expect(room.text()).toHaveLength('前|后'.length + 6)
    // 两个字串各自保持完整,不会被对方的字插进中间
    expect(room.text().replace('AAA', '').replace('BBB', '')).toBe('前|后')
  })

  it('一个人删掉一段,另一个人同时在这段中间打字:收敛,打的字还在(Yjs 的插入不会因为别人删了周围而消失)', async () => {
    const room = new FakeRoom({ kind: 'text', text: '头[要删的一段]尾' })
    const a = await join(room, 'usr_a')
    const b = await join(room, 'usr_b')
    a.socket().hold()
    b.socket().hold()
    a.provider.doc.getText('text').delete(1, 7)
    b.provider.doc.getText('text').insert(4, '新增')
    a.socket().release()
    b.socket().release()
    await settle()
    expectConverged(room, a, b)
    expect(room.text()).toContain('新增')
    expect(room.text().startsWith('头')).toBe(true)
    expect(room.text().endsWith('尾')).toBe(true)
  })
})

describe('离线修改在恢复后合并', () => {
  it.each([
    ['A 先恢复', 0],
    ['B 先恢复', 1],
  ] as const)('两个人都离线各改各的,%s:都收敛,两人的修改和底稿都在,待同步标记清掉', async (_label, first) => {
    const room = new FakeRoom({ kind: 'text', text: '底稿' })
    const a = await join(room, 'usr_a')
    const b = await join(room, 'usr_b')
    a.socket().finish(1006, '')
    b.socket().finish(1006, '')
    a.provider.doc.getText('text').insert(0, 'A离线:')
    b.provider.doc.getText('text').insert(2, ':B离线')
    expect(a.provider.getState().pendingLocal).toBe(true)
    expect(b.provider.getState().pendingLocal).toBe(true)
    for (const peer of first === 0 ? [a, b] : [b, a]) {
      peer.timers.advance(60_000)
      await settle()
    }
    expectConverged(room, a, b)
    expect(room.text()).toContain('A离线:')
    expect(room.text()).toContain(':B离线')
    expect(room.text()).toContain('底稿')
    expect(a.provider.getState().pendingLocal).toBe(false)
    expect(b.provider.getState().pendingLocal).toBe(false)
  })

  it('B 离线期间 A 一直在改:B 回来后两边的修改都在,A 的文字不会被 B 的旧版本盖掉', async () => {
    const room = new FakeRoom({ kind: 'text', text: '一二三' })
    const a = await join(room, 'usr_a')
    const b = await join(room, 'usr_b')
    b.socket().finish(1006, '')
    a.provider.doc.getText('text').insert(3, '四五六')
    a.provider.doc.getText('text').delete(0, 1)
    b.provider.doc.getText('text').insert(0, 'B:')
    b.timers.advance(60_000)
    await settle()
    expectConverged(room, a, b)
    expect(room.text()).toContain('B:')
    expect(room.text()).toContain('四五六')
    expect(room.text()).not.toContain('一')
  })
})

describe('权限变化', () => {
  it('刚改完就被降成只读:这笔修改没进房间(服务端丢弃),本地换成最新内容并提示;别人不受影响', async () => {
    const room = new FakeRoom({ kind: 'text', text: 'abc' })
    const a = await join(room, 'usr_a')
    const b = await join(room, 'usr_b')
    const notices: string[] = []
    b.provider.on('notice', (notice) => notices.push(notice.text))
    // 手动时钟从 0 起,而 provider 用「最近一次本地修改的时刻 > 0」判断刚改过;真实时钟不会是 0,这里先走一步
    b.timers.advance(1000)
    // 降权消息在路上(被挂起),而 B 在这期间还改了一笔:真实网络里正是这种先后
    b.socket().hold()
    b.provider.doc.getText('text').insert(3, '丢')
    b.setRole(false)
    b.socket().release()
    await settle()
    expect(room.updatesDropped).toBeGreaterThan(0)
    expect(room.text()).toBe('abc')
    expect(notices.some((text) => text.includes('只读') && text.includes('没有保存'))).toBe(true)
    expect(b.provider.getState().writable).toBe(false)
    expect(b.provider.getState().docEpoch).toBe(1)
    // A 照常编辑,B 仍然实时看到
    a.provider.doc.getText('text').insert(0, 'A:')
    await settle()
    expectConverged(room, a, b)
    expect(b.text()).toBe('A:abc')
  })

  it('降权时没有未同步的修改:不换文档,只提示,继续实时看到别人的修改', async () => {
    const room = new FakeRoom({ kind: 'text', text: 'abc' })
    const a = await join(room, 'usr_a')
    const b = await join(room, 'usr_b')
    b.timers.advance(60_000)
    b.setRole(false)
    await settle()
    expect(b.provider.getState().docEpoch).toBe(0)
    a.provider.doc.getText('text').insert(3, 'd')
    await settle()
    expectConverged(room, a, b)
  })

  it('只读升成可写:之后的修改发得出去,所有人收敛', async () => {
    const room = new FakeRoom({ kind: 'text', text: 'abc' })
    const a = await join(room, 'usr_a')
    const b = await join(room, 'usr_b', 'Bob', false)
    expect(b.provider.getState().writable).toBe(false)
    b.setRole(true)
    await settle()
    expect(b.provider.getState().writable).toBe(true)
    b.provider.doc.getText('text').insert(0, 'B:')
    await settle()
    expectConverged(room, a, b)
    expect(room.text()).toBe('B:abc')
  })
})

describe('房间被替换', () => {
  it('两个人同时被踢出(内容在别处被改):重新打开后都换到同一份新文档,docEpoch 各加一', async () => {
    const room = new FakeRoom({ kind: 'text', text: '旧' })
    const a = await join(room, 'usr_a')
    const b = await join(room, 'usr_b')
    room.discard(4409, '内容在别处被修改')
    room.doc.getText('text').delete(0, 1)
    room.doc.getText('text').insert(0, '新')
    a.provider.reopen()
    b.provider.reopen()
    await settle()
    expectConverged(room, a, b)
    expect(a.text()).toBe('新')
    expect(a.provider.getState().docEpoch).toBe(1)
    expect(b.provider.getState().docEpoch).toBe(1)
    // 换文档之后两个人还能继续互相看到
    a.provider.doc.getText('text').insert(1, '!')
    await settle()
    expectConverged(room, a, b)
    expect(b.text()).toBe('新!')
  })
})

/** 固定种子的伪随机,失败时能原样复现 */
function lcg(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

describe('三个人交错编辑', () => {
  it.each([1, 7, 42, 2024, 31337])('随机插入 / 删除 / 挂起 / 放行,种子 %i:最后三个端和房间完全一致', async (seed) => {
    const random = lcg(seed)
    const room = new FakeRoom({ kind: 'text', text: '0123456789' })
    const peers = [await join(room, 'usr_a'), await join(room, 'usr_b'), await join(room, 'usr_c')]
    for (let round = 0; round < 60; round += 1) {
      const peer = peers[Math.floor(random() * peers.length)]!
      const text = peer.provider.doc.getText('text')
      const roll = random()
      if (roll < 0.15) peer.socket().hold()
      else if (roll < 0.3) peer.socket().release(random() < 0.5 ? 'out-first' : 'in-first')
      else if (roll < 0.75 || text.length === 0) text.insert(Math.floor(random() * (text.length + 1)), String.fromCharCode(97 + Math.floor(random() * 26)))
      else text.delete(Math.floor(random() * text.length), 1)
      if (random() < 0.3) await settle()
    }
    for (const peer of peers) peer.socket().release()
    await settle()
    expectConverged(room, ...peers)
    // 状态向量也要一致:不只是文字相同,所有端确实收到了同样的全部更新
    const sv = (doc: Y.Doc) => JSON.stringify([...Y.decodeStateVector(Y.encodeStateVector(doc)).entries()].sort())
    for (const peer of peers) expect(sv(peer.provider.doc), peer.who.id).toBe(sv(room.doc))
  })
})

describe('在线状态(光标)', () => {
  it('我动光标别人能看到(身份是服务端认定的);我断开后别人那边立刻清掉', async () => {
    const room = new FakeRoom({ kind: 'text', text: 'x' })
    const a = await join(room, 'usr_a', 'Alice')
    const b = await join(room, 'usr_b', 'Bob')
    a.provider.awareness.setLocalStateField('cursor', { anchor: 1, head: 3 })
    a.timers.advance(500)
    await settle()
    const seen = b.provider.awareness.getStates().get(a.provider.doc.clientID) as { cursor?: unknown; user?: { id: string; name: string; color: string } } | undefined
    expect(seen?.cursor).toEqual({ anchor: 1, head: 3 })
    expect(seen?.user).toMatchObject({ id: 'usr_a', name: 'Alice' })
    a.socket().finish(1006, '')
    await settle()
    expect(b.provider.awareness.getStates().has(a.provider.doc.clientID)).toBe(false)
    expect(peersOf(b.provider.awareness.getStates(), b.provider.doc.clientID)).toHaveLength(0)
  })

  it('点头像跳转(revealPeer):对方有光标就发 reveal 带上位置;没有光标、是我自己、不在房间里都返回 false 且不发', async () => {
    const room = new FakeRoom({ kind: 'text', text: 'hello' })
    const a = await join(room, 'usr_a', 'Alice')
    const b = await join(room, 'usr_b', 'Bob')
    const revealed: { userId: string; head: unknown }[] = []
    b.provider.on('reveal', (payload) => revealed.push(payload))
    // A 还没把光标放进正文
    expect(b.provider.revealPeer('usr_a')).toBe(false)
    a.provider.awareness.setLocalStateField('cursor', { anchor: { type: 1 }, head: { type: 2 } })
    a.timers.advance(500)
    await settle()
    expect(b.provider.revealPeer('usr_a')).toBe(true)
    expect(revealed).toEqual([{ userId: 'usr_a', head: { type: 2 } }])
    // 自己、不存在的人
    b.provider.awareness.setLocalStateField('cursor', { anchor: {}, head: {} })
    expect(b.provider.revealPeer('usr_b')).toBe(false)
    expect(b.provider.revealPeer('usr_nobody')).toBe(false)
    expect(revealed).toHaveLength(1)
  })

  it('同一个人开了两个标签页:关掉一个,头像还在;两个都关了才消失', async () => {
    const room = new FakeRoom({ kind: 'text', text: 'x' })
    const watcher = await join(room, 'usr_w', 'Watcher')
    const tab1 = await join(room, 'usr_a', 'Alice')
    const tab2 = await join(room, 'usr_a', 'Alice')
    for (const tab of [tab1, tab2]) {
      tab.provider.awareness.setLocalStateField('cursor', { anchor: 0, head: 0 })
      tab.timers.advance(500)
    }
    await settle()
    const peers = () => peersOf(watcher.provider.awareness.getStates(), watcher.provider.doc.clientID).map((peer) => peer.id)
    expect(peers()).toEqual(['usr_a'])
    tab1.socket().finish(1006, '')
    await settle()
    expect(peers()).toEqual(['usr_a'])
    tab2.socket().finish(1006, '')
    await settle()
    expect(peers()).toEqual([])
  })
})
