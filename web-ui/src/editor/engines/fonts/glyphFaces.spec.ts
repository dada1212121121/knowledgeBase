/**
 * 浏览器字形按需加载（冷开优化）：哪些字落在哪一片、每片的 unicode-range 是否精确、
 * 加载的去重 / 并行 / 登记顺序 / 失败重试。用假的下载与登记，不碰网络和真实的 FontFace。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HAN_HEAD, HAN_ORDER, HAN_SLICE_COUNT, HAN_TAIL } from './gen/glyphManifest'
import { CORE_SLICES, GlyphFaces, slicesFor, unicodeRangeOf, type GlyphDeps } from './glyphFaces'

const GEN = resolve(import.meta.dirname, 'gen')

/** 解析 `U+4E00-4E02, U+4E10` 成码位集合 */
function codesOf(range: string): Set<number> {
  const out = new Set<number>()
  for (const part of range.split(',')) {
    const [from, to] = part.trim().replace(/^U\+/i, '').split('-')
    for (let cp = parseInt(from!, 16); cp <= parseInt(to ?? from!, 16); cp += 1) out.add(cp)
  }
  return out
}

describe('清单与字体文件', () => {
  it('HAN_ORDER：6763 个互不相同的汉字，片数与每片大小符合切法', () => {
    expect([...HAN_ORDER]).toHaveLength(6763)
    expect(new Set(HAN_ORDER).size).toBe(6763)
    for (const ch of HAN_ORDER) expect(ch.codePointAt(0)! >= 0x4e00 && ch.codePointAt(0)! <= 0x9fff).toBe(true)
    expect(HAN_SLICE_COUNT).toBe(1 + Math.ceil((6763 - HAN_HEAD) / HAN_TAIL))
  })

  it('字频靠前的常用字在第 0 片，最后一个字在最后一片', () => {
    expect(slicesFor('的')).toContain('cjk-han-00')
    expect(slicesFor('的一是不了')).toContain('cjk-han-00')
    const last = HAN_ORDER[HAN_ORDER.length - 1]!
    expect(slicesFor(last)).toContain(`cjk-han-${String(HAN_SLICE_COUNT - 1).padStart(2, '0')}`)
  })

  it('每一片的 unicode-range 恰好等于它的字：各片互不重叠，合起来正好是全部汉字', () => {
    const seen = new Set<number>()
    for (let slice = 0; slice < HAN_SLICE_COUNT; slice += 1) {
      const codes = codesOf(unicodeRangeOf(`cjk-han-${String(slice).padStart(2, '0')}`))
      expect(codes.size).toBe(slice === 0 ? HAN_HEAD : Math.min(HAN_TAIL, 6763 - HAN_HEAD - (slice - 1) * HAN_TAIL))
      for (const cp of codes) {
        expect(seen.has(cp), `U+${cp.toString(16)} 重复出现在多片里`).toBe(false)
        seen.add(cp)
      }
    }
    expect(seen).toEqual(new Set([...HAN_ORDER].map((ch) => ch.codePointAt(0)!)))
  })

  it('不同字体之间不抢码位：Carlito 各片与 Noto 各片只在弯引号 / 省略号上重叠（靠登记顺序），Carlito 的核心片与扩展片重叠无妨（同一份字形）', () => {
    // 回归：拉丁扩展片曾经声明了 Carlito 的全部字符（含弯引号）。同时有中文和西里尔文的文档里，
    // 扩展片和中文标点片抢这几个码位，谁后下载完谁赢，引号一会儿用中文字体、一会儿用 Carlito 画。
    // 核心片 / 扩展片都来自 Carlito，同一个码位两边的字形完全一样，先后无所谓；真正会出错的是 Carlito 与 Noto 抢同一个码位。
    const carlito = ['latin-core-regular', 'latin-core-bold', 'latin-ext-regular', 'latin-ext-bold']
    const noto = ['cjk-sym', 'cjk-kana', ...Array.from({ length: HAN_SLICE_COUNT }, (_, i) => `cjk-han-${String(i).padStart(2, '0')}`)]
    const ownersOf = (ids: string[]) => {
      const owners = new Map<number, string[]>()
      for (const id of ids) for (const cp of codesOf(unicodeRangeOf(id))) owners.set(cp, [...(owners.get(cp) ?? []), id])
      return owners
    }
    const latin = ownersOf(carlito)
    const cjk = ownersOf(noto)
    // Noto 各片之间互不重叠（汉字片、假名片、标点片各管各的）
    expect([...cjk].filter(([, list]) => list.length > 1)).toEqual([])
    // Carlito 与 Noto 重叠的码位：恰好是弯引号和省略号，且 Noto 一侧永远是标点片
    const clash = [...cjk.keys()].filter((cp) => latin.has(cp))
    expect(clash.map((cp) => cp.toString(16)).sort()).toEqual(['2018', '2019', '201a', '201c', '201d', '201e', '2026'])
    for (const cp of clash) {
      expect(cjk.get(cp)).toEqual(['cjk-sym'])
      // Carlito 一侧只能是核心片：扩展片（可能晚于标点片下载完）一旦也声明这些码位，就会盖掉中文字体的引号
      expect((latin.get(cp) ?? []).every((id) => id.startsWith('latin-core')), `U+${cp.toString(16)} 被扩展片声明了`).toBe(true)
    }
  })

  it('每个片编号都对应磁盘上真实的 woff2 文件（文件头 wOF2），没有多余的汉字片', () => {
    const files = readdirSync(GEN).filter((name: string) => name.endsWith('.woff2'))
    const expected = [
      ...['latin-core', 'latin-ext'].flatMap((kind) => ['regular', 'bold'].map((style) => `${kind}-${style}`)),
      'cjk-sym',
      'cjk-kana',
      ...Array.from({ length: HAN_SLICE_COUNT }, (_, i) => `cjk-han-${String(i).padStart(2, '0')}`),
    ]
    expect(files.map((name: string) => name.replace('.woff2', '')).sort()).toEqual(expected.sort())
    for (const name of files) expect(String.fromCharCode(...readFileSync(resolve(GEN, name)).subarray(0, 4)), name).toBe('wOF2')
  })
})

describe('slicesFor：哪些字要哪些片', () => {
  it('纯 ASCII / Latin-1 / 拉丁扩展 A / 常用标点：全在打开就加载的核心片里，不需要额外的片', () => {
    expect(slicesFor('Quarterly review 12% — café Łódź “quoted” … → ©')).toEqual([])
    expect(slicesFor('')).toEqual([])
  })

  it('有中文：汉字片 + 中文标点片；弯引号单独出现（没有中文）不触发中文标点片', () => {
    expect(slicesFor('产品路线图')).toEqual(expect.arrayContaining(['cjk-sym']))
    expect(slicesFor('产品路线图').filter((id) => id.startsWith('cjk-han'))).not.toHaveLength(0)
    expect(slicesFor('“hello”')).toEqual([])
    expect(slicesFor('“你好”')).toContain('cjk-sym')
  })

  it('全角标点、假名各有归属；不在 GB2312 里的生僻字没有汉字片（和原来一样画不出来），但标点片照常带上', () => {
    expect(slicesFor('，。！')).toEqual(['cjk-sym'])
    expect(slicesFor('こんにちは')).toEqual(['cjk-kana', 'cjk-sym'])
    const rare = slicesFor('镕')
    expect(rare.filter((id) => id.startsWith('cjk-han'))).toEqual([])
    expect(rare).toContain('cjk-sym')
  })

  it('希腊 / 西里尔 / 越南文落在拉丁扩展片（常规 + 粗体）；表情符号等两边都没有的字不加载任何东西', () => {
    expect(slicesFor('Привет')).toEqual(['latin-ext-bold', 'latin-ext-regular'])
    expect(slicesFor('Ελληνικά')).toEqual(['latin-ext-bold', 'latin-ext-regular'])
    expect(slicesFor('Tiếng Việt')).toEqual(['latin-ext-bold', 'latin-ext-regular'])
    expect(slicesFor('😀')).toEqual([])
  })

  it('结果有序且不重复，同一片只出现一次', () => {
    const ids = slicesFor('的的的的产品产品')
    expect(ids).toEqual([...new Set(ids)].sort())
  })
})

/* ---------------- GlyphFaces ---------------- */

interface Added {
  family: string
  id: string
  descriptors: FontFaceDescriptors
}

/** 假依赖：fetchBytes 按 url 返回带标记的字节，可控制每个下载何时完成 / 是否失败 */
function fakeDeps(options: { fail?: (url: string) => boolean; delay?: (url: string) => Promise<void> } = {}) {
  const fetched: string[] = []
  const added: Added[] = []
  const deps: GlyphDeps = {
    async fetchBytes(url) {
      fetched.push(url)
      await options.delay?.(url)
      if (options.fail?.(url)) throw new Error('boom')
      return new TextEncoder().encode(url).buffer as ArrayBuffer
    },
    async addFace(family, bytes, descriptors) {
      added.push({ family, id: new TextDecoder().decode(bytes), descriptors })
    },
  }
  return { deps, fetched, added }
}

describe('GlyphFaces', () => {
  it('同一片只下载登记一次（并发、重复调用都一样）；登记时带上权重和精确的 unicode-range', async () => {
    const { deps, fetched, added } = fakeDeps()
    const glyphs = new GlyphFaces(deps)
    await Promise.all([glyphs.ensureText('的'), glyphs.ensureText('的的'), glyphs.ensureText('的')])
    await glyphs.ensureText('的')
    // 汉字片 + 中文标点片 + 标点片依赖的两个拉丁核心片；每个只下载一次
    expect(fetched).toHaveLength(4)
    expect(new Set(fetched).size).toBe(4)
    expect(added.map((item) => item.family)).toEqual(['Calibri', 'Calibri', 'Calibri', 'Calibri'])
    const han = added.find((item) => item.descriptors.unicodeRange?.includes('U+4E00') ?? false)
    expect(han?.descriptors.weight).toBe('400')
    expect(codesOf(han!.descriptors.unicodeRange!).size).toBe(HAN_HEAD)
  })

  it('拉丁粗体片用 700 权重，常规用 400', async () => {
    const { deps, added } = fakeDeps()
    await new GlyphFaces(deps).ensureCore()
    expect(added.map((item) => item.descriptors.weight).sort()).toEqual(['400', '700'])
  })

  it('中文标点片一定在拉丁常用片之后登记（两者都带弯引号，后登记的优先），哪怕它先下载完', async () => {
    const releases = new Map<string, () => void>()
    const { deps, added } = fakeDeps({
      delay: (url) => (url.includes('latin-core') ? new Promise<void>((resolveDelay) => releases.set(url, resolveDelay)) : Promise.resolve()),
    })
    const glyphs = new GlyphFaces(deps)
    const loading = glyphs.ensureText('你好，')
    // 中文片很快就下完了，但核心片还没下完：标点片不能先登记
    await new Promise((done) => setTimeout(done, 20))
    expect(added.filter((item) => item.descriptors.unicodeRange?.includes('U+3000'))).toHaveLength(0)
    for (const release of releases.values()) release()
    await loading
    const order = added.map((item) => (item.descriptors.unicodeRange === unicodeRangeOf('cjk-sym') ? 'sym' : item.descriptors.weight === '700' || item.descriptors.unicodeRange === unicodeRangeOf('latin-core-regular') ? 'core' : 'han'))
    expect(order.indexOf('sym')).toBeGreaterThan(order.lastIndexOf('core'))
  })

  it('下载失败：不抛错、记入 failures，不缓存失败；下次用到时重试，成功后清除记录', async () => {
    let broken = true
    const { deps, fetched } = fakeDeps({ fail: (url) => broken && url.includes('cjk-han-00') })
    const glyphs = new GlyphFaces(deps)
    await expect(glyphs.ensureText('的')).resolves.toBeUndefined()
    expect([...glyphs.failures]).toEqual(['cjk-han-00'])
    broken = false
    await glyphs.ensureText('的')
    expect(glyphs.failures.size).toBe(0)
    expect(fetched.filter((url) => url.includes('cjk-han-00'))).toHaveLength(2)
  })

  it('登记（FontFace.load）失败同样按失败处理，不影响其它片', async () => {
    const { deps } = fakeDeps()
    const addFace = deps.addFace
    deps.addFace = async (family, bytes, descriptors) => {
      if (descriptors.unicodeRange === unicodeRangeOf('cjk-kana')) throw new Error('bad font')
      await addFace(family, bytes, descriptors)
    }
    const glyphs = new GlyphFaces(deps)
    await glyphs.ensureText('こんにちは')
    expect([...glyphs.failures]).toEqual(['cjk-kana'])
  })

  it('核心片编号与清单一致', () => {
    expect([...CORE_SLICES]).toEqual(['latin-core-regular', 'latin-core-bold'])
  })
})
