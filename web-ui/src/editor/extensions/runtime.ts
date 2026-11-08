/**
 * 扩展运行时：页面里唯一的注册表实例，以及它的启动流程
 *
 * 为什么是模块级单例：扩展是「整个页面」的东西，不属于某个 EditorHost 实例——
 * 同时打开两个编辑器时它们共享同一批扩展，各自通过 `attachHost` 绑定自己的文档。
 * 测试里用 `resetExtensionRuntime` 复位，避免用例之间串状态。
 */
import { subscribeLive } from '@/composables/useLiveEvents'
import { readConfigEvent } from '@/utils/configEvents'
import { useConfirm } from '@kb-ui/components/useConfirm'
import { useToast } from '@kb-ui/components/useToast'
import { getActivePinia } from 'pinia'
import { useSessionStore } from '@/stores/session'
import { installBuiltinExtensions } from './builtin'
import { loadInstalledExtensions, type LoadReport } from './loader'
import { ExtensionRegistry } from './registry'
import type { ExtensionManifest } from './api'

let registry: ExtensionRegistry | null = null

/** 第三方扩展第一次写文档时的确认：沿用全站的确认弹窗，把「会改什么」讲清楚。 */
export function confirmExtensionWrite(manifest: ExtensionManifest): Promise<boolean> {
  return useConfirm().ask({
    title: `允许「${manifest.name}」修改文档？`,
    message: `扩展「${manifest.name}」（${manifest.id} ${manifest.version}）想修改你正在编辑的文档。只有信任这个扩展时才允许；修改会像你自己输入一样进入撤销历史和版本记录。`,
    confirmText: '允许修改',
    cancelText: '不允许',
    tone: 'danger',
  })
}

/** 扩展出的问题（命令失败、写权限被拒……）用全站的 toast 告诉用户，不打断编辑。 */
export function notifyExtensionProblem(message: string): void {
  useToast().push(message, 'danger')
}

/**
 * 要不要向后端请求扩展清单：清单接口只对管理员开放，普通用户请求只会得到 403。
 * 已知没有「系统参数」功能点就不请求；还不知道（会话没加载完）或没有 Pinia（独立挂载 / 测试）时照常请求，
 * 后端仍然是最终的把关者，这里只是省一次必然失败的请求。
 */
export function defaultExtensionGate(): boolean {
  if (!getActivePinia()) return true
  return useSessionStore().has('sys.settings')
}

/** 页面里的注册表（首次调用时创建，并装上全部内置扩展）。 */
export function getExtensionRegistry(): ExtensionRegistry {
  if (!registry) {
    registry = new ExtensionRegistry({
      confirmWrite: confirmExtensionWrite,
      notify: (message, tone) => useToast().push(message, tone),
    })
    // 内置功能（各内容面的工具栏、导出 / 评论 / AI、字数…）和第三方扩展走同一套注册表
    installBuiltinExtensions(registry)
  }
  return registry
}

/** 仅供测试：丢掉当前注册表，下次 `getExtensionRegistry` 重新创建。 */
export function resetExtensionRuntime(): void {
  registry = null
  loading = null
  lastReport = null
  stopWatching?.()
  stopWatching = null
  watchers = 0
}

// ---------------------------------------------------------------- 第三方扩展的加载

let loading: Promise<LoadReport> | null = null
let lastReport: LoadReport | null = null

/**
 * 确保本页面已经向后端请求过扩展清单并装好扩展（每个页面只做一次，多个编辑器共享结果）。
 * 没有权限（非管理员）不算失败，也不会重复请求；网络出错会在下一次调用时重试。
 * `allowed` 让调用方在明知没权限时连请求都省掉（普通用户不必每次打开编辑器都吃一个 403）。
 */
export async function ensureExtensionsLoaded(allowed: () => boolean = () => true): Promise<LoadReport> {
  // 让出一拍再判断权限：调用方通常在组件的 onMounted 里，那时 Pinia 会走 Vue 的注入上下文并在没装 Pinia 的场景报警；
  // 让出之后读到的是全局的活动 Pinia，行为一致且没有警告
  await Promise.resolve()
  if (!allowed()) return { enabled: false, loaded: [], failed: [], removed: [], forbidden: true }
  if (!loading) {
    loading = loadInstalledExtensions({ registry: getExtensionRegistry() }).then((report) => {
      lastReport = report
      // 清单本身读不到多半是网络抖动（下次再试），不吵；具体某个扩展加载失败要让管理员在控制台看到
      for (const failure of report.failed) if (failure.id !== '(清单)') console.warn(`编辑器扩展 ${failure.id} 未能加载：${failure.error}`)
      // 暂时性失败（网络）允许下次重试；有结论的（含「没权限」「开关关着」）不再请求
      if (report.failed.some((failure) => failure.id === '(清单)')) loading = null
      return report
    })
  }
  return loading
}

/** 最近一次加载的结果（设置页 / 诊断用）。 */
export function lastExtensionLoadReport(): LoadReport | null {
  return lastReport
}

// ---------------------------------------------------------------- 配置热更新时对齐扩展

/**
 * `[editor] extensions` / `extensions_dir` 是热更新项（后端每个请求现读），前端也要跟上：
 * 管理员关掉开关后，已经装进页面的第三方扩展要立刻撤掉，而不是等到刷新页面。
 * 守护进程重载配置后推 `config.changed`（`hot` 里列出变了的键），命中 `editor.*` 就重新对齐一次。
 */
export async function resyncExtensions(): Promise<LoadReport> {
  const report = await loadInstalledExtensions({ registry: getExtensionRegistry() })
  lastReport = report
  return report
}

let watchers = 0
let stopWatching: (() => void) | null = null

/** 每个编辑器挂载时调用，卸载时调用返回的函数；全站只保留一个订阅（引用计数）。 */
export function watchExtensionConfig(): () => void {
  watchers += 1
  if (watchers === 1) {
    stopWatching = subscribeLive((event) => {
      if (event.type !== 'config.changed') return
      const notice = readConfigEvent(event.type, event.data)
      if (notice?.kind === 'changed' && notice.hot.some((key) => key.startsWith('editor.'))) void resyncExtensions()
    })
  }
  let released = false
  return () => {
    if (released) return
    released = true
    watchers -= 1
    if (watchers === 0) {
      stopWatching?.()
      stopWatching = null
    }
  }
}
