/**
 * 第三方扩展加载器：清单 → import → install，失败隔离，热更新对齐
 */
import { describe, expect, it, vi } from 'vitest'
import { defineExtension } from '../api'
import { EXTENSIONS_API, entryUrl, loadInstalledExtensions } from './loader'
import { ExtensionRegistry } from './registry'
import { manifestFor } from './__fixtures__/testkit'

/** 后端清单里一项（snake_case，与 Rust 返回的形状一致） */
function listed(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    dir: id,
    error: null,
    manifest: {
      id,
      name: `扩展 ${id}`,
      version: '1.0.0',
      api_version: 1,
      description: null,
      entry: 'index.js',
      permissions: ['ui'],
      contributes: { commands: [{ id: `${id}.run`, title: '运行' }], toolbar: [], slash: [], panels: [], codecs: [], surfaces: [], ai_tools: [] },
      ...extra,
    },
  }
}

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function backend(data: { enabled: boolean; extensions: unknown[] } | number) {
  return vi.fn(async (_url: string, _init?: RequestInit) => (typeof data === 'number' ? respond({ ok: false }, data) : respond({ ok: true, data })))
}

const good = (id: string) =>
  defineExtension({
    activate: (ctx) => void ctx.registerCommand(`${id}.run`, () => undefined),
  })

describe('加载器', () => {
  it('1. 取清单 → 对每个合法清单 import 同源入口 → 安装；URL 带版本号', async () => {
    const registry = new ExtensionRegistry()
    const imported: string[] = []
    const fetchMock = backend({ enabled: true, extensions: [listed('kb.one'), listed('kb.two')] })
    const report = await loadInstalledExtensions({
      registry,
      fetch: fetchMock,
      importModule: async (url) => {
        imported.push(url)
        return { default: good(url.includes('kb.one') ? 'kb.one' : 'kb.two') }
      },
    })
    expect(fetchMock).toHaveBeenCalledWith(EXTENSIONS_API, expect.objectContaining({ credentials: 'same-origin' }))
    expect(report).toMatchObject({ enabled: true, loaded: ['kb.one', 'kb.two'], failed: [], removed: [], forbidden: false })
    expect(imported).toEqual([`${EXTENSIONS_API}/kb.one/index.js?v=1.0.0`, `${EXTENSIONS_API}/kb.two/index.js?v=1.0.0`])
    expect(registry.hasCommand('kb.one.run')).toBe(true)
    expect(entryUrl(manifestFor({ id: 'kb.v', version: '2.0.0-beta.1' }))).toBe(`${EXTENSIONS_API}/kb.v/index.js?v=2.0.0-beta.1`)
  })

  it('2. 失败隔离：清单有错 / import 失败 / 没有默认导出 / activate 抛错，只影响自己，其它照常装', async () => {
    const registry = new ExtensionRegistry()
    const report = await loadInstalledExtensions({
      registry,
      fetch: backend({
        enabled: true,
        extensions: [
          { id: 'kb.broken', dir: 'kb.broken', manifest: null, error: 'api_version = 2 需要更新版本的编辑器扩展 API' },
          { id: 'kb.shape', dir: 'kb.shape', error: null, manifest: { id: 'kb.shape' } },
          listed('kb.noimport'),
          listed('kb.nodefault'),
          listed('kb.throws'),
          listed('kb.ok'),
        ],
      }),
      importModule: async (url) => {
        if (url.includes('kb.noimport')) throw new Error('SyntaxError: Unexpected token')
        if (url.includes('kb.nodefault')) return { other: 1 }
        if (url.includes('kb.throws')) {
          return {
            default: defineExtension({
              activate() {
                throw new Error('启动炸了')
              },
            }),
          }
        }
        return { default: good('kb.ok') }
      },
    })
    expect(report.loaded).toEqual(['kb.ok'])
    const reasons = Object.fromEntries(report.failed.map((failure) => [failure.id, failure.error]))
    expect(reasons['kb.broken']).toContain('更新版本')
    expect(reasons['kb.shape']).toContain('缺少 name')
    expect(reasons['kb.noimport']).toContain('Unexpected token')
    expect(reasons['kb.nodefault']).toContain('activate')
    expect(reasons['kb.throws']).toContain('启动炸了')
    expect(registry.list().map((item) => item.manifest.id)).toEqual(['kb.ok'])
  })

  it('3. 开关关着（enabled:false）不装任何东西，并撤掉之前装过的第三方扩展（热更新）', async () => {
    const registry = new ExtensionRegistry()
    const importModule = async () => ({ default: good('kb.one') })
    await loadInstalledExtensions({ registry, fetch: backend({ enabled: true, extensions: [listed('kb.one')] }), importModule })
    expect(registry.isInstalled('kb.one')).toBe(true)
    const report = await loadInstalledExtensions({ registry, fetch: backend({ enabled: false, extensions: [] }), importModule })
    expect(report).toMatchObject({ enabled: false, loaded: [], removed: ['kb.one'] })
    expect(registry.isInstalled('kb.one')).toBe(false)
  })

  it('4. 非管理员 / 未登录：静默跳过，同样撤掉已装的；读不到清单（网络错误）时不动已装的', async () => {
    const registry = new ExtensionRegistry()
    const importModule = async () => ({ default: good('kb.one') })
    await loadInstalledExtensions({ registry, fetch: backend({ enabled: true, extensions: [listed('kb.one')] }), importModule })

    const flaky = await loadInstalledExtensions({
      registry,
      fetch: async () => {
        throw new TypeError('Failed to fetch')
      },
      importModule,
    })
    expect(flaky.failed[0]).toMatchObject({ id: '(清单)' })
    expect(registry.isInstalled('kb.one')).toBe(true) // 网络抖动不能把扩展卸掉

    const serverError = await loadInstalledExtensions({ registry, fetch: backend(500), importModule })
    expect(serverError.failed[0]!.error).toContain('HTTP 500')
    expect(registry.isInstalled('kb.one')).toBe(true)

    for (const status of [401, 403]) {
      const report = await loadInstalledExtensions({ registry, fetch: backend(status), importModule })
      expect(report).toMatchObject({ forbidden: true, enabled: false, failed: [] })
    }
    expect(registry.isInstalled('kb.one')).toBe(false)
  })

  it('5. 已装且版本相同的不重复加载；版本变了就重新 import 并替换；后端不再提供的被卸载；内置同名被忽略', async () => {
    const registry = new ExtensionRegistry()
    registry.installBuiltin(manifestFor({ id: 'kb.builtin', permissions: [] }), { activate: () => undefined })
    const importModule = vi.fn(async (url: string) => ({ default: good(url.includes('kb.one') ? 'kb.one' : 'kb.two') }))
    const first = { enabled: true, extensions: [listed('kb.one'), listed('kb.two')] }
    await loadInstalledExtensions({ registry, fetch: backend(first), importModule })
    expect(importModule).toHaveBeenCalledTimes(2)

    await loadInstalledExtensions({ registry, fetch: backend(first), importModule })
    expect(importModule).toHaveBeenCalledTimes(2) // 同版本不重复

    const second = { enabled: true, extensions: [listed('kb.one', { version: '1.1.0' }), listed('kb.builtin')] }
    const report = await loadInstalledExtensions({ registry, fetch: backend(second), importModule })
    expect(importModule).toHaveBeenCalledTimes(3)
    expect(importModule).toHaveBeenLastCalledWith(`${EXTENSIONS_API}/kb.one/index.js?v=1.1.0`)
    expect(registry.list().find((item) => item.manifest.id === 'kb.one')!.manifest.version).toBe('1.1.0')
    expect(report.removed).toEqual(['kb.two'])
    expect(report.failed).toEqual([{ id: 'kb.builtin', error: '与内置扩展同名，已忽略' }])
    expect(registry.list().find((item) => item.manifest.id === 'kb.builtin')!.builtin).toBe(true)
  })

  it('6. 内置扩展不会被「后端不再提供」卸载', async () => {
    const registry = new ExtensionRegistry()
    registry.installBuiltin(manifestFor({ id: 'kb.builtin' }), { activate: () => undefined })
    await loadInstalledExtensions({ registry, fetch: backend({ enabled: false, extensions: [] }), importModule: async () => ({}) })
    expect(registry.isInstalled('kb.builtin')).toBe(true)
  })
})
