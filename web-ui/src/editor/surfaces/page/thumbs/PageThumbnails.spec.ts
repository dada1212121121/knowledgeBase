/**
 * 页缩略图栏测试（补全）：无障碍名称、当前页高亮、点击跳页、键盘操作、后台生成与失效、横条形态
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import PageThumbnails from './PageThumbnails.vue'
import type { ThumbBox, ThumbSource } from './types'

const yieldNow = vi.hoisted(() => (run: () => void) => {
  const id = setTimeout(run, 0)
  return () => clearTimeout(id)
})
vi.mock('./thumbQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./thumbQueue')>()
  // 测试里用定时器让出，不依赖 requestIdleCallback
  class TestQueue<A> extends actual.ThumbQueue<A> {
    constructor(options: ConstructorParameters<typeof actual.ThumbQueue<A>>[0]) {
      super({ ...options, yieldFn: yieldNow })
    }
  }
  return { ...actual, ThumbQueue: TestQueue }
})

function fakeSource() {
  const rendered: number[] = []
  const boxes: ThumbBox[] = []
  const released: HTMLElement[] = []
  let disposed = 0
  const source: ThumbSource = {
    async render(index, box) {
      rendered.push(index)
      boxes.push(box)
      const element = document.createElement('div')
      element.className = 'fake-thumb'
      element.textContent = `缩略图 ${index + 1}`
      return element
    },
    release: (element) => released.push(element),
    dispose: () => {
      disposed += 1
    },
  }
  return { source, rendered, boxes, released, disposed: () => disposed }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await vi.advanceTimersByTimeAsync(5)
    await flushPromises()
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function mountRail(props: Record<string, unknown> = {}) {
  const fake = fakeSource()
  const wrapper = mount(PageThumbnails, { props: { count: 20, current: 1, source: fake.source, ...props }, attachTo: document.body })
  return { wrapper, ...fake }
}

describe('PageThumbnails', () => {
  it('每页一个按钮，可访问名称「第 N 页，共 M 页」；当前页带 aria-current 与高亮；缩略图画面对读屏隐藏', async () => {
    const { wrapper } = mountRail({ current: 3 })
    const buttons = wrapper.findAll('[data-testid="page-thumb"]')
    expect(buttons).toHaveLength(20)
    // 可访问名称来自按钮内容（视觉隐藏的文字），不用 aria-label：可见的只有页码数字，两者对不上会被 axe 判名称与可见文字不一致
    expect(buttons[0]!.find('.kb-pgt-name').text()).toBe('第 1 页，共 20 页')
    expect(buttons[19]!.find('.kb-pgt-name').text()).toBe('第 20 页，共 20 页')
    expect(buttons[0]!.attributes('aria-label')).toBeUndefined()
    expect(buttons.filter((button) => button.attributes('aria-current') === 'page').map((button) => button.attributes('data-page'))).toEqual(['3'])
    expect(buttons[2]!.classes()).toContain('is-on')
    expect(wrapper.find('aside').attributes('aria-label')).toBe('页面缩略图')
    expect(wrapper.find('.kb-pgt-slot').attributes('aria-hidden')).toBe('true')
    wrapper.unmount()
  })

  it('点击缩略图发出 select(页码)', async () => {
    const { wrapper } = mountRail()
    await wrapper.findAll('[data-testid="page-thumb"]')[14]!.trigger('click')
    expect(wrapper.emitted('select')).toEqual([[15]])
    wrapper.unmount()
  })

  it('只有一个 Tab 停靠点（当前页）；↓ ↑ 移动焦点，Home / End 到头尾，Enter 跳页，Esc 交还焦点给正文', async () => {
    const { wrapper } = mountRail({ current: 5 })
    const stops = () => wrapper.findAll('[data-testid="page-thumb"]').filter((button) => button.attributes('tabindex') === '0')
    expect(stops().map((button) => button.attributes('data-page'))).toEqual(['5'])

    const list = wrapper.find('.kb-pgt-list')
    const focused = () => (document.activeElement as HTMLElement | null)?.getAttribute('data-page')
    ;(wrapper.findAll('[data-testid="page-thumb"]')[4]!.element as HTMLElement).focus()
    await list.trigger('keydown', { key: 'ArrowDown' })
    await vi.advanceTimersByTimeAsync(1)
    expect(focused()).toBe('6')
    await list.trigger('keydown', { key: 'ArrowUp' })
    await list.trigger('keydown', { key: 'ArrowUp' })
    await vi.advanceTimersByTimeAsync(1)
    expect(focused()).toBe('4')
    await list.trigger('keydown', { key: 'End' })
    await vi.advanceTimersByTimeAsync(1)
    expect(focused()).toBe('20')
    await list.trigger('keydown', { key: 'ArrowDown' })
    await vi.advanceTimersByTimeAsync(1)
    expect(focused()).toBe('20')
    await list.trigger('keydown', { key: 'Home' })
    await vi.advanceTimersByTimeAsync(1)
    expect(focused()).toBe('1')
    // 移动焦点不会翻页；按 Enter（按钮的点击）才翻
    expect(wrapper.emitted('select')).toBeUndefined()
    await wrapper.findAll('[data-testid="page-thumb"]')[0]!.trigger('click')
    expect(wrapper.emitted('select')).toEqual([[1]])
    await list.trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('leave')).toHaveLength(1)
    // 焦点只有一个停靠点
    expect(stops()).toHaveLength(1)
    wrapper.unmount()
  })

  it('主视图翻页（current 变化）：没有焦点在栏里时，Tab 停靠点跟着当前页', async () => {
    const { wrapper } = mountRail({ current: 1 })
    await wrapper.setProps({ current: 9 })
    const stop = wrapper.findAll('[data-testid="page-thumb"]').find((button) => button.attributes('tabindex') === '0')
    expect(stop!.attributes('data-page')).toBe('9')
    wrapper.unmount()
  })

  it('后台生成：每页的缩略图挂进槽里（data-state=ready），先画当前页附近，且每页只画一次', async () => {
    const { wrapper, rendered } = mountRail({ current: 8, cacheLimit: 100 })
    await settle()
    expect(rendered[0]).toBe(7)
    expect(new Set(rendered).size).toBe(rendered.length)
    expect(rendered).toHaveLength(20)
    const slots = wrapper.findAll('.kb-pgt-slot')
    expect(slots.every((slot) => slot.attributes('data-state') === 'ready')).toBe(true)
    expect(slots[7]!.text()).toBe('缩略图 8')
    wrapper.unmount()
  })

  it('invalidate：只重画指定的页，旧图在新图到达前一直在槽里；其余页不动', async () => {
    const { wrapper, rendered } = mountRail({ current: 1, cacheLimit: 100 })
    await settle()
    rendered.length = 0
    const before = wrapper.findAll('.kb-pgt-slot')[12]!.element.firstElementChild
    ;(wrapper.vm as unknown as { invalidateFrom(index: number): void }).invalidateFrom(12)
    expect(wrapper.findAll('.kb-pgt-slot')[12]!.element.firstElementChild).toBe(before)
    await settle()
    expect([...rendered].sort((a, b) => a - b)).toEqual([12, 13, 14, 15, 16, 17, 18, 19])
    expect(wrapper.findAll('.kb-pgt-slot')[12]!.element.firstElementChild).not.toBe(before)
    wrapper.unmount()
  })

  it('页数变少：多出的页消失，生成的缩略图被释放', async () => {
    const { wrapper, released } = mountRail({ cacheLimit: 100 })
    await settle()
    await wrapper.setProps({ count: 15 })
    expect(wrapper.findAll('[data-testid="page-thumb"]')).toHaveLength(15)
    expect(released.length).toBe(5)
    wrapper.unmount()
  })

  it('换来源：旧来源被释放，缩略图用新来源重画；卸载时释放来源', async () => {
    const { wrapper, disposed } = mountRail({ cacheLimit: 100 })
    await settle()
    const next = fakeSource()
    await wrapper.setProps({ source: next.source })
    expect(disposed()).toBe(1)
    await settle()
    expect(next.rendered).toHaveLength(20)
    wrapper.unmount()
    expect(next.disposed()).toBe(1)
  })

  it('纵栏的缩略图宽 144，按页的宽高比定高；横条按固定高度定宽，并且标记方向', async () => {
    const aspects = [816 / 1056, 1056 / 816]
    const { wrapper, boxes } = mountRail({ count: 2, aspects, cacheLimit: 100 })
    await settle()
    const slots = wrapper.findAll('.kb-pgt-slot')
    expect(slots[0]!.attributes('style')).toContain('width: 144px')
    expect(slots[0]!.attributes('style')).toContain('height: 186px')
    // 横向页（宽 > 高）的缩略图更矮
    expect(slots[1]!.attributes('style')).toContain('height: 111px')
    expect(boxes[0]!.dpr).toBeGreaterThanOrEqual(1)

    await wrapper.setProps({ orientation: 'horizontal' })
    await settle()
    expect(wrapper.find('aside').attributes('data-orientation')).toBe('horizontal')
    const strip = wrapper.findAll('.kb-pgt-slot')
    expect(strip[0]!.attributes('style')).toContain('height: 72px')
    expect(strip[1]!.attributes('style')).toContain('width: 93px')
    // 方向变了，缩略图用新盒子重画
    expect(boxes.at(-1)!.height).toBe(72)
    wrapper.unmount()
  })

  it('某页生成失败：该槽标 error，其余页照常', async () => {
    const source: ThumbSource = {
      async render(index) {
        if (index === 1) throw new Error('光栅失败')
        return document.createElement('div')
      },
    }
    const wrapper = mount(PageThumbnails, { props: { count: 4, current: 1, source, cacheLimit: 100 }, attachTo: document.body })
    await settle()
    const states = wrapper.findAll('.kb-pgt-slot').map((slot) => slot.attributes('data-state'))
    expect(states).toEqual(['ready', 'error', 'ready', 'ready'])
    wrapper.unmount()
  })

  it('没有来源（canvas 来源还没就绪）：只显示占位的按钮，不报错', async () => {
    const wrapper = mount(PageThumbnails, { props: { count: 3, current: 2, source: null }, attachTo: document.body })
    await settle()
    expect(wrapper.findAll('[data-testid="page-thumb"]')).toHaveLength(3)
    expect(wrapper.findAll('.kb-pgt-slot').every((slot) => slot.attributes('data-state') === 'pending')).toBe(true)
    wrapper.unmount()
  })
})
