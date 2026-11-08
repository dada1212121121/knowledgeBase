import { afterEach, describe, expect, it } from 'vitest'
import { MAX_RANGES, findAllRanges, findTextRange } from './domHighlight'

const mount = (html: string) => {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.append(root)
  return root
}
afterEach(() => (document.body.innerHTML = ''))

describe('findTextRange', () => {
  it('finds a sentence split across inline elements, ignoring whitespace and case', () => {
    const root = mount('<p>倒数排名融合（<b>RRF</b>）以 1/(k+rank)</p><p>对各路结果\n加权求和，无需分数归一化</p>')
    const range = findTextRange(root, '倒数排名融合（rrf）以 1/(k+rank) 对各路结果加权求和')
    expect(range).not.toBeNull()
    expect(range!.toString().replace(/\s+/g, '')).toBe('倒数排名融合（RRF）以1/(k+rank)对各路结果加权求和')
  })
  it('falls back to a shorter prefix when the tail of the sentence is not in the document', () => {
    const root = mount('<p>混合检索与倒数排名融合的实现细节说明文字</p>')
    const range = findTextRange(root, '混合检索与倒数排名融合的实现细节说明文字，但后半句渲染里没有这些字')
    expect(range?.toString()).toContain('混合检索与倒数排名融合')
  })
  it('returns null when nothing matches or the needle is empty', () => {
    const root = mount('<p>完全不相关的内容</p>')
    expect(findTextRange(root, '查无此句的一段话 xyz')).toBeNull()
    expect(findTextRange(root, '   ')).toBeNull()
  })
  it('skips style and script text', () => {
    const root = mount('<style>.secret{color:red}</style><p>正文内容在这里出现</p>')
    expect(findTextRange(root, '.secret{color:red}')).toBeNull()
  })
})

describe('findAllRanges', () => {
  const texts = (ranges: Range[]) => ranges.map((range) => range.toString())

  it('finds every occurrence of every term, in document order, ignoring case', () => {
    const root = mount('<p>Rerank 超时会降级。</p><p>降级之后再 RERANK 一次;超时重试。</p>')
    expect(texts(findAllRanges(root, ['rerank', '降级', '超时']))).toEqual(['Rerank', '超时', '降级', '降级', 'RERANK', '超时'])
  })

  it('a longer term swallows the shorter one inside it (no overlapping ranges)', () => {
    const root = mount('<p>超时降级策略</p>')
    expect(texts(findAllRanges(root, ['超时', '超时降级', '降级']))).toEqual(['超时降级'])
  })

  it('matches across inline elements and ignores whitespace between them', () => {
    const root = mount('<p>倒数排名融合（<b>RR</b>F）以<br>加权</p>')
    expect(texts(findAllRanges(root, ['rrf', '以加权'])).map((t) => t.replace(/\s+/g, ''))).toEqual(['RRF', '以加权'])
  })

  it('returns nothing for no terms, empty terms, or no match; skips style/script text', () => {
    const root = mount('<style>.secret{color:red}</style><p>正文</p>')
    expect(findAllRanges(root, [])).toEqual([])
    expect(findAllRanges(root, ['   ', ''])).toEqual([])
    expect(findAllRanges(root, ['不存在的词'])).toEqual([])
    expect(findAllRanges(root, ['secret'])).toEqual([])
  })

  it('stops at MAX_RANGES so a huge document cannot freeze the page', () => {
    const root = mount(`<p>${'词 '.repeat(MAX_RANGES + 300)}</p>`)
    expect(findAllRanges(root, ['词']).length).toBe(MAX_RANGES)
  })
})
