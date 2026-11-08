// Word 样式瘦身：只去没人用的样式，被引用的 / 默认的 / 被它们依赖的一个不少，其它部件字节不变。
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { PRUNE_MIN_STYLES_CHARS, pruneDocx, pruneUnusedStyles, STYLES_PATH } from './docx-prune'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
/** 一个段落样式；padding 让样式表够大（超过瘦身下限） */
const style = (id: string, extra = '', attrs = 'w:type="paragraph"') =>
  `<w:style ${attrs} w:styleId="${id}"><w:name w:val="${id}"/>${extra}<w:pPr><w:spacing w:after="${'0'.repeat(1)}"/></w:pPr><w:rPr><w:sz w:val="22"/></w:rPr></w:style>`

/** 造一份样式表：defaults 个默认样式 + used 里列出的样式 + 一大堆没人用的 */
function makeStyles(parts: string[], filler = 400): string {
  const unused = Array.from({ length: filler }, (_, i) => style(`Unused${i}`, '<w:uiPriority w:val="99"/>'))
  return `<?xml version="1.0"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults><w:latentStyles w:count="1"/>${[...parts, ...unused].join('')}</w:styles>`
}

async function makeDocx(files: Record<string, string>): Promise<ArrayBuffer> {
  const zip = new JSZip()
  for (const [name, text] of Object.entries(files)) zip.file(name, text)
  return zip.generateAsync({ type: 'arraybuffer' })
}
const idsOf = (xml: string) => [...xml.matchAll(/w:styleId="([^"]*)"/g)].map((match) => match[1]!)

const DOC = `<w:document ${W}><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:rStyle w:val="Strong"/></w:rPr><w:t>标题</w:t></w:r></w:p><w:tbl><w:tblPr><w:tblStyle w:val="Grid"/></w:tblPr></w:tbl></w:body></w:document>`

describe('pruneUnusedStyles', () => {
  it('只留被正文引用的、默认的，以及它们 basedOn / link / next 依赖的样式', async () => {
    const styles = makeStyles([
      style('Normal', '', 'w:type="paragraph" w:default="1"'),
      style('Base', ''),
      style('Heading1', '<w:basedOn w:val="Base"/><w:next w:val="Body"/><w:link w:val="Heading1Char"/>'),
      style('Body', ''),
      style('Heading1Char', '', 'w:type="character"'),
      style('Strong', '', 'w:type="character"'),
      style('Grid', '', 'w:type="table"'),
      style('NumLinked', '', 'w:type="numbering"'),
    ])
    expect(styles.length).toBeGreaterThan(PRUNE_MIN_STYLES_CHARS)
    const zip = await JSZip.loadAsync(
      await makeDocx({
        [STYLES_PATH]: styles,
        'word/document.xml': DOC,
        // 只有编号部件提到的样式也算用到了
        'word/numbering.xml': `<w:numbering ${W}><w:abstractNum><w:lvl><w:pStyle w:val="NumLinked"/></w:lvl></w:abstractNum></w:numbering>`,
      }),
    )
    const result = await pruneUnusedStyles(zip)
    expect(result).not.toBeNull()
    expect(new Set(idsOf(result!.xml))).toEqual(new Set(['Normal', 'Base', 'Heading1', 'Body', 'Heading1Char', 'Strong', 'Grid', 'NumLinked']))
    expect(result!.removed).toBe(400)
    // 样式以外的内容原样保留
    expect(result!.xml).toContain('<w:docDefaults>')
    expect(result!.xml).toContain('<w:latentStyles w:count="1"/>')
    expect(result!.xml.length).toBeLessThan(styles.length * 0.2)
  })

  it('页眉 / 脚注里引用的样式也算用到（不只看 document.xml）', async () => {
    const styles = makeStyles([style('HeaderStyle', ''), style('NoteStyle', '')])
    const zip = await JSZip.loadAsync(
      await makeDocx({
        [STYLES_PATH]: styles,
        'word/document.xml': `<w:document ${W}><w:body/></w:document>`,
        'word/header1.xml': `<w:hdr ${W}><w:p><w:pPr><w:pStyle w:val="HeaderStyle"/></w:pPr></w:p></w:hdr>`,
        'word/footnotes.xml': `<w:footnotes ${W}><w:footnote><w:p><w:pPr><w:pStyle w:val='NoteStyle'/></w:pPr></w:p></w:footnote></w:footnotes>`,
      }),
    )
    const result = await pruneUnusedStyles(zip)
    expect(new Set(idsOf(result!.xml))).toEqual(new Set(['HeaderStyle', 'NoteStyle']))
  })

  it('正文里有带撇号的文字 / 属性值也不会让后面的样式引用漏掉（引号配对错位的回归）', async () => {
    const styles = makeStyles([style('AfterApostrophe'), style('InValue', '', 'w:type="character"'), style('PlainText')])
    const doc = [
      `<w:document ${W}><w:body>`,
      `<w:p><w:r><w:t>it's l'étude "quoted"</w:t></w:r></w:p>`,
      // 属性值里带单引号：成对匹配会把后面所有引号错开一位
      `<w:p><w:r><w:instrText w:val="l'x"/></w:r></w:p>`,
      `<w:p><w:pPr><w:pStyle w:val="AfterApostrophe"/></w:pPr><w:r><w:rPr><w:rStyle w:val="InValue"/></w:rPr></w:r></w:p>`,
      `<w:p><w:pPr><w:pStyle w:val="PlainText"/></w:pPr></w:p>`,
      `</w:body></w:document>`,
    ].join('')
    const zip = await JSZip.loadAsync(await makeDocx({ [STYLES_PATH]: styles, 'word/document.xml': doc }))
    const result = await pruneUnusedStyles(zip)
    expect(new Set(idsOf(result!.xml))).toEqual(new Set(['AfterApostrophe', 'InValue', 'PlainText']))
  })

  it('样式表不大 / 去不掉多少 / 没有样式表：不动（返回 null）', async () => {
    const small = await JSZip.loadAsync(await makeDocx({ [STYLES_PATH]: makeStyles([style('A')], 3), 'word/document.xml': DOC }))
    expect(await pruneUnusedStyles(small)).toBeNull()
    // 几乎全被用到：去掉的不到 20%
    const used = Array.from({ length: 300 }, (_, i) => style(`S${i}`))
    const doc = `<w:document ${W}><w:body>${used.map((_, i) => `<w:p><w:pPr><w:pStyle w:val="S${i}"/></w:pPr></w:p>`).join('')}</w:body></w:document>`
    const allUsed = await JSZip.loadAsync(await makeDocx({ [STYLES_PATH]: makeStyles(used, 2), 'word/document.xml': doc }))
    expect(await pruneUnusedStyles(allUsed)).toBeNull()
    expect(await pruneUnusedStyles(await JSZip.loadAsync(await makeDocx({ 'word/document.xml': DOC })))).toBeNull()
  })
})

describe('pruneDocx', () => {
  it('输出仍是合法的 docx：styles.xml 变小，其它部件内容逐字不变', async () => {
    const styles = makeStyles([style('Normal', '', 'w:type="paragraph" w:default="1"'), style('Heading1'), style('Strong', '', 'w:type="character"'), style('Grid', '', 'w:type="table"')])
    const files = {
      '[Content_Types].xml': '<Types/>',
      [STYLES_PATH]: styles,
      'word/document.xml': DOC,
      'word/settings.xml': '<w:settings/>',
    }
    const out = await pruneDocx(await makeDocx(files))
    expect(out).not.toBeNull()
    const zip = await JSZip.loadAsync(out!)
    for (const name of ['[Content_Types].xml', 'word/document.xml', 'word/settings.xml']) expect(await zip.file(name)!.async('string')).toBe(files[name as keyof typeof files])
    const pruned = await zip.file(STYLES_PATH)!.async('string')
    expect(pruned.length).toBeLessThan(styles.length / 4)
    expect(new Set(idsOf(pruned))).toEqual(new Set(['Normal', 'Heading1', 'Strong', 'Grid']))
  })

  it('不是 zip：返回 null，交给 docx-preview 自己报错', async () => {
    expect(await pruneDocx(new TextEncoder().encode('not a zip').buffer as ArrayBuffer)).toBeNull()
  })
})
