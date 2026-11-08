// 6 位验证码输入:规整、格子、属性。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import OtpInput from './OtpInput.vue'

function make(value = '') {
  return mount(OtpInput, { props: { modelValue: value, label: '6 位验证码' }, attachTo: document.body })
}

describe('OtpInput', () => {
  it('手机弹数字键盘、支持一次性验证码自动填充、有可读的名字', () => {
    const input = make().find('input')
    expect(input.attributes('inputmode')).toBe('numeric')
    expect(input.attributes('autocomplete')).toBe('one-time-code')
    expect(input.attributes('aria-label')).toBe('6 位验证码')
  })

  it('六个格子按已输入的数字填充,格子本身对读屏隐藏', () => {
    const wrapper = make('481')
    const cells = wrapper.findAll('.kb-otp-cell')
    expect(cells.map((cell) => cell.text())).toEqual(['4', '8', '1', '', '', ''])
    expect(wrapper.find('.kb-otp-cells').attributes('aria-hidden')).toBe('true')
  })

  it('输入时规整成纯数字再发出去:粘贴空格、字母、全角数字', async () => {
    const wrapper = make()
    const input = wrapper.find('input')
    await input.setValue('48 1a039 77')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['481039'])
    // 真实输入框里也不留被过滤掉的字符
    expect((input.element as HTMLInputElement).value).toBe('481039')
    await input.setValue('４８１０３９')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['481039'])
  })

  it('聚焦后高亮下一个要输入的格子,输满停在最后一格,失焦后不高亮', async () => {
    const wrapper = make('48')
    expect(wrapper.find('.is-active').exists()).toBe(false)
    await wrapper.find('input').trigger('focus')
    expect(wrapper.findAll('.kb-otp-cell').findIndex((cell) => cell.classes('is-active'))).toBe(2)
    await wrapper.setProps({ modelValue: '481039' })
    expect(wrapper.findAll('.kb-otp-cell').findIndex((cell) => cell.classes('is-active'))).toBe(5)
    await wrapper.find('input').trigger('blur')
    expect(wrapper.find('.is-active').exists()).toBe(false)
  })

  it('出错时标红并标记 aria-invalid,关联到错误说明', () => {
    const wrapper = mount(OtpInput, { props: { modelValue: '', label: 'x', invalid: true, describedby: 'err' } })
    expect(wrapper.find('.kb-otp').classes()).toContain('is-invalid')
    expect(wrapper.find('input').attributes('aria-invalid')).toBe('true')
    expect(wrapper.find('input').attributes('aria-describedby')).toBe('err')
  })

  it('exposed focus() 能把焦点放到输入框', () => {
    const wrapper = make()
    ;(wrapper.vm as unknown as { focus: () => void }).focus()
    expect(document.activeElement).toBe(wrapper.find('input').element)
  })
})
