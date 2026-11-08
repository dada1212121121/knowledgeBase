/**
 * XLSX 协同接入
 *
 * 上游的 `CollaborationProvider` 只认一个二进制传输；本仓已有的
 * `src/editor/collab/officeRoomTransport.ts` 就是同一个协议（open/message/close/drain + 重连 + 背压），
 * 这里把它包成引擎层的 `XlsxCollabTransport`，避免 Surface 直接接触上游类型。
 *
 * 协同内容仍然落在房间的服务端副本上：本地不注册保存快照，也不标脏；
 * 房间关闭时由调用方展示明确原因，不能静默退回「看起来保存了」的单人模式。
 */
import { createOfficeTransport } from '@/editor/collab/officeRoomTransport'
import type { XlsxCollabOptions, XlsxCollabPeer, XlsxCollabStatus } from '../../engines/xlsx'

/** 服务端协同房间的文件大小上限；超过时 prepareOfficeSession 会返回 single + 原因 */
export const OFFICE_COLLAB_MAX_BYTES = 1.5 * 1024 * 1024

export interface XlsxCollabJoinOptions {
  /** `/api/v1/office/collab?doc=…` 的完整 ws(s) 地址 */
  url: string
  userName: string
  userColor?: string
  /** docx 的房间初始状态；xlsx 传 undefined */
  initialUpdate?: Uint8Array
  onStatus?: (status: XlsxCollabStatus) => void
  onClosed?: (code: number, reason: string) => void
}

/** 把浏览器 WebSocket 传输接到引擎；调用方负责在卸载时 destroy 工作簿 */
export function createXlsxCollabOptions(join: XlsxCollabJoinOptions): XlsxCollabOptions {
  const transport = createOfficeTransport(join.url)
  return {
    transport,
    user: { name: join.userName, ...(join.userColor ? { color: join.userColor } : {}) },
    initialUpdate: join.initialUpdate,
    onStatus: join.onStatus,
    onClosed: join.onClosed,
  }
}

/** 状态条文案：和旧岛保持同一套说法，用户不需要分辨新旧编辑器 */
export function xlsxCollabText(status: XlsxCollabStatus | null): string {
  if (!status) return ''
  const others = status.peers.length
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
  return `多人协同 · ${link}${error}${others ? ` · 另有 ${others} 人在编辑：${status.peers.slice(0, 3).map((peer) => peer.name).join('、')}${others > 3 ? ' 等' : ''}` : ''}`
}

/** 只保留当前工作表的远端光标；视图据此画别人的选区 */
export function peersOnSheet(peers: readonly XlsxCollabPeer[], sheetId: string | undefined): readonly XlsxCollabPeer[] {
  if (!sheetId) return []
  return peers.filter((peer) => peer.sheet === sheetId)
}

/** 文件超过 1.5 MB 时的统一提示；服务端已给出原因时优先用服务端的 */
export function collabLimitReason(bytes: number, serverReason?: string): string {
  if (serverReason) return serverReason
  const mb = (bytes / 1024 / 1024).toFixed(1)
  return `表格有 ${mb} MB，超过多人协同支持的 1.5 MB，已改为单人编辑`
}
