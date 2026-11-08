/** 单飞守卫单测：并发调用只跑一份，且成功 / 失败 / 抛错后都能再跑。 */
import { describe, expect, it } from 'vitest'
import { createSingleFlight } from './singleFlight'

const gate = () => {
  let open!: () => void
  const promise = new Promise<void>((resolve) => (open = resolve))
  return { promise, open }
}

describe('createSingleFlight', () => {
  it('空闲时执行并返回结果', async () => {
    const flight = createSingleFlight()
    expect(await flight.run(async () => 42)).toEqual({ ran: true, value: 42 })
    expect(flight.busy).toBe(false)
  })

  it('进行中再调用：不执行，返回 ran:false（连点三下只跑一份）', async () => {
    const flight = createSingleFlight()
    const { promise, open } = gate()
    let runs = 0
    const first = flight.run(async () => {
      runs += 1
      await promise
      return 'a'
    })
    expect(flight.busy).toBe(true)
    const second = await flight.run(async () => (runs += 1))
    const third = await flight.run(async () => (runs += 1))
    expect(second).toEqual({ ran: false })
    expect(third).toEqual({ ran: false })
    open()
    expect(await first).toEqual({ ran: true, value: 'a' })
    expect(runs).toBe(1)
  })

  it('完成后可以再跑', async () => {
    const flight = createSingleFlight()
    await flight.run(async () => 1)
    expect(await flight.run(async () => 2)).toEqual({ ran: true, value: 2 })
  })

  it('任务抛错：错误照常抛出，且标记复位——一次失败后不会再也印不了', async () => {
    const flight = createSingleFlight()
    await expect(flight.run(async () => Promise.reject(new Error('光栅失败')))).rejects.toThrow('光栅失败')
    expect(flight.busy).toBe(false)
    expect(await flight.run(async () => 'ok')).toEqual({ ran: true, value: 'ok' })
  })

  it('任务同步抛错也复位', async () => {
    const flight = createSingleFlight()
    await expect(
      flight.run(() => {
        throw new Error('同步错')
      }),
    ).rejects.toThrow('同步错')
    expect(flight.busy).toBe(false)
  })
})
