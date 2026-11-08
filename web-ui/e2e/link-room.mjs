// 公开分享页 /s/:token 的假协作房间。
//
// 为什么需要:链接访问者(含没账号的游客)编辑笔记时,SharedDoc 一律走多人在线编辑——
// 后端的 info 里每个根都带 space_id,游客又不受「多人在线编辑」功能点约束(见 SharedDoc 的 collabAvailable)。
// 假后端只有 /api/v1/collab/ws 一个房间(collab-scenarios 用),没有 /api/v1/share/{token}/collab,
// 所以点「编辑」之后编辑器永远停在「正在连接」,场景一直等不到编辑器。SOLO_EDIT_FIXTURE 关的是登录用户的功能点,对游客无效。
//
// 这里用 collab-room.mjs 的房间状态机接上链接的 WebSocket,并让「落地」(客户端把最终 Markdown 提交给服务端)
// 同步回有状态的假后端:落地后 get_item 读到新正文,版本号 +1(后端 InsightRepo::update 的乐观锁也是这么走的)。
import { FakeRoom } from './collab-room.mjs'
import { installShareApi } from './share-fixture.mjs'

/** 每个浏览器上下文一个房间,场景里按上下文取回来看房间里的内容 */
const rooms = new WeakMap()
export const linkRoomOf = (tab) => rooms.get(tab.context())

/**
 * @param {object} initial  同 shareFixture 的第一个参数(publicLinks / spaces …)
 * @param {{ space: string, noteId: string, who?: { id: string, name: string }, writable?: boolean, base?: object, room?: object }} options
 *   space / noteId:房间对应哪个知识库的哪篇笔记(正文取它当前的内容做初始化);who:加入房间的人(缺省是游客「访客 3fa9」)
 */
export function linkRoomFixture(initial, options) {
  const who = options.who ?? { id: 'guest:访客 3fa9#3fa9c1', name: '访客 3fa9' }
  return {
    ...(options.base ?? {}),
    __after: async (context) => {
      const state = await installShareApi(context, initial)
      const note = state.spaces[options.space].notes[options.noteId]
      const control = { room: null, opened: 0, writable: options.writable ?? true }
      const room = new FakeRoom({
        kind: 'rich',
        markdown: note.text,
        // 落地 = 服务端把正文写进笔记并升一个版本;正文一字不差时不写(与 land_insight 一致:body_md 相同就返回「没写」)
        onLand: ({ markdown }) => {
          if (markdown === note.text) return
          note.text = markdown
          note.version = (note.version ?? 1) + 1
        },
        ...(options.room ?? {}),
      })
      control.room = room
      rooms.set(context, control)
      await context.routeWebSocket(/\/api\/v1\/share\/[^/]+\/collab/, (ws) => {
        control.opened += 1
        const conn = room.join(who, control.writable, {
          send: (bytes) => ws.send(Buffer.from(bytes)),
          close: (code, reason) => ws.close({ code, reason }),
        })
        ws.onMessage((message) => room.receive(conn, typeof message === 'string' ? new TextEncoder().encode(message) : new Uint8Array(message)))
        ws.onClose(() => room.leave(conn))
      })
    },
  }
}
