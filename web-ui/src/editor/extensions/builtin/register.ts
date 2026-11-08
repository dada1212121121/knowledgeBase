/**
 * 内置扩展的公共小工具
 *
 * 内置功能走和第三方完全相同的注册 API（`ctx.registerToolbarItem` 等）：这里只负责把现成的静态数据
 * （`text.ts` 里的 `ToolbarGroup` / `EditorAction` / `SurfaceContribution`）逐项注册进去，不另开后门。
 * 数据形状没变，所以别的分支往这些常量里加新的工具栏组时，不用碰注册代码。
 *
 * 内置扩展与第三方的区别只有三点（`registry.ts` 的不变量 4）：随应用打包、进程内同步启动；
 * 不需要在清单里声明贡献；不受「id 带扩展前缀」的限制（按钮 id、命令名要和快捷键、测试选择器认的原名一致）。
 */
import { EDITOR_API_VERSION, type EditorExtension, type ExtensionContext, type ExtensionManifest, type Permission, type SurfaceKindName } from '../api'
import type { EditorAction, SurfaceContribution, ToolbarGroup } from './text'

/** 内置扩展的清单：贡献清单恒为空（内置扩展不需要声明），入口标成 `builtin`。 */
export function builtinManifest(init: { id: string; name: string; description: string; permissions: readonly Permission[] }): ExtensionManifest {
  return {
    id: init.id,
    name: init.name,
    version: '1.0.0',
    apiVersion: EDITOR_API_VERSION,
    description: init.description,
    entry: 'builtin',
    permissions: init.permissions,
    contributes: { commands: [], toolbar: [], slash: [], panels: [], codecs: [], surfaces: [], aiTools: [] },
  }
}

/** 一个内置扩展：清单 + 入口，给 `registry.installBuiltin` 用。 */
export interface BuiltinExtension {
  manifest: ExtensionManifest
  extension: EditorExtension
}

/** 注册范围：哪些内容面、哪些格式、哪套工具栏方案。 */
export interface GroupScope {
  kinds: readonly SurfaceKindName[]
  formats?: readonly string[]
  profile?: string
}

/** 把工具栏分组里的每个动作注册成工具栏按钮；分组 id 与显示名跟着按钮走，Chrome 按它们重新聚成分组。 */
export function registerToolbarGroups(ctx: ExtensionContext, groups: readonly ToolbarGroup[], scope: GroupScope): void {
  for (const group of groups) {
    for (const action of group.actions) {
      ctx.registerToolbarItem({
        ...action,
        group: group.id,
        groupLabel: group.label,
        kinds: scope.kinds,
        ...(scope.formats === undefined ? {} : { formats: scope.formats }),
        ...(scope.profile === undefined ? {} : { profile: scope.profile }),
      })
    }
  }
}

/** 把斜杠菜单动作注册成斜杠项（斜杠项一定会改文档，所以只读时不出现）。 */
export function registerSlashActions(ctx: ExtensionContext, actions: readonly EditorAction[], kinds: readonly SurfaceKindName[]): void {
  for (const action of actions) {
    ctx.registerSlashItem({
      id: action.id,
      label: action.label,
      command: action.command,
      kinds,
      ...(action.args === undefined ? {} : { args: action.args }),
      ...(action.icon === undefined ? {} : { icon: action.icon }),
      ...(action.keywords === undefined ? {} : { keywords: action.keywords }),
    })
  }
}

/** 注册一整份内容面贡献（工具栏 + 斜杠）；没有贡献（该内容面还没有内置工具栏）就什么也不做。 */
export function registerContribution(ctx: ExtensionContext, contribution: SurfaceContribution | null, scope: GroupScope): void {
  if (!contribution) return
  registerToolbarGroups(ctx, contribution.toolbar, scope)
  registerSlashActions(ctx, contribution.slash, scope.kinds)
}
