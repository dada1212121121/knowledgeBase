/**
 * Office 协同房间在编辑器层的接线
 *
 * - 传输：沿用 `collab/officeRoomTransport.ts`（断线指数退避重连、发送背压），这里只负责把它交给引擎的
 *   `CollaborationProvider`，类型上的小差别（事件联合类型的写法）在这一处消化，不让调用方到处强转；
 * - 状态：引擎的连接状态（connecting / connected + synced / disconnected / destroyed）换成状态栏认识的
 *   房间状态，状态栏据此显示「正在连接 / 正在同步 / 已同步 / 离线」，而不是永远写着「已保存」。
 */
import { createOfficeTransport, type OfficeTransport } from '@/editor/collab/officeRoomTransport'
import type { CollabRoomStatus, CollabStatusSource } from '../types'

/**
 * 开房间的 WebSocket 传输；`onClosed` 收服务端主动关闭的原因（权限收回、房间关了…）。
 * 返回值的形状与引擎的 `CollaborationTransport` 一致（connect / disconnect / send / onEvent），
 * 编辑器层不直接引用 `@betteroffice/*`（见 engines/contract.spec），由 `engines/pptxEdit.ts` 在边界上接收。
 */
export function openOfficeRoomTransport(url: string, onClosed?: (code: number, reason: string) => void): OfficeTransport {
  const transport = createOfficeTransport(url)
  if (onClosed) transport.onClosed(onClosed)
  return transport
}

/** 引擎连接状态 → 状态栏的房间状态：连上但还没对齐算「正在同步」 */
export function toRoomStatus(status: string, synced: boolean): CollabRoomStatus {
  if (status === 'destroyed') return 'closed'
  if (status === 'connected') return synced ? 'synced' : 'syncing'
  if (status === 'disconnected') return 'offline'
  return 'connecting'
}

export interface RoomStatusFeed {
  source: CollabStatusSource
  /** 引擎的连接状态变了 */
  update(status: string, synced: boolean): void
  /** 服务端主动结束了这次协同（不会再重连）：状态栏写「协同已结束」 */
  close(): void
}

/** 给状态栏用的房间状态来源。订阅时立即推一次当前状态（和 CollabProvider 的约定一致）。 */
export function createRoomStatusFeed(writable: boolean): RoomStatusFeed {
  let state: { status: CollabRoomStatus; writable: boolean } = { status: 'connecting', writable }
  let closed = false
  const listeners = new Set<(next: typeof state) => void>()
  const set = (status: CollabRoomStatus) => {
    // 结束之后引擎还会补发 disconnected：已经「结束」的不能退回「离线」
    if (closed || state.status === status) return
    state = { ...state, status }
    for (const listener of [...listeners]) listener(state)
  }
  return {
    source: {
      getState: () => state,
      subscribe(listener) {
        listeners.add(listener)
        listener(state)
        return () => listeners.delete(listener)
      },
    },
    update: (status, synced) => set(toRoomStatus(status, synced)),
    close() {
      set('closed')
      closed = true
    },
  }
}
