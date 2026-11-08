/**
 * Word 画布编辑内容面
 *
 * 与只读面 `PageSurface`（docx-preview 的 DOM 分页，0 WASM）并列：这里打开引擎编辑会话，
 * 页面由引擎在 Worker 里排版出图，输入走隐藏 textarea（见 DocxEditView.vue）。
 * 只负责生命周期、命令映射、状态快照和保存快照；绘制与输入在视图层，排版在引擎层。
 *
 * 保存：`DocumentSession` 保存时调用异步快照 → `engine.save` 先把没提交的输入落到引擎再取整份 docx 字节。
 */
import { createApp, h, nextTick, ref, shallowRef, type App } from 'vue'
import { openDocxEditSession, rasterizeDocxPages, readDocxBody, setDocxSuggesting, takePrefetchedDocxEngine, type DocxCollabHandle, type DocxEditEngine } from '../../../engines/docx'
import { createDocxCommandRunner, type DocxCommandRunner } from '../commands/runner'
import { settleSelection } from '../commands/settle'
import { toChromeFormatState } from '../commands/state'
import { isDocxCommandType } from '../commands/intents'
import { loadImageFile, pickImageFile } from '../commands/image'
import { createFindBackend } from './docx-find-backend'
import { DocxFindController, type FindRect } from './docx-find-controller'
import type { Anchor, CommandResult, EditorCommand, EditorSource, Size, Surface, SurfaceContext, SurfaceQuery, SurfaceState } from '../../../types'
import { CanvasStore } from './canvasStore'
import DocxEditView from './DocxEditView.vue'
import { fontNotice } from '../../../engines/docx/fontReport'
import { openPrintWindow } from '../../../engines/docx/printWindow'
import { createSingleFlight } from '../../../engines/docx/singleFlight'
import DocxReviewPanel from './DocxReviewPanel.vue'
import { createCommentBackend } from './docx-comments-backend'
import { DocxCommentController } from './docx-comment-controller'
import { createRevisionBackend } from './docx-revisions-backend'
import { DocxRevisionController, type RevisionView } from './docx-revisions'
import type { CommentThread } from './docx-comments'
import { createBodyCache, documentStats, outlineOf, plainTextOf } from './docx-stats'
import type { DocxSurfaceCollab } from './docx-collab'
import type { ReadingStart } from '../thumbs/scrollSync'

interface EditViewExposed {
  focus(): void
  revealDocumentY(y: number): boolean
  goTo(page: number): void
  selectAll(): void
  getPage(): number
  getPages(): number
  getScale(): number
  zoomBy(factor: number): void
  setZoom(value: number): void
  fit(): void
  isThumbsOpen(): boolean
  setThumbs(open?: boolean): void
  markThumbsDirty(from?: number): void
  capturePosition(): ReadingStart | null
  restorePosition(start: ReadingStart): void
  scroller: { value: HTMLElement | null }
}

/** 按容器宽度估一个打开时的缩放：窄屏（手机）直接按缩小后的像素密度出第一帧，省一次重新出图 */
function estimateInitialZoom(container: HTMLElement): number {
  const available = container.clientWidth - 24
  // 816 = Letter 在 96dpi 下的宽度；A4 是 794，估计略大一点只会稍微多缩一点点，真实宽度到了视图会校正
  return available > 0 && available < 816 ? Math.max(0.25, available / 816) : 1
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** 触发浏览器下载一个 Blob（导出用）；创建的链接和对象 URL 马上释放 */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  // 浏览器已经拿到下载任务后再释放；立刻释放在个别浏览器上会让下载变成 0 字节
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** 打印的光栅倍数：2 ≈ 192 dpi，纸面上文字边缘清晰，单页位图 ≈ 1632×2112 像素 */
const PRINT_SCALE = 2

export interface DocxEditSurfaceOptions {
  /**
   * 以多人协同模式打开：修改经传输和服务端房间同步，不用（也不能）手动保存——
   * 手动保存会越过房间的编码，用打开时的旧状态覆盖大家正在改的内容。
   */
  collab?: DocxSurfaceCollab
  /** 当前用户显示名：评论 / 修订的作者、"是我写的"的判定 */
  user?: string
  /** 文件名（不含扩展名决定导出文件名） */
  fileName?: string
  /**
   * 只看不改（只读预览里的「高保真查看」）：引擎只读打开，不抢输入焦点，缩略图直接用原件字节而不是让引擎保存。
   * 与是否只读（`ctx.readonly`）分开：被降级成只读的编辑会话仍然是编辑面，只是暂时不能改。
   */
  viewOnly?: boolean
  /** 缩略图栏的初始状态：true / false = 沿用之前的选择；缺省按容器宽度 */
  thumbs?: boolean | null
  /**
   * 编辑引擎会话打开完成（第一帧已经交给画面）时回调一次。
   * 外层用它把后台的无损检查排在首屏之后：检查要再开一个引擎会话，同时开会和首屏抢带宽 / CPU。
   */
  onEngineReady?: () => void
}

export class DocxEditSurface implements Surface {
  private ctx: SurfaceContext | null = null
  private app: App | null = null
  private host: HTMLElement | null = null
  private engine: DocxEditEngine | null = null
  private canvases = new CanvasStore()
  private viewRef = ref<EditViewExposed | null>(null)
  private panelRef = ref<{ focusDraft(): void } | null>(null)
  private disposed = false
  private zoom = 1
  private offStore: (() => void) | null = null
  private readonlyRef = ref(false)
  private get readonly(): boolean {
    return this.readonlyRef.value
  }
  private set readonly(value: boolean) {
    this.readonlyRef.value = value
  }
  /* 审阅侧栏：评论 + 修订 */
  private reviewOpen = ref(false)
  private reviewTab = ref<'comments' | 'revisions'>('comments')
  private commentThreads = shallowRef<readonly CommentThread[]>([])
  private revisionList = shallowRef<readonly RevisionView[]>([])
  private reviewNotice = ref('')
  /** 字体缺失提示：打开后读一次；空串 = 不显示 */
  private fontNotice = ref('')
  /** 正在准备打印：防止连点打开一堆窗口、各起一个临时会话 */
  private printFlight = createSingleFlight()
  private reviewBusy = ref(false)
  private tracking = ref(false)
  private comments: DocxCommentController | null = null
  private revisions: DocxRevisionController | null = null
  private reviewTimer: ReturnType<typeof setTimeout> | null = null
  private body: ReturnType<typeof createBodyCache> | null = null
  private runner: DocxCommandRunner | null = null
  private statsFrame: number | null = null
  private find: DocxFindController | null = null
  /** 查找命中的高亮块（响应式：View 据此画） */
  private findRects = shallowRef<readonly FindRect[]>([])
  private findRefreshTimer: ReturnType<typeof setTimeout> | null = null
  private findRepaintFrame: number | null = null
  /** 修订模式的作者（null = 关）；查找替换要据此决定是直接改还是出修订标记 */
  private suggestingAs: string | null = null
  private collabHandle = shallowRef<DocxCollabHandle | null>(null)
  /** 整篇排版完成（页数是最终的）：切换版式的外壳要等它，才能把阅读位置放过去 */
  private resolveReady: () => void = () => undefined
  private readonly readyPromise = new Promise<void>((resolve) => {
    this.resolveReady = resolve
  })

  constructor(private readonly options: DocxEditSurfaceOptions = {}) {}

  /** 整篇排版完成后 resolve；会话打开失败时不会 resolve（调用方以 mount 的拒绝为准） */
  whenReady(): Promise<void> {
    return this.readyPromise
  }

  /** 当前阅读位置与缩放（切到轻预览前记下） */
  capturePosition(): ReadingStart | null {
    return this.viewRef.value?.capturePosition() ?? null
  }

  /** 恢复阅读位置；要在 `whenReady` 之后调用 */
  restorePosition(start: ReadingStart): void {
    this.viewRef.value?.restorePosition(start)
  }

  isThumbsOpen(): boolean {
    return this.viewRef.value?.isThumbsOpen() ?? false
  }

  async mount(el: HTMLElement, ctx: SurfaceContext): Promise<void> {
    this.ctx = ctx
    this.host = el
    this.readonly = ctx.readonly
    const source = ctx.document.payload as EditorSource | null
    if (!source || source.kind !== 'bytes') throw new Error('Word 编辑需要二进制原件')
    el.classList.add('kb-docx-edit-host')
    this.zoom = estimateInitialZoom(el)

    const collab = this.options.collab
    // 只读连接（查看者）：能实时看到别人的修改和光标，自己的修改被引擎拒绝、服务端也会丢弃
    const readOnly = ctx.readonly || (collab ? !collab.writable : false)
    this.readonly = readOnly
    // 认领用户悬停「编辑」时预热好的 Worker（没有就照常新建）。只有这里认领：打开前的无损探测自己建临时会话，
    // 若它抢走预取，真正的编辑会话反而要冷启动
    const prefetched = await takePrefetchedDocxEngine()
    const engine = await openDocxEditSession({
      bytes: source.bytes,
      readOnly,
      ...(prefetched ? { client: prefetched } : {}),
      // 协同：身份与初始状态由房间给；图片按包里的部件引用，不进协同状态（否则带截图的手册状态有几十 MB）
      ...(collab ? { collab: { clientId: collab.clientId, initialUpdate: collab.initialUpdate }, mediaTokens: true } : {}),
      getRasterScale: () => (window.devicePixelRatio || 1) * this.zoom,
      canvasForPage: this.canvases.existing,
      ensureCanvas: (page) => void this.canvases.ensure(page),
      onError: (error) => ctx.onError?.(error),
      onRecoverableError: (error) => ctx.onError?.(error),
    })
    if (this.disposed) {
      engine.dispose()
      return
    }
    this.engine = engine
    // 引擎已就绪：通知外层可以开始后台的事了（不在这里做重活，回调自己决定怎么排）
    try {
      this.options.onEngineReady?.()
    } catch {
      // 回调是外层的事，它抛错不能让编辑面打不开
    }
    // 字体提示放后台读：它要加载字体包、解内嵌字体，不能拖慢首屏；读失败只是少一条提示，不影响编辑
    void engine
      .fontReport()
      .then((report) => {
        if (!this.disposed) this.fontNotice.value = fontNotice(report)
      })
      .catch(() => undefined)
    const binding = engine.binding
    const runner = createDocxCommandRunner(engine)
    this.runner = runner
    this.body = createBodyCache(
      async () => {
        await engine.flush()
        return readDocxBody(engine.client)
      },
      () => binding.viewStore.getSnapshot().version,
    )
    const me = this.options.user ?? collab?.userName ?? '我'
    // 命中 / 评论 / 修订选中之后，按引擎帧里的选区几何把它滚进可视区（目标所在页可能还没建，取不到矩形）
    const revealSelection = () => {
      const geometry = engine.binding.viewStore.getSnapshot().geometry
      const focus = geometry?.selectionRects?.[0] ?? geometry?.caret
      if (focus) this.viewRef.value?.revealDocumentY(focus.y)
    }
    this.comments = new DocxCommentController(createCommentBackend(engine, revealSelection), {
      me,
      editable: () => !this.readonly,
      onChange: (threads) => (this.commentThreads.value = threads),
    })
    this.revisions = new DocxRevisionController(createRevisionBackend(engine, revealSelection), {
      me,
      editable: () => !this.readonly,
      onChange: (list) => (this.revisionList.value = list),
    })
    this.find = new DocxFindController(createFindBackend(engine, () => (this.suggestingAs ? { name: this.suggestingAs } : undefined)), {
      onHighlights: (rects) => (this.findRects.value = rects),
      // 命中选中之后，引擎帧里的选区矩形 / 光标一定在命中上（已含页偏移）；按它滚。
      // 不用高亮矩形：命中所在页可能还没建出来，那时取不到矩形
      reveal: () => {
        const geometry = engine.binding.viewStore.getSnapshot().geometry
        const focus = geometry?.selectionRects?.[0] ?? geometry?.caret
        if (focus) this.viewRef.value?.revealDocumentY(focus.y)
      },
      pageOf: (pageIndex) => pageIndex + 1,
    })

    this.app = createApp({
      name: 'KbDocxEditRoot',
      render: () =>
        h('div', { class: 'kb-dex-shell', style: 'position:absolute;inset:0;display:flex;min-width:0;min-height:0' }, [
          h(DocxEditView, {
            ref: this.viewRef,
            engine,
            canvases: this.canvases,
            initialZoom: this.zoom,
            readOnly: this.readonly,
            autoFocus: !this.options.viewOnly,
            thumbs: this.options.thumbs ?? null,
            thumbSnapshot: this.options.viewOnly ? async () => source.bytes : undefined,
            onThumbs: () => ctx.onStatsChange?.(),
            runCommand: (type: string, args?: unknown) => this.runCommand(type, args),
            collab: this.collabHandle.value,
            findRects: this.findRects.value,
            fontNotice: this.fontNotice.value,
            onDismissFontNotice: () => (this.fontNotice.value = ''),
            onZoom: (scale: number) => {
              this.zoom = scale
            },
            onPageChange: () => ctx.onStatsChange?.(),
            onReady: () => ctx.onStatsChange?.(),
            // 整篇排版完成（页数是最终的）才算就绪：首帧只排前几页，这时放阅读位置会被夹到第 3 页
            onLayoutReady: () => this.resolveReady(),
          }),
          this.reviewOpen.value
            ? h(DocxReviewPanel, {
                ref: this.panelRef,
                tab: this.reviewTab.value,
                threads: this.commentThreads.value,
                revisions: this.revisionList.value,
                editable: !this.readonly,
                tracking: this.tracking.value,
                notice: this.reviewNotice.value,
                busy: this.reviewBusy.value,
                'onUpdate:tab': (tab: 'comments' | 'revisions') => {
                  this.reviewTab.value = tab
                  void this.refreshReview()
                },
                onClose: () => this.setReview(false),
                onDismiss: () => (this.reviewNotice.value = ''),
                'onAdd-comment': (text: string) => void this.reviewAction(() => this.comments!.add(text)),
                onReply: (parentId: string, text: string) => void this.reviewAction(() => this.comments!.reply(parentId, text)),
                onResolve: (id: string, done: boolean) => void this.reviewAction(() => this.comments!.setDone(id, done)),
                'onRemove-comment': (comment: Parameters<DocxCommentController['remove']>[0]) => void this.reviewAction(() => this.comments!.remove(comment)),
                'onRemove-thread': (thread: CommentThread) => void this.reviewAction(() => this.comments!.removeThread(thread)),
                'onReveal-comment': (id: string) => void this.comments?.reveal(id),
                'onReveal-revision': (id: string) => void this.revisions?.reveal(id),
                onDecide: (id: string, accept: boolean) => void this.reviewAction(() => this.revisions!.decide(id, accept)),
                'onDecide-all': (accept: boolean) => void this.reviewAction(() => this.revisions!.decideAll(accept)),
                'onToggle-tracking': () => this.setTracking(!this.tracking.value),
              })
            : null,
        ]),
    })
    this.app.mount(el)

    // 文档版本变了就是脏：选区移动不改版本，只有内容变化（含撤销 / 重做）才会
    let lastVersion = binding.viewStore.getSnapshot().version
    this.offStore = binding.viewStore.subscribe(() => {
      // 选区移动 / 格式变化都会改 editState：下一帧统一通知外壳重取工具栏高亮（合并同一帧内的多次变化）
      if (this.statsFrame === null) {
        this.statsFrame = requestAnimationFrame(() => {
          this.statsFrame = null
          this.ctx?.onStatsChange?.()
        })
      }
      // 页窗口移过去、新页建好了：当前命中若还没有高亮就补取一次（节流在 repaint 里：已有矩形就不问）
      if (this.find?.current.matches.length) {
        if (this.findRepaintFrame === null) {
          this.findRepaintFrame = requestAnimationFrame(() => {
            this.findRepaintFrame = null
            void this.find?.repaint()
          })
        }
      }
      const version = binding.viewStore.getSnapshot().version
      if (version === lastVersion) return
      lastVersion = version
      // 审阅栏开着：评论 / 修订可能被自己或协同里的别人改了，稍等一下重新读
      if (this.reviewOpen.value) {
        if (this.reviewTimer) clearTimeout(this.reviewTimer)
        this.reviewTimer = setTimeout(() => void this.refreshReview(), 300)
      }
      // 文档内容变了（自己或协同里别人改的）：查找命中的位置不再可信，稍等一下重新查，保持高亮和计数同步
      if (this.find?.current.query) {
        if (this.findRefreshTimer) clearTimeout(this.findRefreshTimer)
        this.findRefreshTimer = setTimeout(() => void this.find?.refresh(), 250)
      }
      // 协同内容由房间落地，本地脏标记没有意义（否则关闭时会误报"未保存"）
      if (!this.readonly && !this.options.collab) ctx.onDirtyChange?.(true)
    })

    if (collab) {
      // 房间负责落地：Host 的保存入口没有意义，明确清空快照，避免绕过房间覆盖正文
      ctx.session.setSnapshotProvider?.(null)
      ctx.onDirtyChange?.(false)
      // 视图（含远端光标层）先挂好再连房间：第一批同步进来时光标层已经在听视图变化
      this.collabHandle.value = engine.joinCollaboration({
        transport: collab.transport,
        user: { name: collab.userName, ...(collab.userColor ? { color: collab.userColor } : {}) },
        onStatus: collab.onStatus,
        onClosed: collab.onClosed,
      })
      return
    }
    // 同步 provider 给未改动时的原始字节；异步 provider 让引擎在保存时才重新打包
    ctx.session.setSnapshotProvider?.(
      () => ({ kind: 'bytes', name: source.name, bytes: source.bytes }) as EditorSource,
      async () => ({ kind: 'bytes', name: source.name, bytes: await engine.save() }) as EditorSource,
    )
    ctx.onDirtyChange?.(false)
  }

  unmount(): void {
    this.disposed = true
    this.offStore?.()
    this.offStore = null
    if (this.statsFrame !== null) cancelAnimationFrame(this.statsFrame)
    this.statsFrame = null
    if (this.reviewTimer) clearTimeout(this.reviewTimer)
    this.reviewTimer = null
    this.body = null
    this.comments = null
    this.revisions = null
    if (this.findRefreshTimer) clearTimeout(this.findRefreshTimer)
    this.findRefreshTimer = null
    if (this.findRepaintFrame !== null) cancelAnimationFrame(this.findRepaintFrame)
    this.findRepaintFrame = null
    this.find = null
    this.runner = null
    // 先退出房间（撤掉我的光标、停掉 Provider），再断传输，最后拆视图和引擎
    this.collabHandle.value?.leave()
    this.collabHandle.value = null
    this.options.collab?.transport.disconnect()
    this.app?.unmount()
    this.app = null
    this.viewRef.value = null
    this.engine?.dispose()
    this.engine = null
    this.canvases.dispose()
    this.host?.classList.remove('kb-docx-edit-host')
    this.host = null
    this.ctx = null
  }

  resize(_size: Size): void {
    // 视图自己监听容器尺寸并重算页窗口
  }

  focus(): void {
    this.viewRef.value?.focus()
  }

  setReadonly(value: boolean): void {
    this.readonly = value
    if (value && this.tracking.value) this.setTracking(false)
    const admission = this.engine?.binding.admission
    // 引擎侧同步只读：被收回编辑权后，输入框与命令都要立刻停手
    admission?.setReadOnly(value)
    // 只读打开的会话首屏只带了文档里已有的字形；放开编辑后用户会打新字，把字体补全
    if (!value) void this.engine?.completeFonts().catch(() => undefined)
  }

  async command(command: EditorCommand): Promise<CommandResult> {
    const view = this.viewRef.value
    const engine = this.engine
    if (!view || !engine) return { ok: false, reason: 'surface_not_mounted' }
    switch (command.type) {
      case 'view.focus':
        view.focus()
        return { ok: true }
      case 'view.selectAll':
        view.selectAll()
        return { ok: true }
      case 'view.toggleThumbs': {
        const open = (command.args as { open?: boolean } | undefined)?.open
        view.setThumbs(open)
        return { ok: true, data: { open: view.isThumbsOpen() } }
      }
      case 'view.toggleReview': {
        const tab = (command.args as { tab?: 'comments' | 'revisions' } | undefined)?.tab
        this.setReview(tab ? true : !this.reviewOpen.value, tab)
        return { ok: true }
      }
      case 'view.openComments':
        this.setReview(true, 'comments')
        // 面板挂好后把焦点放进评论框，用户可以直接写
        void nextTick().then(() => this.panelRef.value?.focusDraft())
        return { ok: true }
      case 'docx.trackChanges.toggle':
        if (this.readonly) return { ok: false, reason: '文档当前是只读的' }
        this.setTracking(!this.tracking.value)
        return { ok: true, data: { tracking: this.tracking.value } }
      case 'search.set': {
        const query = String((command.args as { query?: string } | undefined)?.query ?? '')
        return this.findCommand(() => this.find!.set(query))
      }
      case 'search.next':
      case 'search.prev':
        return this.findCommand(() => this.find!.step(command.type === 'search.prev'))
      case 'search.replace':
        return this.findCommand(() => this.find!.replaceOne(String((command.args as { text?: string } | undefined)?.text ?? '')))
      case 'search.replaceAll': {
        // 全部替换会改很多页：缩略图从头重画（光标所在页之前的页也可能变）
        const replaced = await this.findCommand(() => this.find!.replaceAll(String((command.args as { text?: string } | undefined)?.text ?? '')))
        view.markThumbsDirty(0)
        return replaced
      }
      case 'search.close':
      case 'search.clear':
        return this.find?.clear() ?? { ok: true }
      case 'zoom.in':
        view.zoomBy(1.2)
        return { ok: true }
      case 'zoom.out':
        view.zoomBy(1 / 1.2)
        return { ok: true }
      case 'zoom.fit':
        view.fit()
        return { ok: true }
      case 'nav.anchor':
      case 'nav.scrollToAnchor': {
        const anchor = (command.args as { anchor?: Anchor } | undefined)?.anchor
        if (!anchor || anchor.kind !== 'text') return { ok: false, reason: 'unsupported_anchor' }
        // 光标放到该段段首并滚过去；段落已经不在了（被删 / 协同里别人删了）如实说
        const { result, shown } = await settleSelection(
          engine.binding.commands.submit(
            { kind: 'select', payload: { selection: { anchor: { story: 'body', paraId: anchor.block, offset: 0 }, focus: { story: 'body', paraId: anchor.block, offset: 0 } } } } as never,
            { source: 'selection', fence: true },
          ),
        )
        if (!result.ok) return { ok: false, reason: 'anchor_lost' }
        // 光标几何随新一帧才到，等它装好再读，否则会滚到上一个光标的位置
        await shown
        const geometry = engine.binding.viewStore.getSnapshot().geometry
        const focus = geometry?.caret ?? geometry?.selectionRects?.[0]
        if (focus) view.revealDocumentY(focus.y)
        view.focus()
        return { ok: true }
      }
      case 'export.docx': {
        // 导出 = 下载：Word 下载保存后的 .docx，纯文本下载 .txt。引擎先把没提交的输入落下来再取字节
        try {
          const name = this.exportName()
          if ((command.args as { as?: string } | undefined)?.as !== 'text') {
            // 拷到普通 ArrayBuffer：保存后的字节不再复用，Blob 要求非共享缓冲
            downloadBlob(new Blob([new Uint8Array(await engine.save())], { type: DOCX_MIME }), `${name}.docx`)
          } else {
            const read = await this.body!.get()
            downloadBlob(new Blob([plainTextOf(read.paragraphs)], { type: 'text/plain;charset=utf-8' }), `${name}.txt`)
          }
          return { ok: true }
        } catch (error) {
          return { ok: false, reason: `导出失败：${error instanceof Error ? error.message : String(error)}` }
        }
      }
      case 'file.print':
        return this.print()
      case 'page.next':
        view.goTo(Math.min(view.getPages(), view.getPage() + 1))
        return { ok: true }
      case 'page.prev':
        view.goTo(Math.max(1, view.getPage() - 1))
        return { ok: true }
      // 外壳的撤销 / 重做按钮与快捷键发的是 undo / redo；统一落到引擎自己的历史
      case 'undo':
      case 'edit.undo':
        return this.finish(await this.runCommand('docx.undo'))
      case 'redo':
      case 'edit.redo':
        return this.finish(await this.runCommand('docx.redo'))
      default:
        if (isDocxCommandType(command.type) || command.type === 'docx.image.pick') {
          return this.finish(await this.runCommand(command.type, command.args))
        }
        return { ok: false, reason: `unsupported_command:${command.type}` }
    }
  }

  /** 导出文件名：原文件名去掉扩展名；没有就叫"文档" */
  private exportName(): string {
    const base = (this.options.fileName ?? '').replace(/\.[^./\\]+$/, '').trim()
    return base || '文档'
  }

  /** 打开 / 关闭审阅栏；打开时立刻读一次（评论和修订都可能在关着的时候被别人改过） */
  private setReview(open: boolean, tab?: 'comments' | 'revisions'): void {
    if (tab) this.reviewTab.value = tab
    this.reviewOpen.value = open
    if (open) void this.refreshReview()
    this.ctx?.onStatsChange?.()
  }

  private async refreshReview(): Promise<void> {
    if (!this.reviewOpen.value) return
    await Promise.all([this.comments?.refresh(), this.revisions?.refresh()]).catch((error) => {
      this.reviewNotice.value = `读取审阅内容失败：${error instanceof Error ? error.message : String(error)}`
    })
  }

  /** 评论 / 修订的动作：失败把原因放进侧栏提示（不是弹全局错误），成功清掉旧提示；动作期间按钮置灰防止连点 */
  private async reviewAction(action: () => Promise<CommandResult & { done?: number }>): Promise<void> {
    if (this.reviewBusy.value) return
    this.reviewBusy.value = true
    try {
      const result = await action()
      this.reviewNotice.value = result.ok ? '' : (result.reason ?? '操作没有成功')
      // 接受 / 拒绝修订会改变版面，且不一定在光标页：缩略图从头重画（评论不影响版面，但重画只是后台空闲时的事，不区分）
      if (result.ok) this.viewRef.value?.markThumbsDirty(0)
    } finally {
      this.reviewBusy.value = false
    }
  }

  /** 修订模式：之后所有输入、删除、格式、替换都带上作者，变成修订标记 */
  private setTracking(on: boolean): void {
    if (!this.engine || this.readonly) return
    this.tracking.value = on
    this.suggestingAs = on ? (this.options.user ?? this.options.collab?.userName ?? '我') : null
    setDocxSuggesting(this.engine, this.suggestingAs)
    this.ctx?.onStatsChange?.()
  }

  /** 查找类命令：引擎读失败（Worker 忙 / 文档刚换）要变成明确的失败结果，不能让异常冒到外壳变成"没反应" */
  private async findCommand(run: () => Promise<CommandResult>): Promise<CommandResult> {
    if (!this.find) return { ok: false, reason: 'surface_not_mounted' }
    try {
      return await run()
    } catch (error) {
      return { ok: false, reason: `查找失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** 命令执行完把焦点还给输入框（点工具栏按钮会抢走焦点，不还的话接着打字没反应） */
  private finish(result: CommandResult): CommandResult {
    this.viewRef.value?.focus()
    return result
  }

  /** 执行一条 `docx.*` 命令；插入图片要先弹文件选择框，这一步需要 DOM，所以在内容面里而不是执行器里做 */
  private async runCommand(type: string, args?: unknown): Promise<CommandResult> {
    const runner = this.runner
    if (!runner) return { ok: false, reason: 'surface_not_mounted' }
    if (type === 'docx.image.pick') {
      if (this.readonly) return { ok: false, reason: '文档当前是只读的' }
      try {
        const file = await pickImageFile()
        if (!file) return { ok: true, data: { cancelled: true } }
        const image = await loadImageFile(file)
        return runner.run('docx.image.insert', { image })
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error))
        this.ctx?.onError?.(failure)
        return { ok: false, reason: failure.message }
      }
    }
    const result = await runner.run(type, args)
    // 引擎拒绝 / 参数不合法要让用户看到，而不是点了没反应；"光标不在表格里"这类可用性提示不弹错误（按钮已置灰）
    if (!result.ok && result.reason && !/^(not_docx_command|文档当前是只读)/.test(result.reason) && !/请先/.test(result.reason)) {
      this.ctx?.onError?.(new Error(result.reason))
    }
    return result
  }

  async query(query: SurfaceQuery): Promise<unknown> {
    const view = this.viewRef.value
    if (!view) return null
    switch (query.type) {
      case 'wordCount': {
        // 真实字数（口径同 Word）；页数由页码条显示。读不出来时退回页数，不显示一个错的字数
        try {
          const read = await this.body!.get()
          const stats = documentStats(read.paragraphs)
          // 全文超过引擎单次读取上限时数字不完整，如实标出来
          return { words: stats.words, unitLabel: read.truncated ? '字（统计不完整）' : '字' }
        } catch {
          return { words: view.getPages(), unitLabel: '页' }
        }
      }
      case 'outline': {
        try {
          const read = await this.body!.get()
          return outlineOf(read.paragraphs).map((item) => ({
            level: item.level,
            text: item.text,
            anchor: { kind: 'text', block: item.paraId, offset: 0, quote: item.text } satisfies Anchor,
          }))
        } catch {
          return []
        }
      }
      case 'text': {
        const read = await this.body!.get().catch(() => null)
        return read ? plainTextOf(read.paragraphs) : ''
      }
      case 'search': {
        const state = this.find?.current
        return state ? { query: state.query, total: state.matches.length, index: state.index } : { query: '', total: 0, index: -1 }
      }
      case 'formatState':
        return this.runner ? toChromeFormatState(this.runner.formatState(), { tracking: this.tracking.value, review: this.reviewOpen.value, thumbs: view.isThumbsOpen() }) : null
      case 'comments':
        return this.commentThreads.value
      default:
        return null
    }
  }

  /**
   * 打印：每页取一张整页位图排进新窗口，再调浏览器打印。
   * 浏览器只在用户手势的同一个调用栈里放行 `window.open`，所以窗口必须在第一个 `await` 之前打开；
   * 被拦截（返回 null）就如实告诉用户去允许弹窗，不再默默失败。
   * 取的是**调用这一刻的字节快照**（隔离会话，见 `rasterizeDocxPages`）：打印途中继续编辑不会印出半新半旧的页，
   * 也不会碰用户正在看的页窗口。查看者也能打印，所以不是写动作。
   */
  private async print(): Promise<CommandResult> {
    const engine = this.engine
    if (!engine) return { ok: false, reason: 'surface_not_mounted' }
    // 单飞：进行中再点不开第二个窗口、不起第二个临时会话（守卫本身的并发行为见 singleFlight.spec.ts）。
    // `run` 在第一个 await 之前同步调用任务，所以任务里先开窗口仍然落在用户手势的调用栈里
    const outcome = await this.printFlight.run(async (): Promise<CommandResult> => {
      const session = openPrintWindow(this.options.fileName || '文档')
      if (!session) return { ok: false, reason: '浏览器拦截了打印窗口，请允许本站弹出窗口后再试' }
      try {
        session.setStatus('正在保存当前内容…')
        const bytes = await engine.save()
        session.setStatus('正在排版…')
        const pages = await rasterizeDocxPages(bytes, {
          scale: PRINT_SCALE,
          onProgress: (done, total) => session.setStatus(`正在生成第 ${done} / ${total} 页…`),
        })
        const printed = await session.present(pages.map((page) => page.dataUrl))
        return printed ? { ok: true, data: { pages: pages.length } } : { ok: false, reason: '打印窗口已关闭，已取消' }
      } catch (error) {
        session.abort()
        return { ok: false, reason: `打印失败：${error instanceof Error ? error.message : String(error)}` }
      }
    })
    return outcome.ran ? outcome.value : { ok: false, reason: '正在准备打印，请稍候' }
  }

  capture(): SurfaceState {
    const view = this.viewRef.value
    const scroller = view?.scroller.value
    return {
      kind: 'page',
      scrollTop: scroller?.scrollTop ?? 0,
      scrollLeft: scroller?.scrollLeft ?? 0,
      zoom: view?.getScale(),
      selection: null,
      extra: { page: view?.getPage() ?? 1 },
    }
  }

  restore(state: SurfaceState): void {
    const view = this.viewRef.value
    if (!view) return
    if (state.zoom) view.setZoom(state.zoom)
    const scroller = view.scroller.value
    if (scroller && state.scrollTop) scroller.scrollTop = state.scrollTop
  }
}

/** 供 OfficeEditor 的 `loadSurface` 使用 */
export function createDocxEditSurface(options: DocxEditSurfaceOptions = {}): Surface {
  return new DocxEditSurface(options)
}
