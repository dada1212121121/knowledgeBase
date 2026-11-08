/** Word 内容清点与探针判定单测：引擎改写后"少了东西"必须被发现；多出来的不算。 */
import { describe, expect, it } from 'vitest'
import { EXPECTED_EDIT_PARTS, inventoryOf, lossBetween, PROBE_MARKER, verdictFromProbe, type ProbeServerReport } from './docxInventory'

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'

const doc = (body: string) => `<w:document ${NS}><w:body>${body}</w:body></w:document>`
const para = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
/** 一个带 VML 兜底的浮动形状：Choice 里是 DrawingML，Fallback 里重复了同样的名字和文字 */
const shape = (name: string, id: number, text: string) =>
  `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><wp:docPr id="${id}" name="${name}"/>` +
  `<w:txbxContent><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:txbxContent></wp:anchor></w:drawing></mc:Choice>` +
  `<mc:Fallback><w:pict><w:txbxContent><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`

const server = (over: Partial<ProbeServerReport> = {}): ProbeServerReport => ({ valid: true, reason: null, changed_parts: ['word/document.xml'], removed_parts: [], added_parts: [], ...over })

describe('inventoryOf', () => {
  it('文字按顺序拼接，Fallback 里重复的内容不计', () => {
    const inventory = inventoryOf(doc(para('甲') + shape('椭圆 32', 32, '乙') + para('丙')))
    expect(inventory.text).toBe('甲乙丙')
    expect(inventory.shapes).toEqual(['椭圆 32'])
  })

  it('统计表格 / 行 / 格 / 超链接 / 域 / 分页符等', () => {
    const body =
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl>' +
      '<w:p><w:hyperlink><w:r><w:t>链</w:t></w:r></w:hyperlink><w:r><w:fldChar/></w:r><w:r><w:br w:type="page"/></w:r></w:p>'
    const { counts } = inventoryOf(doc(body))
    expect(counts).toMatchObject({ 表格: 1, 表格行: 1, 单元格: 2, 超链接: 1, 域: 1, 分页符: 1 })
    expect(counts['段落']).toBe(3)
  })

  it('不合法的 XML 抛错（调用方按"不能证明无损"处理）', () => {
    expect(() => inventoryOf('<w:document><w:body></w:document>')).toThrow()
  })
})

describe('lossBetween', () => {
  const original = inventoryOf(doc(para('你好') + shape('椭圆 32', 32, '收费') + shape('图片 1', 1, '')))

  it('探针只多了一个标记字符：没有丢失', () => {
    const probe = inventoryOf(doc(para(`${PROBE_MARKER}你好`) + shape('椭圆 32', 32, '收费') + shape('图片 1', 1, '')))
    expect(lossBetween(original, probe)).toEqual({ reasons: [], textChanged: false })
  })

  it('引擎去掉 Fallback、补了段落属性：不算丢', () => {
    const probe = inventoryOf(doc(`<w:p w:rsidR="1"><w:r><w:t>${PROBE_MARKER}你好</w:t></w:r></w:p>` + shape('椭圆 32', 32, '收费') + shape('图片 1', 1, '')))
    expect(lossBetween(original, probe).reasons).toEqual([])
  })

  it('形状不见了（流程图那次的真实情形）', () => {
    const probe = inventoryOf(doc(para(`${PROBE_MARKER}你好`) + shape('图片 1', 1, '')))
    const loss = lossBetween(original, probe)
    expect(loss.reasons.some((reason) => reason.includes('少了 1 个') && reason.includes('椭圆 32'))).toBe(true)
    // 形状里的文字也在正文文字里，丢形状必然同时丢字
    expect(loss.textChanged).toBe(true)
  })

  it('引擎把重写的图片改名重建（图片 7 → Picture 1372585881，id 也变）不算丢——按个数比，不按名称（18 份真实文档里 3 份是这样）', () => {
    const probe = inventoryOf(doc(para(`${PROBE_MARKER}你好`) + shape('椭圆 32', 99, '收费') + shape('Picture 1372585881', 1372585881, '')))
    expect(lossBetween(original, probe).reasons).toEqual([])
  })

  it('同名形状按个数比：3 个剩 2 个算丢', () => {
    const three = inventoryOf(doc(shape('图片', 1, '') + shape('图片', 2, '') + shape('图片', 3, '')))
    const two = inventoryOf(doc(shape('图片', 1, '') + shape('图片', 2, '')))
    expect(lossBetween(three, two).reasons.join()).toContain('少了 1 个')
    expect(lossBetween(two, three).reasons).toEqual([])
  })

  it('文字少了：说明少了几个字和大约位置', () => {
    const probe = inventoryOf(doc(para(`${PROBE_MARKER}你`) + shape('椭圆 32', 32, '收费') + shape('图片 1', 1, '')))
    const loss = lossBetween(original, probe)
    expect(loss.textChanged).toBe(true)
    expect(loss.reasons[0]).toContain('少了 1 个字')
  })

  it('表格 / 超链接 / 域少了都报；多了不报', () => {
    const rich = inventoryOf(doc('<w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl><w:p><w:hyperlink><w:r><w:t>x</w:t></w:r></w:hyperlink></w:p>'))
    const flat = inventoryOf(doc(para('x')))
    const reasons = lossBetween(rich, flat).reasons.join()
    expect(reasons).toContain('表格少了')
    expect(reasons).toContain('超链接少了')
    expect(lossBetween(flat, rich).reasons.join()).not.toContain('表格')
  })
})

describe('verdictFromProbe', () => {
  const base = inventoryOf(doc(para('正文')))
  const probe = inventoryOf(doc(para(`${PROBE_MARKER}正文`)))

  it('只改了正文：可以编辑', () => {
    expect(verdictFromProbe(server(), base, probe)).toMatchObject({ editable: 'yes', losses: [], rewritten: [] })
  })

  it('文档属性也变是预期内的（第一次保存会加 core.xml）', () => {
    expect(verdictFromProbe(server({ changed_parts: ['word/document.xml', 'docProps/core.xml'] }), base, probe).editable).toBe('yes')
    expect(verdictFromProbe(server({ added_parts: ['docProps/core.xml'] }), base, probe).editable).toBe('yes')
    expect(EXPECTED_EDIT_PARTS).toContain('docProps/core.xml')
  })

  it('页脚等别的部件被改写、文字都在：只读并允许"仍然编辑"', () => {
    const verdict = verdictFromProbe(server({ changed_parts: ['word/document.xml', 'word/footer1.xml'] }), base, probe)
    expect(verdict).toMatchObject({ editable: 'force', rewritten: ['word/footer1.xml'], losses: [] })
  })

  it('内容丢了：不能编辑（优先于"改写别的部件"）', () => {
    const lost = inventoryOf(doc(para(`${PROBE_MARKER}正`)))
    const verdict = verdictFromProbe(server({ changed_parts: ['word/footer1.xml'] }), base, lost)
    expect(verdict.editable).toBe('no')
    expect(verdict.losses.length).toBeGreaterThan(0)
  })

  it('部件被丢掉：不能编辑', () => {
    const verdict = verdictFromProbe(server({ removed_parts: ['word/customXml/item1.xml'] }), base, probe)
    expect(verdict.editable).toBe('no')
    expect(verdict.losses.join()).toContain('customXml/item1.xml')
  })

  it('保存出来不是完整的包：不能编辑，带着服务端给的原因', () => {
    const verdict = verdictFromProbe(server({ valid: false, reason: '缺少 [Content_Types].xml' }), base, probe)
    expect(verdict).toMatchObject({ editable: 'no', valid: false, reason: '缺少 [Content_Types].xml' })
  })
})
