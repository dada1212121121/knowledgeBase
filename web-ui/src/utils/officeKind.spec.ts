import { describe, expect, it } from 'vitest'
import { officeKindOf } from './officeKind'

describe('officeKindOf', () => {
  it('按扩展名认格式,不分大小写,不认识的返回 null', () => {
    expect(officeKindOf('报表/月报.xlsx')).toBe('xlsx')
    expect(officeKindOf('A.PPTX')).toBe('pptx')
    expect(officeKindOf('报告.docx')).toBe('docx')
    expect(officeKindOf('a.doc')).toBeNull() // 旧格式 Word 不在线编辑
    expect(officeKindOf('a.xls')).toBeNull()
    expect(officeKindOf('xlsx')).toBeNull() // 没有扩展名
    expect(officeKindOf('')).toBeNull()
  })
})
