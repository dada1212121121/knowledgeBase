/**
 * 文件查看器 × 编辑器扩展注册的新格式（扩展格式入口）
 *
 * 页面不认得的扩展名，管理员装了扩展并注册了 Codec + 内容面时，用统一外壳只读打开；没有扩展认领就回到原来的回退。
 * 扩展用仓库里真实的示例（`examples/editor-todo-format`）；只把「向后端取清单」换成桩，外壳、注册表、内容面都是真的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import MANIFEST_TOML from '../../examples/editor-todo-format/manifest.toml?raw'
import { parseToml } from '../../e2e/toml-lite.mjs'
import FileViewer from './FileViewer.vue'
import { parseManifest } from '@/editor/extensions/manifest'
import { getExtensionRegistry, resetExtensionRuntime } from '@/editor/extensions/runtime'
import { resetSurfaceRegistry } from '@/editor/surfaces/registry'
import type { EditorExtension } from '@/editor/extensions/api'

const ensureSpy = vi.hoisted(() => vi.fn<() => Promise<unknown>>())
vi.mock('@/editor/extensions/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/editor/extensions/runtime')>()),
  ensureExtensionsLoaded: ensureSpy,
}))

const modules = import.meta.glob('../../examples/editor-todo-format/index.js') as Record<string, () => Promise<{ default: EditorExtension }>>
async function installTodoExample() {
  const parsed = parseManifest(parseToml(MANIFEST_TOML))
  if (!parsed.ok) throw new Error(parsed.errors.join('；'))
  const { default: extension } = await Object.values(modules)[0]!()
  await getExtensionRegistry().install(parsed.manifest, extension)
}

const FILE = '{\n  "title": "周五发布",\n  "items": [\n    { "text": "冻结版本", "done": true },\n    { "text": "写发布说明", "done": false }\n  ]\n}\n'
const base = { blocks: [], chunks: [], highlight: null, format: 'kbtodo', fileName: 'docs/周五.kbtodo', sourceUrl: '/api/v1/raw?path=docs/周五.kbtodo' }
const texts = () => [...document.querySelectorAll<HTMLInputElement>('[data-testid="todo-text"]')].map((input) => input.value)

beforeEach(() => {
  setActivePinia(createPinia())
  resetExtensionRuntime()
  resetSurfaceRegistry()
  ensureSpy.mockReset()
  ensureSpy.mockResolvedValue({ enabled: true, loaded: [], failed: [], removed: [], forbidden: false })
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  resetExtensionRuntime()
  resetSurfaceRegistry()
})

describe('FileViewer 扩展格式入口', () => {
  it('扩展认领了 .kbtodo：用外壳里的扩展内容面只读打开（经 Codec 解码，输入框全部禁用），不再是代码视图', async () => {
    await installTodoExample()
    const wrapper = mount(FileViewer, { props: { ...base, content: FILE }, attachTo: document.body })
    await vi.waitFor(() => expect(texts()).toEqual(['冻结版本', '写发布说明']), { timeout: 8000 })
    expect(document.querySelector<HTMLInputElement>('[data-testid="todo-title"]')?.value).toBe('周五发布')
    const inputs = [...document.querySelectorAll<HTMLInputElement>('[data-testid="todo-surface"] input')]
    expect(inputs.length).toBeGreaterThan(0)
    expect(inputs.every((input) => input.disabled)).toBe(true)
    expect(document.querySelector('[data-testid="todo-add"]')).toBeNull()
    expect(document.querySelector('.kb-ce .cm-content')).toBeNull()
    wrapper.unmount()
  })

  it('后端没给文本原文（二进制 / 太大）：自己去取原件字节再解码打开', async () => {
    await installTodoExample()
    const fetchSpy = vi.fn(async () => new Response(new TextEncoder().encode(FILE)))
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = mount(FileViewer, { props: { ...base, content: null }, attachTo: document.body })
    await vi.waitFor(() => expect(texts()).toEqual(['冻结版本', '写发布说明']), { timeout: 8000 })
    expect(fetchSpy).toHaveBeenCalledWith('/api/v1/raw?path=docs/周五.kbtodo', expect.objectContaining({ credentials: 'same-origin' }))
    wrapper.unmount()
  })

  it('原件读不到：退回文字层并提示原因，不是空白', async () => {
    await installTodoExample()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    const wrapper = mount(FileViewer, { props: { ...base, content: null, blocks: [{ anchor: { kind: 'page', page: 1 }, kind: 'paragraph', text: '抽取出来的文字' }] }, attachTo: document.body })
    await vi.waitFor(() => expect(wrapper.find('.kb-fv-strip.is-warn').exists()).toBe(true), { timeout: 8000 })
    expect(wrapper.find('.kb-fv-strip').text()).toContain('找不到原件')
    expect(wrapper.find('.kb-dv').exists()).toBe(true)
    wrapper.unmount()
  })

  it('没有扩展认领（没装 / 开关关着 / 不是管理员）：保持原来的回退，后端给的文本照样在只读代码视图里', async () => {
    const wrapper = mount(FileViewer, { props: { ...base, content: FILE }, attachTo: document.body })
    await vi.waitFor(() => expect(document.querySelector('.kb-ce .cm-content')?.textContent).toContain('冻结版本'), { timeout: 8000 })
    expect(document.querySelector('[data-testid="todo-surface"]')).toBeNull()
    expect(wrapper.find('.kb-fv-strip').exists()).toBe(false)
    wrapper.unmount()
  })

  it('内置认得的格式永远优先：扩展再怎么注册也不会接管 .md / .json 的预览', async () => {
    await installTodoExample()
    const wrapper = mount(FileViewer, { props: { ...base, format: 'json', fileName: 'a.json', content: '{"a":1}' }, attachTo: document.body })
    await vi.waitFor(() => expect(document.querySelector('.kb-ce .cm-content')?.textContent).toContain('"a"'), { timeout: 8000 })
    expect(document.querySelector('[data-testid="todo-surface"]')).toBeNull()
    expect(ensureSpy).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('开关在页面打开期间被关掉：扩展被撤掉，同一个文件立刻回到原来的回退', async () => {
    await installTodoExample()
    const wrapper = mount(FileViewer, { props: { ...base, content: FILE }, attachTo: document.body })
    await vi.waitFor(() => expect(texts()).toHaveLength(2), { timeout: 8000 })
    await getExtensionRegistry().uninstall('kb.todo-format')
    await flushPromises()
    await vi.waitFor(() => expect(document.querySelector('.kb-ce .cm-content')?.textContent).toContain('冻结版本'), { timeout: 8000 })
    expect(document.querySelector('[data-testid="todo-surface"]')).toBeNull()
    wrapper.unmount()
  })
})
