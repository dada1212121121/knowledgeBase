// Word 编辑面字体提供器（只提供随站点精选的一小组字体）：
// 简体 / 日文走 GB2312 裁剪版，精选的拉丁字体按需下载并校验长度，没提供的字体明确返回「没有」而不是静默替换；
// 每个资源只下一次、失败不缓存。
// Word 编辑面字体提供器（只提供随站点精选的一小组字体）：
// 简体 / 日文走 GB2312 裁剪版，精选的拉丁字体按需下载并校验长度，没提供的字体明确返回「没有」而不是静默替换；
// 每个资源只下一次、失败不缓存。每个字体拆成「核心 + 扩展字形包」，按文档用到的字形决定下载哪些（下面「按文档需求」一节）。
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn()
const GEN = `${import.meta.dirname}/gen/docx`

/** 用仓库里真实生成的字体文件回答请求（拼装要解析 sfnt，假字节过不了）；`wrongSize` 里的文件少给一个字节 */
let wrongSize = new Set<string>()
function respond(url: string) {
  const file = String(url).split('/').pop()!.split('?')[0]!
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(readFileSync(`${GEN}/${file}`))
  } catch {
    return Promise.resolve(new Response('not found', { status: 404 }))
  }
  return Promise.resolve(new Response((wrongSize.has(file) ? bytes.subarray(1) : bytes) as unknown as BodyInit, { status: 200 }))
}
const fetched = () => fetchMock.mock.calls.map((call) => String(call[0]).split('/').pop()!.split('?')[0]!)

beforeEach(() => {
  vi.resetModules()
  wrongSize = new Set()
  fetchMock.mockReset().mockImplementation((url: string) => respond(url))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

async function setup() {
  const docxFonts = await import('./docxFonts')
  const fonts = await import('@betteroffice/fonts')
  const module = await docxFonts.createDocxFontModule()
  return { docxFonts, fonts, provider: module.createFontProvider() }
}

/** 一份文档的字形需求：codepoints 是文档里 ≥ 0x80 的码位 */
const demandOf = (text: string, full = false) => ({
  ready: Promise.resolve(),
  chars: new Set([...text].map((char) => char.codePointAt(0)!).filter((cp) => cp >= 0x80)),
  full,
})

describe('Word 编辑器字体提供器：中文', () => {
  it('简体与日文区域的脚本兜底都给裁剪版，繁体 / 韩文 / 阿拉伯文 / 希伯来文没有字体（不再拉上游的完整 CJK 字体）', async () => {
    const { docxFonts, provider } = await setup()
    expect(provider.resolveScriptFallback('cjk-sc', false, false)).toBeTypeOf('function')
    expect(provider.resolveScriptFallback('cjk-jp', false, false)).toBeTypeOf('function')
    for (const script of ['cjk-tc', 'cjk-kr', 'arabic', 'hebrew'] as const) {
      expect(provider.resolveScriptFallback(script, false, false), script).toBeUndefined()
      expect(docxFonts.UNAVAILABLE_SCRIPTS.has(script), script).toBe(true)
    }
  })

  it('映射到简体 / 日文字体的中文族名（宋体、微软雅黑、MS 明朝）走裁剪版；映射到繁体 / 韩文的（新细明体、Malgun Gothic）没有', async () => {
    const { provider } = await setup()
    for (const family of ['SimSun', '宋体', 'Microsoft YaHei', '微软雅黑', 'MS Gothic', 'ＭＳ 明朝']) {
      expect(provider.resolve(family, false, false), family).toBeTypeOf('function')
      expect(provider.resolveFamily(family, false, false), family).toBeTypeOf('function')
    }
    for (const family of ['PMingLiU', 'Malgun Gothic']) expect(provider.resolve(family, false, false), family).toBeUndefined()
  })

  it('裁剪版每个文件只下载一次，多个族名拿到同一个 ArrayBuffer（引擎按 buffer 去重注册）', async () => {
    const { provider } = await setup()
    const first = await provider.resolve('SimSun', false, false)!()
    const second = await provider.resolveScriptFallback('cjk-sc', false, false)!()
    expect(second).toBe(first)
    const files = fetched().filter((file) => file.startsWith('cjk-'))
    expect(new Set(files).size).toBe(files.length)
    expect(files).toContain('cjk-core.ttf')
  })

  it('下载失败要报错，并且不缓存失败，重试能成功', async () => {
    const { provider } = await setup()
    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response('', { status: 503 })))
    const loader = provider.resolveScriptFallback('cjk-sc', false, false)!
    await expect(loader()).rejects.toThrow(/503/)
    await expect(loader()).resolves.toBeInstanceOf(ArrayBuffer)
  })

  it('下载到的文件大小不对（被代理改写、缓存损坏）：报错，不把坏字体交给引擎', async () => {
    const { provider } = await setup()
    wrongSize = new Set(['cjk-core.ttf'])
    await expect(provider.resolveScriptFallback('cjk-sc', false, false)!()).rejects.toThrow(/大小不对/)
  })
})

describe('Word 编辑器字体提供器：拉丁', () => {
  it('精选的字体：Calibri / Arial / Times New Roman 的常规与粗体都有，下载前校验字节长度', async () => {
    const { provider } = await setup()
    for (const family of ['Calibri', 'Arial', 'Times New Roman']) {
      for (const bold of [false, true]) expect(provider.resolve(family, bold, false), `${family} ${bold}`).toBeTypeOf('function')
    }
    await expect(provider.resolve('Calibri', false, false)!()).resolves.toBeInstanceOf(ArrayBuffer)
    // 长度对不上：报错
    wrongSize = new Set(['latin-carlito-bold-core.ttf'])
    await expect(provider.resolve('Calibri', true, false)!()).rejects.toThrow(/大小不对/)
  })

  it('同一个字体文件只下载一次，换族名别名也一样', async () => {
    const { provider } = await setup()
    await provider.resolve('Arial', false, false)!()
    await provider.resolve('Helvetica', false, false)?.()
    await provider.resolveFamily('Liberation Sans', false, false)!()
    expect(fetched().filter((file) => file === 'latin-liberationsans-regular-core.ttf')).toHaveLength(1)
  })

  it('没有随站点提供的面，退到同族里最接近的一面：Calibri 斜体 → 常规、粗斜体 → 粗体；Arial 斜体 → 常规；Arial 粗斜体 → 粗体', async () => {
    const { provider } = await setup()
    await provider.resolve('Calibri', false, true)!()
    await provider.resolve('Calibri', true, true)!()
    await provider.resolve('Arial', false, true)!()
    await provider.resolve('Arial', true, true)!()
    const files = fetched()
    for (const file of ['latin-carlito-regular-core.ttf', 'latin-carlito-bold-core.ttf', 'latin-liberationsans-regular-core.ttf', 'latin-liberationsans-bold-core.ttf']) {
      expect(files, file).toContain(file)
    }
  })

  it('整个族都没有随站点提供的（Cambria、Courier New、Georgia、Segoe UI、Verdana）：resolve 返回 undefined，不静默拿别的字体顶', async () => {
    const { provider } = await setup()
    for (const family of ['Cambria', 'Courier New', 'Georgia', 'Segoe UI', 'Verdana', 'Comic Sans MS']) {
      expect(provider.resolve(family, false, false), family).toBeUndefined()
    }
  })

  it('兜底链：任意族名都能拿到一个有字节的拉丁底字；上游选了没提供的族（等宽、Georgia）时退到 Liberation Sans / Serif', async () => {
    const { provider } = await setup()
    for (const family of ['宋体', 'Consolas', 'Georgia', 'Some Unknown Font']) {
      const loader = provider.resolveLastResort(family, false, false, 'word')
      await expect(loader(), family).resolves.toBeInstanceOf(ArrayBuffer)
    }
    const files = fetched()
    expect(files).toContain('latin-liberationsans-regular-core.ttf')
    expect(files).toContain('latin-liberationserif-regular-core.ttf')
  })

  it('缺失字体提示里写的「改用 …」就是实际画的族：衬线的 Liberation Serif，其余 Liberation Sans', async () => {
    const { docxFonts, fonts } = await setup()
    const rendersAs = (family: string) => docxFonts.fallbackFamilyFor(fonts, family)
    for (const family of ['Cambria', 'Georgia']) expect(rendersAs(family), family).toBe('Liberation Serif')
    for (const family of ['Courier New', 'Consolas', 'Verdana', 'Segoe UI', 'Some Unknown Font']) expect(rendersAs(family), family).toBe('Liberation Sans')
  })

  it('字形兜底（Selawik 专用）不提供', async () => {
    const { provider } = await setup()
    expect(provider.resolveGlyphFallback?.('Segoe UI', false, false, 'word')).toBeUndefined()
  })
})

describe('字体包与字频顺序的一致性', () => {
  it('汉字扩展包是按 HAN_ORDER 切的：HAN_ORDER 变了必须重新跑 scripts/build-docx-fonts.py', async () => {
    const { HAN_ORDER } = await import('./gen/glyphManifest')
    const { CJK_HAN_ORDER_SHA256 } = await import('./docxFontManifest')
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(HAN_ORDER))
    expect([...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')).toBe(CJK_HAN_ORDER_SHA256)
  })
})

describe('按文档需求取字形：核心 + 用到的扩展包', () => {
  it('纯拉丁文档（核心字符 + 中文，中文不在拉丁字体里）：拉丁面只下核心字体，不下扩展包', async () => {
    const { docxFonts, fonts } = await setup()
    const provider = docxFonts.createShippedProvider(fonts, demandOf('Hello, world — “quoted” café 你好'))
    await provider.resolve('Calibri', false, false)!()
    await provider.resolve('Arial', true, false)!()
    const files = fetched()
    expect(files).toContain('latin-carlito-regular-core.ttf')
    expect(files.filter((file) => file.includes('-ext'))).toEqual([])
  })

  it('文档里有核心之外的拉丁字符（西里尔字母）：该面才下扩展包，拼成的字体里带上了这些字形', async () => {
    const { docxFonts, fonts } = await setup()
    const provider = docxFonts.createShippedProvider(fonts, demandOf('Привет'))
    const bytes = new Uint8Array(await provider.resolve('Calibri', false, false)!())
    expect(fetched()).toContain('latin-carlito-regular-ext.ttf')
    const core = new Uint8Array(readFileSync(`${GEN}/latin-carlito-regular-core.ttf`))
    expect(bytes.byteLength).toBeGreaterThan(core.byteLength)
  })

  it('中文：只下载文档用到的汉字所在的扩展包（常用字都在核心里，不下任何扩展包）', async () => {
    const { docxFonts, fonts } = await setup()
    const provider = docxFonts.createShippedProvider(fonts, demandOf('的一是不了人我在有他这中大来上国个到说们为子和你地出道也时年得就那要下以生会自着去之过家学对可她里后小么心多天而能好都然没日于起还发成事只作当想看文无开手十用主行方又如前所本见经头面公同三已老从动两长知民样现分将外但身些与高意进把法此实回二理美点月明其种声全工已'))
    await provider.resolveScriptFallback('cjk-sc', false, false)!()
    const files = fetched().filter((file) => file.startsWith('cjk-'))
    expect(files).toEqual(['cjk-core.ttf'])
  })

  it('中文：生僻一点的字落在哪一包就下哪一包；标点 / 假名之外的符号走「其它」包', async () => {
    const { docxFonts, fonts, } = await setup()
    const { HAN_ORDER } = await import('./gen/glyphManifest')
    // 字频名次 1500 的汉字在第 1 包（1024..1663），名次 3000 的在第 4 包（2944..3583）
    const text = `${HAN_ORDER[1500]}${HAN_ORDER[3000]}`
    const provider = docxFonts.createShippedProvider(fonts, demandOf(text))
    await provider.resolveScriptFallback('cjk-sc', false, false)!()
    expect(fetched().filter((file) => file.startsWith('cjk-')).sort()).toEqual(['cjk-core.ttf', 'cjk-ext-01.ttf', 'cjk-ext-04.ttf'])
  })

  it('扫描失败（chars 为 null）或要完整字体：什么都下载，不冒险', async () => {
    const { docxFonts, fonts } = await setup()
    const unknown = docxFonts.createShippedProvider(fonts, { ready: Promise.resolve(), chars: null, full: false })
    await unknown.resolve('Calibri', false, false)!()
    expect(fetched()).toContain('latin-carlito-regular-ext.ttf')
    const full = docxFonts.createShippedProvider(fonts, demandOf('abc', true))
    await full.resolve('Arial', false, false)!()
    expect(fetched()).toContain('latin-liberationsans-regular-ext.ttf')
  })

  it('加载函数先等文档扫描完（demand.ready），再按扫描结果取包', async () => {
    const { docxFonts, fonts } = await setup()
    let finish!: () => void
    const demand = { ready: new Promise<void>((resolve) => (finish = resolve)), chars: null as ReadonlySet<number> | null, full: false }
    const provider = docxFonts.createShippedProvider(fonts, demand)
    const pending = provider.resolve('Calibri', false, false)!()
    await Promise.resolve()
    expect(fetchMock).not.toHaveBeenCalled()
    demand.chars = new Set([0x4e2d])
    finish()
    await pending
    expect(fetched().filter((file) => file.includes('-ext'))).toEqual([])
  })

  it('补全：demand.full 翻成 true 之后，同一个加载函数给出带全部字形的新字体（新的 ArrayBuffer）', async () => {
    const { docxFonts, fonts } = await setup()
    const demand = demandOf('Hello')
    const provider = docxFonts.createShippedProvider(fonts, demand)
    const loader = provider.resolve('Calibri', false, false)!
    const first = await loader()
    demand.full = true
    const second = await loader()
    expect(second).not.toBe(first)
    expect(second.byteLength).toBeGreaterThan(first.byteLength)
    // 之后仍是同一个缓存的拼装结果
    expect(await loader()).toBe(second)
  })
})

describe('resolveShippedFamily：哪些 Word 字体有随站点提供的度量兼容字体', () => {
  it('随站点提供的拉丁族有；没提供的（等宽 / Georgia / Segoe UI）没有；简体 / 日文的 CJK 族有，繁体 / 韩文没有', async () => {
    const { docxFonts, fonts } = await setup()
    const has = (family: string) => docxFonts.resolveShippedFamily(fonts, family)
    expect(has('Calibri')).toBe('Carlito')
    expect(has('Arial')).toBe('Liberation Sans')
    expect(has('Times New Roman')).toBe('Liberation Serif')
    for (const family of ['Cambria', 'Courier New', 'Georgia', 'Segoe UI', 'Comic Sans MS']) expect(has(family), family).toBeUndefined()
    for (const family of ['宋体', '微软雅黑', 'MS Gothic']) expect(has(family), family).toBeTypeOf('string')
    for (const family of ['PMingLiU', 'Malgun Gothic']) expect(has(family), family).toBeUndefined()
    // 上游根本不认识的
    expect(has('Verdana')).toBeUndefined()
  })
})
