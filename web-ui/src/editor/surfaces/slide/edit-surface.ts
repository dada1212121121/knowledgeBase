/**
 * 幻灯片编辑面：在只读阅读面之上接通保存、脏标记、撤销重做
 *
 * 后端由调用方（OfficeEditor）先打开并做完无损预检再交进来——预检没过要先只读，
 * 这个决定必须在挂载编辑界面之前做出，所以后端不能由面自己去开。
 */
import type { CommandResult, EditorCommand, EditorSource, SurfaceContext } from '../../types'
import { SlideSurface } from './surface'
import type { EditChange, SlideEditBackend } from './types'

export class SlideEditSurface extends SlideSurface {
  private editCtx: SurfaceContext | null = null

  /** `collab`：修改经房间落地，没有本地保存，也不该标「未保存」 */
  constructor(
    private readonly editBackend: SlideEditBackend,
    private readonly collab = false,
  ) {
    super(() => async () => editBackend)
  }

  override async mount(el: HTMLElement, ctx: SurfaceContext): Promise<void> {
    await super.mount(el, ctx)
    this.editCtx = ctx
    const name = (ctx.document.payload as { name?: string } | null)?.name ?? 'deck.pptx'
    // 保存时才让引擎序列化（先把还在路上的修改落稳），输入路径上不付这个代价；同步快照留空，Host 不会拿旧字节去存
    // 协同时文件由服务端副本落地，本地没有保存快照，免得绕过房间用旧字节覆盖
    ctx.session.setSnapshotProvider?.(
      () => null,
      this.collab ? null : async () => ({ kind: 'bytes', name, bytes: await this.editBackend.save() }) as EditorSource,
    )
    ctx.onDirtyChange?.(false)
    // 引擎会话挂了（Worker 崩溃 / WASM 内存不足）：把原因交给宿主，由它给出恢复副本入口
    this.editBackend.onFailure((error) => ctx.onError?.(error))
  }

  override unmount(): void {
    this.editCtx = null
    super.unmount()
  }

  protected override onViewChange(change: EditChange): void {
    const ctx = this.editCtx
    if (!ctx || change.state) return
    // 别人（协同 / AI）的修改由房间落地，不算本地未保存
    if (!change.remote && !this.collab) ctx.onDirtyChange?.(true)
    ctx.onStatsChange?.()
    ctx.onContentChange?.()
  }

  override setReadonly(value: boolean): void {
    this.editBackend.setReadonly(value)
    this.viewRef.value?.refreshEditor()
  }

  override async command(command: EditorCommand): Promise<CommandResult> {
    if (command.type === 'undo' || command.type === 'redo') {
      const view = this.viewRef.value
      if (!view) return { ok: false, reason: 'surface_not_mounted' }
      const done = command.type === 'undo' ? view.undo() : view.redo()
      return done ? { ok: true } : { ok: false, reason: command.type === 'undo' ? 'nothing_to_undo' : 'nothing_to_redo' }
    }
    return super.command(command)
  }
}

/** 编辑面工厂：后端已经打开 */
export function createPptxEditSurface(backend: SlideEditBackend, collab = false): SlideEditSurface {
  return new SlideEditSurface(backend, collab)
}
