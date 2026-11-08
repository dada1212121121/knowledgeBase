/**
 * 幻灯片画布用的浏览器字形：按文档里实际出现的字按需加载（冷开优化）
 *
 * 为什么：画布文字是 `fillText` 画的，字形来自浏览器里登记的 FontFace；引擎排版只用字宽（见 fonts.ts 的度量字体）。
 * 所以浏览器这边只需要「这份文档里出现过的字」的字形。原来一次下载整套 Noto Sans SC（GB2312，1185 KB brotli）
 * 加两份完整 Carlito（422 KB），占冷开传输的近一半。现在拆成片（切法与理由见 scripts/build-office-fonts.py）：
 *
 * - `latin-core-*`：常用拉丁字符，打开就加载；`latin-ext-*`：希腊 / 西里尔 / 越南文等，文档里出现了才加载；
 * - `cjk-han-NN`：汉字，按字频排队，第 0 片是最常用的 1024 个，其后每 128 个一片；
 * - `cjk-sym`：中文标点 / 全角；`cjk-kana`：假名。
 *
 * 每个 FontFace 的 unicode-range 严格等于该片实际带有的字：没加载的字不会被误认成「已有字体但没有字形」而画成空框。
 * 加载永不抛错（字体加载失败不该让整页画不出来）：失败的片记在 `failures` 里供界面提示，下次用到时再试。
 */
import {
  CJK_KANA_RANGE,
  CJK_SYM_RANGE,
  HAN_HEAD,
  HAN_ORDER,
  HAN_SLICE_COUNT,
  HAN_TAIL,
  LATIN_CORE_RANGE,
  LATIN_EXT_RANGE,
  LATIN_FULL_RANGE,
} from './gen/glyphManifest'

/** 片的编号：`latin-core-regular` / `latin-ext-bold` / `cjk-sym` / `cjk-kana` / `cjk-han-07` … */
export type SliceId = string

/** 与引擎里登记的族名一致（见 fonts.ts 的 NATIVE_FONT_FAMILIES）；画布按这个族名取浏览器字体 */
const FAMILIES = ['Calibri'] as const

const urls = import.meta.glob('./gen/*.woff2', { query: '?url', import: 'default', eager: true }) as Record<string, string>

function urlOf(id: SliceId): string {
  const url = urls[`./gen/${id}.woff2`]
  if (!url) throw new Error(`没有字体片 ${id}`)
  return url
}

/* ---------------- 码位归类（纯函数，可单测） ---------------- */

/** 把清单里 `U+20-7E, U+A0` 这样的文本解析成区间 */
function parseRanges(text: string): Array<[number, number]> {
  return text
    .split(',')
    .map((part) => part.trim().replace(/^U\+/i, ''))
    .filter(Boolean)
    .map((part): [number, number] => {
      const [from, to] = part.split('-')
      const start = parseInt(from!, 16)
      return [start, to ? parseInt(to, 16) : start]
    })
}

function inRanges(ranges: ReadonlyArray<[number, number]>, cp: number): boolean {
  // 区间是升序且不重叠的：二分
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const [from, to] = ranges[mid]!
    if (cp < from) high = mid - 1
    else if (cp > to) low = mid + 1
    else return true
  }
  return false
}

const CORE = parseRanges(LATIN_CORE_RANGE)
const EXT = parseRanges(LATIN_EXT_RANGE)
const KANA = parseRanges(CJK_KANA_RANGE)

let hanIndex: Map<number, number> | null = null
function hanIndexOf(cp: number): number | undefined {
  if (!hanIndex) {
    hanIndex = new Map()
    let at = 0
    for (const ch of HAN_ORDER) hanIndex.set(ch.codePointAt(0)!, at++)
  }
  return hanIndex.get(cp)
}

const hanSliceId = (slice: number): SliceId => `cjk-han-${String(slice).padStart(2, '0')}`

/** 与 pptxModel.ts 的 CJK 判断同一批码位：有这些字，中文标点那一片（含引号 / 省略号的中文写法）就一起加载 */
const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u3000-\u303F]/u

/** 必须在第一次画之前就绪的片：常用拉丁字符 */
export const CORE_SLICES: readonly SliceId[] = ['latin-core-regular', 'latin-core-bold']

/**
 * 画这段文字需要加载哪些片（不含 {@link CORE_SLICES}）。
 *
 * - 汉字落在它的字频片里；不在 GB2312 里的生僻字没有片（和原来一样画不出来，走系统字体兜底）；
 * - 有任何中文字符就带上标点片：原来的中文字体接管了弯引号 / 省略号，这里保持一致；
 * - 不在拉丁常用集、也不是中文的字符，落在 `latin-ext`（常规 + 粗体都取，运行时不知道哪些字是粗体的）；
 *   两边都没有的字符（表情符号等）不加载任何东西，由浏览器的系统字体兜底。
 */
export function slicesFor(text: string): SliceId[] {
  const wanted = new Set<SliceId>()
  let cjk = false
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp < 0x80) continue
    if (cp >= 0x4e00 && cp <= 0x9fff) {
      cjk = true
      const index = hanIndexOf(cp)
      if (index !== undefined) wanted.add(hanSliceId(index < HAN_HEAD ? 0 : 1 + Math.floor((index - HAN_HEAD) / HAN_TAIL)))
    } else if (inRanges(KANA, cp)) {
      cjk = true
      wanted.add('cjk-kana')
    } else if (CJK.test(ch)) {
      cjk = true
    } else if (!inRanges(CORE, cp) && inRanges(EXT, cp)) {
      wanted.add('latin-ext-regular')
      wanted.add('latin-ext-bold')
    }
  }
  if (cjk) wanted.add('cjk-sym')
  return [...wanted].sort()
}

/** 一片的 unicode-range：汉字片按它的字生成，其余用清单里的固定范围 */
export function unicodeRangeOf(id: SliceId): string {
  if (id.startsWith('latin-core')) return LATIN_CORE_RANGE
  if (id.startsWith('latin-ext')) return LATIN_FULL_RANGE
  if (id === 'cjk-sym') return CJK_SYM_RANGE
  if (id === 'cjk-kana') return CJK_KANA_RANGE
  const slice = Number(id.slice('cjk-han-'.length))
  if (!Number.isInteger(slice) || slice < 0 || slice >= HAN_SLICE_COUNT) throw new Error(`没有字体片 ${id}`)
  const from = slice === 0 ? 0 : HAN_HEAD + (slice - 1) * HAN_TAIL
  const to = slice === 0 ? HAN_HEAD : Math.min(from + HAN_TAIL, HAN_ORDER.length)
  const codes = [...HAN_ORDER.slice(from, to)].map((ch) => ch.codePointAt(0)!).sort((a, b) => a - b)
  const runs: string[] = []
  for (let at = 0; at < codes.length; ) {
    let end = at
    while (end + 1 < codes.length && codes[end + 1] === codes[end]! + 1) end += 1
    runs.push(end === at ? `U+${codes[at]!.toString(16).toUpperCase()}` : `U+${codes[at]!.toString(16).toUpperCase()}-${codes[end]!.toString(16).toUpperCase()}`)
    at = end + 1
  }
  return runs.join(', ')
}

const weightOf = (id: SliceId): string => (id.endsWith('-bold') ? '700' : '400')

/* ---------------- 加载 ---------------- */

export interface GlyphDeps {
  fetchBytes(url: string): Promise<ArrayBuffer>
  /** 把字节登记成浏览器字体（完成后画布就能用） */
  addFace(family: string, bytes: ArrayBuffer, descriptors: FontFaceDescriptors): Promise<void>
}

function browserDeps(): GlyphDeps {
  return {
    async fetchBytes(url) {
      const response = await fetch(url, { credentials: 'same-origin' })
      if (!response.ok) throw new Error(`字体下载失败(HTTP ${response.status})`)
      return response.arrayBuffer()
    },
    async addFace(family, bytes, descriptors) {
      if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) return
      const face = await new FontFace(family, bytes, descriptors).load()
      document.fonts.add(face)
    },
  }
}

export class GlyphFaces {
  private readonly slices = new Map<SliceId, Promise<void>>()
  /** 加载失败过的片（界面据此提示「字体没有加载成功」）；再次用到时会重试，成功后从这里移除 */
  readonly failures = new Set<SliceId>()

  constructor(private readonly deps: GlyphDeps = browserDeps()) {}

  /**
   * 开始加载这些片并等它们就绪；已就绪 / 正在加载的不重复。永不 reject。
   *
   * 登记顺序有意义：中文标点片要在拉丁常用片**之后**登记——两者都带弯引号，后登记的优先，
   * 这样有中文的文档里弯引号用中文字体画，没有中文的文档用 Carlito（与原来一致）。
   * 下载可以并行，只有「登记」按这个顺序。
   */
  load(ids: Iterable<SliceId>): Promise<void> {
    const pending: Promise<void>[] = []
    for (const id of new Set(ids)) pending.push(this.slice(id))
    return Promise.all(pending).then(() => undefined)
  }

  /** 画这段文字之前调用 */
  ensureText(text: string): Promise<void> {
    return this.load(slicesFor(text))
  }

  /** 打开时就要有的片 */
  ensureCore(): Promise<void> {
    return this.load(CORE_SLICES)
  }

  private slice(id: SliceId): Promise<void> {
    const known = this.slices.get(id)
    if (known) return known
    const loading = this.fetchAndAdd(id).then(
      () => {
        this.failures.delete(id)
      },
      () => {
        // 失败不缓存：下次用到再试；这一次不阻塞画布
        this.slices.delete(id)
        this.failures.add(id)
      },
    )
    this.slices.set(id, loading)
    return loading
  }

  private async fetchAndAdd(id: SliceId): Promise<void> {
    const bytes = await this.deps.fetchBytes(urlOf(id))
    // 中文标点片要等核心片登记完再登记，见 load 的说明
    if (id === 'cjk-sym') await this.load(CORE_SLICES)
    const descriptors: FontFaceDescriptors = { weight: weightOf(id), unicodeRange: unicodeRangeOf(id) }
    await Promise.all(FAMILIES.map((family) => this.deps.addFace(family, bytes, descriptors)))
  }
}

let shared: GlyphFaces | null = null

/** 整个页面共用一份（FontFace 登记在 document.fonts 上，重复登记只会白占内存） */
export function sharedGlyphFaces(): GlyphFaces {
  shared ??= new GlyphFaces()
  return shared
}

/** 仅测试用：换掉共享实例 */
export function resetSharedGlyphFaces(next: GlyphFaces | null = null): void {
  shared = next
}
