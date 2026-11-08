import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { OdfError, odpToSlides, odtToHtml } from './odf'

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
  'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"'

async function zipOf(files: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text')
  for (const [name, data] of Object.entries(files)) zip.file(name, data)
  return zip.generateAsync({ type: 'uint8array' })
}

const odt = (body: string, styles = '') =>
  zipOf({ 'content.xml': `<?xml version="1.0"?><office:document-content ${NS}><office:automatic-styles>${styles}</office:automatic-styles><office:body><office:text>${body}</office:text></office:body></office:document-content>` })

describe('odtToHtml', () => {
  it('converts headings, paragraphs, spans, links, breaks and spaces', async () => {
    const styles =
      '<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>' +
      '<style:style style:name="T2" style:family="text"><style:text-properties fo:font-style="italic" style:text-underline-style="solid"/></style:style>'
    const html = await odtToHtml(
      await odt(
        '<text:h text:outline-level="2">标题</text:h>' +
          '<text:p>普通 <text:span text:style-name="T1">加粗</text:span><text:span text:style-name="T2">斜线</text:span><text:line-break/>换行<text:s text:c="2"/>空格 <text:a xlink:href="https://a.com">链接</text:a></text:p>' +
          '<text:p/>',
        styles,
      ),
    )
    expect(html).toBe('<h2>标题</h2><p>普通 <b>加粗</b><i><u>斜线</u></i><br>换行\u00a0\u00a0空格 <a href="https://a.com">链接</a></p>')
  })
  it('converts nested lists and tables with spans', async () => {
    const html = await odtToHtml(
      await odt(
        '<text:list><text:list-item><text:p>一</text:p></text:list-item><text:list-item><text:p>二</text:p></text:list-item></text:list>' +
          '<table:table><table:table-row><table:table-cell table:number-columns-spanned="2"><text:p>合并</text:p></table:table-cell></table:table-row>' +
          '<table:table-row><table:table-cell><text:p>a</text:p></table:table-cell><table:table-cell><text:p>b</text:p></table:table-cell></table:table-row></table:table>',
      ),
    )
    expect(html).toBe('<ul><li>一</li><li>二</li></ul><table><tr><td colspan="2">合并</td></tr><tr><td>a</td><td>b</td></tr></table>')
  })
  it('inlines pictures as data URLs and escapes text', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const html = await odtToHtml(
      await zipOf({
        'Pictures/a.png': png,
        'content.xml': `<office:document-content ${NS}><office:body><office:text><text:p>&lt;b&gt; <draw:frame><draw:image xlink:href="Pictures/a.png"/></draw:frame></text:p></office:text></office:body></office:document-content>`,
      }),
    )
    expect(html).toContain('&lt;b&gt;')
    expect(html).toContain('<img src="data:image/png;base64,iVBORw==" alt="">')
  })
  it('explains broken input', async () => {
    await expect(odtToHtml(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(OdfError)
    await expect(odtToHtml(await zipOf({ 'other.xml': '<a/>' }))).rejects.toThrow(/content\.xml/)
    await expect(odtToHtml(await zipOf({ 'content.xml': '<broken' }))).rejects.toThrow(/XML/)
    await expect(odtToHtml(await odt(''))).rejects.toThrow(/没有可显示/)
  })
})

describe('odpToSlides', () => {
  it('reads titles, bodies and notes per slide', async () => {
    const content = `<office:document-content ${NS}><office:body><office:presentation>
      <draw:page draw:name="page1">
        <draw:frame presentation:class="title"><draw:text-box><text:p>路线图</text:p></draw:text-box></draw:frame>
        <draw:frame presentation:class="outline"><draw:text-box><text:list><text:list-item><text:p>批次 1</text:p></text:list-item></text:list></draw:text-box></draw:frame>
        <presentation:notes><draw:frame><draw:text-box><text:p>先讲批次 1</text:p></draw:text-box></draw:frame></presentation:notes>
      </draw:page>
      <draw:page draw:name="page2"><draw:frame><draw:text-box><text:p>只有正文</text:p></draw:text-box></draw:frame></draw:page>
    </office:presentation></office:body></office:document-content>`
    const slides = await odpToSlides(await zipOf({ 'content.xml': content }))
    expect(slides).toEqual([
      { title: '路线图', html: '<ul><li>批次 1</li></ul>', notes: '先讲批次 1' },
      { title: 'page2', html: '<p>只有正文</p>', notes: '' },
    ])
  })
  it('rejects text documents', async () => {
    await expect(odpToSlides(await odt('<text:p>x</text:p>'))).rejects.toThrow(/不是演示文稿/)
  })
})
