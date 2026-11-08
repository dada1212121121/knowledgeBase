// 笔记 / 集合行的右键菜单:点条目执行并且只执行一次;Esc 与点外面都关。
// 菜单用 Teleport 挂到 body(不被祖先的 overflow 裁掉),所以断言查 document.body。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import RowActionMenu, { type RowMenuState } from './RowActionMenu.vue'

const state = (): RowMenuState => ({
  x: 40,
  y: 60,
  title: '发布流程',
  subtitle: '笔记',
  entries: [
    { label: '打开', run: vi.fn() },
    { label: '删除…', run: vi.fn(), danger: true },
  ],
})
const menuEl = () => document.body.querySelector<HTMLElement>('.kb-row-menu')
const items = () => [...document.body.querySelectorAll<HTMLElement>('[data-testid="row-menu-item"]')]

afterEach(() => {
  document.body.innerHTML = ''
})

describe('RowActionMenu', () => {
  it('点条目先关菜单再执行动作', async () => {
    const menu = state()
    const wrapper = mount(RowActionMenu, { props: { state: menu } })
    expect(items().map((node) => node.textContent?.trim())).toEqual(['打开', '删除…'])
    items()[0].click()
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(menu.entries[0].run).toHaveBeenCalledTimes(1)
  })

  it('Esc 关闭', async () => {
    const wrapper = mount(RowActionMenu, { props: { state: state() } })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('点空白处关闭,点菜单内部不关', async () => {
    const wrapper = mount(RowActionMenu, { props: { state: state() } })
    // jsdom 没有 PointerEvent:用同名的 Event 触发(监听只看 type)
    menuEl()?.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('close')).toBeUndefined()
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('贴近视口下沿时向上收,不把菜单切出屏幕', () => {
    const menu = { ...state(), y: window.innerHeight - 4 }
    mount(RowActionMenu, { props: { state: menu } })
    const top = Number.parseFloat(menuEl()?.style.top ?? '0')
    expect(top + 42 + menu.entries.length * 34).toBeLessThanOrEqual(window.innerHeight)
  })
})
