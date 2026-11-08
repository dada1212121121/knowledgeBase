/**
 * Word 画布编辑的隐藏输入框
 *
 * 画布本身不能接收输入，所以页面里放一个看不见的 `<textarea class="paged-editor__input">` 承接键盘、输入法、剪贴板：
 * 它被定位到光标处（输入法的候选窗才会出现在光标旁边），所有输入事件翻译成引擎的命令意图（intent）交给准入队列。
 *
 * 本文件是上游 `PeerlessInput.tsx` 两个 `useLayoutEffect` 的 1:1 移植（Apache-2.0，见 NOTICE），去掉了 React：
 * - 事件监听整段原样保留：键盘（含 Tab/表格单元格导航/快捷键 B·I·U）、`beforeinput`/`input`、粘贴（先试 HTML 片段）、
 *   `composition*`（拼音组合期间不上屏，结束时一次性提交）、失焦时收尾组合、Escape→Tab 退出输入框；
 * - 定位逻辑变成 `position`，由 viewStore 订阅、滚动与缩放驱动。
 *
 * 为什么不改写：组合期的守卫、尾部组合文本去重、围栏顺序是与引擎 Worker 的命令围栏配合调出来的，
 * 输入法是整个编辑器最容易出错的部分，所以这里只做框架迁移，行为保持与上游逐行对应。
 */
import { parseClipboardHtml } from '../../../engines/docx/vendor/clipboardHtml'
import {
  beginComposition,
  endComposition,
  updateComposition,
  type PeerlessCompositionEndResult,
  type PeerlessCompositionState,
} from '../../../engines/docx/vendor/composition'
import {
  admitInputIntents,
  admitIntent,
  submitFormattingIntent,
  type PeerlessInputAdmission,
} from '../../../engines/docx/vendor/inputAdmission'
import {
  normalizeInputEvent,
  selectsAll,
  type PeerlessInputEvent,
  type PeerlessInputEventState,
} from '../../../engines/docx/vendor/inputEvents'
import type { PeerlessViewStore } from '../../../engines/docx/vendor/viewStore'
import { effectiveZoom, findVerticalScrollParentOrRoot, scrollIntoViewDelta, scrollViewport } from './viewport'

/** 剪贴板里的富文本片段：Surface 层不认识它的内部结构，原样透传给 `onPasteFragment` */
export type DocxPasteFragment = NonNullable<ReturnType<typeof parseClipboardHtml>>

export interface DocxInputOptions {
  admission: PeerlessInputAdmission
  viewStore: PeerlessViewStore
  /** 页面列（含缩放）的元素：光标矩形相对它定位；输入框用它换算到屏幕坐标 */
  getCaretHost?: () => HTMLElement | null
  /** 当前页面缩放（1 = 100%） */
  getZoom?: () => number
  /** 输入法组合状态变化（组合期间光标/选区层要隐藏） */
  onCompositionChange?(state: PeerlessCompositionState | null): void
  /** 引擎拒绝了一次上屏：把文字交还给用户，别吞掉 */
  onRecoverableText?(text: string): void
  /** 复制/剪切；同步填充 `data` 需要的内容就绪时才返回 */
  onClipboard?(cut: boolean, data?: DataTransfer | null): Promise<void>
  /** 粘贴富文本片段；返回 true 表示已经交给引擎 */
  onPasteFragment?(fragment: DocxPasteFragment, inputTime: number): boolean
  /**
   * 纯格式类快捷键（对齐、上下标、列表缩进…）：外壳认得就执行并返回 true，输入层不再处理这次按键。
   * 放在输入层调用而不是 document 级监听：组合输入期间、焦点不在输入框时都不该触发。
   */
  onShortcut?(event: KeyboardEvent): boolean
  /** 表格里按 Tab：外壳自己处理单元格导航（新增末行等）；不传则直接提交意图 */
  onNavigateCell?(direction: 'forward' | 'backward'): void
}

export interface DocxInputHandle {
  /** 按最新光标矩形重新定位输入框（缩放、窗口尺寸变化后调用） */
  position(): void
  dispose(): void
}

/** 给隐藏 textarea 挂上全部输入处理。返回的句柄必须在卸载时 `dispose`（会收尾未结束的输入法组合）。 */
export function attachDocxInput(element: HTMLTextAreaElement, options: DocxInputOptions): DocxInputHandle {
  const { admission, viewStore } = options
  let composing = false
  let revealed: string | undefined
  let revealHold: { seq?: number } | null = null

  /* ---------------- 定位：输入框跟着光标走，输入法候选窗才会出现在光标旁 ---------------- */
  const position = () => {
    const state = viewStore.getSnapshot()
    const geometry = state.geometry
    const cellFocus = !geometry?.caret && !geometry?.selectionFocus ? geometry?.selectionRects.at(-1) : undefined
    const focus = geometry?.caret ?? geometry?.selectionFocus ?? cellFocus
    // 组合期间不动位置（候选窗会跳）；几何还没覆盖到最新输入时也不动（会让光标先指向旧位置）
    if (composing || !geometry || !focus || geometry.coversThroughSeq < state.throughSeq) return
    const host = options.getCaretHost?.() ?? null
    const bounds = host?.getBoundingClientRect()
    const zoom = options.getZoom?.() ?? 1
    const scale = effectiveZoom(element)
    const top = (bounds?.top ?? 0) + focus.y * zoom
    const height = Math.max(1, focus.height * zoom)
    element.style.left = `${((bounds?.left ?? 0) + focus.x * zoom) / scale}px`
    element.style.top = `${top / scale}px`
    element.style.height = `${height / scale}px`
    const selection = state.workerSelection
    const key = selection
      ? JSON.stringify([
          selection.anchor.story,
          selection.anchor.paraId,
          selection.anchor.offset,
          selection.focus.story,
          selection.focus.paraId,
          selection.focus.offset,
          cellFocus,
        ])
      : ''
    const changed = key !== revealed
    revealed = key
    const hold = revealHold
    const held = !!hold && (hold.seq === undefined || geometry.coversThroughSeq <= hold.seq)
    if (hold?.seq !== undefined && geometry.coversThroughSeq >= hold.seq) revealHold = null
    // 选区真的变了、没有被「全选」占位挡住、焦点在输入框里：把光标滚进可视区
    if (!changed || held || !host || document.activeElement !== element) return
    const scroller = findVerticalScrollParentOrRoot(host)
    const delta = scrollIntoViewDelta(scrollViewport(scroller), top, top + height, 24)
    if (delta) scroller.scrollTop += delta
  }

  /* ---------------- 输入事件 ---------------- */
  let nextEventId = 0
  let state: PeerlessInputEventState = { composing: false, compositionId: null, lastHandledEventId: null, trailingCompositionText: null }
  let active: { id: number; phase: 'start' | 'beforeinput'; inputType: string | null; keyboard: boolean } | null = null
  let composition: PeerlessCompositionState | null = null
  let mounted = true
  let escapeArmed = false
  const clearEscape = () => {
    escapeArmed = false
  }
  const isReadOnly = () => admission.getSnapshot().readOnly

  const dispatch = (event: PeerlessInputEvent, native: Event) => {
    const normalized = normalizeInputEvent(event, state)
    state = normalized.state
    if (normalized.preventDefault) native.preventDefault()
    admitInputIntents(admission, normalized.intents, {
      inputTime: event.inputTime,
      fence: normalized.fence,
      source: event.source === 'paste' ? 'paste' : 'typing',
    })
    // 全选后引擎要先把选区算出来，这段时间里不要因为光标「变了」就滚动页面
    const ticket = selectsAll(event) ? admission.getSnapshot().tail : undefined
    const hold: { seq?: number } | null = ticket ? {} : null
    revealHold = hold
    const release = () => {
      if (revealHold === hold) revealHold = null
    }
    void ticket?.ack.then(
      (outcome) => {
        if (outcome.seq === undefined || outcome.status === 'refused' || outcome.status === 'cancelled') release()
        else hold!.seq = outcome.seq
      },
      release,
    )
  }

  const keydown = (event: KeyboardEvent) => {
    // Escape 之后的 Tab 把焦点交还给页面（键盘用户的陷阱出口）
    const exit = escapeArmed && event.key === 'Tab'
    if (event.key !== 'Shift') clearEscape()
    if (event.defaultPrevented || state.composing || event.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') {
      escapeArmed = true
      active = null
      return
    }
    if (exit || (event.key === 'Tab' && isReadOnly())) {
      active = null
      return
    }
    if (!isReadOnly() && options.onShortcut?.(event) === true) {
      event.preventDefault()
      active = null
      return
    }
    state = { ...state, trailingCompositionText: null }
    const key = event.key.toLowerCase()
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && ['b', 'i', 'u'].includes(key)) {
      event.preventDefault()
      const inputType = key === 'b' ? 'formatBold' : key === 'i' ? 'formatItalic' : 'formatUnderline'
      active = { id: ++nextEventId, phase: 'start', inputType, keyboard: true }
      state = { ...state, lastHandledEventId: active.id }
      if (event.repeat) return
      submitFormattingIntent(
        admission,
        { kind: 'toggleMark', payload: { mark: { type: key === 'b' ? 'bold' : key === 'i' ? 'italic' : 'underline' } } },
        { inputTime: event.timeStamp },
      )
      return
    }
    const tab = event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey
    const editState = viewStore.getSnapshot().editState ?? admission.session.state.editState
    const tableTab = tab && !!editState?.tableContext
    const numPr = editState?.toolbar?.paragraphProperties.numPr as { numId?: number } | null | undefined
    // 不在表格也不在列表里的 Shift+Tab：交给浏览器（切到上一个控件）
    if (tab && event.shiftKey && !tableTab && !admission.getSnapshot().tail && !(numPr?.numId && numPr.numId > 0)) {
      active = null
      return
    }
    const inputType = tab
      ? 'insertText'
      : event.key === 'Backspace'
        ? 'deleteContentBackward'
        : event.key === 'Delete'
          ? 'deleteContentForward'
          : event.key === 'Enter'
            ? 'insertParagraph'
            : null
    active = { id: ++nextEventId, phase: 'start', inputType, keyboard: true }
    let pageDistance: number | undefined
    if ((event.key === 'PageUp' || event.key === 'PageDown') && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const snapshot = viewStore.getSnapshot()
      if (snapshot.geometry?.caret || snapshot.workerSelection || admission.session.state.selection || admission.getSnapshot().pendingInputs > 0) {
        const host = options.getCaretHost?.() ?? element
        const viewport = scrollViewport(findVerticalScrollParentOrRoot(host))
        pageDistance = (viewport.height * viewport.zoom) / (effectiveZoom(host) * (options.getZoom?.() ?? 1))
      }
    }
    if (tableTab) {
      event.preventDefault()
      state = { ...state, lastHandledEventId: active.id }
      if (options.onNavigateCell) options.onNavigateCell(event.shiftKey ? 'backward' : 'forward')
      else {
        admitInputIntents(
          admission,
          [
            {
              kind: 'navigateCell',
              payload: { direction: event.shiftKey ? 'backward' : 'forward', extend: false, createLastRow: !event.shiftKey && !isReadOnly() },
            },
          ],
          { inputTime: event.timeStamp, source: 'selection', fence: true },
        )
      }
    } else if (tab) {
      event.preventDefault()
      state = { ...state, lastHandledEventId: active.id }
      admitIntent(
        admission,
        { kind: 'insertText', payload: { text: '\t' } },
        { inputTime: event.timeStamp, source: 'typing', fence: true, tabDirection: event.shiftKey ? 'backward' : 'forward' },
      )
    } else {
      dispatch(
        {
          source: 'keydown',
          eventId: active.id,
          inputTime: event.timeStamp,
          key: event.key,
          code: event.code,
          shift: event.shiftKey,
          alt: event.altKey,
          ctrl: event.ctrlKey,
          meta: event.metaKey,
          pageDistance,
        },
        event,
      )
    }
    // 只读时不让任何会改字的键落进 textarea
    if (isReadOnly() && (inputType !== null || (!(event.ctrlKey || event.metaKey || event.altKey) && event.key.length === 1))) {
      event.preventDefault()
    }
  }

  const keyup = () => {
    if (active?.keyboard) active = null
  }

  /** keydown 先确定的输入类型，与随后 beforeinput 的类型是否是同一次按键 */
  const compatible = (inputType: string) =>
    active !== null &&
    (!inputType ||
      active.inputType === null ||
      active.inputType === inputType ||
      (active.inputType === 'insertParagraph' && inputType === 'insertLineBreak') ||
      (active.inputType === 'deleteContentBackward' && inputType.endsWith('Backward')) ||
      (active.inputType === 'deleteContentForward' && inputType.endsWith('Forward')))

  const beforeinput = (event: InputEvent) => {
    clearEscape()
    const inputType = event.inputType ?? ''
    if (!active || active.phase !== 'start' || !compatible(inputType)) {
      active = { id: ++nextEventId, phase: 'start', inputType, keyboard: false }
    }
    active.phase = 'beforeinput'
    active.inputType = inputType
    const mark = inputType === 'formatBold' ? 'bold' : inputType === 'formatItalic' ? 'italic' : inputType === 'formatUnderline' ? 'underline' : null
    // 浏览器菜单里的「加粗」等：转成标记切换，不让浏览器自己改 textarea
    if (mark && !state.composing) {
      event.preventDefault()
      if (state.lastHandledEventId !== active.id) {
        submitFormattingIntent(admission, { kind: 'toggleMark', payload: { mark: { type: mark } } }, { inputTime: event.timeStamp })
        state = { ...state, lastHandledEventId: active.id }
      }
      return
    }
    dispatch(
      { source: 'beforeinput', eventId: active.id, inputTime: event.timeStamp, inputType, data: event.data, isComposing: event.isComposing },
      event,
    )
    if (isReadOnly() && !state.composing) event.preventDefault()
  }

  const input = (event: InputEvent) => {
    clearEscape()
    const inputType = event.inputType ?? ''
    const eventId = compatible(inputType) ? active!.id : ++nextEventId
    dispatch({ source: 'input', eventId, inputTime: event.timeStamp, inputType, value: element.value, isComposing: event.isComposing }, event)
    active = null
    // 非组合输入：文字已经交给引擎，清空 textarea；组合中保留，textarea 里的就是预编辑文字
    if (!state.composing) element.value = ''
    else if (composition) {
      composition = updateComposition(composition, element.value)
      options.onCompositionChange?.(composition)
    }
  }

  const paste = (event: ClipboardEvent) => {
    clearEscape()
    if (state.composing) return
    event.preventDefault()
    active = { id: ++nextEventId, phase: 'start', inputType: 'insertFromPaste', keyboard: false }
    const html = event.clipboardData?.getData('text/html') ?? ''
    if (html) {
      const fragment = parseClipboardHtml(html)
      if (fragment && options.onPasteFragment?.(fragment, event.timeStamp) === true) {
        element.value = ''
        return
      }
    }
    dispatch({ source: 'paste', eventId: active.id, inputTime: event.timeStamp, text: event.clipboardData?.getData('text/plain') ?? '' }, event)
    element.value = ''
  }

  const compositionstart = () => {
    clearEscape()
    if (composition || isReadOnly()) return
    const id = ++nextEventId
    composition = beginComposition(admission, id)
    composing = true
    state = { ...state, composing: true, compositionId: id, trailingCompositionText: null }
    active = null
    options.onCompositionChange?.(composition)
  }

  const compositionupdate = (event: CompositionEvent) => {
    if (!composition) return
    composition = updateComposition(composition, event.data ?? element.value)
    options.onCompositionChange?.(composition)
  }

  /** 结束组合：把最终文字一次性交给引擎；引擎拒绝时把文字留给用户 */
  const finishComposition = (text: string) => {
    if (!composition) return
    const current = composition
    composition = null
    composing = false
    state = { ...state, composing: false, compositionId: null, trailingCompositionText: text || null, lastHandledEventId: null }
    active = null
    const recover = (committed: PeerlessCompositionState) => {
      if (mounted) options.onCompositionChange?.({ ...committed, phase: 'refused', recoverableText: text })
      if (text) options.onRecoverableText?.(text)
    }
    let result: PeerlessCompositionEndResult
    try {
      result = endComposition(admission, current, text)
    } catch {
      element.value = ''
      recover({ ...current, text })
      return
    }
    element.value = ''
    options.onCompositionChange?.(result.state)
    if (result.status === 'committed') {
      const committed = result.state
      void result.ticket.ack.then(
        (outcome) => {
          if (outcome.status !== 'refused' && outcome.status !== 'cancelled' && outcome.committed !== false) return
          recover(committed)
        },
        () => recover(committed),
      )
    } else if (result.state.recoverableText) options.onRecoverableText?.(result.state.recoverableText)
  }

  const compositionend = (event: CompositionEvent) => finishComposition(event.data ?? composition?.text ?? element.value)
  const blur = () => {
    clearEscape()
    if (composition) finishComposition(composition.text)
    active = null
  }
  const copy = (event: ClipboardEvent) => {
    if (!options.onClipboard || state.composing) return
    event.preventDefault()
    void options.onClipboard(event.type === 'cut', event.clipboardData)
  }

  element.addEventListener('keydown', keydown)
  element.addEventListener('keyup', keyup)
  element.addEventListener('beforeinput', beforeinput as EventListener)
  element.addEventListener('input', input as EventListener)
  element.addEventListener('paste', paste)
  element.addEventListener('copy', copy)
  element.addEventListener('cut', copy)
  element.addEventListener('compositionstart', compositionstart)
  element.addEventListener('compositionupdate', compositionupdate as EventListener)
  element.addEventListener('compositionend', compositionend as EventListener)
  element.addEventListener('blur', blur)
  element.ownerDocument.addEventListener('pointerdown', clearEscape, true)

  // 定位：视图变化、滚动、窗口尺寸变化都要重算
  const offView = viewStore.subscribe(position)
  window.addEventListener('scroll', position, true)
  window.addEventListener('resize', position)
  // 只读状态同步到 textarea 的 readonly（移动端只读时不弹软键盘）
  const syncReadOnly = () => {
    element.readOnly = admission.getSnapshot().readOnly
  }
  syncReadOnly()
  const offReadOnly = admission.subscribeReadOnly(syncReadOnly)
  position()

  return {
    position,
    dispose() {
      mounted = false
      offView()
      offReadOnly()
      window.removeEventListener('scroll', position, true)
      window.removeEventListener('resize', position)
      try {
        // 卸载时还有没结束的组合：用空文字收尾（引擎里释放占位），预编辑文字交还给用户
        if (composition) {
          const current = composition
          composition = null
          try {
            endComposition(admission, current, '')
          } catch {
            // 引擎已经不在了：文字交还给用户就够了
          } finally {
            if (current.text) options.onRecoverableText?.(current.text)
          }
        }
      } finally {
        element.removeEventListener('keydown', keydown)
        element.removeEventListener('keyup', keyup)
        element.removeEventListener('beforeinput', beforeinput as EventListener)
        element.removeEventListener('input', input as EventListener)
        element.removeEventListener('paste', paste)
        element.removeEventListener('copy', copy)
        element.removeEventListener('cut', copy)
        element.removeEventListener('compositionstart', compositionstart)
        element.removeEventListener('compositionupdate', compositionupdate as EventListener)
        element.removeEventListener('compositionend', compositionend as EventListener)
        element.removeEventListener('blur', blur)
        element.ownerDocument.removeEventListener('pointerdown', clearEscape, true)
      }
    },
  }
}
