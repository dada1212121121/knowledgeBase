// 一个房间 = 一份正在协同的文件 + 它唯一的服务端副本 + 连进来的各条连接。
//
// 这里不碰网络、不碰存储:收到的字节进来,要发的字节、要持久化的增量、要落地的文件都通过 `host` 回调出去,
// 时间通过 `clock` 注入,所以能确定性地测。
//
// 性能要点:
// - 每个增量只在这里应用一次,然后原样转发给其它连接(守护进程不解 CRDT);
// - 新连接先收到服务端的状态向量(step1),它只发服务端没有的部分;它的 step1 只回它缺的那部分(step2);
// - 落地去抖:停手 `landIdleMs` 或连续编辑满 `landMaxMs` 才存盘一次;最后一个人离开时立刻落地;
// - 在线状态按连接记最后一条,新人加入时直接补发,不用等各端 20 秒一次的心跳;有人断开时替他广播「离开」。
import { parseAwareness, encodeAwarenessRemoval } from './awareness.mjs'
import {
  AWARENESS,
  QUERY_AWARENESS,
  STEP1,
  STEP2,
  SYNC,
  UPDATE,
  decode,
  encodeSync,
  stripFingerprint,
} from './ysync.mjs'

/** 默认的时间参数(毫秒)。 */
export const DEFAULTS = {
  landIdleMs: 2000,
  landMaxMs: 30000,
  /** 最后一个人离开、内容也落地了之后,多久关房间(期间有人回来就不用重新打开)。 */
  closeIdleMs: 30000,
  /** 落地失败后多久重试(翻倍,封顶 `landMaxMs`)。 */
  retryMs: 1000,
  /**
   * 持久化的增量攒到这么多条 / 这么多字节就合并成一份。进程崩溃后恢复房间要把增量逐条补回副本:
   * 实测 xlsx 2000 条要 2.7 秒,合并成一份(67 KB)只要 6 毫秒;不合并的话一整天的会话恢复要几十秒。
   */
  compactEvery: 500,
  compactBytes: 512 * 1024,
}

/** 空增量(只有头部的 2 字节):不用应用,也不用转发。 */
const isEmptyUpdate = (update) => update.length <= 2

export class Room {
  /**
   * @param {object} options
   * @param {string} options.key 房间键
   * @param {object} options.replica 服务端副本(engines.mjs 的 openReplica)
   * @param {object} options.host 回调:sendTo(conn, bytes) / broadcast(except, bytes) / persist(update, conn) /
   *   land(fileBytes) → Promise / closed() / status({ dirty, landing, conns })
   * @param {object} [options.timers] setTimeout / clearTimeout(测试注入)
   */
  constructor({ key, replica, host, timers = globalThis, options = {} }) {
    this.key = key
    this.replica = replica
    this.host = host
    this.timers = timers
    this.options = { ...DEFAULTS, ...options }
    /** conn → { writable, user, clients: Map<clientId, clock>, awareness: Uint8Array | null } */
    this.conns = new Map()
    /** 收到但还没落地的修改次数;落地时记下当时的值,落地期间又来了修改就还是脏的 */
    this.revision = 0
    this.landedRevision = 0
    this.firstUnlandedAt = null
    this.landing = null
    this.landTimer = null
    this.closeTimer = null
    this.retryDelay = this.options.retryMs
    this.closed = false
    this.stats = { updates: 0, bytesIn: 0, bytesOut: 0, lands: 0, landFailures: 0, rejected: 0, compactions: 0 }
    /** 打开时(底稿 + 还没补回的增量之前)的状态向量:合并 = 相对它的差,恢复时打开底稿再补这一份就回到现在 */
    this.baseSV = replica.stateVector()
    this.sinceCompact = { count: 0, bytes: 0 }
  }

  /** 持久化一条增量;攒够了就让守护进程把已存的增量换成一份合并后的(顺序在这条之后,不会丢中间的)。 */
  #persist(update, conn) {
    this.host.persist(update, conn)
    this.sinceCompact.count += 1
    this.sinceCompact.bytes += update.length
    if (!this.host.compact) return
    if (this.sinceCompact.count < this.options.compactEvery && this.sinceCompact.bytes < this.options.compactBytes) return
    this.host.compact(this.replica.diff(this.baseSV))
    this.sinceCompact = { count: 0, bytes: 0 }
    this.stats.compactions += 1
  }

  get dirty() {
    return this.revision !== this.landedRevision
  }

  #send(conn, bytes) {
    this.stats.bytesOut += bytes.length
    this.host.sendTo(conn, bytes)
  }

  #broadcast(except, bytes) {
    let others = 0
    for (const conn of this.conns.keys()) if (conn !== except) others++
    if (!others) return
    this.stats.bytesOut += bytes.length * others
    this.host.broadcast(except, bytes)
  }

  #status() {
    this.host.status?.({ dirty: this.dirty, landing: !!this.landing, conns: this.conns.size })
  }

  /** 一条连接加入。先给它服务端的状态向量,再补发其他人的在线状态。 */
  join(conn, { writable, user }) {
    if (this.closed) throw new Error('房间已经关了')
    this.timers.clearTimeout(this.closeTimer)
    this.closeTimer = null
    this.conns.set(conn, { writable, user, clients: new Map(), awareness: null })
    this.#send(conn, encodeSync(STEP1, this.replica.stateVector()))
    for (const [other, state] of this.conns) {
      if (other !== conn && state.awareness) this.#send(conn, state.awareness)
    }
    this.#status()
  }

  /** 改一条连接的读写权限(权限被降级 / 升级)。 */
  setWritable(conn, writable) {
    const state = this.conns.get(conn)
    if (state) state.writable = writable
  }

  /** 收到一条连接的一帧。返回这一帧里被拒绝的修改条数(只读连接)。 */
  frame(conn, bytes) {
    const state = this.conns.get(conn)
    if (!state || this.closed) return 0
    this.stats.bytesIn += bytes.length
    let messages
    try {
      messages = decode(bytes)
    } catch {
      // 坏帧整帧丢掉:不能把解不开的东西转发给别人
      this.stats.rejected += 1
      return 0
    }
    let rejected = 0
    for (const message of messages) {
      if (message.type === SYNC && message.sub === STEP1) {
        this.#send(conn, encodeSync(STEP2, this.replica.diff(stripFingerprint(message.payload))))
      } else if (message.type === SYNC && (message.sub === STEP2 || message.sub === UPDATE)) {
        if (!state.writable) {
          rejected += 1
          continue
        }
        this.#applyRemote(conn, stripFingerprint(message.payload))
      } else if (message.type === AWARENESS) {
        this.#awareness(conn, state, message.payload)
      } else if (message.type === QUERY_AWARENESS) {
        for (const [other, otherState] of this.conns) {
          if (other !== conn && otherState.awareness) this.#send(conn, otherState.awareness)
        }
      }
    }
    this.stats.rejected += rejected
    return rejected
  }

  #applyRemote(conn, update) {
    if (isEmptyUpdate(update)) return
    // 引擎拒绝的更新(结构不对、超出上限)抛错:这一条不转发,让发送方自己重新同步
    this.replica.apply(update)
    this.stats.updates += 1
    this.#broadcast(conn, encodeSync(UPDATE, update))
    this.#persist(update, conn)
    this.#touched()
  }

  /**
   * 守护进程重启 / 进程被回收后,把持久化的增量补回副本之后调这一步。
   *
   * 为什么不能复用 [`Self.applyLocal`]:那份增量早就持久化过了,再走一遍会重复写库、
   * 重复广播给连接(此时还没有人加入)。这里只要把「副本里已经有没落地的内容」这件事
   * 记下来 —— 也就是标脏并安排落地。漏了这一步的后果是静默的:文件永远停在底稿,
   * 用户看到内容还在(内存里的副本是对的),可磁盘上没有,直到他再改一次触发落地。
   */
  recover() {
    this.#touched()
  }

  /** 服务端自己改了副本(AI 的修改):把增量发给所有人、持久化、安排落地。 */
  applyLocal(before) {
    const update = this.replica.diff(before)
    if (isEmptyUpdate(update)) return update
    this.#broadcast(null, encodeSync(UPDATE, update))
    this.#persist(update, null)
    this.#touched()
    // 没有人在线时(AI 单独改):落地完就按空闲规则关房间
    this.idle()
    return update
  }

  /** 只为 AI 打开的房间(没有人加入):按空闲规则安排关闭,免得一直占着内存。有人在线时什么都不做。 */
  idle() {
    if (!this.conns.size && !this.closed) this.#scheduleClose()
  }

  #awareness(conn, state, payload) {
    let entries
    try {
      entries = parseAwareness(payload)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.state === 'null') state.clients.delete(entry.clientId)
      else state.clients.set(entry.clientId, entry.clock)
    }
    const head = [AWARENESS]
    let length = payload.length
    while (length > 127) {
      head.push((length & 127) | 128)
      length = Math.floor(length / 128)
    }
    head.push(length)
    const message = new Uint8Array(head.length + payload.length)
    message.set(head)
    message.set(payload, head.length)
    state.awareness = state.clients.size ? message : null
    this.#broadcast(conn, message)
  }

  #touched() {
    this.revision += 1
    const now = this.timers.now ? this.timers.now() : Date.now()
    this.firstUnlandedAt ??= now
    this.timers.clearTimeout(this.landTimer)
    const sinceFirst = now - this.firstUnlandedAt
    const wait = Math.max(0, Math.min(this.options.landIdleMs, this.options.landMaxMs - sinceFirst))
    this.landTimer = this.timers.setTimeout(() => void this.land(), wait)
    this.#status()
  }

  /** 一条连接离开。替它广播「离开」;最后一个人离开就立刻落地,再等一会儿关房间。 */
  leave(conn) {
    const state = this.conns.get(conn)
    if (!state) return
    this.conns.delete(conn)
    if (state.clients.size) {
      const entries = [...state.clients].map(([clientId, clock]) => ({ clientId, clock }))
      this.#broadcast(null, encodeAwarenessRemoval(entries))
    }
    if (!this.conns.size) {
      if (this.dirty) void this.land()
      this.#scheduleClose()
    }
    this.#status()
  }

  #scheduleClose() {
    this.timers.clearTimeout(this.closeTimer)
    this.closeTimer = this.timers.setTimeout(() => {
      this.closeTimer = null
      if (this.conns.size) return
      if (this.dirty || this.landing) return this.#scheduleClose()
      this.close()
    }, this.options.closeIdleMs)
  }

  /** 把副本存成文件交给守护进程写回。同一时间只有一次落地;期间来的修改留给下一次。 */
  async land() {
    this.timers.clearTimeout(this.landTimer)
    this.landTimer = null
    if (this.landing) return this.landing
    if (!this.dirty) return true
    const revision = this.revision
    this.landing = (async () => {
      try {
        const bytes = await this.replica.save()
        await this.host.land(bytes)
        this.landedRevision = Math.max(this.landedRevision, revision)
        this.firstUnlandedAt = this.dirty ? (this.timers.now ? this.timers.now() : Date.now()) : null
        this.stats.lands += 1
        this.retryDelay = this.options.retryMs
        return true
      } catch (error) {
        this.stats.landFailures += 1
        this.host.log?.('warn', `落地失败(${this.key}):${String(error?.message ?? error)}`)
        // 失败了内容还在副本里:退避重试,不丢
        this.landTimer = this.timers.setTimeout(() => void this.land(), this.retryDelay)
        this.retryDelay = Math.min(this.retryDelay * 2, this.options.landMaxMs)
        return false
      } finally {
        this.landing = null
        this.#status()
      }
    })()
    const landed = await this.landing
    // 落地期间又有修改:按去抖规则安排下一次
    if (landed && this.dirty && !this.landTimer) {
      this.landTimer = this.timers.setTimeout(() => void this.land(), this.options.landIdleMs)
    }
    return landed
  }

  /** 关房间,释放副本。 */
  close() {
    if (this.closed) return
    this.closed = true
    this.timers.clearTimeout(this.landTimer)
    this.timers.clearTimeout(this.closeTimer)
    this.replica.dispose?.()
    this.host.closed()
  }
}
