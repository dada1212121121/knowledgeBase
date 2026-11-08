// EPUB 阅读:container.xml → OPF(元数据 / manifest / spine)→ 目录(nav.xhtml 或 NCX)→ 按章节懒加载正文。
// 章节 HTML 取 <body> 内容,图片换成 data URL(限大小),书里的 CSS / 脚本一律不用(统一用应用的阅读样式)。
// 有 DRM(非字体混淆的加密)的书直接报错。输出未清洗,调用方过 sanitizeDocHtml。
import JSZip from 'jszip'

export class EpubError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EpubError'
  }
}

export interface EpubChapter {
  href: string
  title: string
}

export interface EpubBook {
  title: string
  author: string
  chapters: EpubChapter[]
  load(index: number): Promise<string>
}

const MAX_IMAGE = 3 * 1024 * 1024
const FONT_OBFUSCATION = ['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }

function xml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new EpubError('电子书内部的 XML 无法解析(文件可能已损坏)')
  return doc
}

/** 把 `../img/a.png` 之类相对路径按所在目录归一化成 zip 内的绝对路径。 */
export function resolvePath(base: string, relative: string): string {
  const clean = relative.split('#')[0]!.split('?')[0]!
  if (/^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('//')) return ''
  const parts = clean.startsWith('/') ? [] : base.split('/').slice(0, -1)
  for (const part of clean.split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  try {
    return decodeURIComponent(parts.join('/'))
  } catch {
    return parts.join('/')
  }
}

const textOf = (element: Element | undefined | null) => (element?.textContent ?? '').trim().replace(/\s+/g, ' ')

export async function openEpub(bytes: Uint8Array): Promise<EpubBook> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch {
    throw new EpubError('不是有效的 EPUB(无法按 zip 打开)')
  }
  const encryption = await zip.file('META-INF/encryption.xml')?.async('string')
  if (encryption) {
    const algorithms = [...encryption.matchAll(/Algorithm="([^"]+)"/g)].map((match) => match[1]!)
    if (algorithms.some((algorithm) => !FONT_OBFUSCATION.includes(algorithm) && !/xmlenc#sha|xmldsig/i.test(algorithm))) {
      throw new EpubError('这本电子书有 DRM 保护,无法在页内阅读')
    }
  }
  const container = await zip.file('META-INF/container.xml')?.async('string')
  if (!container) throw new EpubError('缺少 META-INF/container.xml,不是 EPUB')
  const rootPath = xml(container).getElementsByTagName('rootfile')[0]?.getAttribute('full-path')
  if (!rootPath) throw new EpubError('找不到 OPF 包文件')
  const opfText = await zip.file(rootPath)?.async('string')
  if (!opfText) throw new EpubError('OPF 包文件缺失')
  const opf = xml(opfText)

  const manifest = new Map<string, { href: string; type: string; properties: string }>()
  for (const item of opf.getElementsByTagName('item')) {
    manifest.set(item.getAttribute('id') ?? '', {
      href: resolvePath(rootPath, item.getAttribute('href') ?? ''),
      type: item.getAttribute('media-type') ?? '',
      properties: item.getAttribute('properties') ?? '',
    })
  }
  const spine = [...opf.getElementsByTagName('itemref')]
    .filter((ref) => ref.getAttribute('linear') !== 'no')
    .map((ref) => manifest.get(ref.getAttribute('idref') ?? ''))
    .filter((item): item is { href: string; type: string; properties: string } => !!item && /x?html/.test(item.type))
  if (!spine.length) throw new EpubError('电子书没有可阅读的章节')

  // 目录:EPUB3 nav 优先,否则 NCX
  const titles = new Map<string, string>()
  const nav = [...manifest.values()].find((item) => item.properties.split(/\s+/).includes('nav'))
  const ncx = [...manifest.values()].find((item) => item.type === 'application/x-dtbncx+xml')
  try {
    if (nav) {
      const doc = new DOMParser().parseFromString((await zip.file(nav.href)?.async('string')) ?? '', 'text/html')
      for (const link of doc.querySelectorAll('nav a[href]')) {
        const path = resolvePath(nav.href, link.getAttribute('href') ?? '')
        if (path && !titles.has(path)) titles.set(path, textOf(link))
      }
    } else if (ncx) {
      const doc = xml((await zip.file(ncx.href)?.async('string')) ?? '')
      for (const point of doc.getElementsByTagName('navPoint')) {
        const path = resolvePath(ncx.href, point.getElementsByTagName('content')[0]?.getAttribute('src') ?? '')
        const label = textOf(point.getElementsByTagName('navLabel')[0])
        if (path && label && !titles.has(path)) titles.set(path, label)
      }
    }
  } catch {
    /* 目录坏了不影响阅读,用章节自己的标题 */
  }

  const chapters: EpubChapter[] = spine.map((item, index) => ({ href: item.href, title: titles.get(item.href) || `第 ${index + 1} 节` }))
  const dc = (name: string) => textOf(opf.getElementsByTagName(`dc:${name}`)[0] ?? opf.getElementsByTagNameNS('*', name)[0])

  return {
    title: dc('title'),
    author: dc('creator'),
    chapters,
    async load(index) {
      const chapter = chapters[index]
      const file = chapter && zip.file(chapter.href)
      if (!chapter || !file) throw new EpubError('章节文件缺失')
      const doc = new DOMParser().parseFromString(await file.async('string'), 'text/html')
      for (const node of doc.querySelectorAll('script, style, link, meta')) node.remove()
      let total = 0
      for (const image of [...doc.querySelectorAll('img')]) {
        const path = resolvePath(chapter.href, image.getAttribute('src') ?? '')
        const entry = path ? zip.file(path) : null
        const mime = MIME[path.split('.').pop()?.toLowerCase() ?? '']
        if (!entry || !mime) {
          image.removeAttribute('src')
          continue
        }
        const data = await entry.async('base64')
        const size = Math.floor((data.length * 3) / 4)
        total += size
        if (size > MAX_IMAGE || total > MAX_IMAGE * 8) image.removeAttribute('src')
        else image.setAttribute('src', `data:${mime};base64,${data}`)
      }
      return doc.body?.innerHTML ?? ''
    },
  }
}
