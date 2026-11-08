// useLiveRefresh:只在可见时轮询、切回前台刷新一次、推送事件合并(最后一个之后 1.5 秒,最长 5 秒)、在途时补一次、卸载后全停。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import type { LiveEvent } from './useLiveEvents'

const listeners = new Set<(event: LiveEvent) => void>()
vi.mock('./useLiveEvents', () => ({
  subscribeLive: (listener: (event: LiveEvent) => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}))

import { useLiveRefresh, type LiveRefreshOptions, type RefreshReason } from './useLiveRefresh'

const emit = (type: string) => [...listeners].forEach((listener) => listener({ type, data: {} }))
let visibility: DocumentVisibilityState = 'visible'
function setVisibility(value: DocumentVisibilityState) {
  visibility = value
  document.dispatchEvent(new Event('visibilitychange'))
}

function host(options: Partial<LiveRefreshOptions> & { load: LiveRefreshOptions['load'] }) {
  let api: ReturnType<typeof useLiveRefresh> | undefined
  const Comp = defineComponent({
    setup() {
      api = useLiveRefresh({ interval: 10_000, events: ['job.done'], ...options })
      return () => h('div')
    },
  })
  const wrapper = mount(Comp)
  return { wrapper, api: api! }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  listeners.clear()
})
afterEach(() => vi.useRealTimers())

describe('useLiveRefresh', () => {
  it('挂载时取一次,之后按间隔轮询;间隔可以随状态变', async () => {
    const reasons: RefreshReason[] = []
    let busy = true
    host({ load: async (reason) => void reasons.push(reason), interval: () => (busy ? 10_000 : 30_000) })
    await flushPromises()
    expect(reasons).toEqual(['mount'])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(reasons).toEqual(['mount', 'poll'])
    busy = false
    await vi.advanceTimersByTimeAsync(10_000)
    // 上一拍结束时 busy 还是 true,所以这一拍仍按 10 秒;之后按 30 秒
    expect(reasons).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(reasons).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(reasons).toHaveLength(4)
  })

  it('页面隐藏时不轮询、不处理事件;回到前台立刻刷新一次', async () => {
    const load = vi.fn(async () => undefined)
    host({ load })
    await flushPromises()
    expect(load).toHaveBeenCalledTimes(1)
    setVisibility('hidden')
    emit('job.done')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(load).toHaveBeenCalledTimes(1)
    setVisibility('visible')
    await flushPromises()
    expect(load).toHaveBeenCalledTimes(2)
    expect(load).toHaveBeenLastCalledWith('visible')
  })

  it('连续的事件合并:最后一个之后 1.5 秒刷新一次', async () => {
    const load = vi.fn(async () => undefined)
    host({ load, interval: 0 })
    await flushPromises()
    load.mockClear()
    for (let index = 0; index < 5; index++) {
      emit('job.done')
      await vi.advanceTimersByTimeAsync(300)
    }
    expect(load).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_500)
    expect(load).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenLastCalledWith('event')
  })

  it('事件一直不停:最长 5 秒必刷一次(每秒一个事件,20 秒里刷 4 次)', async () => {
    const load = vi.fn(async () => undefined)
    host({ load, interval: 0 })
    await flushPromises()
    load.mockClear()
    for (let second = 0; second < 20; second++) {
      emit('job.done')
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(load).toHaveBeenCalledTimes(4)
  })

  it('不关心的事件不触发刷新', async () => {
    const load = vi.fn(async () => undefined)
    host({ load, interval: 0 })
    await flushPromises()
    load.mockClear()
    emit('log')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(load).not.toHaveBeenCalled()
  })

  it('在途时又要刷新:不并发,这次结束后补一次', async () => {
    let release: () => void = () => undefined
    let running = 0
    let peak = 0
    const load = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          running++
          peak = Math.max(peak, running)
          release = () => {
            running--
            resolve()
          }
        }),
    )
    const { api } = host({ load, interval: 0 })
    await flushPromises()
    expect(load).toHaveBeenCalledTimes(1)
    void api.refresh()
    void api.refresh()
    expect(load).toHaveBeenCalledTimes(1)
    release()
    await flushPromises()
    expect(load).toHaveBeenCalledTimes(2)
    release()
    await flushPromises()
    expect(load).toHaveBeenCalledTimes(2)
    expect(peak).toBe(1)
  })

  it('取数报错不打断轮询', async () => {
    const load = vi.fn(async () => {
      throw new Error('boom')
    })
    host({ load })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('immediate: false 时挂载不取,只按间隔', async () => {
    const load = vi.fn(async () => undefined)
    host({ load, immediate: false })
    await flushPromises()
    expect(load).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('卸载后不再轮询、不再听事件', async () => {
    const load = vi.fn(async () => undefined)
    const { wrapper } = host({ load })
    await flushPromises()
    wrapper.unmount()
    expect(listeners.size).toBe(0)
    emit('job.done')
    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(load).toHaveBeenCalledTimes(1)
  })
})
