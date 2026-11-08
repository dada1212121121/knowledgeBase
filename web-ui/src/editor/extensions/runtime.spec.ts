/**
 * 扩展运行时：页面级单例、清单只请求一次、非管理员不请求、配置热更新时对齐
 */
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveEvent } from '@/composables/useLiveEvents'
import { useSessionStore } from '@/stores/session'

type Listener = (event: LiveEvent) => void
const live = vi.hoisted(() => ({ listeners: new Set<(event: { type: string; data: Record<string, unknown> }) => void>() }))
vi.mock('@/composables/useLiveEvents', () => ({
  subscribeLive: (listener: Listener) => {
    live.listeners.add(listener)
    return () => live.listeners.delete(listener)
  },
}))

import { BUILTIN_EXTENSIONS } from './builtin'
import { defaultExtensionGate, ensureExtensionsLoaded, getExtensionRegistry, resetExtensionRuntime, resyncExtensions, watchExtensionConfig } from './runtime'

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify({ ok: status < 400, data }), { status })
}

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  resetExtensionRuntime()
  live.listeners.clear()
  fetchMock = vi.fn(async () => jsonResponse({ enabled: false, extensions: [] }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  resetExtensionRuntime()
})

describe('注册表单例', () => {
  it('1. 同一个页面只有一个注册表，并且已经装好全部内置扩展', () => {
    const registry = getExtensionRegistry()
    expect(getExtensionRegistry()).toBe(registry)
    // 安装顺序有意义：文本面的格式分组先于它的「视图」分组
    expect(registry.list().map((item) => [item.manifest.id, item.builtin])).toEqual(BUILTIN_EXTENSIONS.map(({ manifest }) => [manifest.id, true]))
    expect(registry.list().every((item) => item.builtin)).toBe(true)
    // 文本面的视图按钮在注册表里，排在格式分组之后
    const text = registry.toolbarItemsFor('text').map((item) => item.spec.id)
    expect(text.slice(-3)).toEqual(['find', 'source', 'outline'])
    expect(text).toContain('bold')
    resetExtensionRuntime()
    expect(getExtensionRegistry()).not.toBe(registry)
  })
})

describe('加载清单', () => {
  it('2. 多个编辑器同时请求：只发一次清单请求，共享结果', async () => {
    const [a, b] = await Promise.all([ensureExtensionsLoaded(), ensureExtensionsLoaded()])
    await ensureExtensionsLoaded()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(a).toMatchObject({ enabled: false, forbidden: false })
  })

  it('3. 非管理员（后端 403）：不算失败，之后也不再请求', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 403))
    expect(await ensureExtensionsLoaded()).toMatchObject({ forbidden: true, failed: [] })
    await ensureExtensionsLoaded()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('4. 网络出错：下一次调用会重试', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect((await ensureExtensionsLoaded()).failed[0]).toMatchObject({ id: '(清单)' })
    expect(await ensureExtensionsLoaded()).toMatchObject({ enabled: false, failed: [] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('5. 调用方已知没权限时连请求都不发', async () => {
    expect(await ensureExtensionsLoaded(() => false)).toMatchObject({ forbidden: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('6. 默认的权限判断：有 Pinia 时看是否拥有「系统参数」功能点；会话没加载完按有处理', () => {
    setActivePinia(createPinia())
    const session = useSessionStore()
    expect(defaultExtensionGate()).toBe(true) // 还没加载
    session.loaded = true
    session.features = new Set(['search.basic'])
    expect(defaultExtensionGate()).toBe(false)
    session.features = new Set(['search.basic', 'sys.settings'])
    expect(defaultExtensionGate()).toBe(true)
  })
})

describe('配置热更新', () => {
  const settled = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
  }
  const push = (type: string, data: Record<string, unknown>) => live.listeners.forEach((listener) => listener({ type, data }))

  it('7. 收到命中 editor.* 的 config.changed 才重新对齐；别的配置、别的事件不触发', async () => {
    const stop = watchExtensionConfig()
    expect(live.listeners.size).toBe(1)
    push('config.changed', { hot: ['search.k'], restart_required: [], notes: [] })
    push('job.progress', { hot: ['editor.extensions'] })
    await settled()
    expect(fetchMock).not.toHaveBeenCalled()
    push('config.changed', { hot: ['search.k', 'editor.extensions'], restart_required: [], notes: [] })
    await settled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    stop()
  })

  it('8. 订阅按引用计数：最后一个编辑器离开才取消；重复调用取消函数无副作用', () => {
    const stopA = watchExtensionConfig()
    const stopB = watchExtensionConfig()
    expect(live.listeners.size).toBe(1) // 全站只订阅一次
    stopA()
    stopA()
    expect(live.listeners.size).toBe(1)
    stopB()
    expect(live.listeners.size).toBe(0)
  })

  it('9. 开关关掉 → 重新对齐后已装的第三方扩展被撤掉，内置的保留', async () => {
    const registry = getExtensionRegistry()
    await registry.install(
      { id: 'kb.ext', name: 'x', version: '1.0.0', apiVersion: 1, entry: 'index.js', permissions: [], contributes: { commands: [], toolbar: [], slash: [], panels: [], codecs: [], surfaces: [], aiTools: [] } },
      { activate: () => undefined },
    )
    expect(registry.isInstalled('kb.ext')).toBe(true)
    const report = await resyncExtensions()
    expect(report.removed).toEqual(['kb.ext'])
    expect(registry.isInstalled('kb.ext')).toBe(false)
    expect(registry.isInstalled('kb.builtin.view')).toBe(true)
  })
})
