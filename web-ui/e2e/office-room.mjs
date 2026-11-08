#!/usr/bin/env node
/**
 * 假办公室房间：直接用 office-worker 的生产实现（`room.mjs` + `engines.mjs` + `agent.mjs`）。
 *
 * 为什么不用手抄的协议替身：办公文档房间（`/api/v1/office/collab`）是**纯 y-sync**，
 * 和笔记房间（`crates/kb-collab`，带 100/101 号控制消息）不是一套协议。
 * 引擎的 `CollaborationProvider` 见到 100 号控制帧会直接判帧非法、断开连接，
 * 所以这里让 e2e 跑真正的房间逻辑：协议、去抖落地、AI 走服务端副本的路径都和守护进程一致。
 */
import { agentEdit } from '../../office-worker/src/agent.mjs'
import { openReplica } from '../../office-worker/src/engines.mjs'
import { Room } from '../../office-worker/src/room.mjs'

/**
 * 开一个房间（服务端副本从这份底稿打开，和 office-worker 的 `openRoom` 一样）。
 * @param {object} options
 * @param {Uint8Array} options.bytes 底稿字节
 * @param {string} [options.format] 格式（xlsx / docx / pptx）
 * @param {string} [options.key] 房间键
 * @param {number} [options.clientId] 服务端副本的 clientId（别和浏览器撞）
 */
export async function startOfficeRoom({ bytes, format = 'xlsx', key = 'e2e:office', clientId = 9001 }) {
  const replica = await openReplica(format, new Uint8Array(bytes), { clientId, generation: 'kb:e2e' })
  /** 每次落地的文件字节（守护进程在这一步把文件写回磁盘） */
  const landed = []
  /** 浏览器连接 → 收发通道 */
  const sockets = new Map()
  const room = new Room({
    key,
    replica,
    host: {
      sendTo: (conn, frame) => sockets.get(conn)?.send(frame),
      broadcast: (except, frame) => {
        for (const [conn, socket] of sockets) if (conn !== except) socket.send(frame)
      },
      // 增量持久化不值得在这里模拟：房间关了以后没人再打开，落地字节才是要验的东西
      persist: () => {},
      compact: () => {},
      land: async (fileBytes) => {
        landed.push(fileBytes)
      },
      closed: () => {},
      status: () => {},
      log: (level, message) => console.log(`ROOM ${level} ${message}`),
    },
  })
  return {
    room,
    replica,
    landed,
    /**
     * 把一条浏览器 WebSocket 接进房间。
     * @param {object} ws Playwright 的 WebSocket 路由对象
     * @param {{ writable?: boolean, user?: { id: string, name: string } }} [options]
     */
    attach(ws, { writable = true, user = { id: 'usr_admin', name: '管理员' } } = {}) {
      sockets.set(ws, {
        send: (frame) => ws.send(Buffer.from(frame)),
        close: (code, reason) => ws.close({ code, reason }),
      })
      room.join(ws, { writable, user })
      ws.onMessage((message) =>
        room.frame(ws, typeof message === 'string' ? new TextEncoder().encode(message) : new Uint8Array(message)),
      )
      ws.onClose(() => {
        sockets.delete(ws)
        room.leave(ws)
      })
      return ws
    },
    /** 模拟 AI 的 `doc_edit`：在服务端副本上改，再作为服务端更新广播（office-worker 的 agent_edit 就是这么做的）。 */
    async agentEdit(edits, author = 'AI') {
      const before = replica.stateVector()
      const changed = await agentEdit(replica, edits, author)
      room.applyLocal(before)
      return changed
    },
    /** 模拟服务端主动关连接（权限被收回 4403、房间被关 4410…）：所有在线的浏览器都收到这个关闭码 */
    kickAll(code, reason) {
      for (const socket of sockets.values()) socket.close(code, reason)
    },
    close() {
      room.close()
    },
  }
}
