/**
 * 文档里的示例代码真的能跑（设计规范）
 *
 * `docs/EDITOR_EXTENSIONS.md` 里每个 ` ```toml example=<名字> ` 与 ` ```js example=<名字> ` 配成一对：
 * 清单走和后端一样的校验，入口脚本按「纯 ES 模块」原样执行并装进注册表，再逐类验证它的行为。
 * 文档改了而示例坏了（或者新增了示例却没有验证）这里会变红。
 * 起还核对「内置功能也是扩展」一节：内置扩展一览表与 `BUILTIN_EXTENSIONS` 一一对应，
 * 文档里贴的内置扩展源码与仓库里的文件逐字一致。
 */
import { afterEach, describe, expect, it } from 'vitest'
import DOC from '../../../../docs/EDITOR_EXTENSIONS.md?raw'
import EXPORT_EXT_SOURCE from './builtin/export.ext.ts?raw'
import { parseToml } from '../../../e2e/toml-lite.mjs'
import type { EditorExtension, ExtensionManifest } from './api'
import { contributionWith, mergeSlashActions } from './contributions'
import { BUILTIN_EXTENSIONS } from './builtin'
import { parseManifest } from './manifest'
import { ExtensionRegistry } from './registry'
import { TEXT_SLASH_ACTIONS } from './builtin/text'
import { loadSurface, resetSurfaceRegistry } from '../surfaces/registry'
import { fakeBinding, settle, type FakeBinding } from './__fixtures__/testkit'

interface Example {
  toml: string
  js: string
}

function examplesInDoc(): Record<string, Example> {
  const found: Record<string, Partial<Example>> = {}
  for (const match of DOC.matchAll(/```(toml|js) example=(\w+)\n([\s\S]*?)```/g)) {
    const [, lang, name, body] = match as unknown as [string, 'toml' | 'js', string, string]
    ;(found[name] ??= {})[lang] = body
  }
  return found as Record<string, Example>
}

/** 按「纯 ES 模块」执行入口脚本：只支持文档里用的 `export default {…}` 写法（没有 import，也不需要构建）。 */
function evaluate(js: string): EditorExtension {
  expect(js).not.toMatch(/^\s*import\s/m) // 扩展脚本在浏览器里没有可 import 的编辑器模块
  const factory = new Function(js.replace(/^export default /m, 'return '))
  return factory() as EditorExtension
}

function manifestOf(example: Example): ExtensionManifest {
  const parsed = parseManifest(parseToml(example.toml))
  if (!parsed.ok) throw new Error(parsed.errors.join('；'))
  return parsed.manifest
}

afterEach(() => resetSurfaceRegistry())

interface Rig {
  registry: ExtensionRegistry
  binding: FakeBinding
  notices: string[]
  clipboard: string[]
  fetched: string[]
}

async function setup(example: Example, init: { text?: string; selection?: string } = {}): Promise<Rig> {
  const notices: string[] = []
  const clipboard: string[] = []
  const fetched: string[] = []
  const registry = new ExtensionRegistry({
    confirmWrite: async () => true,
    notify: (message) => void notices.push(message),
    clipboard: { writeText: async (text) => void clipboard.push(text), readText: async () => '' },
    origin: 'https://kb.example.com',
    fetch: async (url) => {
      fetched.push(url)
      return new Response(JSON.stringify({ status: 'ok' }))
    },
  })
  const binding = fakeBinding({ text: init.text ?? '', selection: init.selection ?? '' })
  registry.attachHost(binding)
  await registry.install(manifestOf(example), evaluate(example.js))
  return { registry, binding, notices, clipboard, fetched }
}

const checks: Record<string, (example: Example) => Promise<void>> = {
  async command(example) {
    const { registry, notices } = await setup(example)
    expect(await registry.runCommand('kb.hello.say', { name: '小明' })).toEqual({ ok: true })
    await registry.runCommand('kb.hello.say', undefined)
    expect(notices).toEqual(['你好,小明', '你好,世界'])
  },

  async toolbar(example) {
    const { registry, binding, notices } = await setup(example, { text: 'abc\ndef' })
    const item = registry.toolbarItemsFor('text')[0]!
    expect(item.spec).toMatchObject({ id: 'kb.bar.button', label: '字符数', command: 'kb.bar.count', group: 'view' })
    const view = contributionWith('text', registry)!.toolbar.find((group) => group.id === 'view')!
    expect(view.actions.map((action) => action.id)).toContain('kb.bar.button')
    await registry.runCommand(item.spec.command, undefined, binding)
    expect(notices).toEqual(['共 7 个字符'])
  },

  async slash(example) {
    const { registry, binding } = await setup(example)
    expect(registry.slashItemsFor('text').map((entry) => entry.spec.id)).toEqual(['kb.sign.slash'])
    expect(mergeSlashActions(TEXT_SLASH_ACTIONS, 'text', registry).map((action) => action.id)).toContain('kb.sign.slash')
    expect(await registry.runCommand('kb.sign.insert', undefined, binding)).toEqual({ ok: true })
    expect(binding.executed.map((command) => command.args)).toEqual([{ text: '—— 来自知识库' }])
  },

  async status(example) {
    const { registry } = await setup(example)
    const state = { kind: 'text' as const, format: 'md', words: 3, unitLabel: '', readonly: false, dirty: false, phase: 'ready' as const }
    expect(registry.statusTexts('text', 'status', state)).toEqual([{ id: 'kb.fmt.item', extensionId: 'kb.fmt', text: '格式 md', title: '当前文件格式' }])
    // 缺省放底部状态栏，不在顶栏；只读时这一项不显示
    expect(registry.statusTexts('text', 'chrome', state)).toEqual([])
    expect(registry.statusTexts('text', 'status', { ...state, readonly: true })).toEqual([])
  },

  async panel(example) {
    const { registry, binding } = await setup(example, { text: '一\n二' })
    const el = document.createElement('div')
    const cleanup = await registry.mountPanel(registry.panels('text')[0]!, el, binding)
    await settle()
    expect(el.textContent).toBe('共 2 行')
    binding.text = '一\n二\n三'
    registry.emitChange(binding)
    await settle()
    expect(el.textContent).toBe('共 3 行')
    cleanup()
    expect(el.childNodes).toHaveLength(0)
    binding.text = '一'
    registry.emitChange(binding)
    await settle()
    expect(el.childNodes).toHaveLength(0)
  },

  async codec(example) {
    const { registry } = await setup(example)
    expect(registry.resolveKind('notes.rot13')).toBe('code')
    expect(registry.resolveKind('notes.md')).toBe('text')
    const codec = registry.codecFor('rot13')!
    const decoded = await codec.decode(new TextEncoder().encode('Uryyb, Jbeyq'), { name: 'a.rot13', format: 'rot13' })
    expect(decoded).toEqual({ kind: 'text', text: 'Hello, World', name: 'a.rot13' })
    const bytes = await codec.encode({ kind: 'text', text: 'Hello, World', name: 'a.rot13' }, { name: 'a.rot13', format: 'rot13' })
    expect(new TextDecoder().decode(bytes)).toBe('Uryyb, Jbeyq')
  },

  async surface(example) {
    const { registry } = await setup(example)
    expect(registry.resolveKind('todo.lines')).toBe('ext:kb.lines.surface')
    const surface = (await loadSurface('ext:kb.lines.surface', 'lines'))!
    const el = document.createElement('div')
    await surface.mount(el, { document: { payload: { kind: 'text', text: 'a\nb\nc', name: 'todo.lines' } }, session: { execute: async () => ({ ok: true }) } } as never)
    expect([...el.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['a', 'b', 'c'])
    expect(surface.capture().kind).toBe('ext:kb.lines.surface')
    surface.unmount()
    expect(el.querySelector('ul')).toBeNull()
  },

  async ai(example) {
    const { registry, binding } = await setup(example, { selection: 'hello' })
    expect(registry.aiTools().map((tool) => tool.id)).toEqual(['kb.shout.upper'])
    const suggestion = await registry.runAITool('kb.shout.upper', binding)
    expect(suggestion).toMatchObject({ original: 'hello', text: 'HELLO', note: '只转英文字母' })
    expect(binding.executed).toEqual([]) // 建议不会自己改文档
    await registry.applySuggestion(suggestion, binding)
    expect(binding.executed.map((command) => command.args)).toEqual([{ text: 'HELLO' }])
  },

  async clipboard(example) {
    const { registry, binding, clipboard, notices } = await setup(example, { selection: '选中的字' })
    expect(await registry.runCommand('kb.copy.selection', undefined, binding)).toEqual({ ok: true })
    expect(clipboard).toEqual(['选中的字'])
    expect(notices).toEqual(['已复制选区'])
  },

  async network(example) {
    const { registry, notices, fetched } = await setup(example)
    expect(await registry.runCommand('kb.fetch.now', undefined)).toEqual({ ok: true })
    expect(fetched).toEqual(['https://api.example.com/v1/status'])
    expect(notices).toEqual(['状态:ok'])
  },
}

describe('文档里的示例', () => {
  const examples = examplesInDoc()

  it('每个示例都是 toml + js 成对出现，而且都有对应的验证', () => {
    for (const [name, example] of Object.entries(examples)) {
      expect(example.toml, `${name} 缺少 toml`).toBeTruthy()
      expect(example.js, `${name} 缺少 js`).toBeTruthy()
    }
    expect(Object.keys(examples).sort()).toEqual(Object.keys(checks).sort())
    // 文档要覆盖计划里的注册点：命令 / 工具栏 / 斜杠 / 面板 / 状态栏 / Codec / 内容面 / AI 工具
    expect(Object.keys(examples)).toEqual(expect.arrayContaining(['command', 'toolbar', 'slash', 'panel', 'status', 'codec', 'surface', 'ai']))
  })

  it.each(Object.keys(checks))('示例 %s：清单合法，脚本能装、能跑、能卸载', async (name) => {
    const example = examples[name]!
    await checks[name]!(example)
    // 卸载后一切回收
    const { registry } = await setup(example)
    const id = manifestOf(example).id
    expect(await registry.uninstall(id)).toBe(true)
    expect(registry.list()).toEqual([])
    expect(registry.toolbarItemsFor('text')).toEqual([])
    expect(registry.panels('text')).toEqual([])
    expect(registry.aiTools()).toEqual([])
    expect(registry.statusItemsFor('text', 'status')).toEqual([])
  })

  it('清单里声明的权限都是文档权限表里写过的', () => {
    const table = DOC.slice(DOC.indexOf('## 权限'), DOC.indexOf('## 写一个扩展'))
    for (const example of Object.values(examples)) {
      for (const permission of manifestOf(example).permissions) expect(table, permission).toContain(`\`${permission}\``)
    }
  })
})

describe('文档里的「内置功能也是扩展」', () => {
  const section = DOC.slice(DOC.indexOf('### 内置扩展一览'), DOC.indexOf('### 写一个内置扩展'))

  it('一览表列出的扩展 id 与 BUILTIN_EXTENSIONS 一一对应（同样的先后顺序）', () => {
    expect(section.length).toBeGreaterThan(100)
    const documented = [...section.matchAll(/^\| `(kb\.builtin\.[\w.-]+)` \|/gm)].map((match) => match[1])
    expect(documented).toEqual(BUILTIN_EXTENSIONS.map(({ manifest }) => manifest.id))
  })

  it('文档里贴出的内置扩展源码与仓库里的文件逐字一致（去掉文件头注释）', () => {
    const block = DOC.match(/```ts source=builtin\/export\.ext\.ts\n([\s\S]*?)```/)
    expect(block, '文档里缺少 export.ext.ts 的源码块').toBeTruthy()
    const body = EXPORT_EXT_SOURCE.replace(/^\/\*\*[\s\S]*?\*\/\n/, '').trim()
    expect(block![1]!.trim()).toBe(body)
  })
})
