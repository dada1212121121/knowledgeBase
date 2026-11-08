// 检索词高亮:从查询里取词(中文按词切、单字合成两字词、去虚词和过滤前缀)、按词切文字、围着命中截摘要。
import { describe, expect, it } from 'vitest'
import { MAX_TERMS, hasLiteralHit, queryTerms, snippetWindow, splitByTerms } from './queryTerms'

describe('queryTerms', () => {
  it('英文按空格切,去掉过滤前缀(kind: path: …)和太短的词', () => {
    // 按长度从长到短排(长词先匹配)
    expect(queryTerms('rerank timeout kind:code path:src/ a')).toEqual(['timeout', 'rerank'])
  })

  it('中文没有空格也能切出词:整句不会被当成一个词', () => {
    const terms = queryTerms('rerank 超时怎么降级')
    expect(terms).toContain('rerank')
    expect(terms).toContain('降级')
    expect(terms).toContain('超时')
    expect(terms).not.toContain('超时怎么降级')
  })

  it('虚词不高亮:怎么 / 如何 / 的 …', () => {
    const terms = queryTerms('如何配置的超时')
    expect(terms).not.toContain('如何')
    expect(terms).not.toContain('的')
    expect(terms).toContain('配置')
  })

  it('引号里的短语整句保留,不再拆', () => {
    expect(queryTerms('"UDS 断线" 降级')).toContain('UDS 断线')
    expect(queryTerms('“双哈希增量索引”')).toEqual(['双哈希增量索引'])
  })

  it('字母和汉字连在一起也能分开', () => {
    const terms = queryTerms('rerank超时')
    expect(terms).toContain('rerank')
    expect(terms.some((term) => term.includes('超'))).toBe(true)
  })

  it('标识符和文件名里的点、下划线、连字符保留', () => {
    expect(queryTerms('save_insight kb-service a.rs')).toEqual(expect.arrayContaining(['save_insight', 'kb-service', 'a.rs']))
  })

  it('单个汉字的查询只能按单字高亮;去重、按长度从长到短、有上限', () => {
    expect(queryTerms('猫')).toEqual(['猫'])
    expect(queryTerms('rerank RERANK Rerank')).toEqual(['rerank'])
    const terms = queryTerms('alpha betaa gammaaa deltaaaa')
    expect(terms[0]).toBe('deltaaaa')
    const many = queryTerms(Array.from({ length: 30 }, (_, n) => `word${n}x`).join(' '))
    expect(many.length).toBe(MAX_TERMS)
  })

  it('没有分词器的浏览器:退回连续单字合成两字词,不报错', () => {
    const original = (Intl as { Segmenter?: unknown }).Segmenter
    ;(Intl as { Segmenter?: unknown }).Segmenter = undefined
    try {
      const terms = queryTerms('超时降级')
      expect(terms).toEqual(expect.arrayContaining(['超时', '时降', '降级']))
    } finally {
      ;(Intl as { Segmenter?: unknown }).Segmenter = original
    }
  })

  it('空查询和只有过滤条件的查询没有词', () => {
    expect(queryTerms('')).toEqual([])
    expect(queryTerms('kind:code lang:rust')).toEqual([])
  })
})

describe('splitByTerms', () => {
  it('命中的词标出来,不区分大小写,原文大小写保持', () => {
    expect(splitByTerms('Rerank 超时降级', ['rerank', '降级'])).toEqual([
      { text: 'Rerank', hit: true },
      { text: ' 超时', hit: false },
      { text: '降级', hit: true },
    ])
  })

  it('长词优先:"超时降级" 和 "超时" 同时在时整体命中', () => {
    expect(splitByTerms('超时降级', ['超时', '超时降级'])).toEqual([{ text: '超时降级', hit: true }])
  })

  it('词里的正则符号按字面匹配', () => {
    expect(splitByTerms('a.rs 和 axrs', ['a.rs'])).toEqual([
      { text: 'a.rs', hit: true },
      { text: ' 和 axrs', hit: false },
    ])
  })

  it('没有词 / 空文字', () => {
    expect(splitByTerms('一段话', [])).toEqual([{ text: '一段话', hit: false }])
    expect(splitByTerms('', ['x'])).toEqual([])
  })
})

describe('snippetWindow', () => {
  it('短文字原样返回(压掉多余空白)', () => {
    expect(snippetWindow('a  b\n c', ['b'])).toBe('a b c')
  })

  it('命中在很后面时,摘要围着它截,而不是从开头截(否则高亮的词根本不在摘要里)', () => {
    const text = `${'前文'.repeat(300)}关键词出现在这里${'后文'.repeat(300)}`
    const snippet = snippetWindow(text, ['关键词'], 120)
    expect(snippet).toContain('关键词')
    expect(snippet.startsWith('…') && snippet.endsWith('…')).toBe(true)
    expect(snippet.length).toBeLessThanOrEqual(122)
  })

  it('命中在开头:不加前省略号;没有命中:从开头截并加省略号', () => {
    const text = `开头${'字'.repeat(500)}`
    expect(snippetWindow(text, ['开头'], 100).startsWith('…')).toBe(false)
    expect(snippetWindow(text, ['找不到'], 100)).toBe(`${text.slice(0, 100)}…`)
    expect(snippetWindow(text, [], 100).endsWith('…')).toBe(true)
  })

  it('命中靠近末尾:窗口往前收,仍然包含它', () => {
    const text = `${'字'.repeat(500)}结尾词`
    const snippet = snippetWindow(text, ['结尾词'], 100)
    expect(snippet).toContain('结尾词')
    expect(snippet.endsWith('…')).toBe(false)
  })
})

describe('hasLiteralHit', () => {
  it('标题、来源、摘要里任何一处出现查询词就算有字面命中(不分大小写)', () => {
    const terms = queryTerms('sampleproj 营养')
    expect(hasLiteralHit([null, 'apps/Sampleproj/lib/a.dart', '无关'], terms)).toBe(true)
    expect(hasLiteralHit(['无关', undefined, '每日营养摄入'], terms)).toBe(true)
  })

  it('一个词都没出现:是纯语义命中,要标出来', () => {
    const terms = queryTerms('sampleproj')
    expect(hasLiteralHit(['role_editor_dialog.dart', 'SizedBox( width: itemWidth )'], terms)).toBe(false)
    expect(hasLiteralHit([], terms)).toBe(false)
  })

  it('查询里没有可高亮的词(只写了过滤前缀)时不下结论,按"有"处理', () => {
    expect(hasLiteralHit(['任何内容'], queryTerms('kind:code'))).toBe(true)
  })
})
