// 树行的点击分工与键盘约定:点箭头只展开 / 收起,点其余部分是选中;叶子的箭头点了不触发展开;
// 方向键按 WAI-ARIA tree 的约定在行之间移动,行内小按钮冒泡上来的按键不算选中。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import KbTreeRow from './KbTreeRow.vue'

describe('KbTreeRow 点击', () => {
  it('点箭头只发 toggle,不发 select', async () => {
    const wrapper = mount(KbTreeRow, { props: { label: 'a', open: false } })
    await wrapper.find('.kb-tree-caret').trigger('click')
    expect(wrapper.emitted('toggle')).toHaveLength(1)
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('点行的其余部分只发 select,不发 toggle', async () => {
    const wrapper = mount(KbTreeRow, { props: { label: 'a', open: false } })
    await wrapper.find('.kb-tree-text').trigger('click')
    expect(wrapper.emitted('select')).toHaveLength(1)
    expect(wrapper.emitted('toggle')).toBeUndefined()
  })

  it('叶子(open 未定义)的箭头是占位:点了不发 toggle,也不发 select', async () => {
    const wrapper = mount(KbTreeRow, { props: { label: 'a' } })
    await wrapper.find('.kb-tree-caret').trigger('click')
    expect(wrapper.emitted('toggle')).toBeUndefined()
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('叶子不带 aria-expanded,可展开的行带当前状态;层级写在 aria-level 上', () => {
    const leaf = mount(KbTreeRow, { props: { label: 'a', depth: 2 } })
    expect(leaf.attributes('aria-expanded')).toBeUndefined()
    expect(leaf.attributes('aria-level')).toBe('3')
    const folder = mount(KbTreeRow, { props: { label: 'b', open: true } })
    expect(folder.attributes('aria-expanded')).toBe('true')
  })
})

describe('KbTreeRow 键盘', () => {
  // 一棵三层的小树:A(展开) → A1(展开) → A1a,另有同级的 B(收起)
  const Tree = defineComponent({
    setup() {
      const log: string[] = []
      return () =>
        h('div', { role: 'tree', 'data-log': log.join(',') }, [
          h(KbTreeRow, { label: 'A', depth: 0, open: true, onToggle: () => log.push('A:toggle'), onSelect: () => log.push('A:select') }),
          h(KbTreeRow, { label: 'A1', depth: 1, open: true, onToggle: () => log.push('A1:toggle') }),
          h(KbTreeRow, { label: 'A1a', depth: 2 }),
          h(KbTreeRow, { label: 'B', depth: 0, open: false, onToggle: () => log.push('B:toggle') }),
        ])
    },
  })
  const mountTree = () => mount(Tree, { attachTo: document.body })
  const rows = (wrapper: ReturnType<typeof mountTree>) => wrapper.findAll('[role=treeitem]')
  const labelOf = (el: Element | null) => el?.querySelector('.kb-tree-text')?.textContent

  it('↓ / ↑ 在相邻行之间移动焦点,Home / End 到首尾', async () => {
    const wrapper = mountTree()
    const all = rows(wrapper)
    ;(all[0]!.element as HTMLElement).focus()
    await all[0]!.trigger('keydown', { key: 'ArrowDown' })
    expect(labelOf(document.activeElement)).toBe('A1')
    await all[1]!.trigger('keydown', { key: 'ArrowUp' })
    expect(labelOf(document.activeElement)).toBe('A')
    await all[0]!.trigger('keydown', { key: 'End' })
    expect(labelOf(document.activeElement)).toBe('B')
    await all[3]!.trigger('keydown', { key: 'Home' })
    expect(labelOf(document.activeElement)).toBe('A')
    wrapper.unmount()
  })

  it('→:已展开则进入第一个子项;收起则展开(发 toggle);叶子无动作', async () => {
    const wrapper = mountTree()
    const all = rows(wrapper)
    ;(all[0]!.element as HTMLElement).focus()
    await all[0]!.trigger('keydown', { key: 'ArrowRight' })
    expect(labelOf(document.activeElement)).toBe('A1')
    const closed = mount(KbTreeRow, { props: { label: 'x', open: false } })
    await closed.trigger('keydown', { key: 'ArrowRight' })
    expect(closed.emitted('toggle')).toHaveLength(1)
    const leaf = mount(KbTreeRow, { props: { label: 'y' } })
    await leaf.trigger('keydown', { key: 'ArrowRight' })
    expect(leaf.emitted('toggle')).toBeUndefined()
    wrapper.unmount()
  })

  it('←:已展开则收起(发 toggle);否则回到父项', async () => {
    const wrapper = mountTree()
    const all = rows(wrapper)
    ;(all[2]!.element as HTMLElement).focus()
    await all[2]!.trigger('keydown', { key: 'ArrowLeft' })
    expect(labelOf(document.activeElement)).toBe('A1')
    const open = mount(KbTreeRow, { props: { label: 'x', open: true } })
    await open.trigger('keydown', { key: 'ArrowLeft' })
    expect(open.emitted('toggle')).toHaveLength(1)
    wrapper.unmount()
  })

  it('Enter 和空格都是选中,并且阻止空格滚动页面', async () => {
    const wrapper = mount(KbTreeRow, { props: { label: 'a' } })
    await wrapper.trigger('keydown', { key: 'Enter' })
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    wrapper.element.dispatchEvent(space)
    expect(wrapper.emitted('select')).toHaveLength(2)
    expect(space.defaultPrevented).toBe(true)
  })

  it('行内小按钮冒泡上来的按键不算选中', async () => {
    const wrapper = mount(KbTreeRow, {
      props: { label: 'a' },
      slots: { actions: '<button type="button" data-testid="inner">分享</button>' },
    })
    await wrapper.find('[data-testid=inner]').trigger('keydown', { key: ' ' })
    await wrapper.find('[data-testid=inner]').trigger('keydown', { key: 'ArrowDown' })
    expect(wrapper.emitted('select')).toBeUndefined()
  })
})
