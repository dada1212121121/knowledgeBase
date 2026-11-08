// `/api/v1/ws` 的推送订阅:job.progress / job.done / item.changed / log。
// 全站共用**一条** WebSocket(引用计数):切页时旧页面卸载、新页面挂载,连接不会反复断开重建;
// 断线后按指数退避重连;最后一个订阅者离开后延迟 2s 才真正关闭(覆盖“切页瞬间 0 订阅”的空窗)。
import { onUnmounted } from 'vue'

export interface LiveEvent {
  type: string
  data: Record<string, unknown>
}

type Listener = (event: LiveEvent) => void

const MAX_BACKOFF = 15_000
const IDLE_CLOSE_MS = 2_000

const listeners = new Set<Listener>()
let socket: WebSocket | null = null
let backoff = 500
let reconnectTimer: number | undefined
let idleTimer: number | undefined
let wanted = false

function connect() {
  // 退避定时器可能在测试环境 / SSR 拆掉 window 之后才触发,此时直接放弃重连
  if (!wanted || socket || typeof window === 'undefined') return
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const next = new WebSocket(`${scheme}://${window.location.host}/api/v1/ws`)
  socket = next
  next.onopen = () => {
    backoff = 500
  }
  next.onmessage = (message) => {
    try {
      const event = JSON.parse(String(message.data)) as LiveEvent
      if (event.type === 'ping' || event.type === 'hello' || event.type === 'pong') return
      for (const listener of [...listeners]) listener(event)
    } catch {
      // 非 JSON 帧直接忽略(服务端只发 JSON)
    }
  }
  next.onclose = () => {
    if (socket === next) socket = null
    if (!wanted) return
    reconnectTimer = window.setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, MAX_BACKOFF)
  }
  next.onerror = () => next.close()
}

function shutdown() {
  wanted = false
  if (reconnectTimer) window.clearTimeout(reconnectTimer)
  reconnectTimer = undefined
  const current = socket
  socket = null
  current?.close()
}

/** 订阅服务端事件;返回一个取消函数。 */
export function subscribeLive(onEvent: Listener): () => void {
  listeners.add(onEvent)
  if (idleTimer) window.clearTimeout(idleTimer)
  idleTimer = undefined
  wanted = true
  connect()
  return () => {
    listeners.delete(onEvent)
    if (listeners.size === 0 && !idleTimer) {
      idleTimer = window.setTimeout(() => {
        idleTimer = undefined
        if (listeners.size === 0) shutdown()
      }, IDLE_CLOSE_MS)
    }
  }
}

/** 在组件里订阅;卸载时自动取消。 */
export function useLiveEvents(onEvent: Listener) {
  const stop = subscribeLive(onEvent)
  onUnmounted(stop)
  return stop
}
