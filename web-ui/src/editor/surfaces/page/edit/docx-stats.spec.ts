/** Word 字数与大纲单测：口径要和 Word 一致，因为用户会拿它和 Word 里的数对。 */
import { describe, expect, it, vi } from 'vitest'
import { countChars, countWords, createBodyCache, documentStats, outlineOf, plainTextOf, statsLabel } from './docx-stats'

describe('countWords（与 Word 一致的口径）', () => {
  it.each([
    ['', 0],
    ['   \n\t', 0],
    ['你好世界', 4],
    ['你好 world', 3],
    ['Hello world', 2],
    ['Hello, world!', 2],
    ['don\'t stop', 2],
    ['state-of-the-art design', 2],
    ['pi is 3.14 ok', 4],
    ['1,000 items', 2],
    // 混合检索 4 + 与 1 + BM25 1 + RRF 1 = 7（括号不算）
    ['混合检索（BM25）与 RRF', 7],
    ['こんにちは', 5],
    ['한국어', 3],
    ['，。！？、', 0],
    ['abc123 def', 2],
  ])('%j → %i', (text, expected) => {
    expect(countWords(text)).toBe(expected)
  })

  it('全角字母数字按拉丁词算（Ａ１ 算 1 个）', () => {
    expect(countWords('Ａ１ ｂ')).toBe(2)
  })

  it('汉字中间夹拉丁词不会把词吞掉', () => {
    expect(countWords('使用RRF融合')).toBe(5)
  })

  it('扩展 A 区汉字也算', () => {
    expect(countWords('\u3400')).toBe(1)
  })
})

describe('countChars / documentStats', () => {
  it('字符数不含空白', () => {
    expect(countChars('你好 world\n')).toBe(7)
  })

  it('空段落不计段数；字数 / 字符数累加', () => {
    const stats = documentStats([
      { paraId: 'a', text: '你好' },
      { paraId: 'b', text: '   ' },
      { paraId: 'c', text: 'hello world' },
    ])
    expect(stats).toEqual({ words: 4, chars: 12, paragraphs: 2 })
  })

  it('空文档', () => {
    expect(documentStats([])).toEqual({ words: 0, chars: 0, paragraphs: 0 })
  })
})

describe('outlineOf', () => {
  it('大纲级别 0..8 → 标题 1..9；正文不列', () => {
    expect(
      outlineOf([
        { paraId: 'a', text: '第一章', outlineLevel: 0 },
        { paraId: 'b', text: '正文', outlineLevel: null },
        { paraId: 'c', text: '1.1 小节', outlineLevel: 1 },
        { paraId: 'd', text: '没有级别' },
        { paraId: 'e', text: '第九级', outlineLevel: 8 },
      ]),
    ).toEqual([
      { level: 1, text: '第一章', paraId: 'a' },
      { level: 2, text: '1.1 小节', paraId: 'c' },
      { level: 9, text: '第九级', paraId: 'e' },
    ])
  })

  it('空标题不列；多余空白压成一个；级别越界不列', () => {
    expect(
      outlineOf([
        { paraId: 'a', text: '   ', outlineLevel: 0 },
        { paraId: 'b', text: '  多  个   空白 ', outlineLevel: 0 },
        { paraId: 'c', text: '越界', outlineLevel: 9 },
        { paraId: 'd', text: '负数', outlineLevel: -1 },
      ]),
    ).toEqual([{ level: 1, text: '多 个 空白', paraId: 'b' }])
  })
})

describe('statsLabel', () => {
  it('字数 + 页数；没有统计时只显示页数', () => {
    expect(statsLabel({ words: 1234, chars: 2000, paragraphs: 10 }, 20)).toBe('1234 字 · 20 页')
    expect(statsLabel(null, 20)).toBe('20 页')
    expect(statsLabel(null, 0)).toBe('')
  })
})

describe('createBodyCache', () => {
  const body = (version: string, text = 'x') => ({ version, paragraphs: [{ paraId: 'p', text }], truncated: false })

  it('文档版本没变：直接用缓存，不重读', async () => {
    let version = 1
    const read = vi.fn(async () => body('v1'))
    const cache = createBodyCache(read, () => version)
    await cache.get()
    await cache.get()
    await cache.get()
    expect(read).toHaveBeenCalledTimes(1)
    version = 2
    await cache.get()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('同一时刻只有一个读取在飞，并发的请求共用它', async () => {
    const read = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return body('v1')
    })
    const cache = createBodyCache(read, () => 1)
    const results = await Promise.all([cache.get(), cache.get(), cache.get()])
    expect(read).toHaveBeenCalledTimes(1)
    expect(results[0]).toBe(results[1])
  })

  it('读的过程中文档又变了：结果仍返回给等它的人，但不写缓存（下次要重读）', async () => {
    let version = 1
    const read = vi.fn(async () => {
      version = 2
      return body('v1')
    })
    const cache = createBodyCache(read, () => version)
    await cache.get()
    await cache.get()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('读失败：错误抛出，不缓存，下次重试', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('Worker 忙')).mockResolvedValue(body('v1'))
    const cache = createBodyCache(read, () => 1)
    await expect(cache.get()).rejects.toThrow('Worker 忙')
    await expect(cache.get()).resolves.toMatchObject({ version: 'v1' })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('invalidate 之后重读', async () => {
    const read = vi.fn(async () => body('v1'))
    const cache = createBodyCache(read, () => 1)
    await cache.get()
    cache.invalidate()
    await cache.get()
    expect(read).toHaveBeenCalledTimes(2)
  })
})

describe('plainTextOf', () => {
  it('每段一行，末尾一个换行；空段落保留为空行', () => {
    expect(plainTextOf([{ paraId: 'a', text: '一' }, { paraId: 'b', text: '' }, { paraId: 'c', text: '三' }])).toBe('一\n\n三\n')
    expect(plainTextOf([])).toBe('\n')
  })
})
