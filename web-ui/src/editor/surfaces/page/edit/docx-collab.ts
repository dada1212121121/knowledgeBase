/**
 * Word 协同接入：把房间地址、用户、初始状态打包成内容面认识的选项，并给状态条出文案。
 *
 * 与 xlsx（`grid/xlsx-collab.ts`）同一套约定：协同内容由服务端房间落地，本地不注册保存快照、不标脏；
 * 房间被服务端关掉（权限被收回、房间关了）要把原因明确展示出来，不能静默退回"看起来保存了"的单人模式。
 * docx 比 xlsx 多一件事：加入者必须带服务端给的初始状态（`initialUpdate`），因为每次打开 docx 引擎都会生成新的身份，
 * 两个浏览器从同一份字节各自打开得到的状态是不一样的。
 */
import { createOfficeTransport, type OfficeTransport } from '@/editor/collab/officeRoomTransport'
import type { DocxCollabStatus } from '../../../engines/docx'

export interface DocxCollabJoin {
  /** `/api/v1/office/collab?doc=…` 的完整 ws(s) 地址 */
  url: string
  userName: string
  userColor?: string
  /** 服务端发的房间初始状态（`/api/v1/office/seed`） */
  initialUpdate?: Uint8Array
  /** 房间里能不能改：false = 只能看（别人的修改实时看到，自己的修改被丢弃） */
  writable: boolean
  onStatus?: (status: DocxCollabStatus) => void
  onClosed?: (code: number, reason: string) => void
}

/** 内容面拿到的协同选项：传输已建好（重连 / 背压在传输里），clientId 是这个页面这次会话的身份 */
export interface DocxSurfaceCollab {
  transport: OfficeTransport
  clientId: number
  userName: string
  userColor?: string
  initialUpdate?: Uint8Array
  writable: boolean
  onStatus?: (status: DocxCollabStatus) => void
  onClosed?: (code: number, reason: string) => void
}

/** 31 位非零随机数：Yrs 的 clientId 是 u32，且 0 在部分实现里保留；取 31 位避免有符号溢出 */
export function randomClientId(random: (buffer: Uint32Array) => Uint32Array = (buffer) => crypto.getRandomValues(buffer)): number {
  return (random(new Uint32Array(1))[0]! & 0x7fffffff) || 1
}

export function createDocxCollabOptions(join: DocxCollabJoin, transportFactory: (url: string) => OfficeTransport = createOfficeTransport): DocxSurfaceCollab {
  return {
    transport: transportFactory(join.url),
    clientId: randomClientId(),
    userName: join.userName,
    userColor: join.userColor,
    initialUpdate: join.initialUpdate,
    writable: join.writable,
    onStatus: join.onStatus,
    onClosed: join.onClosed,
  }
}

/** 状态条文案：与 xlsx / 旧岛同一套说法，用户不需要分辨新旧编辑器 */
export function docxCollabText(status: DocxCollabStatus | null): string {
  if (!status) return ''
  const link =
    status.status === 'connected'
      ? status.synced
        ? '已同步'
        : '同步中…'
      : status.status === 'connecting'
        ? '连接中…'
        : status.status === 'destroyed'
          ? '连接已关闭'
          : '离线，修改会在连上后同步'
  const error = status.error ? `（${status.error}）` : ''
  const others = status.peers.length
  const names = status.peers
    .slice(0, 3)
    .map((peer) => peer.name)
    .join('、')
  return `多人协同 · ${link}${error}${others ? ` · 另有 ${others} 人在编辑：${names}${others > 3 ? ' 等' : ''}` : ''}`
}
