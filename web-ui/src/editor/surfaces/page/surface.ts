/**
 * Page Surface 控制器（设计规范）：分页文档的只读阅读面，带两个后端
 *
 * - **轻预览**（默认，0 WASM）：docx-preview 的 DOM 分页，见 docx-read.ts / DocxReadView.vue；
 * - **高保真查看**（用户点「高保真查看」才进）：画布编辑面 `DocxEditSurface` 以只读方式委托运行——引擎排版，
 *   版式与 Word 一致。这就是计划里「PageSurface 适配器：轻只读 DOM 后端与高保真 Canvas 后端无缝切换」：
 *   后端有两个了，接口就是现成的 `Surface` 契约，外壳（Host / Chrome）看到的始终是同一个 `PageSurface`，
 *   命令、查询、状态都转给当前后端，不另造一套。
 *
 * 高保真查看的约束（"只看不改"）：
 * - 不占编辑权、不进协同、不显示保存：编辑权 / 协同房间 / 保存通道都是页面层（OfficeEditor）的事，
 *   只读预览根本没有它们；这里把传给画布面的上下文做成只读，并把「保存快照提供者」换成空操作，
 *   画布面就不会往会话里挂任何可保存的东西；
 * - 与在线编辑共用引擎和预取：悬停 / 聚焦「高保真查看」时预取引擎，认领逻辑在 `DocxEditSurface.mount` 里；
 * - 切换保持位置：切走前记下视口中线所在的页 + 页内比例（和缩放），对面打开后放回去，来回页码不变。
 *   画布面失败（引擎起不来）时原样留在轻预览，不丢状态。
 *
 * 契约上与 PDF 面一致：永远只读；查找 / 跳页 / 缩放走命令；锚点是 `{kind:'page', page, text}`（轻预览）。
 */
import { createApp, h, ref, type App } from 'vue'
import type { Anchor, CommandResult, DocumentSession, EditorCommand, EditorSource, Selection, Size, Surface, SurfaceContext, SurfaceQuery, SurfaceState } from '../../types'
import type { DocxComment } from './docx-meta'
import DocxReadView from './DocxReadView.vue'
import type { PageAnchor } from './docx-anchors'
import type { OutlineEntry } from './docx-read'
import type { DocxEditSurface } from './edit/docxEditSurface'
import type { ReadingStart } from './thumbs/scrollSync'

/** 当前用哪个后端渲染 */
type Backend = 'light' | 'hifi'

/** 画布面第一帧几何最多等多久：冷开要下载并编译引擎，慢网络下可能很久，但不能无限等 */
const HIFI_READY_TIMEOUT_MS = 90_000

interface FindState {
  query: string
  total: number
  index: number
}

interface PageViewExposed {
  find: (query: string) => { total: number; index: number }
  findStep: (previous?: boolean) => { total: number; index: number }
  clearFind: () => void
  getFindState: () => FindState
  selectAnchor: (anchor: PageAnchor) => boolean
  goTo: (page: number) => void
  getPage: () => number
  getPages: () => number
  getScale: () => number
  zoomBy: (factor: number) => void
  fit: () => void
  focus: () => void
  selectAll: () => void
  selectionInfo: () => { anchor: PageAnchor; text: string; isEmpty: boolean } | null
  getOutline: () => OutlineEntry[]
  getComments: () => DocxComment[]
  isThumbsOpen: () => boolean
  setThumbs: (open?: boolean) => void
  capturePosition: () => ReadingStart | null
  getBuffer: () => ArrayBuffer | null
  restoreTo: (start: ReadingStart) => void
}

const EMPTY_FIND = { query: '', total: 0, index: -1, anchors: [] as Anchor[] }

export class PageSurface implements Surface {
  private ctx: SurfaceContext | null = null
  private app: App | null = null
  private host: HTMLElement | null = null
  private viewRef = ref<PageViewExposed | null>(null)
  private currentSelection: Selection | null = null
  private backend: Backend = 'light'
  /** 高保真后端：只读的画布编辑面；只在高保真查看期间存在 */
  private hifi: DocxEditSurface | null = null
  private stage: HTMLElement | null = null
  private loading: HTMLElement | null = null
  private switching = false
  /** 切到高保真前从轻预览取走的原件字节：回来时直接用，不再下载 */
  private buffer: ArrayBuffer | null = null
  private removePrefetch: (() => void) | null = null
  /** 打开高保真的过程中画布面报了错：让正在等第一帧的 `enterHifi` 立刻失败，不用干等超时 */
  private openFailure: ((error: Error) => void) | null = null

  async mount(el: HTMLElement, ctx: SurfaceContext): Promise<void> {
    this.ctx = ctx
    const source = ctx.document.payload as EditorSource | null
    const url = source?.url ?? ''
    if (!url) throw new Error('Word 文档缺少可读取的原件地址')
    el.classList.add('kb-page-surface-host')
    this.host = el
    this.mountLight({})
    this.removePrefetch = installHifiPrefetch()
    ctx.session.setSnapshotProvider?.(() => null)
    ctx.onDirtyChange?.(false)
  }

  /** 挂轻预览（DocxReadView）。`startAt` / `buffer` / `thumbs` 是从高保真查看回来时带回的状态 */
  private mountLight(options: { startAt?: ReadingStart | null; buffer?: ArrayBuffer | null; thumbs?: boolean | null }): void {
    const ctx = this.ctx!
    const el = this.host!
    const source = ctx.document.payload as EditorSource | null
    const url = source?.url ?? ''
    const hint = ctx.document.hint
    const hintAnchor = hint?.anchor?.kind === 'page' ? hint.anchor : undefined
    // 回来恢复位置时不再按搜索命中跳转：用户已经看了一阵，不该被拽回命中处
    const returning = !!options.startAt

    this.app = createApp({
      name: 'KbPageSurfaceRoot',
      render: () =>
        h(DocxReadView, {
          ref: this.viewRef,
          url,
          buffer: options.buffer ?? null,
          thumbs: options.thumbs ?? null,
          startAt: options.startAt ?? null,
          hitText: returning ? '' : (hintAnchor?.text ?? hint?.text ?? ''),
          hitPage: returning ? null : hintAnchor?.page || null,
          // 渲染完成、批注与大纲读完各通知一次：状态栏页数与大纲都是打开之后才知道
          onReady: () => ctx.onStatsChange?.(),
          onError: (message: string) => ctx.onError?.(new Error(message)),
          // 缩略图栏开关变了（含容器变窄后的默认值变化）：工具栏的"缩略图"高亮要跟着变
          onThumbs: () => ctx.onStatsChange?.(),
          onSelection: (payload: { anchor: PageAnchor; text: string; isEmpty: boolean }) => {
            this.currentSelection = { kind: 'page', anchor: payload.anchor, isEmpty: payload.isEmpty, text: payload.text || undefined }
            ctx.onSelectionChange?.(this.currentSelection)
          },
        }),
    })
    this.app.mount(el)
    this.backend = 'light'
  }

  unmount(): void {
    this.openFailure = null
    this.removePrefetch?.()
    this.removePrefetch = null
    this.hifi?.unmount()
    this.hifi = null
    this.stage?.remove()
    this.stage = null
    this.loading?.remove()
    this.loading = null
    this.app?.unmount()
    this.app = null
    this.viewRef.value = null
    this.buffer = null
    this.host?.classList.remove('kb-page-surface-host')
    this.host = null
    this.ctx = null
  }

  resize(size: Size): void {
    // 轻预览的视图自己监听容器宽度并重算"适应宽度"；画布面同样自己监听
    if (this.backend === 'hifi') this.hifi?.resize(size)
  }

  focus(): void {
    if (this.backend === 'hifi') this.hifi?.focus()
    else this.viewRef.value?.focus()
  }

  setReadonly(_value: boolean): void {
    // 永远只读
  }

  async command(command: EditorCommand): Promise<CommandResult> {
    if (command.type === 'view.hifi') return this.toggleHifi((command.args as { on?: boolean } | undefined)?.on)
    if (this.switching) return { ok: false, reason: '正在切换版式，请稍候' }
    // 高保真查看期间，其余命令（查找 / 跳页 / 缩放 / 缩略图…）都交给画布面
    if (this.backend === 'hifi') return this.hifi ? this.hifi.command(command) : { ok: false, reason: 'surface_not_mounted' }
    const view = this.viewRef.value
    if (!view) return { ok: false, reason: 'surface_not_mounted' }
    switch (command.type) {
      case 'view.toggleThumbs': {
        view.setThumbs((command.args as { open?: boolean } | undefined)?.open)
        return { ok: true, data: { open: view.isThumbsOpen() } }
      }
      case 'view.focus':
        view.focus()
        return { ok: true }
      case 'view.selectAll':
        view.selectAll()
        return { ok: true }
      case 'search.set': {
        const query = String((command.args as { query?: string } | undefined)?.query ?? '')
        if (!query) {
          view.clearFind()
          return { ok: true, data: { ...EMPTY_FIND } }
        }
        return { ok: true, data: this.findData(view.find(query)) }
      }
      case 'search.next':
      case 'search.prev':
        return { ok: true, data: this.findData(view.findStep(command.type === 'search.prev')) }
      case 'search.close':
        view.clearFind()
        return { ok: true, data: { ...EMPTY_FIND } }
      case 'nav.anchor':
      case 'nav.scrollToAnchor': {
        const anchor = (command.args as { anchor?: Anchor } | undefined)?.anchor
        if (!anchor || anchor.kind !== 'page') return { ok: false, reason: 'unsupported_anchor' }
        return view.selectAnchor(anchor) ? { ok: true } : { ok: false, reason: 'anchor_lost' }
      }
      case 'zoom.in':
        view.zoomBy(1.2)
        return { ok: true }
      case 'zoom.out':
        view.zoomBy(1 / 1.2)
        return { ok: true }
      case 'zoom.fit':
        view.fit()
        return { ok: true }
      case 'page.next':
        view.goTo(Math.min(view.getPages(), view.getPage() + 1))
        return { ok: true }
      case 'page.prev':
        view.goTo(Math.max(1, view.getPage() - 1))
        return { ok: true }
      default:
        return { ok: false, reason: `readonly_command:${command.type}` }
    }
  }

  async query(query: SurfaceQuery): Promise<unknown> {
    if (this.backend === 'hifi') {
      if (!this.hifi) return null
      const result = await this.hifi.query(query)
      // 工具栏的「高保真查看」按钮要亮着：在画布面上报的开关里补上 hifi
      if (query.type === 'formatState' && result && typeof result === 'object') {
        const state = result as { toggles?: string[] }
        return { ...state, toggles: [...(state.toggles ?? []), 'hifi'] }
      }
      return result
    }
    const view = this.viewRef.value
    if (!view) return null
    switch (query.type) {
      case 'text':
        return ''
      case 'selection':
        return this.currentSelection
      case 'wordCount':
        return { words: view.getPages(), unitLabel: '页' }
      case 'outline':
        return view.getOutline().map((item) => ({ level: item.level, text: item.text, anchor: { kind: 'page', page: item.page, text: item.text } satisfies PageAnchor }))
      case 'comments':
        return view.getComments()
      case 'formatState':
        // 只读预览没有格式状态，只有视图开关（缩略图栏）；工具栏据此高亮
        return { marks: [], block: '', inBlockquote: false, lists: { bullet: false, ordered: false, task: false }, toggles: view.isThumbsOpen() ? ['thumbs'] : [] }
      case 'search':
        return view.getFindState()
      case 'anchorRect': {
        const anchor = (query.args as { anchor?: Anchor } | undefined)?.anchor
        return anchor?.kind === 'page' ? this.pageRect(anchor) : null
      }
      default:
        return null
    }
  }

  capture(): SurfaceState {
    if (this.backend === 'hifi' && this.hifi) return this.hifi.capture()
    const view = this.viewRef.value
    const scroller = this.host?.querySelector<HTMLElement>('.kb-pgs-scroll')
    return {
      kind: 'page',
      scrollTop: scroller?.scrollTop ?? 0,
      scrollLeft: scroller?.scrollLeft ?? 0,
      zoom: view?.getScale(),
      selection: this.currentSelection,
      extra: { page: view?.getPage() ?? 1 },
    }
  }

  restore(state: SurfaceState): void {
    if (this.backend === 'hifi' && this.hifi) {
      this.hifi.restore(state)
      return
    }
    const scroller = this.host?.querySelector<HTMLElement>('.kb-pgs-scroll')
    if (scroller && state.scrollTop) scroller.scrollTop = state.scrollTop
    const page = Number(state.extra?.page ?? 0)
    if (page && !state.scrollTop) this.viewRef.value?.goTo(page)
  }

  /* ---------------- 高保真查看（画布后端） ---------------- */

  /** 切换后端；`on` 缺省 = 取反。成功 / 失败都如实返回，失败时留在原来的后端 */
  private async toggleHifi(on?: boolean): Promise<CommandResult> {
    if (!this.ctx || !this.host) return { ok: false, reason: 'surface_not_mounted' }
    if (this.switching) return { ok: false, reason: '正在切换版式，请稍候' }
    const want = on ?? this.backend === 'light'
    if (want === (this.backend === 'hifi')) return { ok: true, data: { hifi: this.backend === 'hifi' } }
    this.switching = true
    try {
      if (want) await this.enterHifi()
      else this.leaveHifi()
      return { ok: true, data: { hifi: this.backend === 'hifi' } }
    } catch (error) {
      return { ok: false, reason: `${want ? '高保真查看没有打开' : '返回轻预览失败'}：${error instanceof Error ? error.message : String(error)}` }
    } finally {
      this.switching = false
      this.ctx?.onStatsChange?.()
    }
  }

  /**
   * 传给画布面的上下文：只读、不脏、不碰会话的保存通道。
   * 会话（DocumentSession）是 Host 的，这里只给画布面它用到的两样：选区读取和"挂保存快照提供者"（换成空操作——
   * 只读预览没有保存，画布面也就不该往会话里登记任何可保存的东西）。
   */
  private hifiContext(bytes: Uint8Array, name: string): SurfaceContext {
    const ctx = this.ctx!
    const session = { getSelection: () => ctx.session.getSelection(), setSnapshotProvider: () => undefined } as unknown as DocumentSession
    return {
      session,
      document: { ...ctx.document, payload: { kind: 'bytes', bytes, name } satisfies EditorSource },
      permissions: ctx.permissions,
      readonly: true,
      onDirtyChange: () => undefined,
      onStatsChange: () => ctx.onStatsChange?.(),
      // 不能原样交给 Host：Host 收到 onError 会整块换成"出错"页，而高保真只是个可选的看法，
      // 轻预览一直好好的。打开途中出错 → 让 enterHifi 失败并如实告诉用户；打开之后出错 → 退回轻预览并提示
      onError: (error) => this.onHifiError(error),
    }
  }

  private onHifiError(error: Error): void {
    if (this.openFailure) {
      this.openFailure(error)
      return
    }
    if (this.backend !== 'hifi' || this.switching) return
    // 在画布面自己的回调里拆掉它不安全：下一个宏任务再退回
    setTimeout(() => {
      if (this.backend !== 'hifi' || !this.ctx) return
      this.leaveHifi()
      this.showNotice(`高保真查看出错，已回到轻预览：${error.message}`)
      this.ctx.onStatsChange?.()
    }, 0)
  }

  /** 宿主区顶部的一条可关闭提示（不走 Host 的出错页）；换后端时随挂载一起清掉 */
  private showNotice(text: string): void {
    const host = this.host
    if (!host) return
    const note = document.createElement('p')
    note.className = 'kb-pgs-shapes-notice kb-pgs-hifi-notice'
    note.setAttribute('role', 'status')
    note.dataset.testid = 'page-hifi-notice'
    const message = document.createElement('span')
    message.textContent = text
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'btn sm'
    close.textContent = '知道了'
    close.setAttribute('aria-label', '关闭提示')
    close.addEventListener('click', () => note.remove())
    note.append(message, close)
    host.prepend(note)
  }

  private showLoading(text: string): void {
    this.loading?.remove()
    const note = document.createElement('div')
    note.className = 'kb-pgs-hifi-loading'
    note.setAttribute('role', 'status')
    note.dataset.testid = 'page-hifi-loading'
    note.textContent = text
    this.host?.appendChild(note)
    this.loading = note
  }

  private async enterHifi(): Promise<void> {
    const view = this.viewRef.value
    const host = this.host!
    const ctx = this.ctx!
    const buffer = view?.getBuffer()
    if (!view || !buffer) throw new Error('文档还在加载，稍后再试')
    const start = view.capturePosition()
    const thumbs = view.isThumbsOpen()
    const name = (ctx.document.payload as EditorSource | null)?.name ?? '文档.docx'

    this.showLoading('正在载入高保真版式…')
    // 画布面挂在轻预览之上的舞台里，成功之后才拆轻预览：失败（引擎起不来 / 文档打不开）时轻预览原样还在
    const stage = document.createElement('div')
    stage.className = 'kb-pgs-hifi-stage'
    stage.dataset.testid = 'page-hifi-stage'
    host.appendChild(stage)
    // 动态引入：只读预览路径不为画布面的代码付体积，点了「高保真查看」才下载（引擎 WASM 更晚，在 mount 里）
    const { DocxEditSurface: Canvas } = await import('./edit/docxEditSurface')
    const hifi = new Canvas({ viewOnly: true, thumbs, fileName: name })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const failed = new Promise<never>((_, reject) => {
        this.openFailure = reject
        timer = setTimeout(() => reject(new Error('排版超时，可能是文档太大或网络较慢')), HIFI_READY_TIMEOUT_MS)
      })
      await Promise.race([hifi.mount(stage, this.hifiContext(new Uint8Array(buffer), name)).then(() => hifi.whenReady()), failed])
    } catch (error) {
      hifi.unmount()
      stage.remove()
      this.loading?.remove()
      this.loading = null
      throw error
    } finally {
      clearTimeout(timer)
      this.openFailure = null
    }
    if (!this.ctx) {
      // 加载期间窗口被关了
      hifi.unmount()
      return
    }
    // 成功：拆轻预览，画布面接管
    this.buffer = buffer
    this.app?.unmount()
    this.app = null
    this.viewRef.value = null
    this.hifi = hifi
    this.stage = stage
    this.backend = 'hifi'
    stage.classList.add('is-live')
    if (start) hifi.restorePosition(start)
    this.loading?.remove()
    this.loading = null
  }

  private leaveHifi(): void {
    const hifi = this.hifi
    if (!hifi) return
    const start = hifi.capturePosition()
    const thumbs = hifi.isThumbsOpen()
    hifi.unmount()
    this.stage?.remove()
    this.stage = null
    this.hifi = null
    this.mountLight({ startAt: start, buffer: this.buffer, thumbs })
  }

  /** 查找结果只带当前命中所在页：DOM 查找的全部命中由视图高亮，Chrome 的计数来自 total / index */
  private findData(result: { total: number; index: number }): { query: string; total: number; index: number; anchors: Anchor[] } {
    const state = this.viewRef.value?.getFindState() ?? { query: '', total: result.total, index: result.index }
    const page = this.viewRef.value?.getPage() ?? 1
    const anchors: Anchor[] = result.total > 0 ? [{ kind: 'page', page, text: state.query }] : []
    return { query: state.query, total: result.total, index: result.index, anchors }
  }

  /** 锚点所在页相对 Host 的矩形：评论气泡 / 目录定位用；只给到页级，页内位置随缩放变化不做承诺 */
  private pageRect(anchor: PageAnchor): { x: number; y: number; width: number; height: number } | null {
    if (!this.host || anchor.page < 1) return null
    const section = this.host.querySelectorAll<HTMLElement>('.kb-pgs-host section.kbdocx')[anchor.page - 1]
    if (!section) return null
    const page = section.getBoundingClientRect()
    const host = this.host.getBoundingClientRect()
    return { x: page.left - host.left, y: page.top - host.top, width: page.width, height: page.height }
  }
}

/**
 * 悬停 / 聚焦工具栏上的「高保真查看」时预取画布引擎（与「在线编辑」共用同一个预取槽，点击后 `DocxEditSurface.mount` 认领）。
 * 工具栏是 Chrome 渲染的，内容面拿不到按钮元素，所以在文档上做委托：按钮由内置扩展注册，`data-action` 就是它的 id。
 * 预取槽自己有宽限期和幂等保护（移开不点，几秒后销毁），这里不需要额外去抖。
 */
const HIFI_ACTION = '[data-action="page.hifi"]'
function installHifiPrefetch(): () => void {
  if (typeof document === 'undefined') return () => undefined
  const hit = (event: Event) => (event.target as HTMLElement | null)?.closest?.(HIFI_ACTION)
  const warm = (event: Event) => {
    if (hit(event)) void import('../../engines/docx').then((engine) => engine.prefetchDocxEngine()).catch(() => undefined)
  }
  const cool = (event: Event) => {
    if (hit(event)) void import('../../engines/docx').then((engine) => engine.releaseDocxPrefetch()).catch(() => undefined)
  }
  document.addEventListener('pointerover', warm)
  document.addEventListener('focusin', warm)
  document.addEventListener('pointerout', cool)
  document.addEventListener('focusout', cool)
  return () => {
    document.removeEventListener('pointerover', warm)
    document.removeEventListener('focusin', warm)
    document.removeEventListener('pointerout', cool)
    document.removeEventListener('focusout', cool)
  }
}
