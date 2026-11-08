/**
 * 缩略图生成队列测试（补全）：可见优先、缓存与 LRU、失效只重画改动页、节流、取消
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { planOrder, ThumbQueue, type ThumbQueueOptions } from './thumbQueue'

const yieldNow = (run: () => void) => {
  const id = setTimeout(run, 0)
  return () => clearTimeout(id)
}

/** 记录每次渲染的页，可手动控制完成时机 */
function harness(overrides: Partial<ThumbQueueOptions<string>> = {}, count = 20) {
  const log: number[] = []
  const ready: Array<[number, string, string | undefined]> = []
  const evicted: Array<[number, string]> = []
  const errors: number[] = []
  let version = 0
  const queue = new ThumbQueue<string>({
    yieldFn: yieldNow,
    render: async (index) => {
      log.push(index)
      version += 1
      return `p${index}@${version}`
    },
    onReady: (index, artifact, previous) => ready.push([index, artifact, previous]),
    onEvict: (index, artifact) => evicted.push([index, artifact]),
    onError: (index) => errors.push(index),
    ...overrides,
  })
  queue.setCount(count)
  return { queue, log, ready, evicted, errors }
}

async function drain(rounds = 200): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await vi.advanceTimersByTimeAsync(5)
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('planOrder：待办顺序', () => {
  const all = () => true

  it('可见优先：先当前页，再向两侧扩；然后是可见范围外的缓冲；最后后台补齐', () => {
    const order = planOrder({ count: 20, visible: { first: 8, last: 11 }, current: 9, buffer: 2, limit: 100, needs: all, cached: 0 })
    expect(order.slice(0, 4)).toEqual([9, 10, 8, 11])
    expect(order.slice(4, 8)).toEqual([12, 7, 13, 6])
    expect(new Set(order).size).toBe(20)
    // 补齐部分离当前页由近及远
    expect(order.slice(8, 12)).toEqual([5, 14, 4, 15].filter((index) => !order.slice(0, 8).includes(index)).slice(0, 4))
  })

  it('当前页不在可见范围内时，以可见范围里离它最近的一端为起点', () => {
    const order = planOrder({ count: 30, visible: { first: 2, last: 5 }, current: 20, buffer: 0, limit: 4, needs: all, cached: 0 })
    expect(order.slice(0, 4)).toEqual([5, 4, 3, 2])
  })

  it('已经新鲜的项不重复做；后台补齐不超过缓存上限', () => {
    const fresh = new Set([8, 9, 10])
    const order = planOrder({ count: 100, visible: { first: 8, last: 10 }, current: 9, buffer: 0, limit: 10, needs: (index) => !fresh.has(index), cached: 3 })
    expect(order.some((index) => fresh.has(index))).toBe(false)
    // 缓存已有 3 张，上限 10：除可见外后台最多再补 7 张
    expect(order.length).toBe(7)
  })

  it('没有可见范围（栏还没量出来）：围绕当前页补齐', () => {
    expect(planOrder({ count: 10, visible: null, current: 4, buffer: 3, limit: 5, needs: all, cached: 0 })).toEqual([4, 5, 3, 6, 2])
  })

  it('空文档 / 页数为 0 不出任务', () => {
    expect(planOrder({ count: 0, visible: null, current: 0, buffer: 3, limit: 5, needs: all, cached: 0 })).toEqual([])
  })
})

describe('生成：可见优先、一次一项、缓存', () => {
  it('先画可见的几张，再画缓冲，最后后台补齐；每张只画一次', async () => {
    const { queue, log } = harness({ limit: 100 })
    queue.setView({ first: 5, last: 7 }, 6)
    await drain()
    expect(log.slice(0, 3)).toEqual([6, 7, 5])
    expect(log.slice(3, 9)).toEqual([8, 4, 9, 3, 10, 2].slice(0, 6))
    expect(log).toHaveLength(20)
    expect(new Set(log).size).toBe(20)
    queue.dispose()
  })

  it('两项之间让出线程：一次只有一项在做，不会并发', async () => {
    let active = 0
    let peak = 0
    const { queue } = harness({
      render: async (index) => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 10))
        active -= 1
        return `p${index}`
      },
    })
    queue.setView({ first: 0, last: 5 }, 0)
    await drain()
    expect(peak).toBe(1)
    expect(queue.size).toBe(20)
    queue.dispose()
  })

  it('滚动换了可见范围：待办重排，新可见的排在前面，已做的不重做', async () => {
    const gate: Array<() => void> = []
    const { queue, log } = harness({
      limit: 100,
      render: async (index) => {
        await new Promise<void>((resolve) => gate.push(resolve))
        return `p${index}`
      },
    })
    queue.setView({ first: 0, last: 2 }, 0)
    await vi.advanceTimersByTimeAsync(5)
    expect(queue.busy).toBe(true)
    // 用户把栏滚到了第 15 页附近：正在做的那张做完，下一张应是新可见的
    queue.setView({ first: 14, last: 16 }, 15)
    expect(queue.queued.slice(0, 3)).toEqual([15, 16, 14])
    gate.shift()!()
    await vi.advanceTimersByTimeAsync(5)
    gate.shift()!()
    await vi.advanceTimersByTimeAsync(5)
    expect(queue.get(0)).toBe('p0')
    expect(queue.get(15)).toBe('p15')
    void log
    queue.dispose()
  })

  it('命中缓存的页不再渲染：重新设置同一可见范围没有新任务', async () => {
    const { queue, log } = harness({ limit: 100 })
    queue.setView({ first: 0, last: 19 }, 0)
    await drain()
    const done = log.length
    queue.setView({ first: 3, last: 6 }, 4)
    queue.setView({ first: 0, last: 19 }, 0)
    await drain()
    expect(log.length).toBe(done)
    queue.dispose()
  })
})

describe('缓存上限（LRU）', () => {
  it('超过上限淘汰最久没用的，可见的留着；被淘汰的回调 onEvict 让调用方释放', async () => {
    const { queue, evicted } = harness({ limit: 5 }, 12)
    queue.setView({ first: 0, last: 1 }, 0)
    await drain()
    // 滚到靠后的位置，旧的可见项不再可见
    queue.setView({ first: 10, last: 11 }, 10)
    await drain()
    expect(queue.size).toBeLessThanOrEqual(5)
    expect(queue.has(10)).toBe(true)
    expect(queue.has(11)).toBe(true)
    expect(evicted.length).toBeGreaterThan(0)
    queue.dispose()
  })

  it('页数减少：多出去的缓存立即丢弃并回调', async () => {
    const { queue, evicted } = harness({ limit: 100 })
    queue.setView({ first: 0, last: 19 }, 0)
    await drain()
    queue.setCount(12)
    expect(queue.size).toBe(12)
    expect(evicted.map(([index]) => index).sort((a, b) => a - b)).toEqual([12, 13, 14, 15, 16, 17, 18, 19])
    queue.dispose()
  })
})

describe('失效：只重画改动过的页', () => {
  it('invalidateFrom(8)：第 0~7 页保持原图不重画，第 8~19 页重画；旧图在新图到达前一直在（不闪）', async () => {
    const { queue, log, ready } = harness({ limit: 100 })
    queue.setView({ first: 0, last: 19 }, 0)
    await drain()
    expect(log).toHaveLength(20)
    const before = queue.get(3)
    const oldEight = queue.get(8)
    log.length = 0
    ready.length = 0

    queue.invalidateFrom(8)
    // 失效后、新图到达前旧图仍可取
    expect(queue.get(8)).toBe(oldEight)
    expect(queue.isStale(8)).toBe(true)
    expect(queue.isStale(3)).toBe(false)
    await drain()
    expect([...log].sort((a, b) => a - b)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
    expect(queue.get(3)).toBe(before)
    expect(queue.get(8)).not.toBe(oldEight)
    // 换图时把旧图交给 onReady，让调用方替换槽里的元素
    expect(ready.find(([index]) => index === 8)![2]).toBe(oldEight)
    expect(queue.isStale(8)).toBe(false)
    queue.dispose()
  })

  it('可见的过期页先于不可见的过期页重画', async () => {
    const { queue, log } = harness({ limit: 100 })
    queue.setView({ first: 0, last: 19 }, 0)
    await drain()
    log.length = 0
    queue.setView({ first: 12, last: 14 }, 13)
    queue.invalidate([2, 13, 18, 12])
    await drain()
    expect(log.slice(0, 2).sort((a, b) => a - b)).toEqual([12, 13])
    expect(new Set(log)).toEqual(new Set([2, 12, 13, 18]))
    queue.dispose()
  })

  it('渲染途中又被标过期：这次结果照样交付，但保持过期并随后重画，结果以最新为准', async () => {
    const gate: Array<() => void> = []
    let n = 0
    const { queue, ready } = harness({
      limit: 100,
      render: async (index) => {
        n += 1
        const mine = n
        await new Promise<void>((resolve) => gate.push(resolve))
        return `p${index}#${mine}`
      },
    })
    queue.setView({ first: 3, last: 3 }, 3)
    await vi.advanceTimersByTimeAsync(5)
    expect(queue.busy).toBe(true)
    queue.invalidate([3])
    gate.shift()!()
    await vi.advanceTimersByTimeAsync(5)
    expect(ready[0]![1]).toBe('p3#1')
    expect(queue.isStale(3)).toBe(true)
    gate.shift()!()
    await vi.advanceTimersByTimeAsync(5)
    expect(queue.get(3)).toBe('p3#2')
    expect(queue.isStale(3)).toBe(false)
    queue.dispose()
  })

  it('渲染途中这页被标过期、随后渲染失败（来源把在途会话作废了）：不记成该页画不出来，随后用新来源重画', async () => {
    const gate: Array<(ok: boolean) => void> = []
    const { queue, errors } = harness({
      limit: 100,
      render: (index) =>
        new Promise<string>((resolve, reject) => {
          gate.push((ok) => (ok ? resolve(`p${index}`) : reject(new Error('会话已关闭'))))
        }),
    })
    queue.setView({ first: 6, last: 6 }, 6)
    await vi.advanceTimersByTimeAsync(5)
    queue.invalidate([6])
    gate.shift()!(false)
    await vi.advanceTimersByTimeAsync(5)
    expect(errors).toEqual([])
    gate.shift()!(true)
    await vi.advanceTimersByTimeAsync(5)
    expect(queue.get(6)).toBe('p6')
    queue.dispose()
  })

  it('没有缓存的页被 invalidate 不会被当成过期（它本来就要画）', async () => {
    const { queue } = harness({ limit: 100 })
    queue.invalidate([4])
    expect(queue.isStale(4)).toBe(false)
    queue.dispose()
  })
})

describe('节流与错误', () => {
  it('minGapMs：两次开工之间至少间隔这么久', async () => {
    const starts: number[] = []
    const { queue } = harness({
      minGapMs: 100,
      limit: 100,
      render: async (index) => {
        starts.push(Date.now())
        return `p${index}`
      },
    })
    queue.setView({ first: 0, last: 3 }, 0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(starts.length).toBeGreaterThanOrEqual(4)
    for (let i = 1; i < starts.length; i += 1) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(100)
    queue.dispose()
  })

  it('大量失效只触发一次重排：连续 invalidate 不会让同一页被画多次', async () => {
    const { queue, log } = harness({ limit: 100 })
    queue.setView({ first: 0, last: 19 }, 0)
    await drain()
    log.length = 0
    for (let i = 0; i < 50; i += 1) queue.invalidate([5])
    await drain()
    expect(log).toEqual([5])
    queue.dispose()
  })

  it('画不出来的页记错误、不自动重试，也不卡住后面的；失效后允许再试', async () => {
    let fail = true
    const { queue, log, errors } = harness({
      limit: 100,
      render: async (index) => {
        if (index === 2 && fail) throw new Error('光栅失败')
        return `p${index}`
      },
    })
    void log
    queue.setView({ first: 0, last: 5 }, 0)
    await drain()
    expect(errors).toEqual([2])
    expect(queue.has(3)).toBe(true)
    expect(queue.has(2)).toBe(false)
    fail = false
    queue.invalidate([2])
    await drain()
    expect(queue.get(2)).toBe('p2')
    queue.dispose()
  })

  it('pause 期间不开工，resume 后接着做；dispose 后中止进行中的一项并释放全部缓存', async () => {
    const aborted: boolean[] = []
    const { queue, log, evicted } = harness({
      limit: 100,
      render: async (index, signal) => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        aborted.push(signal.aborted)
        return `p${index}`
      },
    })
    queue.pause()
    queue.setView({ first: 0, last: 3 }, 0)
    await drain(20)
    expect(log).toHaveLength(0)
    queue.resume()
    await vi.advanceTimersByTimeAsync(60)
    expect(queue.size).toBeGreaterThan(0)
    const before = queue.size
    queue.dispose()
    expect(evicted.length).toBeGreaterThanOrEqual(before)
    await drain(20)
    expect(queue.size).toBe(0)
  })
})
