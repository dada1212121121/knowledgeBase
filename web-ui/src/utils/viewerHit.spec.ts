import { describe, expect, it } from 'vitest'
import type { PreviewChunk } from '@kb-ui/index'
import { deriveHit, rowOf } from './viewerHit'

const chunk = (id: string, anchor: PreviewChunk['anchor'], extra: Partial<PreviewChunk> = {}): PreviewChunk => ({
  id, ordinal: 1, anchor, start_line: null, end_line: null, title: null, text: ' 命中的句子 ', ...extra,
})

describe('deriveHit', () => {
  it('returns an empty hit when nothing is highlighted or the id is unknown', () => {
    expect(deriveHit([chunk('a', null)], null).text).toBe('')
    expect(deriveHit([chunk('a', null)], 'zzz').text).toBe('')
  })
  it('reads page and slide anchors', () => {
    expect(deriveHit([chunk('p', { kind: 'page', page: 7 })], 'p')).toMatchObject({ page: 7, slide: null, text: '命中的句子' })
    expect(deriveHit([chunk('s', { kind: 'slide', slide: 3 })], 's')).toMatchObject({ slide: 3, page: null })
  })
  it('reads sheet and row from a cell anchor', () => {
    expect(deriveHit([chunk('c', { kind: 'cell', sheet: '评测汇总', cell: 'R2' })], 'c')).toMatchObject({ sheet: '评测汇总', row: 2 })
  })
  it('prefers stored line numbers, falls back to a line anchor', () => {
    expect(deriveHit([chunk('l', null, { start_line: 4, end_line: 10 })], 'l').lines).toEqual([4, 10])
    expect(deriveHit([chunk('l', { kind: 'line', start: 3 })], 'l').lines).toEqual([3, 3])
  })
})

describe('rowOf', () => {
  it('understands R-style and A1-style references', () => {
    expect(rowOf('R118')).toBe(118)
    expect(rowOf('Sheet1!R3')).toBe(3)
    expect(rowOf('B12')).toBe(12)
    expect(rowOf('A1:D2')).toBe(1)
    expect(rowOf('')).toBeNull()
    expect(rowOf(undefined)).toBeNull()
  })
})
