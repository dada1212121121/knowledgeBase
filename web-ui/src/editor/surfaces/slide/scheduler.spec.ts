import { describe, expect, it, vi } from 'vitest'
import { IdleQueue, nearestFirst } from './scheduler'

/** 手动推进的让出线程：每次 flush 跑一个排队的回调 */
function manualYield() {
  const pending: Array<() => void> = []
  return {
    yieldFn: (fn: () => void) => {
      pending.push(fn)
      return () => {
        const at = pending.indexOf(fn)
        if (at >= 0) pending.splice(at, 1)
      }
    },
    async flush(max = 50) {
      for (let i = 0; i < max && pending.length; i += 1) {
        pending.shift()!()
        await Promise.resolve()
        await Promise.resolve()
      }
    },
    pending,
  }
}

describe('空闲队列', () => {
  it('nearestFirst 从中心向两侧交替展开，不越界、不重复', () => {
    expect(nearestFirst(5, 2)).toEqual([2, 3, 1, 4, 0])
    expect(nearestFirst(4, 0)).toEqual([0, 1, 2, 3])
    expect(nearestFirst(4, 3)).toEqual([3, 2, 1, 0])
    expect(nearestFirst(3, 99)).toEqual([2, 1, 0])
    expect(nearestFirst(0, 0)).toEqual([])
    expect(new Set(nearestFirst(30, 7)).size).toBe(30)
  })

  it('按给定顺序一次一项执行，两项之间让出线程', async () => {
    const y = manualYield()
    const ran: string[] = []
    const queue = new IdleQueue<string>({ run: (key) => void ran.push(key), yieldFn: y.yieldFn })
    queue.setOrder(['a', 'b', 'c'])
    expect(ran).toEqual([])
    await y.flush(1)
    expect(ran).toEqual(['a'])
    await y.flush()
    expect(ran).toEqual(['a', 'b', 'c'])
    expect(queue.size).toBe(0)
  })

  it('暂停期间不开始新任务，恢复后继续', async () => {
    const y = manualYield()
    const ran: string[] = []
    const queue = new IdleQueue<string>({ run: (key) => void ran.push(key), yieldFn: y.yieldFn })
    queue.pause()
    queue.setOrder(['a', 'b'])
    await y.flush()
    expect(ran).toEqual([])
    queue.resume()
    await y.flush()
    expect(ran).toEqual(['a', 'b'])
  })

  it('已完成的项不重复做，invalidate 之后重做；重排只影响还没做的', async () => {
    const y = manualYield()
    const ran: string[] = []
    const queue = new IdleQueue<string>({ run: (key) => void ran.push(key), yieldFn: y.yieldFn })
    queue.setOrder(['a', 'b'])
    await y.flush()
    queue.setOrder(['b', 'c', 'a'])
    await y.flush()
    expect(ran).toEqual(['a', 'b', 'c'])
    queue.invalidate(['a'])
    queue.setOrder(['a'])
    await y.flush()
    expect(ran).toEqual(['a', 'b', 'c', 'a'])
  })

  it('一项失败不卡住后面的，并且不重试', async () => {
    const y = manualYield()
    const errors: string[] = []
    const ran: string[] = []
    const queue = new IdleQueue<string>({
      run: (key) => {
        ran.push(key)
        if (key === 'bad') throw new Error('boom')
      },
      onError: (key) => errors.push(key),
      yieldFn: y.yieldFn,
    })
    queue.setOrder(['a', 'bad', 'c'])
    await y.flush()
    expect(ran).toEqual(['a', 'bad', 'c'])
    expect(errors).toEqual(['bad'])
    queue.setOrder(['bad'])
    await y.flush()
    expect(ran.filter((key) => key === 'bad')).toHaveLength(1)
  })

  it('dispose 之后不再执行', async () => {
    const y = manualYield()
    const run = vi.fn()
    const queue = new IdleQueue<string>({ run, yieldFn: y.yieldFn })
    queue.setOrder(['a', 'b'])
    queue.dispose()
    await y.flush()
    queue.setOrder(['c'])
    await y.flush()
    expect(run).not.toHaveBeenCalled()
  })
})
