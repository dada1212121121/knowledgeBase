/**
 * 内容面注册表（骨架， 起逐个接入）
 *
 * 为什么要注册表而不是在 Host 里写 switch：
 * 1. Host 一旦 `import TextSurface from './surfaces/text/TextSurface.vue'`，ProseMirror 就会进入首屏静态图，
 * 阅读态笔记会被迫付出编辑器内核的下载与解析成本（违背 「笔记首屏 ≤ 500 ms」）。
 * 2. 注册 + 动态 import 后，每种内容面各自成块，只有真正打开该格式才会下载。
 * 3. 也让「某格式还没接入」成为一个可表达的合法状态（返回 null → Host 显示中性提示 + 回退按钮）。
 */
import type { SurfaceKindName } from '../extensions/api'
import type { Surface } from '../types'

/** 内容面加载器：按格式返回工厂；返回 null 表示尚未接入，而不是加载失败 */
export type SurfaceLoader = (format?: string) => Promise<SurfaceFactory | null>

/** 内容面类型：内置 6 类 + 扩展的 `ext:<id>`。内置类型的写法不变。 */
type SurfaceKind = SurfaceKindName

/** 内容面工厂：真正的实例化入口（通常就是 `new XxxSurface(ctx)`；扩展的内容面可以异步创建） */
export type SurfaceFactory = () => Surface | Promise<Surface>

const loaders = new Map<SurfaceKind, SurfaceLoader>()
/**
 * 已经解析过的加载器缓存：避免每次打开都重复 import（module map 虽已缓存，但省一次异步调度）。
 * 必须带 format：同一个 `grid` 有 CSV（单元格矩阵）与 XLSX（引擎帧）两套工厂，
 * 只按 kind 缓存会把先打开的格式粘到后打开的格式上。
 */
const resolved = new Map<string, SurfaceFactory | null>()

function cacheKey(kind: SurfaceKind, format?: string): string {
  return `${kind}:${format?.toLowerCase() ?? ''}`
}

function forgetKind(kind: SurfaceKind): void {
  const prefix = `${kind}:`
  for (const key of resolved.keys()) if (key.startsWith(prefix)) resolved.delete(key)
}

/** 注册某类内容面；重复注册会覆盖（便于测试与灰度替换） */
export function registerSurface(kind: SurfaceKind, loader: SurfaceLoader): void {
  loaders.set(kind, loader)
  forgetKind(kind)
}

/** 注销（主要给测试清理用） */
export function unregisterSurface(kind: SurfaceKind): void {
  loaders.delete(kind)
  forgetKind(kind)
}

/** 该格式是否已接入新编辑器 */
export function hasSurface(kind: SurfaceKind): boolean {
  return loaders.has(kind)
}

/** 已注册的内容面类型清单 */
export function registeredSurfaceKinds(): SurfaceKind[] {
  return [...loaders.keys()]
}

/**
 * 解析并实例化内容面。
 * - 未注册 → null（Host 显示「尚未接入」）
 * - 加载器返回 null → null
 * - 加载失败（chunk 404 / 语法错误）→ 抛错，由 Host 的错误边界接住
 */
export async function loadSurface(kind: SurfaceKind, format?: string): Promise<Surface | null> {
  const key = cacheKey(kind, format)
  let factory: SurfaceFactory | null | undefined = resolved.get(key)
  if (factory === undefined) {
    const loader = loaders.get(kind)
    if (!loader) return null
    factory = await loader(format)
    resolved.set(key, factory ?? null)
  }
  if (!factory) return null
  return factory()
}

/**
 * 生成 EditorHost 需要的 `loadSurface` 回调，同时把「未注册」提前判掉，
 * 避免每次打开都走一次无意义的动态 import 失败路径。
 */
export function createSurfaceLoader(): (kind: SurfaceKind, format?: string) => Promise<Surface | null> {
  return (kind, format) => loadSurface(kind, format)
}

/** 仅供测试：清空全部注册 */
export function resetSurfaceRegistry(): void {
  loaders.clear()
  resolved.clear()
}
