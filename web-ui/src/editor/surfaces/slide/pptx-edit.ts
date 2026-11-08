/**
 * 幻灯片编辑控制器：选择、拖动、缩放、文字输入（含输入法）、插入、层级、对齐、撤销
 *
 * 为什么是一个与 Vue 组件分开的类：手势和输入状态机又长又容易出错（拖动阈值、吸附、输入法组字期间不能碰文档……），
 * 只有脱离 DOM 才能用假后端写出覆盖所有分支的单测；组件层（SlideEditLayer.vue）只负责把指针 / 键盘事件翻译成这里的调用，
 * 再把 `state` 画出来。
 *
 * 几个重要约定：
 * - 坐标全是幻灯片坐标（缩放 1 的 CSS 像素），组件层负责从屏幕坐标换算；
 * - 拖动 / 缩放期间**不改文档**，只改 `preview`（叠加层上的虚框），松手时一次性提交，整批算一个撤销步；
 * - 每个"用户动作"开头先 `boundary`：把它和前一个动作在撤销栈里隔开；同一个动作里的多个修改（多选移动、对齐）
 *   在同一个事件循环里完成，由引擎合并成一步；连续打字则不加切刀，让引擎按时间窗口合并；
 * - 输入法组字期间不改文档：预编辑文字只显示在叠加层的光标处，`compositionend` 才一次性写入（一次撤销一步），
 *   这样取消组字、切换候选都不会在文档里留下拼音字母；
 * - 引擎拒绝的操作（只读、形状已被别人删掉……）不抛给界面：记成 `notice`，状态保持不变。
 */
import { computed, shallowRef } from 'vue'
import { alignRects, distributeRects, type AlignKind, type DistributeKind } from './align'
import { boundingBox, snapRect, type Guide, type HandleId, type Point } from './overlay'
import { resizeRect } from './resize'
import { shiftOffset, textDelta } from './textShift'
import type { CaretInfo, CaretMove, EditShape, ShapePreset, SlideEditBackend, SlideRect, TextStyleInfo, TextStylePatch, ZOrder } from './types'

export interface TextSel {
  shapeId: string
  storyId: string
  anchor: number
  focus: number
  /** 光标所在行（折行边界消歧）与上下移动时要保持的 x */
  line: number
  preferredX: number | null
}

export interface EditorHooks {
  backend: SlideEditBackend
  /** 当前页（0 起） */
  index(): number
  /** 当前缩放（CSS 宽度 / 幻灯片宽度） */
  scale(): number
  /** 提示（引擎拒绝 / 能力限制）：界面显示成一条会自己消失的消息 */
  notify?(message: string): void
  /** 新建 / 复制页之后切到新页 */
  gotoSlide?(index: number): void
  /** 进入文字编辑后，把键盘焦点交给隐藏输入框 */
  focusInput?(): void
}

const DRAG_THRESHOLD_PX = 3
const SNAP_PX = 6
const NUDGE = 1
const NUDGE_BIG = 10

const emptyStyle: TextStyleInfo = { bold: false, italic: false, underline: false, fontSizePt: null, color: null, align: null }

type Gesture =
  | { kind: 'move'; origin: Point; moved: boolean; starts: Map<string, SlideRect> }
  | { kind: 'resize'; handle: HandleId; origin: Point; start: SlideRect; shapeId: string; lockAspect: boolean }
  | { kind: 'text'; storyId: string }
  | null

export class SlideEditor {
  /* 状态：每块单独一个 shallowRef，整体替换，不让 Vue 深度代理形状数组 */
  readonly shapes = shallowRef<EditShape[]>([])
  readonly selected = shallowRef<string[]>([])
  readonly text = shallowRef<TextSel | null>(null)
  readonly caret = shallowRef<CaretInfo | null>(null)
  readonly selRects = shallowRef<SlideRect[]>([])
  readonly preedit = shallowRef<string | null>(null)
  readonly guides = shallowRef<Guide[]>([])
  /** 拖动 / 缩放期间的虚框（形状 id → 矩形）；null = 没在拖 */
  readonly preview = shallowRef<Map<string, SlideRect> | null>(null)
  readonly style = shallowRef<TextStyleInfo>(emptyStyle)
  readonly history = shallowRef({ undo: false, redo: false })
  readonly notice = shallowRef('')
  /** 只读标志的响应式镜像（后端的 readonly 是普通属性，工具栏要能随它变灰） */
  readonly readonlyRef = shallowRef(false)

  /** 选中形状的包围盒（拖动中用虚框）；多选 / 单选都有，决定要不要画控制点 */
  readonly box = computed<SlideRect | null>(() => {
    const preview = this.preview.value
    const rects = this.selectedShapes().map((shape) => preview?.get(shape.id) ?? shape.rect)
    return boundingBox(rects)
  })

  /** 单选且能缩放才画控制点（多选只能整体移动） */
  readonly resizable = computed(() => {
    const only = this.selectedShapes()
    return only.length === 1 && only[0]!.canResize
  })

  private gesture: Gesture = null
  private pendingStyle: TextStylePatch | null = null
  private composing = false
  private composeFrom = 0
  private composeTo = 0
  private trailing: string | null = null
  /** 上一次看到的、正在输入的那段文字：别人改了它以后据此算光标该挪到哪 */
  private lastStory: { id: string; text: string } | null = null
  private disposed = false
  private offChange: (() => void) | null = null
  private noticeTimer = 0

  constructor(private readonly hooks: EditorHooks) {
    this.readonlyRef.value = hooks.backend.readonly
    this.offChange = hooks.backend.onChange((change) => this.refresh(change.remote))
    this.refresh()
  }

  get backend(): SlideEditBackend {
    return this.hooks.backend
  }

  dispose(): void {
    this.disposed = true
    this.offChange?.()
    window.clearTimeout(this.noticeTimer)
  }

  /* ---------------- 状态刷新 ---------------- */

  /** 后端内容变了 / 换了页：重读形状，校验选择与光标，更新工具栏状态 */
  refresh(remote = false): void {
    if (this.disposed) return
    this.readonlyRef.value = this.hooks.backend.readonly
    const index = this.hooks.index()
    const shapes = this.hooks.backend.shapes(index)
    this.shapes.value = shapes
    const ids = new Set(shapes.map((shape) => shape.id))
    const selected = this.selected.value.filter((id) => ids.has(id))
    if (selected.length !== this.selected.value.length) this.selected.value = selected
    const text = this.text.value
    if (text && !ids.has(text.shapeId) && !this.cellOfSelectedTable(text)) {
      this.endText()
      // 协同：正在输入的文本框被别人删了，光标会凭空消失——说一声，免得以为输入法坏了
      if (remote) this.say('这个文本框已被其他人删除，输入已结束')
    }
    // 协同：别人在我前面改了文字，我的光标 / 选区要跟着挪，否则下一个字会落在错的位置
    if (remote) this.followRemoteText()
    this.refreshText()
    this.history.value = { undo: this.hooks.backend.canUndo(), redo: this.hooks.backend.canRedo() }
  }

  private followRemoteText(): void {
    const text = this.text.value
    const last = this.lastStory
    if (!text || !last || last.id !== text.storyId) return
    const delta = textDelta(last.text, this.hooks.backend.storyText(text.storyId))
    if (!delta) return
    this.text.value = { ...text, anchor: shiftOffset(text.anchor, delta), focus: shiftOffset(text.focus, delta) }
  }

  /** 表格单元格的文本流不在顶层形状的 storyId 里，但所属表格还在就不算丢 */
  private cellOfSelectedTable(text: TextSel): boolean {
    return this.shapes.value.some((shape) => shape.id === text.shapeId)
  }

  private refreshText(): void {
    const text = this.text.value
    if (!text) {
      this.lastStory = null
      this.caret.value = null
      this.selRects.value = []
      const only = this.selectedShapes()[0]
      this.style.value = only?.storyId ? this.hooks.backend.styleAt(only.storyId, 1) : emptyStyle
      return
    }
    const backend = this.hooks.backend
    const index = this.hooks.index()
    const body = backend.storyText(text.storyId)
    this.lastStory = { id: text.storyId, text: body }
    const length = body.length
    const clamp = (value: number) => Math.min(Math.max(0, value), length)
    if (text.anchor > length || text.focus > length) this.text.value = { ...text, anchor: clamp(text.anchor), focus: clamp(text.focus) }
    const current = this.text.value!
    this.caret.value = backend.caret(index, current.storyId, current.focus, current.line)
    const start = Math.min(current.anchor, current.focus)
    const end = Math.max(current.anchor, current.focus)
    this.selRects.value = start === end ? [] : backend.selectionRects(index, current.storyId, start, end)
    const base = backend.styleAt(current.storyId, Math.max(start, start === end ? current.focus : start + 1))
    this.style.value = this.pendingStyle ? { ...base, ...this.pendingStyle } : base
  }

  private selectedShapes(): EditShape[] {
    const ids = new Set(this.selected.value)
    return this.shapes.value.filter((shape) => ids.has(shape.id))
  }

  private say(message: string): void {
    this.notice.value = message
    this.hooks.notify?.(message)
    window.clearTimeout(this.noticeTimer)
    this.noticeTimer = window.setTimeout(() => (this.notice.value = ''), 4000)
  }

  /** 包一层：引擎拒绝 / 抛错 → 提示，状态保持；成功返回 true */
  private attempt(action: () => void, label = '这个操作'): boolean {
    try {
      action()
      return true
    } catch (error) {
      this.say(`${label}没有成功：${error instanceof Error ? error.message : String(error)}`)
      this.refresh()
      return false
    }
  }

  private cut(): void {
    this.hooks.backend.boundary()
  }

  get readonly(): boolean {
    return this.readonlyRef.value
  }

  /* ---------------- 选择 ---------------- */

  select(ids: string[]): void {
    this.selected.value = ids
    if (this.text.value && !ids.includes(this.text.value.shapeId)) this.endText()
    this.refreshText()
  }

  clearSelection(): void {
    this.selected.value = []
    this.endText()
    this.refreshText()
  }

  selectAll(): void {
    this.select(this.shapes.value.filter((shape) => shape.canMove).map((shape) => shape.id))
  }

  /** Tab / Shift+Tab 在形状间循环 */
  cycle(backwards = false): void {
    const list = this.shapes.value
    if (!list.length) return
    const current = list.findIndex((shape) => shape.id === this.selected.value.at(-1))
    const next = (current + (backwards ? -1 : 1) + list.length) % list.length
    this.select([list[next]!.id])
  }

  /* ---------------- 指针 ---------------- */

  /** 指针按下：返回命中的是文字 / 形状 / 空白，组件层据此决定是否捕获指针 */
  pointerDown(point: Point, mods: { shift?: boolean; detail?: number } = {}): 'text' | 'shape' | 'none' {
    if (this.readonly) return 'none'
    const index = this.hooks.index()
    const scale = this.hooks.scale()
    const hit = this.hooks.backend.hit(index, point.x, point.y, scale)
    // 正在编辑的文本框里再点一下：只移动光标，不切换选择
    if (hit?.kind === 'text' && this.text.value?.storyId === hit.storyId) {
      this.placeCaret(hit.storyId, point, !!mods.shift)
      this.gesture = { kind: 'text', storyId: hit.storyId }
      return 'text'
    }
    if (!hit) {
      if (!mods.shift) this.clearSelection()
      return 'none'
    }
    const shape = this.shapes.value.find((item) => item.id === hit.shapeId)
    if (hit.kind === 'text') {
      this.selected.value = [hit.shapeId]
      this.beginText(hit.shapeId, hit.storyId, hit.position, hit.position)
      this.gesture = { kind: 'text', storyId: hit.storyId }
      return 'text'
    }
    // 形状（含文本框的边框、图片、表格边缘）
    this.endText()
    if (mods.shift) {
      const set = new Set(this.selected.value)
      if (set.has(hit.shapeId)) set.delete(hit.shapeId)
      else set.add(hit.shapeId)
      this.selected.value = [...set]
    } else if (!this.selected.value.includes(hit.shapeId)) {
      this.selected.value = [hit.shapeId]
    }
    this.refreshText()
    if (mods.detail === 2 && shape?.storyId && this.selected.value.length === 1) {
      this.beginText(shape.id, shape.storyId, undefined, undefined)
      return 'text'
    }
    const movable = this.selectedShapes().filter((item) => item.canMove)
    if (movable.length && this.selected.value.includes(hit.shapeId)) {
      this.gesture = { kind: 'move', origin: point, moved: false, starts: new Map(movable.map((item) => [item.id, item.rect])) }
    }
    return 'shape'
  }

  /** 从某个控制点开始缩放（单选且 canResize） */
  startResize(handle: HandleId, point: Point, mods: { shift?: boolean } = {}): void {
    if (this.readonly) return
    const only = this.selectedShapes()
    if (only.length !== 1 || !only[0]!.canResize) return
    const shape = only[0]!
    const corner = handle.length === 2
    this.gesture = { kind: 'resize', handle, origin: point, start: shape.rect, shapeId: shape.id, lockAspect: corner && (shape.aspectLocked || !!mods.shift) }
  }

  pointerMove(point: Point, mods: { alt?: boolean; shift?: boolean } = {}): void {
    const gesture = this.gesture
    if (!gesture) return
    const scale = this.hooks.scale()
    if (gesture.kind === 'text') {
      this.placeCaret(gesture.storyId, point, true)
      return
    }
    const dx = point.x - gesture.origin.x
    const dy = point.y - gesture.origin.y
    if (gesture.kind === 'move') {
      if (!gesture.moved && Math.hypot(dx, dy) * scale < DRAG_THRESHOLD_PX) return
      gesture.moved = true
      const rects = [...gesture.starts.values()]
      const group = boundingBox(rects)!
      let delta = { x: dx, y: dy }
      let guides: Guide[] = []
      if (!mods.alt) {
        const others = this.shapes.value.filter((shape) => !gesture.starts.has(shape.id) && shape.canMove).map((shape) => shape.rect)
        const page = this.pageSize()
        const snapped = snapRect({ ...group, x: group.x + dx, y: group.y + dy }, others, page, SNAP_PX / scale)
        delta = { x: snapped.rect.x - group.x, y: snapped.rect.y - group.y }
        guides = snapped.guides
      }
      this.guides.value = guides
      this.preview.value = new Map([...gesture.starts].map(([id, rect]) => [id, { ...rect, x: rect.x + delta.x, y: rect.y + delta.y }]))
      return
    }
    // resize
    const next = resizeRect(gesture.start, gesture.handle, { x: dx, y: dy }, { lockAspect: gesture.lockAspect || !!mods.shift })
    this.preview.value = new Map([[gesture.shapeId, next]])
    this.guides.value = []
  }

  pointerUp(): void {
    const gesture = this.gesture
    this.gesture = null
    const preview = this.preview.value
    this.preview.value = null
    this.guides.value = []
    if (!gesture || gesture.kind === 'text') return
    if (gesture.kind === 'move' && !gesture.moved) return
    if (!preview || this.readonly) return
    const index = this.hooks.index()
    this.cut()
    this.attempt(() => {
      for (const [id, rect] of preview) {
        const before = gesture.kind === 'move' ? gesture.starts.get(id) : gesture.start
        if (before && sameRect(before, rect)) continue
        this.hooks.backend.setRect(index, id, rect)
      }
    }, gesture.kind === 'move' ? '移动' : '缩放')
    this.refresh()
  }

  /** 放弃正在进行的手势（Esc / 失去捕获） */
  cancelGesture(): void {
    this.gesture = null
    this.preview.value = null
    this.guides.value = []
  }

  private pageSize(): { width: number; height: number } {
    return this.hooks.backend.size
  }

  /* ---------------- 文字：进入 / 光标 ---------------- */

  /** 进入文字编辑。位置缺省 = 文本末尾（双击形状、按 Enter 进入时） */
  beginText(shapeId: string, storyId: string, anchor?: number, focus?: number): void {
    if (this.readonly) return
    const end = this.hooks.backend.storyText(storyId).length
    const a = anchor ?? end
    const f = focus ?? end
    this.selected.value = [shapeId]
    this.pendingStyle = null
    this.composing = false
    this.preedit.value = null
    const line = this.hooks.backend.caret(this.hooks.index(), storyId, f)?.line ?? 0
    this.text.value = { shapeId, storyId, anchor: a, focus: f, line, preferredX: null }
    this.refreshText()
    this.hooks.focusInput?.()
  }

  endText(): void {
    if (!this.text.value) return
    this.text.value = null
    this.pendingStyle = null
    this.composing = false
    this.preedit.value = null
    this.trailing = null
    this.refreshText()
  }

  private placeCaret(storyId: string, point: Point, extend: boolean): void {
    const text = this.text.value
    if (!text || text.storyId !== storyId) return
    const found = this.hooks.backend.positionAt(this.hooks.index(), storyId, point.x, point.y)
    if (!found) return
    this.pendingStyle = null
    this.text.value = { ...text, anchor: extend ? text.anchor : found.position, focus: found.position, line: found.line, preferredX: null }
    this.refreshText()
  }

  private setCaret(position: number, line: number, extend: boolean, keepX = false): void {
    const text = this.text.value
    if (!text) return
    this.pendingStyle = null
    const caret = this.hooks.backend.caret(this.hooks.index(), text.storyId, position, line)
    this.text.value = { ...text, anchor: extend ? text.anchor : position, focus: position, line: caret?.line ?? line, preferredX: keepX ? text.preferredX : null }
    this.refreshText()
  }

  /* ---------------- 文字：键盘 ---------------- */

  /**
   * 文字编辑态的按键（来自隐藏输入框）。返回 true = 已处理（组件层 preventDefault）。
   * 打字、删除、回车、粘贴走 beforeinput，不在这里：输入法和手机键盘都不会给出可靠的 keydown。
   */
  textKeyDown(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing'> & { keyCode?: number }): boolean {
    const text = this.text.value
    if (!text || this.readonly) return false
    // 组字期间所有按键归输入法（keyCode 229 是各浏览器给输入法按键的统一标记）
    if (this.composing || event.isComposing || event.keyCode === 229) return false
    const mod = event.ctrlKey || event.metaKey
    const key = event.key
    const moves: Record<string, CaretMove> = { ArrowLeft: mod ? 'wordLeft' : 'left', ArrowRight: mod ? 'wordRight' : 'right', ArrowUp: 'up', ArrowDown: 'down', Home: mod ? 'storyStart' : 'lineStart', End: mod ? 'storyEnd' : 'lineEnd' }
    const move = moves[key]
    if (move && !event.altKey) {
      const collapsedTarget = text.anchor !== text.focus && !event.shiftKey && (key === 'ArrowLeft' || key === 'ArrowRight')
      if (collapsedTarget) {
        // 有选区时按左右键：折叠到选区的那一端，而不是再走一步
        const edge = key === 'ArrowLeft' ? Math.min(text.anchor, text.focus) : Math.max(text.anchor, text.focus)
        this.setCaret(edge, text.line, false)
        return true
      }
      const vertical = move === 'up' || move === 'down'
      const preferredX = vertical ? (text.preferredX ?? this.caret.value?.x ?? undefined) : undefined
      const next = this.hooks.backend.move(this.hooks.index(), text.storyId, text.focus, text.line, move, preferredX)
      if (vertical) this.text.value = { ...text, preferredX: preferredX ?? null }
      this.setCaret(next.position, next.line, event.shiftKey, vertical)
      return true
    }
    if (key === 'Escape') {
      this.endText()
      return true
    }
    if (mod && key.toLowerCase() === 'a') {
      const end = this.hooks.backend.storyText(text.storyId).length
      this.text.value = { ...text, anchor: 0, focus: end }
      this.refreshText()
      return true
    }
    if (mod && !event.shiftKey && !event.altKey && ['b', 'i', 'u'].includes(key.toLowerCase())) {
      const which = key.toLowerCase() === 'b' ? 'bold' : key.toLowerCase() === 'i' ? 'italic' : 'underline'
      this.toggleStyle(which)
      return true
    }
    return false
  }

  /* ---------------- 文字：输入（beforeinput / 输入法） ---------------- */

  private range(): { start: number; end: number } {
    const text = this.text.value!
    return { start: Math.min(text.anchor, text.focus), end: Math.max(text.anchor, text.focus) }
  }

  /** 把当前选区换成 `insert`（可以是空串 = 删除选区），光标落在插入内容之后 */
  private replaceRange(insert: string, from?: number, to?: number): boolean {
    const text = this.text.value
    if (!text) return false
    const { start: s, end: e } = from === undefined ? this.range() : { start: from, end: to ?? from }
    const style = this.pendingStyle ?? undefined
    const ok = this.attempt(() => {
      if (e > s) this.hooks.backend.deleteText(text.storyId, s, e)
      if (insert) this.hooks.backend.insertText(text.storyId, s, insert, style)
    }, '输入')
    if (!ok) return false
    this.pendingStyle = null
    const at = s + insert.length
    this.text.value = { ...this.text.value!, anchor: at, focus: at, preferredX: null }
    this.refresh()
    return true
  }

  /** beforeinput：返回 true = 我们接管了（组件层 preventDefault，浏览器不再往输入框里写） */
  beforeInput(event: { inputType: string; data: string | null; isComposing?: boolean; dataTransferText?: string }): boolean {
    const text = this.text.value
    if (!text || this.readonly) return false
    // 组字期间的插入由输入法管，写入发生在 compositionend
    if (this.composing || event.isComposing || event.inputType === 'insertCompositionText') return false
    // 一些浏览器在 compositionend 之后紧跟一次同内容的 insertText / insertFromComposition：吞掉，避免重复上屏
    if (this.trailing !== null) {
      const trailing = this.trailing
      this.trailing = null
      if ((event.inputType === 'insertText' || event.inputType === 'insertFromComposition') && event.data === trailing) return true
    }
    const { start, end } = this.range()
    switch (event.inputType) {
      case 'insertText':
      case 'insertReplacementText':
      case 'insertFromComposition':
        if (event.data) this.replaceRange(event.data)
        return true
      case 'insertFromPaste':
      case 'insertFromDrop': {
        const pasted = event.dataTransferText ?? event.data ?? ''
        if (pasted) this.replaceRange(pasted.replace(/\r\n?/g, '\n'))
        return true
      }
      case 'insertParagraph':
      case 'insertLineBreak': {
        if (end > start) this.replaceRange('')
        const at = this.text.value!.focus
        if (this.attempt(() => this.hooks.backend.insertBreak(text.storyId, at), '换行')) {
          this.text.value = { ...this.text.value!, anchor: at + 1, focus: at + 1, preferredX: null }
          this.refresh()
        }
        return true
      }
      case 'deleteContentBackward':
      case 'deleteContentForward':
      case 'deleteWordBackward':
      case 'deleteWordForward': {
        if (end > start) {
          this.replaceRange('')
          return true
        }
        const forward = event.inputType.endsWith('Forward')
        const word = event.inputType.includes('Word')
        const target = this.hooks.backend.move(this.hooks.index(), text.storyId, start, text.line, forward ? (word ? 'wordRight' : 'right') : word ? 'wordLeft' : 'left').position
        if (target !== start) this.replaceRange('', Math.min(start, target), Math.max(start, target))
        return true
      }
      default:
        return false
    }
  }

  compositionStart(): void {
    if (!this.text.value || this.readonly) return
    this.composing = true
    this.trailing = null
    const { start, end } = this.range()
    this.composeFrom = start
    this.composeTo = end
    this.preedit.value = ''
  }

  compositionUpdate(data: string): void {
    if (!this.composing) return
    this.preedit.value = data
  }

  /** 组字结束：把最终文字一次性写进文档（替换组字开始时的选区） */
  compositionEnd(data: string): void {
    if (!this.composing) return
    this.composing = false
    this.preedit.value = null
    this.trailing = data || null
    if (data && this.text.value) this.replaceRange(data, this.composeFrom, this.composeTo)
  }

  get isComposing(): boolean {
    return this.composing
  }

  /** 复制 / 剪切要的纯文本 */
  selectedText(): string {
    const text = this.text.value
    if (!text) return ''
    const { start, end } = this.range()
    return this.hooks.backend.storyText(text.storyId).slice(start, end)
  }

  cutSelection(): string {
    const picked = this.selectedText()
    if (picked && !this.readonly) this.replaceRange('')
    return picked
  }

  /* ---------------- 格式 ---------------- */

  /** 当前格式操作作用的文本流与范围：文字编辑态 = 选区；只选中形状 = 这些形状的全部文字 */
  private formatTargets(): Array<{ storyId: string; start: number; end: number }> {
    const text = this.text.value
    if (text) {
      const { start, end } = this.range()
      return [{ storyId: text.storyId, start, end }]
    }
    return this.selectedShapes()
      .filter((shape) => shape.storyId)
      .map((shape) => ({ storyId: shape.storyId!, start: 0, end: this.hooks.backend.storyText(shape.storyId!).length }))
  }

  format(patch: TextStylePatch): void {
    if (this.readonly) return
    const targets = this.formatTargets()
    if (!targets.length) return
    // 光标折叠时没有可改的字：记成"下一次输入的样式"
    if (this.text.value && targets[0]!.start === targets[0]!.end) {
      this.pendingStyle = { ...this.pendingStyle, ...patch }
      this.refreshText()
      return
    }
    this.cut()
    this.attempt(() => {
      for (const target of targets) if (target.end > target.start) this.hooks.backend.formatText(target.storyId, target.start, target.end, patch)
    }, '设置格式')
    this.refresh()
  }

  toggleStyle(which: 'bold' | 'italic' | 'underline'): void {
    this.format({ [which]: !this.style.value[which] })
  }

  stepFontSize(delta: number): void {
    const current = this.style.value.fontSizePt ?? 18
    this.format({ fontSizePt: Math.min(200, Math.max(6, Math.round(current + delta))) })
  }

  alignText(align: 'l' | 'ctr' | 'r' | 'just'): void {
    if (this.readonly) return
    const targets = this.formatTargets()
    if (!targets.length) return
    this.cut()
    this.attempt(() => {
      for (const target of targets) this.hooks.backend.alignText(target.storyId, target.start, Math.max(target.end, target.start), align)
    }, '设置对齐')
    this.refresh()
  }

  setFill(color: string | null): void {
    const targets = this.selectedShapes().filter((shape) => shape.kind === 'shape')
    if (!targets.length || this.readonly) return
    this.cut()
    this.attempt(() => {
      for (const shape of targets) this.hooks.backend.setFill(this.hooks.index(), shape.id, color)
    }, '设置填充')
    this.refresh()
  }

  /* ---------------- 形状：键盘（选中形状、没在编辑文字） ---------------- */

  /** 返回 true = 已处理 */
  shapeKeyDown(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
    if (this.text.value) return false
    const mod = event.ctrlKey || event.metaKey
    const key = event.key
    if (mod && key.toLowerCase() === 'a' && !this.readonly) {
      this.selectAll()
      return true
    }
    if (!this.selected.value.length) return key === 'Tab' && this.shapes.value.length > 0 ? (this.cycle(event.shiftKey), true) : false
    if (key === 'Escape') {
      this.clearSelection()
      return true
    }
    if (key === 'Tab') {
      this.cycle(event.shiftKey)
      return true
    }
    if (this.readonly) return false
    if (key === 'Delete' || key === 'Backspace') {
      this.removeSelected()
      return true
    }
    if ((key === 'Enter' || key === 'F2') && this.selected.value.length === 1) {
      const shape = this.selectedShapes()[0]
      if (shape?.storyId) {
        this.beginText(shape.id, shape.storyId)
        return true
      }
    }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    const arrow = arrows[key]
    if (arrow && !mod) {
      const step = event.shiftKey ? NUDGE_BIG : NUDGE
      this.nudge(arrow[0] * step, arrow[1] * step)
      return true
    }
    return false
  }

  nudge(dx: number, dy: number): void {
    const movable = this.selectedShapes().filter((shape) => shape.canMove)
    if (!movable.length || this.readonly) return
    this.attempt(() => {
      for (const shape of movable) this.hooks.backend.setRect(this.hooks.index(), shape.id, { ...shape.rect, x: shape.rect.x + dx, y: shape.rect.y + dy })
    }, '移动')
    this.refresh()
  }

  /* ---------------- 形状：插入 / 删除 / 层级 / 对齐 ---------------- */

  private centered(width: number, height: number): SlideRect {
    const page = this.pageSize()
    return { x: Math.round((page.width - width) / 2), y: Math.round((page.height - height) / 2), width, height }
  }

  insertTextBox(): void {
    if (this.readonly) return
    this.cut()
    let id = ''
    if (!this.attempt(() => (id = this.hooks.backend.addTextBox(this.hooks.index(), this.centered(320, 60), '')), '插入文本框')) return
    this.refresh()
    const shape = this.shapes.value.find((item) => item.id === id)
    this.selected.value = [id]
    if (shape?.storyId) this.beginText(id, shape.storyId, 0, 0)
  }

  insertShape(preset: ShapePreset): void {
    if (this.readonly) return
    this.cut()
    let id = ''
    if (!this.attempt(() => (id = this.hooks.backend.addShape(this.hooks.index(), preset, this.centered(200, 120))), '插入形状')) return
    this.refresh()
    this.select([id])
  }

  /** 插入图片：按页面 60% 以内等比缩放，居中；返回新形状 id（失败 null） */
  insertPicture(image: { bytes: Uint8Array; contentType: string; name: string; width: number; height: number }): string | null {
    if (this.readonly) return null
    const page = this.pageSize()
    const ratio = Math.min(1, (page.width * 0.6) / Math.max(1, image.width), (page.height * 0.6) / Math.max(1, image.height))
    const rect = this.centered(Math.max(16, Math.round(image.width * ratio)), Math.max(16, Math.round(image.height * ratio)))
    this.cut()
    let id = ''
    if (!this.attempt(() => (id = this.hooks.backend.addPicture(this.hooks.index(), image, rect)), '插入图片')) return null
    this.refresh()
    this.select([id])
    return id
  }

  /** 替换选中的那张图片，位置、大小、叠放层级不变 */
  replacePicture(image: { bytes: Uint8Array; contentType: string; name: string }): boolean {
    const only = this.selectedShapes()
    if (this.readonly || only.length !== 1 || only[0]!.kind !== 'picture') return false
    this.cut()
    let id = ''
    if (!this.attempt(() => (id = this.hooks.backend.replacePicture(this.hooks.index(), only[0]!.id, image)), '替换图片')) return false
    this.refresh()
    this.select([id])
    return true
  }

  removeSelected(): void {
    const targets = this.selectedShapes()
    if (!targets.length || this.readonly) return
    this.cut()
    this.attempt(() => {
      for (const shape of targets) this.hooks.backend.removeShape(this.hooks.index(), shape.id)
    }, '删除')
    this.selected.value = []
    this.endText()
    this.refresh()
  }

  zOrder(order: ZOrder): void {
    const targets = this.selectedShapes()
    if (!targets.length || this.readonly) return
    // 多选时的处理顺序：往上移先动最上面的，往下移先动最下面的，这样选中的几个之间不会互相挤
    const sorted = [...targets].sort((a, b) => (order === 'front' || order === 'forward' ? b.z - a.z : a.z - b.z))
    // "置顶"要保持选中者之间的相对顺序：从最下面的开始一个个提到顶
    const list = order === 'front' ? [...targets].sort((a, b) => a.z - b.z) : order === 'back' ? [...targets].sort((a, b) => b.z - a.z) : sorted
    this.cut()
    this.attempt(() => {
      for (const shape of list) this.hooks.backend.zOrder(this.hooks.index(), shape.id, order)
    }, '调整层级')
    this.refresh()
  }

  align(kind: AlignKind): void {
    const movable = this.selectedShapes().filter((shape) => shape.canMove)
    if (!movable.length || this.readonly) return
    const moved = alignRects(movable.map((shape) => ({ id: shape.id, rect: shape.rect })), kind, this.pageSize())
    this.commitRects(moved, '对齐')
  }

  distribute(kind: DistributeKind): void {
    const movable = this.selectedShapes().filter((shape) => shape.canMove)
    if (movable.length < 3) {
      this.say('分布至少要选中 3 个形状')
      return
    }
    if (this.readonly) return
    this.commitRects(distributeRects(movable.map((shape) => ({ id: shape.id, rect: shape.rect })), kind), '分布')
  }

  private commitRects(moved: Array<{ id: string; rect: SlideRect }>, label: string): void {
    if (!moved.length) return
    this.cut()
    this.attempt(() => {
      for (const item of moved) this.hooks.backend.setRect(this.hooks.index(), item.id, item.rect)
    }, label)
    this.refresh()
  }

  /** 演讲者备注（当前页）：失败只提示，不丢草稿（调用方保留输入框内容） */
  setNotes(text: string): boolean {
    if (this.readonly) return false
    const index = this.hooks.index()
    if (this.hooks.backend.slides()[index]?.notes === text) return true
    this.cut()
    return this.attempt(() => this.hooks.backend.setNotes(index, text), '保存备注')
  }

  /* ---------------- 页（幻灯片）操作 ---------------- */

  insertSlide(): void {
    this.slideOp('新建页', () => this.hooks.backend.insertSlide(this.hooks.index()), this.hooks.index() + 1)
  }

  duplicateSlide(): void {
    this.slideOp('复制页', () => this.hooks.backend.duplicateSlide(this.hooks.index()), this.hooks.index() + 1)
  }

  deleteSlide(): void {
    if (this.hooks.backend.slides().length <= 1) {
      this.say('至少要保留一页')
      return
    }
    this.slideOp('删除页', () => this.hooks.backend.deleteSlide(this.hooks.index()), Math.max(0, this.hooks.index() - 1))
  }

  moveSlide(delta: -1 | 1): void {
    const from = this.hooks.index()
    const to = from + delta
    if (to < 0 || to >= this.hooks.backend.slides().length) return
    this.slideOp('移动页', () => this.hooks.backend.moveSlide(from, to), to)
  }

  private slideOp(label: string, action: () => void, goto: number): void {
    if (this.readonly) return
    this.cut()
    this.clearSelection()
    if (this.attempt(action, label)) this.hooks.gotoSlide?.(goto)
    this.refresh()
  }

  /* ---------------- 撤销 / 重做 ---------------- */

  undo(): boolean {
    return this.history_('undo')
  }

  redo(): boolean {
    return this.history_('redo')
  }

  private history_(which: 'undo' | 'redo'): boolean {
    if (this.readonly) return false
    const ok = which === 'undo' ? this.hooks.backend.canUndo() : this.hooks.backend.canRedo()
    if (!ok) return false
    // 撤销之前先结束组字，免得预编辑文字悬在已经变了的文档上
    this.composing = false
    this.preedit.value = null
    let applied = false
    this.attempt(() => (applied = which === 'undo' ? this.hooks.backend.undo() : this.hooks.backend.redo()), which === 'undo' ? '撤销' : '重做')
    this.refresh()
    return applied
  }

  /* ---------------- 引擎暂不支持的能力 ---------------- */

  /** 表格 / 连接线 / 组合 / 取消组合：引擎 v0.5.1 没有这些操作，按钮置灰，点击（触屏上点灰按钮）时说明原因 */
  unsupported(name: string): void {
    this.say(`${name}暂不支持在这里编辑（引擎还没有这项能力），请在 PowerPoint 中编辑`)
  }
}

function sameRect(a: SlideRect, b: SlideRect): boolean {
  return Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3 && Math.abs(a.width - b.width) < 1e-3 && Math.abs(a.height - b.height) < 1e-3
}


/** 插入图片允许的类型与大小上限 */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif']
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024

export interface PickedImage {
  bytes: Uint8Array
  contentType: string
  name: string
  width: number
  height: number
}

/** 读用户选的图片文件：校验类型与大小，量出原始像素（用来按比例摆放）。不合格抛出可直接显示的中文错误 */
export async function readImageFile(file: File): Promise<PickedImage> {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error('只支持 PNG、JPEG、GIF 图片')
  if (file.size > IMAGE_MAX_BYTES) throw new Error(`图片太大（${(file.size / 1024 / 1024).toFixed(1)} MB），请压缩到 20 MB 以内`)
  if (file.size === 0) throw new Error('这个图片文件是空的')
  const bytes = new Uint8Array(await file.arrayBuffer())
  let width = 400
  let height = 300
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file)
      width = bitmap.width
      height = bitmap.height
      bitmap.close?.()
    } catch {
      throw new Error('这张图片打不开，可能已经损坏')
    }
  }
  return { bytes, contentType: file.type, name: file.name || 'image', width, height }
}
