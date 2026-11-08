import { describe, expect, it } from 'vitest'
import { hexLines, humanSize } from './hexdump'

describe('hexLines', () => {
  it('formats offset, hex columns and ascii gutter', () => {
    const bytes = new TextEncoder().encode('PK\x03\x04hello world!!\x00')
    const [first, second] = hexLines(bytes)
    expect(first).toBe('00000000  50 4b 03 04 68 65 6c 6c  6f 20 77 6f 72 6c 64 21  |PK..hello world!|')
    expect(second).toBe('00000010  21 00                                             |!.|')
  })
  it('returns nothing for empty input', () => {
    expect(hexLines(new Uint8Array())).toEqual([])
  })
})

describe('humanSize', () => {
  it('scales units', () => {
    expect(humanSize(0)).toBe('0 B')
    expect(humanSize(1023)).toBe('1023 B')
    expect(humanSize(1536)).toBe('1.5 KB')
    expect(humanSize(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(humanSize(250 * 1024 * 1024)).toBe('250 MB')
    expect(humanSize(-1)).toBe('—')
  })
})
