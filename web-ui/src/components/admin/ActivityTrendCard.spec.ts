// 活动趋势卡:结论写合计、切天数重新取、没有活动写说明、读失败可重试。
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api/client')>()), callCapability: (...args: unknown[]) => callCapability(...args) }))
vi.mock('@/composables/useLiveEvents', () => ({ useLiveEvents: () => () => undefined, subscribeLive: () => () => undefined }))

import ActivityTrendCard from './ActivityTrendCard.vue'

const reply = (days: number, fill = 1) => {
  const line = Array.from({ length: days }, () => fill)
  return { days: Array.from({ length: days }, (_, index) => `2026-10-${String((index % 28) + 1).padStart(2, '0')}`), notes: line, edits: line, imports: line, imports_done: line, searches: line, jobs_done: line, ai_tokens: line }
}
const $ = (selector: string) => document.body.querySelector<HTMLElement>(selector)
const calls = () => callCapability.mock.calls.filter((call) => call[0] === 'activity_series').map((call) => call[1])

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  document.body.innerHTML = ''
  callCapability.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('ActivityTrendCard', () => {
  it('默认 30 天;结论写四类活动的合计;图是四层堆叠面积', async () => {
    callCapability.mockImplementation(async (_name: string, args: { days: number }) => reply(args.days, 2))
    mount(ActivityTrendCard, { attachTo: document.body })
    await flushPromises()
    expect(calls()).toEqual([{ days: 30 }])
    expect($('[data-testid=chart-headline]')!.textContent).toBe('近 30 天:新建 60 条笔记,编辑 60 次,导入 60 个文件,搜索 60 次')
    expect(document.body.querySelectorAll('.kb-line-area.is-band')).toHaveLength(4)
  })

  it('切到 7 天:重新取,结论跟着变', async () => {
    callCapability.mockImplementation(async (_name: string, args: { days: number }) => reply(args.days, 1))
    const wrapper = mount(ActivityTrendCard, { attachTo: document.body })
    await flushPromises()
    await wrapper.findAll('[role=tab]')[0]!.trigger('click')
    await flushPromises()
    expect(calls().at(-1)).toEqual({ days: 7 })
    expect($('[data-testid=chart-headline]')!.textContent).toContain('近 7 天:新建 7 条笔记')
  })

  it('这段时间一点活动都没有:写说明,不画空图', async () => {
    callCapability.mockImplementation(async (_name: string, args: { days: number }) => reply(args.days, 0))
    mount(ActivityTrendCard, { attachTo: document.body })
    await flushPromises()
    expect(document.body.textContent).toContain('这段时间还没有活动')
    expect(document.body.querySelector('.kb-line-path')).toBeNull()
  })

  it('读失败:写原因,点重试后恢复', async () => {
    callCapability.mockRejectedValueOnce(new Error('boom'))
    mount(ActivityTrendCard, { attachTo: document.body })
    await flushPromises()
    expect($('[role=alert]')).not.toBeNull()
    callCapability.mockImplementation(async (_name: string, args: { days: number }) => reply(args.days, 1))
    ;($('[role=alert] button') as HTMLButtonElement).click()
    await flushPromises()
    expect($('[role=alert]')).toBeNull()
    expect($('[data-testid=chart-headline]')).not.toBeNull()
  })
})
