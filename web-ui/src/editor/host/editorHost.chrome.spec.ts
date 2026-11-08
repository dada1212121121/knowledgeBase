/**
 * EditorHost × Chrome 端到端
 *
 * 这一层验证「顶栏按钮 → CommandBus → TextSurface → 文档/保存」真的连通，
 * 而不是只有 Chrome 发出了事件。查找/替换、字数、大纲、导出都走真实 TextSurface，
 * 这样任何一处参数拼错都会在这里暴露。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import EditorHost from './EditorHost.vue'
import { pickHeading } from './chromeTestKit'
import { TextSurface } from '../surfaces/text/TextSurface'
import type { SessionTransport } from '../session/DocumentSession'
import type { EditorOpenRequest, Surface } from '../types'

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await flushPromises()
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('waitFor 超时')
}

function makeRequest(overrides: Partial<EditorOpenRequest> = {}): EditorOpenRequest {
  return {
    fileId: 'note_1',
    collection: 'proj_kb',
    format: 'md',
    source: { kind: 'text', text: '# 周报\n\n今天做了什么，周报要发。', name: '周报.md' },
    readonly: false,
    revision: 4,
    permissions: { read: true, write: true, comment: true, ai: true, export: true },
    ...overrides,
  }
}

function makeTransport() {
  const saves: { text: string }[] = []
  const transport: SessionTransport = {
    save: async (request) => {
      const payload = request.source as { text?: string }
      saves.push({ text: payload.text ?? '' })
      return { ok: true, revision: 5, sha256: 'sha5' }
    },
  }
  return { transport, saves }
}

const surfaces: Surface[] = []
function loadSurface(): Promise<Surface> {
  const surface = new TextSurface()
  surfaces.push(surface)
  return Promise.resolve(surface)
}

function mountHost(overrides: { request?: Partial<EditorOpenRequest>; transport?: SessionTransport } = {}) {
  return mount(EditorHost, {
    props: {
      request: makeRequest(overrides.request),
      transport: overrides.transport ?? makeTransport().transport,
      loadSurface,
      // 真实页面会注入上传通道；这里给一个假实现，验证「插进正文的是地址而不是 base64」
      uploadImage: async () => ({ src: './p.png', alt: '截图' }),
    },
    attachTo: document.body,
  })
}

afterEach(() => {
  for (const surface of surfaces) surface.unmount()
  surfaces.length = 0
  document.body.innerHTML = ''
})

describe('Host × Chrome：工具栏真的改文档', () => {
  it('1. 点二级标题 → 文档变 H2；保存带上 ## 前缀', async () => {
    const { transport, saves } = makeTransport()
    const wrapper = mountHost({ transport })
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())

    await pickHeading(wrapper, 'heading.2')
    await waitFor(() => wrapper.find('.kb-text-prose h2').exists())
    expect(wrapper.find('.kb-text-prose h2').text()).toBe('周报')

    await waitFor(() => wrapper.find('[data-testid="editor-save"]').attributes('disabled') === undefined)
    await wrapper.find('[data-testid="editor-save"]').trigger('click')
    await waitFor(() => saves.length === 1)
    expect(saves[0].text.startsWith('## 周报')).toBe(true)
    wrapper.unmount()
  })

  it('2. 插入表格 → 正文出现表格节点，字数/脏标记同步', async () => {
    const wrapper = mountHost()
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())
    // 表格按钮弹出大小选择面板，点一格按那个大小插入
    await wrapper.find('[data-action="table"]').trigger('click')
    await wrapper.find('[data-testid="table-cell-2-3"]').trigger('click')
    await waitFor(() => wrapper.find('.kb-text-prose table').exists())
    expect(wrapper.findAll('.kb-text-prose table tr')).toHaveLength(2)
    expect(wrapper.findAll('.kb-text-prose table tr:first-child th, .kb-text-prose table tr:first-child td')).toHaveLength(3)
    expect(wrapper.find('[data-testid="editor-status"]').text()).toBe('有未保存的改动')
    wrapper.unmount()
  })

  it('3. 只读请求：写操作按钮不渲染，Chrome 显示「只读」', async () => {
    const wrapper = mountHost({
      request: { readonly: true, permissions: { read: true, write: false, comment: true, ai: true, export: true } },
    })
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())
    expect(wrapper.find('[data-action="bold"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="editor-save"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="editor-status"]').text()).toBe('只读')
    // 只读下查找仍可用
    expect(wrapper.find('[data-action="find"]').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('Host × Chrome：查找 / 替换', () => {
  it('4. 编辑区内 Ctrl+F 打开查找条，输入后显示真实命中数', async () => {
    const wrapper = mountHost()
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())
    const prose = wrapper.find('.kb-text-prose')
    await prose.trigger('keydown', { key: 'f', ctrlKey: true })
    await waitFor(() => wrapper.find('[data-testid="editor-find-bar"]').exists())

    await wrapper.find('[data-testid="editor-find-input"]').setValue('周报')
    await waitFor(() => wrapper.find('[data-testid="editor-find-count"]').text() === '1/2')
    expect(wrapper.find('[data-testid="editor-find-count"]').text()).toBe('1/2')
    wrapper.unmount()
  })

  it('5. Enter 跳下一个匹配，命中数跟着走', async () => {
    const wrapper = mountHost()
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())
    await wrapper.find('.kb-text-prose').trigger('keydown', { key: 'f', ctrlKey: true })
    await waitFor(() => wrapper.find('[data-testid="editor-find-bar"]').exists())
    await wrapper.find('[data-testid="editor-find-input"]').setValue('周报')
    await waitFor(() => wrapper.find('[data-testid="editor-find-count"]').text() === '1/2')
    await wrapper.find('[data-testid="editor-find-input"]').trigger('keydown', { key: 'Enter' })
    await waitFor(() => wrapper.find('[data-testid="editor-find-count"]').text() === '2/2')
    wrapper.unmount()
  })

  it('6. 全部替换 → 保存内容全改；查找串保留、命中归零', async () => {
    const { transport, saves } = makeTransport()
    const wrapper = mountHost({ transport })
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())
    await wrapper.find('.kb-text-prose').trigger('keydown', { key: 'f', ctrlKey: true })
    await waitFor(() => wrapper.find('[data-testid="editor-find-bar"]').exists())
    await wrapper.find('[data-testid="editor-find-input"]').setValue('周报')
    await waitFor(() => wrapper.find('[data-testid="editor-find-count"]').text() === '1/2')
    await wrapper.find('[data-testid="editor-find-toggle-replace"]').trigger('click')
    await wrapper.find('[data-testid="editor-find-replace-input"]').setValue('月报')
    await wrapper.find('[data-testid="editor-find-replace-all"]').trigger('click')
    await waitFor(() => wrapper.find('[data-testid="editor-find-count"]').text() === '无匹配')

    await wrapper.find('.kb-text-prose').trigger('keydown', { key: 'f', ctrlKey: true })
    await wrapper.find('[data-testid="editor-save"]').trigger('click')
    await waitFor(() => saves.length === 1)
    expect(saves[0].text).toContain('# 月报')
    expect(saves[0].text).toContain('月报要发')
    wrapper.unmount()
  })

  it('7. Esc 关闭查找条（不留在文档里）', async () => {
    const wrapper = mountHost()
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())
    await wrapper.find('.kb-text-prose').trigger('keydown', { key: 'f', ctrlKey: true })
    await waitFor(() => wrapper.find('[data-testid="editor-find-bar"]').exists())
    await wrapper.find('[data-testid="editor-find-input"]').trigger('keydown', { key: 'Escape' })
    await waitFor(() => !wrapper.find('[data-testid="editor-find-bar"]').exists())
    wrapper.unmount()
  })
})

describe('Host × Chrome：大纲 / 导出 / AI / 图片', () => {
  it('8. 大纲来自 Surface 查询，点击条目把光标送到对应标题', async () => {
    const wrapper = mountHost({ request: { source: { kind: 'text', text: '# 一\n\n正文\n\n## 二\n\n尾部', name: 'a.md' } } })
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())
    await wrapper.find('[data-action="outline"]').trigger('click')
    const items = wrapper.findAll('.kb-editor-outline-item')
    expect(items.map((item) => item.text())).toEqual(['一', '二'])
    expect(items[1].classes()).toContain('is-h2')
    await items[1].trigger('click')
    // 跳转后选区应在「二」这个标题块里：向上查找最近的标题节点
    await waitFor(() => {
      const selection = window.getSelection()
      const anchorNode = selection?.anchorNode
      let el: Element | null = anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement ?? null
      while (el && !/^H[1-6]$/.test(el.tagName)) el = el.parentElement
      return el?.textContent === '二'
    })
    wrapper.unmount()
  })

  it('9. 导出事件带上当前正文（含未保存改动）', async () => {
    const wrapper = mountHost()
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())
    await pickHeading(wrapper, 'heading.2')
    await waitFor(() => wrapper.find('.kb-text-prose h2').exists())
    await wrapper.find('[data-testid="editor-export"]').trigger('click')
    await waitFor(() => Boolean(wrapper.emitted('export')))
    const payload = wrapper.emitted('export')?.[0]?.[0] as { text: string; name: string }
    expect(payload.name).toBe('周报.md')
    expect(payload.text.startsWith('## 周报')).toBe(true)
    wrapper.unmount()
  })

  it('10. AI 菜单发出动作 id（选中文字由 Host 从会话读取）', async () => {
    const wrapper = mountHost()
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())
    await wrapper.find('[data-testid="editor-ai"]').trigger('click')
    await wrapper.findAll('[data-testid="editor-ai-menu"] [role="menuitem"]')[0].trigger('click')
    await waitFor(() => Boolean(wrapper.emitted('ai')))
    expect((wrapper.emitted('ai')?.[0]?.[0] as { action: string }).action).toBe('polish')
    wrapper.unmount()
  })

  it('11. 图片：上传拿回地址后插入正文，绝不写 base64', async () => {
    const wrapper = mountHost()
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())
    const file = new File(['x'], 'p.png', { type: 'image/png' })
    const input = wrapper.find('[data-testid="editor-image-input"]')
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
    await input.trigger('change')
    await waitFor(() => Boolean(wrapper.find('.kb-text-prose img').exists()))
    // ProseMirror 会插一个无 src 的 separator 占位图，这里按真实地址找
    expect(wrapper.find('.kb-text-prose img[src="./p.png"]').exists()).toBe(true)
    wrapper.unmount()
  })
})
