// DocPage × 选区批注 / 管理员只读巡检：这两处都在编辑器外壳里：
// 批注是只读（或编辑）打开 + 文本面的装饰与浮钮，巡检是 request.readonly + 没有写权限。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import DocPage from './DocPage.vue'
import { useSessionStore } from '@/stores/session'
import type { QuoteItem } from '@/editor/surfaces/text/docPlugins'

const BODY = '# 周报\n\n今天做了什么。\n\n## 今天\n\n做完的事。\n\n## 明天\n\n继续。'
const quote = (id: string, text: string, extra: Partial<QuoteItem> = {}): QuoteItem => ({ id, text, prefix: '', suffix: '', resolved: false, ...extra })

function mountDoc(props: Record<string, unknown> = {}) {
  return mount(DocPage, {
    props: { title: '周报', modelValue: BODY, editing: false, collection: 'docs', sourcePath: 'a.md', ...props },
    attachTo: document.body,
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await flushPromises()
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('等待超时')
}

/** 选中正文里的一段字（ProseMirror 选区 + 浏览器选区），触发「评论」浮钮 */
function selectInProse(text: string): void {
  const prose = document.querySelector('.kb-text-prose')!
  const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.textContent?.indexOf(text) ?? -1
    if (at < 0) continue
    window.getSelection()!.setBaseAndExtent(node, at, node, at + text.length)
    document.dispatchEvent(new Event('selectionchange'))
    return
  }
  throw new Error(`正文里没有「${text}」`)
}

beforeEach(() => {
  setActivePinia(createPinia())
  const session = useSessionStore()
  session.user = { id: 'usr_me', username: 'me', display_name: '我', email: null, role_id: 'r', space_id: 's', must_change_password: false }
  window.history.replaceState({}, '', '/')
})
afterEach(() => {
  document.body.innerHTML = ''
  window.history.replaceState({}, '', '/')
})

describe('选区批注：阅读', () => {
  it('带批注的阅读进新外壳：正文只读、没有工具栏 / 状态栏 / 保存，看起来仍是阅读页', async () => {
    const wrapper = mountDoc({ annotatable: true, quotes: [quote('c1', '做完的事')] })
    await waitFor(() => wrapper.find('.kb-quote').exists())
    expect(wrapper.find('.kb-md-read').exists()).toBe(false)
    expect(wrapper.find('.kb-text-prose').attributes('contenteditable')).toBe('false')
    expect(wrapper.find('[data-testid="editor-chrome"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="editor-save"]').exists()).toBe(false)
    expect(wrapper.find('.kb-editor-status').exists()).toBe(false)
    expect(wrapper.find('[data-testid="editor-host"]').classes()).toContain('is-reading')
    wrapper.unmount()
  })

  it('高亮 + 汇报：找得到的摘录画高亮并汇报 id，找不到的不在其中（评论栏标“原文已改动”）', async () => {
    const wrapper = mountDoc({ annotatable: true, quotes: [quote('c1', '做完的事'), quote('c2', '早就删掉的话')] })
    await waitFor(() => wrapper.find('.kb-quote').exists())
    expect(wrapper.findAll('.kb-quote').map((el) => `${el.attributes('data-quote-id')}:${el.text()}`)).toEqual(['c1:做完的事'])
    await waitFor(() => (wrapper.emitted('quotesLocated')?.length ?? 0) > 0)
    expect(wrapper.emitted('quotesLocated')!.at(-1)).toEqual([['c1']])
    wrapper.unmount()
  })

  it('评论列表之后才加载进来 / 聚焦项切换 / 标成已解决：高亮跟着重算', async () => {
    const wrapper = mountDoc({ annotatable: true, quotes: [] })
    await waitFor(() => wrapper.find('.kb-text-prose').exists())
    await wrapper.setProps({ quotes: [quote('c1', '做完的事')] })
    await waitFor(() => wrapper.find('.kb-quote').exists())
    await wrapper.setProps({ activeQuote: 'c1' })
    await waitFor(() => wrapper.find('.kb-quote').classes().includes('is-active'))
    await wrapper.setProps({ quotes: [quote('c1', '做完的事', { resolved: true })] })
    await waitFor(() => wrapper.find('.kb-quote').classes().includes('is-resolved'))
    wrapper.unmount()
  })

  it('选中文字 → 点「评论」→ 页面收到 annotate（摘录 + 前后文）', async () => {
    const wrapper = mountDoc({ annotatable: true })
    await waitFor(() => wrapper.find('.kb-text-prose').exists())
    selectInProse('做完的事')
    await waitFor(() => !!document.querySelector('[data-testid="annotate-selection"]:not([hidden])'))
    ;(document.querySelector('[data-testid="annotate-selection"]') as HTMLButtonElement).click()
    expect(wrapper.emitted('annotate')).toHaveLength(1)
    expect(wrapper.emitted('annotate')![0]![0]).toMatchObject({ kind: 'quote', text: '做完的事' })
    wrapper.unmount()
  })

  it('不能评论（annotatable 为 false，如没有评论权限）：选中文字不出现入口', async () => {
    const wrapper = mountDoc({ annotatable: false, quotes: [quote('c1', '做完的事')] })
    await waitFor(() => wrapper.find('.kb-quote').exists())
    selectInProse('继续')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(document.querySelector('[data-testid="annotate-selection"]:not([hidden])')).toBeNull()
    wrapper.unmount()
  })

  it('点高亮 → quoteClick；scrollToQuote 找得到返回 true、原文已改动返回 false', async () => {
    const wrapper = mountDoc({ annotatable: true, quotes: [quote('c1', '做完的事'), quote('c2', '早就删掉的话')] })
    await waitFor(() => wrapper.find('.kb-quote').exists())
    await wrapper.find('.kb-quote').trigger('click')
    expect(wrapper.emitted('quoteClick')).toEqual([['c1']])
    const api = wrapper.vm as unknown as { scrollToQuote: (id: string) => boolean | Promise<boolean> }
    expect(await api.scrollToQuote('c1')).toBe(true)
    expect(await api.scrollToQuote('c2')).toBe(false)
    wrapper.unmount()
  })

  it('没有批注、也不可评论的阅读仍是轻量阅读（不为看笔记付编辑器内核）', async () => {
    const wrapper = mountDoc()
    await waitFor(() => wrapper.find('.kb-md-read').exists())
    expect(wrapper.find('[data-testid="editor-host"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('阅读 → 编辑：外壳重建为可写（会话的只读在打开时定下来），批注高亮仍在', async () => {
    const wrapper = mountDoc({ annotatable: true, quotes: [quote('c1', '做完的事')] })
    await waitFor(() => wrapper.find('.kb-quote').exists())
    expect(wrapper.find('.kb-text-prose').attributes('contenteditable')).toBe('false')
    await wrapper.setProps({ editing: true, annotatable: false, saveBody: async () => ({ ok: true, revision: 2, sha256: 'x' }) })
    await waitFor(() => wrapper.find('.kb-text-prose').attributes('contenteditable') === 'true')
    expect(wrapper.find('[data-testid="editor-chrome"]').exists()).toBe(true)
    await waitFor(() => wrapper.find('.kb-quote').exists())
    // 编辑态不再给“评论”入口（annotatable 为 false）
    wrapper.unmount()
  })

  it('目录：新外壳里点目录条目能跳到对应标题（以前只有旧编辑器 / 轻量阅读有标题元素）', async () => {
    const scrolls: string[] = []
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value(this: HTMLElement) {
        scrolls.push(this.textContent ?? '')
      },
    })
    const wrapper = mountDoc({ annotatable: true })
    await waitFor(() => wrapper.find('.kb-text-prose h2').exists())
    await waitFor(() => wrapper.find('.kb-dp-toc-btn').exists())
    await wrapper.find('.kb-dp-toc-btn').trigger('click')
    const items = document.querySelectorAll<HTMLElement>('.kb-dp-sheet .kb-dp-toc-item')
    // 文档里唯一的一级标题不进目录（buildOutline 的既有规则）；条目的 index 仍是它在全部标题里的下标，所以点“明天”要对上第 3 个标题元素
    expect([...items].map((el) => el.textContent?.trim())).toEqual(['今天', '明天'])
    items[1]!.click()
    expect(scrolls).toEqual(['明天'])
    wrapper.unmount()
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  })
})

describe('管理员只读巡检', () => {
  it('巡检（adminView）即使进到“编辑态”也是只读打开：不能输入、没有保存、没有写工具；能看、能查找', async () => {
    const saveBody = vi.fn(async () => ({ ok: true, revision: 2, sha256: 'x' }))
    const wrapper = mountDoc({ editing: true, adminView: 'usr_other', saveBody })
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())
    expect(wrapper.find('.kb-text-prose').attributes('contenteditable')).toBe('false')
    // 工具栏里只剩只读安全的动作（查找 / 大纲），写入类整颗消失；没有保存 / 撤销 / 重做
    expect(wrapper.find('[data-action="find"]').exists()).toBe(true)
    expect(wrapper.find('[data-action="bold"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="editor-save"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="editor-undo"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="editor-status"]').text()).toContain('只读')
    // Ctrl+S 也不会把任何东西交给保存通道
    wrapper.find('.kb-text-prose').element.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(saveBody).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('巡检时即使页面说“可评论”，选中文字也不出现入口（评论是对别人库的写操作）', async () => {
    const wrapper = mountDoc({ adminView: 'usr_other', annotatable: true, quotes: [quote('c1', '做完的事')] })
    await waitFor(() => wrapper.find('.kb-quote').exists())
    selectInProse('继续')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(document.querySelector('[data-testid="annotate-selection"]:not([hidden])')).toBeNull()
    // 但别人的批注高亮能看到，点了照样定位评论（先取消上面选中的字：选着字时的点击不算点高亮）
    window.getSelection()!.removeAllRanges()
    await wrapper.find('.kb-quote').trigger('click')
    expect(wrapper.emitted('quoteClick')).toEqual([['c1']])
    wrapper.unmount()
  })

  it('flush 在只读打开时不回写正文（阅读态的 v-model 不会被弄脏）', async () => {
    const wrapper = mountDoc({ editing: true, adminView: 'usr_other' })
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())
    const api = wrapper.vm as unknown as { flush: () => string | undefined; flushAsync: () => Promise<string | undefined> }
    expect(api.flush()).toBe(BODY)
    expect(await api.flushAsync()).toBe(BODY)
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    wrapper.unmount()
  })
})

describe('多人房间里的阅读', () => {
  it('带多人房间的阅读也在新外壳里（不再为 y-prosemirror 回旧编辑器）', async () => {
    const doc = new Y.Doc()
    const state = { status: 'synced', writable: false, ready: true, everSynced: true, initMarkdown: null, pendingLocal: false }
    const room = {
      fragment: doc.getXmlFragment('prosemirror'),
      awareness: new Awareness(doc),
      getState: () => state,
      subscribe: () => () => undefined,
      on: () => () => undefined,
      initDone: () => undefined,
      destroy: () => undefined,
    }
    const wrapper = mountDoc({ collab: room })
    await waitFor(() => wrapper.find('[data-testid="editor-host"]').exists())
    wrapper.unmount()
  })
})
