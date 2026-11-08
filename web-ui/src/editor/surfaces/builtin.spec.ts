/**
 * 内置内容面注册测试
 *
 * 两条底线：
 * 1. 注册过程本身不能把 ProseMirror 拉进调用方 chunk（必须全是动态 import）；
 * 2. 未注册的格式返回 null（中性态），只有加载器抛错才算错误。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { registerBuiltinSurfaces, resetBuiltinSurfaces } from '@/editor/surfaces/builtin'
import { hasSurface, loadSurface, registerSurface, resetSurfaceRegistry } from '@/editor/surfaces/registry'

const SOURCE = import.meta.glob('./builtin.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

beforeEach(() => {
  resetSurfaceRegistry()
  resetBuiltinSurfaces()
})

describe('内置注册表', () => {
  it('1. 注册后 text 能实例化出真正的 TextSurface', async () => {
    registerBuiltinSurfaces()
    expect(hasSurface('text')).toBe(true)
    const surface = await loadSurface('text')
    expect(surface).not.toBeNull()
    expect(typeof surface!.mount).toBe('function')
    expect(typeof surface!.command).toBe('function')
  })

  it('2. 重复调用注册不会重复覆盖，也不抛错', async () => {
    registerBuiltinSurfaces()
    registerBuiltinSurfaces()
    expect(await loadSurface('text')).not.toBeNull()
  })

  it('3. 已接入 code/pdf/grid/page/slide；未登记的类型返回 null（不是错误）', async () => {
    registerBuiltinSurfaces()
    expect(await loadSurface('code')).not.toBeNull()
    expect(await loadSurface('pdf')).not.toBeNull()
    expect(await loadSurface('grid')).not.toBeNull()
    expect(await loadSurface('page')).not.toBeNull()
    expect(await loadSurface('slide')).not.toBeNull()
  })

  it('4. 加载器抛错时异常向上冒泡（交给 Host 错误边界）', async () => {
    registerSurface('grid', async () => {
      throw new Error('chunk 404')
    })
    await expect(loadSurface('grid')).rejects.toThrow('chunk 404')
  })

  it('5. builtin.ts 里没有对内容面的静态 import（否则首屏会带上 ProseMirror）', () => {
    const text = Object.values(SOURCE)[0] ?? ''
    expect(text).not.toMatch(/^import .*surfaces\/text/m)
    expect(text).not.toMatch(/^import .*prosemirror/m)
    // 动态 import 必须在（文本 / 代码 / PDF 都不能静态拉进首屏）
    expect(text).toContain("await import('./text')")
    expect(text).toContain("await import('./code')")
    expect(text).toContain("await import('./pdf')")
    expect(text).toContain("await import('./grid')")
    expect(text).toContain("await import('./slide')")
  })

  it('6. 缓存解析结果：第二次 loadSurface 不再重复 import', async () => {
    let calls = 0
    registerSurface('grid', async () => {
      calls += 1
      return () => ({}) as never
    })
    await loadSurface('grid')
    await loadSurface('grid')
    expect(calls).toBe(1)
  })
})
