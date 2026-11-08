// 导航清单:侧栏、手机「我的」页共用同一份,分「我的」「管理」两组,按功能表过滤
// (没有权限的入口不出现;后端对每个能力照样检查,隐藏只是体验)。只是数据与规则,不依赖组件,方便单测。
import type { RouteLocationNormalizedLoaded } from 'vue-router'
import type { IconName } from '@kb-ui/index'
import { PATHS, TAB_PAGES } from '@/router/paths'
import type { NavEntry, NavGroup } from './types'

export interface NavContext {
  /** 功能点判断(来自 session store 的 has) */
  has: (feature: string | undefined) => boolean
  /** 当前路由 */
  route: Pick<RouteLocationNormalizedLoaded, 'path' | 'meta'>
  counts: { items: number; sources: number | null; drafts: number; jobs: number }
}

/** 12438 → 12.4k;小于 1000 原样。 */
export function compact(value: number): string {
  if (!value) return ''
  if (value < 1000) return String(value)
  return `${(value / 1000).toFixed(1)}k`
}

/** 当前页在导航里属于哪个入口:路由 meta.group 优先(导入记录归「导入」),否则按路径前缀。 */
export function isActivePath(route: NavContext['route'], to: string): boolean {
  const group = route.meta.group as string | undefined
  if (group) return group === to
  return route.path === to || route.path.startsWith(`${to}/`)
}

interface RawItem {
  id: string
  path: string
  icon: IconName
  label: string
  /** 需要的功能点;账号没开通 / AI 被关掉时入口不显示 */
  feature?: string
  count?: number
  text?: string
}

function toEntries(ctx: NavContext, raw: RawItem[]): NavEntry[] {
  return raw
    .filter((item) => ctx.has(item.feature))
    .map(({ feature: _feature, path, ...entry }) => ({ ...entry, to: path, active: isActivePath(ctx.route, path) }))
}

export function buildNavGroups(ctx: NavContext): NavGroup[] {
  const mine = toEntries(ctx, [
    { id: 'home', path: PATHS.home, icon: 'home', label: '首页' },
    { id: 'kb', path: PATHS.kb, icon: 'book', label: '知识库', text: compact(ctx.counts.items) },
    { id: 'search', path: PATHS.search, icon: 'search', label: '搜索', feature: 'search.basic' },
    { id: 'shares', path: PATHS.shares, icon: 'share', label: '我的分享', feature: 'collab.share' },
    { id: 'trash', path: PATHS.trash, icon: 'trash', label: '回收站' },
    { id: 'review', path: PATHS.review, icon: 'inbox', label: '审核收件箱', count: ctx.counts.drafts, feature: 'ai.extract' },
    { id: 'import', path: PATHS.import, icon: 'upload', label: '导入', text: ctx.counts.sources ? String(ctx.counts.sources) : '', feature: 'docs.upload' },
    { id: 'tasks', path: PATHS.tasks, icon: 'list', label: '任务', count: ctx.counts.jobs },
    { id: 'friends', path: PATHS.friends, icon: 'users', label: '好友', feature: 'collab.friends' },
    { id: 'assistant', path: PATHS.assistant, icon: 'sparkles', label: 'AI 助手', feature: 'ai.assistant' },
  ])
  const admin = toEntries(ctx, [
    { id: 'overview', path: PATHS.overview, icon: 'pulse', label: '系统概览', feature: 'sys.ops' },
    { id: 'users', path: PATHS.users, icon: 'shield', label: '用户与权限', feature: 'sys.users' },
    { id: 'params', path: PATHS.params, icon: 'sliders', label: '系统参数', feature: 'sys.settings' },
    { id: 'usage', path: PATHS.usage, icon: 'database', label: '存储与用量', feature: 'sys.ops' },
    { id: 'projects', path: PATHS.projects, icon: 'folder', label: '项目与集合', feature: 'sources.local' },
    { id: 'system', path: PATHS.system, icon: 'server', label: '系统状态', feature: 'sys.ops' },
    { id: 'audit', path: PATHS.audit, icon: 'doc', label: '审计 / 批次', feature: 'sys.ops' },
    { id: 'eval', path: PATHS.eval, icon: 'chart', label: '评测', feature: 'search.tune' },
    { id: 'settings', path: PATHS.settings, icon: 'settings', label: '系统设置', feature: 'sys.settings' },
  ])
  const groups: NavGroup[] = [{ id: 'mine', label: '我的', items: mine }]
  // 管理组一个入口都没有(普通用户)时整组不出现,连标题都没有
  if (admin.length) groups.push({ id: 'admin', label: '管理', items: admin, collapsible: true })
  return groups
}

/**
 * 哪些分组此刻是收起的(侧栏渲染用,纯函数方便单测)。
 *
 * - 用户手动点过就听用户的:`userCollapsed` 里有的收起,没有的展开(空数组 = 用户手动展开过);
 * - 没点过(`null`)时看整列放不放得下:放不下就收起可折叠的分组;放得下就展开——
 *   默认就藏起入口会让人以为功能没了,只有真的挤不下(平板横屏 / 矮窗口)才收;
 * - 当前页在某个组里时,那一组永远展开:否则你正看着的那一页在导航里消失,连高亮都看不到。
 */
export function collapsedGroups(options: {
  groups: NavGroup[]
  userCollapsed: readonly string[] | null
  autoCollapsed: readonly string[]
}): string[] {
  const out: string[] = []
  for (const group of options.groups) {
    if (!group.collapsible) continue
    if (group.items.some((item) => item.active)) continue
    const collapsed = options.userCollapsed ? options.userCollapsed.includes(group.id) : options.autoCollapsed.includes(group.id)
    if (collapsed) out.push(group.id)
  }
  return out
}

/** 手机顶栏左上角的返回目标:标签栏里的页面没有;嵌套页面回父页(meta.parent);其余回「我的」。 */
export function phoneBackTarget(route: Pick<RouteLocationNormalizedLoaded, 'path' | 'meta'>): string | null {
  if (TAB_PAGES.includes(route.path)) return null
  const parent = route.meta.parent
  if (parent) return parent
  return PATHS.mine
}
