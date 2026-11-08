/** 悬停预取槽的状态转换单测：重复悬停、移开再回、认领、失败——每条路径资源只创建/销毁恰当的次数。 */
import { describe, expect, it } from 'vitest'
import { createPrefetchSlot, type PrefetchResource } from './prefetchSlot'

interface Fake extends PrefetchResource {
  id: number
  destroyed: number
  resolve(): void
  reject(error: Error): void
}

/** 手动控制计时器和预热结果，避免真等或假时间带来的不确定 */
function harness(idleMs = 1000) {
  const created: Fake[] = []
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let nextTimer = 1
  const slot = createPrefetchSlot<Fake>(
    () => {
      let resolve!: () => void
      let reject!: (error: Error) => void
      const ready = new Promise<void>((res, rej) => {
        resolve = res
        reject = rej
      })
      const fake: Fake = { id: created.length, destroyed: 0, ready, destroy: () => void (fake.destroyed += 1), resolve, reject }
      created.push(fake)
      return fake
    },
    idleMs,
    {
      set: (fn, ms) => {
        const handle = nextTimer++
        timers.set(handle, { fn, ms })
        return handle
      },
      clear: (handle) => void timers.delete(handle as number),
    },
  )
  const fireTimers = () => {
    for (const [handle, timer] of [...timers]) {
      timers.delete(handle)
      timer.fn()
    }
  }
  return { slot, created, timers, fireTimers }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('悬停预取槽', () => {
  it('重复悬停只创建一份', () => {
    const { slot, created } = harness()
    expect(slot.start()).toBe(true)
    expect(slot.start()).toBe(false)
    expect(slot.start()).toBe(false)
    expect(created).toHaveLength(1)
  })

  it('移开后过了宽限期没人认领：销毁并清槽', () => {
    const { slot, created, fireTimers, timers } = harness(5000)
    slot.start()
    slot.release()
    expect([...timers.values()][0]!.ms).toBe(5000)
    fireTimers()
    expect(created[0]!.destroyed).toBe(1)
    expect(slot.has()).toBe(false)
  })

  it('宽限期内再次悬停：取消销毁，继续用同一份', () => {
    const { slot, created, fireTimers, timers } = harness()
    slot.start()
    slot.release()
    expect(timers.size).toBe(1)
    slot.start()
    expect(timers.size).toBe(0)
    fireTimers()
    expect(created[0]!.destroyed).toBe(0)
    expect(slot.has()).toBe(true)
  })

  it('连续移开不会堆出多个销毁定时器', () => {
    const { slot, timers } = harness()
    slot.start()
    slot.release()
    slot.release()
    slot.release()
    expect(timers.size).toBe(1)
  })

  it('点击认领：拿到预热好的资源，槽清空，不再被定时器销毁', async () => {
    const { slot, created, fireTimers } = harness()
    slot.start()
    slot.release()
    created[0]!.resolve()
    const taken = await slot.take()
    expect(taken).toBe(created[0])
    expect(slot.has()).toBe(false)
    fireTimers()
    expect(created[0]!.destroyed).toBe(0)
  })

  it('预热还没完成就点击：认领会等到预热完成', async () => {
    const { slot, created } = harness()
    slot.start()
    const pending = slot.take()
    let settled = false
    void pending.then(() => (settled = true))
    await flush()
    expect(settled).toBe(false)
    created[0]!.resolve()
    expect(await pending).toBe(created[0])
  })

  it('没有预取时认领返回 undefined', async () => {
    expect(await harness().slot.take()).toBeUndefined()
  })

  it('认领过的槽不能被第二次认领', async () => {
    const { slot, created } = harness()
    slot.start()
    created[0]!.resolve()
    expect(await slot.take()).toBeDefined()
    expect(await slot.take()).toBeUndefined()
  })

  it('预热失败（认领之前）：销毁一次并清槽，下次悬停可重试', async () => {
    const { slot, created } = harness()
    slot.start()
    created[0]!.reject(new Error('网络断了'))
    await flush()
    expect(created[0]!.destroyed).toBe(1)
    expect(slot.has()).toBe(false)
    expect(await slot.take()).toBeUndefined()
    expect(created[0]!.destroyed).toBe(1)
    expect(slot.start()).toBe(true)
    expect(created).toHaveLength(2)
  })

  it('预热失败（认领等待期间）：认领得到 undefined，资源恰好销毁一次', async () => {
    const { slot, created } = harness()
    slot.start()
    const pending = slot.take()
    created[0]!.reject(new Error('下载失败'))
    expect(await pending).toBeUndefined()
    await flush()
    expect(created[0]!.destroyed).toBe(1)
  })

  it('预热失败不产生未处理的 promise 拒绝', async () => {
    // 预取没有人在等 ready：若槽不自己接住拒绝，浏览器里会冒出 unhandledrejection，被全局错误上报当成真故障。
    // 注意 jsdom 不派发 unhandledrejection，所以这条本身抓不到；真正兜底的是 vitest 对未处理拒绝的全局检测
    // （去掉槽里的 ready.catch，上面"预热失败（认领之前）"用例会失败、且 vitest 报 unhandled errors——变异实测过）
    const seen: unknown[] = []
    const listener = (event: PromiseRejectionEvent) => seen.push(event.reason)
    window.addEventListener('unhandledrejection', listener)
    try {
      const { slot, created } = harness()
      slot.start()
      created[0]!.reject(new Error('x'))
      await flush()
      await flush()
      expect(seen).toEqual([])
    } finally {
      window.removeEventListener('unhandledrejection', listener)
    }
  })
})
