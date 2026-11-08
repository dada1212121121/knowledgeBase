// DocPage 阅读态:只读正文走 markdown-it,不为「看」笔记付编辑器内核的钱;
// 批注 / 多人编辑的阅读走编辑器外壳(外壳是唯一实现)。静态 import 图也要守住:外壳只能动态进。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DocPage from './DocPage.vue'
import { useSessionStore } from '@/stores/session'

function mountRead(props: Record<string, unknown> = {}) {
  return mount(DocPage, {
    props: { title: '周报', modelValue: '# 周报\n\n今天做了什么。\n\n## 今天\n\n做完的事。\n\n## 明天\n\n继续。', editing: false, ...props },
    attachTo: document.body,
  })
}

/** 等 MarkdownRead 的渲染 + 链接改写落地 */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  const session = useSessionStore()
  session.user = { id: 'usr_me', username: 'me', display_name: '我', email: null, role_id: 'r', space_id: 's', must_change_password: false }
})
afterEach(() => {
  document.body.innerHTML = ''
  window.history.replaceState({}, '', '/')
})

describe('DocPage 阅读态', () => {
  it('只读正文用 MarkdownRead 渲染,不挂编辑器外壳', async () => {
    const wrapper = mountRead()
    await settle()
    expect(wrapper.find('.kb-md-read').exists()).toBe(true)
    expect(wrapper.find('[data-testid="editor-host"]').exists()).toBe(false)
    expect(wrapper.find('.kb-md-read-body h1').text()).toBe('周报')
    expect(wrapper.findAll('.kb-md-read-body h2').map((h) => h.text())).toEqual(['今天', '明天'])
    wrapper.unmount()
  })

  it('默认不显示页面大标题（正文自己有一级标题）；showTitle 才显示（新建笔记要在这里填标题）', async () => {
    const wrapper = mountRead({ title: '周报', modelValue: '# 周报\n\n正文' })
    await settle()
    expect(wrapper.find('.kb-dp-title').exists()).toBe(false)
    expect(wrapper.find('.kb-dp-head').exists()).toBe(false)
    expect(wrapper.find('.kb-md-read-body h1').text()).toBe('周报')
    await wrapper.setProps({ showTitle: true })
    expect(wrapper.find('.kb-dp-title').text()).toBe('周报')
    wrapper.unmount()
  })

  it('正文开头没有一级标题的笔记：名字画成只读大标题；有一级标题（同名或不同名）就以正文为准', async () => {
    const wrapper = mountRead({ title: '现行规范入口', modelValue: '## 背景\n\n说明。\n\n## 做法\n\n步骤。' })
    await settle()
    const shown = wrapper.find('[data-testid="doc-virtual-title"] .kb-dp-title')
    expect(shown.element.tagName).toBe('H1')
    expect(shown.text()).toBe('现行规范入口')
    // 正文开头（跳过提示块）有一级标题：不再画，名字跟着正文
    await wrapper.setProps({ modelValue: '> [!TIP]\n> 先看这里\n\n# 另一个名字\n\n正文' })
    await settle()
    expect(wrapper.find('[data-testid="doc-virtual-title"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('文件（名字是文件名、不能在这里改）和没有名字的笔记不画只读大标题', async () => {
    const file = mountRead({ title: 'notes.md', titleEditable: false, modelValue: '没有标题的正文' })
    await settle()
    expect(file.find('[data-testid="doc-virtual-title"]').exists()).toBe(false)
    file.unmount()
    const untitled = mountRead({ title: '  ', modelValue: '没有标题的正文' })
    await settle()
    expect(untitled.find('[data-testid="doc-virtual-title"]').exists()).toBe(false)
    untitled.unmount()
  })

  it('目录直接来自正文标题,点击滚到对应小节', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    const wrapper = mountRead()
    await settle()
    // 窄屏下目录在抽屉里:先点工具栏的目录按钮解开,再点小节
    await wrapper.find('.kb-dp-toc-btn').trigger('click')
    // 抽屉用 Teleport 挂到 body,不在 wrapper 的 DOM 树里
    const buttons = [...document.querySelectorAll<HTMLElement>('.kb-dp-sheet .kb-dp-toc-item')]
    expect(buttons.map((item) => item.textContent)).toEqual(['今天', '明天'])
    buttons[1].click()
    await settle()
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('阅读态的双链点击交给上层打开笔记', async () => {
    const wrapper = mountRead({
      modelValue: '# 周报\n\n见 [[01a19f63-f0ea-72fe-aa19-9998f6e2e5ad|规范]]',
      collection: 'proj_kb',
    })
    await settle()
    const link = wrapper.find('.kb-md-read a[data-kb-note]')
    expect(link.exists()).toBe(true)
    await link.trigger('click')
    expect(wrapper.emitted('openLink')?.[0]).toEqual(['01a19f63-f0ea-72fe-aa19-9998f6e2e5ad'])
    wrapper.unmount()
  })

  it('要画批注高亮 / 挂「评论」入口的阅读需要 ProseMirror:走外壳的只读打开', async () => {
    const wrapper = mountRead({ annotatable: true })
    // 外壳是异步组件，加载 + 挂内容面要比 MarkdownRead 多几拍
    for (let i = 0; i < 100 && !wrapper.find('.kb-text-prose').exists(); i += 1) await settle()
    expect(wrapper.find('[data-testid="editor-host"]').exists()).toBe(true)
    expect(wrapper.find('.kb-text-prose').attributes('contenteditable')).toBe('false')
    expect(wrapper.find('.kb-md-read').exists()).toBe(false)
    wrapper.unmount()
  })

  it('编辑态进编辑器外壳：即使页面没有保存通道（新建笔记）也一样', async () => {
    const wrapper = mountRead({ editing: true, draftId: null })
    // 新外壳是动态加载的：等它真的渲染出来再断言（只等一拍会把“还没加载”误判成“没挂”）
    for (let i = 0; i < 100 && !wrapper.find('[data-testid="editor-host"]').exists(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(wrapper.find('[data-testid="editor-host"]').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('DocPage 静态 import 图', () => {
  it('外壳只能动态 import:阅读路径的静态闭包里不能有它，也不能有 ProseMirror', () => {
    const sources = import.meta.glob('./DocPage.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    const source = Object.values(sources)[0] ?? ''
    expect(source).toContain("loader: () => import('@/editor/host/EditorHost.vue')")
    expect(source).not.toMatch(/^import EditorHost/m)
    // 旧的 Milkdown 编辑器已删除，页面里不应再有它的任何痕迹
    expect(source).not.toMatch(/DocEditor|milkdown|@milkdown/i)
    // 值导入 ProseMirror / 文本面会把编辑器内核拖回首屏（类型导入在编译期被抹掉，允许）
    for (const line of source.split('\n').filter((l) => /^import .* from '(prosemirror-|@\/editor\/surfaces\/text)/.test(l))) {
      expect(line).toMatch(/^import type /)
    }
  })

  it('点编辑：编辑器起来之前继续显示刚才读的内容（不缩成骨架），起来后一次换上', async () => {
    const wrapper = mountRead()
    await settle()
    expect(wrapper.find('.kb-md-read').exists()).toBe(true)
    await wrapper.setProps({ editing: true })
    // 刚点完：读到的内容还在，编辑器（异步加载中）没有露出来，也没有骨架
    expect(wrapper.find('.kb-md-read').exists()).toBe(true)
    expect(wrapper.find('[data-testid="native-collab-pending"]').exists()).toBe(false)
    // 编辑器好了（ready）：读到的内容撤掉，编辑器露出（不再带交接用的 is-held）
    for (let i = 0; i < 40 && wrapper.find('.kb-md-read').exists(); i += 1) await settle()
    expect(wrapper.find('.kb-md-read').exists()).toBe(false)
    expect(wrapper.find('.kb-editor-host').exists()).toBe(true)
    expect(wrapper.find('.kb-editor-host').classes()).not.toContain('is-held')
    wrapper.unmount()
  })

  it('退出编辑（保存 / 取消）时交接结束，读到的内容由阅读态自己显示', async () => {
    const wrapper = mountRead()
    await settle()
    await wrapper.setProps({ editing: true })
    await wrapper.setProps({ editing: false })
    await settle()
    expect(wrapper.find('.kb-md-read').exists()).toBe(true)
    wrapper.unmount()
  })

  it('图片宽度：地址里的 #w= 拆成 width 属性、地址不带片段；没有宽度的图片不受影响', async () => {
    const wrapper = mountRead({ modelValue: '![甲](/a.png#w=320)\n\n![乙](/b.png)\n' })
    await settle()
    const images = wrapper.findAll('.kb-md-read-body img')
    expect(images).toHaveLength(2)
    expect(images[0]!.attributes('src')).toBe('/a.png')
    expect(images[0]!.attributes('width')).toBe('320')
    expect(images[1]!.attributes('src')).toBe('/b.png')
    expect(images[1]!.attributes('width')).toBeUndefined()
    wrapper.unmount()
  })

  it('附件：[📎 名字](地址 "大小") 渲染成附件卡片（和编辑器同一套类名 / 数据），去掉 📎，点击仍是链接', async () => {
    const wrapper = mountRead({ modelValue: '前文 [📎 季度报告.pdf](/api/v1/raw?collection=c&path=a%2Fq.pdf "2.3 MB") 后文\n\n[普通链接](https://example.com)\n' })
    await settle()
    const card = wrapper.find('.kb-md-read-body a.kb-attach')
    expect(card.exists()).toBe(true)
    expect(card.text()).toBe('季度报告.pdf')
    expect(card.classes()).toContain('is-pdf')
    expect(card.attributes('data-ext')).toBe('PDF')
    expect(card.attributes('data-meta')).toBe('PDF · 2.3 MB')
    expect(card.attributes('title')).toBeUndefined()
    // 普通链接不受影响
    expect(wrapper.findAll('.kb-md-read-body a.kb-attach')).toHaveLength(1)
    wrapper.unmount()
  })
})
