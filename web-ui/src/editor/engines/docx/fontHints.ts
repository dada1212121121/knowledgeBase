/**
 * 打开文档时字体的「投机预取」：在引擎还没告诉我们精确的字体需求之前，先从文档包里估一份，让字体下载和引擎启动并行。
 *
 * 为什么要估（瀑布图实测，20 Mbps / 70 ms / CPU 4×）：精确的字体需求要等 `openSource`（Worker 解析文档，冷启动约 0.55 s）
 * 加 `fontRequirements`（约 0.1 s）之后才知道，之后才开始下字体；字体（Latin 六个面约 1.1 MB + 中文 1.2 MB）单独就要约 1.1 s，
 * 排版（commandInit）又必须等它们到位——也就是说 WASM 下完以后有 0.7 s 链路是空的。
 * 在 WASM 到位的同一刻就按估计的需求开始下载，这段空档就用上了。
 *
 * 估错了没有任何后果：这里只是让 `docxFonts.ts` 里「同一个 URL 只下载一次」的表提前有了下载；真正的需求出来后仍然走原来的解析 / 登记，
 * 估多了多下几百 KB（计入传输量），估少了就和以前一样在需求出来时补下。排版用到哪些字体、字节是什么，一点不受影响。
 */

/** 从文档各部件估出来的字体线索 */
export interface FontHints {
  /** 文档里直接写明的拉丁族名（ascii / hAnsi）加主题字体里的拉丁族名 */
  families: string[]
  /** 文档或样式里出现过粗体：粗体面也要 */
  bold: boolean
  /** 正文里有中日文字：需要中文字体 */
  cjk: boolean
  /**
   * 文档里用到的码位（只记 ≥ 0x80；ASCII 永远在字体的核心里）：正文 / 页眉页脚 / 脚注 / 批注的文字、修订里被删掉的文字、
   * 公式文字、编号的项目符号。决定要下载字体里哪些扩展字形包（见 docxFonts.ts 的 FontDemand）。
   */
  chars: Set<number>
}

/** 正文文字节点里的中日文字（假名、CJK 统一表意文字、全角标点）；只看文字节点，避免属性值（如 w:eastAsia="宋体"）误判 */
const CJK_TEXT = /[\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/

function textNodes(xml: string): string {
  let text = ''
  // w:t 正文；w:delText 修订里被删掉的字（审阅视图里照样画）；m:t 公式
  for (const match of xml.matchAll(/<(?:w:t|w:delText|m:t)(?:\s[^>]*)?>([^<]*)<\/(?:w:t|w:delText|m:t)>/g)) text += match[1]
  // 项目符号 / 编号文字写在属性里；w:sym 的 w:char 是十六进制码位
  for (const match of xml.matchAll(/w:lvlText\s+w:val="([^"]*)"/g)) text += match[1]
  for (const match of xml.matchAll(/<w:sym\s[^>]*w:char="([0-9A-Fa-f]{1,6})"/g)) text += String.fromCodePoint(parseInt(match[1]!, 16))
  return text
}

/** XML 实体：&amp; &lt; &#x4e2d; 等；只处理数字实体（字符码位），具名实体都是 ASCII 不影响 */
function decodeEntities(text: string): string {
  return text.replace(/&#x([0-9a-fA-F]+);|&#(\d+);/g, (_, hex: string | undefined, dec: string | undefined) => {
    const cp = hex ? parseInt(hex, 16) : parseInt(dec!, 10)
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''
  })
}

const BOLD = /<w:b(?:\s+w:val="(?:1|true|on)")?\s*\/>/

/** 主题里 majorFont / minorFont 的拉丁字体（样式用 asciiTheme 引用主题时，正文真正用的字体在这里） */
function themeLatin(theme: string): string[] {
  const names: string[] = []
  for (const block of theme.matchAll(/<a:(?:major|minor)Font>([\s\S]*?)<\/a:(?:major|minor)Font>/g)) {
    const latin = /<a:latin\s[^>]*typeface="([^"]*)"/.exec(block[1] ?? '')
    if (latin?.[1]) names.push(latin[1])
  }
  return names
}

/**
 * 从已经解出来的各部件 XML 估字体线索。纯函数，便于单测。
 * `body` = 正文 / 页眉 / 页脚等；`styles` = 样式表；`theme` = 主题。
 */
export function hintsFromParts(parts: { body: readonly string[]; styles: string; theme: string }): FontHints {
  const families = new Set<string>()
  const chars = new Set<number>()
  let bold = false
  let cjk = false
  for (const xml of [...parts.body, parts.styles]) {
    for (const match of xml.matchAll(/w:(?:ascii|hAnsi)="([^"]+)"/g)) if (match[1]) families.add(match[1])
    // 粗体：<w:b/>、<w:b w:val="1"/>；<w:bCs/> 是复杂文种的粗体，不算
    if (!bold && BOLD.test(xml)) bold = true
  }
  for (const name of themeLatin(parts.theme)) families.add(name)
  for (const xml of parts.body) {
    const text = decodeEntities(textNodes(xml))
    if (!cjk && CJK_TEXT.test(text)) cjk = true
    for (const char of text) {
      const cp = char.codePointAt(0)!
      if (cp >= 0x80) chars.add(cp)
    }
  }
  // 主题占位名（+mn-lt）不是真字体
  return { families: [...families].filter((name) => !name.startsWith('+')), bold, cjk, chars }
}

/** 要读的部件：正文、页眉页脚、脚注尾注、批注、编号（项目符号），再加样式和主题 */
const BODY_PART = /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes|comments\w*|numbering)\.xml$/

/** 从 docx 包里估字体线索；任何一步失败都返回 null（预取只是优化，不报错） */
export async function scanDocxFontHints(bytes: Uint8Array): Promise<FontHints | null> {
  try {
    const { default: JSZip } = await import('jszip')
    const zip = await JSZip.loadAsync(bytes)
    const read = async (name: string) => (await zip.file(name)?.async('string')) ?? ''
    const bodyNames = Object.keys(zip.files).filter((name) => BODY_PART.test(name))
    const [body, styles, theme] = await Promise.all([Promise.all(bodyNames.map(read)), read('word/styles.xml'), read('word/theme/theme1.xml')])
    return hintsFromParts({ body, styles, theme })
  } catch {
    return null
  }
}

/** 字体提供器里「解析出这个族的字体加载函数」的那部分形状（与 docxFonts.ts 的 createShippedProvider 一致） */
export interface HintFontProvider {
  resolve(family: string, bold: boolean, italic: boolean): (() => Promise<ArrayBuffer>) | undefined
  resolveLastResort(family: string, bold: boolean, italic: boolean, office?: 'powerpoint' | 'word'): (() => Promise<ArrayBuffer>) | undefined
  resolveScriptFallback(script: string): (() => Promise<ArrayBuffer>) | undefined
}

/**
 * 按线索开始下载字体，返回发起了多少个下载（单测用）。
 * 加载函数走提供器自己的「同一个 URL 只下载一次」缓存：之后真正的需求出来时拿到的是同一个 Promise。
 */
export function prefetchHintedFonts(provider: HintFontProvider, hints: FontHints): number {
  let started = 0
  const start = (load: (() => Promise<ArrayBuffer>) | undefined) => {
    if (!load) return
    started += 1
    // 失败不要紧：真正需要时会重试并如实报错
    void load().catch(() => undefined)
  }
  for (const family of hints.families) {
    for (const bold of hints.bold ? [false, true] : [false]) {
      start(provider.resolve(family, bold, false) ?? provider.resolveLastResort(family, bold, false, 'word'))
    }
  }
  if (hints.cjk) start(provider.resolveScriptFallback('cjk-sc'))
  return started
}
