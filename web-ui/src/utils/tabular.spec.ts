import { describe, expect, it } from 'vitest'
import { cellText, columnLetter, columnWidths, decodeText, looksLikeHeader, parseCsv, sniffDelimiter } from './tabular'

describe('columnLetter', () => {
  it('counts like a spreadsheet', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnLetter)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA'])
  })
})

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, embedded newlines and CRLF', () => {
    const text = 'a,b,c\r\n1,"x, y","say ""hi"""\r\n2,"line1\nline2",\r\n'
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x, y', 'say "hi"'],
      ['2', 'line1\nline2', ''],
    ])
  })
  it('skips blank lines and supports other delimiters', () => {
    expect(parseCsv('a\tb\n\n1\t2', '\t')).toEqual([['a', 'b'], ['1', '2']])
  })
  it('keeps a last row without a trailing newline', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']])
  })
})

describe('decodeText / sniffDelimiter', () => {
  it('strips a UTF-8 BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x2c, 0x62])
    expect(decodeText(bytes.buffer)).toBe('a,b')
  })
  it('falls back to gb18030 for non-UTF-8 bytes', () => {
    const bytes = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]) // "你好" in GB18030
    expect(decodeText(bytes.buffer)).toBe('你好')
  })
  it('picks the most frequent delimiter in the header', () => {
    expect(sniffDelimiter('a;b;c\n1;2;3')).toBe(';')
    expect(sniffDelimiter('a\tb\n1\t2')).toBe('\t')
    expect(sniffDelimiter('abc')).toBe(',')
  })
})

describe('cellText / widths / header', () => {
  it('formats dates, booleans and empties', () => {
    expect(cellText(new Date('2026-10-21T00:00:00Z'))).toBe('2026-10-21')
    expect(cellText(new Date('2026-10-21T08:30:05Z'))).toBe('2026-10-21 08:30:05')
    expect(cellText(true)).toBe('TRUE')
    expect(cellText(null)).toBe('')
    expect(cellText(0.437)).toBe('0.437')
  })
  it('clamps column widths and counts CJK as double width', () => {
    const widths = columnWidths([['a', '查询查询查询查询查询查询'], ['x'.repeat(200), '']], 2)
    expect(widths[0]).toBe(360)
    expect(widths[1]).toBeGreaterThan(64)
    expect(columnWidths([[]], 1)[0]).toBe(64)
  })
  it('recognises a header row of distinct, non-numeric labels', () => {
    expect(looksLikeHeader(['编号', '查询', '耗时'])).toBe(true)
    expect(looksLikeHeader(['1', '2'])).toBe(false)
    expect(looksLikeHeader(['a', 'a'])).toBe(false)
    expect(looksLikeHeader(['a', ''])).toBe(false)
  })
})
