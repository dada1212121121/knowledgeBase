/**
 * EditorHost × 笔记页面服务端到端
 *
 * 真实 EditorHost + 真实 TextSurface + 真实 TextPanels，只把页面服务（搜索、上传、体检、打开链接）换成可观测的假实现。
 * 验证「工具栏 / 斜杠 / 粘贴 → 面板 → 命令 → 正文」整条链路连通：任何一环参数拼错都会在这里暴露，
 * 而不是等到浏览器里才发现按钮点了没反应。
 */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import EditorHost from './EditorHost.vue'
import { TextSurface } from '../surfaces/text/TextSurface'
import { fileEvent } from '../surfaces/text/textTestKit'
import { linkKey } from '@/utils/links'
import type { EditorOpenRequest, Surface, TextServices } from '../types'

// 这个文件验证“工具栏 → 面板 → 命令 → 正文”的链路，只看文档结构；流程图 / 公式的真实渲染（要加载 mermaid / KaTeX，
// jsdom 里很慢且受机器负载影响）在 textSurface.blocks.spec.ts 和真实浏览器的 rich-render 场景里验证
vi.mock('../surfaces/text/richPreview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../surfaces/text/richPreview')>()
  const stub = (className: string) => {
    const el = document.createElement('div')
    el.className = className
    return Promise.resolve(el)
  }
  return { ...actual, renderMermaid: () => stub('kb-mermaid'), renderLatex: () => stub('kb-math-block') }
})

vi.mock('@/api/upload', () => ({
  uploadFile: vi.fn(async (_file: File, opts: { relPath: string }) => ({ files: [{ rel_path: opts.relPath }], skipped: [] })),
}))

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await flushPromises()
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('waitFor 超时')
}

const request = (text: string, overrides: Partial<EditorOpenRequest> = {}): EditorOpenRequest => ({
  fileId: 'note_1',
  collection: 'docs',
  path: 'guide/a.md',
  format: 'md',
  source: { kind: 'text', text, name: 'a.md' },
  readonly: false,
  revision: 1,
  permissions: { read: true, write: true, comment: false, ai: false, export: true },
  ...overrides,
})

const surfaces: Surface[] = []
let wrapper: VueWrapper | null = null

interface Probe {
  opened: string[]
  attachments: { collection: string; path: string }[]
  errors: string[]
  states: Record<string, 'missing'>
}

function makeServices(probe: Probe): TextServices {
  return {
    collection: () => 'docs',
    sourcePath: () => 'guide/a.md',
    adminView: () => '',
    linkContext: () => ({ collection: 'docs', sourcePath: 'guide/a.md', rawUrl: (c, p) => `/raw/${c}/${p}` }),
    linkStates: () => probe.states,
    fileCollections: () => [{ name: 'docs' }],
    searchNotes: async () => [{ id: 'n1', title: '第一篇' }],
    searchFiles: async (_q, collection) => [{ collection, path: 'img/a.png', name: 'a.png', size: 10 }],
    openLink: (id) => probe.opened.push(id),
    openAttachment: (target) => probe.attachments.push(target),
    linkError: (message) => probe.errors.push(message),
  }
}

async function mountHost(text: string, options: { readonly?: boolean } = {}) {
  const probe: Probe = { opened: [], attachments: [], errors: [], states: {} }
  const host = mount(EditorHost, {
    props: {
      request: request(text, options.readonly ? { readonly: true, permissions: { read: true, write: false, comment: false, ai: false, export: true } } : {}),
      transport: { save: async () => ({ ok: true, revision: 2, sha256: 'x' }) },
      loadSurface: () => {
        const surface = new TextSurface()
        surfaces.push(surface)
        return Promise.resolve(surface)
      },
      textServices: makeServices(probe),
      chromeTitle: false,
    },
    attachTo: document.body,
    global: { plugins: [createPinia()] },
  })
  wrapper = host
  await waitFor(() => host.find('.kb-text-prose').exists())
  const text$ = async () => ((await (host.vm as unknown as { flushText: () => Promise<string> }).flushText()) ?? '').trim()
  return { host, probe, text: text$ }
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  for (const surface of surfaces) surface.unmount()
  surfaces.length = 0
  document.body.innerHTML = ''
})

describe('页面服务接入后的整条链路', () => {
  it('1. 页面给了服务才出现面板区域', async () => {
    const { host } = await mountHost('正文')
    expect(host.find('[data-testid="text-panels"]').exists()).toBe(true)
  })

  it('2. 插入下拉 → 提示块：正文多出 > [!TIP]', async () => {
    const { host, text } = await mountHost('')
    await host.find('[data-action="insertMore"]').trigger('click')
    await host.find('[data-action="callout.tip"]').trigger('click')
    await waitFor(() => host.find('.kb-text-prose blockquote.kb-callout.is-tip').exists())
    expect(await text()).toContain('> [!TIP]')
  })

  it('3. 插入下拉 → 流程图 / 公式：正文是 mermaid 围栏 / $$ 块', async () => {
    const { host, text } = await mountHost('')
    await host.find('[data-action="insertMore"]').trigger('click')
    await host.find('[data-action="diagram"]').trigger('click')
    await waitFor(() => host.find('.kb-text-prose pre').exists())
    expect(await text()).toContain('```mermaid')
    await host.find('[data-action="insertMore"]').trigger('click')
    await host.find('[data-action="math"]').trigger('click')
    await waitFor(() => host.findAll('.kb-text-prose pre').length === 2)
    expect(await text()).toContain('$$\nE = mc^2\n$$')
  })

  it('4. 引用笔记：下拉 → 选择器 → 选一篇 → 正文有 [[n1|第一篇]]', async () => {
    const { host, text } = await mountHost('')
    await host.find('[data-action="insertMore"]').trigger('click')
    await host.find('[data-action="wikilink"]').trigger('click')
    await waitFor(() => !!document.querySelector('[data-testid="note-picker-item"]'))
    document.querySelector('[data-testid="note-picker-item"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    await waitFor(() => !document.querySelector('[data-testid="note-picker"]'))
    await waitFor(() => host.find('.kb-wikilink').exists())
    expect(await text()).toBe('[[n1|第一篇]]')
  })

  it('5. 引用文件：下拉 → 选择器 → 选图片 → 正文有相对路径图片，显示地址是原件地址', async () => {
    const { host, text } = await mountHost('')
    await host.find('[data-action="insertMore"]').trigger('click')
    await host.find('[data-action="filelink"]').trigger('click')
    await waitFor(() => !!document.querySelector('[data-testid="file-picker-item"]'))
    document.querySelector('[data-testid="file-picker-item"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    await waitFor(() => host.find('.kb-text-prose img:not(.ProseMirror-separator)').exists())
    expect(await text()).toBe('![a](../img/a.png)')
    expect(host.find('.kb-text-prose img:not(.ProseMirror-separator)').attributes('src')).toBe('/raw/docs/img/a.png')
  })

  it('6. 粘贴图片 → 上传 → 正文出现图片（不是 base64，也不是 blob:）', async () => {
    const { host, text } = await mountHost('前面的字')
    const prose = host.find('.kb-text-prose').element
    prose.dispatchEvent(fileEvent('paste', [new File(['x'], '截图.png', { type: 'image/png' })]))
    await waitFor(() => host.find('.kb-text-prose img:not(.ProseMirror-separator)').exists())
    const out = await text()
    expect(out).toMatch(/!\[截图\]\(\.\.\/_attachments\/.+\)/)
    expect(out).not.toMatch(/base64|blob:/)
    expect(out.startsWith('前面的字')).toBe(true)
  })

  it('7. 拖入 PDF → 附件卡片', async () => {
    const { host } = await mountHost('')
    host.find('.kb-text-prose').element.dispatchEvent(fileEvent('drop', [new File(['x'], '合同.pdf', { type: 'application/pdf' })]))
    await waitFor(() => host.find('.kb-attach').exists())
    expect(host.find('.kb-attach').classes()).toContain('is-pdf')
  })

  it('8. 字色：选中文字 → 色板 → 红色 → 正文带 <span style="color: …">', async () => {
    const { host, text } = await mountHost('红字')
    const exposed = host.vm as unknown as { executeCommand: (c: unknown) => Promise<unknown> }
    await exposed.executeCommand({ id: 's', type: 'view.selectAll', source: 'user' })
    await host.find('[data-action="color"]').trigger('click')
    await host.find('[data-testid="editor-color-fg-red"]').trigger('click')
    await waitFor(() => host.find('.kb-text-prose .kb-color').exists())
    expect(await text()).toBe('<span style="color: #e5484d">红字</span>')
  })

  it('8b. 自定义色：面板输入 hex → 正文直接用这个色，保存的 Markdown 也是同一个值', async () => {
    const { host, text } = await mountHost('自定义')
    const exposed = host.vm as unknown as { executeCommand: (c: unknown) => Promise<unknown> }
    await exposed.executeCommand({ id: 's', type: 'view.selectAll', source: 'user' })
    await host.find('[data-action="color"]').trigger('click')
    await host.find('[data-testid="editor-color-custom-color"]').trigger('click')
    await host.find('[data-testid="editor-color-hex"]').setValue('#123456')
    await host.find('[data-testid="editor-color-apply"]').trigger('click')
    await waitFor(() => host.find('.kb-text-prose .kb-color.is-custom').exists())
    expect(host.find('.kb-text-prose .kb-color.is-custom').attributes('style')).toContain('rgb(18, 52, 86)')
    expect(await text()).toBe('<span style="color: #123456">自定义</span>')
  })

  it('9. 字色：没选中文字 → 提示「先选中要上色的文字」', async () => {
    const { host } = await mountHost('红字')
    await host.find('[data-action="color"]').trigger('click')
    await host.find('[data-testid="editor-color-fg-red"]').trigger('click')
    await waitFor(() => host.find('[data-testid="text-notice"]').exists())
    expect(host.find('[data-testid="text-notice"]').text()).toBe('先选中要上色的文字')
  })

  it('10. Ctrl 点击双链 → 页面收到 openLink', async () => {
    const { host, probe } = await mountHost('见 [[ins_1|第一篇]]')
    await waitFor(() => host.find('.kb-wikilink').exists())
    host.find('.kb-wikilink').element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }))
    expect(probe.opened).toEqual(['ins_1'])
  })

  it('11. 链接体检结果异步回来 → refreshText 后出现虚线', async () => {
    const { host, probe } = await mountHost('[去看](./b.md)')
    expect(host.find('.kb-link-missing').exists()).toBe(false)
    probe.states[linkKey('docs', 'guide/b.md')] = 'missing'
    await (host.vm as unknown as { refreshText: () => Promise<void> }).refreshText()
    expect(host.find('.kb-link-missing').exists()).toBe(true)
  })

  it('12. 修复坏引用：replaceHref 改正文并返回处数，进撤销栈', async () => {
    const { host, text } = await mountHost('[旧](./old.md)')
    const exposed = host.vm as unknown as { replaceHref: (a: string, b: string) => Promise<number>; undo: () => Promise<void> }
    expect(await exposed.replaceHref('./old.md', './new.md')).toBe(1)
    expect(await text()).toBe('[旧](./new.md)')
    await exposed.undo()
    await waitFor(() => host.find('a[href="./old.md"]').exists())
    expect(await text()).toBe('[旧](./old.md)')
  })

  it('13. 只读：不出现写入类入口；Ctrl 点击仍可以跟随链接（只读直接点）', async () => {
    const { host, probe } = await mountHost('见 [[ins_1|第一篇]]', { readonly: true })
    expect(host.find('[data-action="insertMore"]').exists()).toBe(false)
    expect(host.find('[data-action="color"]').exists()).toBe(false)
    await waitFor(() => host.find('.kb-wikilink').exists())
    host.find('.kb-wikilink').element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(probe.opened).toEqual(['ins_1'])
  })
})

describe('作为阅读视图用（批注阅读，）', () => {
  it('14. showChrome / showStatus 为 false：不出现工具栏和底部状态栏，正文照样只读可选；默认两者都在', async () => {
    const probe: Probe = { opened: [], attachments: [], errors: [], states: {} }
    const mountWith = async (extra: Record<string, unknown>) => {
      const host = mount(EditorHost, {
        props: {
          request: request('阅读内容', { readonly: true, permissions: { read: true, write: false, comment: true, ai: false, export: true } }),
          loadSurface: () => {
            const surface = new TextSurface()
            surfaces.push(surface)
            return Promise.resolve(surface)
          },
          textServices: makeServices(probe),
          chromeTitle: false,
          ...extra,
        },
        attachTo: document.body,
        global: { plugins: [createPinia()] },
      })
      wrapper = host
      await waitFor(() => host.find('.kb-text-prose').exists())
      return host
    }
    const plain = await mountWith({})
    expect(plain.find('[data-testid="editor-chrome"]').exists()).toBe(true)
    expect(plain.find('.kb-editor-status').exists()).toBe(true)
    plain.unmount()
    const reading = await mountWith({ showChrome: false, showStatus: false })
    expect(reading.find('[data-testid="editor-chrome"]').exists()).toBe(false)
    expect(reading.find('.kb-editor-status').exists()).toBe(false)
    expect(reading.find('.kb-text-prose').attributes('contenteditable')).toBe('false')
    expect(reading.find('.kb-text-prose').text()).toBe('阅读内容')
  })
})

describe('工具栏命令后焦点回到正文', () => {
  it('点加粗 / 标题 / 提示块之后，焦点在正文里（继续打字、Ctrl+Z 才有人接）', async () => {
    const { host } = await mountHost('正文')
    const prose = host.find('.kb-text-prose').element as HTMLElement
    document.body.focus()
    await host.find('[data-action="bold"]').trigger('click')
    await waitFor(() => document.activeElement === prose)
    ;(document.activeElement as HTMLElement).blur()
    await host.find('[data-action="insertMore"]').trigger('click')
    await host.find('[data-action="callout.note"]').trigger('click')
    await waitFor(() => document.activeElement === prose)
  })

  it('打开选择器的命令不抢输入框的焦点（面板自己管）', async () => {
    const { host } = await mountHost('正文')
    await host.find('[data-action="insertMore"]').trigger('click')
    await host.find('[data-action="wikilink"]').trigger('click')
    await waitFor(() => !!document.querySelector('.kb-text-picker-input'))
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(document.activeElement?.classList.contains('kb-text-picker-input')).toBe(true)
  })
})
