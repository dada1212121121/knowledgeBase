/** Word 字体能力判断单测：每一类字体各一条，外加"静默替换"这个要防的坏结果。 */
import { describe, expect, it } from 'vitest'
import { fontNotice, judgeFont, reportFonts, type MetricResolver } from './fontReport'

/** 和 @betteroffice/fonts 的真实别名表对齐的一小份（e2e 里用真包再验一遍） */
const TABLE: Record<string, string> = {
  calibri: 'Carlito',
  arial: 'Liberation Sans',
  'times new roman': 'Liberation Serif',
  宋体: 'Noto Serif SC',
  微软雅黑: 'Noto Sans SC',
}
const resolve: MetricResolver = (family) => TABLE[family.trim().toLowerCase()]

describe('judgeFont', () => {
  it('度量兼容的拉丁字体：exact，显示成随包字体', () => {
    expect(judgeFont('Calibri', resolve)).toEqual({ family: 'Calibri', support: 'exact', rendersAs: 'Carlito' })
    expect(judgeFont('Times New Roman', resolve).rendersAs).toBe('Liberation Serif')
  })

  it('族名大小写、首尾空白不影响命中', () => {
    expect(judgeFont('  ARIAL ', resolve).support).toBe('exact')
  })

  it('宋体：包里解析成衬线，但站点实际画思源黑体子集——按站点实际说', () => {
    const verdict = judgeFont('宋体', resolve)
    expect(verdict.support).toBe('approximate')
    expect(verdict.rendersAs).toContain('思源黑体')
    expect(verdict.rendersAs).not.toContain('Serif')
  })

  it('包里没有、但名字带汉字的未知字体：按全角近似，不算缺失', () => {
    expect(judgeFont('华康少女体', resolve).support).toBe('approximate')
  })

  it('包里没有的拉丁字体：missing，回退字体写明', () => {
    expect(judgeFont('Verdana', resolve)).toEqual({ family: 'Verdana', support: 'missing', rendersAs: 'Carlito' })
    expect(judgeFont('Consolas', resolve).support).toBe('missing')
  })

  it('符号字体（Symbol / Wingdings）：symbol，不算缺失——否则每份带项目符号定义的文档都会误报', () => {
    for (const family of ['Symbol', 'Wingdings', 'Wingdings 2', 'Webdings', ' SYMBOL ']) expect(judgeFont(family, resolve).support, family).toBe('symbol')
  })

  it('文档内嵌的字体：embedded，优先于包里的别名', () => {
    expect(judgeFont('Verdana', resolve, new Set(['verdana'])).support).toBe('embedded')
    expect(judgeFont('Calibri', resolve, new Set(['calibri'])).support).toBe('embedded')
  })
})

describe('reportFonts / fontNotice', () => {
  it('只含 exact / approximate：不需要提示（不打扰）', () => {
    const report = reportFonts(['Calibri', '宋体', '微软雅黑'], resolve)
    expect(report.needsNotice).toBe(false)
    expect(report.approximate.map((item) => item.family)).toEqual(['宋体', '微软雅黑'])
    expect(fontNotice(report)).toBe('')
  })

  it('含缺失字体：需要提示，且点名字体、写明替代和后果', () => {
    const report = reportFonts(['Calibri', 'Verdana', 'Tahoma'], resolve)
    expect(report.needsNotice).toBe(true)
    const text = fontNotice(report)
    expect(text).toContain('「Verdana」')
    expect(text).toContain('「Tahoma」')
    expect(text).toContain('Carlito')
    expect(text).toContain('分页')
  })

  it('只含符号字体：不需要提示（Word 默认模板的 numbering.xml 总带着 Symbol 定义）', () => {
    const report = reportFonts(['Calibri', 'Symbol', 'Wingdings'], resolve)
    expect(report.needsNotice).toBe(false)
    expect(report.missing).toEqual([])
    expect(fontNotice(report)).toBe('')
  })

  it('符号字体和真正缺失的字体并存：只点名真正缺失的', () => {
    const text = fontNotice(reportFonts(['Symbol', 'Verdana'], resolve))
    expect(text).toContain('「Verdana」')
    expect(text).not.toContain('Symbol')
  })

  it('同一个字体重复出现（粗体/斜体各一条需求）只算一次', () => {
    const report = reportFonts(['Verdana', 'verdana', ' Verdana '], resolve)
    expect(report.missing).toHaveLength(1)
  })

  it('缺失很多时只列前几个并写总数', () => {
    const names = ['A1', 'B2', 'C3', 'D4', 'E5', 'F6']
    expect(fontNotice(reportFonts(names, resolve))).toContain('等 6 种')
  })

  it('内嵌的字体不算缺失，即使包里没有', () => {
    const report = reportFonts(['Verdana'], resolve, ['Verdana'])
    expect(report.needsNotice).toBe(false)
    expect(report.verdicts[0]!.support).toBe('embedded')
  })

  it('空族名被忽略', () => {
    expect(reportFonts(['', '  '], resolve).verdicts).toEqual([])
  })
})

describe('文档用到没有字体的文字区域', () => {
  it('繁体 / 韩文 / 阿拉伯文 / 希伯来文：需要提示，点名是哪几种，并说明是字画不出来、文件内容不受影响', () => {
    const report = reportFonts(['Calibri'], resolve, [], ['latin', 'cjk-sc', 'cjk-tc', 'cjk-kr', 'cjk-tc'])
    expect(report.unavailableScripts).toEqual(['cjk-tc', 'cjk-kr'])
    expect(report.needsNotice).toBe(true)
    const text = fontNotice(report)
    expect(text).toContain('繁体中文、韩文')
    expect(text).toContain('空框')
    expect(text).toContain('文件内容不受影响')
  })

  it('简体 / 日文 / 拉丁有字体：不提示', () => {
    const report = reportFonts(['Calibri', '宋体'], resolve, [], ['latin', 'cjk-sc', 'cjk-jp'])
    expect(report.unavailableScripts).toEqual([])
    expect(report.needsNotice).toBe(false)
    expect(fontNotice(report)).toBe('')
  })

  it('字体缺失和文字区域缺失并存：两句话都说', () => {
    const text = fontNotice(reportFonts(['Verdana'], resolve, [], ['arabic']))
    expect(text).toContain('「Verdana」')
    expect(text).toContain('阿拉伯文')
  })
})

describe('斜体没有随站点提供的字体面', () => {
  const noItalic = () => true
  it('有字体但没有斜体面的族用了斜体：提示会显示成正体；没用斜体不提示', () => {
    const report = reportFonts(['Calibri', 'Arial'], resolve, [], [], ['Calibri'], noItalic)
    expect(report.upright).toEqual(['Calibri'])
    expect(report.needsNotice).toBe(true)
    expect(fontNotice(report)).toContain('「Calibri」的斜体没有对应字体')
    expect(fontNotice(report)).toContain('正体')
    expect(reportFonts(['Calibri'], resolve, [], [], [], noItalic).needsNotice).toBe(false)
  })

  it('缺失的族已经单独说了、内嵌的字体用文档自带的面：都不再重复说斜体', () => {
    expect(reportFonts(['Verdana'], resolve, [], [], ['Verdana'], noItalic).upright).toEqual([])
    expect(reportFonts(['Calibri'], resolve, ['Calibri'], [], ['Calibri'], noItalic).upright).toEqual([])
  })

  it('族有斜体面时不提示；同一族的斜体 / 粗斜体两条需求只说一次', () => {
    expect(reportFonts(['Calibri'], resolve, [], [], ['Calibri'], () => false).upright).toEqual([])
    expect(reportFonts(['Calibri'], resolve, [], [], ['Calibri', ' Calibri'], noItalic).upright).toEqual(['Calibri'])
  })
})

describe('与字体包真实别名表、随站点提供的精选字体对照', () => {
  // 假 resolver 只能证明逻辑；这里用 @betteroffice/fonts 的真函数 + 站点真正提供的字体集钉住"哪些字体有替代"，
  // 包升级后别名表变了、或精选字体集改了，这条会红灯提醒我们同步提示文案和夹具
  it('常见 Word 字体的结论：随站点提供的是 exact，没提供的（等宽 / Georgia / Segoe UI …）如实说缺失', async () => {
    const fonts = await import('@betteroffice/fonts')
    const { resolveShippedFamily } = await import('../fonts/docxFonts')
    const real: MetricResolver = (family) => resolveShippedFamily(fonts, family)
    const support = (family: string) => judgeFont(family, real).support
    for (const family of ['Calibri', 'Arial', 'Times New Roman']) expect(support(family), family).toBe('exact')
    for (const family of ['宋体', '微软雅黑', '黑体', '楷体', '仿宋', '等线']) expect(support(family), family).toBe('approximate')
    // 上游字体包有、但没有随站点提供的：不能冒充"有替代"
    for (const family of ['Cambria', 'Courier New', 'Georgia', 'Segoe UI', 'Comic Sans MS']) expect(support(family), family).toBe('missing')
    // 夹具 doc-fonts.docx 依赖这几个"没有替代"的字体：若包新增了它们，e2e 夹具要换
    for (const family of ['Verdana', 'Consolas', 'Tahoma', 'Impact']) expect(support(family), family).toBe('missing')
    // Symbol 包里没有替代，但按符号字体处理，不报缺失
    expect(support('Symbol')).toBe('symbol')
    expect(support('Wingdings')).toBe('symbol')
  })

  it('随站点提供的拉丁族都没有斜体面（精选集只有常规 / 粗体）', async () => {
    const fonts = await import('@betteroffice/fonts')
    const { lacksItalic } = await import('../fonts/docxFonts')
    for (const family of ['Calibri', 'Arial', 'Times New Roman']) expect(lacksItalic(fonts, family), family).toBe(true)
    // 上游根本不认识的族不归这里说（那是「缺失」）
    expect(lacksItalic(fonts, 'Verdana')).toBe(false)
  })

  it('docxFonts 的「没有字体的文字区域」与 fontReport 的名单是同一份', async () => {
    const { UNAVAILABLE_SCRIPTS } = await import('../fonts/docxFonts')
    const { UNAVAILABLE_SCRIPT_LABELS } = await import('./fontReport')
    expect([...UNAVAILABLE_SCRIPTS].sort()).toEqual(Object.keys(UNAVAILABLE_SCRIPT_LABELS).sort())
  })
})
