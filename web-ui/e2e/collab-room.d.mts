// collab-room.mjs 的类型声明(给 vitest 里的 TypeScript 用)。
import * as Y from 'yjs'

export interface RoomEndpoint {
  send(bytes: Uint8Array): void
  close(code: number, reason: string): void
}
export interface RoomConn {
  id: number
  who: { id: string; name: string }
  writable: boolean
  endpoint: RoomEndpoint
  joined: number
  awarenessId: number | null
}
export interface FakeRoomOptions {
  kind: 'text' | 'rich'
  /** 文本文档的初始正文 */
  text?: string
  /** 笔记需要初始化时发给初始化者的 Markdown */
  markdown?: string
  /** 笔记已经有协作状态(不需要初始化) */
  state?: boolean
  /** 落地被接受前的钩子,抛错 = 拒绝并回 rejected */
  onLand?: (landing: { markdown: string; sv: Uint8Array }) => void
}
export declare function colorOf(id: string): string
export declare class FakeRoom {
  constructor(options: FakeRoomOptions)
  kind: 'text' | 'rich'
  doc: Y.Doc
  conns: Map<number, RoomConn>
  lander: number | null
  init: unknown
  landed: { markdown: string; sv: string }[]
  rejected: { conn: number; reason: string }[]
  log: ({ conn: number } & Record<string, unknown>)[]
  updatesAccepted: number
  updatesDropped: number
  dirty: boolean
  lastLandedSv: Map<number, number> | null
  join(who: { id: string; name: string }, writable: boolean, endpoint: RoomEndpoint): RoomConn
  leave(conn: RoomConn): void
  kick(conn: RoomConn, code: number, reason: string): void
  removeUser(userId: string, reason?: string): void
  discard(code?: number, reason?: string): void
  setWritable(conn: RoomConn, writable: boolean): void
  lockReadonly(reason?: string): void
  landNow(): boolean
  sendCtrl(conn: RoomConn, ctrl: Record<string, unknown>): void
  receive(conn: RoomConn, bytes: Uint8Array): void
  text(): string
  richText(): string
}
export { Y }
