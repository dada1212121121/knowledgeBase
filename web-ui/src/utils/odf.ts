// OpenDocument(.odt / .odp)→ HTML。ODF 是 zip,正文在 content.xml。
// 取标题 / 段落 / 列表 / 表格 / 粗斜体下划线 / 链接 / 内嵌图片(data URL);页眉页脚、批注、公式、绘图形状一律忽略。
// ods 走 SheetViewer(SheetJS 能读)。输出已转义,调用方仍应再过 sanitizeDocHtml。
import JSZip from 'jszip'

export class OdfError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OdfError'
  }
}

export interface OdpSlide {
  title: string
  html: string
  notes: string
}

interface Format {
  b: boolean
  i: boolean
  u: boolean
}

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const MAX_IMAGE = 3 * 1024 * 1024
const MAX_IMAGES_TOTAL = 24 * 1024 * 1024
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new OdfError('文档内部的 XML 无法解析(文件可能已损坏)')
  return doc
}

async function openZip(bytes: Uint8Array): Promise<{ zip: JSZip; content: Document }> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch {
    throw new OdfError('不是有效的 OpenDocument 文件(无法按 zip 打开)')
  }
  const file = zip.file('content.xml')
  if (!file) throw new OdfError('缺少 content.xml,不是 OpenDocument 文件')
  const mimetype = (await zip.file('mimetype')?.async('string'))?.trim()
  if (mimetype && /encrypted/i.test(await (zip.file('META-INF/manifest.xml')?.async('string') ?? ''))) {
    throw new OdfError('这份文档已加密,无法在页内预览')
  }
  return { zip, content: parseXml(await file.async('string')) }
}

async function loadImages(zip: JSZip): Promise<Map<string, string>> {
  const images = new Map<string, string>()
  let total = 0
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir || !/^(Pictures|media)\//i.test(name)) continue
    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    const mime = MIME[ext]
    if (!mime) continue
    const data = await entry.async('base64')
    const size = Math.floor((data.length * 3) / 4)
    if (size > MAX_IMAGE || total + size > MAX_IMAGES_TOTAL) continue
    total += size
    images.set(name, `data:${mime};base64,${data}`)
  }
  return images
}

function styleMap(content: Document): Map<string, Format> {
  const map = new Map<string, Format>()
  for (const style of content.getElementsByTagName('style:style')) {
    const name = style.getAttribute('style:name')
    const props = style.getElementsByTagName('style:text-properties')[0]
    if (!name || !props) continue
    const underline = props.getAttribute('style:text-underline-style')
    map.set(name, {
      b: /bold|[6-9]00/.test(props.getAttribute('fo:font-weight') ?? ''),
      i: /italic|oblique/.test(props.getAttribute('fo:font-style') ?? ''),
      u: !!underline && underline !== 'none',
    })
  }
  return map
}

class Converter {
  constructor(
    private readonly styles: Map<string, Format>,
    private readonly images: Map<string, string>,
  ) {}

  inline(node: Node, inherited?: Format): string {
    let out = ''
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += escapeHtml(child.textContent ?? '')
        continue
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue
      const element = child as Element
      switch (element.nodeName) {
        case 'text:span': {
          const format = this.styles.get(element.getAttribute('text:style-name') ?? '')
          let html = this.inline(element, format)
          if (format?.u) html = `<u>${html}</u>`
          if (format?.i) html = `<i>${html}</i>`
          if (format?.b) html = `<b>${html}</b>`
          out += html
          break
        }
        case 'text:a': {
          const href = element.getAttribute('xlink:href') ?? ''
          out += `<a href="${escapeHtml(href)}">${this.inline(element, inherited)}</a>`
          break
        }
        case 'text:s':
          out += '\u00a0'.repeat(Number(element.getAttribute('text:c') ?? 1) || 1)
          break
        case 'text:tab':
          out += '    '
          break
        case 'text:line-break':
          out += '<br>'
          break
        case 'draw:frame':
        case 'draw:a':
          out += this.frame(element)
          break
        case 'text:note':
        case 'office:annotation':
          break
        default:
          out += this.inline(element, inherited)
      }
    }
    return out
  }

  frame(element: Element): string {
    const image = element.getElementsByTagName('draw:image')[0]
    if (!image) return ''
    const href = (image.getAttribute('xlink:href') ?? '').replace(/^\.\//, '')
    const src = this.images.get(href)
    const alt = element.getElementsByTagName('svg:title')[0]?.textContent ?? ''
    return src ? `<img src="${src}" alt="${escapeHtml(alt)}">` : `[图片${alt ? `：${escapeHtml(alt)}` : ''}]`
  }

  block(element: Element): string {
    switch (element.nodeName) {
      case 'text:h': {
        const level = Math.min(6, Math.max(1, Number(element.getAttribute('text:outline-level') ?? 1) || 1))
        return `<h${level}>${this.inline(element)}</h${level}>`
      }
      case 'text:p': {
        const body = this.inline(element)
        return body.trim() ? `<p>${body}</p>` : ''
      }
      case 'text:list':
        return this.list(element)
      case 'table:table':
        return this.table(element)
      case 'text:section':
      case 'office:text':
      case 'draw:text-box':
        return this.blocks(element)
      case 'text:table-of-content':
      case 'text:index-body':
        return this.blocks(element)
      default:
        return ''
    }
  }

  blocks(parent: Element): string {
    let out = ''
    for (const child of parent.children) out += this.block(child)
    return out
  }

  list(element: Element): string {
    const items = [...element.children]
      .filter((child) => child.nodeName === 'text:list-item' || child.nodeName === 'text:list-header')
      .map((item) => `<li>${this.blocks(item).replace(/^<p>([\s\S]*?)<\/p>$/, '$1')}</li>`)
    return `<ul>${items.join('')}</ul>`
  }

  table(element: Element): string {
    const rows: string[] = []
    const visit = (parent: Element) => {
      for (const child of parent.children) {
        if (child.nodeName === 'table:table-row') {
          const cells = [...child.children]
            .filter((cell) => cell.nodeName === 'table:table-cell')
            .map((cell) => {
              const span = Number(cell.getAttribute('table:number-columns-spanned') ?? 1) || 1
              return `<td${span > 1 ? ` colspan="${span}"` : ''}>${this.blocks(cell).replace(/^<p>([\s\S]*?)<\/p>$/, '$1')}</td>`
            })
          rows.push(`<tr>${cells.join('')}</tr>`)
        } else if (['table:table-header-rows', 'table:table-rows', 'table:table-row-group'].includes(child.nodeName)) {
          visit(child)
        }
      }
    }
    visit(element)
    return `<table>${rows.join('')}</table>`
  }
}

export async function odtToHtml(bytes: Uint8Array): Promise<string> {
  const { zip, content } = await openZip(bytes)
  const body = content.getElementsByTagName('office:text')[0]
  if (!body) throw new OdfError('这不是文字文档(.odt)')
  const converter = new Converter(styleMap(content), await loadImages(zip))
  const html = converter.blocks(body)
  if (!html.trim()) throw new OdfError('文档里没有可显示的内容')
  return html
}

export async function odpToSlides(bytes: Uint8Array): Promise<OdpSlide[]> {
  const { zip, content } = await openZip(bytes)
  const presentation = content.getElementsByTagName('office:presentation')[0]
  if (!presentation) throw new OdfError('这不是演示文稿(.odp)')
  const converter = new Converter(styleMap(content), await loadImages(zip))
  const slides: OdpSlide[] = []
  for (const page of presentation.children) {
    if (page.nodeName !== 'draw:page') continue
    let title = ''
    let html = ''
    for (const frame of page.children) {
      if (frame.nodeName !== 'draw:frame') continue
      const kind = frame.getAttribute('presentation:class')
      if (kind === 'title') {
        title = (frame.textContent ?? '').trim().replace(/\s+/g, ' ')
        continue
      }
      html += converter.frame(frame) || converter.blocks(frame.getElementsByTagName('draw:text-box')[0] ?? frame)
    }
    const notes = [...page.getElementsByTagName('presentation:notes')]
      .map((note) => (note.textContent ?? '').trim())
      .filter(Boolean)
      .join('\n')
    slides.push({ title: title || (page.getAttribute('draw:name') ?? ''), html, notes })
  }
  if (!slides.length) throw new OdfError('演示文稿里没有幻灯片')
  return slides
}
