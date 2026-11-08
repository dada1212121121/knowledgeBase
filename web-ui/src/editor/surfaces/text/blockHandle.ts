/**
 * 块手柄：悬停某个块时出现在它左边的「＋」和「⠿」
 *
 * 对应旧编辑器（Crepe 的 BlockEdit）：
 * - 「＋」：在这个块下面新起一个空段并打出 `/`，直接唤出斜杠菜单（和旧编辑器一致）；
 * - 「⠿」：按住拖动，把整个块挪到别处（拖动排序）。
 *
 * 拖动用 ProseMirror 自带的拖放：dragstart 时把这个块设成节点选区并告诉视图“正在拖它、落下时是移动”，
 * 落点的竖线由 cursors.ts 里的 dropcursor 画，落下后的移动、撤销栈、协同同步都走标准事务。
 * 键盘等价操作：Ctrl/⌘+Shift+↑/↓ 把当前块上移 / 下移一位（moveBlock），拖动不是唯一的排序方式。
 *
 * 只在有鼠标（hover + fine pointer）、可编辑、且块左边放得下手柄时出现；触屏另有贴键盘工具栏，不画手柄。
 */
import { NodeSelection, TextSelection, type Command, type Transaction } from 'prosemirror-state'
import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import { namedToolIcon, toolIconElement, type ToolIconName } from '../../host/toolIcons'
import { blockKind, CONVERT_TARGETS, convertBlock, convertibleTargets, deleteBlock, duplicateBlock, moveBlockAt, topIndexAt } from './blockMenu'

/** 手柄宽度（两个按钮 + 间隙）；块左边放不下就不显示，免得盖住正文 */
const HANDLE_WIDTH = 48

export interface BlockHandleDeps {
  view: () => EditorView | null
  /** 只读 / 协同房间未就绪时不显示 */
  isLocked: () => boolean
}

/** 顶层块：pos 是块起点，index 是它在文档里的序号 */
interface TopBlock {
  pos: number
  node: PMNode
  index: number
}

/** 光标 / 选区所在的顶层块；选区跨多个块时取起点所在的 */
export function topBlockAt(view: EditorView, pos: number): TopBlock | null {
  const { doc } = view.state
  if (pos < 0 || pos > doc.content.size) return null
  const $pos = doc.resolve(pos)
  if ($pos.depth === 0) {
    // 落在块与块之间：取后面的块（没有就取前面的）
    const index = Math.min($pos.index(), doc.childCount - 1)
    const node = doc.child(index)
    let start = 0
    for (let i = 0; i < index; i += 1) start += doc.child(i).nodeSize
    return { pos: start, node, index }
  }
  const index = $pos.index(0)
  return { pos: $pos.before(1), node: doc.child(index), index }
}

/** 把当前顶层块上移 / 下移一位；已在边上返回 false。选区跟着块走 */
export function moveBlock(direction: -1 | 1): Command {
  return (state, dispatch) => {
    const { doc, selection } = state
    const index = selection.$from.depth === 0 ? Math.min(selection.$from.index(), doc.childCount - 1) : selection.$from.index(0)
    const target = index + direction
    if (target < 0 || target >= doc.childCount) return false
    if (dispatch) {
      let start = 0
      for (let i = 0; i < index; i += 1) start += doc.child(i).nodeSize
      const node = doc.child(index)
      const tr = state.tr.delete(start, start + node.nodeSize)
      // 删掉之后，插入点前面有几个块：上移 = 目标块（前一个）之前的 target 个；下移 = 到原来的下一个块（现在顶到了 index 位）为止的 index + 1 个
      const before = direction < 0 ? target : index + 1
      let insertAt = 0
      for (let i = 0; i < before; i += 1) insertAt += tr.doc.child(i).nodeSize
      tr.insert(insertAt, node)
      // 光标回到原来的相对位置（块内偏移不变）
      const offset = selection.from - start
      const next = Math.min(insertAt + Math.max(1, offset), tr.doc.content.size)
      tr.setSelection(TextSelection.near(tr.doc.resolve(next)))
      dispatch(tr.scrollIntoView())
    }
    return true
  }
}

/** 块菜单里一项：转换目标或普通操作 */
interface MenuItem {
  label: string
  /** 工具栏图标名；没有就用 face 画成文字 */
  icon?: ToolIconName
  face?: string
  disabled?: boolean
  /** 转换目标里「现在就是这个类型」的那一项：打勾、不可点 */
  checked?: boolean
  danger?: boolean
  action: string
  run: () => Transaction | null
}

export class BlockHandle {
  private el: HTMLElement | null = null
  private current: TopBlock | null = null
  private hideTimer = 0
  private listening: HTMLElement | null = null
  /** 打开着的块菜单：记住它针对的块（节点本身），文档变了、块不在了就收起，不对着旧位置操作 */
  private menu: { el: HTMLElement; block: TopBlock; grip: HTMLElement } | null = null

  constructor(private readonly deps: BlockHandleDeps) {}

  /** 视图挂好后调用：在编辑区上监听鼠标移动 */
  attach(view: EditorView): void {
    const host = view.dom.parentElement
    if (!host || this.listening) return
    this.listening = host
    host.addEventListener('mousemove', this.onMove)
    host.addEventListener('mouseleave', this.scheduleHide)
  }

  destroy(): void {
    window.clearTimeout(this.hideTimer)
    this.listening?.removeEventListener('mousemove', this.onMove)
    this.listening?.removeEventListener('mouseleave', this.scheduleHide)
    this.listening = null
    this.closeMenu()
    this.hide()
  }

  /** 文档变化后块的位置变了：当前块失效就收起（块菜单同理：别人改了文档，菜单对着的块可能已经不在原处） */
  refresh(): void {
    const view = this.deps.view()
    if (!view) return
    const alive = (block: TopBlock) => (block.pos < view.state.doc.content.size ? view.state.doc.nodeAt(block.pos) : null) === block.node
    if (this.menu && !alive(this.menu.block)) this.closeMenu()
    if (this.current && !alive(this.current)) this.hide()
  }

  get menuOpen(): boolean {
    return this.menu !== null
  }

  closeMenu(): void {
    if (!this.menu) return
    const { el, grip } = this.menu
    this.menu = null
    el.remove()
    grip.setAttribute('aria-expanded', 'false')
    const doc = el.ownerDocument
    doc.removeEventListener('pointerdown', this.onOutside, true)
    doc.defaultView?.removeEventListener('scroll', this.onScroll, true)
  }

  get visible(): boolean {
    return this.el !== null
  }

  hide(): void {
    this.el?.remove()
    this.el = null
    this.current = null
  }

  private readonly scheduleHide = () => {
    window.clearTimeout(this.hideTimer)
    this.hideTimer = window.setTimeout(() => {
      // 鼠标移到手柄上时不收起（手柄在编辑区之外）
      if (this.el?.matches(':hover')) return
      this.hide()
    }, 250)
  }

  /** 有鼠标（能悬停、指针精确）才画手柄 */
  private hasMouse(): boolean {
    return typeof window.matchMedia === 'function' && window.matchMedia('(hover: hover) and (pointer: fine)').matches
  }

  private readonly onMove = (event: MouseEvent) => {
    const view = this.deps.view()
    if (!view || this.deps.isLocked() || !view.editable || !this.hasMouse()) return this.hide()
    // 手柄自己上面的移动不重新定位
    if (event.target instanceof Node && this.el?.contains(event.target)) {
      window.clearTimeout(this.hideTimer)
      return
    }
    const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
    if (!at) return this.scheduleHide()
    const block = topBlockAt(view, at.inside >= 0 ? at.inside : at.pos)
    if (!block) return this.scheduleHide()
    window.clearTimeout(this.hideTimer)
    if (this.current?.pos === block.pos && this.current.node === block.node && this.el) return
    this.show(view, block)
  }

  private show(view: EditorView, block: TopBlock): void {
    const dom = view.nodeDOM(block.pos)
    if (!(dom instanceof HTMLElement)) return this.hide()
    const rect = dom.getBoundingClientRect()
    // 左边放不下就不画，免得盖住正文（窄窗口）
    if (rect.left < HANDLE_WIDTH) return this.hide()
    this.hide()
    this.current = block
    const doc = view.dom.ownerDocument
    const el = doc.createElement('div')
    el.className = 'kb-block-handle'
    el.dataset.testid = 'block-handle'
    el.contentEditable = 'false'
    el.setAttribute('role', 'group')
    el.setAttribute('aria-label', '块操作')

    // 图标与工具栏同一套线性 SVG（设计规范：不用 ＋ ⠿ 这类字符图标，它们在各系统字体里粗细、位置都不一样）
    const add = doc.createElement('button')
    add.type = 'button'
    add.className = 'kb-block-btn kb-block-add'
    add.appendChild(toolIconElement(doc, namedToolIcon('plus'), 14))
    add.title = '在下方插入（输入 / 选择类型）'
    add.setAttribute('aria-label', '在下方插入')
    add.dataset.action = 'block-add'
    add.addEventListener('mousedown', (event) => event.preventDefault())
    add.addEventListener('click', () => this.insertBelow(view, block))

    const grip = doc.createElement('button')
    grip.type = 'button'
    grip.className = 'kb-block-btn kb-block-grip'
    grip.appendChild(toolIconElement(doc, namedToolIcon('grip'), 14))
    grip.title = '拖动排序；点一下打开块菜单（转换为、复制一份、上移 / 下移、删除）'
    grip.setAttribute('aria-label', '块操作（拖动排序，点击打开菜单）')
    grip.setAttribute('aria-haspopup', 'menu')
    grip.setAttribute('aria-expanded', 'false')
    grip.dataset.action = 'block-grip'
    grip.draggable = true
    grip.addEventListener('dragstart', (event) => this.dragStart(view, block, dom, event))
    // 拖动过就不会再派发 click：点一下（没拖）才开菜单
    grip.addEventListener('click', () => (this.menu?.block.node === block.node ? this.closeMenu() : this.openMenu(view, block, grip)))
    el.append(add, grip)

    // 第一行文字的垂直位置：行高随字号变，取块的顶边再对齐到首行中线
    const lineHeight = Number.parseFloat(getComputedStyle(dom).lineHeight) || 28
    el.style.left = `${Math.round(rect.left - HANDLE_WIDTH)}px`
    el.style.top = `${Math.round(rect.top + Math.max(0, (lineHeight - 24) / 2))}px`
    view.dom.parentElement?.appendChild(el)
    this.el = el
  }

  /**
   * 块菜单：转换为（只列这个块能变的类型）、复制一份、上移 / 下移、删除。
   * 是点出来的菜单，不是跟着光标飘的工具条；键盘：↑↓ 移动、回车执行、Esc 收起并把焦点还给正文。
   */
  private openMenu(view: EditorView, block: TopBlock, grip: HTMLElement): void {
    this.closeMenu()
    if (this.deps.isLocked() || !view.editable) return
    const doc = view.dom.ownerDocument
    const state = view.state
    const kind = blockKind(block.node)
    const targets = new Set<string>(convertibleTargets(block.node))
    const convert: MenuItem[] = CONVERT_TARGETS.filter((target) => targets.has(target.kind) || target.kind === kind).map((target) => ({
      label: target.label,
      icon: 'icon' in target ? (target.icon as ToolIconName) : undefined,
      face: 'face' in target ? target.face : undefined,
      checked: target.kind === kind,
      action: `convert-${target.kind}`,
      run: () => convertBlock(view.state, block.pos, target.kind),
    }))
    const index = topIndexAt(state, block.pos)
    const actions: MenuItem[] = [
      { label: '复制一份', icon: 'copy', action: 'duplicate', run: () => duplicateBlock(view.state, block.pos) },
      { label: '上移', icon: 'moveUp', action: 'move-up', disabled: index <= 0, run: () => moveBlockAt(view.state, block.pos, -1) },
      { label: '下移', icon: 'moveDown', action: 'move-down', disabled: index < 0 || index >= state.doc.childCount - 1, run: () => moveBlockAt(view.state, block.pos, 1) },
    ]
    const removal: MenuItem = { label: '删除', icon: 'trash', action: 'delete', danger: true, run: () => deleteBlock(view.state, block.pos) }

    const menu = doc.createElement('div')
    menu.className = 'kb-block-menu'
    menu.dataset.testid = 'block-menu'
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', '块操作')
    menu.contentEditable = 'false'
    menu.addEventListener('mousedown', (event) => event.preventDefault())
    const section = (title: string | null, items: MenuItem[]) => {
      if (!items.length) return
      if (menu.childElementCount) {
        const sep = doc.createElement('div')
        sep.className = 'kb-block-menu-sep'
        sep.setAttribute('role', 'separator')
        menu.appendChild(sep)
      }
      if (title) {
        const caption = doc.createElement('div')
        caption.className = 'kb-block-menu-title'
        caption.setAttribute('aria-hidden', 'true')
        caption.textContent = title
        menu.appendChild(caption)
      }
      for (const item of items) menu.appendChild(this.menuButton(doc, view, block, item))
    }
    // 现在的类型也列出来（打勾、不可点），一眼看出「它是什么、能变成什么」；什么都不能变的块（表格、提示块…）不显示这一段
    section(convert.length > 1 ? '转换为' : null, convert.length > 1 ? convert : [])
    section(null, actions)
    section(null, [removal])
    view.dom.parentElement?.appendChild(menu)
    grip.setAttribute('aria-expanded', 'true')
    this.menu = { el: menu, block, grip }
    this.placeMenu(menu, grip)
    menu.addEventListener('keydown', (event) => this.onMenuKey(event, view))
    doc.addEventListener('pointerdown', this.onOutside, true)
    doc.defaultView?.addEventListener('scroll', this.onScroll, true)
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  }

  private menuButton(doc: Document, view: EditorView, block: TopBlock, item: MenuItem): HTMLButtonElement {
    const button = doc.createElement('button')
    button.type = 'button'
    button.className = item.danger ? 'kb-block-menu-item is-danger' : 'kb-block-menu-item'
    button.dataset.action = item.action
    button.setAttribute('role', item.checked !== undefined ? 'menuitemradio' : 'menuitem')
    if (item.checked !== undefined) button.setAttribute('aria-checked', String(item.checked))
    button.disabled = !!item.disabled || !!item.checked
    const icon = doc.createElement('span')
    icon.className = item.face ? 'kb-block-menu-icon is-face' : 'kb-block-menu-icon'
    icon.setAttribute('aria-hidden', 'true')
    if (item.icon) icon.appendChild(toolIconElement(doc, namedToolIcon(item.icon), 16))
    else icon.textContent = item.face ?? ''
    const label = doc.createElement('span')
    label.className = 'kb-block-menu-label'
    label.textContent = item.label
    button.append(icon, label)
    if (item.checked) {
      const mark = doc.createElement('span')
      mark.className = 'kb-block-menu-check'
      mark.setAttribute('aria-hidden', 'true')
      mark.appendChild(toolIconElement(doc, namedToolIcon('check'), 14))
      button.appendChild(mark)
    }
    button.addEventListener('click', () => this.runMenu(view, block, item))
    return button
  }

  /** 执行菜单项：先确认菜单对着的块还在原处（节点没变），再派发事务；之后收起菜单与手柄，焦点回到正文 */
  private runMenu(view: EditorView, block: TopBlock, item: MenuItem): void {
    const still = block.pos < view.state.doc.content.size ? view.state.doc.nodeAt(block.pos) : null
    const tr = !this.deps.isLocked() && still === block.node ? item.run() : null
    this.closeMenu()
    this.hide()
    if (tr) view.dispatch(tr)
    view.focus()
  }

  /** 菜单贴在把手下面；下面放不下就翻到上面，左右夹进视口 */
  private placeMenu(menu: HTMLElement, grip: HTMLElement): void {
    const rect = grip.getBoundingClientRect()
    const win = menu.ownerDocument.defaultView
    const width = menu.offsetWidth || 220
    const height = menu.offsetHeight || 0
    const viewportW = win?.innerWidth || 1024
    const viewportH = win?.innerHeight || 768
    let top = rect.bottom + 4
    if (height && top + height > viewportH - 8) top = Math.max(8, rect.top - 4 - height)
    menu.style.left = `${Math.round(Math.max(8, Math.min(rect.left, viewportW - width - 8)))}px`
    menu.style.top = `${Math.round(top)}px`
  }

  private onMenuKey(event: KeyboardEvent, view: EditorView): void {
    const menu = this.menu?.el
    if (!menu) return
    if (event.key === 'Escape') {
      event.preventDefault()
      this.closeMenu()
      view.focus()
      return
    }
    if (event.key === 'Tab') {
      this.closeMenu()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    if (!buttons.length) return
    const at = buttons.indexOf(menu.ownerDocument.activeElement as HTMLButtonElement)
    const next =
      event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next]?.focus()
  }

  /** 点菜单和把手以外的地方收起菜单 */
  private readonly onOutside = (event: Event) => {
    const target = event.target instanceof Node ? event.target : null
    if (!this.menu || (target && (this.menu.el.contains(target) || this.menu.grip.contains(target)))) return
    this.closeMenu()
  }

  /** 正文滚动后菜单还停在原来的屏幕位置、对不上块了：收起 */
  private readonly onScroll = (event: Event) => {
    if (this.menu && event.target instanceof Node && this.menu.el.contains(event.target)) return
    this.closeMenu()
  }

  /** 在块下面新起一个空段并打出 `/`：斜杠菜单随之唤出 */
  private insertBelow(view: EditorView, block: TopBlock): void {
    if (this.deps.isLocked()) return
    const end = block.pos + block.node.nodeSize
    const paragraph = view.state.schema.nodes.paragraph.create(null, view.state.schema.text('/'))
    const tr = view.state.tr.insert(end, paragraph)
    tr.setSelection(TextSelection.near(tr.doc.resolve(end + 2)))
    view.dispatch(tr.scrollIntoView())
    this.hide()
    view.focus()
  }

  /** 开始拖动：整个块做节点选区，告诉视图“正在拖它、落下时是移动” */
  private dragStart(view: EditorView, block: TopBlock, dom: HTMLElement, event: DragEvent): void {
    if (this.deps.isLocked()) {
      event.preventDefault()
      return
    }
    const selection = NodeSelection.isSelectable(block.node)
      ? NodeSelection.create(view.state.doc, block.pos)
      : TextSelection.create(view.state.doc, block.pos + 1, block.pos + block.node.nodeSize - 1)
    view.dispatch(view.state.tr.setSelection(selection))
    const slice = view.state.selection.content()
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'copyMove'
      // 拖动时显示整个块的样子，而不是那个小把手
      event.dataTransfer.setDragImage(dom, 0, 0)
      event.dataTransfer.setData('text/plain', block.node.textContent)
    }
    ;(view as unknown as { dragging: { slice: unknown; move: boolean } }).dragging = { slice, move: true }
  }
}
