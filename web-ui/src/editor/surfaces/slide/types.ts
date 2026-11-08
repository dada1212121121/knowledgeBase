/**
 * 幻灯片内容面的后端契约
 *
 * 为什么外壳只认这个形状、不直接认引擎：
 * 1. 画布 / 缩略图 / 备注 / 放映 / 缩放这套外壳对「只读渲染」和「在线编辑」是同一份，
 *    引擎（@betteroffice/pptx）只负责「某一页怎么画」，不应该渗进外壳的状态机；
 * 2. 外壳因此能用假后端做单测（不用起 WASM、不用真实 Canvas），回退到别的渲染实现时也不动外壳；
 * 3. 引擎类型只允许出现在 `engines/` 下（有契约测试守着），这里的类型是本仓自己的。
 */

/** 一页幻灯片的目录信息（不含绘制内容） */
export interface SlideSummary {
  id: string
  /** 标题：目录、大纲、缩略图的无障碍名称都用它；没有标题时是空串 */
  title: string
  /** 演讲者备注（纯文本）；没有时是空串 */
  notes: string
  /** 放映时跳过 */
  hidden: boolean
}

/** 幻灯片坐标系里的矩形（缩放 1 时的 CSS 像素） */
export interface SlideRect {
  x: number
  y: number
  width: number
  height: number
}

/** 查找命中：`slide` 0 起，`start/end` 是该文本流里的 UTF-16 偏移（仅供高亮定位） */
export interface SlideMatch {
  slide: number
  shapeId: string
  storyId: string
  start: number
  end: number
  text: string
}

/** 某一页的绘制器：宽高是缩放 1 时的 CSS 像素 */
export interface SlideFrame {
  readonly width: number
  readonly height: number
  /**
   * 画到 `ctx`。`scale` 是缩放（1 = 原始尺寸），`dpr` 是设备像素比；
   * 调用方已按 `ceil(width*scale*dpr)` 设置好画布的像素尺寸。
   */
  paint(ctx: CanvasRenderingContext2D, dpr: number, scale: number): Promise<void>
  /** 命中文字在这一页上的矩形（用来画高亮）；后端画不出几何时返回空数组 */
  textRects?(match: Pick<SlideMatch, 'storyId' | 'start' | 'end'>): SlideRect[]
}

/** 渲染后端 */
export interface SlideBackend {
  /** 一页的逻辑尺寸（所有页同尺寸） */
  readonly size: { width: number; height: number }
  /** 目录；编辑后会变，外壳在 `invalidate` 之后重新取 */
  slides(): readonly SlideSummary[]
  /** 取某页的绘制器；越界抛错 */
  frame(index: number): Promise<SlideFrame>
  /** 这一页上的全部文字（给读屏器和命中判断用，不含备注） */
  slideText(index: number): string
  /**
   * 整份演示文稿的文字查找（大小写不敏感）；后端不支持时返回空数组。
   * 引擎在 Worker 里的后端只能异步回答，所以允许返回 Promise（调用方一律 await）。
   */
  search(query: string): SlideMatch[] | Promise<SlideMatch[]>
  /** 渲染时碰到的非致命问题（缺字体、图片解不开……），外壳展示成提示条 */
  notices?(): readonly string[]
  /** 释放引擎占用的内存 */
  dispose(): void | Promise<void>
}

/** 外壳加载后端时拿到的控制柄 */
export interface SlideLoadControl {
  signal: AbortSignal
  /** 0~1；不知道总量时不要调 */
  onProgress(ratio: number): void
}

/** 外壳挂载时的后端加载函数 */
export type SlideLoader = (control: SlideLoadControl) => Promise<SlideBackend>

/* ---------------- 编辑 ---------------- */

export type EditShapeKind = 'shape' | 'picture' | 'graphicFrame' | 'group'

/** 一个顶层形状（编辑时能选中的单位）；矩形是幻灯片坐标（缩放 1 的 CSS 像素） */
export interface EditShape {
  id: string
  name: string
  kind: EditShapeKind
  rect: SlideRect
  rotation: number
  /** 第一个文本流（没有文字的形状为 null）；表格 / 图表里的单元格文字走 hit 返回的 storyId */
  storyId: string | null
  canMove: boolean
  /** 旋转 / 翻转过的形状引擎不支持拖拽缩放，只能移动 */
  canResize: boolean
  aspectLocked: boolean
  placeholder: boolean
  /** 在这一页里的叠放序号（0 = 最底层） */
  z: number
}

/** 命中测试的结果：点在文字上（可以进入文字编辑）还是只是点在形状上 */
export type EditHit = { kind: 'shape'; shapeId: string } | { kind: 'text'; shapeId: string; storyId: string; position: number }

export interface CaretInfo {
  x: number
  y: number
  height: number
  /** 光标落在第几行（上下移动光标和折行边界处用来消歧） */
  line: number
}

export type CaretMove = 'left' | 'right' | 'up' | 'down' | 'lineStart' | 'lineEnd' | 'wordLeft' | 'wordRight' | 'storyStart' | 'storyEnd'

export interface TextStyleInfo {
  bold: boolean
  italic: boolean
  underline: boolean
  fontSizePt: number | null
  color: string | null
  align: 'l' | 'ctr' | 'r' | 'just' | null
}

export interface TextStylePatch {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  fontSizePt?: number
  color?: string
}

export type ZOrder = 'front' | 'back' | 'forward' | 'backward'

/** 工具栏能插入的预设形状 */
export type ShapePreset = 'rect' | 'roundRect' | 'ellipse' | 'triangle' | 'diamond' | 'rightArrow' | 'star5'

export interface EditChange {
  /** 受影响的页（0 起）；`'all'` 表示页序 / 页数变了或来源不明 */
  slides: readonly number[] | 'all'
  /** 来自别人（协同 / AI）而不是本地操作 */
  remote: boolean
  /** 只是状态变了（比如只读标志放开），没有内容修改：不重画、不标脏，只让界面刷新按钮状态 */
  state?: boolean
}

/** 协同里的另一位参与者（光标按「哪一页 / 哪个形状」） */
export interface SlidePeer {
  id: number
  name: string
  color: string
  /** 所在页（0 起）；他的页已经被删掉时为 -1 */
  slide: number
  shapeId: string | null
}

/** 协同的在线状态：别人在哪一页 / 哪个形状，以及把自己的位置告诉别人 */
export interface SlideCollab {
  peers(): readonly SlidePeer[]
  onPeers(listener: () => void): () => void
  setCursor(slide: number | null, shapeId?: string | null): void
}

/** 带编辑能力的后端：所有坐标、尺寸都是幻灯片坐标（px），EMU 换算留在引擎层 */
export interface SlideEditBackend extends SlideBackend {
  readonly editable: true
  /** 多人协同时才有：在线的人与本地光标 */
  readonly collab?: SlideCollab
  /** 页面当前是否只读（无损检查没过 / 没有编辑权） */
  readonly readonly: boolean
  /** 切换只读（无损检查没过时先只读，用户确认「仍然编辑」后放开） */
  setReadonly(value: boolean): void
  shapes(index: number): EditShape[]
  hit(index: number, x: number, y: number, scale: number): EditHit | null
  storyText(storyId: string): string
  caret(index: number, storyId: string, position: number, line?: number): CaretInfo | null
  positionAt(index: number, storyId: string, x: number, y: number): { position: number; line: number } | null
  move(index: number, storyId: string, position: number, line: number, kind: CaretMove, preferredX?: number): { position: number; line: number }
  styleAt(storyId: string, position: number): TextStyleInfo
  /** [start, end) 这段文字在这一页上的选区高亮矩形（每行一块） */
  selectionRects(index: number, storyId: string, start: number, end: number): SlideRect[]

  insertText(storyId: string, at: number, text: string, style?: TextStylePatch): void
  deleteText(storyId: string, start: number, end: number): void
  insertBreak(storyId: string, at: number): void
  formatText(storyId: string, start: number, end: number, patch: TextStylePatch): void
  alignText(storyId: string, start: number, end: number, align: 'l' | 'ctr' | 'r' | 'just'): void

  setRect(index: number, shapeId: string, rect: SlideRect): void
  addTextBox(index: number, rect: SlideRect, text: string): string
  addShape(index: number, preset: ShapePreset, rect: SlideRect, fill?: string): string
  addPicture(index: number, image: { bytes: Uint8Array; contentType: string; name: string }, rect: SlideRect): string
  /** 同位替换：新图画在旧图的位置、同一叠放层，旧图删除；返回新图的 id */
  replacePicture(index: number, shapeId: string, image: { bytes: Uint8Array; contentType: string; name: string }): string
  removeShape(index: number, shapeId: string): void
  zOrder(index: number, shapeId: string, order: ZOrder): void
  setFill(index: number, shapeId: string, color: string | null): void
  setNotes(index: number, text: string): void
  insertSlide(afterIndex: number): void
  duplicateSlide(index: number): void
  deleteSlide(index: number): void
  moveSlide(index: number, to: number): void

  /** 在撤销栈里切一刀：前后两次操作不会被合并成一步 */
  boundary(): void
  undo(): boolean
  redo(): boolean
  canUndo(): boolean
  canRedo(): boolean
  /** 序列化成 pptx 字节（会先把还在路上的修改落稳） */
  save(): Promise<Uint8Array>
  /** 会话崩溃后抢救一份当前内容；拿不到返回 null */
  recover(): Promise<Uint8Array | null>
  /** 内容变化（本地 / 远端）通知 */
  onChange(listener: (change: EditChange) => void): () => void
  /** 会话是否已经失败（引擎崩溃 / 内存不足）；失败后所有编辑都不可用 */
  failure(): Error | null
  onFailure(listener: (error: Error) => void): () => void
}

export function isEditBackend(backend: SlideBackend | null | undefined): backend is SlideEditBackend {
  return !!backend && (backend as Partial<SlideEditBackend>).editable === true
}
