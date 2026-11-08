/**
 * 第三方扩展加载器：从后端的本地可信目录把扩展装进注册表
 *
 * 流程：取清单列表（只对管理员、且 `[editor] extensions = true` 才有内容）→ 对每个通过校验的清单，
 * 用同源动态 `import` 加载入口脚本 → `registry.install`。
 * 为什么是同源 `import`：站点 CSP 是 `script-src 'self'`，不放宽就只能这样；入口脚本由
 * `GET /api/v1/editor/extensions/{id}/{file}` 下发，Content-Type 是 `text/javascript`。
 *
 * 失败隔离：任何一个扩展的清单坏了、脚本加载失败、`activate` 抛错，都只记进报告，
 * 不影响别的扩展，更不影响编辑器本身（这个模块的函数永远不 reject）。
 */
import type { EditorExtension, ExtensionManifest } from './api'
import { parseManifest } from './manifest'
import type { ExtensionRegistry } from './registry'

/** 清单接口的路径前缀。 */
export const EXTENSIONS_API = '/api/v1/editor/extensions'

export interface LoadFailure {
  /** 扩展 id（清单坏了时是目录名）。 */
  id: string
  error: string
}

export interface LoadReport {
  /** 后端的开关是否打开。 */
  enabled: boolean
  /** 成功安装的扩展 id。 */
  loaded: string[]
  /** 没装上的扩展与原因。 */
  failed: LoadFailure[]
  /** 因为后端不再提供（开关关了、目录被删、不再是管理员）而卸载的扩展 id。 */
  removed: string[]
  /** 没有权限看清单（不是管理员 / 没登录）。 */
  forbidden: boolean
}

export interface LoaderOptions {
  registry: ExtensionRegistry
  /** 注入 fetch（测试用）。 */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
  /** 注入脚本加载（测试用）；缺省同源动态 import。 */
  importModule?: (url: string) => Promise<unknown>
}

interface ListedExtension {
  id?: unknown
  dir?: unknown
  manifest?: unknown
  error?: unknown
}

/**
 * 入口脚本的 URL。带上版本号做缓存键：浏览器的模块表按 URL 缓存，升级版本后要能拿到新代码
 * （同一版本改了代码需要刷新页面，文档里写明）。后端忽略这个查询串。
 */
export function entryUrl(manifest: ExtensionManifest): string {
  return `${EXTENSIONS_API}/${manifest.id}/${manifest.entry}?v=${encodeURIComponent(manifest.version)}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 默认的脚本加载：`@vite-ignore` 是因为地址在运行时才知道，不是打包期能分析的模块。 */
function importSameOrigin(url: string): Promise<unknown> {
  return import(/* @vite-ignore */ url)
}

/** 取出模块的默认导出并确认它是个扩展。 */
function extensionOf(module: unknown): EditorExtension | null {
  const candidate = (module as { default?: unknown } | null)?.default
  if (candidate && typeof (candidate as EditorExtension).activate === 'function') return candidate as EditorExtension
  return null
}

/**
 * 对齐已安装的第三方扩展与后端清单：装上新增的 / 版本变了的，卸载后端不再提供的。
 * 已经装过且版本相同的扩展会跳过（多个编辑器先后挂载时不重复加载）。
 * 永远 resolve：网络错误、解析错误都进 `failed`，并且读不到清单时不会卸载任何东西。
 */
export async function loadInstalledExtensions(options: LoaderOptions): Promise<LoadReport> {
  const report: LoadReport = { enabled: false, loaded: [], failed: [], removed: [], forbidden: false }
  const doFetch = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init))
  const load = options.importModule ?? importSameOrigin

  let listed: ListedExtension[]
  try {
    const response = await doFetch(EXTENSIONS_API, { credentials: 'same-origin', headers: { accept: 'application/json' } })
    if (response.status === 401 || response.status === 403) {
      report.forbidden = true
      // 不再是管理员了：之前装的第三方扩展一并撤掉
      await prune(options.registry, new Set(), report)
      return report
    }
    if (!response.ok) {
      report.failed.push({ id: '(清单)', error: `读取扩展清单失败：HTTP ${response.status}` })
      return report
    }
    const body = (await response.json()) as { data?: { enabled?: unknown; extensions?: unknown } }
    report.enabled = body.data?.enabled === true
    listed = Array.isArray(body.data?.extensions) ? (body.data.extensions as ListedExtension[]) : []
  } catch (error) {
    report.failed.push({ id: '(清单)', error: `读取扩展清单失败：${messageOf(error)}` })
    return report
  }
  if (!report.enabled) {
    await prune(options.registry, new Set(), report)
    return report
  }

  // 后端当前认可的扩展 id（清单没问题的）；其余已安装的第三方扩展要撤掉
  const keep = new Set<string>()
  for (const item of listed) {
    const dir = typeof item.dir === 'string' ? item.dir : String(item.id ?? '?')
    if (typeof item.error === 'string' && item.error) {
      report.failed.push({ id: dir, error: item.error })
      continue
    }
    const parsed = parseManifest(item.manifest)
    if (!parsed.ok) {
      report.failed.push({ id: dir, error: parsed.errors.join('；') })
      continue
    }
    const { manifest } = parsed
    keep.add(manifest.id)
    const existing = options.registry.list().find((installed) => installed.manifest.id === manifest.id)
    if (existing && !existing.builtin && existing.manifest.version === manifest.version) {
      report.loaded.push(manifest.id)
      continue
    }
    if (existing?.builtin) {
      report.failed.push({ id: manifest.id, error: '与内置扩展同名，已忽略' })
      continue
    }
    try {
      const extension = extensionOf(await load(entryUrl(manifest)))
      if (!extension) throw new Error(`${manifest.entry} 没有默认导出带 activate 函数的对象（export default { activate(ctx) { … } }）`)
      await options.registry.install(manifest, extension, { builtin: false })
      report.loaded.push(manifest.id)
    } catch (error) {
      report.failed.push({ id: manifest.id, error: messageOf(error) })
    }
  }
  await prune(options.registry, keep, report)
  return report
}

/** 卸载不在 `keep` 里的第三方扩展（内置扩展永远保留）。 */
async function prune(registry: ExtensionRegistry, keep: Set<string>, report: LoadReport): Promise<void> {
  for (const installed of registry.list()) {
    if (installed.builtin || keep.has(installed.manifest.id)) continue
    if (await registry.uninstall(installed.manifest.id)) report.removed.push(installed.manifest.id)
  }
}
