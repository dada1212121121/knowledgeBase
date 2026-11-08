/**
 * 注册表里的贡献 → Chrome 认识的数据形状（设计规范）
 *
 * Host 以前直接把 `contributionFor(kind)` 交给 Chrome。 把内置工具栏也迁进了注册表
 * （`extensions/builtin/*.ext.ts`），所以现在工具栏 / 斜杠菜单 / 顶栏操作区的按钮 / 状态栏项
 * 全部从注册表取，内置和第三方走同一条路；这里负责把注册表里的条目翻译成 Chrome 认识的 `EditorAction` / 分组。
 * 合并是纯函数：输入注册表快照，输出新对象，不改任何一边。
 */
import type { HostCapability, SurfaceKindName, ToolbarActionSpec } from './api'
import type { EditorAction, SurfaceContribution } from './builtin/text'
import type { AIToolInfo, ExtensionRegistry, SlashEntry, ToolbarEntry, ToolbarScope } from './registry'

/** Chrome 渲染的一个工具栏分组（`id` 放宽成 string：扩展可以自带分组）。 */
export interface MergedGroup {
  id: string
  label: string
  actions: EditorAction[]
}

/** Chrome 认识的贡献：`SurfaceContribution` 的超集。 */
export interface MergedContribution {
  kind: SurfaceKindName
  toolbar: readonly MergedGroup[]
  slash: readonly EditorAction[]
}

/** 内置分组的显示名；扩展指定了不在其中的分组 id 时用 `groupLabel`，再不行用 id 本身。 */
const GROUP_LABELS: Readonly<Record<string, string>> = {
  blocks: '段落',
  marks: '格式',
  lists: '列表',
  insert: '插入',
  view: '视图',
  ext: '扩展',
}

/** 只决定「按钮放哪、什么时候显示」的字段：属于注册范围，不是动作本身，翻译成 `EditorAction` 时丢掉。 */
const SCOPE_KEYS: ReadonlySet<string> = new Set(['group', 'groupLabel', 'kinds', 'formats', 'profile', 'placement', 'capability'])

/**
 * 按钮声明 → Chrome 的动作声明：去掉范围字段、去掉 `undefined`，下拉的子项递归翻译。
 * 其余字段一律原样带过去（不逐个点名）：别的分支往 `EditorAction` 里加新的可选字段时，
 * 只要把它写进 `ToolbarActionSpec`，这里不用改也不会丢。
 * 工具栏按钮、顶栏操作区的按钮、下拉子项都走它，所以一个动作在哪种位置出现，数据形状都一样。
 */
export function actionOf(spec: ToolbarActionSpec): EditorAction {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(spec)) {
    if (value === undefined || SCOPE_KEYS.has(key)) continue
    out[key] = key === 'children' ? (value as readonly ToolbarActionSpec[]).map(actionOf) : value
  }
  return out as unknown as EditorAction
}

/** 工具栏条目 → Chrome 的动作声明。 */
export function toolbarAction(entry: ToolbarEntry): EditorAction {
  return actionOf(entry.spec)
}

/** 斜杠条目 → 动作声明。斜杠菜单里的项一定会改文档，统一标 write，只读时不出现。 */
export function slashAction(entry: SlashEntry): EditorAction {
  const { spec } = entry
  return {
    id: spec.id,
    label: spec.label,
    command: spec.command,
    write: true,
    ...(spec.args === undefined ? {} : { args: spec.args }),
    ...(spec.icon === undefined ? {} : { icon: spec.icon }),
    ...(spec.keywords === undefined ? {} : { keywords: [...spec.keywords] }),
  }
}

/** 合并某类内容面的斜杠菜单动作（内容面创建时和每次菜单刷新时调用）。 */
export function mergeSlashActions(base: readonly EditorAction[], kind: SurfaceKindName, registry: ExtensionRegistry): readonly EditorAction[] {
  const extra = registry.slashItemsFor(kind).map(slashAction)
  if (extra.length === 0) return base
  const taken = new Set(base.map((action) => action.id))
  return [...base, ...extra.filter((action) => !taken.has(action.id))]
}

/**
 * 合并工具栏与斜杠菜单。没有任何贡献时返回 null（Chrome 只显示通用按钮）。
 * `base` 是调用方显式给的静态贡献（页面自己指定的工具栏、单测），缺省没有；其余全部来自注册表。
 * 按钮放进它声明的分组：分组已存在就追加在末尾，不存在就新建在最后（缺省分组 `ext`）。
 */
export function mergeContribution(
  base: SurfaceContribution | null,
  kind: SurfaceKindName,
  registry: ExtensionRegistry,
  scope: ToolbarScope = {},
): MergedContribution | null {
  const items = registry.toolbarItemsFor(kind, scope)
  const slash = mergeSlashActions(base?.slash ?? [], kind, registry)
  if (!base && items.length === 0 && slash.length === 0) return null
  const groups: MergedGroup[] = (base?.toolbar ?? []).map((group) => ({ id: group.id, label: group.label, actions: [...group.actions] }))
  for (const item of items) {
    const groupId = item.spec.group ?? 'ext'
    let group = groups.find((candidate) => candidate.id === groupId)
    if (!group) {
      group = { id: groupId, label: item.spec.groupLabel ?? GROUP_LABELS[groupId] ?? groupId, actions: [] }
      groups.push(group)
    }
    // 同 id 的动作只留第一个：先注册的（内置）优先，扩展不能靠重名顶掉内置按钮
    if (!groups.some((candidate) => candidate.actions.some((action) => action.id === item.spec.id))) group.actions.push(toolbarAction(item))
  }
  return { kind, toolbar: groups, slash }
}

/**
 * 取某类内容面的完整贡献（全部来自注册表：内置扩展 + 第三方扩展）。
 * `format` 决定格式相关的按钮（CSV 的行操作），`profile` 决定页面选的工具栏方案（Word 画布编辑）。
 */
export function contributionWith(kind: SurfaceKindName, registry: ExtensionRegistry, format?: string, profile?: string): MergedContribution | null {
  return mergeContribution(null, kind, registry, { ...(format === undefined ? {} : { format }), ...(profile === undefined ? {} : { profile }) })
}

/** 宿主页面接入了哪些能力（导出 / 评论 / AI）。 */
export type CapabilityFlags = Readonly<Partial<Record<HostCapability, boolean>>>

/**
 * 顶栏操作区的按钮（导出、评论…）：注册表里 `placement: 'bar'` 的条目，去掉页面没接入能力的。
 * 下拉里的 AI 菜单不在这里，它是 AI 工具（见 `visibleAiTools`）。
 */
export function barActionsFor(kind: SurfaceKindName, registry: ExtensionRegistry, capabilities: CapabilityFlags, scope: ToolbarScope = {}): EditorAction[] {
  return registry
    .barItemsFor(kind, scope)
    .filter((entry) => entry.spec.capability === undefined || capabilities[entry.spec.capability] === true)
    .map(toolbarAction)
}

/**
 * AI 菜单里该出现的工具。内置的润色 / 总结 / 翻译由宿主页面接管结果（`target: 'page'`），页面接入了 AI 能力才有；
 * 第三方扩展的工具以「建议」交付，文档有 AI 权限才有（和命令总线对 AI 来源命令的闸门一致）。
 */
export function visibleAiTools(registry: ExtensionRegistry, gates: { page: boolean; suggestion: boolean }): AIToolInfo[] {
  return registry.aiTools().filter((tool) => (tool.target === 'page' ? gates.page : gates.suggestion))
}
