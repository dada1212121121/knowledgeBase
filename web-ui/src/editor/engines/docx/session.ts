/**
 * Word 编辑会话装配：把「Worker 里的命令连接」装成主线程可用的一组对象。
 *
 * 改写自上游 `usePeerlessEditSession.ts`（Apache-2.0，署名见仓库 NOTICE）：上游是一个 React hook，
 * 这里去掉 React，改成「调用一次 → 得到 binding 与释放函数」的普通函数，行为逐条保持：
 * - 视图仓库（viewStore）、回显画笔（echoPainter）、帧呈现（presentation）、输入准入（admission）、命令绑定（commands）
 *   五个对象互相依赖，创建顺序固定，不能调换；
 * - 引擎 Worker 崩溃时按 `recovery.reopen` 换一个新的连接，已发出的命令按序号重放；
 * - 视口窗口（displayWindow）与光栅缩放（rasterScale）通过 `requestViewport` 告诉 Worker 只画哪几页。
 *
 * 为什么放在 engines/：本文件要 import `@betteroffice/docx/*`，全仓只有 engines/ 允许这样做（contract.spec.ts 守着）。
 */
import { ResidentWorkerOutOfMemoryError } from '@betteroffice/docx/yrs'
import { createDocxWorkerEditSession, discardCommandPresentation, SessionFailure } from '@betteroffice/docx/worker'
import type {
  DocxCommandConnection,
  DocxCommandFrame,
  DocxCommandPageIdentity,
  DocxCommandViewportRequest,
  DocxWorkerEditSession,
  DocxWorkerEditSessionOptions,
} from '@betteroffice/docx/worker'
import type { Document } from '@betteroffice/docx/types/document'
import { createPeerlessCommandBinding, type PeerlessCommandBinding } from './vendor/commandBinding'
import { createEchoPainter, type PeerlessEchoIntent, type PeerlessEchoPainter } from './vendor/echoPainter'
import { createFramePresentation, type PeerlessFramePresentation } from './vendor/framePresentation'
import { coalesceInputDrafts, holdInputForCoalescing } from './vendor/inputCoalescing'
import { createInputAdmission, type PeerlessInputAdmission } from './vendor/inputAdmission'
import {
  createPeerlessViewStore,
  type PeerlessFrameGeometry,
  type PeerlessProvisionalCaret,
  type PeerlessViewStore,
} from './vendor/viewStore'

/** 打开会话的输入：字节（我们总是传字节），或上游已解析好的文档对象 */
export type DocxDocumentSource = Uint8Array | Document

export interface DocxEditSessionOptions {
  source: DocxDocumentSource
  /** 取当前光栅缩放（设备像素比 × 页面缩放）；开会话与每次崩溃恢复时各读一次 */
  getRasterScale?: () => number
  /** 开一条到 Worker 的命令连接（含字体登记、版面请求）；engines/docx.ts 提供 */
  openConnection(source: DocxDocumentSource, signal: AbortSignal, getRasterScale?: () => number): Promise<DocxCommandConnection>
  /** Worker 崩溃后的恢复；协同房间里不传（房间自己能重新同步，上游同样不传） */
  recovery?: DocxWorkerEditSessionOptions<DocxDocumentSource, PeerlessEchoIntent>['recovery']
  /** 只返回已经存在的页面画布，不创建 */
  canvasForPage(page: DocxCommandPageIdentity): HTMLCanvasElement | null
  /** 从一帧里算出几何（页边界、光标矩形、选区矩形）；失败返回 undefined，帧会被拒绝并重取 */
  prepareGeometry(frame: DocxCommandFrame): PeerlessFrameGeometry | undefined
  /** 致命错误：会话已经不可用 */
  onError?(error: Error): void
  /** 可恢复的错误：例如换了缩放之后某些页暂时画不出来 */
  onRecoverableError?(error: Error): void
}

/** 一个就绪的编辑会话；Surface 层只通过它读写文档 */
export interface DocxEditSessionBinding {
  session: DocxWorkerEditSession<PeerlessEchoIntent>
  viewStore: PeerlessViewStore
  admission: PeerlessInputAdmission
  commands: PeerlessCommandBinding
  echoPainter: PeerlessEchoPainter
  presentation: PeerlessFramePresentation
  /** 告诉 Worker 当前要画第 [start, end) 页 */
  setDisplayWindow(start: number, end: number): void
  /** 缩放或换屏之后重新按新的光栅倍数出图 */
  setRasterScale(scale: number): void
}

/** 开会话的结果：binding 可能一直没有（打开失败），`dispose` 任何时候都可以调用且幂等 */
export interface DocxEditSessionHandle {
  ready: Promise<DocxEditSessionBinding>
  dispose(): void
}

/**
 * 开一个编辑会话。失败时 `ready` 拒绝，同时已经调用了 `options.onError`。
 */
export function createDocxEditSessionBinding(options: DocxEditSessionOptions): DocxEditSessionHandle {
  const controller = new AbortController()
  let binding: DocxEditSessionBinding | undefined
  let connection: DocxCommandConnection | undefined
  let unsubscribe: (() => void) | undefined
  let incarnation = 0
  let sessionCreated = false
  let respawned = false
  let recovering = false
  let crash: Error | undefined
  let receiveRequestedFrame: ((frame: DocxCommandFrame) => void) | undefined
  const cleanups: Array<() => void> = []

  /** 包一层连接：恢复期的重放命令被拒要当成失败，requestFullFrame 的回包要能交给会话监听器 */
  const connect = (resident: DocxCommandConnection, replayAppliedSeqs: readonly number[] = []): DocxCommandConnection => ({
    ...resident,
    client: {
      ...resident.client,
      get failure() {
        return resident.client.failure
      },
      call: {
        ...resident.client.call,
        async edit(command) {
          const ack = await resident.client.call.edit(command)
          const refused =
            command.replay &&
            ack.outcomes.find(
              (outcome) =>
                outcome.status === 'refused' ||
                outcome.status === 'cancelled' ||
                (replayAppliedSeqs.includes(outcome.seq) && outcome.status === 'noop'),
            )
          if (refused) {
            discardCommandPresentation(ack.frame)
            throw new SessionFailure('message', `Cannot restore DOCX command ${command.seq} (${command.kind}): ${refused.reason ?? refused.status}`)
          }
          return ack
        },
      },
      onFrame(listener) {
        receiveRequestedFrame = listener
        const stop = resident.client.onFrame?.(listener)
        return () => {
          if (receiveRequestedFrame === listener) receiveRequestedFrame = undefined
          stop?.()
        }
      },
    },
  })

  const close = () => {
    unsubscribe?.()
    unsubscribe = undefined
    for (const cleanup of cleanups.splice(0).reverse()) cleanup()
    // 会话还没建起来就中止：连接里那一帧的位图要自己关，Worker 也要放掉
    if (!sessionCreated && connection) {
      discardCommandPresentation(connection.initial.frame)
      void connection.client.dispose().catch(() => undefined)
    }
  }

  let rejectReady!: (error: Error) => void
  let resolveReady!: (value: DocxEditSessionBinding) => void
  const ready = new Promise<DocxEditSessionBinding>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  // 没人等 ready 时（还没开完就被关掉）不要变成未处理的拒绝
  ready.catch(() => undefined)

  const fail = (cause: unknown) => {
    if (controller.signal.aborted) return
    const error = cause instanceof Error ? cause : new Error(String(cause))
    controller.abort()
    close()
    rejectReady(error)
    options.onError?.(error)
  }

  void (async () => {
    try {
      const getRasterScale = () => options.getRasterScale?.() ?? 1
      connection = await options.openConnection(options.source, controller.signal, getRasterScale)
      if (controller.signal.aborted) {
        close()
        rejectReady(new Error('The worker editor session was closed'))
        return
      }
      const initial = connection.initial
      incarnation = initial.incarnation
      const viewStore = createPeerlessViewStore({
        identity: { session: initial.session, incarnation, epoch: initial.epoch },
        version: initial.version,
        throughSeq: initial.throughSeq,
        presentedThroughSeq: -1,
        workerSelection: initial.selection,
        anchors: null,
        editState: initial.editState,
        geometry: null,
      })
      cleanups.push(() => viewStore.dispose())
      const canvasForPage = (page: DocxCommandPageIdentity) => options.canvasForPage(page)
      const requestFullFrame = (settled: () => void = () => undefined) => {
        if (!connection || controller.signal.aborted) {
          settled()
          return
        }
        const resident = connection
        void resident
          .requestFullFrame()
          .then((ack) => {
            settled()
            if (!ack.frame) return
            if (!controller.signal.aborted && resident === connection && receiveRequestedFrame) receiveRequestedFrame(ack.frame)
            else discardCommandPresentation(ack.frame)
          })
          .catch((error: unknown) => {
            settled()
            if (!controller.signal.aborted && !recovering) options.onError?.(error instanceof Error ? error : new Error(String(error)))
          })
      }
      // 回显光标：本地先画了字时，光标先挪到预测位置，帧回来再对账
      let echoCaret: PeerlessProvisionalCaret | undefined
      const clearEchoCaret = () => {
        if (echoCaret && viewStore.getSnapshot().provisionalCaret === echoCaret) viewStore.setProvisionalCaret(null)
        echoCaret = undefined
      }
      const echoPainter = createEchoPainter({
        canvasForPage,
        requestFullFrame,
        onPaint: (predicted) => {
          if (!predicted) {
            clearEchoCaret()
            return
          }
          const bounds = viewStore.getSnapshot().geometry?.pages.find((item) => item.page.pageIndex === predicted.pageIndex)?.bounds
          if (!bounds) {
            clearEchoCaret()
            return
          }
          const caret: PeerlessProvisionalCaret = {
            source: 'echo',
            get throughSeq() {
              return predicted.throughSeq
            },
            pageIndex: predicted.pageIndex,
            rect: { x: predicted.rect.x + bounds.x, y: predicted.rect.y + bounds.y, width: predicted.rect.width, height: predicted.rect.height },
          }
          viewStore.setProvisionalCaret(caret)
          const shown = viewStore.getSnapshot().provisionalCaret
          echoCaret = shown === caret ? caret : shown === echoCaret ? echoCaret : undefined
        },
      })
      cleanups.push(() => echoPainter.dispose())
      const presentation = createFramePresentation({
        viewStore,
        echoPainter,
        canvasForPage,
        prepareGeometry: (frame) => options.prepareGeometry(frame),
        requestFullFrame,
        onError: (error) => {
          if (!controller.signal.aborted) options.onRecoverableError?.(error)
        },
      })
      cleanups.push(() => presentation.dispose())

      let displayWindow = { start: 0, end: 3 }
      let viewport: Omit<DocxCommandViewportRequest, 'frameEpoch'> | undefined
      let viewportPending = false
      const requestViewport = async () => {
        if (viewportPending || !connection?.requestViewport || controller.signal.aborted) return
        viewportPending = true
        try {
          while (viewport && !controller.signal.aborted) {
            const request = viewport
            viewport = undefined
            await connection.requestViewport?.({ ...request, frameEpoch: viewStore.getSnapshot().geometry?.frameEpoch ?? 0 })
          }
        } catch (error) {
          if (!controller.signal.aborted && !recovering) options.onError?.(error instanceof Error ? error : new Error(String(error)))
        } finally {
          viewportPending = false
        }
      }

      const session = createDocxWorkerEditSession<DocxDocumentSource, PeerlessEchoIntent>({
        source: options.source,
        connection: connect(connection),
        echo: presentation.hooks,
        coalesce: coalesceInputDrafts,
        holdForCoalescing: holdInputForCoalescing,
        transactionalPresentation: true,
        echoOverflow: 'decline',
        maxEchoEntries: 256,
        maxRecoveryAttempts: options.recovery ? 1 : 0,
        recovery: {
          checkpoint: options.recovery?.checkpoint
            ? (resident) => options.recovery?.checkpoint?.(resident) ?? resident.client.call.checkpoint()
            : undefined,
          onRecovery(event) {
            if (controller.signal.aborted) return
            if (event.phase !== 'diverged') recovering = event.phase === 'recovering'
            if (event.phase === 'recovering') crash = event.failure
            if (event.phase === 'recovered') {
              viewport = { ...displayWindow, ...viewport }
              void requestViewport()
            }
            if (event.phase === 'failed') fail(event.failure ?? new Error('The worker editor session failed'))
            options.recovery?.onRecovery?.(event)
          },
          async reopen(input) {
            const recovery = options.recovery
            if (!recovery) throw new Error('Worker editor recovery is unavailable')
            // 只重开一次：同一个会话反复崩溃说明文档本身有问题，继续重开只会循环
            if (respawned) throw crash ?? new Error('The worker editor session failed')
            respawned = true
            const reopened = await recovery.reopen(input).catch((error: unknown) => {
              if (error instanceof ResidentWorkerOutOfMemoryError) {
                throw new SessionFailure('out-of-memory', error.message, JSON.stringify(error.memory))
              }
              throw error
            })
            if (controller.signal.aborted) {
              discardCommandPresentation(reopened.initial.frame)
              void reopened.client.dispose().catch(() => undefined)
              throw new Error('The worker editor session was closed')
            }
            connection = reopened
            incarnation = reopened.initial.incarnation
            viewStore.acceptWorkerState(
              { session: reopened.initial.session, incarnation, epoch: reopened.initial.epoch },
              {
                epoch: reopened.initial.epoch,
                version: reopened.initial.version,
                throughSeq: reopened.initial.throughSeq,
                presentedThroughSeq: -1,
                selection: reopened.initial.selection,
                editState: reopened.initial.editState,
              },
            )
            return connect(reopened, input.replayAppliedSeqs)
          },
        },
      })
      sessionCreated = true
      cleanups.push(() => {
        void session.dispose().catch(() => undefined)
      })
      if (controller.signal.aborted) {
        close()
        rejectReady(new Error('The worker editor session was closed'))
        return
      }
      const admission = createInputAdmission({ session, viewStore, echoPainter })
      cleanups.push(() => admission.dispose())
      binding = {
        session,
        viewStore,
        admission,
        commands: createPeerlessCommandBinding(admission),
        echoPainter,
        presentation,
        setDisplayWindow(start, end) {
          displayWindow = { start, end }
          viewport = { ...viewport, ...displayWindow }
          void requestViewport()
          presentation.invalidate()
        },
        setRasterScale(scale) {
          viewport = { ...displayWindow, ...viewport, rasterScale: scale }
          void requestViewport()
          presentation.invalidate()
        },
      }
      unsubscribe = session.subscribe((state) => viewStore.acceptWorkerState({ session: initial.session, incarnation, epoch: state.epoch }, state))
      viewStore.acceptWorkerState({ session: initial.session, incarnation, epoch: session.state.epoch }, session.state)
      resolveReady(binding)
    } catch (cause) {
      fail(cause)
    }
  })()

  return {
    ready,
    dispose() {
      if (controller.signal.aborted) return
      controller.abort()
      close()
      rejectReady(new Error('The worker editor session was closed'))
    },
  }
}
