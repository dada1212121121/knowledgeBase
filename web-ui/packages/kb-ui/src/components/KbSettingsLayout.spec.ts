// 设置分区布局:有分区时左侧导航 + 内容;没有分区时不留空导航。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import KbSettingsLayout from './KbSettingsLayout.vue'

const slots = { default: '<div class="body-probe">内容</div>' }

describe('KbSettingsLayout', () => {
  it('有分区:渲染导航,当前项高亮,点击发出 select', async () => {
    const wrapper = mount(KbSettingsLayout, { props: { items: ['常规', '外观'], active: '外观' }, slots })
    const items = wrapper.findAll('.kb-settings-nav .ni')
    expect(items.map((item) => item.text())).toEqual(['常规', '外观'])
    expect(items[1]!.classes()).toContain('on')
    await items[0]!.trigger('click')
    expect(wrapper.emitted('select')![0]).toEqual(['常规'])
  })

  it('没有分区:不渲染导航(不留空侧栏 / 空白分隔栏),内容照常显示', () => {
    for (const flush of [false, true]) {
      const wrapper = mount(KbSettingsLayout, { props: { items: [], active: '', flush }, slots })
      expect(wrapper.find('.kb-settings-nav').exists()).toBe(false)
      expect(wrapper.find('.body-probe').exists()).toBe(true)
    }
  })
})
