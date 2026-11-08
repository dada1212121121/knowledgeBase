// 导入概况:状态分布(中文名)、每小时堆叠、失败原因 Top、没有文件写说明。
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api/client')>()), callCapability: (...args: unknown[]) => callCapability(...args) }))
const listeners = new Set<(event: { type: string; data: Record<string, unknown> }) => void>()
vi.mock('@/composables/useLiveEvents', () => ({
  useLiveEvents: () => () => undefined,
  subscribeLive: (listener: (event: { type: string; data: Record<string, unknown> }) => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}))

import ImportOverview from './ImportOverview.vue'

const HOUR = 3_600_000
const reply = {
  by_state: [{ state: 'done', count: 90 }, { state: 'failed', count: 6 }, { state: 'queued', count: 4 }],
  start: 1_800_000_000_000,
  step_ms: HOUR,
  buckets: [{ at: 1_800_000_000_000, total: 10, done: 8, failed: 1 }, { at: 1_800_000_000_000 + HOUR, total: 20, done: 15, failed: 4 }],
  top_errors: [{ error: '抽取超时', count: 4 }, { error: '读不出文字', count: 2 }],
}
const $ = (selector: string) => document.body.querySelector<HTMLElement>(selector)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  document.body.innerHTML = ''
  listeners.clear()
  callCapability.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('ImportOverview', () => {
  it('状态环用中文名和数量;结论写在处理的和失败的', async () => {
    callCapability.mockResolvedValue(reply)
    mount(ImportOverview, { attachTo: document.body })
    await flushPromises()
    expect(callCapability.mock.calls[0]).toEqual(['ingest_stats', { hours: 24 }])
    const legend = [...document.body.querySelectorAll('[data-testid=chart-ingest-states] .kb-donut-row')].map((row) => [...row.querySelectorAll('.kb-donut-name, .kb-donut-num')].map((cell) => cell.textContent))
    expect(legend).toEqual([['完成', '90'], ['失败', '6'], ['排队', '4']])
    expect($('[data-testid=chart-ingest-states] [data-testid=chart-headline]')!.textContent).toBe('共 100 个文件,4 个还在处理,6 个失败')
  })

  it('每小时导入:三层堆叠(成功 / 失败 / 其他),结论写合计', async () => {
    callCapability.mockResolvedValue(reply)
    mount(ImportOverview, { attachTo: document.body })
    await flushPromises()
    expect($('[data-testid=chart-ingest-hourly] [data-testid=chart-headline]')!.textContent).toBe('近 24 小时进来 30 个文件,成功 23 个,失败 5 个')
    expect($('[data-testid=chart-ingest-hourly]')!.querySelectorAll('.kb-line-area.is-band')).toHaveLength(3)
  })

  it('失败原因 Top 列在状态卡下面', async () => {
    callCapability.mockResolvedValue(reply)
    mount(ImportOverview, { attachTo: document.body })
    await flushPromises()
    const text = $('[data-testid=ingest-top-errors]')!.textContent!.replace(/\s+/g, ' ')
    expect(text).toContain('抽取超时× 4')
    expect(text).toContain('读不出文字× 2')
  })

  it('一个文件都没有:两张卡都写说明;任务完成的推送合并后刷新', async () => {
    callCapability.mockResolvedValue({ by_state: [], start: 0, step_ms: HOUR, buckets: [], top_errors: [] })
    mount(ImportOverview, { attachTo: document.body })
    await flushPromises()
    expect(document.body.textContent).toContain('还没有导入过文件')
    expect(document.body.textContent).toContain('最近 24 小时没有文件进来')
    const before = callCapability.mock.calls.length
    ;[...listeners].forEach((listener) => listener({ type: 'job.done', data: {} }))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(callCapability.mock.calls.length).toBe(before + 1)
  })
})
