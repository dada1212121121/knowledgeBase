/**
 * docx 包里只读展示要用到的元信息：批注 + 标题样式
 *
 * 为什么不用 docx-preview 解析出来的模型：它的 `WordDocument` 在类型里是 `any`，内部结构随版本变；
 * 这里直接读 OPC 包里的三个 XML（styles / comments / document），输入是字节、输出是纯数据，单测不需要浏览器。
 *
 * 为什么标题要读 styles.xml：docx-preview 给段落的 class 来自样式 id（`kbdocx_<id>`），
 * 英文模板的 id 是 `Heading1`，WPS 和部分中文模板的 id 是 `1`、`2`，只看 class 名分不出标题。
 * 样式名（`w:name`）在内置样式上始终是英文的 `heading 1`，再加上显式的 `w:outlineLvl` 兜底。
 */

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

/** 一条批注：只读展示用，不含回复串（回复关系在 commentsExtended，按出现顺序平铺） */
export interface DocxComment {
  id: string
  author: string
  /** ISO 时间，文档里没有就是空串 */
  date: string
  text: string
  /** 被批注的原文片段（最多 80 字），用来在渲染结果里定位；找不到时为空串 */
  quote: string
}

export interface DocxMeta {
  comments: DocxComment[]
  /** 标题样式：渲染结果里的段落 class（`kbdocx_<escaped id>`）→ 大纲级别 1~9 */
  headingClasses: Map<string, number>
}

/** 与 docx-preview 的 `escapeClassName` 保持一致，才能从样式 id 还原出渲染后的 class */
export function styleClassName(prefix: string, styleId: string): string {
  return `${prefix}_${styleId.replace(/[ .]+/g, '-').replace(/[&]+/g, 'and').toLowerCase()}`
}

function parseXml(xml: string): Document | null {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  // 解析失败时浏览器 / jsdom 会生成 parsererror 节点；当作"这个部件不可用"，不抛错
  return doc.getElementsByTagName('parsererror').length ? null : doc
}

const attr = (el: Element, name: string) => el.getAttributeNS(W, name) ?? el.getAttribute(`w:${name}`) ?? ''

/** 批注正文：每个段落一行，段内取全部 w:t */
function textOf(el: Element): string {
  const lines: string[] = []
  for (const p of Array.from(el.getElementsByTagNameNS(W, 'p'))) {
    lines.push(Array.from(p.getElementsByTagNameNS(W, 't')).map((t) => t.textContent ?? '').join(''))
  }
  return lines.join('\n').trim()
}

const QUOTE_MAX = 80

/**
 * 批注锚点文字：按文档顺序走一遍 w:p，commentRangeStart 到 commentRangeEnd 之间的 w:t 累加成该批注的原文片段。
 * 范围可以跨段落，所以"当前打开的批注集合"在段落之间保持；每条最多留 80 字，够定位且不会把整篇文档拷一遍。
 */
export function anchorQuotes(documentXml: string, wanted: ReadonlySet<string>): Map<string, string> {
  const quotes = new Map<string, string>()
  const doc = parseXml(documentXml)
  if (!doc || !wanted.size) return quotes
  const open = new Set<string>()
  const visit = (node: Node) => {
    if (node.nodeType !== 1) return
    const el = node as Element
    if (el.namespaceURI === W) {
      if (el.localName === 'commentRangeStart') {
        const id = attr(el, 'id')
        if (wanted.has(id)) {
          open.add(id)
          if (!quotes.has(id)) quotes.set(id, '')
        }
        return
      }
      if (el.localName === 'commentRangeEnd') {
        open.delete(attr(el, 'id'))
        return
      }
      if (el.localName === 't' && open.size) {
        const text = el.textContent ?? ''
        for (const id of open) {
          const current = quotes.get(id) ?? ''
          if (current.length < QUOTE_MAX) quotes.set(id, (current + text).slice(0, QUOTE_MAX))
        }
        return
      }
    }
    for (const child of Array.from(el.childNodes)) visit(child)
  }
  const body = doc.getElementsByTagNameNS(W, 'body')[0]
  if (body) visit(body)
  return quotes
}

export function parseComments(commentsXml: string): Omit<DocxComment, 'quote'>[] {
  const doc = parseXml(commentsXml)
  if (!doc) return []
  return Array.from(doc.getElementsByTagNameNS(W, 'comment')).map((el) => ({
    id: attr(el, 'id'),
    author: attr(el, 'author') || '未署名',
    date: attr(el, 'date'),
    text: textOf(el),
  }))
}

/** 标题样式：名字是 `heading N` / `title`，或样式本身带 outlineLvl；继承链上的 basedOn 也算 */
export function parseHeadingStyles(stylesXml: string, classPrefix: string): Map<string, number> {
  const out = new Map<string, number>()
  const doc = parseXml(stylesXml)
  if (!doc) return out
  const levels = new Map<string, number>()
  const based = new Map<string, string>()
  for (const style of Array.from(doc.getElementsByTagNameNS(W, 'style'))) {
    if (attr(style, 'type') && attr(style, 'type') !== 'paragraph') continue
    const id = attr(style, 'styleId')
    if (!id) continue
    const name = (style.getElementsByTagNameNS(W, 'name')[0] ? attr(style.getElementsByTagNameNS(W, 'name')[0]!, 'val') : '').toLowerCase()
    const outline = style.getElementsByTagNameNS(W, 'outlineLvl')[0]
    const parent = style.getElementsByTagNameNS(W, 'basedOn')[0]
    if (parent) based.set(id, attr(parent, 'val'))
    const named = /^heading\s*([1-9])$/.exec(name)
    if (named) levels.set(id, Number(named[1]))
    else if (name === 'title') levels.set(id, 1)
    else if (outline) {
      const value = Number(attr(outline, 'val'))
      // outlineLvl 从 0 开始，9 表示正文
      if (Number.isFinite(value) && value >= 0 && value <= 8) levels.set(id, value + 1)
    }
  }
  const resolve = (id: string, depth = 0): number | undefined => {
    if (levels.has(id)) return levels.get(id)
    const parent = based.get(id)
    return parent && depth < 8 ? resolve(parent, depth + 1) : undefined
  }
  for (const id of new Set([...levels.keys(), ...based.keys()])) {
    const level = resolve(id)
    if (level) out.set(styleClassName(classPrefix, id), level)
  }
  return out
}

/**
 * 读 docx 包的元信息。任何一步失败都返回已有的部分（空批注 / 空标题表），不影响阅读：
 * 元信息只服务大纲与批注侧栏，不是渲染的前提。
 */
export async function readDocxMeta(buffer: ArrayBuffer, classPrefix: string): Promise<DocxMeta> {
  const meta: DocxMeta = { comments: [], headingClasses: new Map() }
  try {
    const { default: JSZip } = await import('jszip')
    const zip = await JSZip.loadAsync(buffer)
    const read = (path: string) => zip.file(path)?.async('string') ?? Promise.resolve('')
    const [styles, comments] = await Promise.all([read('word/styles.xml'), read('word/comments.xml')])
    if (styles) meta.headingClasses = parseHeadingStyles(styles, classPrefix)
    if (comments) {
      const parsed = parseComments(comments)
      // 只有确实有批注才去解析可能很大的 document.xml
      const quotes = parsed.length ? anchorQuotes(await read('word/document.xml'), new Set(parsed.map((item) => item.id))) : new Map<string, string>()
      meta.comments = parsed.map((item) => ({ ...item, quote: quotes.get(item.id) ?? '' }))
    }
  } catch {
    // 包损坏时 docx-preview 自己会报错，这里保持空元信息
  }
  return meta
}
