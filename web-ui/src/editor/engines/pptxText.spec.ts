/**
 * 显示列表文字几何测试：手写的文本框，故意带折行边界、段落分隔、旋转、表格单元格
 */
import { describe, expect, it } from 'vitest'
import type { SlidePrimitive } from '@betteroffice/pptx'
import { caretFor, findTextBox, lineIndexFor, localPoint, moveCaret, pointerTarget, positionAtPoint, selectionRects, wordBoundaries } from './pptxText'

const TEXT = 'hello world\nsecond'

/** 每个字符 10px 宽；三行：折行的 "hello " + "world"，以及第二段 "second" */
function box(over: Record<string, unknown> = {}): SlidePrimitive {
  const stops = (start: number, end: number, x0: number) => Array.from({ length: end - start + 1 }, (_, i) => ({ position: start + i, x: x0 + i * 10 }))
  return {
    kind: 'textBox',
    shapeId: 'sp1',
    storyId: 'story1',
    x: 100,
    y: 100,
    w: 300,
    h: 120,
    lines: [
      { x: 110, y: 110, width: 60, height: 20, start: 0, end: 6, caretStops: stops(0, 6, 110), runs: [] },
      { x: 110, y: 130, width: 50, height: 20, start: 6, end: 11, caretStops: stops(6, 11, 110), runs: [] },
      { x: 110, y: 150, width: 60, height: 20, start: 12, end: 18, caretStops: stops(12, 18, 110), runs: [] },
    ],
    ...over,
  } as unknown as SlidePrimitive
}
const list = (...primitives: SlidePrimitive[]) => ({ primitives })

describe('光标位置', () => {
  it('光标 x 来自停靠点，y 和高度来自行框', () => {
    expect(caretFor(list(box()), 'story1', 3)).toEqual({ x: 140, y: 110, height: 20, line: 0 })
    expect(caretFor(list(box()), 'story1', 15)).toEqual({ x: 140, y: 150, height: 20, line: 2 })
  })

  it('折行边界（上一行行尾 = 下一行行首）：默认显示在下一行行首，提示行号时按提示', () => {
    expect(caretFor(list(box()), 'story1', 6)?.line).toBe(1)
    expect(caretFor(list(box()), 'story1', 6, 0)).toEqual({ x: 170, y: 110, height: 20, line: 0 })
    expect(caretFor(list(box()), 'story1', 6, 1)).toEqual({ x: 110, y: 130, height: 20, line: 1 })
  })

  it('整段文字末尾停在最后一行行尾；超界位置夹到范围内', () => {
    expect(caretFor(list(box()), 'story1', 18)).toEqual({ x: 170, y: 150, height: 20, line: 2 })
    expect(caretFor(list(box()), 'story1', 999)?.line).toBe(2)
    expect(caretFor(list(box()), 'story1', -3)?.line).toBe(0)
  })

  it('空文本流（只有一个空行）也能放光标；找不到文本流返回 null', () => {
    const empty = box({ lines: [{ x: 110, y: 110, width: 0, height: 20, start: 0, end: 0, caretStops: [{ position: 0, x: 110 }], runs: [] }] })
    expect(caretFor(list(empty), 'story1', 0)).toEqual({ x: 110, y: 110, height: 20, line: 0 })
    expect(caretFor(list(box()), 'nope', 0)).toBeNull()
    expect(caretFor(list(box({ lines: [] })), 'story1', 0)).toBeNull()
  })

  it('停靠点之间（一个 emoji 占两个码元）按比例取', () => {
    const emoji = box({ lines: [{ x: 110, y: 110, width: 40, height: 20, start: 0, end: 4, caretStops: [{ position: 0, x: 110 }, { position: 2, x: 130 }, { position: 4, x: 150 }], runs: [] }] })
    expect(caretFor(list(emoji), 'story1', 1)?.x).toBe(120)
  })

  it('表格里的文本流也找得到', () => {
    const table = { kind: 'table', shapeId: 't', x: 0, y: 0, w: 500, h: 200, primitives: [box({ storyId: 'cell' })] } as unknown as SlidePrimitive
    expect(findTextBox(list(table), 'cell')).not.toBeNull()
    expect(caretFor(list(table), 'cell', 2)?.x).toBe(130)
  })

  it('文本框旋转 90° 时光标跟着转', () => {
    const rotated = box({ transform: { rotationDeg: 90 } })
    const caret = caretFor(list(rotated), 'story1', 3)!
    // 框中心 (250,160)；未旋转的光标 (140,110) 相对中心 (-110,-50) → 顺时针 90° 后 (50,-110)
    expect(caret.x).toBeCloseTo(300, 5)
    expect(caret.y).toBeCloseTo(50, 5)
  })
})

describe('点选定位', () => {
  it('点落在哪一行就选哪一行里最近的停靠点', () => {
    expect(positionAtPoint(list(box()), 'story1', { x: 133, y: 140 })).toEqual({ position: 8, line: 1 })
    expect(positionAtPoint(list(box()), 'story1', { x: 112, y: 112 })).toEqual({ position: 0, line: 0 })
  })

  it('点在文字下方 / 右侧落到最近的行和行尾', () => {
    expect(positionAtPoint(list(box()), 'story1', { x: 390, y: 400 })).toEqual({ position: 18, line: 2 })
    expect(positionAtPoint(list(box()), 'story1', { x: 390, y: 112 })).toEqual({ position: 6, line: 0 })
  })

  it('旋转的文本框先把点换到框自己的坐标系', () => {
    const rotated = box({ transform: { rotationDeg: 90 } })
    const screen = { x: 300, y: 50 } // 对应未旋转坐标 (140,110)，即第 3 个字符之后
    expect(positionAtPoint(list(rotated), 'story1', screen)?.position).toBe(3)
    expect(localPoint(rotated as never, screen).x).toBeCloseTo(140, 5)
  })
})

describe('光标移动', () => {
  const move = (position: number, line: number, kind: Parameters<typeof moveCaret>[5], x?: number) => moveCaret(list(box()), 'story1', TEXT, position, line, kind, x)

  it('左右：按码点走，越过段落分隔符，不把代理对劈开', () => {
    expect(move(3, 0, 'right').position).toBe(4)
    expect(move(11, 1, 'right').position).toBe(12)
    expect(move(0, 0, 'left').position).toBe(0)
    expect(moveCaret(list(box()), 'story1', 'a😀b', 1, 0, 'right').position).toBe(3)
    expect(moveCaret(list(box()), 'story1', 'a😀b', 3, 0, 'left').position).toBe(1)
  })

  it('上下：到目标行里离原 x 最近的位置；首行再上到开头，末行再下到末尾', () => {
    expect(move(3, 0, 'down').position).toBe(9)
    expect(move(9, 1, 'down').position).toBe(15)
    expect(move(9, 1, 'up')).toEqual({ position: 3, line: 0 })
    expect(move(2, 0, 'up').position).toBe(0)
    expect(move(15, 2, 'down').position).toBe(TEXT.length)
  })

  it('上下连续移动用同一个期望 x，不会越走越偏', () => {
    // 末尾那行比较短：从 x=160 的位置下去只能到行尾，但再回来要回到 x=160
    expect(move(5, 0, 'down', 160).position).toBe(11)
    expect(move(11, 1, 'up', 160).position).toBe(5)
  })

  it('行首 / 行尾：折行处的行尾仍属于这一行', () => {
    expect(move(3, 0, 'lineEnd')).toEqual({ position: 6, line: 0 })
    expect(move(8, 1, 'lineStart')).toEqual({ position: 6, line: 1 })
    expect(move(15, 2, 'lineEnd').position).toBe(18)
  })

  it('整段文字开头 / 末尾', () => {
    expect(move(9, 1, 'storyStart').position).toBe(0)
    expect(move(9, 1, 'storyEnd').position).toBe(TEXT.length)
  })

  it('按词移动：中文也能断词，英文按单词', () => {
    expect(wordBoundaries('hello world')).toEqual(expect.arrayContaining([0, 5, 6, 11]))
    expect(move(0, 0, 'wordRight').position).toBe(5)
    expect(move(11, 1, 'wordLeft').position).toBeLessThan(11)
    const cn = '我们今天开会'
    expect(moveCaret(list(box()), 'story1', cn, 0, 0, 'wordRight').position).toBeGreaterThan(0)
    expect(moveCaret(list(box()), 'story1', cn, 0, 0, 'wordRight').position).toBeLessThan(cn.length)
  })
})

describe('选区矩形', () => {
  it('同一行内：左右边界取停靠点', () => {
    expect(selectionRects(list(box()), 'story1', 1, 4)).toEqual([{ x: 120, y: 110, width: 30, height: 20 }])
  })

  it('跨行：每行一块，折行处不重复', () => {
    const rects = selectionRects(list(box()), 'story1', 3, 9)
    expect(rects).toHaveLength(2)
    expect(rects[0]).toEqual({ x: 140, y: 110, width: 30, height: 20 })
    expect(rects[1]).toEqual({ x: 110, y: 130, width: 30, height: 20 })
  })

  it('跨段落：选中分隔符时那一行行尾多一小截', () => {
    const rects = selectionRects(list(box()), 'story1', 8, 14, TEXT)
    expect(rects).toHaveLength(2)
    expect(rects[0]!.width).toBeGreaterThan(30)
    expect(selectionRects(list(box()), 'story1', 4, 4)).toEqual([])
  })
})

describe('命中分类', () => {
  const shape = { kind: 'shape', shapeId: 'bg', x: 0, y: 0, w: 1280, h: 720 } as unknown as SlidePrimitive

  it('文本框中间 → 文字（带光标位置）；边缘一圈 → 形状', () => {
    const hit = pointerTarget(list(shape, box()), { x: 133, y: 140 }, 1)
    expect(hit).toEqual({ kind: 'text', shapeId: 'sp1', storyId: 'story1', position: 8 })
    expect(pointerTarget(list(shape, box()), { x: 102, y: 140 }, 1)).toEqual({ kind: 'shape', shapeId: 'sp1' })
    expect(pointerTarget(list(shape, box()), { x: 250, y: 217 }, 1)).toEqual({ kind: 'shape', shapeId: 'sp1' })
  })

  it('边缘宽度按屏幕像素算：放大后同样的屏幕宽度对应更窄的幻灯片距离', () => {
    // 距左边 4 个幻灯片像素：缩放 1 时在 6px 边带里，缩放 4 时边带只有 1.5 幻灯片像素 → 变成文字
    expect(pointerTarget(list(box()), { x: 104, y: 140 }, 1)?.kind).toBe('shape')
    expect(pointerTarget(list(box()), { x: 104, y: 140 }, 4)?.kind).toBe('text')
  })

  it('从最上层往下找；点在空白处 → 只命中背景形状；什么都没有 → null', () => {
    expect(pointerTarget(list(shape, box()), { x: 800, y: 600 }, 1)).toEqual({ kind: 'shape', shapeId: 'bg' })
    expect(pointerTarget(list(box()), { x: 800, y: 600 }, 1)).toBeNull()
    const covering = { kind: 'shape', shapeId: 'top', x: 100, y: 100, w: 300, h: 120 } as unknown as SlidePrimitive
    expect(pointerTarget(list(box(), covering), { x: 133, y: 140 }, 1)).toEqual({ kind: 'shape', shapeId: 'top' })
  })

  it('空文本框（没有行）只能当形状选', () => {
    expect(pointerTarget(list(box({ lines: [] })), { x: 200, y: 140 }, 1)).toEqual({ kind: 'shape', shapeId: 'sp1' })
  })

  it('表格：点中单元格里的文字 → 文字（storyId 是单元格的），点在表格边缘 → 形状', () => {
    const cell = box({ storyId: 'cell:0:1', shapeId: undefined, x: 120, y: 120, w: 100, h: 40 })
    const table = { kind: 'table', shapeId: 'tbl', x: 100, y: 100, w: 300, h: 120, primitives: [cell] } as unknown as SlidePrimitive
    expect(pointerTarget(list(table), { x: 140, y: 140 }, 1)).toEqual({ kind: 'text', shapeId: 'tbl', storyId: 'cell:0:1', position: 9 })
    expect(pointerTarget(list(table), { x: 102, y: 140 }, 1)).toEqual({ kind: 'shape', shapeId: 'tbl' })
  })
})

describe('行号推导', () => {
  it('lineIndexFor 在没有命中的位置（落在两段之间的分隔符上）取最近的行', () => {
    const lines = (box() as unknown as { lines: never[] }).lines
    expect(lineIndexFor(lines, 11)).toBe(1)
    expect(lineIndexFor(lines, 12)).toBe(2)
    expect(lineIndexFor(lines, 99)).toBe(2)
  })
})
