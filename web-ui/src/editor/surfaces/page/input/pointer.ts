/**
 * 页面指针交互：点击定位、双击选词、三击选段、拖拽扩选、Shift 扩选、触屏点按/长按/拖拽，
 * 以及图片的选中/拖动/缩放手柄。
 *
 * 本文件是上游 `PeerlessPagedEditor.tsx` 里 `PeerlessReady` 指针部分的移植（Apache-2.0，见 NOTICE）：
 * 把散在 React hooks/refs 里的手势状态收成一个与框架无关的控制器，Vue 视图只负责把原生指针事件喂进来、
 * 订阅预览状态去画虚线框。这样手势逻辑能用假的 binding 单测，不依赖真引擎。
 *
 * 几个要点（都是与引擎配合出来的，不要随意改）：
 * - 点击先交给「选区意图」，由引擎在 Worker 里按帧版本校验后落点；主线程不自己算光标位置；
 * - 拖拽扩选同一时刻只有一个在飞，期间的移动只保留最后一个点，等上一条回执再发（`holdPointerExtension`）；
 * - 点击瞬间用已呈现页面的命中查询画一个「临时光标」，让光标立刻跳过去，不等 Worker 往返；
 * - 触屏：500ms 长按才进入选择模式（之前的移动是滚动），移动超过 8px 取消长按。
 */
import { holdPointerExtension, type PeerlessInputAdmission } from '../../../engines/docx/vendor/inputAdmission'
import type { PeerlessCommandBinding } from '../../../engines/docx/vendor/commandBinding'
import { clientPointToPage } from '../../../engines/docx/vendor/pagePoint'
import { captureSelectionIntent } from '../../../engines/docx/vendor/selection'
import type { PeerlessPropertyIntent } from '../../../engines/docx/vendor/inputEvents'
import {
  beginPictureDrag,
  floatingPictureAt,
  inlinePictureAt,
  movePictureDrag,
  pictureAt,
  pictureDropIntent,
  pictureInSelection,
  type PictureDrag,
} from '../../../engines/docx/vendor/pictureDrag'
import {
  beginPictureResize,
  movePictureResize,
  pictureResizeIntent,
  type PictureResize,
  type PictureResizeHandle,
} from '../../../engines/docx/vendor/pictureResize'
import type { PeerlessFrameGeometry, PeerlessViewStore } from '../../../engines/docx/vendor/viewStore'

export const TOUCH_TAP_SLOP_PX = 8
export const TOUCH_LONG_PRESS_MS = 500
/** 双击/三击的最大间隔与最大位移（鼠标 5px，触屏 8px） */
const MULTI_CLICK_MS = 500
const MULTI_CLICK_SLOP_PX = 5

export type PageGeometry = PeerlessFrameGeometry['pages'][number]
type EchoRect = { x: number; y: number; width: number; height: number }

/** 控制器需要的最小事件形状（PointerEvent 与测试里的普通对象都满足） */
export interface PointerLike {
  type: string
  pointerId: number
  pointerType: string
  button: number
  buttons: number
  isPrimary?: boolean
  detail?: number
  timeStamp: number
  clientX: number
  clientY: number
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}

/** 指针所在的宿主元素（Vue 里是 data-docx-pages-host） */
export interface PointerHost {
  getBoundingClientRect(): { left: number; top: number; width: number; height: number }
  setPointerCapture(pointerId: number): void
  releasePointerCapture(pointerId: number): void
  hasPointerCapture(pointerId: number): boolean
  style: { touchAction: string }
}

export interface PictureMoves {
  canMove(): boolean
  canMoveInline(): boolean
  move(intent: PeerlessPropertyIntent): void
  resize(intent: PeerlessPropertyIntent): void
}

/** 页眉页脚/脚注等「部件」点击：返回 true 表示已处理（不再落点），返回 {bodyY} 表示改在正文边缘落点 */
export type PartPointHandler = (point: {
  page: PageGeometry
  x: number
  y: number
  clickCount: number
  intent: Extract<ReturnType<typeof captureSelectionIntent>, { kind: 'selectPoint' }>['payload']
}) => boolean | { bodyY: number }

export interface PointerUiState {
  pictureDragging: boolean
  picturePreview: EchoRect | null
  pictureDropCaret: EchoRect | null
  selectingPicture: number
  resizePreview: PictureResize | null
}

export interface PagePointerOptions {
  binding: {
    viewStore: PeerlessViewStore
    admission: PeerlessInputAdmission
    commands: Pick<PeerlessCommandBinding, 'submit'>
  }
  /** 当前页面缩放 */
  getZoom(): number
  /** 页面列的 layout 宽度（未缩放） */
  getWidth(): number
  /** 点击后把焦点交回隐藏输入框 */
  focusInput(): void
  /** 输入法正在组合：不画临时光标 */
  isCompositionActive?(): boolean
  /** 已呈现页面的命中查询：返回点中位置的光标矩形（页面坐标）；没有查询引擎时返回 null */
  provisionalTextHit?(page: PageGeometry, x: number, y: number): { caret: EchoRect | null } | null
  onPartPoint?: PartPointHandler
  pictures?: PictureMoves
  onDragSelectionChange?(active: boolean): void
  /** 预览状态变化（图片拖动/缩放的虚线框、落点光标） */
  onUiChange?(state: PointerUiState): void
}

/** 手势控制器；每个编辑会话一个，随会话销毁 */
export class PagePointerController {
  private click: { time: number; x: number; y: number; pageId: string; count: number; press: number } | null = null
  private touchPointer: { pointerId: number; x: number; y: number } | null = null
  private touchLongPress: ReturnType<typeof setTimeout> | null = null
  private touchSelection: PointerHost | null = null
  private presses = 0
  private dragPointer: number | null = null
  private picture: { pointerId: number; host: PointerHost; start: { x: number; y: number }; drag: PictureDrag } | null = null
  private resize: { pointerId: number; host: PointerHost; pageHost: PointerHost; gesture: PictureResize } | null = null
  private dragExtend: { inFlight: boolean; active: boolean; next: { event: PointerLike; host: PointerHost } | null } = {
    inFlight: false,
    active: false,
    next: null,
  }
  private ui: PointerUiState = { pictureDragging: false, picturePreview: null, pictureDropCaret: null, selectingPicture: 0, resizePreview: null }
  private disposed = false

  constructor(private readonly options: PagePointerOptions) {}

  /** 当前预览状态（Vue 用它渲染虚线框） */
  getUi(): PointerUiState {
    return this.ui
  }

  private setUi(patch: Partial<PointerUiState>): void {
    this.ui = { ...this.ui, ...patch }
    this.options.onUiChange?.(this.ui)
  }

  /** 任何一次按下（含不在页面上的）都计数：双击判定要求两次点击之间没有别的按下 */
  notePress(): void {
    this.presses += 1
    this.cancelTouchPress()
  }

  private cancelTouchPress(): void {
    this.touchPointer = null
    if (this.touchLongPress !== null) clearTimeout(this.touchLongPress)
    this.touchLongPress = null
  }

  /** 触屏拖选择时要阻止页面滚动：touchmove 监听器问这个 */
  isTouchSelecting(): boolean {
    return this.touchSelection !== null
  }

  /** 选中的图片（有句柄）：Vue 画选中框与缩放手柄 */
  selectedPicture() {
    const geometry = this.options.binding.viewStore.getSnapshot().geometry
    return geometry && this.options.pictures?.canMove() ? pictureInSelection(geometry) : null
  }

  /* ---------------- 按下 ---------------- */

  onPointerDown(event: PointerLike, host: PointerHost): void {
    if (event.button !== 0 || (event.pointerType === 'touch' && event.isPrimary === false) || this.dragPointer !== null) return
    if (this.armPicture(event, host)) {
      this.options.focusInput()
      if (this.picture) {
        host.setPointerCapture(event.pointerId)
        this.dragPointer = event.pointerId
      }
      return
    }
    if (event.pointerType === 'touch') {
      // 触屏：先当作可能是滚动，长按 500ms 才进入选择
      this.touchPointer = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
      this.touchLongPress = setTimeout(() => {
        this.cancelTouchPress()
        if (!this.onPoint(event, false, host)) return
        host.setPointerCapture(event.pointerId)
        this.dragPointer = event.pointerId
        this.touchSelection = host
        host.style.touchAction = 'none'
      }, TOUCH_LONG_PRESS_MS)
      return
    }
    if (!this.onPoint(event, false, host)) {
      this.picture = null
      return
    }
    host.setPointerCapture(event.pointerId)
    this.dragPointer = event.pointerId
  }

  /** 图片：按在图片上先落点（清掉旧选区），再让 Worker 选中该图片；可拖动的图片记下起点 */
  private armPicture(event: PointerLike, host: PointerHost): boolean {
    this.picture = null
    const { binding, pictures } = this.options
    const current = binding.viewStore.getSnapshot().geometry
    // 触屏和带修饰键的按下（Shift 是扩选）走普通选区路径
    if (!current || !pictures?.canMove() || event.pointerType === 'touch' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false
    const bounds = host.getBoundingClientRect()
    const zoom = this.options.getZoom()
    const point = clientPointToPage(event.clientX, event.clientY, bounds, zoom, current.pages)
    const hit = point && pictureAt(current, point.page.page.pageIndex, point.x, point.y)
    if (!hit || !point) return false
    if (!this.onPoint(event, false, host)) return true
    if (current.objects?.objects.find((object) => object.handle === hit.handle)?.story === 'body') {
      const selecting = binding.commands.submit({ kind: 'select', payload: { object: { handle: hit.handle, expectVersion: hit.version } } }, { source: 'selection', fence: true })
      if (selecting.status === 'submitted') {
        const settle = () => this.setUi({ selectingPicture: Math.max(0, this.ui.selectingPicture - 1) })
        this.setUi({ selectingPicture: this.ui.selectingPicture + 1 })
        void selecting.ticket.presented.then(settle, settle)
      }
    }
    const target =
      floatingPictureAt(current, point.page.page.pageIndex, point.x, point.y) ??
      (pictures.canMoveInline() ? inlinePictureAt(current, point.page.page.pageIndex, point.x, point.y) : null)
    if (target) this.picture = { pointerId: event.pointerId, host, start: { x: point.x, y: point.y }, drag: beginPictureDrag(target, event.clientX, event.clientY) }
    return true
  }

  /**
   * 落点/扩选：把一次指针位置翻译成选区意图提交。
   * 返回 false 表示这次按下无效（在页面外）；true 表示已被部件处理；否则返回提交结果。
   */
  onPoint(event: PointerLike, drag: boolean, host: PointerHost): false | true | ReturnType<PagePointerOptions['binding']['commands']['submit']> {
    const { binding } = this.options
    const currentSnapshot = binding.viewStore.getSnapshot()
    const current = currentSnapshot.geometry
    if (!current) return false
    const bounds = host.getBoundingClientRect()
    if (bounds.width === 0 || bounds.height === 0) return false
    const zoom = this.options.getZoom()
    const point = clientPointToPage(event.clientX, event.clientY, bounds, zoom, current.pages)
    if (!point) return false
    const { page, x } = point
    let { y } = point
    // 点在页面外的空白（非拖拽）不落点
    if (!drag && (x < 0 || x > page.bounds.width || y < 0 || y > page.bounds.height)) return false
    let clickCount = 1
    if (!drag) {
      const previous = this.click
      clickCount =
        previous &&
        previous.press === this.presses - 1 &&
        event.timeStamp - previous.time < MULTI_CLICK_MS &&
        previous.pageId === page.page.pageId &&
        Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < (event.pointerType === 'touch' ? TOUCH_TAP_SLOP_PX : MULTI_CLICK_SLOP_PX)
          ? (previous.count % 3) + 1
          : 1
      this.click = { time: event.timeStamp, x: event.clientX, y: event.clientY, pageId: page.page.pageId, count: clickCount, press: this.presses }
    } else this.click = null
    const capture = () =>
      captureSelectionIntent(
        {
          kind: drag ? 'drag' : 'point',
          point: {
            page: page.page,
            x,
            y,
            frameEpoch: current.frameEpoch,
            layoutRevision: current.layoutRevision,
            clickCount,
            modifiers: { shift: event.shiftKey, alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey },
          },
        },
        current,
      )
    let intent = capture()
    if (!drag && intent.kind === 'selectPoint') {
      const part = this.options.onPartPoint?.({ page, x, y, clickCount, intent: intent.payload })
      if (part === true) return true
      if (part) {
        y = part.bodyY
        intent = capture()
      }
    }
    const admission = binding.admission.getSnapshot()
    const tailSeq = admission.tail?.seq
    // 临时光标：普通单击、帧已覆盖全部输入、没有组合/只读时，用已呈现页面的命中查询让光标立刻跳过去
    const provisional =
      !drag &&
      event.type === 'pointerdown' &&
      event.pointerType !== 'touch' &&
      event.button === 0 &&
      event.isPrimary !== false &&
      (event.detail === 0 || event.detail === 1 || event.detail === undefined) &&
      clickCount === 1 &&
      intent.kind === 'selectPoint' &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !this.options.isCompositionActive?.() &&
      admission.compositionSlot === null &&
      !admission.readOnly &&
      (!admission.tail || (tailSeq !== undefined && tailSeq <= current.coversThroughSeq)) &&
      current.coversThroughSeq === currentSnapshot.throughSeq
        ? (this.options.provisionalTextHit?.(page, x, y)?.caret ?? null)
        : null
    const result = binding.commands.submit(intent, { source: 'selection', fence: true })
    if (provisional && result.status === 'submitted') {
      const caret = {
        source: 'click' as const,
        get throughSeq() {
          return result.ticket.seq
        },
        pageIndex: page.page.pageIndex,
        rect: provisional,
      }
      binding.viewStore.setProvisionalCaret(caret)
      void result.ticket.presented.then(() => {
        if (binding.viewStore.getSnapshot().provisionalCaret === caret) binding.viewStore.setProvisionalCaret(null)
      })
    }
    this.options.focusInput()
    return result
  }

  /* ---------------- 移动 ---------------- */

  onPointerMove(event: PointerLike, host: PointerHost): void {
    const resizing = this.resize
    if (resizing?.pointerId === event.pointerId) {
      if (event.buttons !== 1) return
      const gesture = this.resizePicture(resizing, event.clientX, event.clientY, event.shiftKey)
      if (!gesture) {
        this.endResize()
        return
      }
      resizing.gesture = gesture
      this.setUi({ resizePreview: gesture })
      return
    }
    const touch = this.touchPointer
    if (touch?.pointerId === event.pointerId && Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > TOUCH_TAP_SLOP_PX) this.cancelTouchPress()
    const pressed = this.picture
    if (pressed?.pointerId === event.pointerId && this.dragPointer === event.pointerId) {
      if (event.buttons !== 1) return
      const drag = this.movePicture(pressed, event.clientX, event.clientY)
      if (!drag || (drag.target.floating === false && !this.options.pictures?.canMoveInline())) {
        this.endPicture()
        return
      }
      pressed.drag = drag
      this.setUi({ pictureDragging: drag.dragging })
      if (drag.target.floating === false) {
        // 行内图片：画落点光标；浮动图片：画移动后的虚线框
        this.setUi({ pictureDropCaret: drag.dragging ? (this.inlineDropAtPoint(pressed.host, event.clientX, event.clientY)?.caret ?? null) : null })
        return
      }
      const page = drag.dragging
        ? this.options.binding.viewStore.getSnapshot().geometry?.pages.find((item) => item.page.pageIndex === drag.target.pageIndex)
        : null
      if (page) {
        this.setUi({
          picturePreview: {
            x: page.bounds.x + drag.target.rect.x + drag.dx,
            y: page.bounds.y + drag.target.rect.y + drag.dy,
            width: drag.target.rect.width,
            height: drag.target.rect.height,
          },
        })
      }
      return
    }
    if (this.dragPointer === event.pointerId && (event.buttons === 1 || this.touchSelection)) this.extendDrag(event, host)
  }

  /* ---------------- 抬起/取消 ---------------- */

  onPointerUp(event: PointerLike, host: PointerHost): void {
    const resizing = this.resize
    if (resizing?.pointerId === event.pointerId) {
      const gesture = this.resizePicture(resizing, event.clientX, event.clientY, event.shiftKey)
      const intent = gesture && pictureResizeIntent(gesture)
      this.endResize()
      if (intent && this.options.pictures?.canMove()) this.options.pictures.resize(intent)
      return
    }
    const touch = this.touchPointer
    if (touch?.pointerId === event.pointerId) {
      this.cancelTouchPress()
      // 触屏轻点（没超出位移阈值也没等到长按）：就是一次落点
      if (Math.hypot(event.clientX - touch.x, event.clientY - touch.y) <= TOUCH_TAP_SLOP_PX) this.onPoint(event, false, host)
    }
    const pressed = this.picture
    if (pressed?.pointerId === event.pointerId) {
      const drag = this.movePicture(pressed, event.clientX, event.clientY)
      const drop = drag?.dragging && drag.target.floating === false ? this.inlineDropAtPoint(pressed.host, event.clientX, event.clientY) : null
      const intent = drag && pictureDropIntent(drag, drop?.drop)
      this.endPicture()
      const pictures = this.options.pictures
      if (intent && pictures?.canMove() && (intent.kind !== 'moveEmbed' || pictures.canMoveInline())) pictures.move(intent)
    }
    this.release(event, host)
  }

  /** 取消/丢失捕获/抬起后的统一收尾 */
  release(event: Pick<PointerLike, 'pointerId'>, host: PointerHost): void {
    if (this.resize?.pointerId === event.pointerId) this.endResize()
    if (this.touchPointer?.pointerId === event.pointerId) this.cancelTouchPress()
    if (this.picture?.pointerId === event.pointerId) this.endPicture()
    if (this.dragPointer !== event.pointerId) return
    this.dragPointer = null
    this.endDrag()
    if (this.touchSelection) {
      this.touchSelection.style.touchAction = 'pan-x pan-y'
      this.touchSelection = null
    }
    if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId)
  }

  /* ---------------- 拖拽扩选：同一时刻只有一个在飞 ---------------- */

  private takeQueued() {
    const next = this.dragExtend.next
    this.dragExtend.next = null
    holdPointerExtension(this.options.binding.admission, null)
    return next
  }

  private flushQueued(): void {
    const next = this.takeQueued()
    if (next) this.onPoint(next.event, true, next.host)
  }

  private sendExtend(event: PointerLike, host: PointerHost): void {
    const state = this.dragExtend
    if (state.inFlight) {
      // 上一次扩选还没回执：只保留最新位置；输入准入也会在需要时催它先发
      state.next = { event, host }
      holdPointerExtension(this.options.binding.admission, () => this.flushQueued())
      return
    }
    const result = this.onPoint(event, true, host)
    if (typeof result !== 'object' || result.status !== 'submitted') return
    state.inFlight = true
    const settle = () => {
      state.inFlight = false
      const next = this.takeQueued()
      if (next) this.sendExtend(next.event, next.host)
    }
    void result.ticket.ack.then(settle, settle)
  }

  private extendDrag(event: PointerLike, host: PointerHost): void {
    if (!this.dragExtend.active) {
      this.dragExtend.active = true
      this.options.onDragSelectionChange?.(true)
    }
    this.sendExtend(event, host)
  }

  private endDrag(): void {
    this.flushQueued()
    if (!this.dragExtend.active) return
    this.dragExtend.active = false
    this.options.onDragSelectionChange?.(false)
  }

  /* ---------------- 图片：拖动与缩放 ---------------- */

  private picturePoint(host: PointerHost, pageIndex: number, clientX: number, clientY: number) {
    const page = this.options.binding.viewStore.getSnapshot().geometry?.pages.find((item) => item.page.pageIndex === pageIndex)
    const bounds = host.getBoundingClientRect()
    const width = this.options.getWidth()
    const scale = bounds.width / width
    if (!page || !Number.isFinite(scale) || scale <= 0) return null
    return { x: (clientX - bounds.left) / scale - page.bounds.x, y: (clientY - bounds.top) / scale - page.bounds.y, scale }
  }

  private movePicture(pressed: NonNullable<PagePointerController['picture']>, clientX: number, clientY: number): PictureDrag | null {
    const point = this.picturePoint(pressed.host, pressed.drag.target.pageIndex, clientX, clientY)
    return point ? { ...movePictureDrag(pressed.drag, clientX, clientY, point.scale), dx: point.x - pressed.start.x, dy: point.y - pressed.start.y } : null
  }

  private inlineDropAtPoint(host: PointerHost, clientX: number, clientY: number) {
    const current = this.options.binding.viewStore.getSnapshot().geometry
    if (!current) return null
    const bounds = host.getBoundingClientRect()
    const width = this.options.getWidth()
    const point = clientPointToPage(clientX, clientY, bounds, bounds.width / width, current.pages)
    if (!point) return null
    const hit = this.options.provisionalTextHit?.(point.page, point.x, point.y)
    if (!hit) return null
    const intent = captureSelectionIntent(
      {
        kind: 'point',
        point: {
          page: point.page.page,
          x: point.x,
          y: point.y,
          frameEpoch: current.frameEpoch,
          layoutRevision: current.layoutRevision,
          clickCount: 1,
          modifiers: { shift: false, alt: false, ctrl: false, meta: false },
        },
      },
      current,
    )
    return intent.kind === 'selectPoint' ? { caret: hit.caret, drop: intent.payload } : null
  }

  private resizePicture(active: NonNullable<PagePointerController['resize']>, clientX: number, clientY: number, shift: boolean): PictureResize | null {
    const point = this.picturePoint(active.pageHost, active.gesture.target.pageIndex, clientX, clientY)
    return point ? movePictureResize(active.gesture, point.x, point.y, 1, shift) : null
  }

  private endPicture(): void {
    this.picture = null
    this.setUi({ pictureDragging: false, picturePreview: null, pictureDropCaret: null })
  }

  private endResize(): void {
    const active = this.resize
    this.resize = null
    this.setUi({ resizePreview: null })
    if (active?.host.hasPointerCapture(active.pointerId)) active.host.releasePointerCapture(active.pointerId)
  }

  /** 缩放手柄按下（手柄元素自己的 pointerdown）；`handleHost` 是手柄元素，`pageHost` 是页面宿主 */
  startResize(event: PointerLike, handle: PictureResizeHandle, handleHost: PointerHost, pageHost: PointerHost): boolean {
    const selected = this.selectedPicture()
    if (event.button !== 0 || event.isPrimary === false || this.resize || this.picture || !selected || (selected.rotation ?? 0) % 360 !== 0 || !this.options.pictures?.canMove()) return false
    const point = this.picturePoint(pageHost, selected.pageIndex, event.clientX, event.clientY)
    if (!point) return false
    const gesture = beginPictureResize(selected, handle, point.x, point.y)
    this.resize = { pointerId: event.pointerId, host: handleHost, pageHost, gesture }
    this.setUi({ resizePreview: gesture })
    handleHost.setPointerCapture(event.pointerId)
    this.options.focusInput()
    return true
  }

  /** Escape：取消正在进行的图片拖动/缩放；没有手势时返回 false（调用方再决定是否把选区移出图片） */
  cancelPictureGesture(): boolean {
    if (this.resize) {
      this.endResize()
      return true
    }
    const active = this.picture
    if (!active) return false
    this.endPicture()
    this.dragPointer = null
    if (active.host.hasPointerCapture(active.pointerId)) active.host.releasePointerCapture(active.pointerId)
    return true
  }

  /** 几何变了：缩放中的图片已不是同一个目标就结束缩放 */
  reconcileGeometry(): void {
    const active = this.resize?.gesture
    if (!active) return
    const selected = this.selectedPicture()
    if (
      !selected ||
      active.target.version !== selected.version ||
      active.target.pageIndex !== selected.pageIndex ||
      active.target.rect.x !== selected.rect.x ||
      active.target.rect.y !== selected.rect.y ||
      active.target.rect.width !== selected.rect.width ||
      active.target.rect.height !== selected.rect.height
    ) {
      this.endResize()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelTouchPress()
    const state = this.dragExtend
    state.next = null
    holdPointerExtension(this.options.binding.admission, null)
    if (state.active) {
      state.active = false
      this.options.onDragSelectionChange?.(false)
    }
  }
}
