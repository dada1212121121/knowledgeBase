import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ViewerToolbar from './ViewerToolbar.vue'

describe('ViewerToolbar', () => {
  it('renders standard slots and default aria attributes', () => {
    const wrapper = mount(ViewerToolbar, {
      props: { ariaLabel: '文档查看工具' },
      slots: {
        start: '<span class="title">测试文档.pdf</span>',
        center: '<span class="page">1 / 10</span>',
        tools: '<button type="button" class="btn">文字层</button>',
      },
    })

    expect(wrapper.attributes('role')).toBe('toolbar')
    expect(wrapper.attributes('aria-label')).toBe('文档查看工具')
    expect(wrapper.classes()).toContain('is-sticky')
    expect(wrapper.find('.title').text()).toBe('测试文档.pdf')
    expect(wrapper.find('.page').text()).toBe('1 / 10')
    expect(wrapper.find('.btn').text()).toBe('文字层')
  })

  it('supports unsticky mode', () => {
    const wrapper = mount(ViewerToolbar, {
      props: { sticky: false },
    })
    expect(wrapper.classes()).not.toContain('is-sticky')
  })
})
