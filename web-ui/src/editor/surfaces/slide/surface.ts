/**
 * Slide Surface 控制器：幻灯片的阅读 / 放映面
 *
 * 契约上与 PDF / 分页文档面一致：查找、跳页、缩放走命令；锚点是 `{kind:'slide', slide}`（slide 1 起，
 * 与检索结果的 viewerHit 一致）。渲染后端由 `createLoader` 提供（引擎只读：pptx-read.ts；编辑：pptx-edit.ts），
 * 本文件不 import 任何引擎。
 */
import { createApp, h, ref, type App } from 'vue'
import type { Anchor, CommandResult, EditorCommand, Selection, Size, Surface, SurfaceContext, SurfaceQuery, SurfaceState } from '../../types'
import SlideView from './SlideView.vue'
import type { EditChange, SlideLoader, SlideSummary } from './types'

interface SlideViewExposed {
  find(query: string): Promise<{ total: number; index: number }>
  findStep(previous?: boolean): { total: number; index: number }
  clearFind(): void
  getFindState(): { query: string; total: number; index: number }
  getFindMatches(): { slide: number; shapeId: string }[]
  goTo(index: number): void
  reveal(slideNo: number, text?: string): Promise<void>
  getSlide(): number
  getSlides(): readonly SlideSummary[]
  getScale(): number
  zoomStep(direction: 1 | -1): void
  fit(mode?: 'page' | 'width'): void
  present(from?: number): void
  toggleNotes(): void
  toggleRail(): void
  invalidate(): void
  isPresenting(): boolean
  focus(): void
  undo(): boolean
  redo(): boolean
  refreshEditor(): void
}

/** 内容面从打开请求里得到后端加载函数的方式（只读 / 编辑各自提供） */
export type SlideLoaderFactory = (ctx: SurfaceContext) => SlideLoader

const EMPTY_FIND = { query: '', total: 0, index: -1, anchors: [] as Anchor[] }

export class SlideSurface implements Surface {
  protected ctx: SurfaceContext | null = null
  protected app: App | null = null
  protected host: HTMLElement | null = null
  protected viewRef = ref<SlideViewExposed | null>(null)
  protected currentSelection: Selection | null = null

  constructor(protected readonly createLoader: SlideLoaderFactory) {}

  /** 编辑后端的内容变了（只读面永远不会触发）；编辑面覆盖它来标脏 */
  protected onViewChange(_change: EditChange): void {}

  async mount(el: HTMLElement, ctx: SurfaceContext): Promise<void> {
    this.ctx = ctx
    el.classList.add('kb-slide-surface-host')
    const hint = ctx.document.hint
    const anchor = hint?.anchor?.kind === 'slide' ? hint.anchor : undefined
    const source = ctx.document.payload as { name?: string } | null
    const load = this.createLoader(ctx)
    this.app = createApp({
      name: 'KbSlideSurfaceRoot',
      render: () =>
        h(SlideView, {
          ref: this.viewRef,
          load,
          label: source?.name || '演示文稿',
          hitText: hint?.text ?? '',
          hitSlide: anchor?.slide || null,
          onReady: () => ctx.onStatsChange?.(),
          onError: (message: string) => ctx.onError?.(new Error(message)),
          onSlide: () => ctx.onStatsChange?.(),
          onChange: (change: EditChange) => this.onViewChange(change),
        }),
    })
    this.app.mount(el)
    this.host = el
    // 只读面没有本地快照：Host 的保存快捷键在这里是 no-op
    ctx.session.setSnapshotProvider?.(() => null)
    ctx.onDirtyChange?.(false)
  }

  unmount(): void {
    this.app?.unmount()
    this.app = null
    this.viewRef.value = null
    this.host?.classList.remove('kb-slide-surface-host')
    this.host = null
    this.ctx = null
  }

  resize(_size: Size): void {
    // 视图自己监听容器尺寸并重算「适应页面」
  }

  focus(): void {
    this.viewRef.value?.focus()
  }

  setReadonly(_value: boolean): void {
    // 阅读面永远只读；编辑面覆盖本方法
  }

  async command(command: EditorCommand): Promise<CommandResult> {
    const view = this.viewRef.value
    if (!view) return { ok: false, reason: 'surface_not_mounted' }
    switch (command.type) {
      case 'view.focus':
        view.focus()
        return { ok: true }
      case 'view.present':
        view.present()
        return { ok: true }
      case 'view.toggleNotes':
        view.toggleNotes()
        return { ok: true }
      case 'view.toggleRail':
        view.toggleRail()
        return { ok: true }
      case 'search.set': {
        const query = String((command.args as { query?: string } | undefined)?.query ?? '')
        if (!query) {
          view.clearFind()
          return { ok: true, data: { ...EMPTY_FIND } }
        }
        return { ok: true, data: this.findData(await view.find(query)) }
      }
      case 'search.next':
      case 'search.prev':
        return { ok: true, data: this.findData(view.findStep(command.type === 'search.prev')) }
      case 'search.close':
      case 'search.clear':
        view.clearFind()
        return { ok: true, data: { ...EMPTY_FIND } }
      case 'nav.anchor':
      case 'nav.scrollToAnchor': {
        const args = command.args as { anchor?: Anchor; text?: string } | undefined
        const anchor = args?.anchor
        if (!anchor || anchor.kind !== 'slide') return { ok: false, reason: 'unsupported_anchor' }
        // 带着命中文字来的（搜索结果联动）要高亮；只带页码的（大纲）只翻页
        if (args?.text) await view.reveal(anchor.slide || 1, args.text)
        else view.goTo((anchor.slide || 1) - 1)
        return { ok: true }
      }
      case 'slide.select': {
        const index = Number((command.args as { index?: number } | undefined)?.index)
        if (!Number.isFinite(index)) return { ok: false, reason: 'invalid_args' }
        view.goTo(index)
        return { ok: true }
      }
      case 'page.next':
        view.goTo(view.getSlide() + 1)
        return { ok: true }
      case 'page.prev':
        view.goTo(view.getSlide() - 1)
        return { ok: true }
      case 'zoom.in':
        view.zoomStep(1)
        return { ok: true }
      case 'zoom.out':
        view.zoomStep(-1)
        return { ok: true }
      case 'zoom.fit':
        view.fit()
        return { ok: true }
      default:
        return { ok: false, reason: `readonly_command:${command.type}` }
    }
  }

  async query(query: SurfaceQuery): Promise<unknown> {
    const view = this.viewRef.value
    if (!view) return null
    switch (query.type) {
      case 'text':
        return ''
      case 'selection':
        return this.currentSelection
      case 'wordCount':
        return { words: view.getSlides().length, unitLabel: '页' }
      case 'outline':
        return view.getSlides().map((slide, index) => ({
          level: 1,
          text: slide.title || `第 ${index + 1} 张`,
          anchor: { kind: 'slide', slide: index + 1 } satisfies Anchor,
        }))
      case 'formatState':
        return null
      case 'search':
        return view.getFindState()
      case 'slides':
        return view.getSlides()
      default:
        return null
    }
  }

  capture(): SurfaceState {
    const view = this.viewRef.value
    return {
      kind: 'slide',
      zoom: view?.getScale(),
      activeSlide: view?.getSlide() ?? 0,
      selection: this.currentSelection,
    }
  }

  restore(state: SurfaceState): void {
    if (typeof state.activeSlide === 'number') this.viewRef.value?.goTo(state.activeSlide)
  }

  /** 查找结果只带当前命中所在页：全部命中由视图高亮，Chrome 的计数来自 total / index */
  private findData(result: { total: number; index: number }): { query: string; total: number; index: number; anchors: Anchor[] } {
    const view = this.viewRef.value
    const state = view?.getFindState() ?? { query: '', total: result.total, index: result.index }
    const match = view?.getFindMatches()[result.index]
    const anchors: Anchor[] = match ? [{ kind: 'slide', slide: match.slide + 1, shape: match.shapeId }] : []
    return { query: state.query, total: result.total, index: result.index, anchors }
  }
}
