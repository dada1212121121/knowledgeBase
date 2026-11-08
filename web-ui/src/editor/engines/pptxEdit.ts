/**
 * PPTX 编辑后端：把上游 `createPptxWorkerEditorSession` 收成 `SlideEditBackend`
 *
 * 编辑通道（计划 要点）：
 * - **全部修改**经 `session.apply({ method, args })`，`method` 必须在 `PPTX_WORKER_REPLAY_METHODS` 里
 *   （`OPS_USED` 在编译期和测试里都核对一遍，新增依赖必须先补契约）。会话在主线程持有一份 peer（同步应用、立刻出结果），
 *   Worker 里的主副本异步重放并负责保存，所以键入没有往返延迟；
 * - 读（布局、快照、命中、故事文本、撤销可用性）走 `handleAsync` 拿到的 peer 访问器；
 * - 保存是 `session.saveAsync`：先把还在路上的修改落稳（fence），再由 Worker 序列化。未改动的部件原样保留。
 *
 * 坐标：对外全部是幻灯片坐标（缩放 1 的 CSS 像素），EMU 换算（914400 EMU = 96 px，即 9525 EMU/px）只在本文件里。
 * 本引擎 v0.5.1 没有 group / connector / table 的新建、表格行列增删：上层把对应按钮置灰并说明，这里也不提供。
 */
import { createPptxWorkerEditorSession, initWasm } from '@betteroffice/pptx'
import type { DeckSnapshot, PresentationHandle, ShapeSnapshot, SlideSnapshot } from '@betteroffice/pptx'
import type { PptxWorkerEditorSession } from '@betteroffice/pptx/worker'
import { NATIVE_FONT_FAMILIES, loadCjkMetrics, loadLatinMetrics } from './fonts/pptxFonts'
import { sharedGlyphFaces } from './fonts/glyphFaces'
import type {
  SlideCollab,
  CaretInfo,
  CaretMove,
  EditChange,
  EditHit,
  EditShape,
  ShapePreset,
  SlideEditBackend,
  SlideRect,
  TextStyleInfo,
  TextStylePatch,
  ZOrder,
} from '../surfaces/slide/types'
import { EMU_PER_PX, PptxBackendBase, type ReadHandle } from './pptx'
import { peekDeckText } from './pptxPeek'
import { prefetchPptxWasm, pptxWasmModule } from './pptxWasm'
import { caretFor, moveCaret, pointerTarget, positionAtPoint, selectionRects } from './pptxText'
import { PPTX_WORKER_REPLAY_METHODS } from './version'
import { yieldToMain } from '../yieldToMain'

/** 后端读文档用到的那一小块：编辑会话的 peer 和协同时直接持有的 `PresentationHandle` 都满足它 */
type Access = Pick<PresentationHandle, 'version' | 'snapshot' | 'layoutSlide' | 'readContent' | 'story' | 'canUndo' | 'canRedo' | 'mediaBytes' | 'searchText'>
type Method = (typeof PPTX_WORKER_REPLAY_METHODS)[number]
type Run = ReturnType<Access['story']>['paragraphs'][number]['runs'][number]

/** 本文件会派发的 apply 方法；`satisfies` 保证它们都在上游允许的 39 项之内 */
export const OPS_USED = [
  'insertText',
  'deleteText',
  'formatText',
  'insertParagraphBreak',
  'setParagraphAlignment',
  'insertSlide',
  'duplicateSlide',
  'deleteSlide',
  'moveSlide',
  'setSlideNotes',
  'addTextBox',
  'addShape',
  'addPicture',
  'removeShape',
  'setShapeRect',
  'setShapeFill',
  'bringShapeToFront',
  'sendShapeToBack',
  'bringShapeForward',
  'sendShapeBackward',
  'addUndoBoundary',
  'undo',
  'redo',
] as const satisfies readonly Method[]

const toEmu = (px: number) => Math.round(px * EMU_PER_PX)
const toPx = (emu: number) => emu / EMU_PER_PX

function emuRect(rect: SlideRect) {
  return { x: toEmu(rect.x), y: toEmu(rect.y), width: Math.max(1, toEmu(rect.width)), height: Math.max(1, toEmu(rect.height)) }
}

/** 形状自己的矩形；占位符没写几何时用从版式继承来的 */
export function effectiveRect(shape: ShapeSnapshot): SlideRect | null {
  const own = shape.width > 0 && shape.height > 0 ? shape : null
  const source = own ?? (shape.inherited && shape.inherited.width > 0 && shape.inherited.height > 0 ? shape.inherited : null)
  if (!source) return null
  return { x: toPx(source.x), y: toPx(source.y), width: toPx(source.width), height: toPx(source.height) }
}

function base64Of(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}

function stylePatch(patch: TextStylePatch) {
  return {
    ...(patch.bold !== undefined ? { bold: patch.bold } : {}),
    ...(patch.italic !== undefined ? { italic: patch.italic } : {}),
    // OOXML 的 u 属性：sng = 单下划线，none = 无
    ...(patch.underline !== undefined ? { underline: patch.underline ? 'sng' : 'none' } : {}),
    ...(patch.fontSizePt !== undefined ? { fontSizePt: patch.fontSizePt } : {}),
    ...(patch.color !== undefined ? { color: patch.color } : {}),
  }
}

/** 故事 id 里带着它所在的幻灯片 id（`story:slide:0:256:shape:1:0`），用来把文本修改归到页上 */
export function slideIdOfStory(storyId: string): string | null {
  const match = /^story:(slide:\d+:\d+)/.exec(storyId)
  return match ? match[1]! : null
}

interface Snapshot {
  version: string
  slides: SlideSnapshot[]
}

/**
 * 修改与保存的通道。单人编辑走 Worker 会话（所有修改经 `session.apply`，Worker 里的主副本负责保存）；
 * 多人协同走主线程直接持有的句柄（上游规定协同时不能用 Worker 编辑会话，见 PptxWorkerEditorCollaborationError），
 * 修改同步应用，由协同提供者把增量发给房间。两者对上层是同一个接口。
 */
export interface EditDriver {
  readonly access: Access
  /** 执行一个修改；`applied` = 文档真的变了 */
  apply(method: Method, args: unknown[]): { applied: boolean; result: unknown }
  /** 在撤销栈里切一刀（失败 / 不支持时静默） */
  boundary(): void
  save(): Promise<Uint8Array>
  recover(): Promise<Uint8Array | null>
  /** 会话 / 连接出了不可恢复的错误 */
  onFailure(listener: (error: Error) => void): () => void
  /** 别人（协同 / AI）的修改到达 */
  onRemote?(listener: () => void): () => void
  dispose(): Promise<void>
}

/** 单人编辑：Worker 会话 + 主线程 peer */
export function sessionDriver(session: PptxWorkerEditorSession, access: Access): EditDriver {
  return {
    access,
    apply(method, args) {
      const reply = session.apply({ method, args } as never)
      return { applied: reply.outcome.applied !== false, result: reply.outcome.result }
    },
    boundary() {
      session.apply({ method: 'addUndoBoundary', args: [] } as never)
    },
    save: () => session.saveAsync(),
    async recover() {
      try {
        return (await session.recoverySave()).bytes
      } catch {
        return null
      }
    },
    onFailure(listener) {
      return session.subscribe((state) => {
        if (state.failure) listener(state.failure)
      })
    },
    async dispose() {
      try {
        await session.dispose()
      } catch {
        // 会话已经失败 / 销毁时释放会报错，忽略
      }
    },
  }
}

/** 协同：直接持有句柄；修改同步应用，是否生效看版本号有没有变 */
export function handleDriver(handle: PresentationHandle, hooks: { fail?: (listener: (error: Error) => void) => () => void; dispose?: () => void } = {}): EditDriver {
  const remoteListeners = new Set<() => void>()
  const off = handle.onUpdate((_update, origin) => {
    if (origin === 'remote') for (const listener of [...remoteListeners]) listener()
  })
  return {
    access: handle,
    apply(method, args) {
      const before = handle.version()
      const result = (handle as unknown as Record<string, (...rest: unknown[]) => unknown>)[method]!(...args)
      return { applied: handle.version() !== before, result }
    },
    boundary() {
      handle.addUndoBoundary()
    },
    async save() {
      return handle.save()
    },
    async recover() {
      try {
        return handle.save()
      } catch {
        return null
      }
    },
    onFailure: (listener) => hooks.fail?.(listener) ?? (() => undefined),
    onRemote(listener) {
      remoteListeners.add(listener)
      return () => remoteListeners.delete(listener)
    },
    async dispose() {
      off()
      remoteListeners.clear()
      hooks.dispose?.()
      try {
        handle.dispose()
      } catch {
        // 句柄已经失效时释放会报错，忽略
      }
    },
  }
}

export class PptxEditBackend extends PptxBackendBase implements SlideEditBackend {
  readonly editable = true as const
  private readOnly: boolean
  private listeners = new Set<(change: EditChange) => void>()
  private failureListeners = new Set<(error: Error) => void>()
  private cached: Snapshot | null = null
  private summariesVersion = ''
  private failed: Error | null = null

  /** 协同时由 openPptxCollab 挂上：在线的人与本地光标 */
  collab?: SlideCollab
  private readonly access: Access
  private offFailure: (() => void) | null = null
  private offRemote: (() => void) | null = null

  constructor(
    private readonly driver: EditDriver,
    readonly: boolean,
  ) {
    super()
    this.access = driver.access
    this.readOnly = readonly
    this.cjk = Promise.resolve()
    // 会话失败（Worker 崩溃 / WASM 内存不足 / 连接协议错误）：记下来并通知上层，之后所有编辑都不可用
    this.offFailure = driver.onFailure((error) => {
      if (this.failed) return
      this.failed = error
      for (const listener of [...this.failureListeners]) listener(error)
    })
    // 别人的修改：不知道具体哪几页，整体刷新
    this.offRemote =
      driver.onRemote?.(() => {
        this.cached = null
        for (const listener of [...this.listeners]) listener({ slides: 'all', remote: true })
      }) ?? null
  }

  protected get h(): ReadHandle {
    return this.access
  }

  get readonly(): boolean {
    return this.readOnly
  }

  setReadonly(value: boolean): void {
    if (this.readOnly === value) return
    this.readOnly = value
    // 通知界面刷新按钮 / 编辑层（没有内容修改，不重画、不标脏）
    this.emit({ slides: [], remote: false, state: true })
  }

  /** 取一次整份快照并读出目录（快照是一次 WASM 调用 + JSON 解析，只取一次：目录、页面尺寸、选形状、字形预取都复用） */
  private readDeck(notices: readonly string[]): DeckSnapshot {
    this.noticeList.push(...notices)
    const snapshot = this.access.snapshot()
    this.cached = { version: this.access.version(), slides: snapshot.slides }
    this.readSummaries(snapshot)
    this.summariesVersion = this.cached.version
    return snapshot
  }

  /** 打开后的准备：目录、尺寸、字体提示 */
  prepare(notices: readonly string[]): DeckSnapshot {
    const snapshot = this.readDeck(notices)
    this.measureSize(snapshot)
    return snapshot
  }

  /**
   * 同 `prepare`，但读目录与第一次排版之间让出一次主线程：取快照（约 20 ms）与第一次排版
   * （WASM 函数还在懒编译，约 80 ms）合在一个任务里，4× 降速下是 100 ms 以上的长任务，拆开后每段各自在预算内。
   */
  async prepareInSlices(notices: readonly string[]): Promise<DeckSnapshot> {
    const snapshot = this.readDeck(notices)
    await yieldToMain()
    this.measureSize(snapshot)
    return snapshot
  }

  /* ---------------- 读 ---------------- */

  private snap(): Snapshot {
    const version = this.access.version()
    if (!this.cached || this.cached.version !== version) this.cached = { version, slides: this.access.snapshot().slides }
    return this.cached
  }

  override slides() {
    const version = this.access.version()
    if (version !== this.summariesVersion) {
      this.summariesVersion = version
      this.readSummaries()
    }
    return this.summaries
  }

  private slideId(index: number): string {
    const id = this.snap().slides[index]?.id
    if (!id) throw new RangeError(`没有第 ${index + 1} 张幻灯片`)
    return id
  }

  private indexOfSlide(slideId: string | null): number {
    return slideId ? this.snap().slides.findIndex((slide) => slide.id === slideId) : -1
  }

  shapes(index: number): EditShape[] {
    const slide = this.snap().slides[index]
    if (!slide) return []
    const out: EditShape[] = []
    slide.shapes.forEach((shape, z) => {
      if (shape.hidden) return
      const rect = effectiveRect(shape)
      const rotation = shape.inherited && !(shape.width > 0 && shape.height > 0) ? shape.inherited.rotationDeg : shape.rotationDeg
      const flipped = shape.inherited && !(shape.width > 0 && shape.height > 0) ? shape.inherited.flipH || shape.inherited.flipV : shape.flipH || shape.flipV
      out.push({
        id: shape.id,
        name: shape.name,
        kind: shape.kind,
        rect: rect ?? { x: 0, y: 0, width: 0, height: 0 },
        rotation,
        storyId: shape.kind === 'graphicFrame' || shape.kind === 'group' ? null : (shape.textStories[0]?.id ?? null),
        canMove: !!rect,
        canResize: !!rect && ((rotation % 360) + 360) % 360 === 0 && !flipped,
        aspectLocked: !!shape.aspectRatioLocked || shape.kind === 'picture',
        placeholder: !!shape.placeholder,
        z,
      })
    })
    return out
  }

  /** 子形状 id → 它所在的顶层形状 id（图元的 shapeId 可能是组合里的子形状） */
  private topLevelId(index: number, shapeId: string): string {
    const slide = this.snap().slides[index]
    if (!slide) return shapeId
    const contains = (shape: ShapeSnapshot): boolean => shape.id === shapeId || (shape.children ?? []).some(contains)
    return slide.shapes.find(contains)?.id ?? shapeId
  }

  hit(index: number, x: number, y: number, scale: number): EditHit | null {
    const target = pointerTarget(this.access.layoutSlide(index), { x, y }, scale)
    if (!target) return null
    const shapeId = this.topLevelId(index, target.shapeId)
    return target.kind === 'text' ? { kind: 'text', shapeId, storyId: target.storyId, position: target.position } : { kind: 'shape', shapeId }
  }

  storyText(storyId: string): string {
    const slideId = slideIdOfStory(storyId)
    const result = this.access.readContent(slideId ? { slideIds: [slideId] } : undefined)
    return result.ok ? (result.stories.find((story) => story.storyId === storyId)?.text ?? '') : ''
  }

  caret(index: number, storyId: string, position: number, line?: number): CaretInfo | null {
    return caretFor(this.access.layoutSlide(index), storyId, position, line)
  }

  positionAt(index: number, storyId: string, x: number, y: number) {
    return positionAtPoint(this.access.layoutSlide(index), storyId, { x, y })
  }

  move(index: number, storyId: string, position: number, line: number, kind: CaretMove, preferredX?: number) {
    return moveCaret(this.access.layoutSlide(index), storyId, this.storyText(storyId), position, line, kind, preferredX)
  }

  selectionRects(index: number, storyId: string, start: number, end: number): SlideRect[] {
    return selectionRects(this.access.layoutSlide(index), storyId, start, end, this.storyText(storyId))
  }

  /**
   * 光标处的文字属性：光标左边那个字符所在的 run 决定样式；在段首则看右边（和主流编辑器一致）。
   * 文本流里段与段之间隔着 1 个分隔符，所以每段的起点是「上一段长度 + 1」。
   */
  private runAt(storyId: string, position: number): { run: Run | null; align: string | null } {
    let story
    try {
      story = this.access.story(storyId)
    } catch {
      return { run: null, align: null }
    }
    let offset = 0
    for (const paragraph of story.paragraphs) {
      const length = paragraph.runs.reduce((sum, run) => sum + run.text.length, 0)
      const end = offset + length
      if (position >= offset && position <= end) {
        let at = offset
        let found: Run | null = null
        for (const run of paragraph.runs) {
          const runEnd = at + run.text.length
          if ((position > at && position <= runEnd) || (position === offset && position === at && run.text.length)) {
            found = run
            break
          }
          at = runEnd
        }
        return { run: found ?? paragraph.runs.at(-1) ?? null, align: paragraph.alignment }
      }
      offset = end + 1
    }
    return { run: null, align: null }
  }

  styleAt(storyId: string, position: number): TextStyleInfo {
    const { run, align } = this.runAt(storyId, position)
    const style = run?.style
    return {
      bold: style?.bold === true,
      italic: style?.italic === true,
      underline: !!style?.underline && style.underline !== 'none',
      fontSizePt: style?.fontSizePt ?? null,
      color: style?.color ?? null,
      align: (align as TextStyleInfo['align']) ?? null,
    }
  }

  /**
   * 新输入的文字沿用光标处的格式（颜色、字号、字体、粗斜体、下划线）。
   * 不显式带上的话引擎插进去的是一个没有格式的 run，退回主题默认色——深色背景的页上敲出黑字，看起来像字没了。
   */
  private inheritedStyle(storyId: string, at: number): Record<string, unknown> {
    const style = this.runAt(storyId, at).run?.style
    const out: Record<string, unknown> = {}
    if (!style) return out
    if (style.bold != null) out.bold = style.bold
    if (style.italic != null) out.italic = style.italic
    if (style.underline != null) out.underline = style.underline
    if (style.fontSizePt != null) out.fontSizePt = style.fontSizePt
    if (style.color != null) out.color = style.color
    if (style.fontFamily != null) out.fontFamily = style.fontFamily
    return out
  }

  /* ---------------- 写 ---------------- */

  /** 唯一的修改入口：核对只读、派发给会话、通知上层哪些页变了 */
  private apply(method: Method, args: unknown[], slides: readonly number[] | 'all'): unknown {
    if (this.readOnly) throw new Error('文档当前只读，不能修改')
    if (this.failed) throw this.failed
    const outcome = this.driver.apply(method, args)
    this.cached = null
    if (outcome.applied) this.emit({ slides, remote: false })
    return outcome.result
  }

  private emit(change: EditChange): void {
    for (const listener of [...this.listeners]) listener(change)
  }

  private storySlides(storyId: string): readonly number[] | 'all' {
    const at = this.indexOfSlide(slideIdOfStory(storyId))
    return at >= 0 ? [at] : 'all'
  }

  insertText(storyId: string, at: number, text: string, style?: TextStylePatch): void {
    const merged = { ...this.inheritedStyle(storyId, at), ...(style ? stylePatch(style) : {}) }
    this.apply('insertText', Object.keys(merged).length ? [storyId, at, text, merged] : [storyId, at, text], this.storySlides(storyId))
  }

  deleteText(storyId: string, start: number, end: number): void {
    this.apply('deleteText', [storyId, start, end], this.storySlides(storyId))
  }

  insertBreak(storyId: string, at: number): void {
    this.apply('insertParagraphBreak', [storyId, at], this.storySlides(storyId))
  }

  formatText(storyId: string, start: number, end: number, patch: TextStylePatch): void {
    this.apply('formatText', [storyId, start, end, stylePatch(patch)], this.storySlides(storyId))
  }

  alignText(storyId: string, start: number, end: number, align: 'l' | 'ctr' | 'r' | 'just'): void {
    this.apply('setParagraphAlignment', [storyId, start, end, align], this.storySlides(storyId))
  }

  setRect(index: number, shapeId: string, rect: SlideRect): void {
    this.apply('setShapeRect', [this.slideId(index), shapeId, emuRect(rect)], [index])
  }

  addTextBox(index: number, rect: SlideRect, text: string): string {
    const receipt = this.apply('addTextBox', [this.slideId(index), { name: '文本框', rect: emuRect(rect), text, style: { fontSizePt: 18 } }], [index]) as { shapeId: string }
    return receipt.shapeId
  }

  addShape(index: number, preset: ShapePreset, rect: SlideRect, fill = '#4472C4'): string {
    const receipt = this.apply('addShape', [this.slideId(index), { name: PRESET_NAMES[preset], geometry: preset, rect: emuRect(rect), fill }], [index]) as { shapeId: string }
    return receipt.shapeId
  }

  addPicture(index: number, image: { bytes: Uint8Array; contentType: string; name: string }, rect: SlideRect): string {
    const receipt = this.apply('addPicture', [this.slideId(index), { name: image.name, rect: emuRect(rect), contentType: image.contentType, mediaBase64: base64Of(image.bytes) }], [index]) as { shapeId: string }
    return receipt.shapeId
  }

  replacePicture(index: number, shapeId: string, image: { bytes: Uint8Array; contentType: string; name: string }): string {
    const shapes = this.shapes(index)
    const old = shapes.find((shape) => shape.id === shapeId)
    if (!old) throw new Error('要替换的图片已经不存在')
    const id = this.addPicture(index, image, old.rect)
    // 新图在最上层；退回到旧图正上方的位置，再删旧图，叠放层级就和原来一样
    for (let i = 0; i < shapes.length - (old.z + 1); i += 1) this.apply('sendShapeBackward', [this.slideId(index), id], [index])
    this.removeShape(index, shapeId)
    return id
  }

  removeShape(index: number, shapeId: string): void {
    this.apply('removeShape', [this.slideId(index), shapeId], [index])
  }

  zOrder(index: number, shapeId: string, order: ZOrder): void {
    const method = { front: 'bringShapeToFront', back: 'sendShapeToBack', forward: 'bringShapeForward', backward: 'sendShapeBackward' }[order] as Method
    this.apply(method, [this.slideId(index), shapeId], [index])
  }

  setFill(index: number, shapeId: string, color: string | null): void {
    this.apply('setShapeFill', [this.slideId(index), shapeId, color], [index])
  }

  setNotes(index: number, text: string): void {
    this.apply('setSlideNotes', [this.slideId(index), text], [index])
  }

  insertSlide(afterIndex: number): void {
    this.apply('insertSlide', [afterIndex + 1], 'all')
  }

  duplicateSlide(index: number): void {
    this.apply('duplicateSlide', [this.slideId(index), index + 1], 'all')
  }

  deleteSlide(index: number): void {
    this.apply('deleteSlide', [this.slideId(index)], 'all')
  }

  moveSlide(index: number, to: number): void {
    this.apply('moveSlide', [this.slideId(index), to], 'all')
  }

  boundary(): void {
    if (this.readOnly || this.failed) return
    this.driver.boundary()
  }

  undo(): boolean {
    const result = this.apply('undo', [], 'all') as { applied?: boolean } | undefined
    return result?.applied !== false
  }

  redo(): boolean {
    const result = this.apply('redo', [], 'all') as { applied?: boolean } | undefined
    return result?.applied !== false
  }

  canUndo(): boolean {
    return !this.failed && this.access.canUndo()
  }

  canRedo(): boolean {
    return !this.failed && this.access.canRedo()
  }

  async save(): Promise<Uint8Array> {
    if (this.failed) throw this.failed
    return this.driver.save()
  }

  recover(): Promise<Uint8Array | null> {
    return this.driver.recover()
  }

  onChange(listener: (change: EditChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  failure(): Error | null {
    return this.failed
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener)
    return () => this.failureListeners.delete(listener)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.offFailure?.()
    this.offRemote?.()
    this.listeners.clear()
    this.failureListeners.clear()
    this.images.clear()
    await this.driver.dispose()
  }
}

const PRESET_NAMES: Record<ShapePreset, string> = {
  rect: '矩形',
  roundRect: '圆角矩形',
  ellipse: '椭圆',
  triangle: '三角形',
  diamond: '菱形',
  rightArrow: '右箭头',
  star5: '五角星',
}

/**
 * 提前预热：开始下载字体。OfficeEditor 在去问服务端（文件信息 / 编辑权 / 原件字节，要好几个往返）的同时调用它，
 * 这几段网络时间和字体下载重叠，不用等拿到字节才开始。失败吞掉——真正打开时会重新触发并报错。
 */
export function warmPptxEdit(): void {
  prefetchPptxWasm()
  void loadLatinMetrics().catch(() => undefined)
  void loadCjkMetrics().catch(() => undefined)
  void sharedGlyphFaces().ensureCore()
}

export interface OpenEditOptions {
  /** 打开后就只读（无损检查没过 / 没有编辑权） */
  readonly?: boolean
}

/**
 * 打开一份 pptx 做在线编辑。引擎的字体表只能在打开时给、事后补不进去，而编辑时随时可能敲进中文，
 * 所以始终带上中文度量（只有几十 KB，不是原来的整套 1.2 MB 字形）；浏览器要画的字形按文字分片、用到才取。
 * WASM 由会话自己的 Worker 使用，但模块在主线程编译一次后直接交给它，主线程的 peer 也用同一个。
 */
export async function openPptxEdit(bytes: Uint8Array, options: OpenEditOptions = {}): Promise<PptxEditBackend> {
  // 性能标记（浏览器 Performance 面板和 e2e 脚本里能看到各阶段耗时）
  const mark = (name: string) => performance.mark(`kb:pptx-edit:${name}`)
  mark('start')
  // 与 WASM 并行：常用拉丁字形，以及前几页文字里出现的字所在的字形片（预测不全不要紧，取帧时会补取）
  const glyphs = sharedGlyphFaces()
  void glyphs.ensureCore()
  void peekDeckText(bytes).then((text) => glyphs.ensureText(text))
  // 度量字体与 WASM 模块并行：模块由主线程编译一次（预热时通常已经在下载 / 已就绪），Worker 直接拿来用，不再自己取一遍
  const [latin, cjk, wasm] = await Promise.all([loadLatinMetrics(), loadCjkMetrics(), pptxWasmModule()])
  mark('fonts')
  const fonts = NATIVE_FONT_FAMILIES.flatMap((family) => [
    { family, bytes: latin.regular },
    { family, bold: true, bytes: latin.bold },
    { family, bytes: cjk },
  ])
  const session = createPptxWorkerEditorSession(bytes, { fonts, wasm })
  try {
    await session.whenHydrated()
    mark('hydrated')
    const access = await session.handleAsync()
    const backend = new PptxEditBackend(sessionDriver(session, access), !!options.readonly)
    const snapshot = await backend.prepareInSlices([])
    mark('prepared')
    await backend.loadGlyphs(snapshot)
    mark('faces')
    return backend
  } catch (error) {
    void session.dispose().catch(() => undefined)
    throw error
  }
}
