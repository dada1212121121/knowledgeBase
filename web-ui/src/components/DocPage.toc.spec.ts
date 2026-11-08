// 文档页的悬浮大纲:不占版面、标签行里的「大纲」按钮开合、记住选择、编辑时让给工具栏的「大纲」;窄屏是底部抽屉。
// 没选过时:版心两侧的留白放得下大纲卡片就默认展开,放不下默认收起。
// 阅读态由 MarkdownRead 渲染,大纲直接来自正文标题(与真实使用同一条路径)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DocPage from './DocPage.vue'

// 三个标题:两个一级 + 一个二级(buildOutline 会在只有一个 h1 时藏掉它,这里故意两个都留)
const BODY = '# 第一章\n\n## 1.1 小节\n\n正文。\n\n# 第二章\n\n结尾。'

const KEY = 'kb.doc.toc.collapsed'
const clientWidthOf = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
const offsetWidthOf = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')

/**
 * jsdom 不排版:容器宽度(文档页的父元素)和版心宽度(文档页自己,真实页面里限宽 760)都要给出来,
 * 「留白放不放得下大纲卡片」= (容器 - 版心) / 2 ≥ 236 才算得出来
 */
function setWidths(container: number, column = 760) {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => container })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => Math.min(column, container) })
}

async function open(width = 1200) {
  setWidths(width)
  const wrapper = mount(DocPage, {
    props: { title: '文档', modelValue: BODY, editing: false },
    attachTo: document.body,
  })
  // MarkdownRead 在 onMounted 里渲染、渲染完再发大纲,等两拍
  await flushPromises()
  await flushPromises()
  return wrapper
}

function restore(name: 'clientWidth' | 'offsetWidth', descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  // 滚动跟随在 jsdom 里会因为 `window instanceof Window` 不成立而抛错;这里只测大纲的展开 / 折叠,不跑它
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0)
})
afterEach(() => {
  vi.restoreAllMocks()
  restore('clientWidth', clientWidthOf)
  restore('offsetWidth', offsetWidthOf)
  document.body.innerHTML = ''
})

describe('DocPage 悬浮大纲', () => {
  it('留白放不下大纲卡片时默认收起:没有悬浮卡片,标签行里有「大纲」按钮;点开列出所有标题', async () => {
    // 容器 1200、版心 760:两侧各 220,放不下 236 宽的卡片
    const wrapper = await open(1200)
    expect(wrapper.find('[data-testid=doc-toc]').exists()).toBe(false)
    const toggle = wrapper.find('[data-testid=toc-toggle]')
    expect(toggle.text()).toContain('大纲')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    await toggle.trigger('click')
    const toc = wrapper.find('[data-testid=doc-toc]')
    expect(toc.attributes('aria-label')).toBe('大纲')
    expect(toc.findAll('.kb-dp-toc-item').map((item) => item.text())).toEqual(['第一章', '1.1 小节', '第二章'])
    expect(wrapper.find('[data-testid=toc-toggle]').attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('[data-testid=toc-collapse]').attributes('aria-label')).toBe('收起大纲')
  })

  it('没选过、留白够宽(1920 屏上右边空着几百像素)时默认展开', async () => {
    // 容器 1700、版心 760:两侧各 470
    const wrapper = await open(1700)
    expect(wrapper.findAll('[data-testid=doc-toc] .kb-dp-toc-item')).toHaveLength(3)
    expect(wrapper.find('[data-testid=toc-toggle]').attributes('aria-expanded')).toBe('true')
    // 只是默认值,没写进本机记录
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('用户收起过:留白再宽也保持收起', async () => {
    localStorage.setItem(KEY, '1')
    const wrapper = await open(1700)
    expect(wrapper.find('[data-testid=doc-toc]').exists()).toBe(false)
    expect(wrapper.find('[data-testid=toc-toggle]').attributes('aria-expanded')).toBe('false')
  })

  it('展开 / 收起都记在本机:卡片上的「收起大纲」和标签行的按钮是同一个开关', async () => {
    const wrapper = await open(1200)
    await wrapper.find('[data-testid=toc-toggle]').trigger('click')
    expect(localStorage.getItem(KEY)).toBe('0')
    await wrapper.find('[data-testid=toc-collapse]').trigger('click')
    expect(wrapper.find('[data-testid=doc-toc]').exists()).toBe(false)
    expect(localStorage.getItem(KEY)).toBe('1')
  })

  it('上次展开过:留白不够也直接展开', async () => {
    localStorage.setItem(KEY, '0')
    const wrapper = await open(1200)
    expect(wrapper.findAll('[data-testid=doc-toc] .kb-dp-toc-item')).toHaveLength(3)
  })

  it('大纲是浮层:展开 / 收起都不改变版面的 class(正文不会横向跳动)', async () => {
    const wrapper = await open(1200)
    const before = wrapper.find('.kb-dp').classes().join(' ')
    await wrapper.find('[data-testid=toc-toggle]').trigger('click')
    expect(wrapper.find('.kb-dp').classes().join(' ')).toBe(before)
  })

  it('编辑时不显示这一份大纲和按钮(工具栏上有同名的「大纲」)', async () => {
    localStorage.setItem(KEY, '0')
    const wrapper = await open(1200)
    await wrapper.setProps({ editing: true })
    expect(wrapper.find('[data-testid=doc-toc]').exists()).toBe(false)
    expect(wrapper.find('[data-testid=toc-toggle]').exists()).toBe(false)
  })

  it('窄屏:不出现悬浮大纲,标签行里有「大纲」按钮,点开是底部抽屉', async () => {
    const wrapper = await open(600)
    expect(wrapper.find('[data-testid=doc-toc]').exists()).toBe(false)
    const button = wrapper.find('.kb-dp-toc-btn')
    expect(button.text()).toContain('大纲')
    await button.trigger('click')
    const sheet = document.body.querySelector('.kb-dp-sheet')
    expect(sheet?.getAttribute('aria-label')).toBe('大纲')
    expect(document.body.querySelectorAll('.kb-dp-sheet .kb-dp-toc-item')).toHaveLength(3)
  })

  it('标题少于两个:不显示大纲', async () => {
    setWidths(1700)
    const wrapper = mount(DocPage, { props: { title: '文档', modelValue: '# 唯一\n\n正文', editing: false }, attachTo: document.body })
    await flushPromises()
    await flushPromises()
    expect(wrapper.find('[data-testid=doc-toc]').exists()).toBe(false)
    expect(wrapper.find('[data-testid=toc-toggle]').exists()).toBe(false)
  })
})
