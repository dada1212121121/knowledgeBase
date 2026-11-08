// 资源曲线区:四张图共用一个范围;标题下一句结论写真实数字;刚开始采样时写说明而不是画空图;出错可重试;切范围重新取。
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api/client')>()), callCapability: (...args: unknown[]) => callCapability(...args) }))
vi.mock('@/composables/useLiveEvents', () => ({ useLiveEvents: () => () => undefined, subscribeLive: () => () => undefined }))

import { CapabilityError } from '@/api/client'
import ResourceCharts from './ResourceCharts.vue'

const GB = 1024 ** 3
const point = (index: number, extra: Record<string, number> = {}) => ({
  at: 1_800_000_000_000 + index * 10_000,
  cpu: 0.2 + index * 0.1,
  cpu_max: 0.3 + index * 0.1,
  mem_used: 38 * GB,
  mem_total: 62 * GB,
  load1: 2,
  disk_used: 300 * GB,
  disk_total: 500 * GB,
  proc_cpu: 0.012,
  proc_rss: 2 * GB,
  ...extra,
})
const series = (range: string, points = [point(0), point(1), point(2)]) => ({ range, step_ms: 10_000, since: 0, until: 0, cores: 16, points, now: points.at(-1) ?? null })
const calls = () => callCapability.mock.calls.filter((call) => call[0] === 'metrics_series').map((call) => call[1])
const $ = (selector: string) => document.body.querySelector<HTMLElement>(selector)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  document.body.innerHTML = ''
  callCapability.mockReset()
  callCapability.mockImplementation(async (_name: string, args: { range: string }) => series(args.range))
})
afterEach(() => vi.useRealTimers())

async function open() {
  const wrapper = mount(ResourceCharts, { attachTo: document.body })
  await flushPromises()
  return wrapper
}

describe('ResourceCharts', () => {
  it('默认 1 小时:四张图都在,结论写真实数字(现在、峰值、核数、内存占比、本服务占用)', async () => {
    await open()
    expect(calls()).toEqual([{ range: '1h' }])
    for (const id of ['cpu', 'memory', 'disk', 'proc']) expect($(`[data-testid=chart-${id}]`), id).not.toBeNull()
    const headline = (id: string) => $(`[data-testid=chart-${id}] [data-testid=chart-headline]`)!.textContent!.replace(/\s+/g, ' ')
    expect(headline('cpu')).toBe('现在 40%,过去 1 小时峰值 50%,共 16 核')
    expect(headline('memory')).toBe('已用 38 GB / 62 GB(61%),本服务占 2 GB')
    expect(headline('disk')).toBe('已用 300 GB / 500 GB(60%)')
    expect(headline('proc')).toBe('本服务现在占整机处理器的 1.2%,过去 1 小时峰值 1.2%')
  })

  it('1 小时的处理器图带「现在」光圈、只画一条线;24 小时以上多一条「峰值」', async () => {
    const wrapper = await open()
    const cpu = () => $('[data-testid=chart-cpu]')!
    expect(cpu().querySelector('.kb-line-now')).not.toBeNull()
    expect(cpu().querySelectorAll('.kb-line-path')).toHaveLength(1)
    await wrapper.findAll('[role=tab]')[1]!.trigger('click')
    await flushPromises()
    expect(calls().at(-1)).toEqual({ range: '24h' })
    expect(cpu().querySelector('.kb-line-now')).toBeNull()
    expect(cpu().querySelectorAll('.kb-line-path')).toHaveLength(2)
  })

  it('刚开始采样(点不够):每张图写说明,不画孤零零的点', async () => {
    callCapability.mockImplementation(async (_name: string, args: { range: string }) => series(args.range, [point(0)]))
    await open()
    expect($('[data-testid=chart-cpu]')!.textContent).toContain('采样刚开始')
    expect(document.body.querySelector('.kb-line-path')).toBeNull()
  })

  it('读取失败:写原因并给重试,点了重新取', async () => {
    callCapability.mockImplementation(async () => {
      throw new CapabilityError('internal: boom', 'internal', 500)
    })
    await open()
    expect($('[data-testid=chart-cpu] [role=alert]')).not.toBeNull()
    callCapability.mockImplementation(async (_name: string, args: { range: string }) => series(args.range))
    ;($('[data-testid=chart-cpu] [role=alert] button') as HTMLButtonElement).click()
    await flushPromises()
    expect($('[data-testid=chart-cpu] [role=alert]')).toBeNull()
    expect($('[data-testid=chart-cpu] .kb-line-path')).not.toBeNull()
  })

  it('7 天的磁盘图:按增长速度写「约 N 天后写满」;1 小时的不写', async () => {
    const day = 86_400_000
    const week = Array.from({ length: 8 }, (_, index) => point(0, { at: 1_800_000_000_000 + index * day, disk_used: (300 + index * 10) * GB }))
    callCapability.mockImplementation(async (_name: string, args: { range: string }) => series(args.range, week))
    const wrapper = await open()
    expect($('[data-testid=chart-disk] [data-testid=chart-headline]')!.textContent).not.toContain('写满')
    await wrapper.findAll('[role=tab]')[2]!.trigger('click')
    await flushPromises()
    // 7 天涨 70 GB,每天 10 GB,还剩 130 GB(500 - 370)→ 约 13 天
    expect($('[data-testid=chart-disk] [data-testid=chart-headline]')!.textContent).toContain('约 13 天后写满')
  })

  it('1 小时每 10 秒刷新一次;切到更长的范围改成每分钟', async () => {
    const wrapper = await open()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls()).toHaveLength(2)
    await wrapper.findAll('[role=tab]')[1]!.trigger('click')
    await flushPromises()
    const before = calls().length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls()).toHaveLength(before)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls()).toHaveLength(before + 1)
  })
})
