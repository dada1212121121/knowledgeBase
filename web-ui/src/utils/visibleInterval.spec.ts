import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { visibleInterval } from './visibleInterval'

let state: 'visible' | 'hidden' = 'visible'

function setVisibility(next: 'visible' | 'hidden') {
  state = next
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('visibleInterval', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    state = 'visible'
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('页面可见时按周期执行', () => {
    const run = vi.fn()
    const stop = visibleInterval(run, 1000)
    vi.advanceTimersByTime(3000)
    expect(run).toHaveBeenCalledTimes(3)
    stop()
  })

  it('页面隐藏时到点也不执行', () => {
    const run = vi.fn()
    const stop = visibleInterval(run, 1000)
    setVisibility('hidden')
    vi.advanceTimersByTime(10_000)
    expect(run).not.toHaveBeenCalled()
    stop()
  })

  it('隐藏超过一个周期后回到前台,立刻补一次', () => {
    const run = vi.fn()
    const stop = visibleInterval(run, 1000)
    setVisibility('hidden')
    vi.advanceTimersByTime(5000)
    expect(run).not.toHaveBeenCalled()
    setVisibility('visible')
    expect(run).toHaveBeenCalledTimes(1)
    stop()
  })

  it('刚执行过就切回前台,不重复执行', () => {
    const run = vi.fn()
    const stop = visibleInterval(run, 1000)
    vi.advanceTimersByTime(1000)
    expect(run).toHaveBeenCalledTimes(1)
    setVisibility('hidden')
    vi.advanceTimersByTime(200)
    setVisibility('visible')
    expect(run).toHaveBeenCalledTimes(1)
    stop()
  })

  it('immediate 时注册就先执行一次', () => {
    const run = vi.fn()
    const stop = visibleInterval(run, 1000, { immediate: true })
    expect(run).toHaveBeenCalledTimes(1)
    stop()
  })

  it('停止后定时器和监听都撤掉', () => {
    const run = vi.fn()
    const stop = visibleInterval(run, 1000)
    stop()
    vi.advanceTimersByTime(5000)
    setVisibility('hidden')
    setVisibility('visible')
    expect(run).not.toHaveBeenCalled()
  })
})
