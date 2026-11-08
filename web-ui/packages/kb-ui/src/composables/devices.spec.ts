// 输入法组字判断与长按:触屏多选、中文输入法回车不提交。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { isComposing } from './ime'
import { useLongPress } from './useLongPress'
import KbFilterBar from '../components/KbFilterBar.vue'
import KbTagEditor from '../components/KbTagEditor.vue'

const key = (init: KeyboardEventInit & { keyCode?: number }) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  if (init.keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  return event
}

describe('isComposing', () => {
  it('组字中(isComposing)算;Safari 在 compositionend 之后那一下 keyCode=229 也算;普通回车不算', () => {
    expect(isComposing(key({ key: 'Enter', isComposing: true }))).toBe(true)
    expect(isComposing(key({ key: 'Enter', keyCode: 229 }))).toBe(true)
    expect(isComposing(key({ key: 'Enter', keyCode: 13 }))).toBe(false)
    expect(isComposing(key({ key: 'Enter' }))).toBe(false)
  })
})

describe('输入法组字时回车不提交', () => {
  it('筛选框:组字中的回车不发出 submit,上屏后的回车才发', async () => {
    const wrapper = mount(KbFilterBar, { props: { modelValue: '', chips: [] } })
    const input = wrapper.find('input')
    await input.trigger('keydown', { key: 'Enter', isComposing: true })
    await input.trigger('keydown', { key: 'Enter', keyCode: 229 })
    expect(wrapper.emitted('submit')).toBeUndefined()
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('submit')).toHaveLength(1)
    expect(input.attributes('enterkeyhint')).toBe('search')
  })
  it('标签编辑器:组字中的回车 / 逗号不添加标签', async () => {
    const wrapper = mount(KbTagEditor, { props: { modelValue: [] } })
    const input = wrapper.find('input')
    await input.setValue('你好')
    await input.trigger('keydown', { key: 'Enter', isComposing: true })
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([['你好']])
  })
})

describe('useLongPress', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const setup = (onLong = vi.fn()) => {
    let press!: ReturnType<typeof useLongPress>
    const Host = defineComponent({
      setup() {
        press = useLongPress(onLong)
        return () => h('div')
      },
    })
    const wrapper = mount(Host)
    return { press, wrapper, onLong }
  }
  const ev = (init: Partial<PointerEvent>) => init as PointerEvent

  it('触屏按住 450ms 触发;之后的 click 被吞掉一次', () => {
    const { press, onLong } = setup()
    press.start(ev({ pointerType: 'touch', clientX: 5, clientY: 5 }))
    vi.advanceTimersByTime(449)
    expect(onLong).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(onLong).toHaveBeenCalledTimes(1)
    expect(press.consumeClick()).toBe(true)
    expect(press.consumeClick()).toBe(false)
  })
  it('没到时间就抬手 / 手指移动超过容差(在滚动)都取消', () => {
    const { press, onLong } = setup()
    press.start(ev({ pointerType: 'touch', clientX: 0, clientY: 0 }))
    press.end()
    vi.advanceTimersByTime(600)
    press.start(ev({ pointerType: 'touch', clientX: 0, clientY: 0 }))
    press.move(ev({ clientX: 3, clientY: 4 })) // 在容差内
    vi.advanceTimersByTime(460)
    expect(onLong).toHaveBeenCalledTimes(1)
    press.start(ev({ pointerType: 'touch', clientX: 0, clientY: 0 }))
    press.move(ev({ clientX: 0, clientY: 30 })) // 超过容差
    vi.advanceTimersByTime(600)
    expect(onLong).toHaveBeenCalledTimes(1)
  })
  it('鼠标不触发长按', () => {
    const { press, onLong } = setup()
    press.start(ev({ pointerType: 'mouse', clientX: 0, clientY: 0 }))
    vi.advanceTimersByTime(1000)
    expect(onLong).not.toHaveBeenCalled()
  })
  it('组件卸载后定时器被清掉', () => {
    const { press, wrapper, onLong } = setup()
    press.start(ev({ pointerType: 'touch', clientX: 0, clientY: 0 }))
    wrapper.unmount()
    vi.advanceTimersByTime(1000)
    expect(onLong).not.toHaveBeenCalled()
  })
})
