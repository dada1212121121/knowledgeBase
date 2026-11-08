/**
 * Headless Office 引擎版本锁与公开入口注册表
 *
 * 工程铁律（见设计规范）：
 * 1. 全仓只有 `web-ui/src/editor/engines/` 目录允许 import `@betteroffice/{docx,xlsx,pptx}`。
 * 2. 版本精确锁死 `0.5.1`，package.json 严禁使用 `^` 或 `~`，防止小版本移除或改动 headless 导出。
 * 3. 升级引擎前必须先跑过 `npx vitest run src/editor/engines/contract.spec.ts` 与真实语料无损往返检查。
 */

/** 锁定的上游 headless 引擎版本 */
export const BETTEROFFICE_ENGINE_VERSION = '0.5.1' as const

/** 允许直接依赖的三个 headless 核心包及精确版本 */
export const LOCKED_ENGINE_PACKAGES = {
  '@betteroffice/docx': BETTEROFFICE_ENGINE_VERSION,
  '@betteroffice/xlsx': BETTEROFFICE_ENGINE_VERSION,
  '@betteroffice/pptx': BETTEROFFICE_ENGINE_VERSION,
} as const

/**
 * 经可行性核验通过的上游 0.5.1 真实公开导出契约。
 *
 * 说明：此表只登记「确实存在且我们后续阶段会调用」的入口。
 * 任何一项在升级后消失或改签名，`contract.spec.ts` 会立刻红灯，
 * 避免运行时才在用户面前白屏。
 */
export const VERIFIED_ENGINE_EXPORTS = {
  docx: {
    /** 主入口：解析 / 重打包 / 选择性保存（docx 无损往返的根基） */
    core: ['parseDocx', 'repackDocx', 'attemptSelectiveSave'] as const,
    /**
     * `/layout` 子路径只提供字体测量与选择门控原语，**不含任何分页入口**。
     * 这正是阶段 3「双模只读」的架构依据：轻只读走 docx-preview（0 WASM），
     * 高保真只读/编辑必须进 `docx_edit_wasm` 会话。
     */
    layout: [
      'createRustMeasureSource',
      'getRustTextEngine',
      'configureDefaultFonts',
      'resolveDefaultFontProvider',
      'resolveHeaderFooter',
    ] as const,
    /** `/layout/render`：真正把 DisplayPage 画到 Canvas 的入口 */
    layoutRender: ['drawDisplayPage', 'rasterizeDisplayListPages'] as const,
    /** `/worker`：编辑会话握手（spawn worker → command connection → edit session） */
    worker: ['createDocxCommandConnection', 'createDocxWorkerEditSession'] as const,
    /** `/editor`：常驻区域布局计算（增量重排，避免整篇重排） */
    editor: ['computeLayout', 'buildResidentRegionLayoutRequest', 'workerLayoutComputation'] as const,
    /** `/yrs`：协同文档（Yjs）与协同态回写 docx */
    yrs: ['createYrsSession', 'saveYrsDocx'] as const,
    /** `/collaboration`：传输无关的协同 Provider */
    collaboration: ['CollaborationProvider'] as const,
  },
  xlsx: {
    /** 主入口：WASM 初始化、按主线程 Handle 或 Worker Session 打开工作簿、画格子 */
    core: [
      'initWasm',
      'openWorkbook',
      'openWorkbookSession',
      'createWorkbookEditSession',
      'paintDisplayList',
      'renderXlsxMarkdown',
      'exportXlsxStructured',
    ] as const,
    /** 注意：xlsx 的协同 Provider 在 `/collaboration` 子路径，不在主入口 */
    collaboration: ['CollaborationProvider'] as const,
  },
  pptx: {
    /** 主入口：WASM 初始化、主线程 Handle、Worker 会话、绘制与导出 */
    core: [
      'initWasm',
      'openPresentation',
      'openPresentationSession',
      'createPptxWorkerEditorSession',
      'paintSlide',
      'slideToPng',
      'CollaborationProvider',
    ] as const,
  },
} as const

/**
 * PPTX Worker 编辑会话允许的操作集合（0.5.1 真实能力边界）。
 *
 * 关键结论：`createPptxWorkerEditorSession.apply(op)` 接受的是
 * `PresentationReplayOp`（即 `PresentationHandle` 同名方法 + 其参数），
 * 唯一被排除的是表格行/列增删四项（协同模式下上游本身就拒绝）。
 *
 * 因此 的「图层 / 对齐 / 形状」功能全部可以在这个 Worker 会话内完成，
 * 无需退回主线程 `openPresentation`。少踩一个大坑：不要再去找
 * `PresentationSession.call.addTextBox` —— 那条窄 API 只有 applyEdits。
 */
export const PPTX_WORKER_REPLAY_METHODS = [
  'insertText',
  'deleteText',
  'formatText',
  'setStoryParagraphs',
  'insertParagraphBreak',
  'setParagraphAlignment',
  'insertSlide',
  'duplicateSlide',
  'deleteSlide',
  'moveSlide',
  'setSlideNotes',
  'setSlideLayout',
  'addTextBox',
  'addShape',
  'addPicture',
  'removeShape',
  'moveShape',
  'resizeShape',
  'setShapeRect',
  'setShapeFill',
  'setShapeStroke',
  'setShapeAdjust',
  'bringShapeToFront',
  'sendShapeToBack',
  'bringShapeForward',
  'sendShapeBackward',
  'addComment',
  'replyToComment',
  'setCommentStatus',
  'setCommentPosition',
  'removeComment',
  'setCommentFlavor',
  'propose',
  'acceptProposal',
  'rejectProposal',
  'applyEdits',
  'addUndoBoundary',
  'undo',
  'redo',
] as const

/** PPTX Worker 会话在 0.5.1 明确不支持的操作（表格行列增删） */
export const PPTX_WORKER_UNSUPPORTED_METHODS = [
  'insertTableRow',
  'deleteTableRow',
  'insertTableColumn',
  'deleteTableColumn',
] as const

/**
 * XLSX 编辑通道的真实形态。
 *
 * `createWorkbookEditSession` 返回的 `WorkbookEditSession` 暴露公开的
 * `command(input: WorkbookCommand)` + `submit(kind, payload)` + `bindPresenter(echo)`
 * + `present(frame)`，因此我们**不需要**去碰未导出的 `WorkbookEditConnection` 内部结构，
 * 也不需要自己重写握手。 直接驱动 `command` 即等价于 `WorkbookHandle` 的编辑语义。
 */
export const XLSX_EDIT_CHANNEL = {
  sessionFactory: 'createWorkbookEditSession',
  commandEntry: 'command',
  submitEntry: 'submit',
  presenterHooks: ['bindPresenter', 'present'] as const,
  /** 主线程读取/命中测试用 Handle 入口 */
  handleEntry: 'openWorkbook',
  /** Worker 只读/预览用窄会话入口 */
  sessionEntry: 'openWorkbookSession',
} as const
