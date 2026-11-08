// Word 编辑面（`@betteroffice/docx` 引擎）的字体提供器（只提供随站点精选的一小组字体）。
//
// 引擎在浏览器里读不到系统字体，排版和画字都要调用方给字体字节。上游 `@betteroffice/fonts` 的做法是整包提供：
// 80 个拉丁字体（14.7 MB）加 5 个完整 CJK OTF（宋体 → Noto Serif SC 11.6 MB、微软雅黑 → Noto Sans SC 8.3 MB、
// 日文 4.5 MB、繁体 5.4 MB、韩文 4.4 MB），全部进 dist 会让字体总量到 57 MB、二进制胖几十兆。
// 所以这里只用上游的「族名 → 度量兼容字体」解析函数，字节由本文件从下面精选的文件里取：
//
// - 中文：简体 / 日文区域的脚本兜底，以及映射到这两个区域的中文族名（宋体 / 黑体 / 微软雅黑 / MS 明朝 …），
//   都用 Noto Sans SC 的 GB2312 裁剪版（pptx 也用它的同一批汉字，见 README.md）。
//   字体拆成「核心 + 扩展字形包」（scripts/build-docx-fonts.py），按文档用到的字取包，再拼回完整字体（sparseFont.ts）。
//   裁剪版含 GB2312 的 6763 个汉字和平假名 / 片假名，不含的字（生僻字、繁体独有字、韩文）画不出来。
//   CJK 字形是等宽方块，衬线 / 无衬线换成同一份裁剪版不影响分页，只是字形风格不同。
// - 拉丁：度量兼容 Word 最常用三组字体的常规 / 粗体——Calibri → Carlito、Arial → Liberation Sans、
//   Times New Roman → Liberation Serif，合计约 2.8 MB（dist 字体预算 12 MB 里剩给 Word 拉丁字体的就这么多）。
//   其余没有随站点提供：斜体 / 粗斜体用同族的正体 / 粗体顶上（字宽接近，但字形不倾斜），整个族没有
//   （Cambria、Courier New、Georgia、Segoe UI、Verdana …）就当作「缺失」——`engines/docx/fontReport.ts`
//   用 {@link resolveShippedFamily} / {@link lacksItalic} 判断并明说，不静默替换。
// - 繁体 / 韩文 / 阿拉伯文 / 希伯来文：不提供。文档里用到这些文字时，字形画不出来（显示成空框，文件内容不受影响），
//   `fontReport` 会据此提示（{@link UNAVAILABLE_SCRIPTS}）。
//
// 字体文件原样复制自上游字体包（未改动，保留它们的 OFL / Apache 许可，见仓库根 NOTICE），带内容哈希长期缓存，
// 第一次打开 Word 编辑时才按需下载；上游的字节长度校验（`byteLength`）这里也照做。
import type { BundledFontFace, BundledFontScript, BundledFontSource } from '@betteroffice/fonts'
import { UNAVAILABLE_SCRIPT_LABELS } from '../docx/fontReport'
import { CJK_EXT_MISC_RANGES, CJK_EXT_TIERS, CJK_HAN_CORE, CJK_HAN_TIER, DOCX_FONT_BYTES, LATIN_SPARSE } from './docxFontManifest'
import { HAN_ORDER } from './gen/glyphManifest'
import { assembleFont, toArrayBuffer } from './sparseFont'

/**
 * 随站点提供的字体文件（`gen/docx/*.ttf`，由 scripts/build-docx-fonts.py 生成）的资源地址。
 * 每个字体拆成「核心字体」+「扩展字形包」：核心约 57 KB（拉丁）/ 215 KB（中文），文档用到核心之外的字才下载扩展包，
 * 拼回完整字体后交给引擎（见 sparseFont.ts）。度量表在核心里是完整的，所以排版与完整字体一致，只有轮廓是否到位不同。
 */
const FONT_URLS = import.meta.glob('./gen/docx/*.ttf', { query: '?url', import: 'default', eager: true }) as Record<string, string>

type FontsModule = typeof import('@betteroffice/fonts')
type Script = BundledFontScript

/** 随站点提供的拉丁字体：键是上游清单（BUNDLED_FONTS）里的 `file`，值是 gen/docx 里的字体名（见 docxFontManifest.ts） */
export const SHIPPED_LATIN: Readonly<Record<string, string>> = Object.fromEntries(Object.keys(LATIN_SPARSE).map((stem) => [`${stem}.ttf`, stem]))

/** 这个族有没有随站点提供的斜体面：没有的话斜体文字会用正体顶上，`fontReport` 据此说明 */
export function lacksItalic(fonts: FontsModule, family: string): boolean {
  const bundled = fonts.resolveMetricCompatFamily(family)
  if (!bundled) return false
  return !fonts.BUNDLED_FONTS.some((face) => face.family === bundled && face.style === 'italic' && SHIPPED_LATIN[face.file])
}

/** 裁剪版能覆盖的区域：简体汉字 + 假名 */
export const SUBSET_SCRIPTS: ReadonlySet<Script> = new Set<Script>(['cjk-sc', 'cjk-jp'])

/** 没有随站点提供字体的文字区域：文档用到时字形画不出来，要提示用户 */
export const UNAVAILABLE_SCRIPTS: ReadonlySet<string> = new Set(Object.keys(UNAVAILABLE_SCRIPT_LABELS))

/** 同一个资源只下载一次；失败不缓存，下一次排版重试 */
const downloads = new Map<string, Promise<ArrayBuffer>>()
/** 下载 gen/docx 里的一个字体文件，并核对字节数（对不上说明拿到的不是原文件：被代理改写、缓存损坏） */
function downloadFile(file: string): Promise<ArrayBuffer> {
  const url = FONT_URLS[`./gen/docx/${file}`]
  if (!url) return Promise.reject(new Error(`没有这个字体文件:${file}`))
  let pending = downloads.get(url)
  if (!pending) {
    pending = (async () => {
      const response = await fetch(url, { credentials: 'same-origin' })
      if (!response.ok) throw new Error(`字体 ${file} 下载失败(HTTP ${response.status}):${url}`)
      const bytes = await response.arrayBuffer()
      const expected = DOCX_FONT_BYTES[file]
      if (expected !== undefined && bytes.byteLength !== expected) {
        throw new Error(`字体 ${file} 大小不对(${bytes.byteLength} 字节，应为 ${expected}):${url}`)
      }
      return bytes
    })().catch((error) => {
      downloads.delete(url)
      throw error
    })
    downloads.set(url, pending)
  }
  return pending
}

/**
 * 这次打开的文档需要字体里的哪些字形。
 * - `ready`：文档扫描完成（`chars` 填好）；加载函数都先等它，保证按文档的真实需求取包；
 * - `chars`：文档里用到的码位（只记 ≥ 0x80 的；ASCII 永远在核心里）。null = 不知道（扫描失败）→ 取全部；
 * - `full`：要完整字体（打印 / 缩略图 / 导出的会话；编辑会话在首屏之后的补全也是它）。
 */
export interface FontDemand {
  ready: Promise<void>
  chars: ReadonlySet<number> | null
  full: boolean
}

/** 完整字体：默认的全局提供器（不知道文档内容的场合）用它 */
export const FULL_DEMAND: FontDemand = { ready: Promise.resolve(), chars: null, full: true }

const inRanges = (cp: number, ranges: ReadonlyArray<readonly [number, number]>) => ranges.some(([low, high]) => cp >= low && cp <= high)
const wantsAll = (demand: FontDemand) => demand.full || demand.chars === null

/** 拼好的字体按「字体 + 用到哪些扩展包」缓存：同一个文档的多个族名拿到同一个 ArrayBuffer（引擎按 buffer 身份去重注册） */
const assembled = new Map<string, Promise<ArrayBuffer>>()
function assembledOnce(key: string, build: () => Promise<ArrayBuffer>): Promise<ArrayBuffer> {
  let pending = assembled.get(key)
  if (!pending) {
    pending = build().catch((error) => {
      assembled.delete(key)
      throw error
    })
    assembled.set(key, pending)
  }
  return pending
}

/** 某个拉丁面这次要不要扩展包：文档里有字符落在该面「核心之外」的 cmap 里 */
function latinNeedsExt(demand: FontDemand, stem: string): boolean {
  if (wantsAll(demand)) return true
  const ranges = LATIN_SPARSE[stem]!.extRanges
  for (const cp of demand.chars!) if (inRanges(cp, ranges)) return true
  return false
}

function loadLatin(stem: string, demand: FontDemand): Promise<ArrayBuffer> {
  return demand.ready.then(() => {
    const ext = latinNeedsExt(demand, stem)
    const key = LATIN_SPARSE[stem]!.key
    return assembledOnce(`latin:${stem}:${ext ? 'full' : 'core'}`, async () => {
      const core = await downloadFile(`latin-${key}-core.ttf`)
      if (!ext) return core
      const pack = await downloadFile(`latin-${key}-ext.ttf`)
      return toArrayBuffer(assembleFont(new Uint8Array(core), [new Uint8Array(pack)]))
    })
  })
}

/** 汉字的字频名次（HAN_ORDER 的下标）；第一次用到才建 */
let hanRank: Map<number, number> | null = null
function hanRankOf(cp: number): number | undefined {
  if (!hanRank) {
    hanRank = new Map()
    let rank = 0
    for (const char of HAN_ORDER) hanRank.set(char.codePointAt(0)!, rank++)
  }
  return hanRank.get(cp)
}

const tierName = (tier: number) => String(tier).padStart(2, '0')

/** 这次要的中文扩展包文件名（不含 cjk-ext- 前缀与 .ttf） */
function cjkExtNames(demand: FontDemand): string[] {
  if (wantsAll(demand)) return ['misc', ...Array.from({ length: CJK_EXT_TIERS }, (_, i) => tierName(i + 1))]
  const need = new Set<string>()
  for (const cp of demand.chars!) {
    const rank = hanRankOf(cp)
    if (rank !== undefined) {
      if (rank >= CJK_HAN_CORE) need.add(tierName(1 + Math.floor((rank - CJK_HAN_CORE) / CJK_HAN_TIER)))
    } else if (inRanges(cp, CJK_EXT_MISC_RANGES)) {
      need.add('misc')
    }
  }
  return [...need].sort()
}

/**
 * 中文字体的字节：核心 + 文档用到的汉字所在的扩展包，拼好。
 * 整个页面里同一组扩展包只拼一次；多个族名（宋体 / 微软雅黑 / 脚本兜底）拿到的是**同一个** ArrayBuffer，
 * 引擎按 buffer 身份去重注册，换成每次新拷贝会让同一份 2 MB 字体在 WASM 里登记好几遍。
 */
export function loadSubsetBytes(demand: FontDemand = FULL_DEMAND): Promise<ArrayBuffer> {
  return demand.ready.then(() => {
    const names = cjkExtNames(demand)
    return assembledOnce(`cjk:${names.join(',')}`, async () => {
      const [core, ...packs] = await Promise.all([downloadFile('cjk-core.ttf'), ...names.map((name) => downloadFile(`cjk-ext-${name}.ttf`))])
      if (!packs.length) return core!
      return toArrayBuffer(assembleFont(new Uint8Array(core!), packs.map((pack) => new Uint8Array(pack))))
    })
  })
}

/**
 * 想要的这一面没有随站点提供时，退到同族里最接近的一面：
 * 同字重的正体（粗斜体 → 粗体）→ 常规体。同族的其它面都没有就返回 undefined。
 */
function shippedFaceOf(fonts: FontsModule, face: BundledFontFace): BundledFontFace | undefined {
  if (SHIPPED_LATIN[face.file]) return face
  const sameFamily = fonts.BUNDLED_FONTS.filter((candidate) => candidate.family === face.family && SHIPPED_LATIN[candidate.file])
  return (
    sameFamily.find((candidate) => candidate.weight === face.weight && candidate.style === 'normal') ??
    sameFamily.find((candidate) => candidate.weight === 400 && candidate.style === 'normal')
  )
}

function loaderOf(face: BundledFontFace, demand: FontDemand): () => Promise<ArrayBuffer> {
  return () => loadLatin(SHIPPED_LATIN[face.file]!, demand)
}

/** 族名解析出来的拉丁面里，真有字体随站点提供的才算；CJK 面按区域看裁剪版是否覆盖 */
function loaderForFace(fonts: FontsModule, face: BundledFontFace | undefined, demand: FontDemand): (() => Promise<ArrayBuffer>) | undefined {
  if (!face) return undefined
  if (face.script) return SUBSET_SCRIPTS.has(face.script) ? () => loadSubsetBytes(demand) : undefined
  const shipped = shippedFaceOf(fonts, face)
  return shipped ? loaderOf(shipped, demand) : undefined
}

/**
 * 站点自己的提供器：形状与上游 `createFontProvider` 的结果相同（引擎只认这个结构），
 * 解析逻辑（族名别名、粗斜体、最后兜底选哪一族）全部用上游的函数，只是字节来自随站点提供的那一小组文件。
 */
/**
 * 整个族都没有随站点提供（或上游根本不认识）时，实际拿来画的兜底字体面：
 * 上游为 Word 选的兜底族（非衬线 → Arial，衬线 → Times New Roman）随站点提供就用它；
 * 它自己没提供（Liberation Mono、Gelasio …）时，衬线的退到 Liberation Serif、其余退到 Liberation Sans，最后是 Carlito。
 * 提供器的 `resolveLastResort` 与 {@link fallbackFamilyFor}（缺失字体提示里写的「改用 … 显示」）都用它，所以提示说的就是实际画的。
 */
function lastResortFaceOf(fonts: FontsModule, family: string, bold: boolean, italic: boolean, office: 'powerpoint' | 'word' | undefined, demand: FontDemand) {
  const choice = fonts.resolveLastResortChoice(family, bold, italic, office)
  const candidates = [
    choice.face,
    fonts.resolveMetricCompatFace(choice.face.family === 'Gelasio' ? 'Times New Roman' : 'Arial', bold, italic),
    fonts.resolveMetricCompatFace('Calibri', bold, italic),
  ]
  for (const candidate of candidates) {
    const loader = loaderForFace(fonts, candidate, demand)
    if (loader) return { choice, loader, face: candidate! }
  }
  return null
}

/** 缺失字体提示里「改用 … 显示」的那个族名：和 {@link createShippedProvider} 的兜底选择一致 */
export function fallbackFamilyFor(fonts: FontsModule, family: string): string {
  return lastResortFaceOf(fonts, family, false, false, 'word', FULL_DEMAND)?.face.family ?? 'Carlito'
}

export function createShippedProvider(fonts: FontsModule, demand: FontDemand = FULL_DEMAND): BundledFontSource {
  return {
    resolve: (family, bold, italic) => loaderForFace(fonts, fonts.resolveMetricCompatFace(family, bold, italic), demand),
    resolveFamily: (family, bold, italic) => loaderForFace(fonts, fonts.resolveBundledFamilyFace(family, bold, italic), demand),
    resolveScriptFallback: (script) => (SUBSET_SCRIPTS.has(script) ? () => loadSubsetBytes(demand) : undefined),
    // 上游只有 Selawik（Segoe UI 的兼容字体）需要字形兜底，它没有随站点提供
    resolveGlyphFallback: () => undefined,
    resolveLastResort: (family, bold, italic, office) => {
      // 总要有一个字体可画，不能让引擎拿不到任何字节
      const picked = lastResortFaceOf(fonts, family, bold, italic, office, demand)
      if (picked) return picked.choice.onlyIfPrimaryFails ? Object.assign(picked.loader, { onlyIfPrimaryFails: true as const }) : picked.loader
      // 理论上走不到（Carlito 常规一定随站点提供）；保险起见明确报错而不是返回 undefined
      return () => Promise.reject(new Error(`没有可用的兜底字体:${family}`))
    },
  }
}

/**
 * 某个 Word 族名有没有随站点提供的度量兼容字体（`engines/docx/fontReport.ts` 的 `resolve` 注入用它）：
 * - 拉丁族：只有至少一面随站点提供才算（Courier New → Liberation Mono 没有，所以不算）；
 * - CJK 族：简体 / 日文区域算（返回上游给的 Noto 族名，由 fontReport 归为「近似」），繁体 / 韩文不算。
 */
export function resolveShippedFamily(fonts: FontsModule, family: string): string | undefined {
  const bundled = fonts.resolveMetricCompatFamily(family)
  if (!bundled) return undefined
  const faces = fonts.BUNDLED_FONTS.filter((candidate) => candidate.family === bundled)
  if (faces.some((face) => face.script)) return faces.some((face) => face.script && SUBSET_SCRIPTS.has(face.script)) ? bundled : undefined
  return faces.some((face) => SHIPPED_LATIN[face.file]) ? bundled : undefined
}

/**
 * 交给 `configureDefaultFonts({ load })` 的模块：形状与 `@betteroffice/fonts` 相同（只用到 `createFontProvider`）。
 * 上游字体包只在用到时才动态加载，不进 Word 编辑器之外的任何 chunk；它的资源表已在构建时清空（见 vite.config.ts）。
 */
export async function createDocxFontModule(): Promise<{ createFontProvider: FontsModule['createFontProvider'] }> {
  const fonts = await import('@betteroffice/fonts')
  return { createFontProvider: () => createShippedProvider(fonts) }
}

/** 上游字体包的模块，给 docx.ts 按每个会话的文档需求建自己的提供器用 */
export async function loadFontsModule(): Promise<FontsModule> {
  return import('@betteroffice/fonts')
}
