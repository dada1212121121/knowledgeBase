// 办公文档协同的 WebSocket 传输(引擎的 CollaborationTransport):断线重连(指数退避)、背压(缓冲太多时让引擎等 drain)。
// 改自 betteroffice 的 shared/editor-host/collaboration/createRoomTransport.ts(Apache-2.0)。
const MAX_BUFFERED_BYTES = 1024 * 1024
const INITIAL_RETRY_MS = 250
const MAX_RETRY_MS = 5000

export type TransportEvent =
  | { type: 'open' }
  | { type: 'message'; data: Uint8Array }
  | { type: 'close'; reason?: string }
  | { type: 'error'; error: unknown }
  | { type: 'drain' }

export interface OfficeTransport {
  connect(): void
  disconnect(): void
  send(data: Uint8Array): boolean
  onEvent(listener: (event: TransportEvent) => void): () => void
  /** 服务端主动关闭的原因(权限被收回、房间关了…);界面据此提示 */
  onClosed(listener: (code: number, reason: string) => void): () => void
}

/** 浏览器里的 WebSocket 构造器(测试里换掉)。 */
export type SocketFactory = (url: string) => WebSocket

/** 服务端说「别再连了」的关闭码:没有权限、房间不存在、文件开不了协同。其余的(网络断、服务重启)都重连。 */
const TERMINAL_CODES = new Set([4403, 4404, 4410])

export function createOfficeTransport(url: string, socketFactory: SocketFactory = (target) => new WebSocket(target)): OfficeTransport {
  const listeners = new Set<(event: TransportEvent) => void>()
  const closedListeners = new Set<(code: number, reason: string) => void>()
  let socket: WebSocket | null = null
  let wants = false
  let retry = INITIAL_RETRY_MS
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let drainTimer: ReturnType<typeof setInterval> | null = null
  const emit = (event: TransportEvent) => {
    for (const listener of [...listeners]) listener(event)
  }
  const clearDrain = () => {
    if (drainTimer) clearInterval(drainTimer)
    drainTimer = null
  }
  const open = () => {
    if (!wants || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return
    const next = socketFactory(url)
    next.binaryType = 'arraybuffer'
    socket = next
    next.onopen = () => {
      if (socket !== next) return
      retry = INITIAL_RETRY_MS
      emit({ type: 'open' })
    }
    next.onmessage = (event: MessageEvent) => {
      if (socket === next && typeof event.data !== 'string') emit({ type: 'message', data: new Uint8Array(event.data as ArrayBuffer) })
    }
    next.onerror = (error) => {
      if (socket === next) emit({ type: 'error', error })
    }
    next.onclose = (event: CloseEvent) => {
      if (socket !== next) return
      socket = null
      clearDrain()
      emit({ type: 'close', reason: event.reason })
      for (const listener of [...closedListeners]) listener(event.code, event.reason)
      if (TERMINAL_CODES.has(event.code)) wants = false
      if (wants && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          open()
        }, retry)
        retry = Math.min(retry * 2, MAX_RETRY_MS)
      }
    }
  }
  return {
    connect() {
      wants = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = null
      open()
    },
    disconnect() {
      wants = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = null
      clearDrain()
      const current = socket
      socket = null
      current?.close(1000, 'Disconnected')
    },
    send(data) {
      if (!socket || socket.readyState !== WebSocket.OPEN) return false
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        drainTimer ??= setInterval(() => {
          if (!socket || socket.bufferedAmount <= MAX_BUFFERED_BYTES) {
            clearDrain()
            emit({ type: 'drain' })
          }
        }, 50)
        return false
      }
      // 引擎会复用传进来的缓冲区:拷一份再发
      const owned = new Uint8Array(data.byteLength)
      owned.set(data)
      socket.send(owned)
      return true
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onClosed(listener) {
      closedListeners.add(listener)
      return () => closedListeners.delete(listener)
    },
  }
}
