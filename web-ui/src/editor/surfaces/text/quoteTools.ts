/**
 * 选中文字时跟在选区旁边的「评论」浮钮
 *
 * 为什么不沿用旧编辑器的判断（`view.hasFocus`）：
 * 旧实现要求编辑器有焦点才显示浮钮，但批注发生在只读阅读态——ProseMirror 的只读视图不可聚焦
 * （activeElement 永远不是它），在真实浏览器里浮钮一次都不会出现（用探针在 Chromium 里验证过）。
 * 这里改看浏览器自己的选区：选区非空、两端都落在正文里，就是“选中了正文里的文字”，与焦点无关。
 *
 * 为什么由内容面自己用 DOM 构建（和 FloatingTools 同理）：位置取决于选区的屏幕坐标，只有内容面拿得到；
 * 点击后只把“摘录 + 统一锚点”交给页面的评论栏，不碰文档，所以不进撤销栈、不经协同房间。
 */
import type { EditorView } from 'prosemirror-view'
import { buildQuoteAnchor, buildTextIndex } from '@/utils/quoteAnchor'
import type { TextComments } from '../../types'
import { textAnchorOfRange } from './quotes'

export interface QuoteToolsDeps {
  view: () => EditorView | null
  /** 每次现读：能不能新建批注随页面状态（编辑中、只读巡检、没有评论权限）变化 */
  comments: () => TextComments | undefined
  /** 一句话提示（选区为空 / 太长） */
  notify: (message: string) => void
}

const BUTTON_WIDTH = 72

export class QuoteTools {
  private el: HTMLButtonElement | null = null
  private frame = 0
  /** 鼠标按着正在拖选：这期间不弹，免得浮钮出现在光标下面截走 mouseup */
  private pressing = false

  private readonly schedule = () => {
    if (this.frame) return
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0
      this.update()
    })
  }
  private readonly onPress = () => {
    this.pressing = true
    this.hide()
  }
  private readonly onRelease = () => {
    if (!this.pressing) return
    this.pressing = false
    this.schedule()
  }

  constructor(private readonly deps: QuoteToolsDeps) {
    const doc = document
    // selectionchange 只在 document 上触发；滚动 / 缩放时浮钮是 fixed 定位，要跟着重新量
    doc.addEventListener('selectionchange', this.schedule)
    doc.addEventListener('mouseup', this.onRelease, true)
    doc.addEventListener('touchend', this.onRelease, true)
    window.addEventListener('scroll', this.schedule, true)
    window.addEventListener('resize', this.schedule)
    this.deps.view()?.dom.addEventListener('mousedown', this.onPress)
  }

  destroy(): void {
    document.removeEventListener('selectionchange', this.schedule)
    document.removeEventListener('mouseup', this.onRelease, true)
    document.removeEventListener('touchend', this.onRelease, true)
    window.removeEventListener('scroll', this.schedule, true)
    window.removeEventListener('resize', this.schedule)
    this.deps.view()?.dom.removeEventListener('mousedown', this.onPress)
    window.cancelAnimationFrame(this.frame)
    this.frame = 0
    this.el?.remove()
    this.el = null
  }

  /** 当前是否在显示（测试用） */
  get visible(): boolean {
    return !!this.el && !this.el.hidden
  }

  hide(): void {
    if (this.el) this.el.hidden = true
  }

  /** 选区 / 页面状态变化后调用：决定显示还是隐藏，并定位 */
  update(): void {
    const view = this.deps.view()
    const comments = this.deps.comments()
    if (!view || !comments?.canAnnotate() || this.pressing) return this.hide()
    const dom = view.dom
    const selection = dom.ownerDocument.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return this.hide()
    // 选区两端都在正文里才算“选中了正文”；点到页面别处选中的字不出现
    if (!selection.anchorNode || !selection.focusNode || !dom.contains(selection.anchorNode) || !dom.contains(selection.focusNode)) return this.hide()
    const { from, to, empty } = view.state.selection
    if (empty) return this.hide()
    const host = dom.parentElement
    if (!host) return this.hide()
    const button = this.ensure(host)
    button.hidden = false
    try {
      const start = view.coordsAtPos(from)
      const end = view.coordsAtPos(to)
      this.position(button, {
        right: Math.max(start.right, end.right),
        top: Math.min(start.top, end.top),
        bottom: Math.max(start.bottom, end.bottom),
      })
    } catch {
      // 没有布局（jsdom、隐藏的标签页）：不定位，样式里有兜底位置（与 FloatingTools 一致）
    }
  }

  private ensure(host: HTMLElement): HTMLButtonElement {
    if (this.el && this.el.parentElement === host) return this.el
    this.el?.remove()
    const button = host.ownerDocument.createElement('button')
    button.type = 'button'
    button.className = 'kb-quote-add'
    button.dataset.testid = 'annotate-selection'
    button.setAttribute('aria-label', '对选中的文字发表评论')
    button.textContent = '评论'
    // 点浮钮不能让选区消失：按下时阻止默认行为，选区保持
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', () => this.annotate())
    host.appendChild(button)
    this.el = button
    return button
  }

  private position(button: HTMLElement, rect: { right: number; bottom: number; top: number }): void {
    // 视口外（选区被滚走了）：不显示
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      button.hidden = true
      return
    }
    // 放在选区右下角下方一点；贴着视口右缘时往左收，免得被切掉
    const width = button.offsetWidth || BUTTON_WIDTH
    const height = button.offsetHeight || 32
    const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8)
    const top = Math.min(rect.bottom + 8, window.innerHeight - height - 8)
    button.style.left = `${left}px`
    button.style.top = `${Math.max(4, top)}px`
  }

  private annotate(): void {
    const view = this.deps.view()
    const comments = this.deps.comments()
    if (!view || !comments) return
    const { from, to } = view.state.selection
    const built = buildQuoteAnchor(buildTextIndex(view.state.doc), from, to)
    if (!built.ok) {
      this.deps.notify(built.reason)
      return
    }
    const anchor = textAnchorOfRange(view.state.doc, from, to, built.anchor.text)
    this.hide()
    comments.annotate(built.anchor, anchor)
  }
}
