/**
 * 输入层单测的夹具。
 *
 * 不起真引擎：用一个记录命令的假 session、一个可手动安装几何的假 viewStore、一个空操作的回显画笔，
 * 再套上真实的 `createInputAdmission`（准入队列是纯逻辑，输入层的行为必须连它一起验证才有意义）。
 * 思路来自上游 `PeerlessInput.test.tsx` 的 `mount`，改成不依赖 React 与 bun:test。
 */
import { createInputAdmission, type PeerlessInputAdmission } from '../../../engines/docx/vendor/inputAdmission'
import type { PeerlessFrameGeometry, PeerlessViewSnapshot, PeerlessViewStore } from '../../../engines/docx/vendor/viewStore'
import { attachDocxInput, type DocxInputHandle, type DocxInputOptions } from './attachDocxInput'

type Session = PeerlessInputAdmission['session']
type Echo = PeerlessInputAdmission['echoPainter']

/** 一次提交给引擎的命令，测试可以读它的载荷，也可以手动让它成功 / 被拒 */
export interface SubmittedCommand {
  kind: string
  payload: Record<string, unknown>
  options: Record<string, unknown>
  settle(outcome: { status: 'applied' | 'refused' | 'cancelled'; seq?: number; committed?: boolean }): void
}

export interface InputHarness {
  textarea: HTMLTextAreaElement
  admission: PeerlessInputAdmission
  handle: DocxInputHandle
  submitted: SubmittedCommand[]
  kinds(): string[]
  snapshot: PeerlessViewSnapshot
  installGeometry(geometry: Partial<PeerlessFrameGeometry>): void
  setReadOnly(readOnly: boolean): void
  /** 等待至少 count 条命令已提交（准入队列是异步放行的） */
  waitForSubmitted(count: number): Promise<void>
  /** 给准入队列一点时间放行，再检查「没有多提交」 */
  settleTasks(): Promise<void>
  dispose(): void
}

export function mountInput(
  callbacks: Partial<Omit<DocxInputOptions, 'admission' | 'viewStore'>> & { readOnly?: boolean; host?: HTMLElement } = {},
): InputHarness {
  const submitted: SubmittedCommand[] = []
  const waiters: Array<{ count: number; resolve(): void }> = []
  const listeners = new Set<() => void>()
  const snapshot: PeerlessViewSnapshot = {
    identity: { session: 'test', incarnation: 1, epoch: 1 },
    version: 0,
    throughSeq: 0,
    presentedThroughSeq: 0,
    workerSelection: null,
    anchors: null,
    geometry: null,
    editState: {
      readOnly: callbacks.readOnly === true,
      toolbar: null,
      effectiveFormatting: null,
      storedMarks: null,
      canUndo: false,
      canRedo: false,
      hyperlink: null,
      tableContext: null,
    } as unknown as PeerlessViewSnapshot['editState'],
  }
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const viewStore = {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => snapshot,
    acceptWorkerState() {},
    installFrameGeometry(geometry: PeerlessFrameGeometry) {
      snapshot.geometry = geometry
      notify()
    },
    setProvisionalCaret() {},
    dispose() {},
  } as unknown as PeerlessViewStore

  const session = {
    backend: 'worker',
    state: { epoch: 1, version: 0, throughSeq: 0, presentedThroughSeq: 0, selection: null, editState: snapshot.editState },
    submit(kind: string, payload: Record<string, unknown>, options: Record<string, unknown> = {}) {
      let settle!: (outcome: never) => void
      const seq = submitted.length + 1
      const ack = new Promise((resolve) => {
        settle = resolve as never
      })
      submitted.push({
        kind,
        payload,
        options,
        settle: (outcome) => settle({ seq, ...outcome } as never),
      })
      for (const waiter of waiters) if (submitted.length >= waiter.count) waiter.resolve()
      return { id: seq, seq, ack, presented: new Promise(() => {}) }
    },
    subscribe: () => () => {},
    whenPresented: async () => 'presented',
    flush: async () => {},
    dispose: async () => {},
  } as unknown as Session

  const echoPainter: Echo = {
    installContext() {},
    restoreBackground: () => false,
    preview: () => undefined,
    paint() {},
    drop() {},
    reconcile() {},
    disable() {},
    dispose() {},
  }

  const admission = createInputAdmission({ session, viewStore, echoPainter })
  if (callbacks.readOnly) admission.setReadOnly(true)
  const textarea = document.createElement('textarea')
  document.body.appendChild(textarea)
  const { readOnly: _readOnly, host, ...rest } = callbacks
  void _readOnly
  const handle = attachDocxInput(textarea, { admission, viewStore, getCaretHost: host ? () => host : undefined, ...rest })
  return {
    textarea,
    admission,
    handle,
    submitted,
    kinds: () => submitted.map((entry) => entry.kind),
    snapshot,
    installGeometry(geometry) {
      viewStore.installFrameGeometry({
        identity: snapshot.identity,
        coversThroughSeq: 0,
        frameEpoch: 1,
        layoutRevision: 1,
        pages: [],
        caret: null,
        selectionRects: [],
        ...geometry,
      } as PeerlessFrameGeometry)
    },
    setReadOnly(readOnly) {
      admission.setReadOnly(readOnly)
    },
    waitForSubmitted: (count) =>
      submitted.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.push({ count, resolve })
          }),
    settleTasks: () => new Promise((resolve) => setTimeout(resolve, 20)),
    dispose() {
      handle.dispose()
      admission.dispose()
      textarea.remove()
    },
  }
}

/** 触发一次 beforeinput（jsdom 不会自己产生它） */
export function fireBeforeInput(target: HTMLTextAreaElement, inputType: string, data: string | null = null): InputEvent {
  const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data })
  target.dispatchEvent(event)
  return event
}

/** 触发 input：和真实浏览器一样，textarea 的 value 先被浏览器改掉 */
export function fireInput(target: HTMLTextAreaElement, inputType: string, data: string | null = null, isComposing = false): InputEvent {
  const event = new InputEvent('input', { bubbles: true, cancelable: false, inputType, data, isComposing })
  target.dispatchEvent(event)
  return event
}

export function fireKey(target: HTMLTextAreaElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

export function fireComposition(target: HTMLTextAreaElement, type: 'compositionstart' | 'compositionupdate' | 'compositionend', data = ''): void {
  target.dispatchEvent(new CompositionEvent(type, { bubbles: true, data }))
}
