/**
 * 示例扩展（字数统计）端到端 + 示例只走公开入口
 *
 * 这里加载的是 `web-ui/examples/editor-word-count/` 里**真实的** `index.js` 与 `manifest.toml`——
 * 和管理员复制进 `<KB_HOME>/editor-extensions/` 的是同一份文件。
 */
import { describe, expect, it, vi } from 'vitest'
import MANIFEST_TOML from '../../../examples/editor-word-count/manifest.toml?raw'
import SNAPSHOT_RAW from '../../../../crates/kb-web/tests/fixtures/editor-word-count.manifest.json?raw'
import { parseToml } from '../../../e2e/toml-lite.mjs'
import type { EditorExtension, ExtensionManifest } from './api'
import { loadInstalledExtensions } from './loader'
import { parseManifest } from './manifest'
import { ExtensionRegistry } from './registry'
import typedExample from './examples/typed'
import { fakeBinding, manifestFor, settle } from './__fixtures__/testkit'

const modules = import.meta.glob('../../../examples/editor-word-count/index.js') as Record<string, () => Promise<{ default: EditorExtension; countText: (text: string) => Record<string, number> }>>
const loadModule = () => Object.values(modules)[0]!()

function exampleManifest(): ExtensionManifest {
  const parsed = parseManifest(parseToml(MANIFEST_TOML))
  if (!parsed.ok) throw new Error(parsed.errors.join('；'))
  return parsed.manifest
}

describe('示例扩展：字数统计', () => {
  it('1. manifest.toml 解析结果与后端真实解析出的快照一致，权限只有读文档和画界面', () => {
    const fromSnapshot = parseManifest(JSON.parse(SNAPSHOT_RAW))
    expect(fromSnapshot.ok).toBe(true)
    expect(exampleManifest()).toEqual((fromSnapshot as { manifest: ExtensionManifest }).manifest)
    expect(exampleManifest().permissions).toEqual(['document.read', 'ui'])
  })

  it('2. 统计函数：汉字、英文词、段落、字符', async () => {
    const { countText } = await loadModule()
    expect(countText('')).toEqual({ cjk: 0, words: 0, paragraphs: 0, chars: 0 })
    expect(countText('你好，世界！Hello, it\'s a nice-day 2024')).toMatchObject({ cjk: 4, words: 5 })
    expect(countText('第一段\n第一段第二行\n\n第二段\n\n\n  \n第三段')).toMatchObject({ paragraphs: 3 })
    expect(countText('あいう カタカナ 한글')).toMatchObject({ cjk: 3 + 4 + 2 })
    expect(countText(' a b\n')).toMatchObject({ chars: 2 })
    expect(countText(undefined as unknown as string)).toMatchObject({ cjk: 0 })
  })

  it('3. 注册 → 运行 → 卸载：按钮、命令、面板随安装出现，面板随输入更新，卸载后全部消失', async () => {
    const notices: string[] = []
    const registry = new ExtensionRegistry({ notify: (message) => void notices.push(message) })
    const binding = fakeBinding({ text: '你好世界 hello world\n\n第二段', selection: '' })
    registry.attachHost(binding)
    const { default: extension } = await loadModule()
    await registry.install(exampleManifest(), extension)

    // 注册
    expect(registry.toolbarItemsFor('text').map((item) => [item.spec.id, item.spec.label, item.spec.icon, item.spec.command])).toEqual([
      ['kb.word-count.button', '字数统计', 'Σ', 'kb.word-count.show'],
    ])
    const panel = registry.panels('text')[0]!
    expect(panel).toMatchObject({ id: 'kb.word-count.panel', title: '字数统计', icon: 'Σ' })

    // 运行：工具栏按钮触发的命令给出提示
    expect(await registry.runCommand('kb.word-count.show', undefined, binding)).toEqual({ ok: true })
    expect(notices).toEqual(['全文:汉字 7 · 英文 2 词 · 2 段'])
    binding.selection = '你好'
    await registry.runCommand('kb.word-count.show', undefined, binding)
    expect(notices[1]).toBe('全文:汉字 7 · 英文 2 词 · 2 段;选中:汉字 2 · 英文 0 词 · 1 段')

    // 面板：初次渲染 + 订阅 change 实时更新
    const el = document.createElement('div')
    const cleanup = await registry.mountPanel(panel, el, binding)
    await settle()
    const cell = (key: string) => el.querySelector(`[data-testid="wc-${key}"]`)!.textContent
    expect([cell('cjk'), cell('words'), cell('paragraphs')]).toEqual(['7', '2', '2'])
    binding.text = '一二三四五六七八九十 and more words here\n\n二\n\n三'
    registry.emitChange(binding)
    await settle()
    expect([cell('cjk'), cell('words'), cell('paragraphs')]).toEqual(['12', '4', '3'])

    // 关闭面板：清理订阅，之后的变化不再更新（也没有泄漏的监听）
    cleanup()
    expect(el.childNodes).toHaveLength(0)
    binding.text = 'changed'
    registry.emitChange(binding)
    await settle()
    expect(el.childNodes).toHaveLength(0)

    // 卸载：贡献全部消失
    expect(await registry.uninstall('kb.word-count')).toBe(true)
    expect(registry.toolbarItemsFor('text')).toEqual([])
    expect(registry.panels('text')).toEqual([])
    expect(registry.hasCommand('kb.word-count.show')).toBe(false)
  })

  it('4. 示例没有改文档的能力：即使有人拿着它的上下文去写，也被权限拒绝', async () => {
    const registry = new ExtensionRegistry({ confirmWrite: async () => true })
    registry.attachHost(fakeBinding({ selection: 'x' }))
    let leaked: Parameters<EditorExtension['activate']>[0] | null = null
    const { default: extension } = await loadModule()
    await registry.install(exampleManifest(), {
      activate(ctx) {
        leaked = ctx
        return extension.activate(ctx)
      },
    })
    await expect(leaked!.document.replaceSelection('y')).rejects.toMatchObject({ name: 'PermissionDeniedError', permission: 'document.write' })
    await expect(leaked!.fetch('https://example.com')).rejects.toMatchObject({ permission: 'network' })
  })

  it('5. 走加载器：按后端返回的清单（真实快照）装上，再被后端撤掉', async () => {
    const registry = new ExtensionRegistry()
    const snapshot = JSON.parse(SNAPSHOT_RAW)
    const module = await loadModule()
    const respond = (data: unknown) => vi.fn(async () => new Response(JSON.stringify({ ok: true, data }), { status: 200 }))
    const report = await loadInstalledExtensions({
      registry,
      fetch: respond({ enabled: true, dir: '/x', extensions: [{ id: 'kb.word-count', dir: 'kb.word-count', manifest: snapshot, error: null }] }),
      importModule: async () => module,
    })
    expect(report.loaded).toEqual(['kb.word-count'])
    expect(registry.toolbarItemsFor('text')).toHaveLength(1)
    await loadInstalledExtensions({ registry, fetch: respond({ enabled: false, extensions: [] }), importModule: async () => module })
    expect(registry.toolbarItemsFor('text')).toHaveLength(0)
  })
})

describe('类型化示例（examples/typed.ts）', () => {
  it('七类贡献各注册一遍，卸载后全部回收', async () => {
    const registry = new ExtensionRegistry()
    await registry.install(
      manifestFor({
        id: 'kb.typed',
        permissions: ['ui', 'ai', 'document.read', 'document.write'],
        contributes: {
          commands: [{ id: 'kb.typed.hello', title: '打招呼' }],
          toolbar: [{ id: 'kb.typed.button' }],
          slash: [{ id: 'kb.typed.slash' }],
          panels: [{ id: 'kb.typed.panel', title: '示例面板' }],
          codecs: [{ id: 'kb.typed.codec', extensions: ['typedc'] }],
          surfaces: [{ id: 'kb.typed.surface', extensions: ['typeds'] }],
          aiTools: [{ id: 'kb.typed.ai', title: '转大写' }],
        },
      }),
      typedExample,
    )
    expect(registry.hasCommand('kb.typed.hello')).toBe(true)
    expect(registry.toolbarItemsFor('text')).toHaveLength(1)
    expect(registry.slashItemsFor('text')).toHaveLength(1)
    expect(registry.panels('text')).toHaveLength(1)
    expect(registry.codecFor('typedc')).not.toBeNull()
    expect(registry.resolveKind('a.typeds')).toBe('ext:kb.typed.surface')
    expect(registry.aiTools()).toHaveLength(1)
    await registry.uninstall('kb.typed')
    expect([registry.hasCommand('kb.typed.hello'), registry.codecFor('typedc'), registry.resolveKind('a.typeds')]).toEqual([false, null, null])
  })
})

describe('扩展示例只走公开入口 @/editor/api', () => {
  // 被检查的源码：仓库示例、类型化示例、故意越权的夹具。它们和真正的第三方扩展处在同一个位置
  const sources = {
    ...import.meta.glob('../../../examples/**/*.{js,ts}', { query: '?raw', import: 'default', eager: true }),
    ...import.meta.glob('./examples/**/*.ts', { query: '?raw', import: 'default', eager: true }),
    ...import.meta.glob('./__fixtures__/overreach.ts', { query: '?raw', import: 'default', eager: true }),
  } as Record<string, string>

  it('读得到被检查的文件（防止 glob 路径变了悄悄空转）', () => {
    const names = Object.keys(sources)
    expect(names.some((name) => name.endsWith('editor-word-count/index.js'))).toBe(true)
    expect(names.some((name) => name.endsWith('overreach.ts'))).toBe(true)
  })

  it('不 import @/editor 下除 @/editor/api 以外的任何模块，也不用相对路径摸进 editor 内部', () => {
    const offenders: string[] = []
    for (const [name, source] of Object.entries(sources)) {
      for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const target = match[1]!
        const internalAlias = target.startsWith('@/editor') && target !== '@/editor/api' && !target.startsWith('@/editor/api/')
        const relativeIntoEditor = target.startsWith('.') && /(^|\/)editor\//.test(new URL(target, `file:///${name.replace(/^(\.\.\/)+/, '')}`).pathname)
        if (internalAlias || relativeIntoEditor || target.includes('editor/internal') || target.startsWith('@betteroffice')) offenders.push(`${name} → ${target}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
