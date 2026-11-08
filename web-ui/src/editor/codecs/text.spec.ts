/**
 * 纯文本 codec 测试
 *
 * 重点不在「能读写」，而在「不改动时逐字节相同」：
 * 行尾、BOM、末尾换行任一被改，都会让纯文本文件的 diff 全是噪音。
 */
import { describe, expect, it } from 'vitest'
import { parseText, serializeText } from '@/editor/codecs/text'

describe('text codec', () => {
  it('1. LF 文本未改动时逐字节相同', () => {
    const source = '第一行\n第二行\n'
    const parsed = parseText(source)
    expect(serializeText(parsed, parsed.text)).toBe(source)
  })

  it('2. CRLF 文本保留 CRLF', () => {
    const source = '第一行\r\n第二行\r\n'
    const parsed = parseText(source)
    expect(parsed.eol).toBe('\r\n')
    expect(parsed.text).toBe('第一行\n第二行\n')
    expect(serializeText(parsed, parsed.text)).toBe(source)
  })

  it('3. BOM 保留', () => {
    const source = '\uFEFF内容\n'
    const parsed = parseText(source)
    expect(parsed.bom).toBe(true)
    expect(serializeText(parsed, parsed.text)).toBe(source)
  })

  it('4. 原文件没有末尾换行，保存后也不补', () => {
    const source = '没有换行'
    const parsed = parseText(source)
    expect(parsed.trailingNewline).toBe(false)
    expect(serializeText(parsed, '没有换行')).toBe('没有换行')
  })

  it('5. 编辑内容后仍按原文件风格落盘', () => {
    const parsed = parseText('a\r\nb\r\n')
    expect(serializeText(parsed, 'a\n改过的行\n')).toBe('a\r\n改过的行\r\n')
  })

  it('6. 混用换行时以第一个换行为准（与旧编辑器一致）', () => {
    const parsed = parseText('a\r\nb\nc')
    expect(parsed.eol).toBe('\r\n')
    expect(parsed.text).toBe('a\nb\nc')
    expect(serializeText(parsed, parsed.text)).toBe('a\r\nb\r\nc')
  })

  it('7. 空文件不会凭空多出内容', () => {
    const parsed = parseText('')
    expect(serializeText(parsed, '')).toBe('')
  })
})
