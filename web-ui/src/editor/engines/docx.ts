/**
 * Word 编辑引擎适配层
 *
 * 工程铁律：全仓只有 `src/editor/engines/` 允许 import `@betteroffice/*`。本文件把上游的
 * 「同源 Worker → 打开文档 → 登记字体 → 命令连接 → 编辑会话」这条链收成一个普通函数 `openDocxEditSession`，
 * Surface 只看到本文件导出的类型与句柄，不碰上游类型。
 *
 * 流程（对应计划 的三步握手，行为改写自上游 `PeerlessDocxEditor.openResident`，Apache-2.0，见 NOTICE）：
 * 1. `new DocxSourceWorkerClient(同源模块 Worker)` + `prewarm`：Worker 与 wasm 常驻，整份文档只在 Worker 里一份；
 * 2. `openSource({ bytes })` 拿到文档元信息 → `fontRequirements` 读出排版要用的字体 → 登记字体字节（GB2312 裁剪版等）；
 * 3. `commandInit` 把字体与版面请求交给 Worker，换回第一帧；`createDocxCommandConnection` 得到命令连接；
 * 4. `createDocxWorkerEditSession`（见 docx/session.ts）装出 viewStore / admission / commands 等。
 *
 * 与上游的差别：
 * - Worker 由我们自己创建（docx/docx.worker.ts → vite alias → 上游 docxWorker.mjs），CSP `worker-src 'self'` 下可用，不依赖上游的 `new URL` 约定；
 * - 不做「先预览首页」（previewFirstPage）：它要在 React 里另挂一个预览画布；我们的首帧本来就由 `commandInit` 带回；
 * - 字体登记只在打开时和用户换字体时发生（安装的 0.5.1 没有「需求变化提示」事件）。
 */
import { DocxSourceWorkerClient, createDocxCommandConnection, discardCommandPresentation, SessionFailure } from '@betteroffice/docx/worker'
import type { DocxCommandCheckpoint, DocxCommandConnection, DocxCommandFrame, DocxCommandPageIdentity, DocxCommandSelection } from '@betteroffice/docx/worker'
import { residentCaretSnapshotForFrame } from '@betteroffice/docx/yrs'
import type { DocxFontEnvironment, YrsResidentFontRegistration } from '@betteroffice/docx/yrs'
import { applyFrameDelta, loadedRustDisplayListQueryEngine, loadRustDisplayListQueryEngine, type RetainedFrame } from '@betteroffice/docx/layout/render'
import { buildResidentRegionLayoutRequest } from '@betteroffice/docx/editor'
import { configureDefaultFonts, createRustMeasureSource, type ResidentFontRequirement } from '@betteroffice/docx/layout'
import { extractEmbeddedFontFaces } from '@betteroffice/docx/utils'
import type { Document } from '@betteroffice/docx/types/document'
import { createDocxEditSessionBinding, type DocxDocumentSource, type DocxEditSessionBinding, type DocxEditSessionOptions } from './docx/session'
import { fontEnvironmentForRegistrations, prepareWorkerFontEnvironment, uncoveredFontRequirements } from './docx/fonts'
import { createPrefetchSlot } from './docx/prefetchSlot'
import { KbDocxWorkerClient } from './docx/client'
import { prefetchHintedFonts, scanDocxFontHints, type FontHints, type HintFontProvider } from './docx/fontHints'
import { docxEditWasmModule, prefetchDocxWasm } from './docxWasm'
import type { FontDemand } from './fonts/docxFonts'
import { CaptureAborted, isPagePainted, waitUntil, type CapturedPage } from './docx/pageCapture'
import { reportFonts, type FontReport } from './docx/fontReport'
import { commandPageGeometry } from './docx/vendor/commandPageGeometry'
import { decodeCommandFrameDeltas } from './docx/vendor/frameDeltas'
import { flushAdmittedInput } from './docx/vendor/inputAdmission'
import { decodeSvgMedia, type SvgMediaDecode } from './docx/vendor/svgMedia'
import type { PeerlessFrameGeometry, PeerlessViewIdentity } from './docx/vendor/viewStore'
import { createPresentedPageQueries } from './docx/vendor/presentedPageQueries'
import { joinDocxCollaboration, type DocxCollabHandle, type DocxCollabJoinOptions } from './docx/collab'
import { resolveImageLayoutAttrs, type ImageLayoutCurrentAttrs, type ImageLayoutTarget } from './docx/vendor/imageLayout'

export type { DocxDocumentSource, DocxEditSessionBinding } from './docx/session'
export type { DocxCollabHandle, DocxCollabJoinOptions, DocxCollabStatus } from './docx/collab'
export { resolvePresenceColor } from './docx/collab'
export type { PeerlessFrameGeometry, PeerlessViewSnapshot, PeerlessViewStore, PeerlessProvisionalCaret } from './docx/vendor/viewStore'
export type { PeerlessInputAdmission, PeerlessAdmissionResult } from './docx/vendor/inputAdmission'
export type { PeerlessCommandBinding } from './docx/vendor/commandBinding'
export type { PeerlessCompositionState } from './docx/vendor/composition'
export type { DocxCommandFrame, DocxCommandPageIdentity }

/** 一页的几何（页边界 + 引擎给的页标识 + 已呈现的显示列表）；Surface 用来摆页、做命中 */
export type DocxPageGeometry = PeerlessFrameGeometry['pages'][number]
export type DocxEchoRect = { x: number; y: number; width: number; height: number }

/** 引擎 Worker 客户端：Surface 用它读文档、查找、导出页面；类型从引擎再导出，Surface 不直接 import 上游 */
export type DocxEngineClient = DocxSourceWorkerClient
export type DocxFontEnvironmentPayload = DocxFontEnvironment

/* ---------------- 命中查询（点击时的「临时光标」） ---------------- */

/**
 * 点击后光标要立刻跳到点击处，不能等 Worker 往返（一次约 20~50 ms）：用主线程已呈现页面的显示列表做命中查询，
 * 先画一个临时光标，帧回来再对账。查询引擎是另一份 wasm（layout，约 1.5 MB gzip），用到才加载；没加载好就不画临时光标。
 */
export type DocxPageQueries = ReturnType<typeof createPresentedPageQueries>
export const createDocxPageQueries = createPresentedPageQueries
export function docxQueryEngineReady(): boolean {
  return !!loadedRustDisplayListQueryEngine()
}
export function loadDocxQueryEngine(): Promise<void> {
  return loadRustDisplayListQueryEngine().then(() => undefined)
}

/** 页面坐标 (x, y) 处的文字命中，返回该处光标矩形（页面列坐标）；命中不在正文或页面没建好返回 null */
export function provisionalTextHitAtPoint(page: DocxPageGeometry, x: number, y: number, cache: DocxPageQueries): { caret: DocxEchoRect | null } | null {
  const engine = loadedRustDisplayListQueryEngine()
  if (!engine || !page.displayPage || page.displayPage.unbuilt) return null
  const queries = cache.get(page.displayPage)
  if (!queries) return null
  const hit = queries.hitTestRegions(0, x, y)
  if (hit?.region !== 'body' || hit.pos === null) return null
  const rect = queries.caretRect(hit.pos)
  return {
    caret:
      rect && rect.pageIndex === 0 && rect.height > 0
        ? { x: page.bounds.x + rect.x, y: page.bounds.y + rect.y, width: 1, height: rect.height }
        : null,
  }
}

/* ---------------- 协同：远端光标几何 ---------------- */

export interface DocxPresencePeer {
  clientId: number
  clock: number
  /** 对方广播的光标（字节编码的位置，主线程不解释） */
  cursor?: { story: string; anchor: Uint8Array; head: Uint8Array }
  /** 对方刚输入时由引擎推断出的位置（光标广播有延迟，输入的瞬间先用它贴住） */
  inferred?: { story: string; paraId: string; offset: number }
}

export interface DocxPresenceRect {
  pageId: string
  pageIndex: number
  x: number
  y: number
  width: number
  height: number
}

export interface DocxPresencePeerGeometry {
  clientId: number
  status: string
  caret?: DocxPresenceRect | null
  rects: DocxPresenceRect[]
}

export interface DocxPresenceGeometry {
  version: string
  frameEpoch: number
  layoutRevision: number
  peers: DocxPresencePeerGeometry[]
}

/**
 * 让引擎把"别人的光标位置"换算成页面上的矩形。
 * 必须带上当前文档版本 / 帧代次 / 版面版本：换算期间文档变了（有人又敲了字）结果就对不上当前画面，
 * 引擎会拒绝（返回 null），调用方丢掉这次结果等下一帧，不画一个错位的光标。
 */
export async function readDocxPresence(
  client: DocxEngineClient,
  request: { peers: readonly DocxPresencePeer[]; pages: readonly [number, number]; version: string; frameEpoch: number; layoutRevision: number },
): Promise<DocxPresenceGeometry | null> {
  const result = await client.documentReadAt(
    {
      kind: 'collabPresence',
      peers: request.peers.slice(0, 32).map((peer) => ({
        clientId: peer.clientId,
        clock: peer.clock,
        ...(peer.cursor ? { cursor: peer.cursor } : {}),
        ...(peer.inferred ? { inferred: peer.inferred } : {}),
      })),
      pages: [request.pages[0], request.pages[1]],
      expectVersion: request.version,
      expectFrameEpoch: request.frameEpoch,
      expectLayoutRevision: request.layoutRevision,
    } as never,
    request.version,
  )
  return result.status === 'ok' ? (result.value as unknown as DocxPresenceGeometry) : null
}

/* ---------------- 查找 / 替换 ---------------- */

export interface DocxFindMatch {
  text: string
  range: { story: string; start: { paraId: string; offset: number }; end: { paraId: string; offset: number }; view: string }
}

export interface DocxFindRect {
  pageId: string
  pageIndex: number
  x: number
  y: number
  width: number
  height: number
}

/** 在正文里按"接受修订后的文字"查找；`limit` 超出时 `truncated` 为真（调用方据此拒绝"替换全部"） */
export async function findDocxText(client: DocxEngineClient, query: string, limit: number): Promise<{ version: string; matches: DocxFindMatch[]; truncated: boolean }> {
  const reply = await client.documentRead({ kind: 'findText', request: { text: query, within: { kind: 'story', story: 'body' }, view: 'accepted', limit } } as never)
  const result = reply.value as unknown as { ok: boolean; version?: string; matches?: DocxFindMatch[]; truncated?: boolean; message?: string }
  if (!result.ok) throw new Error(result.message ?? '查找失败')
  return { version: result.version ?? reply.version, matches: result.matches ?? [], truncated: result.truncated === true }
}

/** 命中在页面上的矩形（每个命中可能跨行 / 跨页，所以是二维）；文档在换算期间变了返回 null */
export async function readDocxHighlights(
  client: DocxEngineClient,
  ranges: ReadonlyArray<{ story: string; start: { paraId: string; offset: number }; end: { paraId: string; offset: number } }>,
  version: string,
  frameEpoch: number,
  layoutRevision: number,
): Promise<DocxFindRect[][] | null> {
  if (!ranges.length) return []
  const result = await client.documentReadAt(
    { kind: 'rangeHighlights', ranges: ranges as never, expectVersion: version, expectFrameEpoch: frameEpoch, expectLayoutRevision: layoutRevision } as never,
    version,
  )
  if (result.status !== 'ok') return null
  const value = result.value as unknown as { rects: Array<Array<{ pageId: string; pageIndex: number; x: number; y: number; width: number; height: number }>>; unbuiltPages: number[] }
  return value.rects.map((group) => group.map((rect) => ({ pageId: rect.pageId, pageIndex: rect.pageIndex, x: rect.x, y: rect.y, width: rect.width, height: rect.height })))
}

/** 打开 / 关闭修订模式：之后所有输入、删除、格式、替换都带上作者，变成修订标记（作者 = null 关闭） */
export function setDocxSuggesting(engine: DocxEditEngine, author: string | null): void {
  engine.binding.admission.setSuggesting?.(author)
}

/* ---------------- 评论 / 修订快照 ---------------- */

export interface DocxReviewComment {
  id: string
  author: string
  date: string
  done: boolean
  parentId: string | null
  body: unknown
  /** 界面用的数字 id（`reviewTarget` 按它查）；引擎没给映射时为 undefined */
  uiId?: number
}

export interface DocxReviewRevision {
  revisionId: string
  author: string
  date: string
  /** insertion / deletion / pPrChange … */
  kind: string
  story: string
  /** 受影响文字的预览（最多 80 个字） */
  preview: string
  /** 修订在文档里的范围（同一段内的起止偏移）；侧栏据此把相邻的碎片合并成一条显示 */
  range?: { story: string; start: { paraId: string; offset: number }; end: { paraId: string; offset: number } }
}

export interface DocxReviewData {
  version: string
  comments: DocxReviewComment[]
  /** 评论 id → 它在页面上的第一块矩形（用来按文档顺序排序、点评论时滚过去）；页还没建的评论没有 */
  commentAnchors: Map<string, { pageIndex: number; y: number }>
  revisions: DocxReviewRevision[]
  /** 修订 id → 第一块矩形 */
  revisionAnchors: Map<string, { pageIndex: number; y: number }>
}

/** 读评论与修订。`reviewSnapshot` 是引擎一次性给的审阅快照（评论、修订、各自在页面上的矩形），读到的是同一个文档版本，不会半新半旧 */
export async function readDocxReview(client: DocxEngineClient): Promise<DocxReviewData> {
  const reply = await client.documentRead({ kind: 'reviewSnapshot' } as never)
  const snapshot = reply.value as unknown as {
    version: string
    comments: DocxReviewComment[]
    revisions: DocxReviewRevision[]
    commentIds?: Record<string, number>
    commentGeometry: Record<string, Array<{ pageIndex: number; y: number }>>
    revisionGeometry: Record<string, Array<{ pageIndex: number; y: number }>>
  } | null
  if (!snapshot) return { version: reply.version, comments: [], commentAnchors: new Map(), revisions: [], revisionAnchors: new Map() }
  const first = (geometry: Record<string, Array<{ pageIndex: number; y: number }>>) => new Map(Object.entries(geometry).flatMap(([id, rects]) => (rects[0] ? [[id, { pageIndex: rects[0].pageIndex, y: rects[0].y }] as const] : [])))
  return {
    version: snapshot.version,
    comments: snapshot.comments.map((comment) => ({ id: comment.id, author: comment.author, date: comment.date, done: comment.done, parentId: comment.parentId, body: comment.body, uiId: snapshot.commentIds?.[comment.id] })),
    commentAnchors: first(snapshot.commentGeometry ?? {}),
    revisions: snapshot.revisions.map((revision) => ({ revisionId: revision.revisionId, author: revision.author, date: revision.date, kind: revision.kind, story: revision.story, preview: revision.preview, range: revision.range })),
    revisionAnchors: first(snapshot.revisionGeometry ?? {}),
  }
}

/** 选区对应的可评论范围（含文档版本）；选区为空 / 不在正文返回 null */
export async function readCommentRange(client: DocxEngineClient, selection: DocxCommandSelection): Promise<{ version: string; range: unknown } | null> {
  const reply = await client.documentRead({ kind: 'commentSelectionRange', selection } as never)
  const range = reply.value as unknown as { story: string; start: { paraId: string; offset: number }; end: { paraId: string; offset: number } } | null
  if (!range) return null
  const inBody = range.story === 'body' || range.story.startsWith('body:')
  const empty = range.start.paraId === range.end.paraId && range.start.offset === range.end.offset
  return inBody && !empty ? { version: reply.version, range } : null
}

/**
 * 某条评论 / 修订锚着的范围，含命令要用的会话 id 和文档版本；已经不存在返回 null。
 * 三套 id 要分清：界面用数字 id（`Comment.id`），引擎会话里是字符串 id（命令 `updateComment/removeComment` 要它），
 * 修订另有自己的字符串 id。这里按界面 id 查，返回会话 id。
 */
export async function readReviewTarget(client: DocxEngineClient, target: { kind: 'comment'; uiId: number } | { kind: 'revision'; revisionId: string }): Promise<{ version: string; id: string; ranges: unknown[] } | null> {
  // 引擎的目标形状：评论是 `{ kind:'comment', id: 数字 }`，修订是 `{ kind:'revision', revisionId }`。
  // 我们对外的参数里评论叫 uiId（和字符串会话 id 区分），这里必须显式映射成引擎的字段名——
  // 曾经直接透传 `{ uiId }`，引擎认不得就返回 null，表现为"这条评论已经不在了"
  const engineTarget = target.kind === 'comment' ? { kind: 'comment' as const, id: target.uiId } : { kind: 'revision' as const, revisionId: target.revisionId }
  const reply = await client.documentRead({ kind: 'reviewTarget', target: engineTarget })
  const value = reply.value as unknown as { id: string; ranges: unknown[] } | null
  return value ? { version: reply.version, id: value.id, ranges: value.ranges } : null
}

/* ---------------- 全文读取（字数 / 大纲 / 纯文本导出） ---------------- */

export interface DocxStoryParagraph {
  paraId: string
  text: string
  outlineLevel?: number | null
}

/**
 * 一次读出正文故事的所有段落（含大纲级别）。字数、大纲、纯文本导出都从这里来。
 * 超过引擎单次读取上限（truncated）时返回已读到的部分并标记，调用方要如实说"统计不完整"，不能把半截当全部。
 */
export async function readDocxBody(client: DocxEngineClient): Promise<{ version: string; paragraphs: DocxStoryParagraph[]; truncated: boolean }> {
  const reply = await client.documentRead({ kind: 'readStories', request: { stories: ['body'], view: 'accepted' } } as never)
  const result = reply.value as unknown as {
    ok: boolean
    message?: string
    truncated?: boolean
    stories?: Array<{ story: string; paragraphs: Array<{ paraId: string; text: string; outlineLevel?: number | null }> }>
  }
  if (!result.ok) throw new Error(result.message ?? '读取全文失败')
  const body = (result.stories ?? []).find((story) => story.story === 'body')
  return {
    version: reply.version,
    paragraphs: (body?.paragraphs ?? []).map((paragraph) => ({ paraId: paragraph.paraId, text: paragraph.text, outlineLevel: paragraph.outlineLevel ?? null })),
    truncated: result.truncated === true,
  }
}

/* ---------------- 无损探针 ---------------- */

/**
 * 在一个隔离的临时会话里对文档做一次真实的探针编辑（文首插入一个标记字符）并保存，返回保存出的字节。
 *
 * 为什么必须是"真实编辑"：引擎对没改过的文档保存时原样返回原件字节，"不改保存"永远显示无损，
 * 看不见引擎重写 document.xml 时丢东西（实测一份流程图会丢锚定在空段落里的浮动形状）。
 * 为什么是隔离的临时会话：探针不能混进用户要编辑的文档（撤销栈、脏标记、协同状态都不该被碰），
 * 用完立刻释放；页面画布给一个不挂进 DOM 的空壳，不画任何东西。
 * 这一步会再解析一遍文档并占一个临时 Worker，所以结论要按原件 sha256 缓存（见 codecs/docxRoundtrip.ts）。
 */
export async function probeDocxSave(bytes: Uint8Array, marker: string, signal?: AbortSignal): Promise<Uint8Array> {
  const canvases = new Map<string, HTMLCanvasElement>()
  const engine = await openDocxEditSession({
    bytes,
    readOnly: false,
    skipFontCompletion: true,
    signal,
    canvasForPage: (page) => canvases.get(page.pageId) ?? null,
    ensureCanvas: (page) => {
      if (!canvases.has(page.pageId)) canvases.set(page.pageId, document.createElement('canvas'))
    },
    onError: () => undefined,
  })
  try {
    const { binding } = engine
    // 光标默认在文首：直接插入。fence 让它不被合并、保存前一定落到引擎
    const held = binding.commands.submit({ kind: 'insertText', payload: { text: marker } }, { fence: true })
    const admitted = held.status === 'held' ? await held.released : held
    if (admitted.status !== 'submitted') throw new Error('探针编辑没有被引擎接收')
    const outcome = await admitted.ticket.ack
    if (outcome.status !== 'applied') throw new Error(`探针编辑被引擎拒绝（${outcome.reason ?? outcome.status}）`)
    return await engine.save()
  } finally {
    engine.dispose()
    for (const canvas of canvases.values()) {
      canvas.width = 0
      canvas.height = 0
    }
    canvases.clear()
  }
}

/* ---------------- 整页位图（打印 / 缩略图） ---------------- */

export interface RasterizeDocxOptions {
  /** 光栅倍数：1 ≈ 96 dpi。打印用 2（约 192 dpi，纸面清晰），缩略图用 0.25 */
  scale: number
  /** 只取这些页（页序号，从 0 起）；不传取整篇。缩略图按需取可见的几页 */
  pages?: readonly number[]
  signal?: AbortSignal
  /** 每取完一页调用：已完成页数 / 总页数 */
  onProgress?(done: number, total: number): void
  /** 单页等待上限，默认 20 秒（含大图的页光栅较慢） */
  pageTimeoutMs?: number
}

/**
 * 把页位图铺在白纸上，返回一块新画布（调用方拥有，用完置零尺寸释放）。
 * 引擎画出来的页位图是**透明背景的墨层**（实测一页只有约 1% 的像素不透明，其余全透明）：屏幕上的白纸是页面容器的
 * CSS 背景（`#fff`），不在位图里。直接导出透明 PNG 去打印，「打印为 PDF」等路径常把透明画成黑底，文字就看不见了。
 * 所以导出前先铺白——这与屏幕所见一致（屏幕上页面背景也是固定白色，不由位图承载）。缩略图同理：深色主题下
 * 透明位图会透出栏的深色底，页面颜色就变了（"深色模式只改界面，不改文档页面颜色"）。
 */
function flattenCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const flat = document.createElement('canvas')
  flat.width = source.width
  flat.height = source.height
  const context = flat.getContext('2d')
  if (!context) {
    flat.width = 0
    flat.height = 0
    throw new Error('无法创建页位图画布')
  }
  context.fillStyle = '#fff'
  context.fillRect(0, 0, flat.width, flat.height)
  context.drawImage(source, 0, 0)
  return flat
}

/** 一个隔离的只读光栅会话：开一次、逐页取位图（打印一次性用，缩略图常驻用） */
export interface DocxRasterSession {
  /** 排版稳定后的最终页数 */
  readonly pageCount: number
  /** 每页的版面尺寸（px，未缩放；与屏幕编辑视图的页几何同一口径） */
  readonly pageSizes: ReadonlyArray<{ width: number; height: number }>
  /**
   * 取第 `index` 页（0 起）的位图：铺白、尺寸 = 版面尺寸 × 打开时的光栅倍数。
   * 返回独立画布，所有权归调用方；引擎那块画布取走后立刻释放（峰值内存只有一页）。
   * 会话是串行的：同一时刻只能取一页（调用方保证，如生成队列"一次一项"）。
   */
  rasterize(index: number, signal?: AbortSignal): Promise<HTMLCanvasElement>
  dispose(): void
}

export interface OpenDocxRasterSessionOptions {
  /** 光栅倍数：1 ≈ 96 dpi */
  scale: number
  signal?: AbortSignal
  /** 单页等待上限，默认 20 秒（含大图的页光栅较慢） */
  pageTimeoutMs?: number
  /** 等整篇排版完成的上限，默认 60 秒 */
  layoutTimeoutMs?: number
}

/**
 * 在一个隔离的只读临时会话里逐页取整页位图（`rasterizeDisplayListPages` 的对应实现）。
 *
 * 为什么是隔离会话而不是借用屏幕上那个：
 * - 逐页取要不断改「当前显示哪几页」（`setDisplayWindow`），会把用户正在看的页窗口和画布搅乱；
 * - 会话层只有一个帧监听槽，另挂一个监听会顶掉屏幕渲染自己的；
 * - 隔离会话基于调用时刻的字节快照，打印 / 生成缩略图途中用户继续编辑也不会取到半新半旧的页。
 * 代价是多开一个 Worker 会话（wasm 已缓存，约几秒），对打印这种低频操作和后台缩略图可以接受。
 *
 * 引擎本来就会把页面位图画到 `canvasForPage` 给的画布上，这里直接读那块画布（尺寸被引擎改成位图尺寸即说明画上了），
 * 取走位图后立刻把画布缩成 0×0 释放内存：20 页同时驻留几百 MB 是没必要的。
 */
export async function openDocxRasterSession(bytes: Uint8Array, options: OpenDocxRasterSessionOptions): Promise<DocxRasterSession> {
  const { signal, scale } = options
  const pageTimeout = options.pageTimeoutMs ?? 20_000
  const canvases = new Map<number, HTMLCanvasElement>()
  const release = () => {
    for (const canvas of canvases.values()) {
      canvas.width = 0
      canvas.height = 0
    }
    canvases.clear()
  }
  const engine = await openDocxEditSession({
    bytes,
    readOnly: true,
    // 输出（打印 / 缩略图）一个字形都不能缺，不走「先核心后补全」
    fullFonts: true,
    signal,
    getRasterScale: () => scale,
    canvasForPage: (page) => canvases.get(page.pageIndex) ?? null,
    ensureCanvas: (page) => {
      if (!canvases.has(page.pageIndex)) canvases.set(page.pageIndex, document.createElement('canvas'))
    },
    onError: () => undefined,
  })
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    engine.dispose()
    release()
  }
  try {
    const { viewStore } = engine.binding
    const geometry = () => viewStore.getSnapshot().geometry
    // 引擎为了首屏快，首帧只排前 3 页（`layoutProvisional`，页数是估的）。补全不是自己发生的：
    // 实测要有一次视口请求，Worker 才接着把整篇排完——屏幕会话打开时必然设一次光栅倍数，所以从来看不到这个临时态；
    // 隔离会话什么都不做就会一直停在「3 页」，把 20 页的文档只印 3 页。所以这里和屏幕一样主动发一次。
    // （这是实测出来的行为，不是文档承诺的；将来引擎变了会表现为下面「文档排版」等待超时，报错会点明卡在排版）
    engine.binding.setRasterScale(scale)
    // 首帧几何到达，且布局不再是临时的、页数连续 600 ms 不变：此时的页数才是最终页数（页数不准就会少印页）
    let lastCount = -1
    let stableSince = 0
    await waitUntil(
      () => {
        const current = geometry()
        if (!current || current.layoutProvisional || !current.pages.length) return false
        if (current.pages.length !== lastCount) {
          lastCount = current.pages.length
          stableSince = Date.now()
          return false
        }
        return Date.now() - stableSince >= 600
      },
      { what: '文档排版', timeoutMs: options.layoutTimeoutMs ?? 60_000, signal },
    )
    const pageSizes = geometry()!.pages.map((item) => ({ width: item.bounds.width, height: item.bounds.height }))
    return {
      pageCount: pageSizes.length,
      pageSizes,
      async rasterize(index, rasterSignal) {
        if (disposed) throw new CaptureAborted()
        const abort = rasterSignal ?? signal
        if (abort?.aborted) throw new CaptureAborted()
        engine.binding.setDisplayWindow(index, index + 1)
        // 会话在等的途中被关掉（文档改了、栏关了）：画布已被置零，`isPagePainted` 会把 0×0 误判成"画好了"，所以要先看会话是否还活着
        await waitUntil(
          () => {
            if (disposed) return true
            const canvas = canvases.get(index)
            return !!canvas && isPagePainted(canvas)
          },
          { what: `第 ${index + 1} 页的位图`, timeoutMs: pageTimeout, signal: abort },
        )
        if (disposed) throw new CaptureAborted()
        const canvas = canvases.get(index)!
        try {
          return flattenCanvas(canvas)
        } finally {
          // 取走就释放：峰值内存只有一页
          canvas.width = 0
          canvas.height = 0
          canvases.delete(index)
        }
      },
      dispose,
    }
  } catch (error) {
    dispose()
    throw error
  }
}

/**
 * 一次性取一批整页位图（打印用，PNG data URL）：开一个隔离会话、逐页取、关会话。
 * 要反复取页（缩略图）用 `openDocxRasterSession`，会话常驻，不用每次重开。
 */
export async function rasterizeDocxPages(bytes: Uint8Array, options: RasterizeDocxOptions): Promise<CapturedPage[]> {
  const { signal, scale } = options
  const session = await openDocxRasterSession(bytes, { scale, signal, pageTimeoutMs: options.pageTimeoutMs })
  try {
    const total = session.pageCount
    const wanted = (options.pages ?? Array.from({ length: total }, (_, index) => index)).filter((index) => index >= 0 && index < total)
    const captured: CapturedPage[] = []
    for (const index of wanted) {
      if (signal?.aborted) throw new CaptureAborted()
      const canvas = await session.rasterize(index, signal)
      try {
        captured.push({ index, width: canvas.width, height: canvas.height, dataUrl: canvas.toDataURL('image/png') })
      } finally {
        canvas.width = 0
        canvas.height = 0
      }
      options.onProgress?.(captured.length, wanted.length)
    }
    return captured
  } finally {
    session.dispose()
  }
}

/* ---------------- 读文档文本 ---------------- */

export interface DocxTextPage {
  /** 本页的段落文本（按文档顺序，每段一项；批注 / 修订按「接受后」的视图） */
  text: string[]
  /** 文档段落总数 */
  total: number
}

/**
 * 从引擎读一页段落文本（无障碍「读取文档文本」面板、查找与 AI 读取共用）。
 * 为什么分页：整篇一次读会让几百页的文档卡住 Worker 的消息队列；上游同样每次只读 32 段。
 * 读的过程中文档被改了（版本令牌对不上）就抛错，调用方重读，不拼出半新半旧的文本。
 */
export async function readDocxText(client: DocxEngineClient, offset = 0, limit = 32): Promise<DocxTextPage> {
  const identities = (await client.documentRead({ kind: 'paragraphIdentities' })).value
  const paragraphs = identities.paragraphs.flatMap(({ session }) => (session ? [session] : []))
  // 同一个故事（正文 / 页眉 / 脚注）的段落一起读，减少往返
  const groups = new Map<string, typeof paragraphs>()
  for (const paragraph of paragraphs.slice(offset, offset + limit)) {
    const group = groups.get(paragraph.story) ?? []
    group.push(paragraph)
    groups.set(paragraph.story, group)
  }
  const text: string[] = []
  let token: string | undefined
  for (const [story, group] of groups) {
    const result = await client.documentRead({
      kind: 'readParagraphs',
      request: { story, paraIds: group.map(({ paraId }) => paraId), view: 'accepted' },
    })
    if (!result.value.ok) throw new Error('文档文本暂时读不出来')
    if (token && token !== result.version) throw new Error('读取过程中文档被修改了，请重试')
    token = result.version
    text.push(...result.value.paragraphs.map((paragraph) => paragraph.text))
  }
  return { text, total: paragraphs.length }
}

/* ---------------- 图片（缩放 / 环绕） ---------------- */

export type { ImageLayoutTarget } from './docx/vendor/imageLayout'
export { pictureInSelection as selectedPictureOf } from './docx/vendor/pictureDrag'

/** 引擎当前选中对象的属性（图片的版式 / 位置 / 尺寸…）；选区不是对象时返回 null */
export async function readSelectedObjectAttrs(client: DocxEngineClient, selection: DocxCommandSelection): Promise<Record<string, unknown> | null> {
  const result = (await client.documentRead({ kind: 'properties', target: { kind: 'objectSelection', selection } as never })).value
  return result && result.kind === 'object' ? result.properties : null
}

/**
 * 环绕方式 → 对象属性补丁。字段集合与上游 `buildImageWrapPatch`（useWorkerPropertyDialogs.tsx）一致：
 * `wrap` / `wrapType` 两个名字都要写，引擎读前者、渲染读后者；`dist*` 只在版式变化时才带。
 */
export function buildImageWrapPatch(current: Record<string, unknown>, target: ImageLayoutTarget): Record<string, unknown> {
  const next = resolveImageLayoutAttrs(target, current as ImageLayoutCurrentAttrs)
  return {
    wrap: next.wrapType,
    wrapType: next.wrapType,
    displayMode: next.displayMode ?? null,
    cssFloat: next.cssFloat ?? null,
    wrapText: next.wrapText ?? null,
    position: next.position ?? null,
    ...('distTop' in next ? { distTop: next.distTop ?? null } : {}),
    ...('distBottom' in next ? { distBottom: next.distBottom ?? null } : {}),
    ...('distLeft' in next ? { distLeft: next.distLeft ?? null } : {}),
    ...('distRight' in next ? { distRight: next.distRight ?? null } : {}),
  }
}

/* ---------------- 字体 ---------------- */

let fontsConfigured = false

/**
 * 字体提供器模块（`docxFonts` + 上游 `@betteroffice/fonts` 两个 chunk）只加载一次。
 * 为什么要能提前加载：以前它在 `fontRequirements` 回来、真正要字体的那一刻才动态引入，两个 chunk 串行（先 docxFonts 再 fonts，
 * 慢网络下约 2 个往返）并且正好挡在「登记字体 → commandInit」的关键路径上；现在打开 / 悬停时就并行取，等到要用时已经在内存里。
 */
type FontsApi = typeof import('./fonts/docxFonts')
type FontsPackage = Awaited<ReturnType<FontsApi['loadFontsModule']>>
let fontsLoaded: Promise<{ api: FontsApi; fonts: FontsPackage }> | null = null
function loadFonts() {
  fontsLoaded ??= (async () => {
    const [api, fonts] = await Promise.all([import('./fonts/docxFonts'), import('@betteroffice/fonts')])
    return { api, fonts }
  })().catch((error) => {
    // 失败不缓存，下一次排版重试
    fontsLoaded = null
    throw error
  })
  return fontsLoaded
}

/**
 * 字体投机预取：WASM 到位的同一刻，按文档包里估出来的字体需求开始下载（线索与取舍见 docx/fontHints.ts）。
 * 先等 WASM 再下字体：WASM 是最长的一段，让它独占链路；字体下载正好和引擎解析文档（约 0.55 s）并行。
 * 任何一步失败都忽略——这只是优化，真正的字体需求出来后照旧加载。
 */
async function prefetchFontsFor(scan: Promise<FontHints | null>, demand: FontDemand): Promise<void> {
  try {
    const [hints, { api, fonts }] = await Promise.all([scan, loadFonts(), docxEditWasmModule().catch(() => undefined)])
    if (!hints) return
    prefetchHintedFonts(api.createShippedProvider(fonts, demand) as unknown as HintFontProvider, hints)
  } catch {
    // 同上
  }
}

/**
 * 装好 Word 的字体提供器（全局一次）。
 * 为什么走 `configureDefaultFonts`：上游测量源在没有显式 provider 时去取全局默认；
 * 我们的默认是 `engines/fonts/docxFonts.ts` 的包装——简体/日文走 GB2312 裁剪版（省约 10 MB 首开传输），其余原样交给上游。
 * 默认提供器不知道文档内容，取完整字体；引擎会话自己按文档需求建提供器（见 openDocxEditSession 的 demand）。
 */
export function configureDocxFonts(): void {
  if (fontsConfigured) return
  fontsConfigured = true
  configureDefaultFonts({ load: () => loadFonts().then(({ api, fonts }) => ({ createFontProvider: () => api.createShippedProvider(fonts) })) })
}

/* ---------------- Worker ---------------- */

/** 创建一个常驻的引擎 Worker 客户端（同源模块 Worker）；悬停预取时可以提前创建并交给 openDocxEditSession 复用 */
export function createDocxEngineClient(): DocxEngineClient {
  const worker = new Worker(new URL('./docx/docx.worker.ts', import.meta.url), { type: 'module', name: 'kb-docx-edit' })
  // 用我们的子类：`warm` 直接把页面里编译好的引擎模块交给 Worker（见 docx/client.ts、docxWasm.ts）
  return new KbDocxWorkerClient(worker as never)
}

/** 提前把 wasm 下载并编译进 Worker（悬停「编辑」按钮时空闲调用）；返回的客户端交给 `openDocxEditSession({ client })` */
export async function prewarmDocxEngine(): Promise<DocxEngineClient> {
  const client = createDocxEngineClient()
  try {
    await client.prewarm()
  } catch (error) {
    client.destroy()
    throw error
  }
  return client
}

/* ---------------- 悬停预取 ---------------- */

/** 首屏之后多久开始补全字体：让首屏的下载、排版、缩略图先走完，补全的下载和重新登记不去抢它们 */
const FONT_COMPLETION_DELAY_MS = 1200

/** 悬停离开后等多久还没人认领就销毁：够用户移开再回来、或鼠标到点击之间的犹豫 */
const PREFETCH_IDLE_MS = 8000

/** 槽的状态机见 docx/prefetchSlot.ts；这里只负责"预取的是什么"：一个已预热的引擎 Worker 客户端 */
const prefetchSlot = createPrefetchSlot<{ client: DocxEngineClient; ready: Promise<void>; destroy(): void }>(() => {
  const client = createDocxEngineClient()
  return { client, ready: client.prewarm(), destroy: () => client.destroy() }
}, PREFETCH_IDLE_MS)

/**
 * 悬停「编辑 / 高保真审阅」或已经点开在线编辑时调用；幂等。返回是否发起了新的 Worker 预取。
 * 一次开始三件互不依赖的事：引擎 WASM 下载 + 编译、字体提供器 chunk、建 Worker 并预热——
 * 以前是「chunk → Worker → WASM → 字体提供器」一条线（瀑布图见 docxWasm.ts 的说明）。
 */
export const prefetchDocxEngine = (): boolean => {
  prefetchDocxWasm()
  configureDocxFonts()
  void loadFonts().catch(() => undefined)
  return prefetchSlot.start()
}

/** 鼠标移开时调用：宽限期内没被认领就销毁 */
export const releaseDocxPrefetch = (): void => prefetchSlot.release()

/** 点击打开时认领预取的客户端交给 `openDocxEditSession({ client })`；没有或预热失败返回 undefined（调用方照常新建） */
export async function takePrefetchedDocxEngine(): Promise<DocxEngineClient | undefined> {
  return (await prefetchSlot.take())?.client
}

/* ---------------- 会话 ---------------- */

export interface OpenDocxEditSessionOptions {
  /** 文档字节（ownership 交给引擎：内部会拷贝一份发给 Worker） */
  bytes: Uint8Array
  readOnly: boolean
  /** 取当前光栅缩放（设备像素比 × 页面缩放） */
  getRasterScale?: () => number
  /** 页面画布：已经存在的返回，不存在返回 null（引擎在恢复阶段用） */
  canvasForPage(page: DocxCommandPageIdentity): HTMLCanvasElement | null
  /** 为帧里新出现的页面创建画布；引擎在接受一帧的几何之后对它的暂存页逐个调用 */
  ensureCanvas(page: DocxCommandPageIdentity): void
  /** 协同房间：一份底稿、多个副本；joiner 传服务端发的 `initialUpdate` */
  collab?: { clientId: number; initialUpdate?: Uint8Array; clientClock?: number }
  /** 协同时图片按包里的部件引用，不进协同状态（否则一份带截图的手册状态有几十 MB） */
  mediaTokens?: boolean
  heapLimitBytes?: number
  /**
   * 要完整字体（打印 / 缩略图 / 导出：输出必须一个字形都不缺）。默认按文档用到的字形取「核心 + 需要的扩展包」，
   * 编辑会话在首屏之后再补全（见 `completeFonts`）。
   */
  fullFonts?: boolean
  /** 不要在首屏之后补全字体（无损探针这类不画给人看的临时会话：字形缺不缺不影响它保存出的字节，补全只是白占 CPU 和带宽） */
  skipFontCompletion?: boolean
  /** 复用已经预热的客户端（悬停预取），不传则新建 */
  client?: DocxEngineClient
  /** 取消打开 */
  signal?: AbortSignal
  onError(error: Error): void
  onRecoverableError?(error: Error): void
  /** 文档用到的字体族（打开后给字体选择器和「缺字体」提示用） */
  onFamilies?(families: string[]): void
}

/** 一个就绪的 Word 编辑会话 */
export interface DocxEditEngine {
  binding: DocxEditSessionBinding
  client: DocxEngineClient
  /** 把还没提交的输入落到引擎，然后取出整份 docx 的字节 */
  save(): Promise<Uint8Array>
  /** 等输入准入与会话里的命令都落地（保存、读文档前调用） */
  flush(): Promise<void>
  /** 文档里用到的字体族 */
  families(): string[]
  /**
   * 文档字体的支持情况：哪些字体随站点提供、哪些是近似、哪些缺失。
   * 读文档的字体表与内嵌字体，再用字体包自己的别名表判断——不另抄一份族名表，免得与包的真实能力漂移。
   */
  fontReport(): Promise<FontReport>
  /** 用户选了新字体：准备好该字体的登记环境，调用方再提交 `setFontEnvironment`，成功后调 `fontEnvironmentApplied` */
  prepareFontFamily(family: string): Promise<DocxFontEnvironmentPayload>
  fontEnvironmentApplied(environment: DocxFontEnvironmentPayload): void
  /**
   * 把字体补成完整的（首屏用的是文档用到的字形，见 OpenDocxEditSessionOptions.fullFonts）：下载剩下的扩展包、
   * 重新登记字体环境。排版用的度量一直是完整的，所以补全不会让排版变化，只是之前没到位的字形轮廓补上。
   * 幂等；会话销毁时放弃。编辑会话打开后自动安排，只读会话被放开编辑时由外层再调一次。
   */
  completeFonts(): Promise<void>
  /** 引擎副本实际使用的协同 clientId（没开协同为 undefined） */
  collabClientId(): number | undefined
  /**
   * 加入协同房间：建副本与 Provider、接传输、连接。会话只能加入一次；`leave` 后可以再加入（重新连接）。
   * 传输由调用方提供（`collab/officeRoomTransport.ts`）。只读会话也可以加入：能看到别人的改动和光标，自己的修改会被引擎拒绝。
   */
  joinCollaboration(options: DocxCollabJoinOptions): DocxCollabHandle
  /** 崩溃恢复或销毁；幂等 */
  dispose(): void
}

type ResidentResume = NonNullable<DocxEditSessionOptions['recovery']> extends { reopen(input: infer I): unknown } ? I : never

/**
 * 打开一个 Word 编辑会话。失败时抛错（同时已调用 `onError`）；成功返回的引擎需要调用方 `dispose`。
 */
export async function openDocxEditSession(options: OpenDocxEditSessionOptions): Promise<DocxEditEngine> {
  configureDocxFonts()
  // 这次打开的文档要字体里的哪些字形：字节已经在手，不等引擎告诉我们字体需求，先扫一遍文档包（几十毫秒）——
  // 既决定下载哪些字体扩展包，也让字体下载和 WASM 下载 / 文档解析并行（预取）。扫不出来就取完整字体，不冒险。
  const demand: FontDemand = { ready: Promise.resolve(), chars: null, full: options.fullFonts === true }
  if (!demand.full && options.bytes?.byteLength) {
    const scan = scanDocxFontHints(options.bytes)
    demand.ready = scan.then((hints) => {
      demand.chars = hints ? hints.chars : null
    })
    void prefetchFontsFor(scan, demand)
  }
  /** 本会话的字体提供器：随 demand 变化（补全时 full 翻成 true，之后加载函数给完整字体） */
  const sessionProvider = async () => {
    const { api, fonts } = await loadFonts()
    return api.createShippedProvider(fonts, demand)
  }
  const controller = new AbortController()
  if (options.signal) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  const getRasterScale = options.getRasterScale ?? (() => 1)

  // 当前连接的状态；崩溃恢复会换掉它们
  let client: DocxEngineClient | null = null
  let releaseResident: (() => void) | null = null
  let identity: PeerlessViewIdentity | null = null
  let retained: RetainedFrame | null = null
  let prepared = new WeakMap<DocxCommandFrame, PeerlessFrameGeometry>()
  let sourceComments: unknown[] = []
  let fontSource: {
    document: Document
    layoutInput: string
    families: string[]
    requirements: ResidentFontRequirement[]
  } | null = null
  let preloaded: DocxEngineClient | undefined = options.client
  let effectiveClientId: number | undefined = options.collab?.clientId

  /** 打开一条到 Worker 的命令连接（也用于崩溃后的重开，此时带 resume） */
  const openResident = async (
    input: DocxDocumentSource,
    signal: AbortSignal,
    rasterScale?: () => number,
    resume?: ResidentResume,
  ): Promise<DocxCommandConnection> => {
    signal.throwIfAborted()
    const checkpoint = (resume as { checkpoint?: DocxCommandCheckpoint } | undefined)?.checkpoint
    if (checkpoint && !checkpoint.recoveryState) {
      throw new SessionFailure('message', 'Cannot restore DOCX checkpoint command-local state and proposals')
    }
    releaseResident?.()
    const resident: DocxEngineClient = (resume ? undefined : preloaded) ?? createDocxEngineClient()
    preloaded = undefined
    client = resident
    // 登记的字体字节与槽位：Worker 用槽位号引用字体，主线程只在打开阶段持有字节
    const fonts: YrsResidentFontRegistration[] = []
    const fontIds: number[] = []
    let nextFontId = 0
    let measurement: ReturnType<typeof createRustMeasureSource> | undefined
    let initialFrame: DocxCommandFrame | undefined
    let svgImages: SvgMediaDecode | undefined
    let disposed = false
    const disposeFonts = () => {
      if (disposed) return
      disposed = true
      fonts.length = 0
      fontIds.length = 0
      measurement?.setEmbeddedFaces([])
      measurement?.clear()
    }
    const appendFont = (font: YrsResidentFontRegistration) => {
      signal.throwIfAborted()
      if (disposed) throw new Error('DOCX command fonts are disposed')
      return fonts.push(font instanceof Uint8Array ? font.slice() : font) - 1
    }
    let released = false
    const abort = () => {
      if (released) return
      released = true
      signal.removeEventListener('abort', abort)
      if (releaseResident === abort) releaseResident = null
      svgImages?.close()
      disposeFonts()
      resident.destroy()
      if (client === resident) {
        client = null
        fontSource = null
      }
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      await resident.prewarm()
      signal.throwIfAborted()

      /** 读出文档的字体需求并登记，返回版面请求（含字体链） */
      const measure = async (metadata: Document) => {
        const theme = metadata.package.theme
        const themeColors = Object.fromEntries(
          Object.entries(theme?.colorScheme ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        )
        const environment = { themeColors, showHiddenText: false, showTableGridlines: false }
        const layout = buildResidentRegionLayoutRequest(metadata, 24, {
          ...environment,
          defaultTabStopTwips: metadata.package.settings?.defaultTabStop ?? null,
          mediaTokens: options.mediaTokens === true,
        })
        const requirements = JSON.parse(await resident.fontRequirements(JSON.stringify(layout))) as ResidentFontRequirement[]
        signal.throwIfAborted()
        const bundled = await sessionProvider()
        signal.throwIfAborted()
        measurement ??= createRustMeasureSource({
          bundled: bundled as never,
          engine: {
            registerFont: (data) => {
              const slot = appendFont(data)
              fontIds[slot] = nextFontId++
              return slot
            },
            registerSubstituteFont: (substituteOf, family) => {
              const slot = appendFont({ substituteOf, family })
              fontIds[slot] = fontIds[substituteOf]!
              return slot
            },
            clearFonts: disposeFonts,
          },
        })
        measurement.setCompat(metadata.package.settings?.compatibilityFlags)
        const embeddedFaces = await extractEmbeddedFontFaces(metadata)
        signal.throwIfAborted()
        measurement.setEmbeddedFaces(embeddedFaces)
        await measurement.prepareFontRequirements(requirements)
        signal.throwIfAborted()
        const config = measurement.measurementConfigForRequirements(requirements)
        if (!config) throw new Error('DOCX command fonts are not ready')
        layout.measurement = {
          ...config,
          fontChains: Object.fromEntries(
            Object.entries(config.fontChains).map(([key, ids]) => [key, [...new Set(ids.map((id) => fontIds[id]!))]]),
          ),
        }
        return { environment, layout, requirements, config }
      }

      const opened = await resident.openSource({
        ...(input instanceof Uint8Array
          ? { bytes: input, ...(checkpoint ? { state: checkpoint.state } : {}) }
          : { document: input }),
        heapLimitBytes: options.heapLimitBytes,
        mediaTokens: options.mediaTokens === true,
        collaboration: options.collab,
      })
      signal.throwIfAborted()
      // 引擎为避免复用本页用过的时钟，可能给的不是我们指定的 clientId；协同必须用它实际写入时的那个，
      // 否则两个副本用同一个 id 写入，互相覆盖对方的操作
      if (opened.clientId !== undefined) effectiveClientId = opened.clientId
      svgImages = decodeSvgMedia(opened.svgMedia)
      const metadata = opened.document
      sourceComments = metadata.package.document.comments ?? []
      const { layout, requirements, config } = await measure(metadata)
      // 还在解码的 SVG 图片随第一帧之后补发，不拖慢首屏
      const hostImages = svgImages.take()
      const resumeInit = resume as
        | (ResidentResume & { session?: string; incarnation?: number; epoch?: number; refusedSeqs?: readonly number[]; replayAppliedSeqs?: readonly number[] })
        | undefined
      const initial = await resident.commandInit({
        session: resumeInit?.session ?? crypto.randomUUID(),
        incarnation: resumeInit?.incarnation ?? 1,
        epoch: resumeInit?.epoch ?? 1,
        ...(resumeInit
          ? {
              version: checkpoint?.version ?? 0,
              throughSeq: checkpoint?.throughSeq ?? 0,
              refusedSeqs: resumeInit.refusedSeqs,
              replayAppliedSeqs: resumeInit.replayAppliedSeqs,
              recoveryState: checkpoint?.recoveryState,
            }
          : {}),
        readOnly: options.readOnly,
        fonts: fonts.slice(),
        rasterScale: rasterScale?.() ?? 1,
        fontRegistrationSlots: { fontChains: config.fontChains },
        layoutInput: JSON.stringify(layout),
        layoutWithRegions: true,
        layoutRevision: 1,
        extras: JSON.stringify({ fontChains: config.fontChains }),
        displayWindow: [0, 3],
        provisionalPages: 3,
        ...(hostImages.length ? { hostImages } : {}),
      })
      initialFrame = initial.frame
      const connection = await createDocxCommandConnection(resident, initial)
      signal.throwIfAborted()
      const decoding = svgImages
      svgImages = undefined
      signal.addEventListener('abort', () => decoding.close(), { once: true })
      decoding.flushTo((late) => {
        if (signal.aborted) {
          for (const { image } of late) image.close()
          return
        }
        resident.provideHostImages(late).catch(() => {
          for (const { image } of late) image.close()
        })
      })
      const families = [
        ...new Set([...requirements.map((item) => item.family), ...(metadata.package.fontTable?.fonts ?? []).map((font) => font.name)]),
      ]
      fontSource = { document: metadata, layoutInput: JSON.stringify(layout), families, requirements }
      options.onFamilies?.(families)
      identity = {
        session: connection.initial.session,
        incarnation: connection.initial.incarnation,
        epoch: connection.initial.epoch,
      }
      retained = null
      prepared = new WeakMap()
      releaseResident = abort
      return connection
    } catch (error) {
      discardCommandPresentation(initialFrame)
      abort()
      throw error
    } finally {
      svgImages?.close()
      disposeFonts()
    }
  }

  /** 从一帧里算出几何；失败返回 undefined（呈现层会拒绝这一帧并重取整帧） */
  const prepareGeometry = (frame: DocxCommandFrame): PeerlessFrameGeometry | undefined => {
    if (!identity) return undefined
    const cached = prepared.get(frame)
    if (cached) return cached
    try {
      let next = retained
      for (const delta of decodeCommandFrameDeltas(frame)) next = applyFrameDelta(next, delta)
      if (!next) return undefined
      const caret = residentCaretSnapshotForFrame(frame.payload.caret, next)
      if (!caret) return undefined
      const pages = commandPageGeometry(next, frame.payload)
      const geometry: PeerlessFrameGeometry = {
        identity,
        coversThroughSeq: frame.coversThroughSeq,
        frameEpoch: next.frameEpoch,
        layoutRevision: frame.payload.layoutRevision,
        layoutEpoch: next.layoutEpoch,
        documentVersion: frame.payload.documentVersion,
        objects: frame.payload.geometry,
        documentWidth: frame.payload.documentWidth,
        layoutProvisional: frame.payload.layoutProvisional,
        ...(frame.payload.reservations ? { reservations: frame.payload.reservations } : {}),
        pages,
        caret: caret.caretRect
          ? {
              ...caret.caretRect,
              x: caret.caretRect.x + (pages[caret.caretRect.pageIndex]?.bounds.x ?? 0),
              y: caret.caretRect.y + (pages[caret.caretRect.pageIndex]?.bounds.y ?? 0),
              width: 1,
            }
          : null,
        selectionFocus: frame.payload.selectionFocus
          ? {
              ...frame.payload.selectionFocus,
              x: frame.payload.selectionFocus.x + (pages[frame.payload.selectionFocus.pageIndex]?.bounds.x ?? 0),
              y: frame.payload.selectionFocus.y + (pages[frame.payload.selectionFocus.pageIndex]?.bounds.y ?? 0),
              width: 1,
            }
          : null,
        parts: frame.payload.parts,
        selectionRects: (frame.payload.selectionRects ?? []).map(({ pageIndex, x, y, width, height }) => ({
          x: x + (pages[pageIndex]?.bounds.x ?? 0),
          y: y + (pages[pageIndex]?.bounds.y ?? 0),
          width,
          height,
        })),
      }
      retained = next
      prepared.set(frame, geometry)
      // 帧里暂存的页面要有画布可画：几何接受之后给每个暂存页创建画布
      for (const { page } of frame.payload.stagedPresentation?.pages ?? []) {
        if (geometry.pages.some((candidate) => candidate.page.pageId === page.pageId && candidate.page.pageIndex === page.pageIndex)) {
          options.ensureCanvas(page)
        }
      }
      return geometry
    } catch {
      return undefined
    }
  }

  // 崩溃恢复：重开一条连接，已发命令按序号重放。协同房间里不做（房间自己能重新同步）
  const recovery: DocxEditSessionOptions['recovery'] = options.collab
    ? undefined
    : {
        checkpoint: (resident) => resident.client.call.checkpoint(),
        reopen: async (resume) => openResident(resume.source, controller.signal, getRasterScale, resume as ResidentResume),
        onRecovery: () => undefined,
      }

  const handle = createDocxEditSessionBinding({
    source: options.bytes,
    getRasterScale,
    openConnection: (source, signal, scale) => openResident(source, signal, scale),
    recovery,
    canvasForPage: options.canvasForPage,
    prepareGeometry,
    onError: options.onError,
    onRecoverableError: options.onRecoverableError,
  })
  // 外部取消 → 拆会话
  controller.signal.addEventListener('abort', () => handle.dispose(), { once: true })
  let binding: DocxEditSessionBinding
  try {
    binding = await handle.ready
  } catch (error) {
    controller.abort()
    throw error
  }
  const activeClient = client as DocxEngineClient | null
  if (!activeClient) throw new Error('The document worker is not ready')

  let fontAbort: AbortController | null = null
  const pickedFonts = new WeakMap<DocxFontEnvironment, { source: object; requirements: ResidentFontRequirement[] }>()
  const flush = () => flushAdmittedInput(binding)

  let disposedEngine = false
  let joined: DocxCollabHandle | null = null

  /** 补全字体的进行中任务：同一时刻只做一次，失败后允许重试 */
  let completing: Promise<void> | null = null
  const completeFonts = (): Promise<void> => {
    if (demand.full) return Promise.resolve()
    completing ??= (async () => {
      const current = client
      const opened = fontSource
      if (!current || !opened || controller.signal.aborted) return
      await demand.ready
      // 扫描失败时一开始取的就是完整字体，没有什么要补的
      const wasComplete = demand.chars === null
      // 从这一刻起所有字体加载函数都给完整字体（包括之后用户换字体时登记的）
      demand.full = true
      if (wasComplete) return
      const abort = new AbortController()
      controller.signal.addEventListener('abort', () => abort.abort(), { once: true })
      const payload = await prepareWorkerFontEnvironment({
        embedded: await extractEmbeddedFontFaces(opened.document),
        requirements: opened.requirements,
        families: opened.families,
        compat: opened.document.package.settings?.compatibilityFlags,
        signal: abort.signal,
        bundled: (await sessionProvider()) as never,
      })
      try {
        if (client !== current || fontSource !== opened) return
        abort.signal.throwIfAborted()
        // 和用户改字体族是同一条路径：fence 保证它排在已经提交的输入之后、之前的输入都已落到引擎
        const held = binding.commands.submit({ kind: 'setFontEnvironment', payload } as never, { fence: true })
        const admitted = held.status === 'held' ? await held.released : held
        if (admitted.status !== 'submitted') throw new Error('字体环境没有被引擎接收')
        const outcome = await admitted.ticket.ack
        if (outcome.status === 'refused' || outcome.status === 'cancelled') throw new Error(`补全字体被引擎拒绝（${outcome.reason ?? outcome.status}）`)
      } finally {
        // 字体字节只在这份环境里存在一次，登记后立刻释放
        payload.faces.length = 0
      }
    })().catch((error) => {
      // 失败后允许重试（用户下次被放开编辑时会再来一次）
      completing = null
      demand.full = false
      throw error
    })
    return completing
  }

  const engine: DocxEditEngine = {
    binding,
    get client() {
      return (client ?? activeClient) as DocxEngineClient
    },
    families: () => fontSource?.families ?? [],
    async fontReport() {
      const source = fontSource
      if (!source) return reportFonts([], () => undefined)
      // 字体包与内嵌字体解析都只在需要提示时才用到：动态引入，不拖慢首屏
      const [fonts, shipped, embedded] = await Promise.all([
        import('@betteroffice/fonts'),
        import('./fonts/docxFonts'),
        extractEmbeddedFontFaces(source.document).catch(() => []),
      ])
      // 「有没有替代」以随站点真正提供的字体为准（resolveShippedFamily），不是上游字体包的完整别名表
      return reportFonts(
        source.families,
        (family) => shipped.resolveShippedFamily(fonts, family),
        embedded.map((face) => face.family),
        source.requirements.flatMap((requirement) => requirement.scripts ?? []),
        source.requirements.filter((requirement) => requirement.italic).map((requirement) => requirement.family),
        (family) => shipped.lacksItalic(fonts, family),
        (family) => shipped.fallbackFamilyFor(fonts, family),
      )
    },
    completeFonts,
    collabClientId: () => effectiveClientId,
    joinCollaboration(joinOptions) {
      const clientId = effectiveClientId
      if (clientId === undefined) throw new Error('这个会话不是以协同模式打开的（缺少 collab 选项）')
      if (joined) throw new Error('这个会话已经加入过协同房间，先 leave() 再重新加入')
      const handle = joinDocxCollaboration(activeClient, binding, clientId, joinOptions)
      joined = handle
      return { ...handle, leave: () => { if (joined === handle) joined = null; handle.leave() } }
    },
    flush,
    async save() {
      await flush()
      const current = client
      if (!current) throw new Error('The document worker is not ready')
      const saved = await current.save({ comments: [...sourceComments] as never })
      return new Uint8Array(saved.bytes)
    },
    async prepareFontFamily(family: string) {
      const current = client
      const opened = fontSource
      if (!current || !opened) throw new Error('Worker fonts are unavailable')
      fontAbort?.abort()
      const abort = new AbortController()
      fontAbort = abort
      await flush()
      abort.signal.throwIfAborted()
      const requirements = JSON.parse(await current.fontRequirements(opened.layoutInput)) as ResidentFontRequirement[]
      // 粗斜体四种变体都登记，用户随后点粗体/斜体不需要再来一轮
      for (const bold of [false, true]) {
        for (const italic of [false, true]) {
          const key = `${family.toLowerCase()}|${bold ? 1 : 0}|${italic ? 1 : 0}`
          if (!requirements.some((entry) => entry.key === key)) requirements.push({ key, family, bold, italic })
        }
      }
      const embedded = await extractEmbeddedFontFaces(opened.document)
      const next = uncoveredFontRequirements(opened.requirements, requirements) ?? requirements
      const payload = await prepareWorkerFontEnvironment({
        embedded,
        requirements: next,
        families: [...opened.families, family],
        compat: opened.document.package.settings?.compatibilityFlags,
        signal: abort.signal,
        bundled: (await sessionProvider()) as never,
      })
      if (client !== current || fontSource !== opened) throw new Error('Document was replaced')
      abort.signal.throwIfAborted()
      pickedFonts.set(payload, { source: opened, requirements: next })
      return payload
    },
    fontEnvironmentApplied(environment) {
      const picked = pickedFonts.get(environment)
      if (picked && fontSource === picked.source) fontSource = { ...fontSource, requirements: picked.requirements }
      environment.faces.length = 0
    },
    dispose() {
      if (disposedEngine) return
      disposedEngine = true
      joined?.leave()
      joined = null
      fontAbort?.abort()
      controller.abort()
      handle.dispose()
    },
  }

  // 首屏之后把字体补全：能改文档的会话（或协同里别人会打新字进来的会话）需要完整字形；
  // 只读会话看到的只有文档里已有的字，被放开编辑时由外层再调 completeFonts。
  if (!demand.full && !options.skipFontCompletion && (!options.readOnly || options.collab)) {
    setTimeout(() => {
      if (!controller.signal.aborted) void engine.completeFonts().catch(() => undefined)
    }, FONT_COMPLETION_DELAY_MS)
  }
  return engine
}

// 供测试与 Surface 的类型检查：避免未使用的导入被裁掉
export { fontEnvironmentForRegistrations }
