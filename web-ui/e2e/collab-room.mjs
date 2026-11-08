// 假的协作房间:用 Node 里的 yjs 把后端 `crates/kb-collab/src/core.rs` 的房间状态机照着写一遍,
// 给 vitest(协议客户端单测)和 Playwright 场景(假 WebSocket 服务)共用。
//
// 它**不是**后端的替身测试:它只是把后端已经确定的协议行为固定下来,让前端在没有守护进程时也能跑完整流程。
// 和 core.rs 对不上的地方以 core.rs 为准,改的时候两边对照着看(每个方法注明了对应的函数)。
// 没有网络也没有时钟:连接是 `{ send(bytes), close(code, reason) }` 这样的端点,时间靠调用方推进。
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'

const MSG_SYNC = 0
const MSG_AWARENESS = 1
const MSG_AUTH = 2
const MSG_QUERY_AWARENESS = 3
const CTRL_SERVER = 100
const CTRL_CLIENT = 101

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

// 与 types.rs 的 Participant::color 同一张表、同一个 FNV-1a,同一个人在后端和这里颜色一致
const PALETTE = ['#e03131', '#c2255c', '#9c36b5', '#6741d9', '#3b5bdb', '#1971c2', '#0c8599', '#099268', '#2f9e44', '#e67700', '#d9480f', '#5c940d']
export function colorOf(id) {
  let hash = 0x811c9dc5
  for (const byte of textEncoder.encode(id)) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return PALETTE[hash % PALETTE.length]
}

function frame(write) {
  const encoder = encoding.createEncoder()
  write(encoder)
  return encoding.toUint8Array(encoder)
}

function ctrlFrame(ctrl) {
  return frame((encoder) => {
    encoding.writeVarUint(encoder, CTRL_SERVER)
    encoding.writeVarUint8Array(encoder, textEncoder.encode(JSON.stringify(ctrl)))
  })
}

function fromBase64(text) {
  return Uint8Array.from(Buffer.from(text, 'base64'))
}

export class FakeRoom {
  /**
   * @param {{ kind: 'text'|'rich', text?: string, markdown?: string, onLand?: (landing: {markdown: string, sv: Uint8Array}) => void, initTimeoutRejects?: boolean }} options
   *   text:文本文档的初始正文(服务端自己放进 Y.Text);markdown:笔记需要初始化时发给初始化者的正文
   */
  constructor(options) {
    this.kind = options.kind
    this.doc = new Y.Doc()
    this.conns = new Map()
    this.nextConn = 1
    this.nextJoin = 0
    this.lander = null
    this.readonlyReason = null
    this.landed = [] // 已接受的落地提交 { markdown, sv(base64) }
    this.rejected = [] // 被拒绝的落地提交 { conn, reason }
    this.onLand = options.onLand ?? null
    this.lastLandedSv = null
    this.dirty = false
    this.log = [] // 收到的客户端控制消息,测试用
    this.updatesAccepted = 0
    this.updatesDropped = 0
    if (options.kind === 'text') {
      this.init = 'done'
      if (options.text) this.doc.getText('text').insert(0, options.text)
    } else {
      this.init = options.state ? 'done' : 'needed'
      this.initMarkdown = options.markdown ?? ''
    }
    // 所有并入文档的更新(包括发起者自己)都广播给全部连接,与 drain_captured 一致
    this.doc.on('update', (update) => {
      const message = frame((encoder) => {
        encoding.writeVarUint(encoder, MSG_SYNC)
        syncProtocol.writeUpdate(encoder, update)
      })
      for (const conn of this.conns.values()) conn.endpoint.send(message)
    })
  }

  // ---------------------------------------------------------------- 连接(RoomCore::join / leave)

  /**
   * 加入一条连接。`who` = { id, name };返回连接对象。房间满了返回 null(真实服务端会以 1013 关闭)。
   * @param {{ id: string, name: string }} who
   * @param {boolean} writable
   * @param {{ send: (bytes: Uint8Array) => void, close: (code: number, reason: string) => void }} endpoint
   */
  join(who, writable, endpoint) {
    const id = this.nextConn++
    writable = writable && !this.readonlyReason
    const conn = { id, who, writable, endpoint, joined: this.nextJoin++, awarenessId: null, awarenessClock: 0, presence: null }
    this.conns.set(id, conn)
    let init = null
    if (this.kind === 'rich' && this.init === 'needed' && writable) {
      this.init = { pending: id }
      init = this.initMarkdown
    }
    this.#ctrl(conn, {
      type: 'hello',
      you: { id: who.id, name: who.name, color: colorOf(who.id) },
      writable,
      kind: this.kind,
      ready: this.init === 'done',
      init,
      lander: false,
      readonly_reason: this.readonlyReason,
    })
    conn.endpoint.send(
      frame((encoder) => {
        encoding.writeVarUint(encoder, MSG_SYNC)
        syncProtocol.writeSyncStep1(encoder, this.doc)
      }),
    )
    const others = this.#presence(id)
    if (others) conn.endpoint.send(others)
    this.#electLander()
    return conn
  }

  /** 连接断开(RoomCore::leave) */
  leave(conn) {
    if (!this.conns.delete(conn.id)) return
    if (conn.awarenessId !== null && conn.presence) {
      this.#broadcastAwareness(null, conn.awarenessId, conn.awarenessClock + 1, 'null')
    }
    if (typeof this.init === 'object' && this.init.pending === conn.id) {
      if (this.doc.store.clients.size > 0) this.#finishInit()
      else {
        this.init = 'needed'
        this.#assignInitializer()
      }
    }
    this.#electLander()
  }

  /** 踢掉一条连接(RoomCore::kick):先发关闭码,再摘掉 */
  kick(conn, code, reason) {
    if (!this.conns.has(conn.id)) return
    conn.endpoint.close(code, reason)
    this.leave(conn)
  }

  /** 某个人被收回权限(RoomCore::remove_user) */
  removeUser(userId, reason = '你已经没有这篇文档的权限') {
    for (const conn of [...this.conns.values()]) if (conn.who.id === userId) this.kick(conn, 4403, reason)
  }

  /** 房间作废、文档被删(Hub::discard_where) */
  discard(code = 4404, reason = '文档已被删除') {
    for (const conn of [...this.conns.values()]) this.kick(conn, code, reason)
  }

  /** 权限变更(RoomCore::set_conn_writable) */
  setWritable(conn, writable) {
    writable = writable && !this.readonlyReason
    if (conn.writable === writable) return
    conn.writable = writable
    this.#ctrl(conn, { type: 'role', writable })
    if (!writable && typeof this.init === 'object' && this.init.pending === conn.id) this.init = 'needed'
    this.#assignInitializer()
    this.#electLander()
  }

  /** 房间被锁成只读(文档太大):所有人降级并收到 rejected */
  lockReadonly(reason = '文档太大,已锁定为只读') {
    this.readonlyReason = reason
    for (const conn of this.conns.values()) {
      conn.writable = false
      this.#ctrl(conn, { type: 'role', writable: false })
      this.#ctrl(conn, { type: 'rejected', reason })
    }
    this.#electLander()
  }

  /** 要求落地者马上提交(RoomCore::nudge_lander) */
  landNow() {
    const lander = this.lander && this.conns.get(this.lander)
    if (!lander) return false
    this.#ctrl(lander, { type: 'land_now' })
    return true
  }

  /** 直接发一条服务端控制消息(测试里模拟 closing 之类) */
  sendCtrl(conn, ctrl) {
    this.#ctrl(conn, ctrl)
  }

  // ---------------------------------------------------------------- 入站(RoomCore::on_binary)

  /** 处理一条连接发来的一帧 */
  receive(conn, bytes) {
    if (!this.conns.has(conn.id)) return
    const decoder = decoding.createDecoder(bytes)
    while (decoding.hasContent(decoder)) {
      const type = decoding.readVarUint(decoder)
      if (type === MSG_SYNC) {
        const step = decoding.readVarUint(decoder)
        if (step === syncProtocol.messageYjsSyncStep1) {
          const sv = decoding.readVarUint8Array(decoder)
          conn.endpoint.send(
            frame((encoder) => {
              encoding.writeVarUint(encoder, MSG_SYNC)
              syncProtocol.writeSyncStep2(encoder, this.doc, sv)
            }),
          )
        } else {
          const update = decoding.readVarUint8Array(decoder)
          // 查看者(或被降级的人)的修改直接丢弃(apply_client_update)
          if (!conn.writable || this.readonlyReason) {
            this.updatesDropped++
            continue
          }
          this.updatesAccepted++
          Y.applyUpdate(this.doc, update, conn.id)
          this.dirty = true
        }
      } else if (type === MSG_AWARENESS) {
        this.#onAwareness(conn, decoding.readVarUint8Array(decoder))
      } else if (type === MSG_QUERY_AWARENESS) {
        const presence = this.#presence(null)
        if (presence) conn.endpoint.send(presence)
      } else if (type === MSG_AUTH) {
        if (decoding.readVarUint(decoder) === 0) decoding.readVarString(decoder)
      } else if (type === CTRL_CLIENT) {
        this.#onCtrl(conn, JSON.parse(textDecoder.decode(decoding.readVarUint8Array(decoder))))
      } else {
        return
      }
    }
  }

  #onCtrl(conn, ctrl) {
    this.log.push({ conn: conn.id, ...ctrl })
    if (ctrl.type === 'init_done') {
      if (typeof this.init === 'object' && this.init.pending === conn.id && conn.writable) this.#finishInit()
    } else if (ctrl.type === 'land') {
      this.#onLand(conn, ctrl)
    }
  }

  /** 落地提交(check_land + Request::Land) */
  #onLand(conn, ctrl) {
    const reject = (reason) => {
      this.rejected.push({ conn: conn.id, reason })
      this.#ctrl(conn, { type: 'rejected', reason })
    }
    if (this.kind !== 'rich') return reject('这种文档由服务端自己保存')
    if (this.lander !== conn.id) return reject('你现在不是落地者')
    let client
    try {
      client = Y.decodeStateVector(fromBase64(ctrl.sv))
    } catch {
      return reject('提交的状态不合法')
    }
    const server = Y.decodeStateVector(Y.encodeStateVector(this.doc))
    // 客户端不可能比服务端还新;落后于已落地的版本也不收
    if (!covers(server, client)) return reject('提交的状态不合法')
    if (this.lastLandedSv && !covers(client, this.lastLandedSv)) return reject('提交的状态落后于已保存的版本')
    if (this.onLand) {
      try {
        this.onLand({ markdown: ctrl.markdown, sv: fromBase64(ctrl.sv) })
      } catch (error) {
        return reject(`保存失败:${error instanceof Error ? error.message : error}`)
      }
    }
    this.lastLandedSv = client
    this.landed.push({ markdown: ctrl.markdown, sv: ctrl.sv })
    // record_landed:服务端比提交的状态更新时仍然算「有未落地内容」
    this.dirty = !(covers(client, server) && covers(server, client))
    this.#ctrl(conn, { type: 'saved', savepoint: false })
  }

  // ---------------------------------------------------------------- 在线状态(RoomCore::on_awareness)

  #onAwareness(conn, update) {
    const decoder = decoding.createDecoder(update)
    const len = decoding.readVarUint(decoder)
    for (let i = 0; i < len; i++) {
      const clientId = decoding.readVarUint(decoder)
      const clock = decoding.readVarUint(decoder)
      const json = decoding.readVarString(decoder)
      // 一条连接只能认领一个 client id,别的(伪造别人的光标)一概忽略
      if (conn.awarenessId === null) conn.awarenessId = clientId
      else if (conn.awarenessId !== clientId) continue
      if (json.length > 2048) continue
      if (clock < conn.awarenessClock && conn.presence) continue
      let rewritten
      if (json === 'null') rewritten = 'null'
      else {
        let parsed
        try {
          parsed = JSON.parse(json)
        } catch {
          continue
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
        // 身份由服务端改写:客户端自称的名字和颜色不采信
        parsed.user = { id: conn.who.id, name: conn.who.name, color: colorOf(conn.who.id) }
        rewritten = JSON.stringify(parsed)
      }
      conn.awarenessClock = clock
      conn.presence = rewritten === 'null' ? null : rewritten
      this.#broadcastAwareness(conn.id, clientId, clock, rewritten)
    }
  }

  #awarenessFrame(entries) {
    return frame((encoder) => {
      encoding.writeVarUint(encoder, MSG_AWARENESS)
      const inner = encoding.createEncoder()
      encoding.writeVarUint(inner, entries.length)
      for (const entry of entries) {
        encoding.writeVarUint(inner, entry.clientId)
        encoding.writeVarUint(inner, entry.clock)
        encoding.writeVarString(inner, entry.json)
      }
      encoding.writeVarUint8Array(encoder, encoding.toUint8Array(inner))
    })
  }

  #broadcastAwareness(except, clientId, clock, json) {
    const message = this.#awarenessFrame([{ clientId, clock, json }])
    for (const conn of this.conns.values()) if (conn.id !== except) conn.endpoint.send(message)
  }

  #presence(except) {
    const entries = []
    for (const conn of this.conns.values()) {
      if (conn.id === except || conn.awarenessId === null || !conn.presence) continue
      entries.push({ clientId: conn.awarenessId, clock: conn.awarenessClock, json: conn.presence })
    }
    return entries.length ? this.#awarenessFrame(entries) : null
  }

  // ---------------------------------------------------------------- 初始化与落地者

  #assignInitializer() {
    if (this.init !== 'needed') return
    const next = [...this.conns.values()].filter((conn) => conn.writable).sort((a, b) => a.joined - b.joined)[0]
    if (!next) return
    this.init = { pending: next.id }
    // 已经发过 hello 的连接再补发一次初始化指令:同样的 hello 结构(core.rs assign_initializer)
    this.#ctrl(next, {
      type: 'hello',
      you: { id: next.who.id, name: next.who.name, color: colorOf(next.who.id) },
      writable: true,
      kind: this.kind,
      ready: false,
      init: this.initMarkdown,
      lander: false,
      readonly_reason: this.readonlyReason,
    })
  }

  #finishInit() {
    this.init = 'done'
    this.initMarkdown = null
    this.lastLandedSv = Y.decodeStateVector(Y.encodeStateVector(this.doc))
    this.dirty = false
    for (const conn of this.conns.values()) this.#ctrl(conn, { type: 'ready' })
    this.#electLander()
  }

  #electLander() {
    const next =
      this.kind === 'rich' && this.init === 'done'
        ? ([...this.conns.values()].filter((conn) => conn.writable).sort((a, b) => a.joined - b.joined)[0]?.id ?? null)
        : null
    if (next === this.lander) return
    const previous = this.lander
    this.lander = next
    if (previous && this.conns.has(previous)) this.#ctrl(this.conns.get(previous), { type: 'lander', you: false })
    if (next) {
      this.#ctrl(this.conns.get(next), { type: 'lander', you: true })
      if (this.dirty) this.#ctrl(this.conns.get(next), { type: 'land_now' })
    }
  }

  #ctrl(conn, ctrl) {
    conn.endpoint.send(ctrlFrame(ctrl))
  }

  // ---------------------------------------------------------------- 检查用

  /** 文本文档的正文 */
  text() {
    return this.doc.getText('text').toString()
  }

  /** 笔记节点树的字符串形式(和 Rust 测试客户端的 rich_text 一样) */
  richText() {
    return this.doc.getXmlFragment('prosemirror').toString()
  }
}

/** a 的每一项都不小于 b(状态向量的偏序:a ≥ b) */
function covers(a, b) {
  for (const [client, clock] of b) if ((a.get(client) ?? 0) < clock) return false
  return true
}

export { Y }
