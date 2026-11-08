import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ColorPicker from './ColorPicker.vue'

// 自定义取色器只发 pick，不改编辑器：这里守住预设数量、hex 规范化和键盘操作三条底线；
// 拖拽依赖真实布局与 Pointer Capture，交给 Playwright 探针覆盖。
describe('自定义取色器（ColorPicker）', () => {
  const mountPicker = (value = '#ff0000', prop: 'color' | 'background-color' = 'color') =>
    mount(ColorPicker, { props: { prop, value } })

  it('字色 / 底色各给 32 个扩展色，输入框回显当前颜色', () => {
    const fg = mountPicker('#ff0000', 'color')
    expect(fg.findAll('.kb-color-preset')).toHaveLength(32)
    expect((fg.find('[data-testid="editor-color-hex"]').element as HTMLInputElement).value).toBe('#ff0000')

    const bg = mountPicker('#FFF3A3', 'background-color')
    expect(bg.findAll('.kb-color-preset')).toHaveLength(32)
    expect((bg.find('[data-testid="editor-color-hex"]').element as HTMLInputElement).value).toBe('#fff3a3')
  })

  it('点预设色直接 pick；自定义 hex 规范化成小写后应用', async () => {
    const wrapper = mountPicker('#ff0000')
    await wrapper.find('[data-testid="editor-color-preset-8"]').trigger('click')
    expect(wrapper.emitted('pick')?.at(-1)).toEqual(['#dc2626'])

    const input = wrapper.find('[data-testid="editor-color-hex"]')
    await input.setValue('#ABCDEF')
    await wrapper.find('[data-testid="editor-color-apply"]').trigger('click')
    expect(wrapper.emitted('pick')?.at(-1)).toEqual(['#abcdef'])
  })

  it('输入不完整时应用按钮禁用，失焦后回到上一个有效色', async () => {
    const wrapper = mountPicker('#123456')
    const input = wrapper.find('[data-testid="editor-color-hex"]')
    await input.setValue('#12')
    expect(wrapper.find('[data-testid="editor-color-apply"]').attributes('disabled')).toBeDefined()
    await input.trigger('blur')
    expect((input.element as HTMLInputElement).value).toBe('#123456')
  })

  it('饱和度和色相支持键盘调整，调整后 hex 输入框同步', async () => {
    const wrapper = mountPicker('#808080')
    const sv = wrapper.find('[data-testid="editor-color-sv"]')
    const hue = wrapper.find('[data-testid="editor-color-hue"]')
    const input = wrapper.find('[data-testid="editor-color-hex"]')

    await sv.trigger('keydown', { key: 'ArrowRight' })
    expect((input.element as HTMLInputElement).value).not.toBe('#808080')
    expect(sv.attributes('aria-valuenow')).toBe('2')

    await hue.trigger('keydown', { key: 'ArrowRight' })
    expect((input.element as HTMLInputElement).value).toMatch(/^#[0-9a-f]{6}$/)
    expect(hue.attributes('aria-valuenow')).toBe('5')
  })
})
