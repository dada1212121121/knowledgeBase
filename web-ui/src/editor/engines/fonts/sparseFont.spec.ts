// 稀疏字体的拼装（核心字体 + 扩展字形包 → 完整 TTF）：用仓库里真实生成的文件对着原字体检查，不是造出来的假数据。
// 生成脚本 scripts/build-docx-fonts.py 的 --verify 在 Python 侧做同一件事；这里守的是 TypeScript 侧的拼装实现。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assembleFont, readGlyphPack, readSfnt } from './sparseFont'

const here = `${import.meta.dirname}/`
const generated = (name: string) => new Uint8Array(readFileSync(`${here}gen/docx/${name}`))
const original = (name: string) => new Uint8Array(readFileSync(`${here}../../../../node_modules/@betteroffice/fonts/assets/${name}`))
const u32 = (bytes: Uint8Array, at: number) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at)
const u16 = (bytes: Uint8Array, at: number) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(at)

/** 每个字形的字节（按 head.indexToLocFormat 读 loca） */
function glyphs(font: Uint8Array): Uint8Array[] {
  const tables = readSfnt(font)
  const count = u16(tables.get('maxp')!, 4)
  const long = u16(tables.get('head')!, 50) === 1
  const loca = tables.get('loca')!
  const glyf = tables.get('glyf')!
  const at = (i: number) => (long ? u32(loca, i * 4) : u16(loca, i * 2) * 2)
  return Array.from({ length: count }, (_, i) => glyf.subarray(at(i), at(i + 1)))
}

const same = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((value, i) => value === b[i])

describe('assembleFont：核心 + 全部扩展包拼回去，与原字体逐字节同源', () => {
  const cases: Array<[string, string, string[]]> = [
    ['Carlito-Regular', 'Carlito-Regular.ttf', ['latin-carlito-regular-core.ttf', 'latin-carlito-regular-ext.ttf']],
    ['Liberation Serif Bold', 'LiberationSerif-Bold.ttf', ['latin-liberationserif-bold-core.ttf', 'latin-liberationserif-bold-ext.ttf']],
  ]
  for (const [label, file, [core, ext]] of cases) {
    it(`${label}：每个字形字节相同，度量表（cmap / hmtx / GPOS / kern / OS/2 …）原样`, () => {
      const full = assembleFont(generated(core!), [generated(ext!)])
      const before = glyphs(original(file))
      const after = glyphs(full)
      expect(after).toHaveLength(before.length)
      const wrong = after.map((glyph, i) => (same(glyph, before[i]!) ? -1 : i)).filter((i) => i >= 0)
      expect(wrong).toEqual([])
      const reference = readSfnt(original(file))
      const rebuilt = readSfnt(full)
      for (const tag of ['cmap', 'hmtx', 'hhea', 'maxp', 'OS/2', 'GPOS', 'kern']) {
        if (reference.has(tag)) expect(same(rebuilt.get(tag)!, reference.get(tag)!), tag).toBe(true)
      }
    })
  }

  it('中文：核心 + 全部扩展包，每个字形与裁剪版原字体相同', () => {
    const names = ['cjk-ext-misc.ttf', ...Array.from({ length: 9 }, (_, i) => `cjk-ext-${String(i + 1).padStart(2, '0')}.ttf`)]
    const full = assembleFont(generated('cjk-core.ttf'), names.map(generated))
    const before = glyphs(new Uint8Array(readFileSync(`${here}NotoSansSC-GB2312-Regular.ttf`)))
    const after = glyphs(full)
    expect(after).toHaveLength(before.length)
    expect(after.filter((glyph, i) => !same(glyph, before[i]!))).toHaveLength(0)
  })

  it('只拼一部分扩展包：没拼的字形是空的（度量仍在，所以排版不变），拼了的与原字体相同', () => {
    const core = generated('cjk-core.ttf')
    const coreGlyphs = glyphs(core)
    const pack = readGlyphPack(generated('cjk-ext-01.ttf'))
    const partial = glyphs(assembleFont(core, [generated('cjk-ext-01.ttf')]))
    const before = glyphs(new Uint8Array(readFileSync(`${here}NotoSansSC-GB2312-Regular.ttf`)))
    for (const [gid, bytes] of pack) expect(same(partial[gid]!, bytes) && same(bytes, before[gid]!), `gid ${gid}`).toBe(true)
    // 不在核心也不在第 1 包里的字形：仍是空的
    const emptied = partial.filter((glyph, i) => glyph.byteLength === 0 && coreGlyphs[i]!.byteLength === 0 && !pack.has(i))
    expect(emptied.length).toBeGreaterThan(1000)
    // 度量表一个字节都不变
    expect(same(readSfnt(core).get('hmtx')!, readSfnt(assembleFont(core, [generated('cjk-ext-01.ttf')])).get('hmtx')!)).toBe(true)
  })

  it('拼出来的是合法 sfnt：表目录按标签排序、校验和正确、head.checkSumAdjustment 使整个文件的校验和为 0xB1B0AFBA', () => {
    const full = assembleFont(generated('latin-carlito-bold-core.ttf'), [generated('latin-carlito-bold-ext.ttf')])
    const data = new DataView(full.buffer, full.byteOffset, full.byteLength)
    const count = data.getUint16(4)
    const tags: string[] = []
    for (let i = 0; i < count; i += 1) {
      const at = 12 + 16 * i
      tags.push(String.fromCharCode(full[at]!, full[at + 1]!, full[at + 2]!, full[at + 3]!))
      expect(data.getUint32(at + 8) % 4, '表偏移 4 字节对齐').toBe(0)
    }
    expect(tags).toEqual([...tags].sort())
    let sum = 0
    for (let i = 0; i + 4 <= full.byteLength; i += 4) sum = (sum + data.getUint32(i)) >>> 0
    expect(sum).toBe(0xb1b0afba)
  })

  it('坏文件要报错，不能把半截字体交给引擎', () => {
    const core = generated('latin-carlito-regular-core.ttf')
    expect(() => assembleFont(core.subarray(0, 100), [])).toThrow()
    expect(() => assembleFont(core, [new Uint8Array([1, 2, 3])])).toThrow()
    // 扩展包不是扩展包（拿一个核心字体当扩展包：缺 KGix）
    expect(() => assembleFont(core, [core])).toThrow(/KGix/)
  })

  it('输入不被修改，返回独占的 ArrayBuffer', () => {
    const core = generated('latin-carlito-regular-core.ttf')
    const snapshot = core.slice()
    const full = assembleFont(core, [generated('latin-carlito-regular-ext.ttf')])
    expect(same(core, snapshot)).toBe(true)
    expect(full.byteOffset).toBe(0)
    expect(full.byteLength).toBe(full.buffer.byteLength)
  })
})
