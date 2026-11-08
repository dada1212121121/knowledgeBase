// 旧地址 → 新地址的重定向表(.4 路由重组)。
//
// 为什么要留:书签、邮件和通知里已经发出去的链接、AI 助手历史对话里的引用、
// 其它页面还没改完的硬编码地址,都还指着旧地址。重定向一律保留 query 和 hash
// (例如 /browser?collection=x&item=y 要原样落到 /kb?collection=x&item=y),并用 replace,
// 不在历史里留下旧地址,免得「返回」又被弹回去。
import type { LocationQuery, RouteRecordRaw } from 'vue-router'
import { PATHS, importBatch, importFile } from './paths'

/** 重定向函数看到的「当前要去的位置」(只用到这几项,不依赖 vue-router 的完整类型,方便测试)。 */
export interface RedirectFrom {
  params: Record<string, string | string[]>
  query: LocationQuery
  hash: string
}

/** 目标地址 + 原样带上 query / hash。 */
const keep =
  (path: string | ((to: RedirectFrom) => string)) =>
  (to: RedirectFrom) => ({
    path: typeof path === 'function' ? path(to) : path,
    query: to.query,
    hash: to.hash,
  })

/** 旧地址表:[旧路径模式, 新地址]。导出给测试逐条验证。 */
export const LEGACY_REDIRECTS: { from: string; to: string | ((to: RedirectFrom) => string) }[] = [
  { from: '/', to: PATHS.home },
  { from: '/dashboard', to: PATHS.overview },
  { from: '/browser', to: PATHS.kb },
  { from: '/sources', to: PATHS.import },
  { from: '/ingest', to: PATHS.importQueue },
  { from: '/ingest/file/:id', to: (to) => importFile(String(to.params.id)) },
  { from: '/ingest/:batch', to: (to) => importBatch(String(to.params.batch)) },
  { from: '/jobs', to: PATHS.tasks },
  { from: '/agent', to: PATHS.assistant },
  { from: '/audit', to: PATHS.audit },
  { from: '/eval', to: PATHS.eval },
  { from: '/projects', to: PATHS.projects },
  { from: '/system', to: PATHS.system },
  { from: '/params', to: PATHS.params },
  { from: '/users', to: PATHS.users },
  { from: '/settings/appearance', to: PATHS.appearance },
]

export const legacyRoutes: RouteRecordRaw[] = [
  ...LEGACY_REDIRECTS.map(({ from, to }) => ({ path: from, redirect: keep(to) })),
  // 旧的 /settings?tab=appearance 是外观页(外观早就不是设置里的一个页签),其余页签留在系统设置
  {
    path: '/settings',
    redirect: (to: RedirectFrom) =>
      to.query.tab === 'appearance' ? { path: PATHS.appearance, query: {}, hash: to.hash } : { path: PATHS.settings, query: to.query, hash: to.hash },
  },
]
