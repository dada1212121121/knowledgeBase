// 多人在线编辑的客户端 provider(纯 TypeScript,不依赖 Vue / 编辑器,可用假 WebSocket 单测)。
//
// 行为与 `crates/kb-cli/tests/support/mod.rs` 里的 `CollabClient` 一致,并补上浏览器里必须有的部分:
//   连上就发 SyncStep1 和自己的在线状态;处理 hello(身份 / 能不能写 / 要不要初始化)、ready、role、lander;
//   本地修改实时发给服务端,服务端发来的并入本地文档;断线自动重连(指数退避),恢复后靠 Yjs 自动合并离线修改。
//
// 三条要紧的规矩(都是后端协议决定的):
//   1. 身份以服务端 hello / 在线状态里的 `user` 为准(服务端会改写),这里从不把自己报的名字当真;
//   2. 房间被作废重开(4409,或重连时 hello 说"还没就绪"但本地已有内容)后,本地那份 Yjs 历史和新房间毫无关系,
//      合并进去内容会重复:必须丢掉本地文档、换一份全新的再连;
//   3. 被降级成只读时,服务端会静默丢弃之后的修改,本地文档因此可能比服务端多出东西:近期有过本地修改就换新文档。
import * as encoding from 'lib0/encoding'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import { backoffDelay, classifyClose, type CloseInfo, type CloseKind } from './closeCodes'
import {
  MSG_AWARENESS,
  MSG_QUERY_AWARENESS,
  MSG_SYNC,
  RICH_ROOT,
  TEXT_ROOT,
  base64Encode,
  encodeClientCtrl,
  parseKind,
  readFrame,
  type ClientCtrl,
  type DocKind,
  type Identity,
  type ServerCtrl,
} from './protocol'

export type CollabStatus = 'connecting' | 'syncing' | 'synced' | 'offline' | 'closed'

/** 连接被终止后的结论:不再自动重连 */
export interface CollabEnd {
  kind: 'denied' | 'deleted' | 'stale' | 'failed'
  code: number
  message: string
  /** 能不能用「重新打开」(换一份新文档重连)恢复 */
  reopenable: boolean
}

/** 握手失败(浏览器看不到 HTTP 状态码)时,调用方用别的接口弄清原因 */
export interface Diagnosis {
  kind: 'denied' | 'deleted' | 'unauthorized' | 'retry'
  message: string
}

export interface CollabState {
  status: CollabStatus
  /** 这条连接上文档内容就绪了吗。笔记第一次被打开时要等初始化者把正文放进来;断线后回到 false */
  ready: boolean
  /** 这份文档(当前 docEpoch)有没有同步成功过。编辑器第一次绑定后就不再因为断线而拆掉 */
  everSynced: boolean
  writable: boolean
  readonlyReason: string | null
  /** 是不是落地者(笔记正文由它序列化后提交) */
  lander: boolean
  /** 服务端认定的我 */
  me: Identity | null
  end: CollabEnd | null
  /** 断线后最近一次失败的原因(给人看) */
  offlineReason: string | null
  /** 第几次重连(0 = 没在重连) */
  attempt: number
  /** 离线期间有没有改动还没发出去 */
  pendingLocal: boolean
  /** 本连接被指定为初始化者,待初始化的正文(Markdown);null = 不需要 */
  initMarkdown: string | null
  /** 文档被换成了新的第几份(编辑器据此重新绑定) */
  docEpoch: number
  /** 最近一次落地 / 保存点成功的时间 */
  savedAt: number | null
}

export interface CollabNotice {
  tone: 'info' | 'warn'
  text: string
}

interface Events {
  state: CollabState
  /** 被指定为初始化者:用这段 Markdown 把正文放进文档,然后调用 initDone */
  init: string
  /** 文档与在线状态对象被换成了全新的一份:编辑器要重新绑定 */
  'doc-replaced': undefined
  /** 文档内容有变化(本地或远端),落地调度用 */
  change: undefined
  'land-now': undefined
  saved: { savepoint: boolean }
  rejected: { reason: string }
  notice: CollabNotice
  /** 即将销毁:落地者趁连接还在做最后一次提交 */
  closing: undefined
  /** 要把视图带到某个人的光标那里(点头像跳转);位置是 Yjs 相对位置的 JSON,换算成文档位置是编辑器的事 */
  reveal: { userId: string; head: unknown }
}

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** provider 用到的 WebSocket 子集(假实现照这个写) */
export interface SocketLike {
  binaryType: string
  readyState: number
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason: string }) => void) | null
  onerror: ((event: unknown) => void) | null
  send(data: Uint8Array): void
  close(code?: number, reason?: string): void
}

export interface CollabOptions {
  /** 连接地址;每次(重)连都会重新取,链接令牌之类可以随时变 */
  url: string | (() => string)
  kind: DocKind
  socket?: (url: string) => SocketLike
  clock?: Clock
  random?: () => number
  /** online / offline 事件的来源,默认 window */
  target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null
  diagnose?: () => Promise<Diagnosis | null>
}

const CONNECTING = 0
const OPEN = 1
const HEARTBEAT_MS = 20_000
const DEAD_AFTER_MS = 50_000
/** 在线状态(光标)最多这么久发一次,拖选文字时每个像素都发会触发服务端限速 */
const AWARENESS_THROTTLE_MS = 100
/** 角色刚被降级时,这段时间内的本地修改可能已经被服务端丢弃 */
const DOWNGRADE_RISK_MS = 15_000
/** 连续这么多次握手都失败就不再硬试了,把"重试"交给人 */
const MAX_HANDSHAKE_FAILURES = 8
/** 连续协议错误(1003)次数上限,避免死循环 */
const MAX_PROTOCOL_FAILURES = 3

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export class CollabProvider {
  readonly kind: DocKind
  doc: Y.Doc
  awareness: awarenessProtocol.Awareness

  #options: CollabOptions
  #clock: Clock
  #random: () => number
  #state: CollabState
  #listeners: { [K in keyof Events]?: Set<(payload: Events[K]) => void> } = {}
  #ws: SocketLike | null = null
  /** 每建一条连接加一:旧连接上迟到的事件据此识别并丢掉 */
  #generation = 0
  #opened = false
  #gotHello = false
  #gotStep2 = false
  #destroyed = false
  #wantConnected = false
  #reconnectTimer: unknown = null
  #heartbeatTimer: unknown = null
  #awarenessTimer: unknown = null
  #lastMessageAt = 0
  #handshakeFailures = 0
  #protocolFailures = 0
  #closingReason = ''
  #diagnosing = false
  /** 这份文档在本地有过修改(用来判断降级 / 重开时有没有东西会丢) */
  #lastLocalEditAt = 0
  #version = 0
  #offHandlers: (() => void)[] = []

  constructor(options: CollabOptions) {
    this.kind = options.kind
    this.#options = options
    this.#clock = options.clock ?? realClock
    this.#random = options.random ?? Math.random
    this.doc = new Y.Doc()
    this.awareness = new awarenessProtocol.Awareness(this.doc)
    this.#state = {
      status: 'connecting',
      ready: false,
      everSynced: false,
      writable: false,
      readonlyReason: null,
      lander: false,
      me: null,
      end: null,
      offlineReason: null,
      attempt: 0,
      pendingLocal: false,
      initMarkdown: null,
      docEpoch: 0,
      savedAt: null,
    }
    this.#bindDoc()
    const target = options.target === undefined ? (typeof window === 'undefined' ? null : window) : options.target
    if (target) {
      const online = () => this.#onOnline()
      const offline = () => this.#onOffline()
      target.addEventListener('online', online)
      target.addEventListener('offline', offline)
      this.#offHandlers.push(
        () => target.removeEventListener('online', online),
        () => target.removeEventListener('offline', offline),
      )
    }
  }

  // ------------------------------------------------------------ 对外

  getState(): CollabState {
    return this.#state
  }

  /** 文档里正文的根:文本文件是 Y.Text,笔记是 Y.XmlFragment */
  get text(): Y.Text {
    return this.doc.getText(TEXT_ROOT)
  }
  get fragment(): Y.XmlFragment {
    return this.doc.getXmlFragment(RICH_ROOT)
  }
  /** 文档变化计数(本地和远端都算),落地调度据此判断有没有新内容 */
  get version(): number {
    return this.#version
  }
  /** 当前连接是否能把内容发出去 */
  get online(): boolean {
    return this.#ws !== null && this.#ws.readyState === OPEN && this.#gotHello
  }

  on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): () => void {
    // 监听器表按事件名分桶,泛型下 TypeScript 推不出每个桶的具体类型:这里统一按"某事件的处理函数集合"取用
    const buckets = this.#listeners as unknown as Record<string, Set<(payload: Events[K]) => void> | undefined>
    const set = (buckets[event as string] ??= new Set())
    set.add(handler)
    return () => set.delete(handler)
  }

  /**
   * 把视图带到某个人的光标那里(腾讯文档的「点头像跳转」)。
   * 同一个人开了几个标签页时取有光标的那个;他没把光标放进正文(还没点进来)返回 false,调用方据此告诉用户。
   * 光标位置是服务端原样转发的 Yjs 相对位置;这里不换算(要用编辑器当前的节点映射),只发事件。
   */
  revealPeer(userId: string): boolean {
    for (const [client, state] of this.awareness.getStates()) {
      if (client === this.doc.clientID) continue
      const user = state.user as { id?: unknown } | undefined
      const cursor = state.cursor as { head?: unknown } | null | undefined
      if (user?.id !== userId || !cursor || cursor.head == null) continue
      this.#emit('reveal', { userId, head: cursor.head })
      return true
    }
    return false
  }

  /** 订阅状态变化(立即回调一次当前状态) */
  subscribe(handler: (state: CollabState) => void): () => void {
    handler(this.#state)
    return this.on('state', handler)
  }

  connect(): void {
    if (this.#destroyed || this.#state.end) return
    this.#wantConnected = true
    if (this.#ws || this.#reconnectTimer !== null) return
    this.#openSocket()
  }

  /** 用户主动断开(不再重连) */
  disconnect(): void {
    this.#wantConnected = false
    this.#clearTimers()
    this.#closeSocket(1000, 'client')
    if (!this.#state.end) this.#patch({ status: 'closed' })
  }

  /** 立刻重试(用户点了「重试」,或网络恢复) */
  retryNow(): void {
    if (this.#destroyed) return
    if (this.#state.end && !this.#state.end.reopenable) return
    if (this.#state.end) {
      this.reopen()
      return
    }
    this.#wantConnected = true
    this.#clearReconnectTimer()
    if (!this.#ws) this.#openSocket()
  }

  /** 丢掉本地文档,换一份全新的重连(4409 之后、或连接彻底失败后用户选择重新打开) */
  reopen(): void {
    if (this.#destroyed) return
    this.#replaceDoc(null)
  }

  /** 初始化者放完正文后调用,服务端据此宣布文档就绪 */
  initDone(): void {
    if (this.#state.initMarkdown === null) return
    this.#patch({ initMarkdown: null })
    this.#sendCtrl({ type: 'init_done' })
  }

  /** 落地者提交 Markdown 和此刻的状态向量。返回有没有发出去 */
  land(markdown: string): boolean {
    if (!this.online || !this.#state.lander || !this.#state.writable) return false
    return this.#sendCtrl({ type: 'land', markdown, sv: base64Encode(Y.encodeStateVector(this.doc)) })
  }

  /**
   * 不是落地者的窗口点了「保存」：自己没法落地，就在在线状态里写一个递增序号，
   * 落地者（同一篇笔记的另一个窗口，可能是同一个账号的另一台设备）看到序号变大就立刻提交，不管它是不是在「一个人编辑」。
   * 以前这种情况谁也不提交：落地者认为只有自己在、把服务端的落地请求当草稿忽略了，点保存后正文根本没进库
   */
  requestSave(): void {
    const seq = (this.awareness.getLocalState() as { saveSeq?: number } | null)?.saveSeq ?? 0
    this.awareness.setLocalStateField('saveSeq', seq + 1)
  }

  /** 「保存版本」 */
  savePoint(): boolean {
    if (!this.online || !this.#state.writable) return false
    return this.#sendCtrl({ type: 'save_point' })
  }

  destroy(): void {
    if (this.#destroyed) return
    // 先让落地者趁连接还在做最后一次提交,再关
    this.#emit('closing', undefined)
    this.#destroyed = true
    this.#wantConnected = false
    this.#clearTimers()
    if (this.#ws && this.#ws.readyState === OPEN) {
      // 让别人的屏幕上立刻不再有我的光标(服务端也会在断开时广播,这里是早一步)
      awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy')
      this.#flushAwareness(true)
    }
    this.#closeSocket(1000, 'client')
    for (const off of this.#offHandlers.splice(0)) off()
    this.#unbindDoc()
    this.awareness.destroy()
    this.#listeners = {}
  }

  // ------------------------------------------------------------ 文档与在线状态

  #docHandlers: (() => void)[] = []

  #bindDoc(): void {
    const doc = this.doc
    const awareness = this.awareness
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      this.#version += 1
      if (origin !== this) {
        this.#lastLocalEditAt = this.#clock.now()
        if (this.online && this.#state.writable) {
          this.#send(
            encodeFrame((encoder) => {
              encoding.writeVarUint(encoder, MSG_SYNC)
              syncProtocol.writeUpdate(encoder, update)
            }),
          )
        } else if (!this.#state.pendingLocal) {
          // 没连上(或只读)时的修改先留在本地,连上后靠 SyncStep 自动合并
          this.#patch({ pendingLocal: true })
        }
      }
      this.#emit('change', undefined)
    }
    doc.on('update', onUpdate)
    const onAwareness = (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      if (origin === this) return
      // 服务端只认本连接自己的那一个 client id,别人的状态发了也被丢
      if (![...added, ...updated, ...removed].includes(doc.clientID)) return
      this.#scheduleAwareness()
    }
    awareness.on('update', onAwareness)
    this.#docHandlers.push(
      () => doc.off('update', onUpdate),
      () => awareness.off('update', onAwareness),
    )
  }

  #unbindDoc(): void {
    for (const off of this.#docHandlers.splice(0)) off()
  }

  #scheduleAwareness(): void {
    if (this.#awarenessTimer !== null) return
    this.#awarenessTimer = this.#clock.setTimeout(() => {
      this.#awarenessTimer = null
      this.#flushAwareness(false)
    }, AWARENESS_THROTTLE_MS)
  }

  #flushAwareness(immediate: boolean): void {
    if (immediate && this.#awarenessTimer !== null) {
      this.#clock.clearTimeout(this.#awarenessTimer)
      this.#awarenessTimer = null
    }
    if (!this.#ws || this.#ws.readyState !== OPEN) return
    this.#send(
      encodeFrame((encoder) => {
        encoding.writeVarUint(encoder, MSG_AWARENESS)
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]))
      }),
    )
  }

  /** 换一份全新的文档 + 在线状态,然后马上重连。`notice` 非空时提示用户发生了什么 */
  #replaceDoc(notice: CollabNotice | null): void {
    this.#generation += 1
    this.#clearTimers()
    this.#closeSocket(1000, 'replace')
    this.#unbindDoc()
    this.awareness.destroy()
    this.doc = new Y.Doc()
    this.awareness = new awarenessProtocol.Awareness(this.doc)
    this.#bindDoc()
    this.#lastLocalEditAt = 0
    this.#handshakeFailures = 0
    this.#protocolFailures = 0
    this.#patch({
      status: 'connecting',
      ready: false,
      everSynced: false,
      writable: false,
      lander: false,
      end: null,
      pendingLocal: false,
      initMarkdown: null,
      offlineReason: null,
      attempt: 0,
      docEpoch: this.#state.docEpoch + 1,
    })
    this.#emit('doc-replaced', undefined)
    if (notice) this.#emit('notice', notice)
    this.#wantConnected = true
    this.#openSocket()
  }

  // ------------------------------------------------------------ 连接

  #url(): string {
    const { url } = this.#options
    return typeof url === 'function' ? url() : url
  }

  #openSocket(): void {
    if (this.#destroyed) return
    const factory = this.#options.socket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike)
    let ws: SocketLike
    try {
      ws = factory(this.#url())
    } catch {
      // 地址不合法 / 被浏览器拒绝:当作握手失败处理
      this.#onClosed(null, 1006, '', false, this.#generation)
      return
    }
    ws.binaryType = 'arraybuffer'
    const generation = ++this.#generation
    this.#ws = ws
    this.#opened = false
    this.#gotHello = false
    this.#gotStep2 = false
    if (this.#state.status !== 'offline') this.#patch({ status: 'connecting' })
    ws.onopen = () => {
      if (generation !== this.#generation) return
      this.#opened = true
      this.#lastMessageAt = this.#clock.now()
      this.#patch({ status: 'syncing' })
      // 和 y-websocket 一样:连上就发 SyncStep1(把服务端多出来的要过来),再报到自己的在线状态
      this.#send(
        encodeFrame((encoder) => {
          encoding.writeVarUint(encoder, MSG_SYNC)
          syncProtocol.writeSyncStep1(encoder, this.doc)
        }),
      )
      this.#flushAwareness(true)
      this.#startHeartbeat()
    }
    ws.onmessage = (event) => {
      if (generation !== this.#generation) return
      this.#lastMessageAt = this.#clock.now()
      const data = event.data
      if (data instanceof ArrayBuffer) this.#onFrame(new Uint8Array(data), generation)
      else if (ArrayBuffer.isView(data)) this.#onFrame(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), generation)
    }
    ws.onerror = () => {
      // 错误之后一定会跟一个 close,在那里统一处理
    }
    ws.onclose = (event) => this.#onClosed(ws, event.code, event.reason, this.#opened, generation)
  }

  #closeSocket(code: number, reason: string): void {
    const ws = this.#ws
    if (!ws) return
    this.#ws = null
    // 先摘掉回调再关:主动关闭产生的 close 事件不该被当成断线
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
    this.#stopHeartbeat()
    try {
      if (ws.readyState === CONNECTING) {
        // 还在握手就 close 会让浏览器在控制台报「WebSocket is closed before the connection is established」。
        // 等它连上再关:用户几乎感觉不到,服务端也只看到一次正常的开关
        ws.onopen = () => {
          try {
            ws.close(code, reason)
          } catch {
            // 已经关了
          }
        }
        return
      }
      ws.close(code, reason)
    } catch {
      // 已经关了
    }
  }

  #onClosed(ws: SocketLike | null, code: number, reason: string, wasOpen: boolean, generation: number): void {
    if (generation !== this.#generation || this.#destroyed) return
    if (ws && this.#ws !== ws) return
    this.#ws = null
    this.#stopHeartbeat()
    const closingReason = this.#closingReason
    this.#closingReason = ''
    const info = classifyClose(code, reason || closingReason, wasOpen)
    if (info.terminal) {
      this.#end(info, code)
      return
    }
    if (info.kind === 'handshake') this.#handshakeFailures += 1
    else this.#handshakeFailures = 0
    if (info.kind === 'protocol') this.#protocolFailures += 1
    if (this.#protocolFailures >= MAX_PROTOCOL_FAILURES) {
      this.#end({ kind: 'protocol', terminal: true, message: '协作连接反复出错。请刷新页面重试;还不行就把这个情况告诉管理员。' }, code, 'failed', true)
      return
    }
    if (this.#handshakeFailures >= MAX_HANDSHAKE_FAILURES) {
      this.#end({ kind: 'handshake', terminal: true, message: '一直连不上协作服务。请检查网络,或确认你还有这篇文档的权限,然后点「重试」。' }, code, 'failed', true)
      return
    }
    this.#patch({ status: 'offline', offlineReason: info.message, ready: false, lander: false })
    if (!this.#wantConnected) return
    this.#scheduleReconnect(info.kind)
    // 第二次握手失败时问一次原因,之后每隔几次再问(权限可能是中途被收回的)
    if (info.kind === 'handshake' && (this.#handshakeFailures === 2 || this.#handshakeFailures % 4 === 0)) void this.#diagnose()
  }

  #end(info: CloseInfo, code: number, kind?: CollabEnd['kind'], reopenable = false): void {
    this.#clearTimers()
    this.#wantConnected = false
    const endKind: CollabEnd['kind'] = kind ?? (info.kind === 'denied' ? 'denied' : info.kind === 'deleted' ? 'deleted' : info.kind === 'stale' ? 'stale' : 'failed')
    // 4409:房间作废,本地历史和新房间无关;重新打开要用新文档
    const canReopen = reopenable || endKind === 'stale'
    this.#patch({
      status: 'closed',
      ready: false,
      writable: false,
      lander: false,
      end: { kind: endKind, code, message: info.message, reopenable: canReopen },
      offlineReason: null,
    })
  }

  #scheduleReconnect(kind: CloseKind): void {
    this.#clearReconnectTimer()
    const attempt = this.#state.attempt
    // 服务端主动让我们马上重来(初始化者超时被换下)不用等
    const delay = kind === 'init-timeout' ? 0 : backoffDelay(attempt, kind, this.#random)
    this.#patch({ attempt: attempt + 1 })
    this.#reconnectTimer = this.#clock.setTimeout(() => {
      this.#reconnectTimer = null
      if (this.#wantConnected && !this.#ws) this.#openSocket()
    }, delay)
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer !== null) {
      this.#clock.clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
  }

  #clearTimers(): void {
    this.#clearReconnectTimer()
    this.#stopHeartbeat()
    if (this.#awarenessTimer !== null) {
      this.#clock.clearTimeout(this.#awarenessTimer)
      this.#awarenessTimer = null
    }
  }

  async #diagnose(): Promise<void> {
    const diagnose = this.#options.diagnose
    if (!diagnose || this.#diagnosing) return
    this.#diagnosing = true
    try {
      const result = await diagnose()
      if (!result || this.#destroyed || this.#state.end || result.kind === 'retry') {
        if (result?.message) this.#patch({ offlineReason: result.message })
        return
      }
      const kind: CollabEnd['kind'] = result.kind === 'deleted' ? 'deleted' : 'denied'
      this.#generation += 1
      this.#closeSocket(1000, 'diagnosed')
      this.#end({ kind: kind === 'deleted' ? 'deleted' : 'denied', terminal: true, message: result.message }, 0, kind, false)
    } catch {
      // 诊断本身失败(比如网络真的断了):继续按断线重连
    } finally {
      this.#diagnosing = false
    }
  }

  // ------------------------------------------------------------ 网络状态与心跳

  #onOffline(): void {
    if (this.#destroyed || this.#state.end) return
    // 浏览器说网断了:不等 TCP 超时,立刻显示离线并停掉当前连接
    this.#closeSocket(1000, 'offline')
    this.#clearReconnectTimer()
    this.#patch({ status: 'offline', ready: false, lander: false, offlineReason: '网络断开了。恢复后会自动重连,离线时的修改会自动合并。' })
    // online 事件不一定可靠(有的网络环境会误报断网),保底仍按退避重试
    if (this.#wantConnected) this.#scheduleReconnect('lost')
  }

  #onOnline(): void {
    if (this.#destroyed || this.#state.end || !this.#wantConnected) return
    this.#clearReconnectTimer()
    if (!this.#ws) this.#openSocket()
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat()
    const tick = () => {
      this.#heartbeatTimer = null
      const ws = this.#ws
      if (!ws || ws.readyState !== OPEN) return
      const idle = this.#clock.now() - this.#lastMessageAt
      if (idle > DEAD_AFTER_MS) {
        // 半开连接(对端早没了但本地没发现):主动断开重连
        const generation = this.#generation
        this.#closeSocket(1000, 'dead')
        this.#onClosed(null, 1006, '', true, generation)
        return
      }
      // 用"查询在线状态"当心跳:服务端一定会回(至少有我自己的状态)
      if (idle >= HEARTBEAT_MS) this.#send(encodeFrame((encoder) => encoding.writeVarUint(encoder, MSG_QUERY_AWARENESS)))
      this.#heartbeatTimer = this.#clock.setTimeout(tick, HEARTBEAT_MS)
    }
    this.#heartbeatTimer = this.#clock.setTimeout(tick, HEARTBEAT_MS)
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer !== null) {
      this.#clock.clearTimeout(this.#heartbeatTimer)
      this.#heartbeatTimer = null
    }
  }

  // ------------------------------------------------------------ 入站

  #onFrame(bytes: Uint8Array, generation: number): void {
    readFrame(bytes, (message) => {
      // 处理某条消息时连接可能被换掉(重开文档):后面的消息属于旧连接,丢弃
      if (generation !== this.#generation || this.#destroyed) return false
      switch (message.kind) {
        case 'sync': {
          const encoder = encoding.createEncoder()
          encoding.writeVarUint(encoder, MSG_SYNC)
          const type = syncProtocol.readSyncMessage(message.decoder, encoder, this.doc, this)
          if (encoding.length(encoder) > 1) {
            this.#send(encoding.toUint8Array(encoder))
            // 回给服务端的 SyncStep2 带上了我所有它没有的修改(包括离线时的)
            if (this.#state.writable) this.#patch({ pendingLocal: false })
          }
          if (type === syncProtocol.messageYjsSyncStep2) {
            this.#gotStep2 = true
            this.#checkSynced()
          }
          break
        }
        case 'awareness':
          awarenessProtocol.applyAwarenessUpdate(this.awareness, message.update, this)
          break
        case 'query-awareness':
          this.#send(
            encodeFrame((encoder) => {
              encoding.writeVarUint(encoder, MSG_AWARENESS)
              encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...this.awareness.getStates().keys()]))
            }),
          )
          break
        case 'ctrl':
          return this.#onCtrl(message.ctrl, generation)
        default:
          break
      }
      return true
    })
  }

  /** 返回 false = 这条连接已作废,别再处理这一帧里剩下的消息 */
  #onCtrl(ctrl: ServerCtrl, generation: number): boolean {
    switch (ctrl.type) {
      case 'hello':
        return this.#onHello(ctrl, generation)
      case 'role':
        this.#onRole(ctrl.writable)
        return true
      case 'lander':
        this.#patch({ lander: ctrl.you })
        return true
      case 'ready':
        this.#patch({ ready: true })
        this.#checkSynced()
        return true
      case 'land_now':
        this.#emit('land-now', undefined)
        return true
      case 'saved':
        this.#patch({ savedAt: this.#clock.now() })
        this.#emit('saved', { savepoint: ctrl.savepoint })
        return true
      case 'rejected':
        this.#emit('rejected', { reason: ctrl.reason })
        return true
      case 'closing':
        // 服务端要关闭了:记下原因,真正的关闭码随后到来
        this.#closingReason = ctrl.reason
        return true
      default:
        return true
    }
  }

  #onHello(hello: Extract<ServerCtrl, { type: 'hello' }>, generation: number): boolean {
    const kind = parseKind(hello.kind)
    if (kind && kind !== this.kind) {
      // 前后端对这篇文档的结构认知不一样:继续同步会写坏文档
      this.#generation += 1
      this.#closeSocket(1000, 'kind-mismatch')
      this.#end({ kind: 'protocol', terminal: true, message: '这篇文档的类型和页面对不上,无法协作。请刷新页面后再试。' }, 0, 'failed', false)
      return false
    }
    const firstHello = !this.#gotHello
    this.#gotHello = true
    this.#handshakeFailures = 0
    this.#protocolFailures = 0
    const hasContent = this.doc.store.clients.size > 0
    // 重连时服务端说"还没就绪"(房间被作废重开),本地却已有一份内容:那是旧房间的历史,合并进去会让正文重复。
    // 被指定为初始化者(init 不为空)的也一样:要先换成空白文档,再按服务端给的正文初始化
    if (firstHello && !hello.ready && hasContent) {
      this.#replaceDoc({ tone: 'warn', text: '这篇文档在你离线期间被别处改过,已载入最新内容;离线时没来得及同步的修改没有保留。' })
      return false
    }
    // 重连后发现自己已经是只读,而离线时做过修改:这些修改服务端不会收,留着只会让本地和房间不一致
    if (firstHello && !hello.writable && (this.#state.pendingLocal || this.#recentlyEdited())) {
      this.#replaceDoc({ tone: 'warn', text: '你现在只有查看权限,离线时的修改没有保存。' })
      return false
    }
    this.#patch({
      me: hello.you,
      writable: hello.writable,
      readonlyReason: hello.readonly_reason,
      lander: hello.lander,
      // ready 是这条连接上的就绪状态:hello 一定在 ready 之前,所以直接取 hello 的
      ready: hello.ready,
      initMarkdown: hello.init !== null ? hello.init : this.#state.initMarkdown,
    })
    // 本地显示用的名字和颜色;服务端转发给别人时会按它认定的身份改写,这里写什么都不影响别人看到的
    this.awareness.setLocalStateField('user', { id: hello.you.id, name: hello.you.name, color: hello.you.color })
    if (hello.init !== null) this.#emit('init', hello.init)
    if (hello.readonly_reason) this.#emit('notice', { tone: 'warn', text: hello.readonly_reason })
    this.#checkSynced()
    return generation === this.#generation
  }

  #onRole(writable: boolean): void {
    const was = this.#state.writable
    if (was === writable) return
    if (was && !writable) {
      // 降级:之后的修改服务端静默丢弃;刚刚的修改可能已经落在丢弃窗口里
      if (this.#recentlyEdited() || this.#state.pendingLocal) {
        this.#replaceDoc({ tone: 'warn', text: '你的权限变成了只读,刚才没来得及同步的修改没有保存。你仍然能实时看到别人的修改。' })
        return
      }
      this.#patch({ writable: false })
      this.#emit('notice', { tone: 'warn', text: '你的权限变成了只读。你仍然能实时看到别人的修改。' })
      return
    }
    this.#patch({ writable: true })
    this.#emit('notice', { tone: 'info', text: '你现在可以编辑这篇文档了。' })
  }

  #recentlyEdited(): boolean {
    return this.#lastLocalEditAt > 0 && this.#clock.now() - this.#lastLocalEditAt < DOWNGRADE_RISK_MS
  }

  #checkSynced(): void {
    if (!this.#opened || !this.#gotHello || !this.#gotStep2) return
    if (!this.#state.ready) {
      this.#patch({ status: 'syncing' })
      return
    }
    // 同步完成:这一轮重连算成功,退避计数清零
    this.#patch({ status: 'synced', everSynced: true, attempt: 0, offlineReason: null })
  }

  // ------------------------------------------------------------ 出站

  #send(bytes: Uint8Array): boolean {
    const ws = this.#ws
    if (!ws || ws.readyState !== OPEN) return false
    try {
      ws.send(bytes)
      return true
    } catch {
      return false
    }
  }

  #sendCtrl(ctrl: ClientCtrl): boolean {
    return this.#send(encodeClientCtrl(ctrl))
  }

  // ------------------------------------------------------------ 状态与事件

  #patch(patch: Partial<CollabState>): void {
    const next = { ...this.#state, ...patch }
    const changed = (Object.keys(patch) as (keyof CollabState)[]).some((key) => next[key] !== this.#state[key])
    if (!changed) return
    this.#state = next
    this.#emit('state', next)
  }

  #emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.#listeners[event] as Set<(payload: Events[K]) => void> | undefined
    if (!set) return
    for (const handler of [...set]) {
      try {
        handler(payload)
      } catch (error) {
        console.error('协作事件处理出错', error)
      }
    }
  }
}

function encodeFrame(write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder()
  write(encoder)
  return encoding.toUint8Array(encoder)
}
