// 向量表体检面板:正常列出、碎片多与没索引的提示、「整理索引」的显隐与确认、失败不清空。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { IndexStats, TableStatRow } from '@/utils/indexStats'

const callCapability = vi.fn<(name: string, args?: Record<string, unknown>) => Promise<unknown>>()
vi.mock('@/api/client', () => ({ callCapability: (name: string, args?: Record<string, unknown>) => callCapability(name, args) }))

import IndexStatsPanel from './IndexStatsPanel.vue'

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
const stats = (tables: TableStatRow[]): IndexStats => ({ threshold: 10_000, tables })
const apiError = (message: string, status: number) => Object.assign(new Error(message), { status })

/** 第一次 index_stats、之后是 maintain_indexes 的响应 */
function mockStats(tables: TableStatRow[], maintained = { maintained: [] as string[], failed: [] as Array<{ collection: string; stage: string; error: string }> }) {
  callCapability.mockImplementation((name: string) => (name === 'maintain_indexes' ? Promise.resolve(maintained) : Promise.resolve(stats(tables))))
}

beforeEach(() => {
  callCapability.mockReset()
})

describe('IndexStatsPanel', () => {
  it('加载中是骨架屏', () => {
    callCapability.mockReturnValue(new Promise(() => undefined))
    const wrapper = mount(IndexStatsPanel)
    expect(wrapper.find('[data-testid="admin-loading"]').exists()).toBe(true)
  })

  it('列出每张表的行数、碎片与索引状况', async () => {
    mockStats([row({ collection: 'knowledgebase', rows: 32_940, fragments: 588, data_files: 588, versions: 2_533, index_kind: null }), row()])
    const wrapper = mount(IndexStatsPanel)
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('knowledgebase')
    expect(text).toContain('32,940')
    expect(text).toContain('588')
    expect(text).toContain('2,533')
    expect(text).toContain('没有索引')
    expect(text).toContain('IVF-HNSW 量化')
    expect(wrapper.text()).toContain('2 张表 · 33,940 行 · 最碎的是 knowledgebase(588 个碎片)')
    // 碎片偏多要单独标注
    expect(text).toContain('碎片偏多')
  })

  it('没有表过了阈值就不摆「整理索引」', async () => {
    mockStats([row()])
    const wrapper = mount(IndexStatsPanel)
    await flushPromises()
    expect(wrapper.find('[data-testid="maintain-indexes"]').exists()).toBe(false)
  })

  it('有表该建却没建时,点「整理索引」带 confirm,完成后重新读一遍', async () => {
    mockStats([row({ index_kind: null, missing_vector_index: true })], { maintained: ['demo'], failed: [] })
    const wrapper = mount(IndexStatsPanel)
    await flushPromises()
    await wrapper.find('[data-testid="maintain-indexes"]').trigger('click')
    await flushPromises()
    expect(callCapability).toHaveBeenCalledWith('maintain_indexes', { confirm: true })
    // 一次读 + 一次整理 + 整理后再读
    expect(callCapability.mock.calls.filter(([name]) => name === 'index_stats')).toHaveLength(2)
  })

  it('整理失败只提示,不清空已有的表', async () => {
    callCapability.mockImplementation((name: string) => {
      if (name === 'maintain_indexes') return Promise.reject(apiError('整理索引会短暂占住表的写入,请带 confirm: true 再执行', 400))
      return Promise.resolve(stats([row({ index_kind: null, missing_vector_index: true })]))
    })
    const wrapper = mount(IndexStatsPanel)
    await flushPromises()
    await wrapper.find('[data-testid="maintain-indexes"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('demo')
  })

  it('读不到时给报错与重试,不留空页', async () => {
    callCapability.mockRejectedValue(apiError('服务器出错了', 500))
    const wrapper = mount(IndexStatsPanel)
    await flushPromises()
    expect(wrapper.text()).toContain('读取向量表状况')
  })
})
