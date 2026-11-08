/**
 * Word 打开时的无损检查与按 sha256 的缓存
 *
 * 为什么要检查：引擎改过文档再保存，可能和原件不一样——丢东西（实测一份流程图会丢浮动形状），或者改写别的部件
 * （WPS 的页码域、旧版部件）。用户改一个字，文件里别的地方不能悄悄变样。
 *
 * 为什么是"探针"而不是"不改保存"：引擎对没改过的文档保存时原样返回原件字节，"不改保存"永远显示无损，
 * 看不见重写时丢东西。所以在隔离的临时会话里做一次真实的探针编辑（文首插入一个标记字符）再保存，
 * 交给服务端 `roundtrip-check`（`office_check::compare`）逐部件比、本地再清点内容（见 docxInventory.ts），
 * 得到三态结论：yes 放开编辑；force 文字没丢但会改写别的部件，只读并说明，用户点「仍然编辑」才放开；
 * no 会丢内容或不是完整的包，不能编辑。
 *
 * 为什么能缓存：结论只取决于「原件字节 + 引擎版本」。同一份文件第二次打开不需要再起临时会话、再传一遍给服务端。
 * 键里带引擎版本号：升级引擎后旧结论作废，重新检查。缓存只放在浏览器本机，只存结论（不存文件内容）；
 * 存储不可用（隐私模式、配额满）时静默退化为每次都检查。
 */
import type { RoundtripReport } from '../../api/officeEdit'
import { inventoryOf, PROBE_MARKER, verdictFromProbe, type DocxEditVerdict } from './docxInventory'

/** 引擎版本：键的一部分。升级 @betteroffice/docx 时必须同步改（有单测对着 node_modules 里的版本守着） */
export const DOCX_ENGINE_VERSION = '0.5.1'

// v2：缓存的内容从服务端报告换成三态判定，旧版本写下的条目不能混用
const STORAGE_KEY = 'kb.docx.roundtrip.v2'
/** 最多记多少份文件的结论；超出按最久未用淘汰 */
export const ROUNDTRIP_CACHE_LIMIT = 200

interface Entry {
  key: string
  verdict: DocxEditVerdict
  at: number
}

/** 只用到 getItem / setItem 的存储抽象，测试里换成内存实现 */
export interface RoundtripStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function roundtripCacheKey(sha256: string, engineVersion = DOCX_ENGINE_VERSION): string {
  return `${engineVersion}:${sha256}`
}

function isVerdict(value: unknown): value is DocxEditVerdict {
  if (!value || typeof value !== 'object') return false
  const verdict = value as Record<string, unknown>
  return (
    (verdict.editable === 'yes' || verdict.editable === 'force' || verdict.editable === 'no') &&
    typeof verdict.valid === 'boolean' &&
    Array.isArray(verdict.losses) &&
    Array.isArray(verdict.rewritten)
  )
}

export class RoundtripCache {
  constructor(
    private readonly storage: RoundtripStorage | null,
    private readonly now: () => number = Date.now,
    private readonly limit = ROUNDTRIP_CACHE_LIMIT,
  ) {}

  private load(): Entry[] {
    if (!this.storage) return []
    try {
      const raw = this.storage.getItem(STORAGE_KEY)
      if (!raw) return []
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      // 被改坏的条目整条丢掉，不让一条坏数据让整个缓存失效
      return parsed.filter((entry): entry is Entry => !!entry && typeof entry.key === 'string' && typeof entry.at === 'number' && isVerdict(entry.verdict))
    } catch {
      return []
    }
  }

  private save(entries: Entry[]): void {
    if (!this.storage) return
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(entries))
    } catch {
      // 配额满 / 存储被禁：缓存只是加速，失败就算了
    }
  }

  get(sha256: string, engineVersion = DOCX_ENGINE_VERSION): DocxEditVerdict | null {
    const key = roundtripCacheKey(sha256, engineVersion)
    const entries = this.load()
    const hit = entries.find((entry) => entry.key === key)
    if (!hit) return null
    // 命中就刷新时间：常用的文件不会被淘汰
    hit.at = this.now()
    this.save(entries)
    return hit.verdict
  }

  set(sha256: string, verdict: DocxEditVerdict, engineVersion = DOCX_ENGINE_VERSION): void {
    if (!sha256) return
    const key = roundtripCacheKey(sha256, engineVersion)
    const entries = this.load().filter((entry) => entry.key !== key)
    entries.push({ key, verdict, at: this.now() })
    entries.sort((left, right) => right.at - left.at)
    this.save(entries.slice(0, this.limit))
  }
}

/** 浏览器里的默认缓存；没有 localStorage（SSR / 被禁用）时不缓存 */
export function defaultRoundtripCache(): RoundtripCache {
  try {
    return new RoundtripCache(typeof localStorage === 'undefined' ? null : localStorage)
  } catch {
    // 访问 localStorage 本身就可能抛（Safari 隐私模式 / 被策略禁用）
    return new RoundtripCache(null)
  }
}

export interface RoundtripCheckInput {
  /** 原件字节的 sha256（file_info 给的）；空 = 不能缓存，每次都检查 */
  sha256: string
  /** 原件字节 */
  original: Uint8Array
  /** 在隔离的临时会话里做一次探针编辑并保存，返回保存出的字节（只在缓存没命中时才调用） */
  probe(original: Uint8Array): Promise<Uint8Array>
  /** 交给服务端比较"探针保存的包 vs 原件" */
  check(resaved: Uint8Array): Promise<RoundtripReport>
  cache: RoundtripCache
}

/** 取出 docx 包里的 word/document.xml */
export async function readDocumentXml(bytes: Uint8Array): Promise<string> {
  // JSZip 只在需要检查时才加载，不进主包
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(bytes)
  const entry = zip.file('word/document.xml')
  if (!entry) throw new Error('文档里没有 word/document.xml')
  return entry.async('string')
}

/**
 * 取编辑判定：先看缓存，没有才起探针会话、问服务端、清点内容。
 * 任何一步失败（探针被引擎拒绝、网络断了、XML 读不了）都抛出去，由调用方决定怎么提示；失败的结论不进缓存。
 * "读不出来"不能当成"没问题"——宁可不让编辑，也不能把一份可能被改坏的文档放出去。
 */
export async function roundtripVerdict(input: RoundtripCheckInput): Promise<{ verdict: DocxEditVerdict; cached: boolean }> {
  const known = input.sha256 ? input.cache.get(input.sha256) : null
  if (known) return { verdict: known, cached: true }
  const probed = await input.probe(input.original)
  const [server, originalXml, probeXml] = await Promise.all([input.check(probed), readDocumentXml(input.original), readDocumentXml(probed)])
  const verdict = verdictFromProbe(server, inventoryOf(originalXml), inventoryOf(probeXml))
  if (input.sha256) input.cache.set(input.sha256, verdict)
  return { verdict, cached: false }
}

export { PROBE_MARKER }
