// DocPage × 编辑器外壳（笔记默认走外壳；外壳是唯一实现）：编辑态正文换 EditorHost。
// 保存必须把外壳里的最新正文交出去，不能拿初始文本。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DocPage from './DocPage.vue'
import { pickHeading } from '@/editor/host/chromeTestKit'
import { useSessionStore } from '@/stores/session'
import type { SaveResult } from '@/editor/types'

const BODY = '# 周报\n\n今天做了什么。\n\n## 今天\n\n做完的事。'

function mountNative(props: Record<string, unknown> = {}) {
  return mount(DocPage, {
    props: {
      title: '周报',
      modelValue: BODY,
      editing: true,
      saveBody: async () => ({ ok: true, revision: 2, sha256: 'sha2' }) as SaveResult,
      ...props,
    },
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

describe('DocPage 新编辑器外壳', () => {
  it('AI 写作（UI-3）：账号有 AI 助手时插入下拉里有「AI 写作…」；没有（含 AI 总开关关闭）就没有', async () => {
    const session = useSessionStore()
    session.loaded = true
    session.features = new Set(['ai.assistant'])
    const withAi = mountNative()
    await waitFor(() => withAi.find('.kb-text-prose h1').exists())
    await withAi.find('[data-action="insertMore"]').trigger('click')
    expect(withAi.find('[data-action="ai.write"]').exists()).toBe(true)
    withAi.unmount()
    session.features = new Set()
    const withoutAi = mountNative()
    await waitFor(() => withoutAi.find('.kb-text-prose h1').exists())
    await withoutAi.find('[data-action="insertMore"]').trigger('click')
    expect(withoutAi.find('[data-action="insertMore"]').exists()).toBe(true)
    expect(withoutAi.find('[data-action="ai.write"]').exists()).toBe(false)
    withoutAi.unmount()
    session.loaded = false
  })

  it('1. 默认（不带参数）编辑态挂 EditorHost 与真实 Text Surface', async () => {
    const wrapper = mountNative()
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())
    expect(wrapper.find('[data-testid="editor-host"]').exists()).toBe(true)
    expect(wrapper.find('.kb-text-prose h1').text()).toBe('周报')
    // 页面自己有标题与「完成」入口，外壳里不能再出现一份标题 / 关闭按钮
    expect(wrapper.find('.kb-editor-chrome-title').exists()).toBe(false)
    expect(wrapper.find('[data-testid="editor-close"]').exists()).toBe(false)
    // 底部状态栏（有未保存的改动 / 字数）也不画：保存状态在顶栏、字数在页头标签行，不重复
    expect(wrapper.find('.kb-editor-status').exists()).toBe(false)
    wrapper.unmount()
  })

  it('2. 工具栏改标题后 Ctrl+S 保存，交给页面的是最新正文', async () => {
    const saveBody = vi.fn(async (_text: string) => ({ ok: true, revision: 3, sha256: 'sha3' }) as SaveResult)
    const wrapper = mountNative({ saveBody })
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())

    await pickHeading(wrapper, 'heading.2')
    await waitFor(() => wrapper.find('.kb-text-prose h2').exists())
    // 页面有自己的「保存」，外壳不再给第二个；外壳内的 Ctrl+S 照常保存正文
    expect(wrapper.find('[data-testid="editor-save"]').exists()).toBe(false)
    await wrapper.find('.kb-text-prose').trigger('keydown', { key: 's', ctrlKey: true })
    await waitFor(() => saveBody.mock.calls.length === 1)
    await waitFor(() => wrapper.emitted('update:modelValue') !== undefined)

    expect(saveBody.mock.calls[0][0]).toContain('## 周报')
    // 页面通过 @change 拿到同一份正文，草稿 / v-model 不会停在初始版本
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toContain('## 周报')
    wrapper.unmount()
  })

  it('3. 工具栏撤销走内容面自己的历史，标题恢复原级别', async () => {
    const wrapper = mountNative()
    await waitFor(() => wrapper.find('.kb-text-prose h2').exists())
    await pickHeading(wrapper, 'heading.3')
    await waitFor(() => wrapper.find('.kb-text-prose h3').exists())
    await wrapper.find('[data-testid="editor-undo"]').trigger('click')
    await waitFor(() => wrapper.find('.kb-text-prose h3').exists() === false)
    expect(wrapper.find('.kb-text-prose h2').text()).toBe('今天')
    wrapper.unmount()
  })

  it('4. flushAsync 返回外壳里最新的序列化正文', async () => {
    const wrapper = mountNative()
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())
    await pickHeading(wrapper, 'heading.2')
    await waitFor(() => wrapper.find('.kb-text-prose h2').exists())
    const api = wrapper.vm as unknown as { flushAsync: () => Promise<string | undefined> }
    const text = await api.flushAsync()
    expect(text).toContain('## 周报')
    wrapper.unmount()
  })

  it('5. 新建笔记（没有保存通道）也走新外壳；Ctrl+S 等同页头的「保存」，发 save 事件', async () => {
    const wrapper = mountNative({ saveBody: undefined })
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())
    const prose = wrapper.find('.kb-text-prose')
    prose.element.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }))
    // 先改点什么，保存按钮才有效；Host 的快捷键走会话保存 → 传输层 → 页面的 save 事件
    await pickHeading(wrapper, 'heading.2')
    prose.element.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }))
    await waitFor(() => (wrapper.emitted('save')?.length ?? 0) >= 1)
    wrapper.unmount()
  })

  it('6. 编辑里的最新正文同步给父级（草稿靠它），页面服务接上了外壳（选择器入口可用）', async () => {
    const wrapper = mountNative({ collection: 'docs', sourcePath: 'a.md' })
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())
    await pickHeading(wrapper, 'heading.2')
    await waitFor(() => (wrapper.emitted('update:modelValue')?.length ?? 0) > 0)
    expect(wrapper.find('[data-testid="text-panels"]').exists()).toBe(true)
    await wrapper.find('[data-action="insertMore"]').trigger('click')
    expect(wrapper.find('[data-action="wikilink"]').exists()).toBe(true)
    expect(wrapper.find('[data-action="filelink"]').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('DocPage 新外壳 · 焦点（切换默认后不能丢的旧行为）', () => {
  it('7. 标题里按回车跳进正文（新建笔记的第一步）', async () => {
    const wrapper = mountNative({ saveBody: undefined, title: '新标题', modelValue: '', showTitle: true })
    await waitFor(() => wrapper.find('.kb-text-prose').exists())
    const title = wrapper.find('textarea.kb-dp-title')
    ;(title.element as HTMLElement).focus()
    await title.trigger('keydown', { key: 'Enter' })
    await waitFor(() => document.activeElement === wrapper.find('.kb-text-prose').element)
    wrapper.unmount()
  })

  it('8. 进入编辑时有标题就把光标放进正文；标题还空着（新笔记）焦点留在标题', async () => {
    const filled = mountNative({ title: '周报' })
    await waitFor(() => document.activeElement === filled.find('.kb-text-prose').element)
    filled.unmount()
    document.body.innerHTML = ''
    const empty = mountNative({ title: '', saveBody: undefined, modelValue: '', showTitle: true })
    await waitFor(() => empty.find('.kb-text-prose').exists())
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(document.activeElement === empty.find('.kb-text-prose').element).toBe(false)
    empty.unmount()
  })
})
