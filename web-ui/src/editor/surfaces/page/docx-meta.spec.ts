/**
 * docx 包元信息（批注 + 标题样式）测试
 *
 * 用 JSZip 现场拼最小 OPC 包，不依赖二进制夹具：每条用例只放自己要验的 XML 部件。
 */
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { anchorQuotes, parseComments, parseHeadingStyles, readDocxMeta, styleClassName } from './docx-meta'

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

const STYLES = `<w:styles ${NS}>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>
  <w:style w:type="paragraph" w:styleId="Sub"><w:name w:val="My Sub"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Body"><w:name w:val="Body"/><w:pPr><w:outlineLvl w:val="9"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1Child"><w:name w:val="H1 Child"/><w:basedOn w:val="Heading1"/></w:style>
  <w:style w:type="character" w:styleId="Heading3Char"><w:name w:val="heading 3"/></w:style>
</w:styles>`

const COMMENTS = `<w:comments ${NS}>
  <w:comment w:id="0" w:author="张三" w:date="2025-03-04T05:06:07Z"><w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:comment>
  <w:comment w:id="7" w:date="2025-03-05T00:00:00Z"><w:p><w:r><w:t>没署名</w:t></w:r></w:p></w:comment>
</w:comments>`

const DOCUMENT = `<w:document ${NS}><w:body>
  <w:p><w:r><w:t>前言不算</w:t></w:r></w:p>
  <w:p><w:commentRangeStart w:id="0"/><w:r><w:t>被批注的</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:t>范围外</w:t></w:r></w:p>
  <w:p><w:commentRangeStart w:id="7"/><w:r><w:t>跨段落开头</w:t></w:r></w:p>
  <w:p><w:r><w:t>跨段落结尾</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:t>之外</w:t></w:r></w:p>
</w:body></w:document>`

describe('styleClassName', () => {
  it('1. 与 docx-preview 的 class 规则一致：空格 / 点变连字符、& 变 and、转小写', () => {
    expect(styleClassName('kbdocx', 'Heading1')).toBe('kbdocx_heading1')
    expect(styleClassName('kbdocx', 'List Bullet.2')).toBe('kbdocx_list-bullet-2')
    expect(styleClassName('kbdocx', 'A&B')).toBe('kbdocx_aandb')
  })
})

describe('parseHeadingStyles', () => {
  const map = parseHeadingStyles(STYLES, 'kbdocx')

  it('2. 样式名 heading N 与样式 id 无关：id 是数字的 WPS 模板也认得', () => {
    expect(map.get('kbdocx_heading1')).toBe(1)
    expect(map.get('kbdocx_2')).toBe(2)
  })
  it('3. Title 算一级；显式 outlineLvl 从 0 起，9 是正文不算标题', () => {
    expect(map.get('kbdocx_title')).toBe(1)
    expect(map.get('kbdocx_sub')).toBe(3)
    expect(map.has('kbdocx_body')).toBe(false)
  })
  it('4. 继承链：基于标题样式派生的样式沿用级别；字符样式不算', () => {
    expect(map.get('kbdocx_heading1child')).toBe(1)
    expect(map.has('kbdocx_heading3char')).toBe(false)
  })
  it('5. XML 解析失败返回空表，不抛错', () => {
    expect(parseHeadingStyles('<w:styles', 'kbdocx').size).toBe(0)
  })
})

describe('parseComments / anchorQuotes', () => {
  it('6. 批注：作者、日期、多段正文用换行连接；没署名的显示「未署名」', () => {
    const items = parseComments(COMMENTS)
    expect(items).toEqual([
      { id: '0', author: '张三', date: '2025-03-04T05:06:07Z', text: '第一段\n第二段' },
      { id: '7', author: '未署名', date: '2025-03-05T00:00:00Z', text: '没署名' },
    ])
  })
  it('7. 锚点原文：只取范围之内的文字，范围可以跨段落', () => {
    const quotes = anchorQuotes(DOCUMENT, new Set(['0', '7']))
    expect(quotes.get('0')).toBe('被批注的')
    expect(quotes.get('7')).toBe('跨段落开头跨段落结尾')
  })
  it('8. 原文片段最多 80 字', () => {
    const long = `<w:document ${NS}><w:body><w:p><w:commentRangeStart w:id="1"/><w:r><w:t>${'字'.repeat(300)}</w:t></w:r><w:commentRangeEnd w:id="1"/></w:p></w:body></w:document>`
    expect(anchorQuotes(long, new Set(['1'])).get('1')!.length).toBe(80)
  })
})

describe('readDocxMeta', () => {
  async function pack(parts: Record<string, string>): Promise<ArrayBuffer> {
    const zip = new JSZip()
    for (const [path, xml] of Object.entries(parts)) zip.file(path, xml)
    return zip.generateAsync({ type: 'arraybuffer' })
  }

  it('9. 从包里读出批注（带原文片段）和标题 class 表', async () => {
    const meta = await readDocxMeta(await pack({ 'word/styles.xml': STYLES, 'word/comments.xml': COMMENTS, 'word/document.xml': DOCUMENT }), 'kbdocx')
    expect(meta.comments.map((item) => [item.id, item.quote])).toEqual([
      ['0', '被批注的'],
      ['7', '跨段落开头跨段落结尾'],
    ])
    expect(meta.headingClasses.get('kbdocx_heading1')).toBe(1)
  })
  it('10. 没有批注部件：批注为空，也不去读 document.xml', async () => {
    const meta = await readDocxMeta(await pack({ 'word/styles.xml': STYLES }), 'kbdocx')
    expect(meta.comments).toEqual([])
    expect(meta.headingClasses.size).toBeGreaterThan(0)
  })
  it('11. 不是合法的 zip：返回空元信息而不是抛错（渲染失败由 docx-preview 报）', async () => {
    const meta = await readDocxMeta(new TextEncoder().encode('not a zip').buffer as ArrayBuffer, 'kbdocx')
    expect(meta.comments).toEqual([])
    expect(meta.headingClasses.size).toBe(0)
  })
})
