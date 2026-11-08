// 溢出的滚动容器要能被键盘聚焦(axe scrollable-region-focusable);不溢出就不加,免得多一个没用的 Tab 停靠点。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { useScrollFocus } from './useScrollFocus'

let sizes = { scrollWidth: 100, clientWidth: 100, scrollHeight: 50, clientHeight: 50 }
let observed: Element[] = []
let fire: () => void = () => {}

function stubLayout() {
  for (const key of Object.keys(sizes) as (keyof typeof sizes)[]) {
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => sizes[key] })
  }
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        fire = callback
      }
      observe(el: Element) {
        observed.push(el)
      }
      disconnect() {}
    },
  )
}

// show=false 模拟「骨架屏阶段容器还不存在」:真实页面里表格要等数据回来才从骨架屏换成 .kb-scroll,容器是挂载之后才出现的
// (只在 onMounted 里量会漏掉,自测时踩到过)
const Host = defineComponent({
  props: { show: { type: Boolean, default: true } },
  setup(props) {
    const el = ref<HTMLElement | null>(null)
    const scrollable = useScrollFocus(el)
    return () => (props.show ? h('div', { ref: el, class: 'box', tabindex: scrollable.value ? 0 : undefined }, [h('table')]) : h('p', '加载中'))
  },
})

afterEach(() => {
  sizes = { scrollWidth: 100, clientWidth: 100, scrollHeight: 50, clientHeight: 50 }
  observed = []
  vi.unstubAllGlobals()
  for (const key of ['scrollWidth', 'clientWidth', 'scrollHeight', 'clientHeight']) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key]
})

describe('useScrollFocus', () => {
  it('容器晚于挂载出现(骨架屏 → 表格):出现之后照样量、照样观察', async () => {
    sizes.scrollWidth = 400
    stubLayout()
    const wrapper = mount(Host, { props: { show: false } })
    await nextTick()
    expect(wrapper.find('.box').exists()).toBe(false)
    await wrapper.setProps({ show: true })
    await nextTick()
    expect(wrapper.find('.box').attributes('tabindex')).toBe('0')
    expect(observed.map((item) => item.tagName)).toEqual(['DIV', 'TABLE'])
  })

  it('不溢出:没有 tabindex', async () => {
    stubLayout()
    const wrapper = mount(Host)
    await nextTick()
    expect(wrapper.find('.box').attributes('tabindex')).toBeUndefined()
  })

  it('横向溢出:挂载后有 tabindex=0', async () => {
    sizes.scrollWidth = 400
    stubLayout()
    const wrapper = mount(Host)
    await nextTick()
    expect(wrapper.find('.box').attributes('tabindex')).toBe('0')
  })

  it('纵向溢出同样算', async () => {
    sizes.scrollHeight = 900
    stubLayout()
    const wrapper = mount(Host)
    await nextTick()
    expect(wrapper.find('.box').attributes('tabindex')).toBe('0')
  })

  it('差 1px 以内是取整误差,不算溢出', async () => {
    sizes.scrollWidth = 101
    stubLayout()
    const wrapper = mount(Host)
    await nextTick()
    expect(wrapper.find('.box').attributes('tabindex')).toBeUndefined()
  })

  it('窗口缩放 / 内容变化后重新量:先溢出、后恢复,tabindex 跟着去掉;容器和它的子元素都在被观察', async () => {
    sizes.scrollWidth = 400
    stubLayout()
    const wrapper = mount(Host)
    await nextTick()
    expect(wrapper.find('.box').attributes('tabindex')).toBe('0')
    expect(observed.map((el) => el.tagName)).toEqual(['DIV', 'TABLE'])
    sizes.scrollWidth = 100
    fire()
    await nextTick()
    expect(wrapper.find('.box').attributes('tabindex')).toBeUndefined()
  })
})
