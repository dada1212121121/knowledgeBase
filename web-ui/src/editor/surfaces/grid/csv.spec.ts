/**
 * CSV 网格适配器
 *
 * 适配器把 codec 的不可变文档接到 Grid 的编辑/撤销接口上：
 * 编辑只追加一次补丁，撤销恢复旧文档引用，快照永远从原始文本序列化。
 */
import { describe, expect, it } from 'vitest'
import type { EditorSource } from '../../types'
import { CsvGridAdapter } from './csv'

const SOURCE: EditorSource = {
  kind: 'text',
  name: 'a.csv',
  text: '\uFEFF姓名,年龄\r\n张三,30\r\n李四,28\r\n',
}

describe('CsvGridAdapter', () => {
  it('1. 打开后快照逐字节等于原件，编辑前不脏', () => {
    const adapter = new CsvGridAdapter(SOURCE)
    expect(adapter.snapshot().text).toBe(SOURCE.text)
    expect(adapter.readonly()).toBe(false)
    expect(adapter.sheets()[0].cell(0, 0)?.text).toBe('姓名')
  })

  it('2. apply 改一格：只动那一格，版本递增，快照保留 BOM/CRLF', () => {
    const adapter = new CsvGridAdapter(SOURCE)
    expect(adapter.apply([{ row: 1, col: 1, text: '31' }])).toBe(true)
    expect(adapter.revision()).toBe(1)
    expect(adapter.snapshot().text).toBe('\uFEFF姓名,年龄\r\n张三,31\r\n李四,28\r\n')
    expect(adapter.sheets()[0].cell(1, 1)?.text).toBe('31')
  })

  it('3. 改成原值不置版本 / 不产生撤销步', () => {
    const adapter = new CsvGridAdapter(SOURCE)
    expect(adapter.apply([{ row: 1, col: 1, text: '30' }])).toBe(false)
    expect(adapter.revision()).toBe(0)
    expect(adapter.undo()).toBe(false)
  })

  it('4. undo / redo 按文档快照回放，多次编辑也能逐步回退', () => {
    const adapter = new CsvGridAdapter(SOURCE)
    adapter.apply([{ row: 1, col: 1, text: '31' }])
    adapter.apply([{ row: 1, col: 0, text: '张三丰' }])
    expect(adapter.undo()).toBe(true)
    expect(adapter.sheets()[0].cell(1, 0)?.text).toBe('张三')
    expect(adapter.undo()).toBe(true)
    expect(adapter.sheets()[0].cell(1, 1)?.text).toBe('30')
    expect(adapter.undo()).toBe(false)
    expect(adapter.redo()).toBe(true)
    expect(adapter.sheets()[0].cell(1, 1)?.text).toBe('31')
  })

  it('5. 新编辑清空 redo 栈，不会重做出一条岔路', () => {
    const adapter = new CsvGridAdapter(SOURCE)
    adapter.apply([{ row: 1, col: 1, text: '31' }])
    adapter.undo()
    adapter.apply([{ row: 2, col: 1, text: '29' }])
    expect(adapter.redo()).toBe(false)
  })

  it('6. 追加行沿用原文行尾并保留末行换行习惯', () => {
    const adapter = new CsvGridAdapter(SOURCE)
    expect(adapter.appendRow(['王五', '26'])).toBe(true)
    expect(adapter.snapshot().text.endsWith('李四,28\r\n王五,26\r\n')).toBe(true)
  })

  it('7. 超过 20 万行：只读，apply / append 都拒绝', () => {
    const rows = Array.from({ length: 200_001 }, (_, index) => `r${index},${index}`).join('\n')
    const adapter = new CsvGridAdapter({ kind: 'text', name: 'big.csv', text: `a,b\n${rows}\n` })
    expect(adapter.readonly()).toBe(true)
    expect(adapter.apply([{ row: 0, col: 0, text: 'x' }])).toBe(false)
    expect(adapter.appendRow(['x', 'y'])).toBe(false)
  })

  it('8. 空表也有合法网格，不因 0 行崩掉', () => {
    const adapter = new CsvGridAdapter({ kind: 'text', name: 'empty.csv', text: '' })
    const sheet = adapter.sheets()[0]
    expect(sheet.rowCount).toBe(0)
    expect(sheet.colCount).toBe(1)
    expect(adapter.snapshot().text).toBe('')
  })

  it('9. 删除若干行：只动那几行的字节，撤销 / 重做回放', () => {
    const adapter = new CsvGridAdapter({ kind: 'text', name: 'a.csv', text: 'a,b\n1,2\n3,4\n5,6\n' })
    expect(adapter.deleteRows(1, 2)).toBe(true)
    expect(adapter.snapshot().text).toBe('a,b\n5,6\n')
    expect(adapter.sheets()[0].rowCount).toBe(2)
    expect(adapter.undo()).toBe(true)
    expect(adapter.snapshot().text).toBe('a,b\n1,2\n3,4\n5,6\n')
    expect(adapter.redo()).toBe(true)
    expect(adapter.snapshot().text).toBe('a,b\n5,6\n')
    expect(adapter.deleteRows(9, 9)).toBe(false)
  })

  it('10. 删最后一行：末尾没有换行的习惯保持不变', () => {
    const adapter = new CsvGridAdapter({ kind: 'text', name: 'a.csv', text: 'a,b\r\n1,2\r\n3,4' })
    adapter.deleteRows(2, 2)
    expect(adapter.snapshot().text).toBe('a,b\r\n1,2')
  })

  it('11. 插入空行：视图多一行带底色的空行，文本一个字节不变；撤销回到原样', () => {
    const adapter = new CsvGridAdapter({ kind: 'text', name: 'a.csv', text: 'a,b\n1,2\n' })
    expect(adapter.insertRows(1, 2)).toBe(true)
    const sheet = adapter.sheets()[0]
    expect(sheet.rowCount).toBe(4)
    expect(sheet.cell(1, 0)).toMatchObject({ text: '', background: expect.any(String) })
    expect(sheet.cell(3, 0)?.text).toBe('1')
    expect(adapter.snapshot().text).toBe('a,b\n1,2\n')
    expect(adapter.undo()).toBe(true)
    expect(adapter.sheets()[0].rowCount).toBe(2)
    expect(adapter.redo()).toBe(true)
    expect(adapter.sheets()[0].rowCount).toBe(4)
  })

  it('12. 往空行里填内容才写进文本，位置在被点的那一行之前；其余空行留着', () => {
    const adapter = new CsvGridAdapter({ kind: 'text', name: 'a.csv', text: 'a,b\n1,2\n3,4\n' })
    adapter.insertRows(2, 2) // 视图：a / 1 / 空 / 空 / 3
    expect(adapter.apply([{ row: 3, col: 1, text: 'Y' }])).toBe(true)
    // 填的是第二个空行：文本里它插在「3,4」之前，第一个空行仍在它上面（还没写）
    expect(adapter.snapshot().text).toBe('a,b\n1,2\n,Y\n3,4\n')
    const sheet = adapter.sheets()[0]
    expect(sheet.rowCount).toBe(5)
    expect(sheet.cell(2, 0)).toMatchObject({ text: '', background: expect.any(String) })
    expect(sheet.cell(3, 1)).toMatchObject({ text: 'Y' })
    expect(sheet.cell(3, 1)?.background).toBeUndefined()
    // 再填上面那个空行：落在已写入行的前面
    adapter.apply([{ row: 2, col: 0, text: 'X' }])
    expect(adapter.snapshot().text).toBe('a,b\n1,2\nX\n,Y\n3,4\n')
    expect(adapter.sheets()[0].rowCount).toBe(5)
  })

  it('13. 在空行里只写空串不落地；写入一步可撤销', () => {
    const adapter = new CsvGridAdapter({ kind: 'text', name: 'a.csv', text: 'a,b\n1,2\n' })
    adapter.insertRows(2, 1)
    expect(adapter.apply([{ row: 2, col: 0, text: '' }])).toBe(false)
    expect(adapter.apply([{ row: 2, col: 0, text: 'z' }])).toBe(true)
    expect(adapter.snapshot().text).toBe('a,b\n1,2\nz\n')
    expect(adapter.undo()).toBe(true)
    expect(adapter.snapshot().text).toBe('a,b\n1,2\n')
    // 撤销后空行还在
    expect(adapter.sheets()[0].rowCount).toBe(3)
  })

  it('14. 删除空行不动文本；删除时夹着空行和真实行一起处理', () => {
    const adapter = new CsvGridAdapter({ kind: 'text', name: 'a.csv', text: 'a\n1\n2\n' })
    adapter.insertRows(1, 1) // a / 空 / 1 / 2
    expect(adapter.deleteRows(1, 2)).toBe(true) // 删掉空行和 "1"
    expect(adapter.snapshot().text).toBe('a\n2\n')
    expect(adapter.sheets()[0].rowCount).toBe(2)
    expect(adapter.undo()).toBe(true)
    expect(adapter.sheets()[0].rowCount).toBe(4)
  })

  it('15. 删除行之后，后面的空行位置跟着上移', () => {
    const adapter = new CsvGridAdapter({ kind: 'text', name: 'a.csv', text: 'a\n1\n2\n3\n' })
    adapter.insertRows(3, 1) // a 1 2 空 3
    adapter.deleteRows(0, 1) // 删 a、1 → 2 空 3
    const sheet = adapter.sheets()[0]
    expect([0, 1, 2].map((row) => sheet.cell(row, 0)?.text)).toEqual(['2', '', '3'])
    expect(sheet.cell(1, 0)?.background).toBeDefined()
  })

  it('16. 超过 20 万行时行操作也被拒绝', () => {
    const rows = Array.from({ length: 200_001 }, (_, index) => `r${index},${index}`).join('\n')
    const adapter = new CsvGridAdapter({ kind: 'text', name: 'big.csv', text: `a,b\n${rows}\n` })
    expect(adapter.insertRows(0, 1)).toBe(false)
    expect(adapter.deleteRows(0, 0)).toBe(false)
  })
})
