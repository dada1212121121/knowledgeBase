// 选区批注的锚点:摘录 + 前后文,位置只在渲染时现算。
import { describe, expect, it } from 'vitest'
import { Schema } from 'prosemirror-model'
import { CONTEXT_CHARS, MAX_QUOTE_CHARS, buildQuoteAnchor, buildTextIndex, locateQuote, quotePreview } from './quoteAnchor'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
  },
})
const docOf = (...paragraphs: string[]) =>
  schema.node('doc', null, paragraphs.map((text) => schema.node('paragraph', null, text ? [schema.text(text)] : [])))

describe('buildTextIndex', () => {
  it('段落之间用换行隔开,每个字符记着它在编辑器里的位置', () => {
    const index = buildTextIndex(docOf('第一段', '第二段'))
    expect(index.text).toBe('第一段\n第二段')
    expect(index.pos).toEqual([1, 2, 3, 5, 6, 7, 8])
  })

  it('空段落不产生字符,但前后段落之间仍只隔一个换行分隔', () => {
    expect(buildTextIndex(docOf('甲', '', '乙')).text).toBe('甲\n\n乙')
  })
})

describe('buildQuoteAnchor', () => {
  const index = buildTextIndex(docOf('第一段的内容', '第二段的内容'))

  it('选中一段文字:摘录 + 前后文', () => {
    const result = buildQuoteAnchor(index, 2, 4)
    expect(result).toEqual({ ok: true, anchor: { kind: 'quote', text: '一段', prefix: '第', suffix: '的内容\n第二段的内容' } })
  })

  it('前后文最多各取 CONTEXT_CHARS 个字', () => {
    const long = buildTextIndex(docOf('字'.repeat(100)))
    const result = buildQuoteAnchor(long, 50, 52)
    expect(result.ok && result.anchor.prefix.length).toBe(CONTEXT_CHARS)
    expect(result.ok && result.anchor.suffix.length).toBe(CONTEXT_CHARS)
  })

  it('跨段落的选区保留段落之间的换行;首尾的空白被去掉', () => {
    const spaced = buildTextIndex(docOf(' 前 ', ' 后 '))
    const result = buildQuoteAnchor(spaced, 1, 9)
    expect(result.ok && result.anchor.text).toBe('前 \n 后')
  })

  it('没选中东西 / 只选了空白:不能评论,并说清楚', () => {
    expect(buildQuoteAnchor(index, 3, 3)).toEqual({ ok: false, reason: '先选中要评论的文字' })
    const blank = buildTextIndex(docOf('甲   乙'))
    expect(buildQuoteAnchor(blank, 2, 5)).toEqual({ ok: false, reason: '先选中要评论的文字' })
  })

  it('太长的选区不截断(截断会和用户选的不一样),让用户缩短', () => {
    const huge = buildTextIndex(docOf('字'.repeat(MAX_QUOTE_CHARS + 5)))
    const result = buildQuoteAnchor(huge, 1, MAX_QUOTE_CHARS + 6)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toContain(String(MAX_QUOTE_CHARS))
  })
})

describe('locateQuote', () => {
  it('建锚点再定位:回到原来选的那一段(往返一致,段内和跨段落都是)', () => {
    const index = buildTextIndex(docOf('第一段的内容', '第二段的内容'))
    for (const [from, to] of [
      [2, 4], // 段内:「一段」
      [5, 11], // 跨段落:「内容」+ 段落分隔 + 「第二」
    ] as const) {
      const built = buildQuoteAnchor(index, from, to)
      expect(built.ok, `${from}-${to}`).toBe(true)
      if (built.ok) expect(locateQuote(index, built.anchor), `${from}-${to}`).toEqual({ from, to })
    }
  })

  it('同一句话出现多次:靠前后文挑出当初选的那一处', () => {
    const index = buildTextIndex(docOf('苹果很甜。', '香蕉不错。', '苹果很甜。', '梨子很脆。'))
    const third = locateQuote(index, { text: '苹果很甜。', prefix: '香蕉不错。\n', suffix: '\n梨子很脆。' })
    const first = locateQuote(index, { text: '苹果很甜。', prefix: '', suffix: '\n香蕉不错。' })
    expect(third?.from).toBe(index.pos[index.text.lastIndexOf('苹果很甜。')])
    expect(first?.from).toBe(1)
  })

  it('正文别处被改过、前后文变了:摘录还在就仍然找得到', () => {
    const before = buildTextIndex(docOf('旧的开头', '要评论的这一句话', '旧的结尾'))
    const built = buildQuoteAnchor(before, 7, 15)
    expect(built.ok).toBe(true)
    const after = buildTextIndex(docOf('全新的开头加了很多字', '要评论的这一句话', '另一个结尾'))
    if (built.ok) expect(locateQuote(after, built.anchor)).not.toBeNull()
  })

  it('摘录本身被改掉了:找不到,返回 null(界面标"原文已改动",评论不丢)', () => {
    const index = buildTextIndex(docOf('要评论的这一句话被改写成了别的'))
    expect(locateQuote(index, { text: '要评论的这一句话', prefix: '', suffix: '' })).not.toBeNull()
    expect(locateQuote(index, { text: '这句话已经不存在', prefix: '', suffix: '' })).toBeNull()
    expect(locateQuote(index, { text: '', prefix: '', suffix: '' })).toBeNull()
  })
})

describe('quotePreview', () => {
  it('压掉空白;太长截断加省略号', () => {
    expect(quotePreview('  一\n 二  ')).toBe('一 二')
    expect(quotePreview('字'.repeat(50))).toBe(`${'字'.repeat(40)}…`)
  })
})
