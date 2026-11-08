import { describe, expect, it } from 'vitest'
import { classifyGesture, tapTarget } from './swipe'

describe('触屏手势归类', () => {
  it('向左滑 = 下一页，向右滑 = 上一页', () => {
    expect(classifyGesture({ dx: -120, dy: 10, dt: 200 })).toBe('next')
    expect(classifyGesture({ dx: 120, dy: -10, dt: 200 })).toBe('prev')
  })

  it('位移不够或太慢不算滑动', () => {
    expect(classifyGesture({ dx: -30, dy: 0, dt: 150 })).toBe('none')
    expect(classifyGesture({ dx: -200, dy: 0, dt: 1500 })).toBe('none')
  })

  it('斜着或上下滑（纵向占优）不翻页，留给滚动', () => {
    expect(classifyGesture({ dx: -80, dy: 70, dt: 200 })).toBe('none')
    expect(classifyGesture({ dx: -10, dy: 200, dt: 200 })).toBe('none')
  })

  it('几乎不动且很快 = 轻点；按住很久不算轻点', () => {
    expect(classifyGesture({ dx: 2, dy: -3, dt: 90 })).toBe('tap')
    expect(classifyGesture({ dx: 0, dy: 0, dt: 900 })).toBe('none')
  })

  it('放映轻点：左 1/3 上一页，其余下一页', () => {
    expect(tapTarget(100, 900)).toBe('prev')
    expect(tapTarget(299, 900)).toBe('prev')
    expect(tapTarget(300, 900)).toBe('next')
    expect(tapTarget(800, 900)).toBe('next')
    expect(tapTarget(10, 0)).toBe('next')
  })
})
