// 数字滚动:目标值始终在 data-value 上;已经显示之后值变了会闪一下(.is-bump),首次出现不闪。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import KbCountUp from './KbCountUp.vue'

beforeEach(() => {
  // 单测环境默认关动效(见 src/test-setup-motion.ts);这里要测动效,打开
  ;(globalThis as { __KB_MOTION__?: boolean }).__KB_MOTION__ = true
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  // 用同步的帧:rAF 立刻回调,performance.now 往前走,滚动一步到位
  let now = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback((now += 2000)), 0) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  vi.spyOn(performance, 'now').mockImplementation(() => now)
})
afterEach(() => {
  ;(globalThis as { __KB_MOTION__?: boolean }).__KB_MOTION__ = false
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('KbCountUp', () => {
  it('data-value 是目标值;滚完显示目标值(千分位)', async () => {
    const wrapper = mount(KbCountUp, { props: { value: 12438 } })
    await nextTick()
    await vi.advanceTimersByTimeAsync(50)
    expect(wrapper.attributes('data-value')).toBe('12438')
    expect(wrapper.text()).toBe('12,438')
  })

  it('首次出现不闪;之后值变了才闪,过一会儿自己撤掉', async () => {
    const wrapper = mount(KbCountUp, { props: { value: 10 } })
    await nextTick()
    await vi.advanceTimersByTimeAsync(50)
    expect(wrapper.classes()).not.toContain('is-bump')
    await wrapper.setProps({ value: 25 })
    await vi.advanceTimersByTimeAsync(50)
    expect(wrapper.classes()).toContain('is-bump')
    expect(wrapper.attributes('data-value')).toBe('25')
    await vi.advanceTimersByTimeAsync(2000)
    expect(wrapper.classes()).not.toContain('is-bump')
  })

  it('值没变不闪', async () => {
    const wrapper = mount(KbCountUp, { props: { value: 7 } })
    await nextTick()
    await vi.advanceTimersByTimeAsync(50)
    await wrapper.setProps({ value: 7 })
    await vi.advanceTimersByTimeAsync(50)
    expect(wrapper.classes()).not.toContain('is-bump')
  })
})

describe('KbCountUp · 减弱动效', () => {
  it('不允许动效时直接显示目标值,值变了也不闪', async () => {
    ;(globalThis as { __KB_MOTION__?: boolean }).__KB_MOTION__ = false
    const wrapper = mount(KbCountUp, { props: { value: 12438 } })
    expect(wrapper.text()).toBe('12,438')
    await wrapper.setProps({ value: 99 })
    await vi.advanceTimersByTimeAsync(50)
    expect(wrapper.text()).toBe('99')
    expect(wrapper.classes()).not.toContain('is-bump')
  })
})
