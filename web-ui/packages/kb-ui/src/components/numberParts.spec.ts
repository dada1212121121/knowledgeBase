// 把显示文字拆成前缀 / 数字 / 后缀:数字滚动只动数字部分。
import { describe, expect, it } from 'vitest'
import { splitNumber } from './numberParts'

describe('splitNumber', () => {
  it('纯数字、带千分位、带小数', () => {
    expect(splitNumber(42)).toEqual({ prefix: '', number: 42, decimals: 0, suffix: '', locale: false })
    expect(splitNumber('12,438')).toEqual({ prefix: '', number: 12438, decimals: 0, suffix: '', locale: true })
    expect(splitNumber('1.50')).toEqual({ prefix: '', number: 1.5, decimals: 2, suffix: '', locale: false })
  })
  it('前后缀原样保留', () => {
    expect(splitNumber('84 ms')).toMatchObject({ prefix: '', number: 84, suffix: ' ms' })
    expect(splitNumber('¥ 3.20')).toMatchObject({ prefix: '¥ ', number: 3.2, decimals: 2 })
    expect(splitNumber('63%')).toMatchObject({ number: 63, suffix: '%' })
    expect(splitNumber('38 / 62 GB')).toMatchObject({ number: 38, suffix: ' / 62 GB' })
  })
  it('没有数字、空值、超长数字(编号)返回 null', () => {
    expect(splitNumber('—')).toBeNull()
    expect(splitNumber('')).toBeNull()
    expect(splitNumber(null)).toBeNull()
    expect(splitNumber(undefined)).toBeNull()
    expect(splitNumber('0123456789012345678')).toBeNull()
  })
})
