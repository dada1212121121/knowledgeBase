/**
 * 剪贴板编解码测试
 *
 * 表格复制粘贴最容易坏在「引号里的换行」和「末尾空列」：一坏就会把整张表错位。
 * 这里把这两类边界以及 Excel 的 HTML 剪贴板都钉住。
 */
import { describe, expect, it } from 'vitest'
import { isFormula, parseClipboard, parseDelimited, parseHtmlTable, pasteMatrix, serializeHtml, serializeTsv } from './clipboard'

describe('parseDelimited', () => {
  it('1. 基础 TSV：行列与空单元格', () => {
    expect(parseDelimited('a\tb\nc\td')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
    expect(parseDelimited('a\t\tb')).toEqual([['a', '', 'b']])
  })

  it('2. CRLF 与末尾换行不产生多余空行', () => {
    expect(parseDelimited('a\tb\r\nc\td\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('3. 中间的空白行保留，末尾空白行去掉', () => {
    expect(parseDelimited('a\n\nb\n\n')).toEqual([['a'], [''], ['b']])
  })

  it('4. 引号字段里的分隔符与换行不被拆开', () => {
    expect(parseDelimited('"a\tb"\t"c\nd"\n')).toEqual([['a\tb', 'c\nd']])
  })

  it('5. 双引号转义', () => {
    expect(parseDelimited('"say ""hi"""\t"x"')).toEqual([['say "hi"', 'x']])
  })

  it('6. CSV 分隔符可切换，且不误拆引号内的逗号', () => {
    expect(parseDelimited('a,b\n"1,2",3', ',')).toEqual([
      ['a', 'b'],
      ['1,2', '3'],
    ])
  })

  it('7. 空字符串得到空矩阵', () => {
    expect(parseDelimited('')).toEqual([])
  })
})

describe('serializeTsv', () => {
  it('8. 普通单元格按 TSV 拼接', () => {
    expect(serializeTsv([['a', 'b'], ['c', 'd']])).toBe('a\tb\nc\td')
  })

  it('9. 含制表符 / 换行 / 引号的字段被转义', () => {
    expect(serializeTsv([['a\tb', 'c\nd', 'say "hi"']])).toBe('"a\tb"\t"c\nd"\t"say ""hi"""')
  })

  it('10. 与解析器往返一致（含空单元格）', () => {
    const matrix = [
      ['a', '', 'c,d'],
      ['x\ty', 'say "hi"', 'line1\nline2'],
    ]
    expect(parseDelimited(serializeTsv(matrix))).toEqual(matrix)
  })
})

describe('HTML 剪贴板', () => {
  it('11. serializeHtml 转义标签字符并保留换行', () => {
    const html = serializeHtml([['<script>', 'a & b'], ['line1\nline2', '']])
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('a &amp; b')
    expect(html).toContain('line1<br>line2')
  })

  it('12. parseHtmlTable 读取第一张表并跳过嵌套噪声', () => {
    const html = '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td><b>2</b></td></tr></table>'
    expect(parseHtmlTable(html)).toEqual([
      ['A', 'B'],
      ['1', '2'],
    ])
    expect(parseHtmlTable('<p>no table</p>')).toEqual([])
  })

  it('13. parseClipboard 优先文本，单格文本才回退 HTML', () => {
    const table = '<table><tr><td>1</td><td>2</td></tr></table>'
    expect(parseClipboard('a\tb', table)).toEqual([['a', 'b']])
    expect(parseClipboard('only', table)).toEqual([
      ['1', '2'],
    ])
  })
})

describe('粘贴与公式', () => {
  it('14. pasteMatrix 相对起点展开，保留空值', () => {
    expect(
      pasteMatrix(
        [
          ['a', ''],
          ['b', 'c'],
        ],
        { row: 2, col: 3 },
      ),
    ).toEqual([
      { row: 2, col: 3, text: 'a' },
      { row: 2, col: 4, text: '' },
      { row: 3, col: 3, text: 'b' },
      { row: 3, col: 4, text: 'c' },
    ])
  })

  it('15. 只有以 = 开头的才当公式', () => {
    expect(isFormula('=SUM(A1:A2)')).toBe(true)
    expect(isFormula(' =SUM(A1:A2)')).toBe(false)
    expect(isFormula('')).toBe(false)
  })
})
