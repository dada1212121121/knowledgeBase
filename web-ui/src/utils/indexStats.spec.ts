// 向量表体检的文案与判读:索引类型怎么显示、哪张表需要人看一眼、总结那句话怎么说。
import { describe, expect, it } from 'vitest'
import {
  FRAGMENT_WARN,
  fragmentsNote,
  hasMissingIndex,
  indexKindText,
  indexNote,
  needsAttention,
  statsSummary,
  tableName,
  type IndexStats,
  type TableStatRow,
} from './indexStats'

const row = (patch: Partial<TableStatRow> = {}): TableStatRow => ({
  table: 'proj_demo__fake8__v1',
  collection: 'demo',
  rows: 1000,
  fragments: 2,
  data_files: 2,
  version: 10,
  versions: 2,
  index_kind: 'ivf_hnsw_sq',
  index_rows: 1000,
  index_unindexed_rows: 0,
  index_created_at: 1,
  missing_vector_index: false,
  ...patch,
})

const stats = (tables: TableStatRow[], threshold = 10_000): IndexStats => ({ threshold, tables })

describe('索引类型与表名', () => {
  it('认识的类型说中文,不认识的原样显示,没建就说没建', () => {
    expect(indexKindText('ivf_hnsw_sq')).toBe('IVF-HNSW 量化')
    expect(indexKindText('ivf_pq')).toBe('IVF-PQ')
    expect(indexKindText('brute_force_v2')).toBe('brute_force_v2')
    expect(indexKindText(null)).toBe('没有索引')
    expect(indexKindText(undefined)).toBe('没有索引')
  })

  it('优先显示集合名,对不上时退回表名', () => {
    expect(tableName(row())).toBe('demo')
    expect(tableName(row({ collection: null }))).toBe('proj_demo__fake8__v1')
  })
})

describe('每行的一句话', () => {
  it('没索引分两种:该建没建、还没到阈值', () => {
    expect(indexNote(row({ index_kind: null, missing_vector_index: true }))).toBe('过了阈值还没建')
    expect(indexNote(row({ index_kind: null, missing_vector_index: false }))).toBe('没建索引')
  })

  it('建了但还有行没并进去时要说明数量', () => {
    expect(indexNote(row({ index_unindexed_rows: 12 }))).toBe('还有 12 行没并进去')
    expect(indexNote(row({ index_unindexed_rows: 0 }))).toBe('已覆盖全部行')
    expect(indexNote(row({ index_unindexed_rows: null }))).toBe('已覆盖全部行')
  })

  it('碎片分三档,阈值与 kb doctor 一致', () => {
    expect(fragmentsNote(row({ fragments: 1 }))).toBe('正常')
    expect(fragmentsNote(row({ fragments: 21 }))).toBe('有点碎')
    expect(fragmentsNote(row({ fragments: FRAGMENT_WARN }))).toBe('有点碎')
    expect(fragmentsNote(row({ fragments: FRAGMENT_WARN + 1 }))).toBe('碎片偏多')
  })
})

describe('要人看哪张表', () => {
  it('该建的索引没建,或者碎片攒太多', () => {
    expect(needsAttention(row())).toBe(false)
    expect(needsAttention(row({ missing_vector_index: true }))).toBe(true)
    expect(needsAttention(row({ fragments: FRAGMENT_WARN + 1 }))).toBe(true)
  })

  it('没有表过了阈值就不该把「整理索引」摆出来', () => {
    expect(hasMissingIndex(null)).toBe(false)
    expect(hasMissingIndex(stats([row()]))).toBe(false)
    expect(hasMissingIndex(stats([row({ missing_vector_index: true })]))).toBe(true)
  })
})

describe('顶部那句总结', () => {
  it('没表时说清楚是空的', () => {
    expect(statsSummary(null)).toBe('还没有物理表')
    expect(statsSummary(stats([]))).toBe('还没有物理表')
  })

  it('正常时只报表数与行数,最碎的那张不碎就不提', () => {
    expect(statsSummary(stats([row({ rows: 900 }), row({ rows: 100 })]))).toBe('2 张表 · 1,000 行')
  })

  it('有表碎到要人管时点出是哪一张', () => {
    const text = statsSummary(stats([row({ rows: 900, fragments: 3 }), row({ collection: 'kb', rows: 100, fragments: 588 })]))
    expect(text).toBe('2 张表 · 1,000 行 · 最碎的是 kb(588 个碎片)')
  })
})
