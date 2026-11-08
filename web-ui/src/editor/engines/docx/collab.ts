/**
 * Word 多人协同接入
 *
 * 结构：Worker 里的引擎持有文档（一份 Yrs 副本）；协同的"副本适配器"把它包成上游 `CollaborationProvider` 认识的接口，
 * Provider 再经 WebSocket 传输（`collab/officeRoomTransport.ts`，同一个 y-sync 协议）和服务端房间同步。
 *
 * 本文件由上游 `peerless/peerlessCollaboration.ts` 与 `useWorkerCollaboration.ts` 改写而来（Apache-2.0，见 NOTICE），
 * 去掉了 React；三件必须保持的事：
 * - 远端更新走专门的 `collab` 通道提交给引擎（`applyRemoteUpdate`），**不进本地撤销栈**：
 *   用户撤销的只能是自己的操作，不会把同事刚敲的字撤掉；
 * - 读状态前先冲掉已准入但还没到引擎的本地输入（`flushAdmittedInput`），否则同步出去的状态会漏掉最后几个字；
 * - 副本退休后所有调用都拒绝，不在会话销毁后还往已经没有的引擎里写。
 */
import {
  attachCollaborationPipe,
  CollaborationProvider,
  createAsyncCollaborationReplica,
  resolvePresenceColor,
  type AsyncReplicaAdapter,
  type CollaborationPeer,
  type CollaborationTextInsertion,
  type CollaborationTransport,
  type CollaborationUpdateOrigin,
} from '@betteroffice/docx/collaboration'
import type { DocxSourceWorkerClient } from '@betteroffice/docx/worker'
import type { DocxEditSessionBinding } from './session'
import { flushAdmittedInput } from './vendor/inputAdmission'

type Client = DocxSourceWorkerClient
type PipeBatch = Parameters<Parameters<Client['onCollabPipe']>[0]>[0][number]
type PipeOut = PipeBatch['out']
type PipeChannel = { receive: (out: PipeOut) => void; lost: (reason: string) => void }

/** 引擎要的是自己拥有的 ArrayBuffer（会被转移给 Worker）；传进来的视图若只是大缓冲的一段就先拷贝 */
const owned = (update: Uint8Array): ArrayBuffer =>
  update.buffer instanceof ArrayBuffer && update.byteOffset === 0 && update.byteLength === update.buffer.byteLength ? update.buffer : (update.slice().buffer as ArrayBuffer)

export type DocxCollabReplica = AsyncReplicaAdapter & { retire(): void }

/** 把 Worker 里的文档包成协同副本。`clientId` 是这份副本在房间里的身份，必须与打开会话时用的一致。 */
export function createDocxCollaborationReplica(client: Client, binding: Pick<DocxEditSessionBinding, 'admission' | 'session'>, clientId: number): DocxCollabReplica {
  const { session } = binding
  let retired = false
  const listeners = new Set<(update: Uint8Array, origin: CollaborationUpdateOrigin) => void>()
  // 本地输入推断：引擎在合并远端更新时告诉我们"这是在哪个段落敲了字"，远端光标据此贴到刚输入的位置
  const inferences = new Map<number, CollaborationTextInsertion>()
  const requireActive = () => {
    if (retired) throw new Error('协同副本已退休')
  }
  const fenced = async <T>(read: () => Promise<{ value: T }>): Promise<T> => {
    requireActive()
    await flushAdmittedInput(binding as never)
    requireActive()
    const reply = await read()
    requireActive()
    return reply.value
  }
  const off = client.onCollabUpdates((event) => {
    if (retired) return
    for (const inference of event.inferences) inferences.set(inference.seq, inference.insertion)
    // 只留最近 256 条：推断只用来对上刚提交的那一次合并，旧的没有用
    while (inferences.size > 256) inferences.delete(inferences.keys().next().value as number)
    for (const update of event.updates) for (const listener of [...listeners]) listener(update, 'local')
  })
  const merged = async (ticket: ReturnType<typeof session.submit>) => {
    const outcome = await ticket.ack
    requireActive()
    if (outcome.status === 'refused' || outcome.status === 'cancelled') throw new Error(`协同合并被${outcome.status === 'refused' ? '拒绝' : '取消'}：${outcome.reason ?? '原因不明'}`)
    return ticket
  }
  const adapter = createAsyncCollaborationReplica({
    clientId,
    encodeStateVector: () => fenced(() => client.documentRead({ kind: 'collabStateVector' })),
    encodeStateAsUpdate: (stateVector) => fenced(() => client.documentRead({ kind: 'collabDiff', stateVector: stateVector?.slice() })),
    encodeStateAsUpdateChunks: (stateVector, maxChunkBytes) =>
      fenced(() => client.documentRead({ kind: 'collabDiffChunks', stateVector: stateVector.slice(), maxChunkBytes })),
    async applyUpdate(update) {
      requireActive()
      const ticket = await merged(session.submit('applyRemoteUpdate', { update: owned(update) }, { lane: 'collab', fence: true }))
      const inference = ticket.seq === undefined ? undefined : inferences.get(ticket.seq)
      if (ticket.seq !== undefined) inferences.delete(ticket.seq)
      return inference ?? null
    },
    async applyUpdateChunks(updates) {
      requireActive()
      await merged(session.submit('applyRemoteUpdateChunks', { updates: updates.map(owned) }, { lane: 'collab', fence: true }))
      return null
    },
    onUpdate(listener) {
      requireActive()
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  })
  // Provider 跑在 Worker 里（协议处理不占主线程）；主线程只转发字节：传输层来的帧 → Worker，Worker 要发的帧 → 传输层
  const pipes = new Map<number, PipeChannel>()
  let nextPipe = 1
  const offPipe = client.onCollabPipe((batches) => {
    if (retired) return
    for (const batch of batches) pipes.get(batch.provider)?.receive(batch.out)
  })
  attachCollaborationPipe(adapter, {
    open(receive: PipeChannel['receive'], lost: PipeChannel['lost']) {
      const id = nextPipe++
      if (retired) queueMicrotask(() => lost('协同副本已退休'))
      else pipes.set(id, { receive, lost })
      return {
        // ops 是引擎自己定义的协议操作，主线程不解释，原样交给 Worker 里的 Provider
        async post(ops: unknown[]) {
          requireActive()
          await merged(session.submit('collabPipe', { provider: id, ops } as never, { lane: 'collab', fence: true }))
        },
        close() {
          pipes.delete(id)
        },
      }
    },
  } as never)
  return Object.assign(adapter, {
    retire() {
      if (retired) return
      retired = true
      off()
      offPipe()
      listeners.clear()
      inferences.clear()
      const lost = [...pipes.values()]
      pipes.clear()
      for (const pipe of lost) {
        try {
          pipe.lost('协同副本已退休')
        } catch {
          // 一个通道的收尾失败不影响其它通道
        }
      }
    },
  })
}

/* ---------------- 加入房间 ---------------- */

export interface DocxCollabStatus {
  /** connecting / connected / disconnected / destroyed（引擎原样给的） */
  status: string
  synced: boolean
  error?: string
  /** 房间里的其他人（名字 + 颜色 + 最近一次光标移动时间） */
  peers: Array<{ clientId: number; name: string; color: string }>
}

export interface DocxCollabJoinOptions {
  transport: CollaborationTransport
  user: { name: string; color?: string }
  onStatus?(status: DocxCollabStatus): void
  /** 服务端关掉了连接（权限被收回、房间关了）：码和原因 */
  onClosed?(code: number, reason: string): void
}

/** 引擎里的"在线的人"→ 外壳要的轻量形状；颜色在这里就定下，光标层和状态条用同一个色 */
export function summarizePeers(peers: readonly CollaborationPeer[]): DocxCollabStatus['peers'] {
  return peers
    .map((peer) => ({ clientId: peer.clientId, name: peer.user?.name ?? '', color: resolvePresenceColor(peer.clientId, peer.user?.color) }))
    .filter((peer) => peer.name)
}

export interface DocxCollabHandle {
  readonly provider: CollaborationProvider
  readonly replica: DocxCollabReplica
  peers(): readonly CollaborationPeer[]
  onPeers(listener: (peers: readonly CollaborationPeer[]) => void): () => void
  /** 把本地光标广播给房间；`null` = 离开（不再显示我的光标） */
  setCursor(cursor: { story: string; anchor: Uint8Array; head: Uint8Array } | null, broadcast?: boolean): void
  /** 断开并释放；幂等 */
  leave(): void
}

/**
 * 用已经就绪的编辑会话加入房间：建副本、建 Provider、接传输、连接。
 * 传输由调用方给（`collab/officeRoomTransport.ts` 的 `createOfficeTransport`），这里只负责协议；
 * 断线重连、离线期间的本地修改缓存与重连后的状态向量对账都是 Provider + 传输自己做的。
 */
export function joinDocxCollaboration(client: Client, binding: DocxEditSessionBinding, clientId: number, options: DocxCollabJoinOptions): DocxCollabHandle {
  const replica = createDocxCollaborationReplica(client, binding, clientId)
  const provider = new CollaborationProvider(replica as never, options.transport, { user: options.user })
  const cleanups: Array<() => void> = []
  let left = false
  let last = { status: 'connecting', synced: false } as { status: string; synced: boolean; error?: string }
  const report = () => options.onStatus?.({ ...last, peers: summarizePeers(provider.peers) })
  cleanups.push(
    provider.onStatus((change) => {
      last = { status: change.status, synced: change.synced, ...('error' in change && change.error ? { error: String((change as { error: unknown }).error) } : {}) }
      report()
    }),
  )
  cleanups.push(provider.onPeers(() => report()))
  cleanups.push(
    provider.onError((error) => {
      last = { ...last, error: error.message }
      report()
    }),
  )
  const closable = options.transport as CollaborationTransport & { onClosed?: (listener: (code: number, reason: string) => void) => () => void }
  if (options.onClosed && closable.onClosed) cleanups.push(closable.onClosed(options.onClosed))
  provider.connect()
  return {
    provider,
    replica,
    peers: () => provider.peers,
    onPeers: (listener) => provider.onPeers(listener),
    setCursor: (cursor, broadcast) => provider.setCursor(cursor, broadcast),
    leave() {
      if (left) return
      left = true
      for (const stop of cleanups.splice(0)) stop()
      provider.setCursor(null)
      provider.destroy()
      replica.retire()
    },
  }
}

export { resolvePresenceColor }
