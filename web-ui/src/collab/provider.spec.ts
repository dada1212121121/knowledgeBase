import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { FakeRoom, type RoomConn } from '../../e2e/collab-room.mjs'
import { CollabProvider, type Clock, type SocketLike } from './provider'

/** 手动推进的时钟:退避重连、心跳都由测试掌控。 */
function manualClock() {
  let now = 0
  let nextId = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++nextId
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (handle) => void timers.delete(handle as number),
  }
  return {
    clock,
    advance(ms: number) {
      const end = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        now = due[1].at
        timers.delete(due[0])
        due[1].fn()
      }
      now = end
    },
  }
}

/** 把 provider 的 WebSocket 接到假房间上。 */
class RoomSocket implements SocketLike {
  binaryType = 'arraybuffer'
  readyState = 0
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null
  conn: RoomConn | null = null

  constructor(
    private readonly room: FakeRoom,
    private readonly who: { id: string; name: string },
    private readonly writable: boolean,
    private readonly registry: RoomSocket[],
  ) {
    registry.push(this)
    queueMicrotask(() => this.open())
  }

  private open() {
    if (this.readyState === 3) return
    this.readyState = 1
    // 真实顺序是 onopen 在前、服务端消息在后;但 onopen 里客户端就要发 SyncStep1,所以先加入房间(服务端的消息先攒着),
    // 再触发 onopen,最后把攒着的消息投递出去
    const queued: Uint8Array[] = []
    let delivering = false
    const deliver = (bytes: Uint8Array) => this.onmessage?.({ data: bytes.slice().buffer })
    this.conn = this.room.join(this.who, this.writable, {
      send: (bytes) => (delivering ? deliver(bytes) : void queued.push(bytes)),
      close: (code, reason) => this.finish(code, reason),
    })
    this.onopen?.({})
    delivering = true
    for (const bytes of queued) deliver(bytes)
  }

  send(data: Uint8Array) {
    if (this.conn) this.room.receive(this.conn, data)
  }

  /** 服务端 / 网络一侧关闭 */
  finish(code: number, reason: string) {
    if (this.readyState === 3) return
    this.readyState = 3
    if (this.conn) this.room.leave(this.conn)
    this.onclose?.({ code, reason })
  }

  close(code = 1000, reason = '') {
    this.finish(code, reason)
  }
}

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

function setup(room: FakeRoom, options: { writable?: boolean; who?: { id: string; name: string } } = {}) {
  const sockets: RoomSocket[] = []
  const timers = manualClock()
  const provider = new CollabProvider({
    url: 'ws://test/collab',
    kind: room.kind,
    socket: () => new RoomSocket(room, options.who ?? { id: 'usr_a', name: 'Alice' }, options.writable ?? true, sockets),
    clock: timers.clock,
    random: () => 0.5,
    target: null,
  })
  provider.connect()
  return { provider, sockets, timers }
}

describe('CollabProvider(假房间)', () => {
  it('文本文档:连上后拿到正文、就绪;本地改动到房间,房间里的改动回到本地', async () => {
    const room = new FakeRoom({ kind: 'text', text: '第一行' })
    const { provider } = setup(room)
    await settle()
    const state = provider.getState()
    expect(state.ready).toBe(true)
    expect(state.writable).toBe(true)
    expect(provider.doc.getText('text').toString()).toBe('第一行')

    provider.doc.getText('text').insert(3, ' 本地加的')
    await settle()
    expect(room.text()).toBe('第一行 本地加的')

    room.doc.getText('text').insert(0, '远端:')
    await settle()
    expect(provider.doc.getText('text').toString()).toBe('远端:第一行 本地加的')
  })

  it('笔记第一次被协作打开:被点名初始化,放完正文调用 initDone 之后房间才就绪', async () => {
    const room = new FakeRoom({ kind: 'rich', markdown: '# 标题\n\n正文' })
    const { provider } = setup(room)
    const inits: string[] = []
    provider.on('init', (markdown) => inits.push(markdown))
    await settle()
    expect(provider.getState().ready).toBe(false)
    expect(provider.getState().initMarkdown).toBe('# 标题\n\n正文')
    // 编辑器把正文放进 Yjs 文档
    const paragraph = new Y.XmlElement('paragraph')
    paragraph.insert(0, [new Y.XmlText('正文')])
    provider.doc.getXmlFragment('prosemirror').insert(0, [paragraph])
    provider.initDone()
    await settle()
    expect(provider.getState().ready).toBe(true)
    expect(provider.getState().initMarkdown).toBeNull()
    // 之后再 initDone 不会重复发
    provider.initDone()
    expect(room.log.filter((entry) => entry.type === 'init_done')).toHaveLength(1)
  })

  it('落地者提交 Markdown:房间收到并记录;不是落地者提交不出去', async () => {
    const room = new FakeRoom({ kind: 'rich', state: true })
    const first = setup(room, { who: { id: 'usr_a', name: 'Alice' } })
    const second = setup(room, { who: { id: 'usr_b', name: 'Bob' } })
    await settle()
    expect(first.provider.getState().lander).toBe(true)
    expect(second.provider.getState().lander).toBe(false)
    expect(second.provider.land('不该被接受')).toBe(false)
    expect(first.provider.land('# 落地的正文')).toBe(true)
    await settle()
    expect(room.landed.map((entry) => entry.markdown)).toEqual(['# 落地的正文'])
  })

  it('服务端要求立刻落地(land_now)会通知上层', async () => {
    const room = new FakeRoom({ kind: 'rich', state: true })
    const { provider } = setup(room)
    let nudged = 0
    provider.on('land-now', () => (nudged += 1))
    await settle()
    room.landNow()
    expect(nudged).toBe(1)
  })

  it('断线后按退避重连,期间的本地修改在恢复后合并进房间', async () => {
    const room = new FakeRoom({ kind: 'text', text: 'abc' })
    const { provider, sockets, timers } = setup(room)
    await settle()
    sockets[0]!.finish(1006, '')
    expect(provider.getState().status).toBe('offline')
    provider.doc.getText('text').insert(3, 'XYZ')
    timers.advance(60_000)
    await settle()
    expect(sockets.length).toBeGreaterThan(1)
    expect(provider.getState().status).toBe('synced')
    expect(room.text()).toBe('abcXYZ')
  })

  it('权限被收回(4403):不再重连,说清原因', async () => {
    const room = new FakeRoom({ kind: 'text', text: 'x' })
    const { provider, sockets, timers } = setup(room)
    await settle()
    room.removeUser('usr_a')
    const state = provider.getState()
    expect(state.end?.kind).toBe('denied')
    expect(state.end?.reopenable).toBe(false)
    timers.advance(120_000)
    await settle()
    expect(sockets).toHaveLength(1)
  })

  it('文档被删(4404):终止且不重试', async () => {
    const room = new FakeRoom({ kind: 'text', text: 'x' })
    const { provider, sockets, timers } = setup(room)
    await settle()
    room.discard(4404, '文档已被删除')
    expect(provider.getState().end?.kind).toBe('deleted')
    timers.advance(120_000)
    await settle()
    expect(sockets).toHaveLength(1)
  })

  it('文档在别处被改(4409):终止但可以「重新打开」,换一份全新的文档重连', async () => {
    const room = new FakeRoom({ kind: 'text', text: '旧' })
    const { provider, sockets } = setup(room)
    await settle()
    const epoch = provider.getState().docEpoch
    room.discard(4409, '内容在别处被修改')
    expect(provider.getState().end?.kind).toBe('stale')
    expect(provider.getState().end?.reopenable).toBe(true)
    room.doc.getText('text').delete(0, 1)
    room.doc.getText('text').insert(0, '新')
    provider.reopen()
    await settle()
    expect(sockets.length).toBe(2)
    expect(provider.getState().docEpoch).toBe(epoch + 1)
    expect(provider.getState().end).toBeNull()
    expect(provider.doc.getText('text').toString()).toBe('新')
  })

  it('角色被降级:变成只读并提示;本地继续看到别人的修改', async () => {
    const room = new FakeRoom({ kind: 'text', text: 'abc' })
    const { provider, sockets } = setup(room)
    await settle()
    const notices: string[] = []
    provider.on('notice', (notice) => notices.push(notice.text))
    room.setWritable(sockets[0]!.conn!, false)
    expect(provider.getState().writable).toBe(false)
    expect(notices.some((text) => text.includes('只读'))).toBe(true)
    room.doc.getText('text').insert(0, '别人:')
    await settle()
    expect(provider.doc.getText('text').toString()).toBe('别人:abc')
  })

  it('以只读身份进来:本地改动不会发给服务端(留在本地待恢复)', async () => {
    const room = new FakeRoom({ kind: 'text', text: 'abc' })
    const { provider, sockets } = setup(room, { writable: false })
    await settle()
    expect(provider.getState().writable).toBe(false)
    // 握手之后客户端不应再发任何帧(发了会被服务端当成越权)
    const sent: Uint8Array[] = []
    const original = sockets[0]!.send.bind(sockets[0]!)
    sockets[0]!.send = (data) => {
      sent.push(data)
      original(data)
    }
    provider.doc.getText('text').insert(0, '我偷偷改')
    await settle()
    expect(sent).toHaveLength(0)
    expect(room.text()).toBe('abc')
    expect(provider.getState().pendingLocal).toBe(true)
  })

  it('身份以服务端为准:在线状态里的 user 是服务端认定的名字', async () => {
    const room = new FakeRoom({ kind: 'text', text: 'x' })
    const { provider } = setup(room, { who: { id: 'usr_z', name: '服务端认定的名字' } })
    await settle()
    const mine = provider.awareness.getLocalState() as { user?: { id: string; name: string } } | null
    expect(mine?.user?.id).toBe('usr_z')
    expect(mine?.user?.name).toBe('服务端认定的名字')
  })

  it('还在握手时销毁:不在握手阶段 close()(浏览器会报错),等连上再关', async () => {
    const room = new FakeRoom({ kind: 'text', text: 'x' })
    const { provider, sockets } = setup(room)
    // 不 settle:此刻 socket 还没 open(RoomSocket 在微任务里才 open)。把它改成「一直在连接」
    const socket = sockets[0]!
    socket.readyState = 0
    const closed: number[] = []
    const originalClose = socket.close.bind(socket)
    socket.close = (code, reason) => {
      closed.push(socket.readyState)
      originalClose(code, reason)
    }
    provider.destroy()
    expect(closed).toEqual([])
    // 连上之后才关
    socket.readyState = 1
    socket.onopen?.({})
    expect(closed).toEqual([1])
  })

  it('销毁时先通知 closing(落地者趁连接还在做最后一次提交),并关掉连接', async () => {
    const room = new FakeRoom({ kind: 'text', text: 'x' })
    const { provider, sockets } = setup(room)
    await settle()
    let closing = 0
    provider.on('closing', () => (closing += 1))
    provider.destroy()
    expect(closing).toBe(1)
    expect(sockets[0]!.readyState).toBe(3)
    expect(room.conns.size).toBe(0)
  })
})
