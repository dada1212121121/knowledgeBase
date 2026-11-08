// AI 用量趋势:按用途堆叠、结论写总量和最多的一天、切天数重新取、没用过写说明。
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api/client')>()), callCapability: (...args: unknown[]) => callCapability(...args) }))
vi.mock('@/composables/useLiveEvents', () => ({ useLiveEvents: () => () => undefined, subscribeLive: () => () => undefined }))

import LlmTrendCard from './LlmTrendCard.vue'

const reply = (days: number) => {
  const labels = Array.from({ length: days }, (_, index) => `2026-10-${String(index + 1).padStart(2, '0')}`)
  const extract = labels.map((_, index) => (index === 2 ? 50_000 : 1_000))
  const agent = labels.map(() => 500)
  return { days: labels, purposes: ['agent', 'extract'], series: { agent, extract }, totals: extract.map((value, index) => value + agent[index]!) }
}
const $ = (selector: string) => document.body.querySelector<HTMLElement>(selector)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  document.body.innerHTML = ''
  callCapability.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('LlmTrendCard', () => {
  it('结论写总量和最多的一天;图例用中文用途名;两层堆叠', async () => {
    callCapability.mockImplementation(async (_name: string, args: { days: number }) => reply(args.days))
    mount(LlmTrendCard, { attachTo: document.body })
    await flushPromises()
    expect(callCapability.mock.calls[0]).toEqual(['llm_usage_series', { days: 30 }])
    // 30 天:每天 1500,其中第 3 天 50500 → 总 = 29 × 1500 + 50500 = 94000 → 9.4 万
    expect($('[data-testid=chart-headline]')!.textContent).toBe('近 30 天共用 9.4 万,最多的一天是 10-03(5.1 万)')
    expect([...document.body.querySelectorAll('.kb-line-legend span')].map((item) => item.textContent!.trim())).toEqual(['助手对话', '自动提炼'])
    expect(document.body.querySelectorAll('.kb-line-area.is-band')).toHaveLength(2)
  })

  it('切到 7 天重新取', async () => {
    callCapability.mockImplementation(async (_name: string, args: { days: number }) => reply(args.days))
    const wrapper = mount(LlmTrendCard, { attachTo: document.body })
    await flushPromises()
    await wrapper.findAll('[role=tab]')[0]!.trigger('click')
    await flushPromises()
    expect(callCapability.mock.calls.at(-1)).toEqual(['llm_usage_series', { days: 7 }])
    expect($('[data-testid=chart-headline]')!.textContent).toContain('近 7 天')
  })

  it('这段时间没用过:写说明', async () => {
    callCapability.mockResolvedValue({ days: ['2026-10-01', '2026-10-02'], purposes: [], series: {}, totals: [0, 0] })
    mount(LlmTrendCard, { attachTo: document.body })
    await flushPromises()
    expect(document.body.textContent).toContain('这段时间没有用过云端模型')
  })
})
