/**
 * EditorHost × 扩展注册的新格式（待办清单 .kbtodo）：打开 → 改一处 → 保存
 *
 * 文件浏览页的编辑通道就是这条路径：页面把文件字节交给外壳，外壳经扩展 Codec 解码、扩展内容面显示与编辑，
 * 保存时经 Codec 编码成字节交给页面的保存通道。这里用真实的示例扩展和真实的 EditorHost 验证整条链，
 * 并验证「Codec 写回受权限闸门」：用户拒绝写权限时保存失败，页面的保存通道一次都不会被调用。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MANIFEST_TOML from '../../../examples/editor-todo-format/manifest.toml?raw'
import { parseToml } from '../../../e2e/toml-lite.mjs'
import EditorHost from './EditorHost.vue'
import { parseManifest } from '../extensions/manifest'
import { getExtensionRegistry, resetExtensionRuntime } from '../extensions/runtime'
import { resetSurfaceRegistry } from '../surfaces/registry'
import type { EditorExtension } from '../extensions/api'
import type { EditorOpenRequest } from '../types'
import type { SessionSaveRequest } from '../session/DocumentSession'

// 这个页面不向后端取清单：扩展由测试直接装进注册表
vi.mock('../extensions/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../extensions/runtime')>()),
  ensureExtensionsLoaded: vi.fn(async () => ({ enabled: true, loaded: [], failed: [], removed: [], forbidden: false })),
}))

const modules = import.meta.glob('../../../examples/editor-todo-format/index.js') as Record<string, () => Promise<{ default: EditorExtension }>>

const FILE = '{\n  "title": "周五发布",\n  "items": [\n    {\n      "text": "冻结版本",\n      "done": true\n    },\n    {\n      "text": "写发布说明",\n      "done": false\n    }\n  ]\n}\n'

async function waitFor(predicate: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await flushPromises()
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('waitFor 超时')
}

async function install(confirmWrite: () => Promise<boolean>) {
  const parsed = parseManifest(parseToml(MANIFEST_TOML))
  if (!parsed.ok) throw new Error(parsed.errors.join('；'))
  const registry = getExtensionRegistry()
  registry.setConfirmWrite(confirmWrite)
  await registry.install(parsed.manifest, (await Object.values(modules)[0]!()).default)
}

function request(overrides: Partial<EditorOpenRequest> = {}): EditorOpenRequest {
  return {
    fileId: 'proj:docs/周五.kbtodo',
    format: 'kbtodo',
    source: { kind: 'bytes', bytes: new TextEncoder().encode(FILE), name: 'docs/周五.kbtodo' },
    readonly: false,
    revision: 7,
    permissions: { read: true, write: true, export: false, comment: false, ai: false },
    ...overrides,
  }
}

beforeEach(() => resetExtensionRuntime())
afterEach(() => {
  document.body.innerHTML = ''
  resetExtensionRuntime()
  resetSurfaceRegistry()
})

describe('EditorHost 打开扩展注册的 .kbtodo', () => {
  it('打开 → 改一处 → 保存：交给保存通道的是 Codec 编码出来的 JSON 字节，带页面给的版本号；第一次写要确认', async () => {
    const confirmWrite = vi.fn(async () => true)
    await install(confirmWrite)
    const saved: SessionSaveRequest[] = []
    const wrapper = mount(EditorHost, {
      props: { request: request(), transport: { save: async (req: SessionSaveRequest) => (saved.push(req), { ok: true, revision: 8, sha256: '' }) }, chromeTitle: false, chromeClose: false, chromeSave: false },
      attachTo: document.body,
    })
    await waitFor(() => document.querySelectorAll('[data-testid="todo-text"]').length === 2)
    expect((wrapper.vm as unknown as { surfaceKind: string }).surfaceKind).toBe('ext:kb.todo-format.surface')
    expect(document.querySelector<HTMLInputElement>('[data-testid="todo-title"]')?.value).toBe('周五发布')

    const second = document.querySelectorAll<HTMLInputElement>('[data-testid="todo-done"]')[1]!
    second.checked = true
    second.dispatchEvent(new Event('change'))
    await waitFor(() => (wrapper.vm as unknown as { dirty: boolean }).dirty)

    await (wrapper.vm as unknown as { save(): Promise<void> }).save()
    expect(confirmWrite).toHaveBeenCalledTimes(1)
    expect(saved).toHaveLength(1)
    expect(saved[0]!.revision).toBe(7)
    expect(saved[0]!.source.kind).toBe('bytes')
    const bytes = (saved[0]!.source as { bytes: Uint8Array }).bytes
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({
      title: '周五发布',
      items: [
        { text: '冻结版本', done: true },
        { text: '写发布说明', done: true },
      ],
    })
    expect(new TextDecoder().decode(bytes)).toBe(FILE.replace('"done": false', '"done": true'))
    wrapper.unmount()
  })

  it('用户拒绝写权限：保存失败并说明原因，页面的保存通道一次都没被调用，改动留在编辑器里', async () => {
    await install(async () => false)
    const transport = { save: vi.fn(async () => ({ ok: true as const, revision: 8, sha256: '' })) }
    const wrapper = mount(EditorHost, {
      props: { request: request(), transport, chromeTitle: false, chromeClose: false, chromeSave: false },
      attachTo: document.body,
    })
    await waitFor(() => document.querySelectorAll('[data-testid="todo-text"]').length === 2)
    const first = document.querySelector<HTMLInputElement>('[data-testid="todo-text"]')!
    first.value = '冻结版本 v2'
    first.dispatchEvent(new Event('input'))
    await waitFor(() => (wrapper.vm as unknown as { dirty: boolean }).dirty)
    await (wrapper.vm as unknown as { save(): Promise<void> }).save()
    expect(transport.save).not.toHaveBeenCalled()
    expect((wrapper.vm as unknown as { dirty: boolean }).dirty).toBe(true)
    expect(document.querySelector<HTMLInputElement>('[data-testid="todo-text"]')?.value).toBe('冻结版本 v2')
    wrapper.unmount()
  })

  it('清单被改成认不出的内容（编码失败）：保存被取消，原文件不动', async () => {
    await install(async () => true)
    const transport = { save: vi.fn(async () => ({ ok: true as const, revision: 8, sha256: '' })) }
    const wrapper = mount(EditorHost, {
      props: { request: request(), transport, chromeTitle: false, chromeClose: false, chromeSave: false },
      attachTo: document.body,
    })
    await waitFor(() => document.querySelectorAll('[data-testid="todo-text"]').length === 2)
    // 内容面只会产出合法清单，所以直接让快照里出现一行 Codec 认不出的内容：模拟别的内容面 / 扩展的 bug
    const session = (wrapper.vm as unknown as { activeSession: { setSnapshotProvider(provider: () => unknown): void; markDirty(value: boolean): void } }).activeSession
    session.setSnapshotProvider(() => ({ kind: 'text', text: '[ ] 好\n随手写的一行', name: 'a.kbtodo' }))
    session.markDirty(true)
    await (wrapper.vm as unknown as { save(): Promise<void> }).save()
    expect(transport.save).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
