/**
 * 自研多格式原生编辑器核心契约定义
 *
 * 设计约束（见设计规范）：
 * 1. 全应用只有一个 EditorHost 外壳，按 SurfaceKind 懒加载 6 类内容面（text / grid / page / slide / code / pdf）。
 * 2. SurfaceDocument.payload、引擎句柄、Canvas DisplayList 等重型对象严禁放进 Vue 深度响应式（ref/reactive），
 *    只允许 shallowRef 或保留在 Session / Worker 内部，避免大文档卡死主线程。
 * 3. 所有修改必须经过 CommandBus，显式携带 source（user / ai / collab / api），以便权限守卫、历史栈与审计统一拦截。
 * 4. 上游 @betteroffice/{docx,xlsx,pptx} 引擎 API 只允许在 src/editor/engines/ 下 import，Surface 与 Host 只认本文件契约。
 */

import type { FileHit, LinkContext, LinkState } from '@/utils/links'
import type { QuoteAnchor } from '@/utils/quoteAnchor'

/** 六类内容面：4 类自研（text/grid/page/slide）+ 2 类收编复用（code/pdf） */
export type SurfaceKind = 'text' | 'grid' | 'page' | 'slide' | 'code' | 'pdf'

/** 编辑器运行模式：read 为零编辑开销只读态，edit 为单人编辑态，collab 为多人实时协同态 */
export type EditorMode = 'read' | 'edit' | 'collab'

/** 命令来源：区分用户输入、AI 改写建议、远端协同回放与扩展 API 调用 */
export type CommandSource = 'user' | 'ai' | 'collab' | 'api'

/** 二维尺寸（CSS 像素） */
export interface Size {
  width: number
  height: number
}

/** 矩形几何（坐标单位由所在 Surface 约定：Page/Slide 为页面 pt 或 CSS px，Grid 为画布 px） */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 编辑器输入源：二进制字节流（Office/PDF）或已解码文本（Markdown/TXT/CSV/Code）。
 *
 * `url` 只给「原件已经在服务端、由内容面自己按需流式读取」的只读场景（PDF）：
 * 把整份 50 页 PDF 先读进内存再交给 Surface，会让首屏多一次完整下载 + 一份常驻副本，
 * 而 pdf.js 本来就支持按 range 拉取。它不参与保存，也不改变文本/字节的既有契约。
 */
export type EditorSource =
  | { kind: 'bytes'; bytes: Uint8Array; name: string; sha256?: string; url?: string }
  | { kind: 'text'; text: string; name: string; encoding?: string; sha256?: string; url?: string }

/**
 * Codec 解码后的首屏文档描述
 * 注意：payload 由具体 Surface 定义，必须保持非响应式（或 shallowRef），禁止深层 reactive 包裹。
 */
export interface SurfaceDocument {
  /** 内置 6 类，或扩展注册的内容面（`ext:<贡献 id>`） */
  readonly kind: SurfaceKind | `ext:${string}`
  readonly format: string
  readonly revision: number
  /** 首屏数据；具体形状由 Surface 定义，不整份进 Vue 响应式 */
  readonly payload: unknown
  /** 打开时的定位提示（搜索命中 / 深链），由调用方给出，不由 Surface 自己猜 */
  readonly hint?: { text?: string; anchor?: Anchor }
}

/** 当前会话在宿主层的细粒度权限（与后端 RBAC / 分享模式 / 管理员只读巡检对齐） */
export interface EditorPermissions {
  read: boolean
  write: boolean
  comment: boolean
  ai: boolean
  export: boolean
}

/** 协同连接状态 */
export type CollabConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error'

/** 协同房间加入参数 */
export interface CollabJoinOptions {
  /** WebSocket 房间地址 */
  url: string
  /** 当前展示用户名 */
  userName: string
  /** 当前用户代表色 */
  userColor?: string
  /** 房间初始状态种子（如 docx 的 Yrs 初始增量） */
  initialUpdate?: Uint8Array
  /** 状态变更回调 */
  onStatusChange?: (state: CollabConnectionState, detail?: string) => void
  /** 服务端主动关闭房间（如 4000+ 错误码或强制踢出） */
  onClosed?: (code: number, reason: string) => void
}

/**
 * 协同房间里的纯文本句柄（结构上是 Y.Text 的最小子集）。
 * 编辑器契约不 import yjs：页面把已经连好的房间文本交给 Host，Grid 再把它包成协同适配器。
 */
/** Y.Text 观察事件里用到的部分：本次变更的 delta（retain / insert / delete 序列） */
export interface CollabTextEvent {
  readonly delta?: ReadonlyArray<{ retain?: number; insert?: unknown; delete?: number }>
}

export interface CollabTextLike {
  toString(): string
  observe(listener: (event?: CollabTextEvent) => void): void
  unobserve(listener: (event?: CollabTextEvent) => void): void
  insert(index: number, text: string): void
  delete(index: number, length: number): void
  readonly doc?: { transact(fn: () => void): void } | null
}

/** 富文本协同房间的状态（CollabProvider 状态的子集） */
export interface CollabRichState {
  /** 服务端允许本连接写 */
  writable: boolean
  /** 这条连接上内容已就绪 */
  ready: boolean
  /** 这份文档同步成功过（断线后仍可继续写，恢复后合并） */
  everSynced: boolean
  /** 本连接被点名初始化空房间时的正文 Markdown；null = 不需要 */
  initMarkdown: string | null
}

/**
 * 已连好的富文本协同房间（笔记 / Markdown 文件）。
 * 结构上是 `collab/provider.ts` 里 CollabProvider 的子集：页面把连好的房间交给 Host，Text Surface 用
 * y-prosemirror 绑定 `fragment`、用 `awareness` 画别人的光标。契约不 import yjs，所以两个句柄是 unknown。
 */
export interface CollabRichLike {
  /** 房间正文根：Y.XmlFragment（节点名 = ProseMirror 节点名，与旧编辑器同一份格式） */
  readonly fragment: unknown
  /** y-protocols 的 Awareness（光标、选区、名字） */
  readonly awareness: unknown
  getState(): CollabRichState
  subscribe(listener: (state: CollabRichState) => void): () => void
  /** 被点名初始化：用这段 Markdown 填空房间，然后调用 initDone */
  on(event: 'init', listener: (markdown: string) => void): () => void
  initDone(): void
}

/* ---------------- 笔记文本面的页面级服务 ---------------- */

/** 「引用笔记」候选 */
export interface TextNoteHit {
  id: string
  title: string
  kind?: string
}

/** 选区批注里一条已有评论的摘录（落库的格式是 `utils/quoteAnchor` 的 QuoteAnchor：摘录 + 前后各一小段上下文） */
export interface TextQuote {
  /** 评论 id（点正文高亮时据此定位到评论） */
  id: string
  text: string
  prefix: string
  suffix: string
  /** 已解决的评论：高亮淡化成虚线下划线 */
  resolved: boolean
}

/**
 * 选区批注：页面 ⇄ 文本面的出入口。
 *
 * 落库的锚点仍是后端的 `Anchor::Quote`（摘录 + 前后文，不存位置，正文被改后按摘录重新找回）；
 * 统一锚点（`Anchor` 的 text 类）用在内容面这一侧：选区对应的 `{block, offset, length, quote}`，
 * 命令 / 查询 / 跳转都说它，页面不必知道 ProseMirror 的位置。
 */
export interface TextComments {
  /** 已有评论的摘录（含已解决的）；现读，页面的评论列表变了只需通知内容面重画 */
  quotes(): readonly TextQuote[]
  /** 评论列表里聚焦的那条：对应的高亮加重 */
  activeQuote(): string | null
  /** 能不能新建批注；false 时选中文字也不出现「评论」入口（只读巡检、没有评论权限） */
  canAnnotate(): boolean
  /** 选中文字点了「评论」：quote 交给评论栏落库，anchor 是同一段选区的统一锚点 */
  annotate(quote: QuoteAnchor, anchor: Extract<Anchor, { kind: 'text' }>): void
  /** 点了正文里的批注高亮 */
  quoteClick(id: string): void
  /** 现在正文里还找得到摘录的评论 id；不在其中的评论界面标「原文已改动」 */
  located(ids: string[]): void
}

/**
 * 笔记文本面需要从页面拿到的数据与出口。
 *
 * 为什么用一组「现读」的函数而不是把值直接传进来：链接体检、双链标题、集合列表都是异步回来的，
 * 内容面挂载之后还会变；函数每次现读最新值，页面不用为它们重建编辑器（重建会丢光标和撤销栈）。
 * 页面数据变了之后只需要通知内容面重画装饰（命令 `text.refresh`）。
 */
export interface TextServices {
  /** 图片 / 附件上传到哪个集合；null = 不能上传 */
  collection(): string | null
  /** 这篇 Markdown 在集合里的路径：相对图片 / 链接按它所在目录解析 */
  sourcePath(): string | null
  /** 管理员只读查看时的目标用户（原件地址要带上） */
  adminView(): string
  /** 链接解析上下文；null = 不改写相对链接 */
  linkContext(): LinkContext | null
  /** 链接体检结果：collection + path → 在不在 */
  linkStates(): Record<string, LinkState>
  /** 双链标题：id → 标题 */
  resolveTitles?(ids: string[]): Promise<Record<string, string>>
  /** 「引用笔记」选择器的搜索 */
  searchNotes?(query: string): Promise<TextNoteHit[]>
  /** 「引用文件 / 模板」选择器的搜索 */
  searchFiles?(query: string, collection: string): Promise<FileHit[]>
  /** 引用文件选择器里可切换的集合（当前集合总会在） */
  fileCollections(): { name: string }[]
  /** 选区批注；页面没有评论栏（分享页、单测）时不传，高亮与「评论」入口都不出现 */
  comments?: TextComments
  /** 跟随链接（Ctrl/⌘ 点击、只读时直接点击） */
  openLink(id: string): void
  openAttachment(target: { collection: string; path: string; fragment?: string }): void
  linkError(message: string): void
}

/** Host 侧面板：选择器、文件选择；由内容面请求、Host 渲染 */
export type TextPanelName = 'wikilink' | 'filelink' | 'image' | 'attachment'

/**
 * 内容面 ↔ Host 的桥。
 * 内容面（纯 TS，不碰 Vue）只能「请求」：弹哪个面板、传哪些文件；面板本身（Vue）与上传进度由 Host 持有。
 */
export interface TextHostBridge {
  readonly services: TextServices
  /** 打开面板；from 是 `[[` 的起点（引用笔记面板用它把 `[[` 换成链接） */
  openPanel(panel: TextPanelName, options?: { from?: number }): void
  /** 粘贴 / 拖入的文件：Host 上传后把结果插回 pos 处 */
  uploadFiles(files: File[], pos?: number): void
  /** 给用户一句话提示（超限、不能上传等） */
  notify(message: string): void
  /** 页面接了 AI 写作没有（没接时斜杠菜单不出现 AI 项） */
  aiAvailable?(): boolean
  /** 打开工具栏下面的 AI 写作条；带 action 时直接开始生成（斜杠菜单的「AI 续写」） */
  openAi?(options?: { action?: AiWriteAction }): void
}

/** AI 写作的动作（UI-3），和服务端 `ai_write` 的 action 一致 */
export type AiWriteAction = 'polish' | 'summarize' | 'translate' | 'continue' | 'custom'

/**
 * 交给页面去调 AI 写作的请求。编辑器只负责从正文里取出「选中的内容（Markdown）」和「光标前的上下文」，
 * 怎么调后端由页面实现（编辑器不 import 网络层，见 RemoteTableFormat 的说明）。
 */
export interface AiWriteRequest {
  action: AiWriteAction
  /** 选中的内容（Markdown）；没选中时为空 */
  text: string
  /** 选区（或光标）前面的正文，纯文字 */
  context: string
  /** 「按要求写」的要求 */
  instruction?: string
}

/** AI 结果怎么写回：替换选中 / 插到选中内容所在块的下面 / 插在光标处 */
export type AiApplyMode = 'replace' | 'below' | 'cursor'

/** 协同房间的连接状态（与 collab/provider.ts 的 CollabStatus 同名同义） */
export type CollabRoomStatus = 'connecting' | 'syncing' | 'synced' | 'offline' | 'closed'

/** 房间状态的订阅来源（CollabProvider 的结构子集）：状态栏据此显示「连接中 / 已同步 / 离线」，而不是「已保存」 */
export interface CollabStatusSource {
  getState(): { status: CollabRoomStatus; writable: boolean }
  /** 订阅时立即推一次当前状态；返回退订函数 */
  subscribe(listener: (state: { status: CollabRoomStatus; writable: boolean }) => void): () => void
}

/**
 * 服务端分页表格（CSV / TSV 超过整份读入上限、或不是 UTF-8 时）。
 *
 * 为什么编辑器不自己解码：GBK / GB18030 / UTF-16 的文件要「逐字节原样写回」，编码器在服务端（`csv_edit` 按文件原来的编码写），
 * 前端再写一份 GBK 编码器既多余又可能和服务端不一致。所以内容面只认这个接口：按页取行、按操作列表提交改动；
 * 具体怎么调后端由页面实现，编辑器不 import 网络层。
 */
export interface RemoteTableFormat {
  /** 编码的稳定标识（`utf-8` / `utf-8-bom` / `utf-16le` / `utf-16be` / `gb18030`） */
  encoding: string
  /** 编码给人看的名字 */
  encodingLabel: string
  delimiter: string
  /** `lf` / `crlf` / `cr` */
  newline: string
  trailingNewline: boolean
}

export interface RemoteTablePage {
  /** 总行数（不含全空白的行） */
  totalRows: number
  /** 最宽的一行有几列 */
  columns: number
  /** 这一页的行 */
  rows: string[][]
  /** 这一页第一行在整张表里的行号（0 基） */
  offset: number
  format: RemoteTableFormat
  /** 现在文件内容的 sha256：保存时带回去，文件在这之后被改过就会被拒绝 */
  sha256: string
  /** 现在的版本号 */
  version: number
}

/** 一次编辑里的操作；行号一律指**打开时那张表**（服务端也是这个口径），所以分页浏览、先删后插都不影响结果 */
export type RemoteTableOp =
  | { op: 'set_cell'; row: number; col: number; value: string }
  | { op: 'insert_row'; at: number; values: string[] }
  | { op: 'delete_row'; row: number }

export interface RemoteTableSaveResult {
  changed: boolean
  version: number
  sha256: string
  embedded: number
}

/** 乐观锁冲突：文件在你打开之后被别人（或别的程序）改过。后端实现遇到它必须抛这个错，内容面据此进入「版本冲突」且不丢草稿 */
export class RemoteTableConflict extends Error {
  constructor(message = '这个文件刚被别人保存过（版本冲突）') {
    super(message)
    this.name = 'RemoteTableConflict'
  }
}

export interface RemoteTableBackend {
  read(offset: number, limit: number): Promise<RemoteTablePage>
  edit(ops: RemoteTableOp[], expected: { version: number; sha256: string }): Promise<RemoteTableSaveResult>
}

/** EditorHost 打开文档的完整请求契约 */
export interface EditorOpenRequest {
  fileId: string
  collection?: string
  path?: string
  format: string
  source: EditorSource
  readonly: boolean
  revision: number
  permissions: EditorPermissions
  collab?: CollabJoinOptions
  /** 已连好的协同文本房间；CSV/TSV 走它做单元格补丁，不另开连接 */
  collabText?: CollabTextLike
  /** 服务端分页的表格数据源（CSV / TSV 超过 512 KB 或不是 UTF-8）；有它时表格按页向服务端取行，保存提交操作列表 */
  remoteTable?: RemoteTableBackend
  /** 已连好的富文本协同房间（笔记 / Markdown）；有它时正文以房间为准，不走本地保存 */
  collabRich?: CollabRichLike
  /** 房间连接状态（CSV 文本房间 / 笔记富文本房间）；有它时状态栏显示同步状态 */
  collabStatus?: CollabStatusSource
  /**
   * 已连好的完整协同连接（`collab/provider.ts` 的 CollabProvider），给原样复用旧组件的内容面用：
   * 代码面里的 CodeEditor 自己会绑 Y.Text 与光标，直接吃它。契约不认识它的形状，所以是 unknown
   */
  collabProvider?: unknown
  /** 房间当前是否可写；不传按只读处理 */
  collabWritable?: () => boolean
  /** 首屏定位提示；PDF 的检索命中、评论深链都从这里进 */
  initialHint?: { text?: string; anchor?: Anchor }
  /**
   * 调用方保证这份是整份读到的可编辑文本：内置格式表和扩展都不认识这个扩展名时（.cs / .rb / .php / .proto / Makefile…），
   * 按纯文本交给代码面，而不是落进「暂不支持」。为什么放在请求里而不是扩 FORMAT_TO_SURFACE：
   * 页面的文本格式清单（utils/viewKind 的 TEXT_FORMATS）有上百项且服务端还会按内容嗅探，宿主这张表只管「哪些格式有专门的内容面」；
   * 二进制没有这个声明，仍走下载兜底。语法高亮由代码面按文件名自己判断，认不出就是纯文本。
   */
  plainText?: boolean
}

/**
 * 跨格式统一锚点模型（取代单向的 viewerHit.deriveHit）
 * 同时用于搜索命中高亮、目录大纲跳转、评论/批注定位、AI 引用与协同远端光标。
 */
export type Anchor =
  | { kind: 'text'; block: string; offset: number; length?: number; quote?: string }
  | { kind: 'cell'; sheet: string; cell: string; endCell?: string }
  | { kind: 'page'; page: number; text: string; rect?: Rect }
  | { kind: 'slide'; slide: number; shape?: string; offset?: number }
  | { kind: 'code'; line: number; column: number; length?: number }
  | { kind: 'pdf'; page: number; rect: Rect }

/** 当前选区抽象 */
export interface Selection {
  readonly kind: SurfaceKind
  readonly anchor: Anchor
  readonly focus?: Anchor
  readonly isEmpty: boolean
  readonly text?: string
}

/** 统一编辑命令 */
export interface EditorCommand {
  id: string
  type: string
  args?: unknown
  source: CommandSource
  origin?: string
  /** 是否只读安全命令（如跳转、查找、缩放、切换工作表，只读模式下允许执行） */
  readonlySafe?: boolean
}

/** 命令执行结果 */
export interface CommandResult {
  ok: boolean
  reason?: string
  anchor?: Anchor
  data?: unknown
}

/** 保存选项 */
export interface SaveOptions {
  /** 是否跳过无损预检强制保存（仅在 text_equal 为 true 且用户显式确认「仍然编辑」后允许） */
  force?: boolean
  /** 保存原因标记（手动保存 / 自动保存 / 关闭前保存） */
  reason?: 'manual' | 'autosave' | 'close'
}

/** 保存结果（对齐服务端 replace_bytes 与文本保存响应） */
export interface SaveResult {
  ok: boolean
  revision: number
  sha256: string
  unchanged?: boolean
  embedded?: number
  partsRemoved?: string[]
  /** 失败原因（冲突时额外带 conflict 细节），供 UI 直接展示 */
  reason?: string
  conflict?: {
    serverRevision: number
    serverSha256?: string
    holderName?: string
    message: string
  }
}

/** 会话生命周期阶段 */
export type SessionPhase =
  | 'idle'
  | 'loading'
  | 'checking'
  | 'ready'
  | 'saving'
  | 'conflict'
  | 'error'
  | 'destroyed'

/** 会话事件通知 */
export interface SessionEvent {
  type: 'phase' | 'dirty' | 'revision' | 'selection' | 'collab' | 'error'
  phase: SessionPhase
  dirty: boolean
  revision: number
  readonly: boolean
  selection?: Selection | null
  error?: string
}

export type SessionListener = (event: SessionEvent) => void

/** 文档会话接口：管理文档身份、版本、脏标记、命令派发、撤销重做与保存 */
export interface DocumentSession {
  /**
   * Surface 挂载后注册「当前待保存内容」提供者；卸载时传 null 撤销。
   * 第二个参数给需要引擎序列化的格式（xlsx/pptx）：保存时才 await，不阻塞输入。
   */
  setSnapshotProvider?: (
    provider: (() => EditorSource | null) | null,
    asyncProvider?: (() => Promise<EditorSource | null>) | null,
  ) => void
  /**
   * 内容面自带保存通道：服务端分页的表格保存的是「操作列表」而不是整份文本，没有快照可交给 transport。
   * 设置后 save 不再取快照、不走 transport，直接调它；返回值（成功 / 冲突 / 失败）照常驱动会话的版本、冲突与脏标记。
   */
  setSaveHandler?: (handler: ((options: SaveOptions) => Promise<SaveResult>) | null) => void
  readonly id: string
  readonly kind: SurfaceKind
  readonly format: string
  readonly readonly: boolean
  readonly dirty: boolean
  readonly revision: number
  readonly phase: SessionPhase

  execute(command: EditorCommand): Promise<CommandResult>
  /**
   * 统一查找入口：返回命中锚点，由 Surface 负责高亮/滚动。
   * Chrome 查找栏与 PDF / 代码面共用这一条通道，不各自维护一套查找状态。
   */
  find(query: string): Promise<Anchor[]>
  undo(): Promise<void>
  redo(): Promise<void>
  save(options?: SaveOptions): Promise<SaveResult>
  scrollTo(anchor: Anchor): Promise<void>
  getSelection(): Selection | null
  subscribe(listener: SessionListener): () => void
  destroy(): void
}

/** Surface 挂载上下文 */
export interface SurfaceContext {
  readonly session: DocumentSession
  readonly document: SurfaceDocument
  readonly permissions: EditorPermissions
  readonly readonly: boolean
  /** 已连好的协同文本（CSV/TSV）；由 Host 从打开请求透传 */
  readonly collabText?: CollabTextLike
  /** 服务端分页的表格数据源；由 Host 从打开请求透传 */
  readonly remoteTable?: RemoteTableBackend
  /** 已连好的富文本协同房间（笔记 / Markdown）；由 Host 从打开请求透传 */
  readonly collabRich?: CollabRichLike
  /** 已连好的完整协同连接（代码面）；由 Host 从打开请求透传 */
  readonly collabProvider?: unknown
  /** 协同房间当前是否可写 */
  readonly collabWritable?: () => boolean
  /** 笔记文本面与页面之间的桥（选择器、上传、链接体检）；没有就只做不依赖页面的编辑 */
  readonly textHost?: TextHostBridge
  onSelectionChange?: (selection: Selection | null) => void
  onDirtyChange?: (dirty: boolean) => void
  /** 内容面自己的保存快捷键（CodeMirror 的 Mod-s 会 stopPropagation）统一回到 Host 保存 */
  onSaveRequest?: () => void
  /** 内容面自己接管的查找快捷键（网格的 Ctrl+F 在画布上）交回 Host 打开查找栏 */
  onFindRequest?: () => void
  /** 内容面加载后才拿到的统计（如 PDF 页数）变化时通知 Host 重新取数 */
  onStatsChange?: () => void
  /** 正文变了（含协同里别人的修改）：Host 防抖后把最新正文推给页面，页面的草稿与落地都靠它 */
  onContentChange?: () => void
  /**
   * 扩展命令的入口：内容面自己执行命令（斜杠菜单）时，遇到不认识的命令类型先问这里——
   * 返回 null 表示这不是扩展命令，内容面照常报「不支持」；返回 Promise 表示已交给扩展执行。
   */
  runExtensionCommand?: (type: string, args?: unknown) => Promise<CommandResult> | null
  /** 内容面请求打开链接输入（Ctrl/⌘+K、选区浮条的链接按钮、链接卡的“编辑”）：输入条在 Chrome 里 */
  onLinkRequest?: () => void
  /** 内容面自己的浮层（斜杠菜单）在手机上变成贴键盘的底部面板时，把它的高度告诉 Host：光标要滚到它上面（0 = 没开） */
  onSheetHeight?: (height: number) => void
  onError?: (err: Error) => void
}

/** Surface 状态查询请求 */
export interface SurfaceQuery {
  type: 'outline' | 'wordCount' | 'search' | 'anchorRect' | 'proposals' | string
  args?: unknown
}

/** Surface 视图状态快照（用于标签页切换或重挂载后恢复滚动位置、缩放比与选区） */
export interface SurfaceState {
  readonly kind: SurfaceKind | `ext:${string}`
  scrollTop?: number
  scrollLeft?: number
  zoom?: number
  activeSheet?: string
  activeSlide?: number
  selection?: Selection | null
  extra?: Record<string, unknown>
}

/** 内容面接口：只负责渲染、输入、选区、滚动与局部查询，不直接管网络与版本 */
export interface Surface {
  mount(el: HTMLElement, ctx: SurfaceContext): Promise<void>
  unmount(): void
  resize(size: Size): void
  focus(): void
  setReadonly(value: boolean): void
  command(command: EditorCommand): Promise<CommandResult>
  query(query: SurfaceQuery): Promise<unknown>
  capture(): SurfaceState
  restore(state: SurfaceState): void
  /**
   * 同步取当前正文（只有文本类内容面实现）。多人编辑的落地调度在事件回调里同步要 Markdown
   * （`collab/landing.ts` 的 getMarkdown），等不了 `query({ type: 'text' })` 的 Promise。
   */
  textNow?(): string
}

/** Codec 编解码上下文 */
export interface CodecContext {
  readonly fileId: string
  readonly format: string
  readonly readonly: boolean
  readonly signal?: AbortSignal
}

/** 增量编辑操作（用于 CSV 逐字节补丁或 XLSX 服务端轻量改值快速通道） */
export type EditOp =
  | { kind: 'csv.setCell'; row: number; col: number; value: string }
  | { kind: 'csv.insertRow'; index: number; values: string[] }
  | { kind: 'csv.deleteRow'; index: number }
  | { kind: 'xlsx.setCell'; sheet: string; cell: string; value: string | number | boolean | null }
  | { kind: 'docx.selective'; paragraphIndex: number; xml: string }

/** 编解码器接口：负责打开解析、序列化保存与按字节补丁 */
export interface Codec {
  readonly id: string
  readonly formats: readonly string[]
  readonly kind: SurfaceKind

  sniff?(head: Uint8Array): boolean
  open(source: EditorSource, ctx: CodecContext): Promise<SurfaceDocument>
  save(doc: SurfaceDocument, ctx: CodecContext): Promise<EditorSource>
  patch?(source: EditorSource, ops: EditOp[]): Promise<EditorSource>
}

/** 格式路由表：扩展名（不含点，小写）→ SurfaceKind */
const FORMAT_TO_SURFACE: Readonly<Record<string, SurfaceKind>> = {
  // Text Surface（ProseMirror / MarkdownRead）
  md: 'text',
  markdown: 'text',
  mdx: 'text',
  txt: 'text',

  // Grid Surface（CSV 自研补丁 + XLSX WorkbookHandle）
  csv: 'grid',
  tsv: 'grid',
  xlsx: 'grid',
  xls: 'grid',
  ods: 'grid',
  et: 'grid',

  // Page Surface（DOCX 轻只读 + Canvas 编辑）
  docx: 'page',
  doc: 'page',
  odt: 'page',
  rtf: 'page',
  wps: 'page',

  // Slide Surface（PPTX PresentationSession + paintSlide）
  pptx: 'slide',
  ppt: 'slide',
  odp: 'slide',
  dps: 'slide',

  // PDF Surface（pdf.js）
  pdf: 'pdf',

  // Code Surface（CodeMirror 6）
  json: 'code',
  jsonc: 'code',
  yaml: 'code',
  yml: 'code',
  toml: 'code',
  xml: 'code',
  html: 'code',
  css: 'code',
  scss: 'code',
  js: 'code',
  mjs: 'code',
  cjs: 'code',
  ts: 'code',
  mts: 'code',
  tsx: 'code',
  jsx: 'code',
  vue: 'code',
  rs: 'code',
  py: 'code',
  go: 'code',
  java: 'code',
  kt: 'code',
  kts: 'code',
  dart: 'code',
  c: 'code',
  cpp: 'code',
  h: 'code',
  hpp: 'code',
  sh: 'code',
  bash: 'code',
  sql: 'code',
  ini: 'code',
  conf: 'code',
  log: 'code',
}

/** 需要走服务端 LibreOffice /converted 转换后按只读预览的旧格式集合 */
const LEGACY_OFFICE_FORMATS = new Set([
  'doc',
  'xls',
  'ppt',
  'odt',
  'ods',
  'odp',
  'rtf',
  'wps',
  'et',
  'dps',
])

/**
 * 从文件名、路径或格式名中提取规范化的小写扩展名
 */
export function normalizeFormat(formatOrPath: string): string {
  const trimmed = formatOrPath.trim().toLowerCase()
  if (!trimmed) return ''
  // 去掉查询串与 hash
  const clean = trimmed.split(/[?#]/, 1)[0] ?? ''
  const lastSegment = clean.split('/').pop() ?? clean
  const dotIndex = lastSegment.lastIndexOf('.')
  const ext = dotIndex >= 0 ? lastSegment.slice(dotIndex + 1) : lastSegment
  return ext
}

/**
 * 根据格式或文件路径解析对应的 SurfaceKind；不认识的二进制格式返回 null（走下载兜底）
 */
export function resolveSurfaceKind(formatOrPath: string): SurfaceKind | null {
  const ext = normalizeFormat(formatOrPath)
  if (!ext) return null
  return FORMAT_TO_SURFACE[ext] ?? null
}

/**
 * 判断是否为旧二进制/ODF 办公格式（需请求 /converted 端点转换后以只读模式打开）
 */
export function isLegacyOfficeFormat(formatOrPath: string): boolean {
  const ext = normalizeFormat(formatOrPath)
  return LEGACY_OFFICE_FORMATS.has(ext)
}

/** 只读模式下允许通过 CommandBus 的安全命令前缀/类型 */
const READONLY_SAFE_PREFIXES = ['view.', 'nav.', 'search.', 'zoom.', 'sheet.select', 'slide.select', 'copy']

/**
 * CommandBus 前置权限与只读守卫：
 * 保证在 readonly 会话或缺少 write 权限时，任何修改类命令在进入 Surface / Engine 之前被统一拦截。
 */
export function canExecuteCommand(
  command: EditorCommand,
  readonly: boolean,
  permissions: EditorPermissions,
): CommandResult {
  if (!permissions.read) {
    return { ok: false, reason: '当前账号无权读取该文档' }
  }
  const isReadonlySafe =
    command.readonlySafe === true ||
    READONLY_SAFE_PREFIXES.some((prefix) => command.type === prefix || command.type.startsWith(prefix))

  if (isReadonlySafe) {
    return { ok: true }
  }
  if (readonly) {
    return { ok: false, reason: '文档当前处于只读模式，无法执行修改命令' }
  }
  if (!permissions.write) {
    return { ok: false, reason: '当前账号无文档写入权限' }
  }
  if (command.source === 'ai' && !permissions.ai) {
    return { ok: false, reason: '当前会话未开启 AI 改写权限' }
  }
  return { ok: true }
}

/**
 * 将 Anchor 序列化为稳定的定位键，用于高亮比对、大纲激活态判断与历史记录去重
 */
export function formatAnchorKey(anchor: Anchor): string {
  switch (anchor.kind) {
    case 'text':
      return `text:${anchor.block}:${anchor.offset}:${anchor.length ?? 0}`
    case 'cell':
      return `cell:${anchor.sheet}:${anchor.cell}${anchor.endCell ? `:${anchor.endCell}` : ''}`
    case 'page':
      return `page:${anchor.page}:${anchor.text}`
    case 'slide':
      return `slide:${anchor.slide}:${anchor.shape ?? ''}:${anchor.offset ?? 0}`
    case 'code':
      return `code:${anchor.line}:${anchor.column}:${anchor.length ?? 0}`
    case 'pdf':
      return `pdf:${anchor.page}:${anchor.rect.x},${anchor.rect.y},${anchor.rect.width},${anchor.rect.height}`
  }
}
