/**
 * 显示列表上的文字几何：光标位置、点选定位、光标移动、命中分类
 *
 * 上游没有 `getCaretPositionRect` 之类的接口（计划已注明），光标和选区都由 `layoutSlide` 给出的文本行几何推导：
 * 每个 textBox 图元带若干行，每行有 `[start, end)` 的文字区间和 `caretStops`（每个可停靠位置的 x）。
 * 命中分类（点在文字里还是点在形状边框上）的思路参考上游 pptx-react 的 interactions.ts（Apache-2.0）：
 * 文本框边缘一圈算"形状"（抓住框拖动），中间算"文字"（放光标），和 PowerPoint 的手感一致。
 *
 * 本文件只做纯计算，不碰 DOM / WASM，所有坐标都是幻灯片坐标（缩放 1 的 CSS 像素），可以用手写的小列表做单测。
 */
import type { SlideDisplayList, SlidePrimitive, TextBoxPrimitive } from '@betteroffice/pptx'
import type { CaretInfo, CaretMove } from '../surfaces/slide/types'

export interface Point {
  x: number
  y: number
}

type Line = TextBoxPrimitive['lines'][number]

/** 找到某个文本流对应的文本框图元（表格 / 图表里的单元格文本框也找得到） */
export function findTextBox(list: Pick<SlideDisplayList, 'primitives'>, storyId: string): TextBoxPrimitive | null {
  const walk = (primitives: readonly SlidePrimitive[]): TextBoxPrimitive | null => {
    for (const primitive of primitives) {
      if (primitive.kind === 'textBox' && primitive.storyId === storyId) return primitive
      if (primitive.kind === 'table' || primitive.kind === 'chart') {
        const inner = walk(primitive.primitives)
        if (inner) return inner
      }
    }
    return null
  }
  return walk(list.primitives)
}

/** 把点从幻灯片坐标换到图元自己的（未旋转、未翻转的）坐标系 */
export function localPoint(primitive: Pick<SlidePrimitive, 'x' | 'y' | 'w' | 'h' | 'transform'>, point: Point): Point {
  const transform = primitive.transform
  if (!transform || (!transform.rotationDeg && !transform.flipH && !transform.flipV)) return point
  const cx = primitive.x + primitive.w / 2
  const cy = primitive.y + primitive.h / 2
  const angle = ((transform.rotationDeg ?? 0) * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dx = point.x - cx
  const dy = point.y - cy
  // 绘制是先旋转再翻转，所以反过来：先逆旋转，再翻转
  let x = dx * cos + dy * sin
  let y = dy * cos - dx * sin
  if (transform.flipH) x = -x
  if (transform.flipV) y = -y
  return { x: cx + x, y: cy + y }
}

/** 位置 `position` 落在哪一行：在折行边界上（上一行行尾 = 下一行行首）时，`hint` 指定的那行优先 */
export function lineIndexFor(lines: readonly Line[], position: number, hint?: number): number {
  const hits: number[] = []
  lines.forEach((line, i) => {
    if (position >= line.start && position <= line.end) hits.push(i)
  })
  if (!hits.length) return position < (lines[0]?.start ?? 0) ? 0 : Math.max(0, lines.length - 1)
  if (hint !== undefined && hits.includes(hint)) return hint
  // 没有提示：边界上取后一行（光标显示在下一行行首），但落在整段文字末尾时取最后一行
  return hits.length > 1 && position < lines[hits.at(-1)!]!.end ? hits.at(-1)! : hits[0]!
}

function stopX(line: Line, position: number): number {
  const stops = line.caretStops
  if (!stops.length) return line.x
  let before = stops[0]!
  let after = stops.at(-1)!
  for (const stop of stops) {
    if (stop.position === position) return stop.x
    if (stop.position < position) before = stop
    if (stop.position > position) {
      after = stop
      break
    }
  }
  if (position <= before.position) return before.x
  if (position >= after.position) return after.x
  // 两个停靠点之间（一个 emoji / 合字占多个码元）按比例取
  const ratio = (position - before.position) / (after.position - before.position)
  return before.x + (after.x - before.x) * ratio
}

/** 光标的矩形（幻灯片坐标，宽度 0）；文本流不存在返回 null */
export function caretFor(list: Pick<SlideDisplayList, 'primitives'>, storyId: string, position: number, lineHint?: number): CaretInfo | null {
  const box = findTextBox(list, storyId)
  if (!box || !box.lines.length) return null
  const line = lineIndexFor(box.lines, position, lineHint)
  const target = box.lines[line]!
  const local = { x: stopX(target, Math.min(Math.max(position, target.start), target.end)), y: target.y }
  const rotated = rotatePoint(box, local)
  return { x: rotated.x, y: rotated.y, height: target.height, line }
}

/** 图元里的点（未旋转坐标）→ 屏幕上的点（跟着图元旋转 / 翻转） */
function rotatePoint(primitive: Pick<SlidePrimitive, 'x' | 'y' | 'w' | 'h' | 'transform'>, point: Point): Point {
  const transform = primitive.transform
  if (!transform || (!transform.rotationDeg && !transform.flipH && !transform.flipV)) return point
  const cx = primitive.x + primitive.w / 2
  const cy = primitive.y + primitive.h / 2
  let dx = point.x - cx
  let dy = point.y - cy
  if (transform.flipH) dx = -dx
  if (transform.flipV) dy = -dy
  const angle = ((transform.rotationDeg ?? 0) * Math.PI) / 180
  return { x: cx + dx * Math.cos(angle) - dy * Math.sin(angle), y: cy + dx * Math.sin(angle) + dy * Math.cos(angle) }
}

function lineDistance(line: Line, point: Point, columns: boolean): number {
  const dx = Math.max(line.x - point.x, point.x - line.x - line.width, 0)
  const dy = point.y < line.y ? line.y - point.y : point.y > line.y + line.height ? point.y - line.y - line.height : 0
  return columns ? dx * dx + dy * dy : dy
}

function hasColumns(box: TextBoxPrimitive): boolean {
  return box.lines.some((line, i) => i > 0 && (line.columnOffset ?? 0) !== (box.lines[i - 1]!.columnOffset ?? 0))
}

function nearestStop(line: Line, x: number): number {
  const first = line.caretStops[0]
  if (!first) return line.start
  return line.caretStops.reduce((best, stop) => (Math.abs(stop.x - x) < Math.abs(best.x - x) ? stop : best), first).position
}

/** 点在某个文本流里对应的光标位置（幻灯片坐标的点）；没有行返回 null */
export function positionAtPoint(list: Pick<SlideDisplayList, 'primitives'>, storyId: string, point: Point): { position: number; line: number } | null {
  const box = findTextBox(list, storyId)
  if (!box || !box.lines.length) return null
  const local = localPoint(box, point)
  const columns = hasColumns(box)
  let line = 0
  for (let i = 1; i < box.lines.length; i += 1) {
    if (lineDistance(box.lines[i]!, local, columns) < lineDistance(box.lines[line]!, local, columns)) line = i
  }
  return { position: nearestStop(box.lines[line]!, local.x), line }
}

/** 按 Unicode 码点前进 / 后退一步（不把代理对劈成两半） */
function stepOver(text: string, position: number, direction: 1 | -1): number {
  if (direction > 0) {
    const code = text.codePointAt(position)
    return Math.min(text.length, position + (code !== undefined && code > 0xffff ? 2 : 1))
  }
  if (position <= 0) return 0
  const low = text.charCodeAt(position - 1)
  const high = position >= 2 ? text.charCodeAt(position - 2) : 0
  return low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? position - 2 : position - 1
}

/** 词边界（中日文也能按词断；浏览器没有 Intl.Segmenter 时退化成按空白分） */
export function wordBoundaries(text: string): number[] {
  const bounds = new Set<number>([0, text.length])
  const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => { segment(input: string): Iterable<{ index: number; isWordLike?: boolean; segment: string }> } }).Segmenter
  if (Segmenter) {
    for (const part of new Segmenter(undefined, { granularity: 'word' }).segment(text)) {
      bounds.add(part.index)
      bounds.add(part.index + part.segment.length)
    }
  } else {
    for (const match of text.matchAll(/\s+/g)) {
      bounds.add(match.index!)
      bounds.add(match.index! + match[0].length)
    }
  }
  return [...bounds].sort((a, b) => a - b)
}

/** 移动光标；`text` 是整段文本流（换行符 = 段落分隔，各占 1 个位置） */
export function moveCaret(
  list: Pick<SlideDisplayList, 'primitives'>,
  storyId: string,
  text: string,
  position: number,
  line: number,
  kind: CaretMove,
  preferredX?: number,
): { position: number; line: number } {
  const box = findTextBox(list, storyId)
  const lines = box?.lines ?? []
  const at = Math.min(Math.max(0, position), text.length)
  const result = (next: number, hint?: number) => ({ position: next, line: lines.length ? lineIndexFor(lines, next, hint) : 0 })
  switch (kind) {
    case 'left':
      return result(stepOver(text, at, -1))
    case 'right':
      return result(stepOver(text, at, 1))
    case 'storyStart':
      return result(0)
    case 'storyEnd':
      return result(text.length)
    case 'lineStart': {
      const current = lines[lineIndexFor(lines, at, line)]
      return result(current ? current.start : 0, current ? lineIndexFor(lines, current.start, lineIndexFor(lines, at, line)) : undefined)
    }
    case 'lineEnd': {
      const index = lineIndexFor(lines, at, line)
      const current = lines[index]
      // 折行处的行尾要显示在这一行的末尾，所以把行号钉住
      return current ? { position: current.end, line: index } : result(text.length)
    }
    case 'wordLeft': {
      const bounds = wordBoundaries(text)
      return result([...bounds].reverse().find((b) => b < at) ?? 0)
    }
    case 'wordRight': {
      const bounds = wordBoundaries(text)
      return result(bounds.find((b) => b > at) ?? text.length)
    }
    case 'up':
    case 'down': {
      if (!lines.length) return result(at)
      const index = lineIndexFor(lines, at, line)
      const target = index + (kind === 'down' ? 1 : -1)
      if (target < 0) return result(0)
      if (target >= lines.length) return result(text.length)
      const x = preferredX ?? caretFor(list, storyId, at, index)?.x ?? lines[index]!.x
      const local = box ? localPoint(box, { x, y: lines[target]!.y }) : { x, y: 0 }
      return { position: nearestStop(lines[target]!, local.x), line: target }
    }
  }
}

/** 范围 [start, end) 的选区高亮：每个文本行一块；`text` 用来判断行尾是不是段落分隔符（选中它时行尾多画一小截） */
export function selectionRects(
  list: Pick<SlideDisplayList, 'primitives'>,
  storyId: string,
  start: number,
  end: number,
  text = '',
): Array<{ x: number; y: number; width: number; height: number }> {
  const box = findTextBox(list, storyId)
  if (!box || start >= end) return []
  const out: Array<{ x: number; y: number; width: number; height: number }> = []
  for (const line of box.lines) {
    const s = Math.max(line.start, start)
    const e = Math.min(line.end, end)
    // 选中了换行符的整行：行尾多画一小截，让用户看见"这一行的换行被选中了"
    const wholeBreak = end > line.end && start <= line.end && text[line.end] === '\n'
    if (s >= e && !wholeBreak) continue
    const left = stopX(line, Math.max(s, line.start))
    const right = Math.max(stopX(line, Math.min(e, line.end)) + (wholeBreak && end > line.end ? 4 : 0), left)
    if (right <= left) continue
    const rect = { x: left, y: line.y, width: right - left, height: line.height }
    out.push(rect)
  }
  return out
}

/** 文本框边缘多宽算"形状边框"（屏幕像素）：边框抓框，中间放光标 */
export const BORDER_BAND_PX = 6

export type PointerTarget = { kind: 'shape'; shapeId: string } | { kind: 'text'; shapeId: string; storyId: string; position: number }

function contains(primitive: Pick<SlidePrimitive, 'x' | 'y' | 'w' | 'h' | 'transform'>, point: Point): Point | null {
  const local = localPoint(primitive, point)
  return local.x >= primitive.x && local.x <= primitive.x + primitive.w && local.y >= primitive.y && local.y <= primitive.y + primitive.h ? local : null
}

function withinBorder(primitive: Pick<SlidePrimitive, 'x' | 'y' | 'w' | 'h'>, local: Point, scale: number): boolean {
  const band = Math.min(BORDER_BAND_PX / (scale > 0 ? scale : 1), primitive.w / 3, primitive.h / 3)
  return local.x - primitive.x <= band || primitive.x + primitive.w - local.x <= band || local.y - primitive.y <= band || primitive.y + primitive.h - local.y <= band
}

/**
 * 点中了什么：从最上层往下找第一个带 shapeId 且包含该点的图元。
 * 文本框（中间部分、且有行可以放光标）→ 文字；表格里命中的单元格同理；其余 → 形状。
 */
export function pointerTarget(list: Pick<SlideDisplayList, 'primitives'>, point: Point, scale = 1): PointerTarget | null {
  for (let i = list.primitives.length - 1; i >= 0; i -= 1) {
    const primitive = list.primitives[i]!
    if (!primitive.shapeId) continue
    const local = contains(primitive, point)
    if (!local) continue
    if (primitive.kind === 'textBox' && primitive.storyId && primitive.lines.length && !withinBorder(primitive, local, scale)) {
      const found = positionAtPoint(list, primitive.storyId, point)
      if (found) return { kind: 'text', shapeId: primitive.shapeId, storyId: primitive.storyId, position: found.position }
    }
    if (primitive.kind === 'table') {
      for (let j = primitive.primitives.length - 1; j >= 0; j -= 1) {
        const cell = primitive.primitives[j]!
        if (cell.kind === 'textBox' && cell.storyId && cell.lines.length && contains(cell, point)) {
          const found = positionAtPoint(list, cell.storyId, point)
          if (found && !withinBorder(primitive, local, scale)) return { kind: 'text', shapeId: primitive.shapeId, storyId: cell.storyId, position: found.position }
        }
      }
    }
    return { kind: 'shape', shapeId: primitive.shapeId }
  }
  return null
}
