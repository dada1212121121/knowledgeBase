// 动效工具的回归测试:token 单位换算(曾因把 0.42s 当成 0.42ms 导致数字滚动一帧跳完)。
import { afterEach, describe, expect, it } from 'vitest'
import { tokenMs } from '@kb-ui/motion/useMotion'

afterEach(() => document.documentElement.style.removeProperty('--dur-test'))

describe('tokenMs', () => {
  it('毫秒原样返回', () => {
    document.documentElement.style.setProperty('--dur-test', '420ms')
    expect(tokenMs('--dur-test', 1)).toBe(420)
  })
  it('秒换算成毫秒(浏览器会把 420ms 规范成 0.42s)', () => {
    document.documentElement.style.setProperty('--dur-test', '0.42s')
    expect(tokenMs('--dur-test', 1)).toBe(420)
  })
  it('读不到时用兜底值', () => {
    expect(tokenMs('--dur-nope', 123)).toBe(123)
  })
})
