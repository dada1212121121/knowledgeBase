/**
 * EditorHost × 内置扩展
 *
 * 证明两件事：
 * 1. 评论 / 导出 / AI / 字数 / 各内容面的工具栏「真的」由注册表里的内置扩展提供：把对应的内置扩展卸掉，
 *    界面上的入口就消失；Host 自己没有硬编码任何一个。
 * 2. 示例第三方插件（`examples/editor-word-count`）不改 Host 的任何代码就能装上、运行、卸载：
 *    用的是仓库里真实的 `index.js` + `manifest.toml`，经和线上一样的加载器装进注册表，挂在真实的 EditorHost + 文本面上。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { toasts } from '@kb-ui/components/useToast'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import MANIFEST_TOML from '../../../examples/editor-word-count/manifest.toml?raw'
import SNAPSHOT_RAW from '../../../../crates/kb-web/tests/fixtures/editor-word-count.manifest.json?raw'
import EditorHost from './EditorHost.vue'
import { TextSurface } from '../surfaces/text/TextSurface'
import { BUILTIN_AI_ID } from '../extensions/builtin/ai.ext'
import { BUILTIN_COMMENT_ID } from '../extensions/builtin/comment.ext'
import { BUILTIN_EXPORT_ID } from '../extensions/builtin/export.ext'
import { BUILTIN_STATS_ID } from '../extensions/builtin/stats.ext'
import { BUILTIN_TEXT_ID } from '../extensions/builtin/text.ext'
import { loadInstalledExtensions } from '../extensions/loader'
import { parseManifest } from '../extensions/manifest'
import { getExtensionRegistry, resetExtensionRuntime } from '../extensions/runtime'
import { defineExtension } from '../api'
import { manifestFor } from '../extensions/__fixtures__/testkit'
import { resetSurfaceRegistry } from '../surfaces/registry'
import type { EditorOpenRequest, Surface } from '../types'
import { parseToml } from '../../../e2e/toml-lite.mjs'

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
    source: { kind: 'text', text: '# 周报\n\nhello world 你好', name: '周报.md' },
    readonly: false,
    revision: 4,
    permissions: { read: true, write: true, comment: true, ai: true, export: true },
    ...overrides,
  }
}

const surfaces: Surface[] = []
function loadText(): Promise<Surface> {
  const surface = new TextSurface()
  surfaces.push(surface)
  return Promise.resolve(surface)
}

function mountHost(overrides: { request?: Partial<EditorOpenRequest>; capabilities?: { ai?: boolean; comment?: boolean; export?: boolean } } = {}) {
  return mount(EditorHost, {
    props: {
      request: makeRequest(overrides.request),
      transport: { save: async () => ({ ok: true, revision: 5, sha256: 'sha5' }) },
      loadSurface: loadText,
      ...(overrides.capabilities ? { capabilities: overrides.capabilities } : {}),
    },
    attachTo: document.body,
  })
}

beforeEach(() => {
  resetExtensionRuntime()
  toasts.length = 0
})
afterEach(() => {
  for (const surface of surfaces) surface.unmount()
  surfaces.length = 0
  document.body.innerHTML = ''
  resetExtensionRuntime()
  resetSurfaceRegistry()
})

describe('内置功能由贡献点提供：卸掉对应的内置扩展，入口就消失', () => {
  it('1. 导出：按钮是 kb.builtin.export 的贡献；点击经注册表命令 → 页面通道 → export 事件（带当前正文）', async () => {
    const wrapper = mountHost()
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())
    const button = wrapper.find('[data-testid="editor-export"]')
    expect(button.attributes('aria-label')).toBe('导出 Markdown')
    expect(getExtensionRegistry().list().map((item) => item.manifest.id)).toContain(BUILTIN_EXPORT_ID)
    await button.trigger('click')
    await waitFor(() => Boolean(wrapper.emitted('export')))
    expect(wrapper.emitted('export')?.[0]?.[0]).toMatchObject({ name: '周报.md', text: expect.stringContaining('周报') })

    await getExtensionRegistry().uninstall(BUILTIN_EXPORT_ID)
    await waitFor(() => !wrapper.find('[data-testid="editor-export"]').exists())
    wrapper.unmount()
  })

  it('2. 评论：按钮是 kb.builtin.comment 的贡献；事件带选区文字；卸载后消失；页面没接入评论能力时本来就不出现', async () => {
    const off = mountHost({ capabilities: { comment: false, export: true } })
    await waitFor(() => off.find('[data-testid="editor-export"]').exists())
    expect(off.find('[data-testid="editor-comment"]').exists()).toBe(false)
    off.unmount()

    const wrapper = mountHost({ capabilities: { comment: true, export: true } })
    await waitFor(() => wrapper.find('[data-testid="editor-comment"]').exists())
    const session = (wrapper.vm as unknown as { activeSession: { setSelection(selection: unknown): void } }).activeSession
    session.setSelection({ text: '周报', anchor: { kind: 'text', block: 'h1:0', offset: 0 } })
    await wrapper.find('[data-testid="editor-comment"]').trigger('click')
    await waitFor(() => Boolean(wrapper.emitted('comment')))
    expect(wrapper.emitted('comment')?.[0]?.[0]).toEqual({ text: '周报', anchor: { kind: 'text', block: 'h1:0', offset: 0 } })

    await getExtensionRegistry().uninstall(BUILTIN_COMMENT_ID)
    await waitFor(() => !wrapper.find('[data-testid="editor-comment"]').exists())
    wrapper.unmount()
  })

  it('3. AI：润色 / 总结 / 翻译是 kb.builtin.ai 的三个 AI 工具；点击把「动作 + 选区」交给页面，不弹「建议」条；卸载后 AI 菜单消失', async () => {
    const wrapper = mountHost({ capabilities: { ai: true, export: true } })
    await waitFor(() => wrapper.find('[data-testid="editor-ai"]').exists())
    await wrapper.find('[data-testid="editor-ai"]').trigger('click')
    expect(wrapper.findAll('[data-testid="editor-ai-menu"] [role="menuitem"]').map((item) => item.text())).toEqual(['润色选中', '总结选中', '翻译选中'])
    await wrapper.find('[data-ai-tool="translate"]').trigger('click')
    await waitFor(() => Boolean(wrapper.emitted('ai')))
    expect(wrapper.emitted('ai')?.[0]?.[0]).toEqual({ action: 'translate', text: '' })
    expect(wrapper.find('[data-testid="editor-ai-suggestion"]').exists()).toBe(false)

    await getExtensionRegistry().uninstall(BUILTIN_AI_ID)
    await waitFor(() => !wrapper.find('[data-testid="editor-ai"]').exists())
    wrapper.unmount()
  })

  it('4. AI：页面没接入 AI 能力时内置三项不出现，但文档有 AI 权限的第三方工具照常出现（并以建议条交付）', async () => {
    await getExtensionRegistry().install(
      manifestFor({ id: 'kb.ai.third', permissions: ['ai', 'document.read'], contributes: { aiTools: [{ id: 'kb.ai.third.up', title: '转大写' }] } }),
      defineExtension({ activate: (ctx) => void ctx.registerAITool({ id: 'kb.ai.third.up', title: '转大写', run: (input) => ({ text: input.text.toUpperCase() }) }) }),
    )
    const wrapper = mountHost({ capabilities: { ai: false } })
    await waitFor(() => wrapper.find('[data-testid="editor-ai"]').exists())
    await wrapper.find('[data-testid="editor-ai"]').trigger('click')
    expect(wrapper.findAll('[data-testid="editor-ai-menu"] [role="menuitem"]').map((item) => item.text())).toEqual(['转大写'])
    await wrapper.find('[data-ai-tool="kb.ai.third.up"]').trigger('click')
    await waitFor(() => wrapper.find('[data-testid="editor-ai-suggestion"]').exists())
    expect(wrapper.emitted('ai')).toBeUndefined()
    wrapper.unmount()
  })

  it('5. 字数：顶栏与底部状态栏的计数是 kb.builtin.stats 的两个状态栏项；卸载后两处都消失，换成别的状态栏项就显示别的', async () => {
    const wrapper = mountHost()
    await waitFor(() => wrapper.find('[data-testid="editor-chrome-count"]').exists())
    expect(wrapper.find('[data-testid="editor-chrome-count"]').text()).toMatch(/^\d+ 字$/)
    expect(wrapper.find('[data-testid="editor-status-count"]').text()).toMatch(/^\d+ 字$/)

    await getExtensionRegistry().uninstall(BUILTIN_STATS_ID)
    await waitFor(() => !wrapper.find('[data-testid="editor-chrome-count"]').exists())
    expect(wrapper.find('[data-testid="editor-status-count"]').exists()).toBe(false)

    // 第三方也能提供计数：状态栏项能读到内容面上报的字数
    await getExtensionRegistry().install(
      manifestFor({ id: 'kb.st3', permissions: ['ui'], contributes: { toolbar: [{ id: 'kb.st3.item' }] } }),
      defineExtension({ activate: (ctx) => void ctx.registerStatusItem({ id: 'kb.st3.item', area: 'status', text: (state) => `${state.words}/${state.format}` }) }),
    )
    await waitFor(() => wrapper.find('[data-testid="editor-status-kb.st3.item"]').exists())
    expect(wrapper.find('[data-testid="editor-status-kb.st3.item"]').text()).toMatch(/^\d+\/md$/)
    wrapper.unmount()
  })

  it('6. 文本面的格式工具栏与斜杠菜单是 kb.builtin.text 的贡献：卸载后格式按钮全部消失（Host 没有自己的一份）', async () => {
    const wrapper = mountHost()
    await waitFor(() => wrapper.find('[data-action="bold"]').exists())
    await getExtensionRegistry().uninstall(BUILTIN_TEXT_ID)
    await waitFor(() => !wrapper.find('[data-action="bold"]').exists())
    // 视图类按钮属于另一个内置扩展，不受影响
    expect(wrapper.find('[data-action="find"]').exists()).toBe(true)
    wrapper.unmount()
  })
})

// 和线上一样是一个纯 ES 模块；用 glob 引入是因为它是 .js、没有类型声明（examples.spec.ts 同一做法）
const exampleModules = import.meta.glob('../../../examples/editor-word-count/index.js') as Record<string, () => Promise<unknown>>

describe('示例插件 editor-word-count：不改 Host，装上即用，卸载即走', () => {
  function exampleManifest() {
    const parsed = parseManifest(parseToml(MANIFEST_TOML))
    if (!parsed.ok) throw new Error(parsed.errors.join('；'))
    return parsed.manifest
  }

  /** 和线上一样走加载器：后端清单接口返回真实快照，入口脚本用仓库里真实的 index.js */
  async function installExample() {
    const module = await Object.values(exampleModules)[0]!()
    const respond = (data: unknown) => async () => new Response(JSON.stringify({ ok: true, data }), { status: 200 })
    const listing = { enabled: true, dir: '/x', extensions: [{ id: 'kb.word-count', dir: 'kb.word-count', manifest: JSON.parse(SNAPSHOT_RAW), error: null }] }
    const sync = (data: unknown) => loadInstalledExtensions({ registry: getExtensionRegistry(), fetch: respond(data), importModule: async () => module })
    return { installed: () => sync(listing), removed: () => sync({ enabled: false, extensions: [] }) }
  }

  it('7. 装上后：工具栏按钮和面板开关出现；打开面板能看到统计，随输入变化；卸载后按钮、面板、命令全部消失', async () => {
    expect(exampleManifest().id).toBe('kb.word-count')
    const wrapper = mountHost()
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())
    // 装之前没有
    expect(wrapper.find('[data-action="kb.word-count.button"]').exists()).toBe(false)
    expect(wrapper.find('[data-ext-panel-toggle]').exists()).toBe(false)

    const example = await installExample()
    const report = await example.installed()
    expect(report.loaded).toEqual(['kb.word-count'])

    // 工具栏按钮（扩展分组）和面板开关出现——Host 没有为这个扩展改过任何东西
    await waitFor(() => wrapper.find('[data-action="kb.word-count.button"]').exists())
    expect(wrapper.find('[data-action="kb.word-count.button"]').attributes('aria-label')).toBe('Σ 字数统计')
    const toggle = wrapper.find('[data-ext-panel-toggle="kb.word-count:kb.word-count.panel"]')
    expect(toggle.exists()).toBe(true)

    // 面板：初始统计（“周报” 2 个汉字 + “你好” 2 个 = 4；英文词 hello world = 2）
    await toggle.trigger('click')
    await waitFor(() => wrapper.find('[data-testid="wc-cjk"]').exists() && wrapper.find('[data-testid="wc-cjk"]').text() !== '—')
    expect(wrapper.find('[data-testid="wc-cjk"]').text()).toBe('4')
    expect(wrapper.find('[data-testid="wc-words"]').text()).toBe('2')

    // 字数随输入变化：往文档里插入文字，防抖后面板重新统计
    const host = wrapper.vm as unknown as { executeCommand(command: unknown): Promise<{ ok: boolean }> }
    const typed = await host.executeCommand({ id: 'type_1', type: 'text.insert', args: { text: '再来五个字 and three more' }, source: 'user' })
    expect(typed.ok).toBe(true)
    await waitFor(() => wrapper.find('[data-testid="wc-cjk"]').text() === '9')
    expect(wrapper.find('[data-testid="wc-words"]').text()).toBe('5')

    // 工具栏按钮：点击执行扩展命令，给出提示（命令里 notify 走 toast）
    await wrapper.find('[data-action="kb.word-count.button"]').trigger('click')
    await waitFor(() => toasts.some((toast) => toast.message.startsWith('全文:汉字 9 · 英文 5 词')))

    // 卸载（后端不再提供）：按钮、面板开关、面板内容、命令一起消失
    expect((await example.removed()).removed).toEqual(['kb.word-count'])
    await waitFor(() => !wrapper.find('[data-action="kb.word-count.button"]').exists())
    expect(wrapper.find('[data-ext-panel-toggle]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="editor-ext-panel"]').exists()).toBe(false)
    expect(getExtensionRegistry().hasCommand('kb.word-count.show')).toBe(false)

    // 内置功能不受影响：格式按钮、字数仍在
    expect(wrapper.find('[data-action="bold"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="editor-chrome-count"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('8. 独立安装 / 卸载可反复进行：重复安装不会出现两个按钮，卸载后重装又回来', async () => {
    const wrapper = mountHost()
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())
    const example = await installExample()
    for (let round = 0; round < 3; round += 1) {
      await example.installed()
      await example.installed()
      await waitFor(() => wrapper.find('[data-action="kb.word-count.button"]').exists())
      expect(wrapper.findAll('[data-action="kb.word-count.button"]')).toHaveLength(1)
      await example.removed()
      await waitFor(() => !wrapper.find('[data-action="kb.word-count.button"]').exists())
    }
    expect(getExtensionRegistry().list().every((item) => item.builtin)).toBe(true)
    wrapper.unmount()
  })
})
