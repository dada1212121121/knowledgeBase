// 合成样本:用 cfb 按规范拼出最小的 .doc / .ppt(真实 Word / PowerPoint 文件在本机验证过,见架构设计说明)。
import * as CFB from 'cfb'
import { describe, expect, it } from 'vitest'
import { LegacyOfficeError, extractDoc, extractPpt, openOle, structureWordText } from './legacyOffice'

function ole(streams: Record<string, Uint8Array>): Uint8Array {
  const container = CFB.utils.cfb_new()
  for (const [name, data] of Object.entries(streams)) CFB.utils.cfb_add(container, name, data)
  return Uint8Array.from(CFB.write(container, { type: 'array' }) as number[])
}

/** 最小 .doc:一个 piece(ANSI 压缩或 UTF-16),FIB 里只填解析器会读的字段。 */
function makeDoc(text: string, { unicode = false, flags = 0x0200, magic = 0xa5ec } = {}): Uint8Array {
  const body = unicode ? new Uint8Array(text.length * 2) : new Uint8Array(text.length)
  text.split('').forEach((char, index) => {
    if (unicode) new DataView(body.buffer).setUint16(index * 2, char.charCodeAt(0), true)
    else body[index] = char.charCodeAt(0) & 0xff
  })
  const header = 0x400
  const main = new Uint8Array(header + body.length)
  const view = new DataView(main.buffer)
  view.setUint16(0, magic, true)
  view.setUint16(0x0a, flags, true)
  view.setUint32(0x4c, text.length, true)
  main.set(body, header)
  // Clx: 0x02 + lcb + PlcPcd(CP0, CP1, PCD)
  const plc = new Uint8Array(4 * 2 + 8)
  const plcView = new DataView(plc.buffer)
  plcView.setUint32(0, 0, true)
  plcView.setUint32(4, text.length, true)
  plcView.setUint32(8 + 2, unicode ? header : (header * 2) | 0x40000000, true)
  const clx = new Uint8Array(5 + plc.length)
  clx[0] = 0x02
  new DataView(clx.buffer).setUint32(1, plc.length, true)
  clx.set(plc, 5)
  view.setUint32(0x1a2, 0, true)
  view.setUint32(0x1a6, clx.length, true)
  return ole({ WordDocument: main, '1Table': clx, '0Table': clx })
}

describe('structureWordText', () => {
  it('splits paragraphs and collapses blank runs', () => {
    expect(structureWordText('第一段\r\r\r第二段\r')).toEqual([
      { kind: 'p', text: '第一段' },
      { kind: 'p', text: '' },
      { kind: 'p', text: '第二段' },
    ])
  })
  it('builds a table from cell and row marks', () => {
    const blocks = structureWordText('前言\r' + 'a\x07b\x07\x07' + 'c\x07d\x07\x07' + '后记\r')
    expect(blocks).toEqual([
      { kind: 'p', text: '前言' },
      { kind: 'table', rows: [['a', 'b'], ['c', 'd']] },
      { kind: 'p', text: '后记' },
    ])
  })
  it('keeps field results and drops field codes', () => {
    expect(structureWordText('见\x13 PAGEREF _Toc1 \\h \x14第 3 页\x15。\r')).toEqual([{ kind: 'p', text: '见第 3 页。' }])
    expect(structureWordText('x\x13 TOC \\o \x15y\r')).toEqual([{ kind: 'p', text: 'xy' }])
  })
  it('turns vertical tabs into line breaks and strips stray controls', () => {
    expect(structureWordText('a\x0bb\x01\x08c\r')).toEqual([{ kind: 'p', text: 'a\nbc' }])
  })
})

describe('extractDoc', () => {
  it('reads an ANSI-compressed piece', () => {
    const blocks = extractDoc(makeDoc('Hello\rWorld\r'))
    expect(blocks.map((block) => (block.kind === 'p' ? block.text : ''))).toEqual(['Hello', 'World'])
  })
  it('reads a UTF-16 piece (Chinese text)', () => {
    const blocks = extractDoc(makeDoc('你好，世界\r', { unicode: true }))
    expect(blocks).toEqual([{ kind: 'p', text: '你好，世界' }])
  })
  it('reads the 0Table when the flag selects it', () => {
    expect(extractDoc(makeDoc('abc\r', { flags: 0 }))).toEqual([{ kind: 'p', text: 'abc' }])
  })
  it('reports encrypted, foreign and corrupt files in plain words', () => {
    expect(() => extractDoc(makeDoc('x\r', { flags: 0x0300 }))).toThrow(/密码/)
    expect(() => extractDoc(makeDoc('x\r', { magic: 0x1234 }))).toThrow(/Word 97/)
    expect(() => extractDoc(new Uint8Array([1, 2, 3]))).toThrow(LegacyOfficeError)
    expect(() => extractDoc(ole({ Other: new Uint8Array(10) }))).toThrow(/没有找到 Word 正文流/)
  })
})

const record = (ver: number, type: number, payload: Uint8Array) => {
  const out = new Uint8Array(8 + payload.length)
  const view = new DataView(out.buffer)
  view.setUint16(0, ver, true)
  view.setUint16(2, type, true)
  view.setUint32(4, payload.length, true)
  out.set(payload, 8)
  return out
}
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) (out.set(part, at), (at += part.length))
  return out
}
const utf16 = (text: string) => {
  const out = new Uint8Array(text.length * 2)
  text.split('').forEach((char, index) => new DataView(out.buffer).setUint16(index * 2, char.charCodeAt(0), true))
  return out
}
const u32 = (value: number) => {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value, true)
  return out
}
const textBox = (type: number, text: string) =>
  record(0x0f, 0x0f00, concat(record(0, 0x0f9f, u32(type)), record(0, 0x0fa0, utf16(text))))
const slide = (...boxes: Uint8Array[]) => record(0x0f, 0x03ee, record(0x0f, 0x040c, concat(...boxes)))
const notes = (text: string) => record(0x0f, 0x03f0, record(0x0f, 0x040c, textBox(2, text)))

describe('extractPpt', () => {
  it('collects titles, bodies and notes per slide', () => {
    const stream = concat(
      slide(textBox(0, '路线图'), textBox(1, '批次 1\r批次 2')),
      notes('先讲批次 1'),
      slide(textBox(6, '检索质量'), record(0x0f, 0x0f00, record(0, 0x0fa8, new TextEncoder().encode('RRF'))) ),
      notes('补充 RRF'),
    )
    const slides = extractPpt(ole({ 'PowerPoint Document': stream }))
    expect(slides).toHaveLength(2)
    expect(slides[0]).toEqual({ title: '路线图', body: ['批次 1\n批次 2'], notes: ['先讲批次 1'] })
    expect(slides[1]!.title).toBe('检索质量')
    expect(slides[1]!.body).toEqual(['RRF'])
    expect(slides[1]!.notes).toEqual(['补充 RRF'])
  })
  it('does not guess notes when the counts differ', () => {
    const stream = concat(slide(textBox(0, 'A')), slide(textBox(0, 'B')), notes('only one'))
    const slides = extractPpt(ole({ 'PowerPoint Document': stream }))
    expect(slides.map((item) => item.notes)).toEqual([[], []])
  })
  it('explains missing streams and empty decks', () => {
    expect(() => extractPpt(ole({ Other: new Uint8Array(4) }))).toThrow(/没有找到 PowerPoint/)
    expect(() => extractPpt(ole({ 'PowerPoint Document': new Uint8Array(16) }))).toThrow(/没有找到幻灯片/)
  })
})

describe('openOle', () => {
  it('lists stream names', () => {
    expect(openOle(ole({ A: new Uint8Array(4), B: new Uint8Array(4) })).names).toEqual(expect.arrayContaining(['A', 'B']))
  })
})
