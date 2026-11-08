// KbNum:数字部分交给 KbCountUp(带目标值),前后缀原样;没有数字直接显示原文。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import KbNum from './KbNum.vue'

describe('KbNum', () => {
  it('前缀 + 滚动的数字 + 后缀;滚动元素带目标值', () => {
    const wrapper = mount({ components: { KbNum }, template: '<span><KbNum value="¥ 1,284.5 起" /></span>' })
    const count = wrapper.find('.kb-countup')
    expect(count.attributes('data-value')).toBe('1284.5')
    expect(wrapper.text().startsWith('¥ ')).toBe(true)
    expect(wrapper.text().endsWith(' 起')).toBe(true)
  })
  it('没有数字:原样显示;空值显示 —', () => {
    const plain = mount({ components: { KbNum }, template: '<span><KbNum value="待定" /></span>' })
    expect(plain.find('.kb-countup').exists()).toBe(false)
    expect(plain.text()).toBe('待定')
    const empty = mount({ components: { KbNum }, template: '<span><KbNum :value="null" /></span>' })
    expect(empty.text()).toBe('—')
  })
})
