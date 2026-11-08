/**
 * 测试用的假编辑后端：纯内存，不依赖引擎。
 * 几何刻意简单可算：每个字符 10px 宽、文本框内边距 10px、每个文本流只有一行；
 * 撤销栈以 `boundary` 为界做整页状态快照，足够验证"一个用户动作 = 一个撤销步"。
 */
import { makeFakeBackend, type FakeBackendOptions } from './fakeBackend'
import { moveCaretSimple } from './fakeCaret'
import type {
  SlideCollab,
  SlidePeer,
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
} from './types'

interface FakeShape {
  id: string
  kind: EditShape['kind']
  rect: SlideRect
  rotation: number
  text: string | null
  bold: boolean
  fill: string | null
  aspectLocked: boolean
}

interface State {
  shapes: FakeShape[][]
  notes: string[]
  next: number
}

const clone = (state: State): State => JSON.parse(JSON.stringify(state))

export interface FakeEditBackend extends SlideEditBackend {
  log: { frame: number[]; paint: number[]; disposed: boolean }
  calls: string[]
  state: State
  setReadonly(value: boolean): void
  injectRemote(): void
  breakIt(error: Error): void
  /** 协同：假的在线状态；`cursors` 记录本地告诉别人的位置 */
  peerList: SlidePeer[]
  cursors: Array<[number | null, string | null | undefined]>
  emitPeers(): void
}

export function makeFakeEditBackend(options: FakeBackendOptions & { readonly?: boolean; shapes?: FakeShape[][]; collab?: boolean } = {}): FakeEditBackend {
  const base = makeFakeBackend(options)
  const count = options.count ?? 5
  const state: State = {
    shapes:
      options.shapes ??
      Array.from({ length: count }, (_, i) => [
        { id: `title${i}`, kind: 'shape', rect: { x: 100, y: 50, width: 400, height: 60 }, rotation: 0, text: `标题 ${i + 1}`, bold: false, fill: null, aspectLocked: false },
        { id: `body${i}`, kind: 'shape', rect: { x: 100, y: 200, width: 500, height: 200 }, rotation: 0, text: 'hello world', bold: false, fill: null, aspectLocked: false },
        { id: `pic${i}`, kind: 'picture', rect: { x: 700, y: 200, width: 200, height: 100 }, rotation: 0, text: null, bold: false, fill: null, aspectLocked: true },
      ]),
    notes: Array.from({ length: count }, () => ''),
    next: 1,
  }
  let history: State[] = []
  let future: State[] = []
  let groupOpen = false
  let readOnly = !!options.readonly
  let failure: Error | null = null
  const listeners = new Set<(change: EditChange) => void>()
  const failureListeners = new Set<(error: Error) => void>()
  const calls: string[] = []
  const peerListeners = new Set<() => void>()
  const peerList: SlidePeer[] = []
  const cursors: Array<[number | null, string | null | undefined]> = []
  const collab: SlideCollab | undefined = options.collab
    ? {
        peers: () => [...peerList],
        onPeers: (listener) => {
          peerListeners.add(listener)
          return () => peerListeners.delete(listener)
        },
        setCursor: (slide, shapeId) => void cursors.push([slide, shapeId]),
      }
    : undefined

  const storyOf = (id: string) => `story:${id}`
  const shapeOfStory = (storyId: string): { slide: number; shape: FakeShape } | null => {
    for (let slide = 0; slide < state.shapes.length; slide += 1) {
      const shape = state.shapes[slide]!.find((item) => storyOf(item.id) === storyId)
      if (shape) return { slide, shape }
    }
    return null
  }
  const emit = (slides: readonly number[] | 'all') => {
    for (const listener of [...listeners]) listener({ slides, remote: false })
  }
  /** 修改前：新动作组的第一次修改保存快照，之后同组的不再保存 */
  const touch = (label: string) => {
    if (readOnly) throw new Error('文档当前只读，不能修改')
    if (failure) throw failure
    calls.push(label)
    if (!groupOpen) {
      history.push(clone(state))
      future = []
      groupOpen = true
    }
  }
  const slideShapes = (index: number) => {
    const list = state.shapes[index]
    if (!list) throw new RangeError(`没有第 ${index + 1} 张`)
    return list
  }
  const asEdit = (shape: FakeShape, z: number): EditShape => ({
    id: shape.id,
    name: shape.id,
    kind: shape.kind,
    rect: { ...shape.rect },
    rotation: shape.rotation,
    storyId: shape.text === null ? null : storyOf(shape.id),
    canMove: true,
    canResize: shape.rotation === 0,
    aspectLocked: shape.aspectLocked,
    placeholder: false,
    z,
  })

  const backend: FakeEditBackend = {
    ...base,
    editable: true,
    collab,
    peerList,
    cursors,
    emitPeers() {
      for (const listener of [...peerListeners]) listener()
    },
    calls,
    state,
    get readonly() {
      return readOnly
    },
    setReadonly(value: boolean) {
      readOnly = value
    },
    slides: () =>
      state.shapes.map((list, i) => ({ id: `slide:${i}`, title: list[0]?.text ?? '', notes: state.notes[i] ?? '', hidden: false })),
    shapes: (index) => (state.shapes[index] ?? []).map(asEdit),
    hit(index, x, y, scale): EditHit | null {
      const list = state.shapes[index] ?? []
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const shape = list[i]!
        const r = shape.rect
        if (x < r.x || x > r.x + r.width || y < r.y || y > r.y + r.height) continue
        const band = 6 / scale
        const inside = x - r.x > band && r.x + r.width - x > band && y - r.y > band && r.y + r.height - y > band
        if (shape.text !== null && inside) return { kind: 'text', shapeId: shape.id, storyId: storyOf(shape.id), position: Math.max(0, Math.min(shape.text.length, Math.round((x - r.x - 10) / 10))) }
        return { kind: 'shape', shapeId: shape.id }
      }
      return null
    },
    storyText: (storyId) => shapeOfStory(storyId)?.shape.text ?? '',
    caret(_index, storyId, position): CaretInfo | null {
      const found = shapeOfStory(storyId)
      return found ? { x: found.shape.rect.x + 10 + position * 10, y: found.shape.rect.y + 5, height: 20, line: 0 } : null
    },
    positionAt(_index, storyId, x) {
      const found = shapeOfStory(storyId)
      if (!found) return null
      return { position: Math.max(0, Math.min(found.shape.text!.length, Math.round((x - found.shape.rect.x - 10) / 10))), line: 0 }
    },
    move(_index, storyId, position, line, kind: CaretMove) {
      return moveCaretSimple(backend.storyText(storyId), position, line, kind)
    },
    styleAt(storyId): TextStyleInfo {
      const found = shapeOfStory(storyId)
      return { bold: !!found?.shape.bold, italic: false, underline: false, fontSizePt: 18, color: null, align: null }
    },
    selectionRects(_index, storyId, start, end) {
      const found = shapeOfStory(storyId)
      return found ? [{ x: found.shape.rect.x + 10 + start * 10, y: found.shape.rect.y + 5, width: (end - start) * 10, height: 20 }] : []
    },
    insertText(storyId, at, text, style?: TextStylePatch) {
      touch(`insertText:${storyId}:${at}:${text}:${JSON.stringify(style ?? null)}`)
      const found = shapeOfStory(storyId)!
      found.shape.text = found.shape.text!.slice(0, at) + text + found.shape.text!.slice(at)
      emit([found.slide])
    },
    deleteText(storyId, start, end) {
      touch(`deleteText:${storyId}:${start}:${end}`)
      const found = shapeOfStory(storyId)!
      found.shape.text = found.shape.text!.slice(0, start) + found.shape.text!.slice(end)
      emit([found.slide])
    },
    insertBreak(storyId, at) {
      touch(`insertBreak:${storyId}:${at}`)
      const found = shapeOfStory(storyId)!
      found.shape.text = `${found.shape.text!.slice(0, at)}\n${found.shape.text!.slice(at)}`
      emit([found.slide])
    },
    formatText(storyId, start, end, patch) {
      touch(`formatText:${storyId}:${start}:${end}:${JSON.stringify(patch)}`)
      const found = shapeOfStory(storyId)!
      if (patch.bold !== undefined) found.shape.bold = patch.bold
      emit([found.slide])
    },
    alignText(storyId, start, end, align) {
      touch(`alignText:${storyId}:${start}:${end}:${align}`)
      emit('all')
    },
    setRect(index, shapeId, rect) {
      touch(`setRect:${shapeId}:${rect.x},${rect.y},${rect.width},${rect.height}`)
      slideShapes(index).find((item) => item.id === shapeId)!.rect = { ...rect }
      emit([index])
    },
    addTextBox(index, rect, text) {
      touch(`addTextBox:${text}`)
      const id = `new${state.next++}`
      slideShapes(index).push({ id, kind: 'shape', rect: { ...rect }, rotation: 0, text, bold: false, fill: null, aspectLocked: false })
      emit([index])
      return id
    },
    addShape(index, preset: ShapePreset, rect, fill) {
      touch(`addShape:${preset}`)
      const id = `new${state.next++}`
      slideShapes(index).push({ id, kind: 'shape', rect: { ...rect }, rotation: 0, text: null, bold: false, fill: fill ?? '#4472C4', aspectLocked: false })
      emit([index])
      return id
    },
    addPicture(index, image, rect) {
      touch(`addPicture:${image.name}`)
      const id = `new${state.next++}`
      slideShapes(index).push({ id, kind: 'picture', rect: { ...rect }, rotation: 0, text: null, bold: false, fill: null, aspectLocked: true })
      emit([index])
      return id
    },
    replacePicture(index, shapeId, image) {
      touch(`replacePicture:${shapeId}:${image.name}`)
      const list = slideShapes(index)
      const at = list.findIndex((item) => item.id === shapeId)
      const id = `new${state.next++}`
      list[at] = { ...list[at]!, id }
      emit([index])
      return id
    },
    removeShape(index, shapeId) {
      touch(`removeShape:${shapeId}`)
      const list = slideShapes(index)
      list.splice(list.findIndex((item) => item.id === shapeId), 1)
      emit([index])
    },
    zOrder(index, shapeId, order: ZOrder) {
      touch(`zOrder:${shapeId}:${order}`)
      const list = slideShapes(index)
      const at = list.findIndex((item) => item.id === shapeId)
      const [shape] = list.splice(at, 1)
      const target = order === 'front' ? list.length : order === 'back' ? 0 : order === 'forward' ? Math.min(list.length, at + 1) : Math.max(0, at - 1)
      list.splice(target, 0, shape!)
      emit([index])
    },
    setFill(index, shapeId, color) {
      touch(`setFill:${shapeId}:${color}`)
      slideShapes(index).find((item) => item.id === shapeId)!.fill = color
      emit([index])
    },
    setNotes(index, text) {
      touch(`setNotes:${index}`)
      state.notes[index] = text
      emit([index])
    },
    insertSlide(after) {
      touch(`insertSlide:${after}`)
      state.shapes.splice(after + 1, 0, [])
      state.notes.splice(after + 1, 0, '')
      emit('all')
    },
    duplicateSlide(index) {
      touch(`duplicateSlide:${index}`)
      state.shapes.splice(index + 1, 0, JSON.parse(JSON.stringify(slideShapes(index))))
      state.notes.splice(index + 1, 0, state.notes[index] ?? '')
      emit('all')
    },
    deleteSlide(index) {
      touch(`deleteSlide:${index}`)
      state.shapes.splice(index, 1)
      state.notes.splice(index, 1)
      emit('all')
    },
    moveSlide(index, to) {
      touch(`moveSlide:${index}:${to}`)
      const [list] = state.shapes.splice(index, 1)
      const [note] = state.notes.splice(index, 1)
      state.shapes.splice(to, 0, list!)
      state.notes.splice(to, 0, note ?? '')
      emit('all')
    },
    boundary() {
      calls.push('boundary')
      groupOpen = false
    },
    undo() {
      if (!history.length) return false
      future.push(clone(state))
      Object.assign(state, history.pop()!)
      groupOpen = false
      calls.push('undo')
      emit('all')
      return true
    },
    redo() {
      if (!future.length) return false
      history.push(clone(state))
      Object.assign(state, future.pop()!)
      groupOpen = false
      calls.push('redo')
      emit('all')
      return true
    },
    canUndo: () => history.length > 0 && !failure,
    canRedo: () => future.length > 0 && !failure,
    save: async () => new Uint8Array([80, 75, 3, 4]),
    recover: async () => new Uint8Array([1]),
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    failure: () => failure,
    onFailure(listener) {
      failureListeners.add(listener)
      return () => failureListeners.delete(listener)
    },
    injectRemote() {
      for (const listener of [...listeners]) listener({ slides: 'all', remote: true })
    },
    breakIt(error: Error) {
      failure = error
      for (const listener of [...failureListeners]) listener(error)
    },
  }
  history = []
  return backend
}
