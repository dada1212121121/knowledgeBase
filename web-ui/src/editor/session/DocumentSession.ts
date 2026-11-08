/**
 * DocumentSession：一份打开文档的会话
 *
 * 职责边界（设计规范）：
 * - 管文档身份（fileId / collection / format）、版本号（revision）、sha256、脏标记、保存与冲突；
 * - 把命令交给 CommandBus，把撤销/重做交给 History，把内容渲染交给 Surface；
 * - **不持有** Surface 的文档树或引擎句柄的深拷贝，也不把它们放进响应式系统。
 *
 * 保存契约与服务端一致（设计规范）：
 * - 成功：返回新 revision 与 sha256，清脏；
 * - 409：服务端版本已前进 → 进入 `conflict` 阶段，由 UI 提示「重新加载 / 另存副本」；
 * - 只读或无写权限：直接拒绝，不发请求（避免一次注定 403 的网络往返）。
 */
import { resolveSurfaceKind } from '../types'
import type {
  Anchor,
  CommandResult,
  DocumentSession,
  EditorCommand,
  EditorOpenRequest,
  EditorSource,
  SaveOptions,
  SaveResult,
  Selection,
  SessionEvent,
  SessionListener,
  SessionPhase,
  Surface,
  SurfaceKind,
} from '../types'
import { CommandBus } from './CommandBus'
import { History } from './History'

/** 保存请求（由 transport 落到具体 API：文本走 PUT，二进制走 replace_bytes） */
export interface SessionSaveRequest {
  fileId: string
  collection?: string
  /** 客户端已知的服务端版本，用于乐观锁校验 */
  revision: number
  source: EditorSource
  options?: SaveOptions
}

/** 保存通道：把 HTTP/API 细节挡在会话之外，便于单测注入假实现 */
export interface SessionTransport {
  save(request: SessionSaveRequest): Promise<SaveResult>
}

export interface EditorDocumentSessionOptions {
  request: EditorOpenRequest
  /** 保存通道；缺失时 save 直接返回失败（只读巡检场景不需要） */
  transport?: SessionTransport
  /** 复用的撤销栈；缺省按 SurfaceKind 建一个默认配置的 */
  history?: History
  /** 取当前待保存内容；Surface 每次改动后通过 markDirty 触发，保存时再取值，避免每键序列化 */
  snapshot?: () => EditorSource | null
  /** 注入时钟，便于测试 */
  now?: () => number
}

let sessionSeq = 0

export class EditorDocumentSession implements DocumentSession {
  readonly id: string
  readonly kind: SurfaceKind
  readonly format: string
  readonly fileId: string

  private readonly request: EditorOpenRequest
  private readonly transport?: SessionTransport
  private readonly history: History
  private readonly now: () => number
  private readonly listeners = new Set<SessionListener>()

  private bus: CommandBus | null = null
  private surface: Surface | null = null
  private snapshot: (() => EditorSource | null) | null
  /** 异步快照：xlsx 这类需要引擎序列化才能拿到字节的面用它，避免在每次改动时预序列化 */
  private snapshotAsync: (() => Promise<EditorSource | null>) | null
  /** 内容面自带的保存通道（服务端分页表格）；设置后取代 snapshot + transport */
  private saveHandler: ((options: SaveOptions) => Promise<SaveResult>) | null = null

  private currentPhase: SessionPhase = 'idle'
  private currentDirty = false
  /** 改动代次：保存期间又有编辑时，不能用旧快照的保存结果把脏标记清掉 */
  private dirtyEpoch = 0
  private currentRevision: number
  private currentSha256: string
  private currentSelection: Selection | null = null
  private lastError: string | undefined
  private saveInFlight: Promise<SaveResult> | null = null
  private destroyed = false

  constructor(options: EditorDocumentSessionOptions) {
    this.request = options.request
    this.transport = options.transport
    this.now = options.now ?? Date.now
    this.snapshot = options.snapshot ?? null
    this.snapshotAsync = null
    this.fileId = options.request.fileId
    this.format = options.request.format
    this.currentRevision = options.request.revision
    this.currentSha256 = options.request.source.sha256 ?? ''
    this.id = `s${++sessionSeq}_${options.request.fileId}`

    // SurfaceKind 由格式推导；无法识别时按 text 处理（调用方本不该打开这种格式）
    this.kind = resolveKind(options.request)
    this.history =
      options.history ??
      new History({ limit: this.kind === 'text' ? 200 : 120, mergeWindowMs: this.kind === 'text' ? 400 : 0 })
  }

  get readonly(): boolean {
    // 只读判定同时看请求标记与权限：宁可多拒一次，也不要放过一次越权写
    return this.request.readonly || !this.request.permissions.write
  }

  get dirty(): boolean {
    return this.currentDirty
  }

  get revision(): number {
    return this.currentRevision
  }

  get sha256(): string {
    return this.currentSha256
  }

  get phase(): SessionPhase {
    return this.currentPhase
  }

  get error(): string | undefined {
    return this.lastError
  }

  get undoStack(): History {
    return this.history
  }

  get canUndo(): boolean {
    return this.history.canUndo
  }

  get canRedo(): boolean {
    return this.history.canRedo
  }

  get commandBus(): CommandBus | null {
    return this.bus
  }

  /** 绑定命令总线；Session 作为只读态/权限的唯一判定源（保存与冲突期间临时升级为只读） */
  attachBus(bus: CommandBus): void {
    this.bus = bus
  }

  /** 绑定内容面；Host 在 mount 完成后调用 */
  attachSurface(surface: Surface | null): void {
    this.surface = surface
  }

  /**
   * 设置待保存内容提供者。
   *
   * 同步 provider 适合文本面（内存里就有字符串）；xlsx 必须由引擎在 Worker 内重新打包，
   * 因此额外接受一个异步 provider，保存时才等待序列化，不阻塞输入。
   */
  setSnapshotProvider(
    provider: (() => EditorSource | null) | null,
    asyncProvider?: (() => Promise<EditorSource | null>) | null,
  ): void {
    this.snapshot = provider
    this.snapshotAsync = asyncProvider ?? null
  }

  /** 内容面自带保存通道；卸载时传 null 撤销 */
  setSaveHandler(handler: ((options: SaveOptions) => Promise<SaveResult>) | null): void {
    this.saveHandler = handler
  }

  /** 打开完成：idle/loading → ready */
  markReady(): void {
    this.transition('ready')
  }

  /** 加载中（解析文档、无损预检） */
  markLoading(): void {
    this.transition('loading')
  }

  /** 内容变更：置脏并广播 */
  markDirty(value = true): void {
    if (this.destroyed) return
    // 即使已经是脏态也要推进代次：保存请求在途时每一次真实改动都算一次新编辑
    if (value) this.dirtyEpoch += 1
    if (this.currentDirty === value) return
    this.currentDirty = value
    this.emit('dirty')
  }

  /** 更新选区（由 Surface 的 onSelectionChange 回调驱动） */
  setSelection(selection: Selection | null): void {
    if (this.destroyed) return
    this.currentSelection = selection
    this.emit('selection')
  }

  getSelection(): Selection | null {
    return this.currentSelection
  }

  /** 统一命令入口：先过 CommandBus（含只读/权限守卫），再落 Surface */
  async execute(command: EditorCommand): Promise<CommandResult> {
    if (this.destroyed) return { ok: false, reason: '编辑器已关闭' }
    if (!this.bus) {
      // 未接总线时退化为直接交给 Surface，但仍要过一遍只读守卫，避免绕过
      if (this.readonly && command.readonlySafe !== true) {
        return { ok: false, reason: '文档当前处于只读模式，无法执行修改命令' }
      }
      if (!this.surface) return { ok: false, reason: '编辑器会话尚未就绪' }
      return this.surface.command(command)
    }
    return this.bus.execute(command)
  }

  /**
   * 统一查找：把查询交给内容面，返回它算出的锚点。
   * Chrome 的计数 / 上一个 / 下一个仍走 `search.*` 命令（Surface 需要维护当前命中索引），
   * 这里只暴露「有哪些命中」，给页面跳转、评论定位等只读场景复用。
   */
  async find(query: string): Promise<Anchor[]> {
    if (this.destroyed || !this.surface) return []
    const result = await this.execute({
      id: `find_${this.now()}`,
      type: 'search.set',
      args: { query },
      source: 'user',
      readonlySafe: true,
    })
    if (!result.ok) return []
    const anchors = (result.data as { anchors?: unknown } | undefined)?.anchors
    return Array.isArray(anchors) ? (anchors as Anchor[]) : []
  }

  /** 撤销：只动本地栈；协同远端变更由引擎 CRDT 负责，不入此栈 */
  async undo(): Promise<void> {
    if (this.destroyed || this.readonly) return
    const applied = await this.history.undo()
    if (applied) this.markDirty(true)
  }

  /** 重做 */
  async redo(): Promise<void> {
    if (this.destroyed || this.readonly) return
    const applied = await this.history.redo()
    if (applied) this.markDirty(true)
  }

  /** 记录一次远端协同变更：只计数，不入撤销栈 */
  recordRemoteChange(): void {
    this.history.recordRemote()
  }

  /** 跳到锚点（搜索命中、评论定位、协同光标） */
  async scrollTo(anchor: Anchor): Promise<void> {
    await this.execute({
      id: `nav_${this.now()}`,
      type: 'nav.scrollToAnchor',
      args: { anchor },
      source: 'user',
      readonlySafe: true,
    })
  }

  /**
   * 保存。
   * 并发保护：同一时刻只允许一次保存，重复调用复用同一个 Promise，
   * 避免「Ctrl+S 连按两次」产生两个并发 PUT 与一次假冲突。
   */
  async save(options: SaveOptions = {}): Promise<SaveResult> {
    if (this.destroyed) {
      return { ok: false, revision: this.currentRevision, sha256: this.currentSha256 }
    }
    if (this.readonly && !options.force) {
      return { ok: false, revision: this.currentRevision, sha256: this.currentSha256 }
    }
    if (!this.currentDirty && !options.force) {
      // 没有改动就不发请求，避免无意义的版本推进
      return { ok: true, unchanged: true, revision: this.currentRevision, sha256: this.currentSha256 }
    }
    if (this.saveInFlight) return this.saveInFlight
    if (!this.transport && !this.saveHandler) {
      return { ok: false, revision: this.currentRevision, sha256: this.currentSha256 }
    }

    // 先记代次再取快照：快照等待期间的新编辑必须让本次保存结果失效
    const epoch = this.dirtyEpoch
    // 自带保存通道的内容面（服务端分页表格）没有整份快照，保存内容由它自己按操作列表提交
    const handler = this.saveHandler
    const source = handler
      ? this.request.source
      : this.snapshotAsync
        ? ((await this.snapshotAsync()) ?? this.request.source)
        : (this.snapshot?.() ?? this.request.source)
    this.transition('saving')
    const task = (async (): Promise<SaveResult> => {
      try {
        const result = handler
          ? await handler(options)
          : await this.transport!.save({
              fileId: this.fileId,
              collection: this.request.collection,
              revision: this.currentRevision,
              source,
              options,
            })
        if (result.ok) {
          this.currentRevision = result.revision
          this.currentSha256 = result.sha256 || this.currentSha256
          this.lastError = undefined
          // 保存期间又有改动：字节已含快照时刻之前的内容，但新改动还没落盘，保持脏态
          this.currentDirty = this.dirtyEpoch !== epoch
          this.transition('ready')
        } else if (result.conflict) {
          this.lastError = result.conflict.message
          this.transition('conflict')
        } else {
          this.lastError = result.reason ?? '保存失败'
          this.transition('error')
        }
        return result
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        const status = (err as { status?: unknown })?.status
        this.lastError = error.message
        // 409 是乐观锁冲突，不是故障：单独进入 conflict，UI 才能给出「重新加载 / 另存副本」
        this.transition(status === 409 ? 'conflict' : 'error')
        return {
          ok: false,
          revision: this.currentRevision,
          sha256: this.currentSha256,
          conflict:
            status === 409
              ? { serverRevision: this.currentRevision + 1, message: error.message }
              : undefined,
        }
      } finally {
        this.saveInFlight = null
      }
    })()

    this.saveInFlight = task
    return task
  }

  /** 冲突解决后由 UI 调用：接受服务端版本（丢弃本地改动） */
  acceptServerRevision(revision: number, sha256: string): void {
    this.currentRevision = revision
    this.currentSha256 = sha256
    this.currentDirty = false
    this.lastError = undefined
    this.history.clear()
    this.transition('ready')
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener)
    // 立即推一次当前状态，订阅方不必自己初始化
    listener(this.event())
    return () => {
      this.listeners.delete(listener)
    }
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.surface = null
    this.bus?.dispose()
    this.bus = null
    this.history.clear()
    this.transition('destroyed')
    this.listeners.clear()
  }

  private transition(phase: SessionPhase): void {
    this.currentPhase = phase
    this.emit()
  }

  /**
   * 通知订阅方。type 要如实写：Host 只在选区 / 脏标记变化时刷新工具栏高亮与大纲，
   * 以前这里一律发 'phase'，Host 的刷新条件永远不成立（发现：工具栏高亮、字数、页面草稿都不更新）
   */
  private emit(type: SessionEvent['type'] = 'phase'): void {
    if (this.listeners.size === 0) return
    const event = this.event(type)
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // 订阅方异常不能打断会话状态机，否则一次 UI 报错会让保存流程卡死
      }
    }
  }

  private event(type: SessionEvent['type'] = 'phase'): SessionEvent {
    return {
      type,
      phase: this.currentPhase,
      dirty: this.currentDirty,
      revision: this.currentRevision,
      readonly: this.readonly,
      selection: this.currentSelection,
      error: this.lastError,
    }
  }
}

/** 依据请求的格式/文件名推导 SurfaceKind；无法识别时按 text 兜底 */
function resolveKind(request: EditorOpenRequest): SurfaceKind {
  return resolveSurfaceKind(request.format || request.source.name) ?? 'text'
}
