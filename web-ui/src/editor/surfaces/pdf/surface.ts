/**
 * PDF Surface 控制器
 *
 * pdf.js 的内核不动，只把「查找 / 跳页 / 选区」接到统一契约：
 *  - 永远是只读面：命令层直接拒绝 undo/redo/insert/save，界面也不会出现假编辑入口；
 *  - 锚点是「页码 + 页内 rect」，rect 按 1 倍缩放归一，缩放后仍能落回同一句话；
 *  - 查找走 pdf.js 的 FindController，但 UI 计数交给 Host 的查找栏，避免两套状态。
 *
 * 这里不做「把整份 PDF 读成 bytes 再交给 pdf.js」：source.url 存在时交给查看器按 range 流式读取，
 * 50 页的文件也不会在首屏占两份内存；没有 url 的调用方（离线导出等）仍可回退到 bytes。
 */
import { createApp, h, ref, type App } from 'vue'
import type { Anchor, CommandResult, EditorCommand, EditorSource, Selection, Size, Surface, SurfaceContext, SurfaceQuery, SurfaceState } from '../../types'
import PdfSurfaceView from './PdfSurface.vue'

interface PdfSurfaceExposed {
  find: (query: string) => Promise<{ total: number; index: number }>
  findStep: (previous?: boolean) => Promise<{ total: number; index: number }>
  clearFind: () => void
  getFindState: () => { query: string; total: number; index: number }
  selectAnchor: (anchor: { kind: 'pdf'; page: number; rect?: { x: number; y: number; width: number; height: number } }) => boolean
  goTo: (page: number) => void
  getPage: () => number
  getPages: () => number
  getScale: () => number
  zoomBy: (factor: number) => void
  fit: () => void
  focus: () => void
}

/** 从 EditorSource 取 URL：优先显式 url，其次 bytes 没有地址时只能报错（交给 Host 回退文字层） */
function sourceUrl(source: EditorSource): string {
  return source.url ?? ''
}

export class PdfSurface implements Surface {
  private ctx: SurfaceContext | null = null
  private app: App | null = null
  private host: HTMLElement | null = null
  private viewRef = ref<PdfSurfaceExposed | null>(null)
  private currentSelection: Selection | null = null
  private pages = 0

  async mount(el: HTMLElement, ctx: SurfaceContext): Promise<void> {
    this.ctx = ctx
    const url = sourceUrl(ctx.document.payload as EditorSource)
    if (!url) throw new Error('PDF 缺少可读取的原件地址')
    el.classList.add('kb-pdf-surface-host')
    const hint = ctx.document.hint
    const hintPage = hint?.anchor?.kind === 'pdf' ? hint.anchor.page : undefined

    this.app = createApp({
      name: 'KbPdfSurfaceRoot',
      render: () =>
        h(PdfSurfaceView, {
          ref: this.viewRef,
          url,
          hitText: hint?.text ?? '',
          hitPage: hintPage ?? null,
          onReady: (pages: number) => this.onReady(pages),
          onError: (message: string) => ctx.onError?.(new Error(message)),
          onSelection: (payload: { anchor: Anchor; text: string; isEmpty: boolean }) => {
            this.currentSelection = {
              kind: 'pdf',
              anchor: payload.anchor,
              isEmpty: payload.isEmpty,
              text: payload.text || undefined,
            }
            ctx.onSelectionChange?.(this.currentSelection)
          },
        }),
    })
    this.app.mount(el)
    this.host = el
    ctx.session.setSnapshotProvider?.(() => null)
    ctx.onDirtyChange?.(false)
  }

  unmount(): void {
    this.app?.unmount()
    this.app = null
    this.viewRef.value = null
    this.host?.classList.remove('kb-pdf-surface-host')
    this.host = null
    this.ctx = null
  }

  resize(_size: Size): void {
    // pdf.js 自己监听容器尺寸并重排；这里不重复触发布局
  }

  focus(): void {
    this.viewRef.value?.focus()
  }

  setReadonly(_value: boolean): void {
    // PDF 永远只读，没有可切换状态
  }

  async command(command: EditorCommand): Promise<CommandResult> {
    const view = this.viewRef.value
    if (!view) return { ok: false, reason: 'surface_not_mounted' }
    switch (command.type) {
      case 'view.focus':
        view.focus()
        return { ok: true }
      case 'search.set': {
        const query = String((command.args as { query?: string } | undefined)?.query ?? '')
        if (!query) return { ok: true, data: { query: '', total: 0, index: -1, anchors: [] } }
        const result = await view.find(query)
        return { ok: true, data: this.findData(result) }
      }
      case 'search.next':
      case 'search.prev': {
        const result = await view.findStep(command.type === 'search.prev')
        return { ok: true, data: this.findData(result) }
      }
      case 'search.close':
        view.clearFind()
        return { ok: true, data: { query: '', total: 0, index: -1, anchors: [] } }
      case 'nav.anchor':
      case 'nav.scrollToAnchor': {
        const anchor = (command.args as { anchor?: Anchor } | undefined)?.anchor
        if (!anchor || anchor.kind !== 'pdf') return { ok: false, reason: 'unsupported_anchor' }
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
    const view = this.viewRef.value
    if (!view) return null
    switch (query.type) {
      case 'text':
        return ''
      case 'selection':
        return this.currentSelection
      case 'wordCount':
        return { words: this.pages, unitLabel: '页' }
      case 'outline':
        return []
      case 'formatState':
        return null
      case 'search':
        return view.getFindState()
      case 'anchorRect': {
        const anchor = (query.args as { anchor?: Anchor } | undefined)?.anchor
        if (!anchor || anchor.kind !== 'pdf') return null
        return this.pageRect(anchor)
      }
      default:
        return null
    }
  }

  capture(): SurfaceState {
    const view = this.viewRef.value
    return {
      kind: 'pdf',
      scrollTop: 0,
      zoom: undefined,
      selection: this.currentSelection,
      extra: { page: view?.getPage() ?? 1 },
    }
  }

  restore(state: SurfaceState): void {
    const page = Number(state.extra?.page ?? 0)
    if (page) this.viewRef.value?.goTo(page)
    const anchor = state.selection?.anchor
    if (anchor?.kind === 'pdf') this.viewRef.value?.selectAnchor(anchor)
  }

  private onReady(pages: number): void {
    this.pages = pages
    this.ctx?.onDirtyChange?.(false)
    // 页数是打开后才拿到的；不通知 Host 的话状态栏会一直停在「0 页」
    this.ctx?.onStatsChange?.()
  }

  /** 查找结果只带当前命中页：pdf.js 不公开全部 matches，Chrome 的计数仍来自它的 total/current */
  private findData(result: { total: number; index: number }): { query: string; total: number; index: number; anchors: Anchor[] } {
    const state = this.viewRef.value?.getFindState() ?? { query: '', total: result.total, index: result.index }
    const page = this.viewRef.value?.getPage() ?? 1
    const anchors: Anchor[] = result.total > 0 ? [{ kind: 'pdf', page, rect: { x: 0, y: 0, width: 0, height: 0 } }] : []
    return { query: state.query, total: result.total, index: result.index, anchors }
  }

  /** 锚点矩形：转成相对 Host 视口的坐标，供评论气泡 / 目录定位复用 */
  private pageRect(anchor: { kind: 'pdf'; page: number; rect?: { x: number; y: number; width: number; height: number } }): { x: number; y: number; width: number; height: number } | null {
    if (!anchor.rect || !this.host) return null
    const pageEl = this.host.querySelector(`.page[data-page-number="${anchor.page}"]`) as HTMLElement | null
    if (!pageEl) return null
    const page = pageEl.getBoundingClientRect()
    const host = this.host.getBoundingClientRect()
    // anchor.rect 是按 1 倍缩放存的；页面实际被 pdf.js 缩放过，投影回屏幕必须乘当前 scale
    const ratio = this.viewRef.value?.getScale() ?? 1
    return {
      x: page.left - host.left + anchor.rect.x * ratio,
      y: page.top - host.top + anchor.rect.y * ratio,
      width: anchor.rect.width * ratio,
      height: anchor.rect.height * ratio,
    }
  }
}
