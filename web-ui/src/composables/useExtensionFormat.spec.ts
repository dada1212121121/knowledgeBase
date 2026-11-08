/**
 * 文件页问编辑器扩展「认不认识这个格式」（useExtensionFormat）
 *
 * 用真实的注册表和真实的示例扩展（`examples/editor-todo-format`）；只把「向后端取清单、动态 import 入口脚本」
 * 这一步换成桩，页面里其余逻辑都是真的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import MANIFEST_TOML from '../../examples/editor-todo-format/manifest.toml?raw'
import { parseToml } from '../../e2e/toml-lite.mjs'
import { parseManifest } from '@/editor/extensions/manifest'
import { getExtensionRegistry, resetExtensionRuntime } from '@/editor/extensions/runtime'
import type { EditorExtension } from '@/editor/extensions/api'
import { useSessionStore } from '@/stores/session'
import { extensionOfName, extensionSourceOf, saveTextOf, useExtensionFormat } from './useExtensionFormat'

// 后端清单接口 + 入口脚本：由测试决定「扩展有没有装上」。这里替掉运行时的 ensureExtensionsLoaded，其余（注册表、订阅）用真的
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

/** 挂一个只调用 useExtensionFormat 的小组件，把名字交给测试改 */
function mountProbe(initial: string | undefined) {
  const name = ref(initial)
  const result = {} as ReturnType<typeof useExtensionFormat>
  const wrapper = mount(
    defineComponent({
      setup() {
        Object.assign(result, useExtensionFormat(() => name.value))
        return () => h('div')
      },
    }),
  )
  return { name, result, wrapper }
}

beforeEach(() => {
  setActivePinia(createPinia())
  resetExtensionRuntime()
  ensureSpy.mockReset()
  ensureSpy.mockResolvedValue({ enabled: true, loaded: [], failed: [], removed: [], forbidden: false })
})
afterEach(() => {
  resetExtensionRuntime()
})

describe('extensionOfName', () => {
  it('取路径里最后一段的扩展名（小写）；没有扩展名 / 点开头的隐藏文件返回空', () => {
    expect(extensionOfName('docs/周报.KBTODO')).toBe('kbtodo')
    expect(extensionOfName('a.tar.gz')).toBe('gz')
    for (const name of ['Makefile', '.gitignore', 'dir.d/Makefile', 'trailing.', '', undefined]) expect(extensionOfName(name), String(name)).toBe('')
  })
})

describe('useExtensionFormat', () => {
  it('页面自己认得的格式、没有扩展名的文件：根本不问扩展（不下载运行时、不请求清单）', async () => {
    await installTodoExample()
    for (const name of ['report.pdf', 'a.md', 'b.csv', 'Hit.cs', 'Makefile', '.gitignore']) {
      const { result, wrapper } = mountProbe(name)
      await flushPromises()
      expect(result.format.value, name).toBeNull()
      expect(result.pending.value, name).toBe(false)
      wrapper.unmount()
    }
    expect(ensureSpy).not.toHaveBeenCalled()
  })

  it('不认得的扩展名 + 没有扩展认领：问过之后是 null，问的过程中 pending 为真；回退照旧', async () => {
    let release: (value: unknown) => void = () => undefined
    ensureSpy.mockReturnValue(new Promise((resolve) => (release = resolve)))
    const { result } = mountProbe('notes.kbtodo')
    await flushPromises()
    expect(result.pending.value).toBe(true)
    expect(result.format.value).toBeNull()
    release({ enabled: false })
    await flushPromises()
    expect(ensureSpy).toHaveBeenCalledTimes(1)
    expect(result.pending.value).toBe(false)
    expect(result.format.value).toBeNull()
  })

  it('扩展注册了 Codec + 内容面：给出扩展名、内容面类型和「带 Codec」；换成别的文件重新判断', async () => {
    await installTodoExample()
    const { name, result } = mountProbe('docs/周五.kbtodo')
    await flushPromises()
    expect(result.format.value).toEqual({ ext: 'kbtodo', kind: 'ext:kb.todo-format.surface', hasCodec: true })
    expect(result.pending.value).toBe(false)
    name.value = 'docs/readme.md'
    await flushPromises()
    expect(result.format.value).toBeNull()
    name.value = 'other.kbtodo'
    await flushPromises()
    expect(result.format.value?.ext).toBe('kbtodo')
  })

  it('跟着注册表走：管理员关掉开关 / 扩展被撤掉后立刻回到回退，再装上又回来', async () => {
    await installTodoExample()
    const { result } = mountProbe('a.kbtodo')
    await flushPromises()
    expect(result.format.value).not.toBeNull()
    await getExtensionRegistry().uninstall('kb.todo-format')
    await nextTick()
    expect(result.format.value).toBeNull()
    await installTodoExample()
    await nextTick()
    expect(result.format.value?.kind).toBe('ext:kb.todo-format.surface')
  })

  it('已知不是管理员（没有 sys.settings）：不问，不下载运行时；还不知道身份时照常问', async () => {
    await installTodoExample()
    const session = useSessionStore()
    session.loaded = true
    session.features = new Set(['docs.read'])
    const plain = mountProbe('a.kbtodo')
    await flushPromises()
    expect(plain.result.format.value).toBeNull()
    expect(plain.result.pending.value).toBe(false)
    expect(ensureSpy).not.toHaveBeenCalled()
    plain.wrapper.unmount()

    session.features = new Set(['docs.read', 'sys.settings'])
    const admin = mountProbe('a.kbtodo')
    await flushPromises()
    expect(admin.result.format.value?.ext).toBe('kbtodo')
    expect(ensureSpy).toHaveBeenCalledTimes(1)
  })

  it('运行时加载出意外：当作没有扩展认领，不抛未处理的异常', async () => {
    ensureSpy.mockRejectedValue(new Error('chunk load failed'))
    const { result } = mountProbe('a.kbtodo')
    await flushPromises()
    expect(result.format.value).toBeNull()
    expect(result.pending.value).toBe(false)
  })

  it('组件卸载后不再响应注册表变化', async () => {
    await installTodoExample()
    const { result, wrapper } = mountProbe('a.kbtodo')
    await flushPromises()
    expect(result.format.value).not.toBeNull()
    wrapper.unmount()
    await getExtensionRegistry().uninstall('kb.todo-format')
    await nextTick()
    expect(result.format.value).not.toBeNull()
  })
})

describe('打开请求的来源 / 保存内容', () => {
  it('带 Codec 给字节（让外壳跑 decode），不带给文本', () => {
    expect(extensionSourceOf('你好', 'a.kbtodo', true)).toEqual({ kind: 'bytes', bytes: new TextEncoder().encode('你好'), name: 'a.kbtodo' })
    expect(extensionSourceOf('你好', 'a.kbtodo', false)).toEqual({ kind: 'text', text: '你好', name: 'a.kbtodo' })
  })

  it('保存：文本原样；合法 UTF-8 字节解成文本；不是 UTF-8 就拒绝并说明原因，绝不返回空串', () => {
    expect(saveTextOf({ kind: 'text', text: 'x', name: 'a' })).toEqual({ ok: true, text: 'x' })
    expect(saveTextOf({ kind: 'bytes', bytes: new TextEncoder().encode('{"a":"汉"}\n'), name: 'a' })).toEqual({ ok: true, text: '{"a":"汉"}\n' })
    const bad = saveTextOf({ kind: 'bytes', bytes: new Uint8Array([0xff, 0xfe, 0x00]), name: 'a' })
    expect(bad.ok).toBe(false)
    expect(bad.ok === false && bad.reason).toContain('不是 UTF-8')
  })
})
