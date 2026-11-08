/**
 * PPTX 引擎数据的纯函数
 *
 * 这里只处理引擎吐出来的普通对象（快照、显示列表），不碰 WASM、不碰 DOM，
 * 所以能用手写的小对象做单测。需要真实引擎的部分在 `pptx.ts`。
 * 类型只从 `@betteroffice/pptx` 引（type-only，不进运行时），符合「只有 engines/ 能引上游」的契约。
 */
import type { DeckSnapshot, ShapeSnapshot, SlideDisplayList, SlidePrimitive, SlideSnapshot } from '@betteroffice/pptx'
import type { SlideRect } from '../surfaces/slide/types'

/** 中文字体要不要下载的判断：CJK 统一表意文字、假名、全角标点、兼容区（与 FontFace 的 unicode-range 同一批） */
const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u3000-\u303F]/u

export function hasCjk(text: string): boolean {
  return CJK.test(text)
}

/** 形状（含组合内的子形状）的每一段文字 */
export function shapeParagraphs(shape: ShapeSnapshot): string[] {
  const out: string[] = []
  for (const story of shape.textStories ?? []) {
    for (const paragraph of story.paragraphs) out.push(paragraph.runs.map((run) => run.text).join(''))
  }
  for (const child of shape.children ?? []) out.push(...shapeParagraphs(child))
  return out
}

function placeholderType(shape: ShapeSnapshot): string | null {
  const placeholder = shape.placeholder as { placeholderType?: string } | null
  return placeholder?.placeholderType ?? null
}

/** 标题的最大长度：目录、缩略图标题、大纲都用它，太长在 UI 里也是被省略号截掉 */
const TITLE_MAX = 80

/**
 * 一页的标题：标题占位符的文字优先；没有就取第一个有文字的形状的第一行。
 * 引擎快照里 `title` 字段目前恒为 null，不能指望它。
 */
export function slideTitle(slide: SlideSnapshot): string {
  const firstLine = (shape: ShapeSnapshot) => shapeParagraphs(shape).map((line) => line.trim()).find(Boolean) ?? ''
  const isTitle = (shape: ShapeSnapshot) => ['title', 'ctrTitle'].includes(placeholderType(shape) ?? '')
  const flat = (shapes: readonly ShapeSnapshot[]): ShapeSnapshot[] => shapes.flatMap((shape) => [shape, ...flat(shape.children ?? [])])
  const shapes = flat(slide.shapes)
  const titled = shapes.filter(isTitle).map(firstLine).find(Boolean)
  const text = titled || shapes.map(firstLine).find(Boolean) || ''
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text
}

/** 整份 deck 的可见文字 + 备注（用来判断要不要下载中文字体） */
export function deckText(snapshot: DeckSnapshot): string {
  const parts: string[] = []
  for (const slide of snapshot.slides) {
    for (const shape of slide.shapes) parts.push(...shapeParagraphs(shape))
    if (slide.notes) parts.push(slide.notes)
  }
  return parts.join('\n')
}

/** 显示列表里有没有中文：表格 / 图表里的文字不在快照的文本流里，所以绘制前再扫一遍显示列表兜底 */
export function listHasCjk(list: Pick<SlideDisplayList, 'primitives'>): boolean {
  const walk = (primitives: readonly SlidePrimitive[]): boolean => {
    for (const primitive of primitives) {
      if (primitive.kind === 'textBox') {
        for (const line of primitive.lines) for (const run of line.runs) if (hasCjk(run.text)) return true
      } else if ((primitive.kind === 'table' || primitive.kind === 'chart') && walk(primitive.primitives)) {
        return true
      }
    }
    return false
  }
  return walk(list.primitives)
}

/**
 * 显示列表里所有要画的文字（含表格 / 图表里的）：画之前据此决定要加载哪些字形片（fonts/glyphFaces.ts）。
 * 和 listHasCjk 走同一种递归，只是把文字收集起来而不是判断有没有中文。
 */
export function listText(list: Pick<SlideDisplayList, 'primitives'>): string {
  const parts: string[] = []
  const walk = (primitives: readonly SlidePrimitive[]): void => {
    for (const primitive of primitives) {
      if (primitive.kind === 'textBox') {
        for (const line of primitive.lines) for (const run of line.runs) parts.push(run.text)
      } else if (primitive.kind === 'table' || primitive.kind === 'chart') {
        walk(primitive.primitives)
      }
    }
  }
  walk(list.primitives)
  return parts.join('')
}

/** 已经内置了字宽一致字体的族名（小写）；其余 Latin 族名会被 Carlito 顶替，换行位置可能和 PowerPoint 略有出入 */
const COVERED_FAMILIES = new Set(['calibri', 'carlito', 'arial'])

/** deck 里显式写了、而我们没有内置的拉丁字体名（去重、排序；中文族名不算，中文统一由 Noto Sans SC 顶替） */
export function substitutedFonts(snapshot: DeckSnapshot): string[] {
  const found = new Set<string>()
  const walk = (shape: ShapeSnapshot) => {
    for (const story of shape.textStories ?? []) {
      for (const paragraph of story.paragraphs) {
        for (const run of paragraph.runs) {
          const name = run.style.fontFamily?.trim()
          if (!name || name.startsWith('+') || hasCjk(name)) continue
          if (!COVERED_FAMILIES.has(name.toLowerCase())) found.add(name)
        }
      }
    }
    for (const child of shape.children ?? []) walk(child)
  }
  for (const slide of snapshot.slides) for (const shape of slide.shapes) walk(shape)
  return [...found].sort((a, b) => a.localeCompare(b))
}

export function fontNotice(names: readonly string[]): string | null {
  if (!names.length) return null
  const shown = names.slice(0, 4).join('、')
  return `此演示文稿用到了未内置的字体（${shown}${names.length > 4 ? ` 等 ${names.length} 种` : ''}），已用相近字体替代，换行位置可能与 PowerPoint 略有不同`
}

/** 矩形绕自身中心旋转后的外接矩形（命中高亮只需要覆盖范围，不需要斜着画） */
export function rotatedBounds(rect: SlideRect, degrees: number): SlideRect {
  if (!degrees) return rect
  const angle = (degrees * Math.PI) / 180
  const cos = Math.abs(Math.cos(angle))
  const sin = Math.abs(Math.sin(angle))
  const width = rect.width * cos + rect.height * sin
  const height = rect.width * sin + rect.height * cos
  return { x: rect.x + (rect.width - width) / 2, y: rect.y + (rect.height - height) / 2, width, height }
}

/**
 * 某个文本流里 [start, end) 这段文字在这一页上的矩形（幻灯片坐标）。
 * 每一行一个矩形：横向范围取这一行里落在区间内的光标停靠点的最左 / 最右，纵向是行框。
 * 文本框被旋转时返回外接矩形。
 */
export function textRectsFor(list: Pick<SlideDisplayList, 'primitives'>, match: { storyId: string; start: number; end: number }): SlideRect[] {
  const out: SlideRect[] = []
  const walk = (primitives: readonly SlidePrimitive[]) => {
    for (const primitive of primitives) {
      if (primitive.kind === 'table' || primitive.kind === 'chart') {
        walk(primitive.primitives)
        continue
      }
      if (primitive.kind !== 'textBox' || primitive.storyId !== match.storyId) continue
      for (const line of primitive.lines) {
        const start = Math.max(line.start, match.start)
        const end = Math.min(line.end, match.end)
        if (start >= end) continue
        const xs = line.caretStops.filter((stop) => stop.position >= start && stop.position <= end).map((stop) => stop.x)
        const left = xs.length > 1 ? Math.min(...xs) : line.x
        const right = xs.length > 1 ? Math.max(...xs) : line.x + line.width
        if (right <= left) continue
        out.push(rotatedBounds({ x: left, y: line.y, width: right - left, height: line.height }, primitive.transform?.rotationDeg ?? 0))
      }
    }
  }
  walk(list.primitives)
  return out
}
