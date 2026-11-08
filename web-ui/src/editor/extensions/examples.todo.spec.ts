/**
 * 示例扩展「待办清单格式」（注册新格式：Codec + 内容面）端到端
 *
 * 加载的是 `web-ui/examples/editor-todo-format/` 里**真实的** `index.js` 与 `manifest.toml`，
 * 和管理员复制进 `<KB_HOME>/editor-extensions/` 的是同一份文件。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import MANIFEST_TOML from '../../../examples/editor-todo-format/manifest.toml?raw'
import SNAPSHOT_RAW from '../../../../crates/kb-web/tests/fixtures/editor-todo-format.manifest.json?raw'
import { parseToml } from '../../../e2e/toml-lite.mjs'
import type { EditorExtension, ExtensionManifest } from './api'
import { parseManifest } from './manifest'
import { ExtensionRegistry } from './registry'
import { loadSurface, resetSurfaceRegistry } from '../surfaces/registry'
import type { EditorSource, SurfaceContext } from '../types'

interface TodoModule {
  default: EditorExtension
  parseTodoJson: (text: string) => { title: string; items: { text: string; done: boolean }[] }
  toChecklist: (model: { title: string; items: { text: string; done: boolean }[] }) => string
  fromChecklist: (text: string) => { title: string; items: { text: string; done: boolean }[] }
  toTodoJson: (model: { title: string; items: { text: string; done: boolean }[] }) => string
}
const modules = import.meta.glob('../../../examples/editor-todo-format/index.js') as Record<string, () => Promise<TodoModule>>
const loadModule = () => Object.values(modules)[0]!()

const CANONICAL = '{\n  "title": "周五发布",\n  "items": [\n    {\n      "text": "冻结版本",\n      "done": true\n    },\n    {\n      "text": "写发布说明",\n      "done": false\n    }\n  ]\n}\n'
const CHECKLIST = '# 周五发布\n[x] 冻结版本\n[ ] 写发布说明'

function exampleManifest(): ExtensionManifest {
  const parsed = parseManifest(parseToml(MANIFEST_TOML))
  if (!parsed.ok) throw new Error(parsed.errors.join('；'))
  return parsed.manifest
}

afterEach(() => {
  resetSurfaceRegistry()
  document.body.innerHTML = ''
})

describe('示例扩展：待办清单格式', () => {
  it('1. manifest.toml 解析结果与后端真实解析出的快照一致；接管的只有 .kbtodo，权限是读 / 写文档和画界面', () => {
    const fromSnapshot = parseManifest(JSON.parse(SNAPSHOT_RAW))
    expect(fromSnapshot.ok).toBe(true)
    expect(exampleManifest()).toEqual((fromSnapshot as { manifest: ExtensionManifest }).manifest)
    const manifest = exampleManifest()
    expect(manifest.permissions).toEqual(['document.read', 'document.write', 'ui'])
    expect(manifest.contributes.codecs).toEqual([{ id: 'kb.todo-format.codec', extensions: ['kbtodo'] }])
    expect(manifest.contributes.surfaces).toEqual([{ id: 'kb.todo-format.surface', extensions: ['kbtodo'] }])
  })

  it('2. 清单文本 ↔ JSON：规范格式的文件解码再编码，字节不变；认不出的内容报错而不是悄悄丢掉', async () => {
    const { parseTodoJson, toChecklist, fromChecklist, toTodoJson } = await loadModule()
    expect(toChecklist(parseTodoJson(CANONICAL))).toBe(CHECKLIST)
    expect(toTodoJson(fromChecklist(CHECKLIST))).toBe(CANONICAL)
    // 没有标题、空清单也是合法文件
    expect(toTodoJson(fromChecklist(''))).toBe('{\n  "title": "",\n  "items": []\n}\n')
    // 磁盘上的 JSON 不合法 / 形状不对 / 一项里有换行：解码失败
    expect(() => parseTodoJson('not json')).toThrow('不是合法的 .kbtodo')
    expect(() => parseTodoJson('{"items":"x"}')).toThrow('缺少 items')
    expect(() => parseTodoJson('{"items":[{"text":"a","done":"yes"}]}')).toThrow('第 1 项')
    expect(() => parseTodoJson('{"items":[{"text":"a\\nb","done":false}]}')).toThrow('换行')
    // 清单里有认不出的行：编码失败并指出行号（保存会被取消，原文件不动）
    expect(() => fromChecklist('[ ] 好\n随手写的一行')).toThrow('第 2 行')
  })

  it('3. 装上后 .kbtodo 归扩展：内容面类型是 ext:…，带 Codec；内置格式不受影响；卸载后消失', async () => {
    const registry = new ExtensionRegistry({ confirmWrite: async () => true })
    const { default: extension } = await loadModule()
    await registry.install(exampleManifest(), extension)
    expect(registry.resolveKind('notes.kbtodo')).toBe('ext:kb.todo-format.surface')
    expect(registry.codecFor('kbtodo')).toMatchObject({ extensionId: 'kb.todo-format', surface: 'ext:kb.todo-format.surface' })
    expect(registry.resolveKind('a.md')).toBe('text')
    expect(await registry.uninstall('kb.todo-format')).toBe(true)
    expect(registry.resolveKind('notes.kbtodo')).toBeNull()
    expect(registry.codecFor('kbtodo')).toBeNull()
  })

  it('4. Codec 写回受权限闸门：用户拒绝写权限时 encode 失败；允许才产出 JSON 字节', async () => {
    const { default: extension } = await loadModule()
    const denied = new ExtensionRegistry({ confirmWrite: async () => false })
    await denied.install(exampleManifest(), extension)
    const source: EditorSource = { kind: 'text', text: CHECKLIST, name: 'a.kbtodo' }
    await expect(denied.codecFor('kbtodo')!.encode(source, { name: 'a.kbtodo', format: 'kbtodo' })).rejects.toMatchObject({ name: 'PermissionDeniedError', permission: 'document.write' })

    const allowed = new ExtensionRegistry({ confirmWrite: async () => true })
    await allowed.install(exampleManifest(), extension)
    const bytes = await allowed.codecFor('kbtodo')!.encode(source, { name: 'a.kbtodo', format: 'kbtodo' })
    expect(new TextDecoder().decode(bytes)).toBe(CANONICAL)
    const decoded = await allowed.codecFor('kbtodo')!.decode(new TextEncoder().encode(CANONICAL), { name: 'a.kbtodo', format: 'kbtodo' })
    expect(decoded).toEqual({ kind: 'text', text: CHECKLIST, name: 'a.kbtodo' })
  })

  it('5. 内容面：只读时不能勾选；可编辑时改一处 → 标脏、快照给出新清单、查询 text 一致；卸载时撤掉快照提供者', async () => {
    const registry = new ExtensionRegistry({ confirmWrite: async () => true })
    const { default: extension } = await loadModule()
    await registry.install(exampleManifest(), extension)

    const mountWith = async (readonly: boolean) => {
      const provider: { current: (() => EditorSource | null) | null } = { current: null }
      const dirty: boolean[] = []
      const el = document.createElement('div')
      document.body.append(el)
      const surface = (await loadSurface('ext:kb.todo-format.surface'))!
      const ctx = {
        session: { setSnapshotProvider: (next: (() => EditorSource | null) | null) => (provider.current = next) },
        document: { kind: 'ext:kb.todo-format.surface', format: 'kbtodo', revision: 1, payload: { kind: 'text', text: CHECKLIST, name: 'a.kbtodo' } },
        permissions: { read: true, write: !readonly },
        readonly,
        onDirtyChange: (value: boolean) => dirty.push(value),
        onContentChange: vi.fn(),
        onSaveRequest: vi.fn(),
      } as unknown as SurfaceContext
      await surface.mount(el, ctx)
      return { surface, el, provider, dirty, ctx }
    }

    const readOnly = await mountWith(true)
    expect([...readOnly.el.querySelectorAll<HTMLInputElement>('input')].every((input) => input.disabled)).toBe(true)
    expect(readOnly.el.querySelector('[data-testid="todo-add"]')).toBeNull()
    readOnly.surface.unmount()

    const editable = await mountWith(false)
    const boxes = editable.el.querySelectorAll<HTMLInputElement>('[data-testid="todo-done"]')
    expect([...boxes].map((box) => box.checked)).toEqual([true, false])
    boxes[1]!.checked = true
    boxes[1]!.dispatchEvent(new Event('change'))
    expect(editable.dirty.at(-1)).toBe(true)
    expect(editable.provider.current?.()).toEqual({ kind: 'text', text: '# 周五发布\n[x] 冻结版本\n[x] 写发布说明', name: 'a.kbtodo' })
    expect(await editable.surface.query({ type: 'text' })).toBe('# 周五发布\n[x] 冻结版本\n[x] 写发布说明')
    expect(await editable.surface.query({ type: 'wordCount' })).toEqual({ words: 2, unitLabel: '项' })
    // 改回原样：不再算脏
    boxes[1]!.checked = false
    boxes[1]!.dispatchEvent(new Event('change'))
    expect(editable.dirty.at(-1)).toBe(false)
    // 增删条目
    editable.el.querySelector<HTMLButtonElement>('[data-testid="todo-add"]')!.click()
    expect(editable.el.querySelectorAll('[data-testid="todo-text"]')).toHaveLength(3)
    editable.el.querySelector<HTMLButtonElement>('[data-testid="todo-remove"]')!.click()
    expect(editable.el.querySelectorAll('[data-testid="todo-text"]')).toHaveLength(2)
    // Ctrl+S 交回宿主统一保存
    editable.el.querySelector('[data-testid="todo-surface"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))
    expect(editable.ctx.onSaveRequest).toHaveBeenCalledTimes(1)
    editable.surface.unmount()
    expect(editable.provider.current).toBeNull()
  })
})
