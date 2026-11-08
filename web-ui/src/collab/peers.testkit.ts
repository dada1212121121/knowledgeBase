// 多端协作测试夹具(只给 *.spec.ts 用,文件名不匹配 spec 所以不会被当成测试跑)。
// 把若干个 CollabProvider 接到同一个假房间上,并且能把某个端「挂起」:
// 挂起期间它发出的帧、它该收到的帧都先攒着,放行后才一起走。
// 这样两个端都停留在同一个版本上各改各的,放行后才互相看到,造出的是真正的并发编辑——
// 假房间是同步转发的,不挂起的话每次修改都已经被对方看到了,测的只是「依次编辑」。
import { FakeRoom, type RoomConn } from '../../e2e/collab-room.mjs'
import { CollabProvider, type Clock, type SocketLike } from './provider'

/** 手动推进的时钟:退避重连、心跳都由测试掌控。 */
export function manualClock() {
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

export const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

/** 接到假房间的 WebSocket,可以挂起 / 放行。 */
export class HeldSocket implements SocketLike {
  binaryType = 'arraybuffer'
  readyState = 0
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null
  conn: RoomConn | null = null
  held = false
  private outbox: Uint8Array[] = []
  private inbox: Uint8Array[] = []

  constructor(
    private readonly room: FakeRoom,
    private readonly who: { id: string; name: string },
    /** 每次建连接时现取:真实服务端按权限表决定,降权之后的重连不能又变回可写 */
    private readonly writable: () => boolean,
    registry: HeldSocket[],
  ) {
    registry.push(this)
    queueMicrotask(() => this.open())
  }

  private open() {
    if (this.readyState === 3) return
    this.readyState = 1
    const queued: Uint8Array[] = []
    let delivering = false
    this.conn = this.room.join(this.who, this.writable(), {
      send: (bytes) => (delivering ? this.deliver(bytes) : void queued.push(bytes)),
      close: (code, reason) => this.finish(code, reason),
    })
    this.onopen?.({})
    delivering = true
    for (const bytes of queued) this.deliver(bytes)
  }

  private deliver(bytes: Uint8Array) {
    if (this.held) this.inbox.push(bytes)
    else if (this.readyState === 1) this.onmessage?.({ data: bytes.slice().buffer })
  }

  private forward(bytes: Uint8Array) {
    if (this.conn && this.readyState === 1) this.room.receive(this.conn, bytes)
  }

  send(data: Uint8Array) {
    if (this.held) this.outbox.push(data)
    else this.forward(data)
  }

  /** 挂起:此刻起它发出的和它收到的都先攒着(像网络卡住了,但连接没断) */
  hold() {
    this.held = true
  }

  /** 放行。先发后收还是先收后发,收敛结果都必须一样,测试两个顺序 */
  release(order: 'out-first' | 'in-first' = 'out-first') {
    this.held = false
    const out = () => this.outbox.splice(0).forEach((bytes) => this.forward(bytes))
    const inn = () => this.inbox.splice(0).forEach((bytes) => this.deliver(bytes))
    if (order === 'out-first') {
      out()
      inn()
    } else {
      inn()
      out()
    }
  }

  /** 服务端 / 网络一侧关闭 */
  finish(code: number, reason: string) {
    if (this.readyState === 3) return
    this.readyState = 3
    this.outbox.length = 0
    this.inbox.length = 0
    if (this.conn) this.room.leave(this.conn)
    this.onclose?.({ code, reason })
  }

  close(code = 1000, reason = '') {
    this.finish(code, reason)
  }
}

export interface Peer {
  provider: CollabProvider
  sockets: HeldSocket[]
  timers: ReturnType<typeof manualClock>
  who: { id: string; name: string }
  /** 当前这条连接 */
  socket(): HeldSocket
  /** 文本文档的正文 */
  text(): string
  /** 改这个人的权限:现在这条连接立刻生效(服务端推 role),之后的重连也按新权限进房间 */
  setRole(writable: boolean): void
}

export function joinPeer(room: FakeRoom, who: { id: string; name: string }, writable = true): Peer {
  const sockets: HeldSocket[] = []
  const timers = manualClock()
  let canWrite = writable
  const provider = new CollabProvider({
    url: 'ws://test/collab',
    kind: room.kind,
    socket: () => new HeldSocket(room, who, () => canWrite, sockets),
    clock: timers.clock,
    random: () => 0.5,
    target: null,
  })
  provider.connect()
  const peer: Peer = {
    provider,
    sockets,
    timers,
    who,
    socket: () => sockets[sockets.length - 1]!,
    text: () => provider.doc.getText('text').toString(),
    setRole: (next) => {
      canWrite = next
      const conn = peer.socket().conn
      if (conn) room.setWritable(conn, next)
    },
  }
  return peer
}

/** 每个测试结束时销毁所有端,免得心跳计时器泄漏到下一个测试 */
export function disposeAll(peers: Peer[]) {
  for (const peer of peers) peer.provider.destroy()
  peers.length = 0
}
