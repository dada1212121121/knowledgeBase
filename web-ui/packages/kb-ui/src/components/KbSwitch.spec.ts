// 开关的可访问名称(axe aria-toggle-field-name):带 label 的形态要用 aria-labelledby 指向旁边的文字;
// 不带 label 的形态,调用方给的 aria-label 要落在 role=switch 的元素上。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import KbSwitch from './KbSwitch.vue'

describe('KbSwitch 的可访问名称', () => {
  it('带 label:开关的 aria-labelledby 指向旁边的文字节点,名称就是 label', () => {
    const wrapper = mount(KbSwitch, { props: { modelValue: false, label: '只看笔记' }, attachTo: document.body })
    const sw = wrapper.find('[role=switch]')
    const labelledby = sw.attributes('aria-labelledby')
    expect(labelledby).toBeTruthy()
    const target = document.getElementById(labelledby!)
    expect(target?.textContent).toBe('只看笔记')
    wrapper.unmount()
  })

  it('同一页上多个带 label 的开关,id 互不相同(否则后一个会读成前一个的名字)', () => {
    const a = mount(KbSwitch, { props: { modelValue: false, label: '重排' }, attachTo: document.body })
    const b = mount(KbSwitch, { props: { modelValue: false, label: '查看排序依据' }, attachTo: document.body })
    const idA = a.find('[role=switch]').attributes('aria-labelledby')
    const idB = b.find('[role=switch]').attributes('aria-labelledby')
    expect(idA).not.toBe(idB)
    expect(document.getElementById(idB!)?.textContent).toBe('查看排序依据')
    a.unmount()
    b.unmount()
  })

  it('不带 label:调用方给的 aria-label 落在开关本身上,而且不会多出 aria-labelledby', () => {
    const wrapper = mount(KbSwitch, { props: { modelValue: true }, attrs: { 'aria-label': '沙箱运行' } })
    const sw = wrapper.find('[role=switch]')
    expect(sw.attributes('aria-label')).toBe('沙箱运行')
    expect(sw.attributes('aria-labelledby')).toBeUndefined()
    expect(sw.attributes('aria-checked')).toBe('true')
  })

  it('点击切换、disabled 时不响应(行为没被名称改动带坏)', async () => {
    const wrapper = mount(KbSwitch, { props: { modelValue: false, label: '深度检索' } })
    await wrapper.find('[role=switch]').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([[true]])
    const off = mount(KbSwitch, { props: { modelValue: false, disabled: true, label: 'x' } })
    await off.find('[role=switch]').trigger('click')
    expect(off.emitted('update:modelValue')).toBeUndefined()
  })

  it('点旁边的文字也能切换(和原生 label 一致);disabled 时文字也不响应', async () => {
    const wrapper = mount(KbSwitch, { props: { modelValue: false, label: '只看笔记' } })
    await wrapper.find('.kb-sw-label').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([[true]])
    const off = mount(KbSwitch, { props: { modelValue: false, disabled: true, label: 'x' } })
    await off.find('.kb-sw-label').trigger('click')
    expect(off.emitted('update:modelValue')).toBeUndefined()
  })

  it('不带 label 的开关没有文字节点,点哪里都只有开关本体', () => {
    const wrapper = mount(KbSwitch, { props: { modelValue: false }, attrs: { 'aria-label': 'x' } })
    expect(wrapper.find('.kb-sw-label').exists()).toBe(false)
  })
})
