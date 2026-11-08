/**
 * EditorHost × 扩展
 *
 * 这一层验证「注册表里的贡献真的出现在编辑器里、点了真的执行」：
 * 工具栏按钮、面板、AI 工具建议、斜杠菜单命令入口、Codec 与扩展内容面的格式协商、
 * 以及扩展被卸载 / 后端撤掉之后界面立刻跟着变。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pickHeading } from './chromeTestKit'
import { toasts } from '@kb-ui/components/useToast'
import EditorHost from './EditorHost.vue'
import { TextSurface } from '../surfaces/text/TextSurface'
import { defineExtension } from '../api'
import { getExtensionRegistry, resetExtensionRuntime } from '../extensions/runtime'
import { manifestFor, type ManifestInit } from '../extensions/__fixtures__/testkit'
import { resetSurfaceRegistry } from '../surfaces/registry'
import type { SessionTransport } from '../session/DocumentSession'
import type { EditorOpenRequest, Surface } from '../types'
import type { EditorExtension } from '../extensions/api'

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

function mountHost(options: { request?: Partial<EditorOpenRequest>; transport?: SessionTransport; builtinLoader?: boolean } = {}) {
  return mount(EditorHost, {
    props: {
      request: makeRequest(options.request),
      transport: options.transport ?? { save: async () => ({ ok: true, revision: 5, sha256: 'sha5' }) },
      ...(options.builtinLoader ? {} : { loadSurface: loadText }),
    },
    attachTo: document.body,
  })
}

async function installExt(init: ManifestInit, extension: EditorExtension) {
  await getExtensionRegistry().install(manifestFor(init), extension)
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

describe('工具栏与命令', () => {
  it('1. 迁到注册表的内置「查找 / 大纲」按钮照常出现、照常工作', async () => {
    const wrapper = mountHost()
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())
    expect(wrapper.find('[data-action="find"]').exists()).toBe(true)
    expect(wrapper.find('[data-action="outline"]').exists()).toBe(true)
    await wrapper.find('[data-action="find"]').trigger('click')
    await waitFor(() => wrapper.find('[data-testid="editor-find-bar"]').exists())
    wrapper.unmount()
  })

  it('2. 扩展的工具栏按钮出现在「扩展」分组，点击执行扩展命令（带参数和绑定到这个编辑器的 API）', async () => {
    const seen: unknown[] = []
    await installExt(
      { id: 'kb.btn', permissions: ['ui', 'document.read'], contributes: { commands: [{ id: 'kb.btn.run', title: '运行' }], toolbar: [{ id: 'kb.btn.button' }] } },
      defineExtension({
        activate(ctx) {
          ctx.registerCommand('kb.btn.run', async (args, api) => {
            seen.push(args, (await api.document.read()).text)
          })
          ctx.registerToolbarItem({ id: 'kb.btn.button', label: '运行扩展', icon: '★', command: 'kb.btn.run', args: { n: 1 } })
        },
      }),
    )
    const wrapper = mountHost()
    await waitFor(() => wrapper.find('[data-action="kb.btn.button"]').exists())
    const button = wrapper.find('[data-action="kb.btn.button"]')
    expect(button.attributes('aria-label')).toBe('★ 运行扩展')
    await button.trigger('click')
    await waitFor(() => seen.length === 2)
    expect(seen[0]).toEqual({ n: 1 })
    expect(seen[1]).toBe('# 周报\n\nhello world 你好')
    wrapper.unmount()
  })

  it('3. 扩展命令失败：用 toast 告诉用户，编辑器不受影响', async () => {
    await installExt(
      { id: 'kb.fail', permissions: ['ui'], contributes: { commands: [{ id: 'kb.fail.run', title: '失败' }], toolbar: [{ id: 'kb.fail.button' }] } },
      defineExtension({
        activate(ctx) {
          ctx.registerCommand('kb.fail.run', () => {
            throw new Error('命令炸了')
          })
          ctx.registerToolbarItem({ id: 'kb.fail.button', label: '失败', command: 'kb.fail.run' })
        },
      }),
    )
    const wrapper = mountHost()
    await waitFor(() => wrapper.find('[data-action="kb.fail.button"]').exists())
    await wrapper.find('[data-action="kb.fail.button"]').trigger('click')
    await waitFor(() => toasts.length > 0)
    expect(toasts[0]!.message).toContain('命令炸了')
    expect(wrapper.find('.kb-text-prose h1').exists()).toBe(true)
    wrapper.unmount()
  })

  it('4. 写文档的按钮在只读文档里不显示（write: true）', async () => {
    await installExt(
      { id: 'kb.w', permissions: ['ui', 'document.write'], contributes: { commands: [{ id: 'kb.w.run', title: 'w' }], toolbar: [{ id: 'kb.w.button' }, { id: 'kb.w.view' }] } },
      defineExtension({
        activate(ctx) {
          ctx.registerCommand('kb.w.run', () => undefined)
          ctx.registerToolbarItem({ id: 'kb.w.button', label: '改', command: 'kb.w.run', write: true })
          ctx.registerToolbarItem({ id: 'kb.w.view', label: '看', command: 'kb.w.run' })
        },
      }),
    )
    const wrapper = mountHost({ request: { readonly: true, permissions: { read: true, write: false, comment: false, ai: false, export: true } } })
    await waitFor(() => wrapper.find('[data-action="kb.w.view"]').exists())
    expect(wrapper.find('[data-action="kb.w.button"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('5. 卸载扩展：按钮立刻从界面消失；重新安装又回来（幂等安装不会重复出按钮）', async () => {
    const ext = defineExtension({
      activate(ctx) {
        ctx.registerCommand('kb.life.run', () => undefined)
        ctx.registerToolbarItem({ id: 'kb.life.button', label: '生命周期', command: 'kb.life.run' })
      },
    })
    const init: ManifestInit = { id: 'kb.life', permissions: ['ui'], contributes: { commands: [{ id: 'kb.life.run', title: 'r' }], toolbar: [{ id: 'kb.life.button' }] } }
    await installExt(init, ext)
    const wrapper = mountHost()
    await waitFor(() => wrapper.find('[data-action="kb.life.button"]').exists())
    await getExtensionRegistry().uninstall('kb.life')
    await waitFor(() => !wrapper.find('[data-action="kb.life.button"]').exists())
    await installExt(init, ext)
    await installExt(init, ext)
    await waitFor(() => wrapper.find('[data-action="kb.life.button"]').exists())
    expect(wrapper.findAll('[data-action="kb.life.button"]')).toHaveLength(1)
    wrapper.unmount()
  })

  it('6. 内容面执行命令时先问扩展（斜杠菜单的扩展命令入口）', async () => {
    const ran: unknown[] = []
    await installExt(
      { id: 'kb.slash', permissions: ['ui'], contributes: { commands: [{ id: 'kb.slash.run', title: 'r' }], slash: [{ id: 'kb.slash.item' }] } },
      defineExtension({
        activate(ctx) {
          ctx.registerCommand('kb.slash.run', (args) => void ran.push(args))
          ctx.registerSlashItem({ id: 'kb.slash.item', label: '扩展斜杠', command: 'kb.slash.run', args: { from: 'slash' } })
        },
      }),
    )
    const wrapper = mountHost()
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())
    const surface = surfaces[0]!
    expect(await surface.command({ id: 'c1', type: 'kb.slash.run', args: { from: 'slash' }, source: 'user' })).toEqual({ ok: true })
    expect(ran).toEqual([{ from: 'slash' }])
    // 不是扩展命令的照常报不支持
    expect(await surface.command({ id: 'c2', type: 'nobody.knows', source: 'user' })).toMatchObject({ ok: false, reason: 'unsupported_command:nobody.knows' })
    // 斜杠菜单的动作列表里有扩展项
    const info = (await surface.query({ type: 'slash' })) as { active: boolean }
    expect(info.active).toBe(false) // 没有输入 `/`
    wrapper.unmount()
  })
})

describe('面板', () => {
  const panelExt = defineExtension({
    activate(ctx) {
      ctx.registerPanel({
        id: 'kb.panel.p',
        title: '字符面板',
        icon: 'Σ',
        mount(el, api) {
          const label = document.createElement('p')
          label.dataset.testid = 'panel-label'
          el.append(label)
          const refresh = async () => {
            label.textContent = `${(await api.document.read()).text.length}`
          }
          const subscription = api.document.onChange(() => void refresh())
          void refresh()
          return () => {
            subscription.dispose()
            label.remove()
            ;(window as unknown as { __panelCleaned?: number }).__panelCleaned = ((window as unknown as { __panelCleaned?: number }).__panelCleaned ?? 0) + 1
          }
        },
      })
    },
  })
  const panelInit: ManifestInit = { id: 'kb.panel', permissions: ['ui', 'document.read'], contributes: { panels: [{ id: 'kb.panel.p', title: '字符面板', icon: 'Σ' }] } }

  it('7. 操作区有开关按钮；打开后面板内容由扩展挂载，随正文变化更新；收起时调用清理函数', async () => {
    ;(window as unknown as { __panelCleaned?: number }).__panelCleaned = 0
    await installExt(panelInit, panelExt)
    const wrapper = mountHost()
    await waitFor(() => wrapper.find('[data-ext-panel-toggle="kb.panel:kb.panel.p"]').exists())
    const toggle = wrapper.find('[data-ext-panel-toggle="kb.panel:kb.panel.p"]')
    expect(toggle.attributes('aria-pressed')).toBe('false')
    expect(wrapper.find('[data-testid="editor-ext-panel"]').exists()).toBe(false)

    await toggle.trigger('click')
    await waitFor(() => wrapper.find('[data-testid="panel-label"]').exists() && wrapper.find('[data-testid="panel-label"]').text() !== '')
    const initial = Number(wrapper.find('[data-testid="panel-label"]').text())
    expect(initial).toBe('# 周报\n\nhello world 你好'.length)
    expect(wrapper.find('[data-testid="editor-ext-panel"]').attributes('aria-label')).toBe('字符面板')

    // 与大纲面板同层级、互不影响
    await wrapper.find('[data-action="outline"]').trigger('click')
    await waitFor(() => wrapper.find('[data-testid="editor-outline"]').exists())
    expect(wrapper.find('[data-testid="editor-ext-panel"]').exists()).toBe(true)

    // 改正文 → 防抖后面板更新
    await wrapper.find('[data-action="table"]').trigger('click')
    await wrapper.find('[data-testid="table-cell-3-3"]').trigger('click')
    await waitFor(() => Number(wrapper.find('[data-testid="panel-label"]').text()) !== initial)

    await toggle.trigger('click')
    await waitFor(() => !wrapper.find('[data-testid="editor-ext-panel"]').exists())
    expect((window as unknown as { __panelCleaned?: number }).__panelCleaned).toBe(1)
    wrapper.unmount()
  })

  it('8. 编辑器关闭 / 扩展卸载都会清理已打开的面板', async () => {
    ;(window as unknown as { __panelCleaned?: number }).__panelCleaned = 0
    await installExt(panelInit, panelExt)
    const first = mountHost()
    await waitFor(() => first.find('[data-ext-panel-toggle]').exists())
    await first.find('[data-ext-panel-toggle]').trigger('click')
    await waitFor(() => first.find('[data-testid="panel-label"]').exists())
    first.unmount() // 关闭编辑器
    await waitFor(() => (window as unknown as { __panelCleaned?: number }).__panelCleaned === 1)

    const second = mountHost()
    await waitFor(() => second.find('[data-ext-panel-toggle]').exists())
    await second.find('[data-ext-panel-toggle]').trigger('click')
    await waitFor(() => second.find('[data-testid="panel-label"]').exists())
    await getExtensionRegistry().uninstall('kb.panel') // 扩展被卸载
    await waitFor(() => !second.find('[data-ext-panel-toggle]').exists())
    expect(second.find('[data-testid="editor-ext-panel"]').exists()).toBe(false)
    expect((window as unknown as { __panelCleaned?: number }).__panelCleaned).toBe(2)
    second.unmount()
  })

  it('9. 同时开两个编辑器：面板读到的是各自的文档，不串', async () => {
    await installExt(panelInit, panelExt)
    const a = mountHost({ request: { fileId: 'a', source: { kind: 'text', text: '甲', name: 'a.md' } } })
    const b = mountHost({ request: { fileId: 'b', source: { kind: 'text', text: '乙乙乙乙乙', name: 'b.md' } } })
    for (const wrapper of [a, b]) {
      await waitFor(() => wrapper.find('[data-ext-panel-toggle]').exists())
      await wrapper.find('[data-ext-panel-toggle]').trigger('click')
    }
    await waitFor(() => a.find('[data-testid="panel-label"]').exists() && b.find('[data-testid="panel-label"]').exists() && a.find('[data-testid="panel-label"]').text() !== '' && b.find('[data-testid="panel-label"]').text() !== '')
    expect(a.find('[data-testid="panel-label"]').text()).toBe(String('甲'.length))
    expect(b.find('[data-testid="panel-label"]').text()).toBe(String('乙乙乙乙乙'.length))
    a.unmount()
    b.unmount()
  })
})

describe('AI 工具', () => {
  const aiInit: ManifestInit = {
    id: 'kb.ai',
    name: '大写助手',
    permissions: ['ai', 'document.read', 'document.write'],
    contributes: { aiTools: [{ id: 'kb.ai.upper', title: '转大写' }] },
  }
  const aiExt = defineExtension({
    activate(ctx) {
      ctx.registerAITool({ id: 'kb.ai.upper', title: '转大写', run: (input) => ({ text: input.text.toUpperCase(), note: '仅作建议' }) })
    },
  })

  it('10. AI 菜单里列出工具；运行后以「建议」展示，接受才写回；写回前要用户确认写权限', async () => {
    const confirmed: string[] = []
    getExtensionRegistry().setConfirmWrite(async (manifest) => {
      confirmed.push(manifest.id)
      return true
    })
    await installExt(aiInit, aiExt)
    const wrapper = mountHost()
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())
    const vm = wrapper.vm as unknown as { executeCommand(command: object): Promise<unknown>; flushText(): Promise<string> }
    await vm.executeCommand({ id: 's', type: 'view.selectAll', source: 'user' })

    await wrapper.find('[data-testid="editor-ai"]').trigger('click')
    expect(wrapper.find('[data-ai-tool="kb.ai.upper"]').text()).toBe('转大写')
    await wrapper.find('[data-ai-tool="kb.ai.upper"]').trigger('click')
    await waitFor(() => wrapper.find('[data-testid="editor-ai-suggestion-text"]').exists())
    const suggestion = wrapper.find('[data-testid="editor-ai-suggestion-text"]').text()
    expect(suggestion).toContain('HELLO WORLD')
    // 建议阶段文档没动
    expect(await vm.flushText()).toContain('hello world')

    await wrapper.find('[data-testid="editor-ai-suggestion-accept"]').trigger('click')
    await waitFor(() => !wrapper.find('[data-testid="editor-ai-suggestion"]').exists())
    expect(confirmed).toEqual(['kb.ai'])
    expect(await vm.flushText()).toContain('HELLO WORLD')
    wrapper.unmount()
  })

  it('11. 拒绝建议：文档不动，建议条收起', async () => {
    await installExt(aiInit, aiExt)
    const wrapper = mountHost()
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())
    const vm = wrapper.vm as unknown as { executeCommand(command: object): Promise<unknown>; flushText(): Promise<string> }
    await vm.executeCommand({ id: 's', type: 'view.selectAll', source: 'user' })
    await wrapper.find('[data-testid="editor-ai"]').trigger('click')
    await wrapper.find('[data-ai-tool="kb.ai.upper"]').trigger('click')
    await waitFor(() => wrapper.find('[data-testid="editor-ai-suggestion-reject"]').exists() && wrapper.find('[data-testid="editor-ai-suggestion-text"]').exists())
    await wrapper.find('[data-testid="editor-ai-suggestion-reject"]').trigger('click')
    await waitFor(() => !wrapper.find('[data-testid="editor-ai-suggestion"]').exists())
    expect(await vm.flushText()).toContain('hello world')
    wrapper.unmount()
  })

  it('12. 用户不允许写入：接受失败，文档不动，建议保留并提示原因', async () => {
    getExtensionRegistry().setConfirmWrite(async () => false)
    await installExt(aiInit, aiExt)
    const wrapper = mountHost()
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())
    const vm = wrapper.vm as unknown as { executeCommand(command: object): Promise<unknown>; flushText(): Promise<string> }
    await vm.executeCommand({ id: 's', type: 'view.selectAll', source: 'user' })
    await wrapper.find('[data-testid="editor-ai"]').trigger('click')
    await wrapper.find('[data-ai-tool="kb.ai.upper"]').trigger('click')
    await waitFor(() => wrapper.find('[data-testid="editor-ai-suggestion-accept"]').exists())
    await wrapper.find('[data-testid="editor-ai-suggestion-accept"]').trigger('click')
    await waitFor(() => toasts.length > 0)
    expect(toasts[0]!.message).toContain('不能修改文档')
    expect(wrapper.find('[data-testid="editor-ai-suggestion"]').exists()).toBe(true)
    expect(await vm.flushText()).toContain('hello world')
    wrapper.unmount()
  })

  it('13. 文档没有 AI 权限时不显示扩展的 AI 工具', async () => {
    await installExt(aiInit, aiExt)
    const wrapper = mountHost({ request: { permissions: { read: true, write: true, comment: false, ai: false, export: true } } })
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())
    expect(wrapper.find('[data-testid="editor-ai"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('格式协商：Codec 与扩展内容面', () => {
  const rot13 = (text: string) => text.replace(/[a-z]/gi, (ch) => String.fromCharCode(((ch.charCodeAt(0) - (ch <= 'Z' ? 65 : 97) + 13) % 26) + (ch <= 'Z' ? 65 : 97)))

  it('14. 不认识的二进制格式走扩展 Codec 解码；保存时经 encode 翻译回字节；写回要用户确认', async () => {
    const confirmed: string[] = []
    getExtensionRegistry().setConfirmWrite(async (manifest) => {
      confirmed.push(manifest.id)
      return true
    })
    await installExt(
      { id: 'kb.rot', permissions: ['document.read', 'document.write'], contributes: { codecs: [{ id: 'kb.rot.codec', extensions: ['rot13'] }] } },
      defineExtension({
        activate(ctx) {
          ctx.registerCodec({
            id: 'kb.rot.codec',
            surface: 'text',
            decode: (bytes, { name }) => ({ kind: 'text', text: rot13(new TextDecoder().decode(bytes)), name }),
            encode: (source) => new TextEncoder().encode(rot13(source.kind === 'text' ? source.text : '')),
          })
        },
      }),
    )
    const saved: { bytes?: Uint8Array; kind: string }[] = []
    const transport: SessionTransport = {
      save: async (request) => {
        saved.push({ kind: request.source.kind, bytes: request.source.kind === 'bytes' ? request.source.bytes : undefined })
        return { ok: true, revision: 5, sha256: 'sha5' }
      },
    }
    const wrapper = mountHost({
      transport,
      request: { fileId: 'f1', format: 'rot13', source: { kind: 'bytes', bytes: new TextEncoder().encode(rot13('# Title\n\nsecret body')), name: 'a.rot13', sha256: 'abc' } },
    })
    // 解码后的文本在文本面里显示
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())
    expect(wrapper.find('.kb-text-prose h1').text()).toBe('Title')
    expect(wrapper.attributes('data-surface-kind')).toBe('text')

    // 标题收进「H▾」下拉
    await pickHeading(wrapper, 'heading.2')
    await waitFor(() => wrapper.find('.kb-text-prose h2').exists())
    await waitFor(() => wrapper.find('[data-testid="editor-save"]').attributes('disabled') === undefined)
    await wrapper.find('[data-testid="editor-save"]').trigger('click')
    await waitFor(() => saved.length === 1)
    expect(saved[0]!.kind).toBe('bytes')
    expect(rot13(new TextDecoder().decode(saved[0]!.bytes))).toContain('## Title')
    expect(confirmed).toEqual(['kb.rot'])
    wrapper.unmount()
  })

  it('15. 用户拒绝写回：保存失败并给出原因，不把未翻译的文本写出去', async () => {
    getExtensionRegistry().setConfirmWrite(async () => false)
    await installExt(
      { id: 'kb.rot', permissions: ['document.read', 'document.write'], contributes: { codecs: [{ id: 'kb.rot.codec', extensions: ['rot13'] }] } },
      defineExtension({
        activate(ctx) {
          ctx.registerCodec({
            id: 'kb.rot.codec',
            surface: 'text',
            decode: (bytes, { name }) => ({ kind: 'text', text: new TextDecoder().decode(bytes), name }),
            encode: () => new Uint8Array([1]),
          })
        },
      }),
    )
    let transportCalls = 0
    const wrapper = mountHost({
      transport: { save: async () => (transportCalls += 1, { ok: true, revision: 5, sha256: 's' }) },
      request: { fileId: 'f2', format: 'rot13', source: { kind: 'bytes', bytes: new TextEncoder().encode('# T'), name: 'a.rot13' } },
    })
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())
    // 标题收进「H▾」下拉
    await pickHeading(wrapper, 'heading.2')
    await waitFor(() => wrapper.find('[data-testid="editor-save"]').attributes('disabled') === undefined)
    await wrapper.find('[data-testid="editor-save"]').trigger('click')
    await waitFor(() => wrapper.find('[data-testid="editor-fallback"]').exists())
    expect(wrapper.find('[data-testid="editor-fallback"]').text()).toContain('不能修改文档')
    expect(transportCalls).toBe(0)
    wrapper.unmount()
  })

  it('16. 内置格式不受扩展影响：.md 仍然走文本面，.csv 仍然走网格', async () => {
    const wrapper = mountHost()
    await waitFor(() => wrapper.find('.kb-text-prose h1').exists())
    expect(wrapper.attributes('data-surface-kind')).toBe('text')
    expect(getExtensionRegistry().resolveKind('x.csv')).toBe('grid')
    wrapper.unmount()
  })

  it('17. 扩展内容面接管不认识的扩展名：Host 用 ext:<id> 取内容面，经受限会话挂载；卸载后回到「不支持」', async () => {
    await installExt(
      { id: 'kb.lines', permissions: ['ui', 'document.read'], contributes: { surfaces: [{ id: 'kb.lines.surface', extensions: ['lines'] }] } },
      defineExtension({
        activate(ctx) {
          ctx.registerSurface({
            id: 'kb.lines.surface',
            create() {
              let list: HTMLElement | null = null
              return {
                async mount(el, surfaceCtx) {
                  const source = surfaceCtx.document.payload as { kind: 'text'; text: string }
                  list = document.createElement('ul')
                  for (const line of source.text.split('\n')) {
                    const item = document.createElement('li')
                    item.textContent = line
                    list.append(item)
                  }
                  el.append(list)
                },
                unmount: () => list?.remove(),
                resize() {},
                focus() {},
                setReadonly() {},
                command: async () => ({ ok: false, reason: 'readonly_surface' }),
                query: async () => null,
                capture: () => ({ kind: 'ext:kb.lines.surface' }),
                restore() {},
              }
            },
          })
        },
      }),
    )
    const wrapper = mountHost({
      builtinLoader: true,
      request: { fileId: 'l1', format: 'lines', readonly: true, source: { kind: 'text', text: '甲\n乙\n丙', name: 'todo.lines' } },
    })
    await waitFor(() => wrapper.findAll('li').length === 3)
    expect(wrapper.findAll('li').map((item) => item.text())).toEqual(['甲', '乙', '丙'])
    expect(wrapper.attributes('data-surface-kind')).toBe('ext:kb.lines.surface')
    expect(wrapper.find('[data-testid="editor-surface-kind"]').text()).toBe('扩展文档')
    wrapper.unmount()

    await getExtensionRegistry().uninstall('kb.lines')
    const after = mountHost({ builtinLoader: true, request: { fileId: 'l2', format: 'lines', source: { kind: 'text', text: 'x', name: 'a.lines' } } })
    await waitFor(() => after.find('[data-testid="editor-fallback"]').exists())
    expect(after.find('[data-testid="editor-fallback"]').text()).toContain('暂不支持')
    after.unmount()
  })
})
