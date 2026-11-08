/**
 * 原生多格式编辑器模块统一对外入口（设计规范）
 *
 * 业务页面（DocPage / FileViewer 等）只允许从本入口导入 EditorHost 与公共契约与会话类型，
 * 严禁越过本层直接导入 engines/ 下的 @betteroffice/* 上游包，也不要直接摸 surfaces/ 内部实现。
 */
export { default as EditorHost } from './host/EditorHost.vue'
export { default as EditorChrome } from './host/EditorChrome.vue'
export { default as EditorStatus } from './host/EditorStatus.vue'

export * from './types'

export { CommandBus, History, EditorDocumentSession, SessionRegistry } from './session'
export {
  anchorKey,
  clampAnchor,
  dedupeAnchors,
  sameAnchor,
  shiftTextAnchor,
  sortTextAnchors,
  textAnchorRange,
  textAnchorsOverlap,
} from './session'
export type {
  AnchorBounds,
  CommandAuditRecord,
  CommandBusOptions,
  CommandHandler,
  EditorDocumentSessionOptions,
  HistoryEntry,
  HistoryOptions,
  HistoryRecordInit,
  HistoryStep,
  SessionFactory,
  SessionRegistryOptions,
  SessionSaveRequest,
  SessionTransport,
  TextEditRange,
} from './session'
