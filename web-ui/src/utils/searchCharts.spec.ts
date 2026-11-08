// Explain 面板的耗时条:六项都在、文字保持原样、额外两趟与主链路分开着色。
import { describe, expect, it } from 'vitest'
import { hasExtraTimings, timingRows } from './searchCharts'

const timings = { parse_ms: 0.4, embed_ms: 38.25, store_ms: 3, fts_ms: 5.5, vector_ms: 12, fuse_ms: 0.1, rerank_ms: 90, total_ms: 150 }

describe('timingRows', () => {
  it('没有耗时数据(没开 explain / 后端没给)返回空数组', () => {
    expect(timingRows(null)).toEqual([])
    expect(timingRows(undefined)).toEqual([])
  })

  it('六项按原来的顺序,名字和面板上原来的一致', () => {
    expect(timingRows(timings).map((row) => row.label)).toEqual(['解析 / 前缀', '嵌入', 'BM25 (explain 额外)', '向量 (explain 额外)', 'RRF 融合', '重排'])
  })

  it('数字文字保持一位小数加 ms(和原来的列表一样,已有的习惯不变)', () => {
    const rows = timingRows(timings)
    expect(rows.map((row) => row.totalText)).toEqual(['0.4 ms', '38.3 ms', '5.5 ms', '12.0 ms', '0.1 ms', '90.0 ms'])
  })

  it('额外多跑的两趟(BM25、向量)用中性灰,主链路用主色', () => {
    const rows = timingRows(timings)
    expect(rows.filter((row) => row.extra).map((row) => row.key)).toEqual(['fts', 'vector'])
    expect(rows.find((row) => row.key === 'fts')!.segments[0]!.color).toBe('var(--viz-other)')
    expect(rows.find((row) => row.key === 'embed')!.segments[0]!.color).toBe('var(--viz-1)')
  })

  it('字段缺失或不是数字时按 0 画、文字写 0.0 ms,不出现 NaN', () => {
    const broken = { ...timings, embed_ms: Number.NaN, rerank_ms: undefined as unknown as number }
    const rows = timingRows(broken)
    expect(rows.find((row) => row.key === 'embed')!.totalText).toBe('0.0 ms')
    expect(rows.find((row) => row.key === 'rerank')!.segments[0]!.value).toBe(0)
    expect(rows.map((row) => row.totalText).join('')).not.toContain('NaN')
  })

  it('负数当 0(时钟回拨不该画出反向的条)', () => {
    expect(timingRows({ ...timings, fuse_ms: -4 }).find((row) => row.key === 'fuse')!.segments[0]!.value).toBe(0)
  })
})

describe('hasExtraTimings', () => {
  it('额外两趟有耗时才需要解释;都是 0 就不写', () => {
    expect(hasExtraTimings(timingRows(timings))).toBe(true)
    expect(hasExtraTimings(timingRows({ ...timings, fts_ms: 0, vector_ms: 0 }))).toBe(false)
    expect(hasExtraTimings([])).toBe(false)
  })
})
