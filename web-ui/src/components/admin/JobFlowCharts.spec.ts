// 任务趋势:吞吐(堆叠面积)和排队深度;结论写真实数字;没有任务时写说明;AI 关闭时排除提炼 / 审核类任务;切范围重新取。
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api/client')>()), callCapability: (...args: unknown[]) => callCapability(...args) }))
vi.mock('@/composables/useLiveEvents', () => ({ useLiveEvents: () => () => undefined, subscribeLive: () => () => undefined }))

import JobFlowCharts from './JobFlowCharts.vue'

const HOUR = 3_600_000
const bucket = (index: number, extra: Record<string, number | null> = {}) => ({ at: 1_800_000_000_000 + index * HOUR, created: 0, done: 0, failed: 0, canceled: 0, avg_ms: null, queue_depth: 0, ...extra })
const reply = (buckets: ReturnType<typeof bucket>[], range = '24h') => ({ total: 1, by_state: {}, series: { range, start: buckets[0]?.at ?? 0, step_ms: HOUR, buckets } })
const calls = () => callCapability.mock.calls.filter((call) => call[0] === 'job_stats').map((call) => call[1])
const $ = (selector: string) => document.body.querySelector<HTMLElement>(selector)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  document.body.innerHTML = ''
  callCapability.mockReset()
})
afterEach(() => vi.useRealTimers())

async function open(props: { excludeKinds?: string[] } = {}) {
  const wrapper = mount(JobFlowCharts, { props, attachTo: document.body })
  await flushPromises()
  return wrapper
}

describe('JobFlowCharts', () => {
  it('结论写真实数字:完成 / 失败的合计和按完成数加权的平均用时;排队深度写现在和最多', async () => {
    callCapability.mockResolvedValue(reply([bucket(0, { done: 10, failed: 1, avg_ms: 2_000, queue_depth: 5 }), bucket(1, { done: 30, canceled: 2, avg_ms: 6_000, queue_depth: 0 })]))
    await open()
    const headline = (id: string) => $(`[data-testid=chart-${id}] [data-testid=chart-headline]`)!.textContent!.replace(/\s+/g, ' ')
    // 加权平均:(10×2s + 30×6s) ÷ 40 = 5s
    expect(headline('flow')).toBe('近 24 小时完成 40 个,失败 1 个,平均用时 5s')
    expect(headline('depth')).toBe('现在没有排队,近 24 小时最多 5 个')
    // 堆叠面积:三层
    expect($('[data-testid=chart-flow]')!.querySelectorAll('.kb-line-area.is-band')).toHaveLength(3)
  })

  it('请求带范围和排除的类型;AI 关闭后传 evolve / extract / review', async () => {
    callCapability.mockResolvedValue(reply([bucket(0, { done: 1 })]))
    await open({ excludeKinds: ['evolve', 'extract', 'review'] })
    expect(calls()).toEqual([{ range: '24h', exclude_kinds: ['evolve', 'extract', 'review'] }])
  })

  it('这段时间一个任务都没有:两张图都写说明', async () => {
    callCapability.mockResolvedValue(reply([bucket(0), bucket(1)]))
    await open()
    expect($('[data-testid=chart-flow]')!.textContent).toContain('这段时间没有任务')
    expect($('[data-testid=chart-depth]')!.textContent).toContain('这段时间没有任务排过队')
    expect(document.body.querySelector('.kb-line-path')).toBeNull()
  })

  it('切范围:重新取,标题里的范围跟着变', async () => {
    callCapability.mockImplementation(async (_name: string, args: { range: string }) => reply([bucket(0, { done: 3 })], args.range))
    const wrapper = await open()
    await wrapper.findAll('[role=tab]')[1]!.trigger('click')
    await flushPromises()
    expect(calls().at(-1)).toMatchObject({ range: '7d' })
    expect($('[data-testid=chart-flow] [data-testid=chart-headline]')!.textContent).toContain('近 7 天完成 3 个')
  })

  it('读取失败:写原因,可重试', async () => {
    callCapability.mockRejectedValue(new Error('boom'))
    await open()
    expect($('[data-testid=chart-flow] [role=alert]')).not.toBeNull()
  })
})
