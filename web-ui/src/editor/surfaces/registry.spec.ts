import { describe, expect, it, vi } from 'vitest'
import {
  createSurfaceLoader,
  hasSurface,
  loadSurface,
  registerSurface,
  registeredSurfaceKinds,
  resetSurfaceRegistry,
  unregisterSurface,
} from './registry'
import type { Surface, SurfaceKind } from '../types'

/** 造一个只关心 register/load 行为的最小 Surface */
function stubSurface(): Surface {
  return {
    mount: async () => undefined,
    unmount: () => undefined,
    resize: () => undefined,
    focus: () => undefined,
    setReadonly: () => undefined,
    command: async () => ({ ok: true }),
    query: async () => null,
    capture: () => ({ kind: 'text' }),
    restore: () => undefined,
  }
}

describe('内容面注册表：懒加载 + 未接入可表达', () => {
  it('61. 未注册的格式返回 null（不是抛错），Host 才能显示中性提示', async () => {
    resetSurfaceRegistry()
    expect(hasSurface('grid')).toBe(false)
    await expect(loadSurface('grid')).resolves.toBeNull()
  })

  it('62. 注册后可以解析出实例，且只真正调用一次加载器', async () => {
    resetSurfaceRegistry()
    const loader = vi.fn(async () => () => stubSurface())
    registerSurface('text', loader)

    const first = await loadSurface('text')
    const second = await loadSurface('text')
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(loader).toHaveBeenCalledTimes(1)
    expect(registeredSurfaceKinds()).toEqual(['text'])
  })

  it('63. 加载器返回 null 时按「尚未接入」处理并缓存', async () => {
    resetSurfaceRegistry()
    const loader = vi.fn(async () => null)
    registerSurface('pdf', loader)
    expect(await loadSurface('pdf')).toBeNull()
    expect(await loadSurface('pdf')).toBeNull()
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('64. 加载器抛错时把错误交给调用方（由 Host 错误边界接住）', async () => {
    resetSurfaceRegistry()
    registerSurface('slide', async () => {
      throw new Error('chunk 加载失败')
    })
    await expect(loadSurface('slide')).rejects.toThrow('chunk 加载失败')
  })

  it('65. 重新注册会覆盖旧实现并清掉缓存（灰度替换 / 测试隔离依赖这一点）', async () => {
    resetSurfaceRegistry()
    const oldLoader = vi.fn(async () => () => stubSurface())
    const newLoader = vi.fn(async () => () => stubSurface())
    registerSurface('code', oldLoader)
    await loadSurface('code')
    registerSurface('code', newLoader)
    await loadSurface('code')
    expect(newLoader).toHaveBeenCalledTimes(1)
    expect(oldLoader).toHaveBeenCalledTimes(1)
  })

  it('66. 同一 kind 的不同 format 各自缓存（CSV 与 XLSX 不能互相粘住）', async () => {
    resetSurfaceRegistry()
    const loader = vi.fn(async (format?: string) => () => stubSurface())
    registerSurface('grid', loader)
    await loadSurface('grid', 'csv')
    await loadSurface('grid', 'xlsx')
    await loadSurface('grid', 'csv')
    await loadSurface('grid', 'XLSX')
    expect(loader).toHaveBeenCalledTimes(2)
    expect(loader).toHaveBeenNthCalledWith(1, 'csv')
    expect(loader).toHaveBeenNthCalledWith(2, 'xlsx')
  })

  it('67. unregister 后回到「未接入」；createSurfaceLoader 与 loadSurface 行为一致', async () => {
    resetSurfaceRegistry()
    registerSurface('page', async () => () => stubSurface())
    const loader = createSurfaceLoader()
    expect(await loader('page')).not.toBeNull()
    unregisterSurface('page')
    expect(await loader('page')).toBeNull()
    expect(await loadSurface('page' as SurfaceKind)).toBeNull()
  })
})
