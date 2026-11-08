// WebSocket 关闭码 / 握手失败 → 该怎么办。
//
// 后端的关闭码(crates/kb-collab、kb-web/collab_ws.rs):
//   4403 权限被收回(此后不能再看到这篇文档)  4404 文档已删除  4409 文档在别处被改了(房间已作废,要重新打开)
//   4408 初始化者超时  1001 服务重启  1008 消息太频繁  1009 消息太大  1003 协议错误
//   1013 连接太慢 / 房间满 / 同时编辑的文档太多(原因写在 reason 里)
// 浏览器的 WebSocket **看不到**握手阶段的 HTTP 状态码(401/403/404/410/429/503 对页面一律是一次 1006 的失败),
// 所以握手失败单独归成 `handshake`,由调用方用别的接口去弄清原因(见 provider 的 diagnose)。

export type CloseKind =
  | 'restart'
  | 'denied'
  | 'deleted'
  | 'stale'
  | 'busy'
  | 'ratelimited'
  | 'too-big'
  | 'protocol'
  | 'init-timeout'
  | 'lost'
  | 'handshake'

export interface CloseInfo {
  kind: CloseKind
  /** 终止:不再自动重连,界面要给出结论和下一步 */
  terminal: boolean
  /** 给人看的话:出了什么事 + 怎么办 */
  message: string
}

/** 服务端自己写在 reason 里的话(中文)比我们猜的更准;ASCII 的通用原因不用 */
function serverSaid(reason: string): string {
  const text = reason.trim()
  return /[\u4e00-\u9fff]/.test(text) ? text : ''
}

export function classifyClose(code: number, reason: string, wasOpen: boolean): CloseInfo {
  if (!wasOpen) {
    return { kind: 'handshake', terminal: false, message: '连不上协作服务,正在重试。你的修改先留在本页,连上后会自动合并。' }
  }
  switch (code) {
    case 4403:
      return { kind: 'denied', terminal: true, message: '你已经没有这篇文档的访问权限,连接已断开。需要继续的话请联系文档所有者。' }
    case 4404:
      return { kind: 'deleted', terminal: true, message: '这篇文档已被删除。' }
    case 4409:
      return { kind: 'stale', terminal: true, message: '这篇文档刚在别处被修改(导入或接口写入),需要重新打开才能继续协作。本页里没来得及同步的修改不会保留。' }
    case 4408:
      return { kind: 'init-timeout', terminal: false, message: '文档初始化超时,正在重试。' }
    case 1001:
      return { kind: 'restart', terminal: false, message: '服务正在重启,几秒后自动重连。你的修改不会丢。' }
    case 1008:
      return { kind: 'ratelimited', terminal: false, message: '操作太频繁,连接被暂时断开,稍后自动重连。' }
    case 1009:
      return { kind: 'too-big', terminal: true, message: '一次修改太大,服务器没有接收。请把内容拆小一些再试。' }
    case 1003:
      return { kind: 'protocol', terminal: false, message: '协作连接出错了,正在重试。' }
    case 1013:
      return { kind: 'busy', terminal: false, message: serverSaid(reason) || '服务器暂时忙,正在重试。' }
    default:
      return { kind: 'lost', terminal: false, message: '连接断开了,正在重连。离线时的修改会在恢复后自动合并。' }
  }
}

/** 重连的等待时间:指数退避 + 抖动。busy / 限流多等一会儿,别把拥堵的服务器压得更狠。 */
export function backoffDelay(attempt: number, kind: CloseKind, random: () => number): number {
  const slow = kind === 'busy' || kind === 'ratelimited'
  const base = slow ? 2000 : 400
  const cap = slow ? 30_000 : 15_000
  const raw = Math.min(cap, base * 2 ** Math.min(attempt, 10))
  // ±25% 抖动:服务重启后所有客户端同时重连会再把它压垮
  return Math.round(raw * (0.75 + random() * 0.5))
}
