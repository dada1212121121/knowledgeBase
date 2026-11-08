/**
 * PPTX 引擎数据纯函数测试：手写的小快照 / 显示列表，不起 WASM
 */
import { describe, expect, it } from 'vitest'
import type { DeckSnapshot, ShapeSnapshot, SlideDisplayList, SlideSnapshot } from '@betteroffice/pptx'
import { deckText, fontNotice, hasCjk, listHasCjk, listText, rotatedBounds, shapeParagraphs, slideTitle, substitutedFonts, textRectsFor } from './pptxModel'

const run = (text: string, fontFamily: string | null = null) => ({ text, style: { bold: null, italic: null, fontSizePt: null, color: null, fontFamily, underline: null } })
const shape = (paragraphs: string[][], extra: Partial<ShapeSnapshot> = {}, fonts: Array<string | null> = []): ShapeSnapshot =>
  ({
    id: 's',
    kind: 'shape',
    name: 'n',
    children: [],
    placeholder: null,
    textStories: [{ id: 'st', length: 0, paragraphs: paragraphs.map((runs) => ({ id: 'p', alignment: null, level: 0, bulletJson: null, runs: runs.map((text, i) => run(text, fonts[i] ?? null)) })) }],
    ...extra,
  }) as unknown as ShapeSnapshot
const slide = (shapes: ShapeSnapshot[], notes?: string): SlideSnapshot => ({ id: 'slide:0', shapes, notes }) as unknown as SlideSnapshot
const deck = (slides: SlideSnapshot[]): DeckSnapshot => ({ widthEmu: 12192000, heightEmu: 6858000, slides }) as unknown as DeckSnapshot

describe('中文判断', () => {
  it('汉字、假名、全角标点算中文；纯拉丁与 emoji 不算', () => {
    expect(hasCjk('产品路线图')).toBe(true)
    expect(hasCjk('こんにちは')).toBe(true)
    expect(hasCjk('Ａ１，')).toBe(true)
    expect(hasCjk('Quarterly review 12 — 😀')).toBe(false)
    expect(hasCjk('')).toBe(false)
  })
})

describe('标题与文字', () => {
  it('标题占位符优先，哪怕它不是第一个形状', () => {
    const body = shape([['正文第一行']])
    const title = shape([['真正的标题']], { placeholder: { placeholderType: 'title' } as never })
    expect(slideTitle(slide([body, title]))).toBe('真正的标题')
    const centered = shape([['封面标题']], { placeholder: { placeholderType: 'ctrTitle' } as never })
    expect(slideTitle(slide([body, centered]))).toBe('封面标题')
  })

  it('没有标题占位符时取第一个有文字的形状的第一行；跳过空行', () => {
    expect(slideTitle(slide([shape([['']]), shape([['  '], ['第一行', '续'], ['第二行']])]))).toBe('第一行续')
    expect(slideTitle(slide([shape([['']])]))).toBe('')
  })

  it('组合内的子形状也算；过长标题截断加省略号', () => {
    const inner = shape([['组合里的字']])
    expect(slideTitle(slide([shape([], { children: [inner] })]))).toBe('组合里的字')
    const long = 'x'.repeat(200)
    const title = slideTitle(slide([shape([[long]])]))
    expect(title.length).toBe(81)
    expect(title.endsWith('…')).toBe(true)
  })

  it('shapeParagraphs 递归拿到每一段', () => {
    expect(shapeParagraphs(shape([['a', 'b'], ['c']], { children: [shape([['d']])] }))).toEqual(['ab', 'c', 'd'])
  })

  it('deckText 汇总所有页的文字与备注', () => {
    const text = deckText(deck([slide([shape([['one']])], '备注一'), slide([shape([['two']])])]))
    expect(text).toContain('one')
    expect(text).toContain('two')
    expect(text).toContain('备注一')
    expect(hasCjk(text)).toBe(true)
  })
})

describe('字体提示', () => {
  it('只列出未内置的拉丁字体；Calibri / Arial / Carlito、中文族名、主题字体占位不算', () => {
    const snapshot = deck([
      slide([
        shape([['a', 'b', 'c', 'd', 'e', 'f', 'g']], {}, ['Calibri', 'Arial', 'carlito', '微软雅黑', '+mn-lt', 'Times New Roman', 'Consolas']),
        shape([['x']], {}, ['Times New Roman']),
      ]),
    ])
    expect(substitutedFonts(snapshot)).toEqual(['Consolas', 'Times New Roman'])
  })

  it('提示文案：没有则 null；超过 4 种显示总数', () => {
    expect(fontNotice([])).toBeNull()
    expect(fontNotice(['A', 'B'])).toContain('A、B')
    expect(fontNotice(['A', 'B', 'C', 'D', 'E', 'F'])).toContain('等 6 种')
  })
})

type Prim = SlideDisplayList['primitives'][number]
const textBox = (over: Record<string, unknown>): Prim =>
  ({
    kind: 'textBox',
    storyId: 'story:1',
    x: 0,
    y: 0,
    w: 400,
    h: 100,
    lines: [
      { x: 10, y: 20, width: 300, height: 30, start: 0, end: 10, caretStops: [{ position: 0, x: 10 }, { position: 3, x: 70 }, { position: 6, x: 130 }, { position: 10, x: 310 }], runs: [{ text: '你好 world' }] },
      { x: 10, y: 60, width: 200, height: 30, start: 10, end: 18, caretStops: [{ position: 10, x: 10 }, { position: 18, x: 210 }], runs: [{ text: 'second' }] },
    ],
    ...over,
  }) as unknown as Prim

describe('显示列表', () => {
  it('listText 收集所有文本框的文字，递归进表格 / 图表，不含占位符的说明文字', () => {
    const box = (text: string) => ({ kind: 'textBox', lines: [{ runs: [{ text }] }] }) as unknown as Prim
    const list = {
      primitives: [
        box('标题'),
        { kind: 'placeholder', name: 'x', label: '不画的说明' } as unknown as Prim,
        { kind: 'table', primitives: [box('单元格')] } as unknown as Prim,
        { kind: 'chart', primitives: [{ kind: 'table', primitives: [box('图例')] }] } as unknown as Prim,
      ],
    }
    expect(listText(list)).toBe('标题单元格图例')
    expect(listText({ primitives: [] })).toBe('')
  })
  it('listHasCjk 递归进表格 / 图表里的文本框', () => {
    expect(listHasCjk({ primitives: [textBox({})] })).toBe(true)
    const latin = textBox({ lines: [{ x: 0, y: 0, width: 1, height: 1, start: 0, end: 1, caretStops: [], runs: [{ text: 'plain' }] }] })
    expect(listHasCjk({ primitives: [latin] })).toBe(false)
    expect(listHasCjk({ primitives: [{ kind: 'table', primitives: [textBox({})] } as unknown as Prim] })).toBe(true)
    expect(listHasCjk({ primitives: [{ kind: 'chart', primitives: [{ kind: 'table', primitives: [textBox({})] }] } as unknown as Prim] })).toBe(true)
  })

  it('命中矩形：用光标停靠点算横向范围，行框算纵向', () => {
    const rects = textRectsFor({ primitives: [textBox({})] }, { storyId: 'story:1', start: 3, end: 6 })
    expect(rects).toEqual([{ x: 70, y: 20, width: 60, height: 30 }])
  })

  it('命中跨两行得到两个矩形；只落在一行里的不会带出另一行', () => {
    const rects = textRectsFor({ primitives: [textBox({})] }, { storyId: 'story:1', start: 6, end: 14 })
    expect(rects).toHaveLength(2)
    expect(rects[0]).toEqual({ x: 130, y: 20, width: 180, height: 30 })
    expect(textRectsFor({ primitives: [textBox({})] }, { storyId: 'story:1', start: 11, end: 14 })).toHaveLength(1)
  })

  it('其它文本流、空区间、表格里的文本流', () => {
    expect(textRectsFor({ primitives: [textBox({})] }, { storyId: 'other', start: 0, end: 5 })).toEqual([])
    expect(textRectsFor({ primitives: [textBox({})] }, { storyId: 'story:1', start: 4, end: 4 })).toEqual([])
    const inTable = { kind: 'table', primitives: [textBox({ storyId: 'cell' })] } as unknown as Prim
    expect(textRectsFor({ primitives: [inTable] }, { storyId: 'cell', start: 0, end: 3 })).toHaveLength(1)
  })

  it('文本框旋转 90° 时矩形取外接框', () => {
    expect(rotatedBounds({ x: 0, y: 0, width: 100, height: 20 }, 0)).toEqual({ x: 0, y: 0, width: 100, height: 20 })
    const turned = rotatedBounds({ x: 0, y: 0, width: 100, height: 20 }, 90)
    expect(turned.width).toBeCloseTo(20, 5)
    expect(turned.height).toBeCloseTo(100, 5)
    expect(turned.x).toBeCloseTo(40, 5)
    expect(turned.y).toBeCloseTo(-40, 5)
  })
})
