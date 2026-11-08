/**
 * 会话层统一出口
 * 上层只从这里取 Session / CommandBus / History / Anchors / Registry，不直接深入具体文件。
 */
export { CommandBus, isReadonlySafeCommand } from './CommandBus'
export type { CommandAuditRecord, CommandBusOptions, CommandHandler } from './CommandBus'

export { History } from './History'
export type { HistoryEntry, HistoryOptions, HistoryRecordInit, HistoryStep } from './History'

export {
  anchorKey,
  clampAnchor,
  dedupeAnchors,
  sameAnchor,
  shiftTextAnchor,
  sortTextAnchors,
  textAnchorRange,
  textAnchorsOverlap,
} from './Anchors'
export type { AnchorBounds, TextEditRange } from './Anchors'

export { EditorDocumentSession } from './DocumentSession'
export type {
  EditorDocumentSessionOptions,
  SessionSaveRequest,
  SessionTransport,
} from './DocumentSession'

export { SessionRegistry } from './SessionRegistry'
export type { SessionFactory, SessionRegistryOptions } from './SessionRegistry'
