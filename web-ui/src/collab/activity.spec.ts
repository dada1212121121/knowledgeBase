import { describe, expect, it } from 'vitest'
import { ACTIVE_MS, ActivityTracker } from './activity'

const state = (id: string, cursor: unknown) => ({ user: { id, name: id, color: '#111111' }, cursor })
const at = (position: number) => ({ anchor: position, head: position })
const states = (entries: [number, Record<string, unknown>][]) => new Map(entries)

describe('ActivityTracker', () => {
  it('刚加入时第一次看到的光标不算活动', () => {
    let now = 1000
    const tracker = new ActivityTracker(() => now)
    tracker.observe(states([[2, state('usr_a', at(1))]]), 1)
    expect(tracker.isActive('usr_a')).toBe(false)
    expect(tracker.nextExpiry()).toBeNull()
    now += 10
  })

  it('光标位置变了才算:变了亮 3 秒,到点灭', () => {
    let now = 1000
    const tracker = new ActivityTracker(() => now)
    tracker.observe(states([[2, state('usr_a', at(1))]]), 1)
    now += 500
    tracker.observe(states([[2, state('usr_a', at(2))]]), 1)
    expect(tracker.isActive('usr_a')).toBe(true)
    now += ACTIVE_MS - 1
    expect(tracker.isActive('usr_a')).toBe(true)
    now += 1
    expect(tracker.isActive('usr_a')).toBe(false)
  })

  it('同样的状态再来一次(心跳续期)不算活动', () => {
    let now = 1000
    const tracker = new ActivityTracker(() => now)
    tracker.observe(states([[2, state('usr_a', at(1))]]), 1)
    for (let i = 0; i < 5; i += 1) {
      now += 15_000
      tracker.observe(states([[2, state('usr_a', at(1))]]), 1)
    }
    expect(tracker.isActive('usr_a')).toBe(false)
  })

  it('我自己的光标不算,没有身份的状态不算', () => {
    let now = 1000
    const tracker = new ActivityTracker(() => now)
    tracker.observe(states([[1, state('usr_me', at(1))], [3, { cursor: at(1) }]]), 1)
    now += 10
    tracker.observe(states([[1, state('usr_me', at(9))], [3, { cursor: at(9) }]]), 1)
    expect(tracker.isActive('usr_me')).toBe(false)
  })

  it('同一个人开两个标签页:任何一个动了他就算活跃', () => {
    let now = 1000
    const tracker = new ActivityTracker(() => now)
    tracker.observe(states([[2, state('usr_a', at(1))], [3, state('usr_a', at(5))]]), 1)
    now += 10
    tracker.observe(states([[2, state('usr_a', at(1))], [3, state('usr_a', at(6))]]), 1)
    expect(tracker.isActive('usr_a')).toBe(true)
  })

  it('他走了又回来:重新加入的第一次不算活动(旧记录已清掉)', () => {
    let now = 1000
    const tracker = new ActivityTracker(() => now)
    tracker.observe(states([[2, state('usr_a', at(1))]]), 1)
    tracker.observe(states([]), 1)
    now += 10
    // 换了一个连接 id 回来,光标在别处:首次看到,不是「移动」
    tracker.observe(states([[7, state('usr_a', at(40))]]), 1)
    expect(tracker.isActive('usr_a')).toBe(false)
  })

  it('nextExpiry 给出最早灭掉的那个还剩多久', () => {
    let now = 1000
    const tracker = new ActivityTracker(() => now)
    tracker.observe(states([[2, state('usr_a', at(1))], [3, state('usr_b', at(1))]]), 1)
    now += 100
    tracker.observe(states([[2, state('usr_a', at(2))], [3, state('usr_b', at(1))]]), 1)
    now += 1000
    tracker.observe(states([[2, state('usr_a', at(2))], [3, state('usr_b', at(2))]]), 1)
    expect(tracker.nextExpiry()).toBe(ACTIVE_MS - 1000)
  })
})
