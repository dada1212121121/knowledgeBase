/**
 * EditorHost × AI 写作（UI-3）
 *
 * 真实 EditorHost + 真实 TextSurface，只把页面的 aiWrite（调后端）换成可观测的假实现。
 * 验证整条链路：入口只在页面接了 AI 写作时出现 → 发起时内容面记下目标并交出选中内容 / 上下文 →
 * 结果在 AI 写作条里预览（替换类逐字对比）→ 点了「替换 / 插入」才写进正文，一步可撤销；
 * 停止 / 关闭后迟到的结果丢掉；要改的那段被删掉了就拒绝写回。
 */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import EditorHost from './EditorHost.vue'
import { TextSurface } from '../surfaces/text/TextSurface'
import { TEXT_SLASH_ACTIONS } from '../extensions/builtin/text'
import type { AiWriteRequest, EditorOpenRequest, Surface, TextServices } from '../types'

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await flushPromises()
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('waitFor 超时')
}

const request = (text: string): EditorOpenRequest => ({
  fileId: 'note_ai',
  collection: 'docs',
  path: 'a.md',
  format: 'md',
  source: { kind: 'text', text, name: 'a.md' },
  readonly: false,
  revision: 1,
  permissions: { read: true, write: true, comment: false, ai: false, export: true },
})

const services: TextServices = {
  collection: () => 'docs',
  sourcePath: () => 'a.md',
  adminView: () => '',
  linkContext: () => ({ collection: 'docs', sourcePath: 'a.md', rawUrl: (c, p) => `/raw/${c}/${p}` }),
  linkStates: () => ({}),
  fileCollections: () => [{ name: 'docs' }],
  searchNotes: async () => [],
  searchFiles: async () => [],
  openLink: () => undefined,
  openAttachment: () => undefined,
  linkError: () => undefined,
}

const surfaces: Surface[] = []
let wrapper: VueWrapper | null = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  for (const surface of surfaces) surface.unmount()
  surfaces.length = 0
  document.body.innerHTML = ''
  localStorage.removeItem('kb.slash.recent')
})

async function mountHost(source: string, aiWrite?: (req: AiWriteRequest) => Promise<string>) {
  const host = mount(EditorHost, {
    props: {
      request: request(source),
      transport: { save: async () => ({ ok: true, revision: 2, sha256: 'x' }) },
      loadSurface: () => {
        // 和真实工厂一样带上斜杠菜单的动作（AI 项是否出现由内容面按「页面接没接 AI 写作」过滤）
        const surface = new TextSurface({ slashActions: TEXT_SLASH_ACTIONS })
        surfaces.push(surface)
        return Promise.resolve(surface)
      },
      textServices: services,
      chromeTitle: false,
      ...(aiWrite ? { aiWrite } : {}),
    },
    attachTo: document.body,
    global: { plugins: [createPinia()] },
  })
  wrapper = host
  await waitFor(() => host.find('.kb-text-prose').exists())
  const view = (surfaces[0] as unknown as { view: EditorView }).view
  const text = async () => ((await (host.vm as unknown as { flushText: () => Promise<string> }).flushText()) ?? '').trim()
  /** 选中正文里的一段文字 */
  const select = (needle: string) => {
    let from = -1
    view.state.doc.descendants((node, pos) => {
      if (from < 0 && node.isText && node.text?.includes(needle)) from = pos + node.text.indexOf(needle)
      return from < 0
    })
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + needle.length)))
  }
  const caretAtEnd = () => view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)))
  return { host, view, text, select, caretAtEnd }
}

/** 可控的假 aiWrite：记下每次请求，由测试决定什么时候、以什么结果完成 */
function controlledAi() {
  const calls: AiWriteRequest[] = []
  const pending: { resolve: (text: string) => void; reject: (err: Error) => void }[] = []
  const aiWrite = vi.fn((req: AiWriteRequest) => {
    calls.push(req)
    return new Promise<string>((resolve, reject) => pending.push({ resolve, reject }))
  })
  return { aiWrite, calls, pending }
}

describe('AI 写作入口', () => {
  it('页面没接 AI 写作：插入下拉里没有「AI 写作…」，斜杠菜单没有 AI 组', async () => {
    const { host, view } = await mountHost('正文')
    await host.find('[data-action="insertMore"]').trigger('click')
    expect(host.find('[data-action="ai.write"]').exists()).toBe(false)
    view.dispatch(view.state.tr.insert(view.state.doc.content.size, view.state.schema.nodes.paragraph.create(null, view.state.schema.text('/'))))
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)))
    await flushPromises()
    // 菜单确实打开了（有别的项），只是没有 AI 组
    expect(document.querySelector('[data-slash-id="table"]')).not.toBeNull()
    expect(document.querySelector('[data-slash-id="ai.write"]')).toBeNull()
    expect(document.querySelector('[data-slash-id="ai.continue"]')).toBeNull()
  })

  it('接了 AI 写作：插入下拉第一项是「AI 写作…」，点开 AI 写作条（输入框获得焦点）', async () => {
    const { aiWrite } = controlledAi()
    const { host } = await mountHost('正文', aiWrite)
    await host.find('[data-action="insertMore"]').trigger('click')
    const first = host.find('[data-testid="editor-dropdown-insertMore"] [data-action]')
    expect(first.attributes('data-action')).toBe('ai.write')
    await first.trigger('click')
    await waitFor(() => host.find('[data-testid="editor-ai-bar"]').exists())
    expect(host.find('[data-testid="editor-ai-bar"]').attributes('data-phase')).toBe('idle')
    await waitFor(() => document.activeElement === host.find('[data-testid="editor-ai-input"]').element)
    expect(aiWrite).not.toHaveBeenCalled()
  })
})

describe('AI 写作流程', () => {
  it('润色选中：生成期间高亮要改的那段；预览逐字对比；「替换选中」写回，一步撤销', async () => {
    const ai = controlledAi()
    const { host, select, text, view } = await mountHost('第一段。\n\n这个功能很好用很好用。', ai.aiWrite)
    ;(host.vm as unknown as { openAi: () => void }).openAi()
    await waitFor(() => host.find('[data-testid="editor-ai-bar"]').exists())
    select('这个功能很好用很好用。')
    await host.find('[data-ai-action="polish"]').trigger('click')
    await waitFor(() => ai.calls.length === 1)
    expect(ai.calls[0]).toMatchObject({ action: 'polish', text: '这个功能很好用很好用。' })
    expect(ai.calls[0]!.context).toContain('第一段。')
    expect(host.find('[data-testid="editor-ai-running"]').exists()).toBe(true)
    expect(view.dom.querySelector('.kb-ai-target')?.textContent).toBe('这个功能很好用很好用。')
    ai.pending[0]!.resolve('这个功能很好用。')
    await waitFor(() => host.find('[data-testid="editor-ai-preview"]').exists())
    expect(host.find('[data-testid="editor-ai-preview"] del').text()).toBe('很好用')
    expect(host.find('[data-testid="editor-ai-replace"]').classes()).toContain('pri')
    // 写进文档之前正文不变
    expect(await text()).toBe('第一段。\n\n这个功能很好用很好用。')
    await host.find('[data-testid="editor-ai-replace"]').trigger('click')
    await waitFor(() => !host.find('[data-testid="editor-ai-bar"]').exists())
    expect(await text()).toBe('第一段。\n\n这个功能很好用。')
    expect(view.dom.querySelector('.kb-ai-target')).toBeNull()
    await (host.vm as unknown as { undo: () => Promise<void> }).undo()
    expect(await text()).toBe('第一段。\n\n这个功能很好用很好用。')
  })

  it('没选中就点润色：直接说明「先选中」，不调后端', async () => {
    const ai = controlledAi()
    const { host, caretAtEnd } = await mountHost('正文', ai.aiWrite)
    caretAtEnd()
    ;(host.vm as unknown as { openAi: () => void }).openAi()
    await waitFor(() => host.find('[data-testid="editor-ai-bar"]').exists())
    await host.find('[data-ai-action="polish"]').trigger('click')
    await waitFor(() => host.find('[data-testid="editor-ai-error"]').exists())
    expect(host.find('[data-testid="editor-ai-error"]').text()).toContain('先选中')
    expect(ai.aiWrite).not.toHaveBeenCalled()
  })

  it('斜杠菜单「AI 续写」：带上文直接生成，「插入」另起一段写在光标所在段落后面', async () => {
    const ai = controlledAi()
    const { host, view, text } = await mountHost('今天完成了部署。', ai.aiWrite)
    // 文末新起一段打 /，选「AI 续写」
    view.dispatch(view.state.tr.insert(view.state.doc.content.size, view.state.schema.nodes.paragraph.create(null, view.state.schema.text('/'))))
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)))
    await flushPromises()
    const item = document.querySelector<HTMLElement>('[data-slash-id="ai.continue"]')
    expect(item).not.toBeNull()
    item!.click()
    await waitFor(() => ai.calls.length === 1)
    expect(ai.calls[0]).toMatchObject({ action: 'continue', text: '' })
    expect(ai.calls[0]!.context).toContain('今天完成了部署。')
    ai.pending[0]!.resolve('明天开始压测。')
    await waitFor(() => host.find('[data-testid="editor-ai-insert"]').exists())
    await host.find('[data-testid="editor-ai-insert"]').trigger('click')
    await waitFor(() => !host.find('[data-testid="editor-ai-bar"]').exists())
    expect(await text()).toBe('今天完成了部署。\n\n明天开始压测。')
  })

  it('总结：主按钮是「插入到下方」，原文保留、总结插在它后面', async () => {
    const ai = controlledAi()
    const { host, select, text } = await mountHost('甲乙丙丁戊。\n\n后面一段。', ai.aiWrite)
    ;(host.vm as unknown as { openAi: () => void }).openAi()
    await waitFor(() => host.find('[data-testid="editor-ai-bar"]').exists())
    select('甲乙丙丁戊。')
    await host.find('[data-ai-action="summarize"]').trigger('click')
    await waitFor(() => ai.calls.length === 1)
    ai.pending[0]!.resolve('- 要点一\n- 要点二')
    await waitFor(() => host.find('[data-testid="editor-ai-below"]').exists())
    expect(host.find('[data-testid="editor-ai-below"]').classes()).toContain('pri')
    await host.find('[data-testid="editor-ai-below"]').trigger('click')
    await waitFor(() => !host.find('[data-testid="editor-ai-bar"]').exists())
    expect(await text()).toBe('甲乙丙丁戊。\n\n- 要点一\n- 要点二\n\n后面一段。')
  })

  it('停止：迟到的结果丢掉，高亮清除，正文不变', async () => {
    const ai = controlledAi()
    const { host, select, text, view } = await mountHost('原文一句。', ai.aiWrite)
    ;(host.vm as unknown as { openAi: () => void }).openAi()
    await waitFor(() => host.find('[data-testid="editor-ai-bar"]').exists())
    select('原文一句。')
    await host.find('[data-ai-action="translate"]').trigger('click')
    await waitFor(() => host.find('[data-testid="editor-ai-stop"]').exists())
    await host.find('[data-testid="editor-ai-stop"]').trigger('click')
    expect(host.find('[data-testid="editor-ai-bar"]').exists()).toBe(false)
    ai.pending[0]!.resolve('One sentence.')
    await flushPromises()
    expect(host.find('[data-testid="editor-ai-bar"]').exists()).toBe(false)
    expect(view.dom.querySelector('.kb-ai-target')).toBeNull()
    expect(await text()).toBe('原文一句。')
  })

  it('生成期间要改的那段被删掉了：点「替换」拒绝写回并说明原因', async () => {
    const ai = controlledAi()
    const { host, select, text, view } = await mountHost('保留。\n\n要被删掉的一段。', ai.aiWrite)
    ;(host.vm as unknown as { openAi: () => void }).openAi()
    await waitFor(() => host.find('[data-testid="editor-ai-bar"]').exists())
    select('要被删掉的一段。')
    await host.find('[data-ai-action="polish"]').trigger('click')
    await waitFor(() => ai.calls.length === 1)
    // 用户（或协同里的别人）把这一段整个删了
    const second = view.state.doc.child(0).nodeSize
    view.dispatch(view.state.tr.delete(second, view.state.doc.content.size).insert(second, view.state.schema.nodes.paragraph.create()))
    ai.pending[0]!.resolve('改好的一段。')
    await waitFor(() => host.find('[data-testid="editor-ai-replace"]').exists())
    await host.find('[data-testid="editor-ai-replace"]').trigger('click')
    await waitFor(() => host.find('[data-testid="editor-ai-error"]').exists())
    expect(host.find('[data-testid="editor-ai-error"]').text()).toContain('请重新生成')
    expect(await text()).not.toContain('改好的一段')
  })

  it('后端报错：错误写在条里，可以换个动作重试', async () => {
    const ai = controlledAi()
    const { host, select } = await mountHost('一句话。', ai.aiWrite)
    ;(host.vm as unknown as { openAi: () => void }).openAi()
    await waitFor(() => host.find('[data-testid="editor-ai-bar"]').exists())
    select('一句话。')
    await host.find('[data-ai-action="polish"]').trigger('click')
    await waitFor(() => ai.calls.length === 1)
    ai.pending[0]!.reject(new Error('今天的 AI 额度已用完'))
    await waitFor(() => host.find('[data-testid="editor-ai-error"]').exists())
    expect(host.find('[data-testid="editor-ai-error"]').text()).toContain('额度已用完')
    expect(host.find('[data-ai-action="translate"]').exists()).toBe(true)
  })
})

describe('在正文里定位文字（AI 修改建议的「在正文里找到」）', () => {
  it('text.locate 选中第一处匹配；找不到返回失败', async () => {
    const { host, view } = await mountHost('第一段。\n\n这里有**要找的**文字。')
    const exec = (host.vm as unknown as { executeCommand: (c: unknown) => Promise<{ ok: boolean }> }).executeCommand
    expect((await exec({ id: 'l1', type: 'text.locate', args: { text: '要找的文字' }, source: 'user', readonlySafe: true })).ok).toBe(true)
    const { from, to } = view.state.selection
    expect(view.state.doc.textBetween(from, to)).toBe('要找的文字')
    expect((await exec({ id: 'l2', type: 'text.locate', args: { text: '不存在' }, source: 'user', readonlySafe: true })).ok).toBe(false)
  })
})
