import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { EpubError, openEpub, resolvePath } from './epub'

const OPF = (extra = '') => `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>示例书</dc:title><dc:creator>作者甲</dc:creator></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/c2.xhtml" media-type="application/xhtml+xml"/><item id="img" href="img/a.png" media-type="image/png"/>${extra}</manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`
const CONTAINER = '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'
const NAV = '<html><body><nav epub:type="toc"><ol><li><a href="text/c1.xhtml">第一章 起</a></li><li><a href="text/c2.xhtml#x">第二章 承</a></li></ol></nav></body></html>'

async function book(files: Record<string, string | Uint8Array> = {}) {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', CONTAINER)
  zip.file('OEBPS/content.opf', OPF())
  zip.file('OEBPS/nav.xhtml', NAV)
  zip.file('OEBPS/text/c1.xhtml', '<html><head><style>p{color:red}</style></head><body><h1>起</h1><p>正文一</p><img src="../img/a.png"/><script>x()</script></body></html>')
  zip.file('OEBPS/text/c2.xhtml', '<html><body><p>正文二</p></body></html>')
  zip.file('OEBPS/img/a.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  for (const [name, data] of Object.entries(files)) zip.file(name, data)
  return zip.generateAsync({ type: 'uint8array' })
}

describe('resolvePath', () => {
  it('normalises relative paths and refuses external urls', () => {
    expect(resolvePath('OEBPS/text/c1.xhtml', '../img/a.png')).toBe('OEBPS/img/a.png')
    expect(resolvePath('OEBPS/content.opf', 'text/c%201.xhtml#frag')).toBe('OEBPS/text/c 1.xhtml')
    expect(resolvePath('a/b.xhtml', '/root.png')).toBe('root.png')
    expect(resolvePath('a/b.xhtml', 'https://x/y.png')).toBe('')
  })
})

describe('openEpub', () => {
  it('reads metadata, the toc titles and loads chapters lazily with inlined images', async () => {
    const epub = await openEpub(await book())
    expect(epub.title).toBe('示例书')
    expect(epub.author).toBe('作者甲')
    expect(epub.chapters.map((chapter) => chapter.title)).toEqual(['第一章 起', '第二章 承'])
    const first = await epub.load(0)
    expect(first).toContain('<h1>起</h1>')
    expect(first).toContain('src="data:image/png;base64,iVBORw=="')
    expect(first).not.toContain('<script')
    expect(first).not.toContain('<style')
    expect(await epub.load(1)).toBe('<p>正文二</p>')
  })
  it('falls back to NCX titles', async () => {
    const zip = new JSZip()
    zip.file('META-INF/container.xml', CONTAINER)
    zip.file('OEBPS/content.opf', OPF('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>').replace(' properties="nav"', ''))
    zip.file('OEBPS/toc.ncx', '<ncx><navMap><navPoint><navLabel><text>甲章</text></navLabel><content src="text/c1.xhtml"/></navPoint></navMap></ncx>')
    zip.file('OEBPS/text/c1.xhtml', '<html><body>a</body></html>')
    zip.file('OEBPS/text/c2.xhtml', '<html><body>b</body></html>')
    const epub = await openEpub(await zip.generateAsync({ type: 'uint8array' }))
    expect(epub.chapters.map((chapter) => chapter.title)).toEqual(['甲章', '第 2 节'])
  })
  it('rejects DRM books but allows font obfuscation', async () => {
    const drm = '<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/></EncryptedData></encryption>'
    await expect(openEpub(await book({ 'META-INF/encryption.xml': drm }))).rejects.toThrow(/DRM/)
    const fonts = '<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/></EncryptedData></encryption>'
    await expect(openEpub(await book({ 'META-INF/encryption.xml': fonts }))).resolves.toBeTruthy()
  })
  it('explains broken books', async () => {
    await expect(openEpub(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(EpubError)
    const zip = new JSZip()
    zip.file('a.txt', 'x')
    await expect(openEpub(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow(/container\.xml/)
  })
})
