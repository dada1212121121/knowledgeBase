import { describe, expect, it } from 'vitest'
import { numberFieldValue } from './configFields'

describe('numberFieldValue', () => {
  it('把数字字符串转成数字', () => {
    expect(numberFieldValue('8')).toBe(8)
    expect(numberFieldValue(' 24 ')).toBe(24)
    expect(numberFieldValue('-1')).toBe(-1)
  })

  it('0 必须是数字 0,不能退化成字符串', () => {
    // 回归守卫:`Number(v) || v` 会把 "0" 写成字符串,保留策略的“不清理”就存不进去
    expect(numberFieldValue('0')).toBe(0)
    expect(numberFieldValue('0.0')).toBe(0)
  })

  it('空串与非数字原样返回,交给后端校验报错', () => {
    expect(numberFieldValue('')).toBe('')
    expect(numberFieldValue('   ')).toBe('   ')
    expect(numberFieldValue('abc')).toBe('abc')
    expect(numberFieldValue('1e')).toBe('1e')
  })
})
