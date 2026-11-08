// 协作状态条的纯逻辑:状态 → 一句人话;awareness 状态表 → 在线的人。
import type { CollabState } from './provider'

export interface Peer {
  id: string
  name: string
  color: string
  /** 这个人就是我自己(别的标签页 / 设备上同一个账号也算) */
  me?: boolean
}

/**
 * 在线的人:按用户去重(同一个人开了两个标签页只算一个),不含我自己这个标签页。
 * 身份来自服务端改写过的 `user` 字段;没有 `user` 的状态(还没发出身份)不算。
 */
export function peersOf(states: Map<number, Record<string, unknown>>, myClientId: number): Peer[] {
  const byId = new Map<string, Peer>()
  for (const [client, state] of states) {
    if (client === myClientId) continue
    const user = state.user as { id?: unknown; name?: unknown; color?: unknown } | undefined
    if (!user || typeof user.id !== 'string' || !user.id) continue
    if (!byId.has(user.id)) byId.set(user.id, { id: user.id, name: typeof user.name === 'string' && user.name ? user.name : '协作者', color: typeof user.color === 'string' ? user.color : '' })
  }
  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * 头像堆里要显示的人(腾讯文档式):**我自己排第一**,其他人按名字排。
 * 同一个账号在别的标签页 / 设备上开着,也只算一个,并标成"我"。
 * `me` 是我自己的身份(provider 收到 hello 之前是 null,这时只显示别人)。
 */
export function stackOf(peers: Peer[], me: { id: string; name: string; color: string } | null): Peer[] {
  if (!me) return peers
  const others = peers.filter((peer) => peer.id !== me.id)
  return [{ id: me.id, name: me.name || '我', color: me.color, me: true }, ...others]
}

/**
 * 头像堆最多直接显示几个,剩下的折成 +N。
 * 只多出一个人时直接显示他:"+1" 占的地方和一个头像一样,却什么也看不出来。
 */
export function splitStack<T>(people: T[], max: number): { shown: T[]; more: number } {
  if (people.length <= max + 1) return { shown: people, more: 0 }
  return { shown: people.slice(0, max), more: people.length - max }
}

/** 状态条上那句话。断线要说清"改动还在、恢复后自动合并";被终止要说清原因。 */
export function statusText(state: Pick<CollabState, 'status' | 'end' | 'offlineReason' | 'pendingLocal' | 'writable' | 'ready' | 'readonlyReason' | 'attempt'>): string {
  if (state.end) return state.end.message
  switch (state.status) {
    case 'connecting':
      return '正在连接多人编辑…'
    case 'syncing':
      return state.ready ? '正在同步…' : '正在准备文档…'
    case 'offline': {
      // 原因优先用服务端 / 探测给出的(握手被拒、网络断开各有说法),没有才用通用的一句
      const reason = state.offlineReason || '连接断开了。'
      const retrying = state.attempt ? `第 ${state.attempt} 次重连中。` : ''
      // 原因里已经交代了「修改会自动合并」就不再重复
      const keep = state.pendingLocal && !reason.includes('合并') ? '你的改动先留在本地,恢复后自动合并。' : state.pendingLocal ? '' : reason.includes('自动') ? '' : '恢复后自动继续。'
      return [reason, retrying, keep].filter(Boolean).join(' ')
    }
    case 'closed':
      return '已断开'
    default:
      if (!state.writable) return state.readonlyReason ? `只读:${state.readonlyReason}` : '只读:你现在的权限不能编辑'
      return '已同步 · 多人编辑中'
  }
}
