/**
 * 内置扩展：分页文档（Word，page 面）的工具栏
 *
 * 同一个内容面有两套工具栏：只读预览（查找 + 大纲）和画布编辑（文字 / 段落 / 列表 / 插入 / 表格 / 视图）。
 * 以前由页面把整份 `PAGE_EDIT_CONTRIBUTION` 当作 `contribution` 传给 Host 来覆盖；现在两套都注册在这里，
 * 用工具栏方案区分（预览是缺省的 `default`，编辑是 `edit`），页面只要告诉 Host 用哪套（`toolbarProfile="edit"`）。
 * 编辑方案的数据取自 `PAGE_EDIT_CONTRIBUTION`（OfficeEditor 以前传的那一份），所以以后往里加新的工具栏组会自动生效。
 */
import { defineExtension } from '../../api'
import { builtinManifest, registerToolbarGroups, type BuiltinExtension } from './register'
import { PAGE_EDIT_CONTRIBUTION, PAGE_TOOLBAR, type EditorAction, type ToolbarGroup } from './text'

export const BUILTIN_PAGE_ID = 'kb.builtin.page'

/** Word 画布编辑的工具栏方案名（`EditorHost` 的 `toolbarProfile`）。 */
export const PAGE_EDIT_PROFILE = 'edit'

/**
 * 页缩略图栏开关（补全）：只读预览与画布编辑都有。命令由内容面执行（`view.toggleThumbs`），
 * 不是 UI 类动作；按钮高亮来自内容面上报的开关 `thumbs`。不标 `write`，所以只读文档里也显示、也能点。
 */
export const PAGE_THUMBS_ACTION: EditorAction = {
  id: 'page.thumbs',
  label: '缩略图',
  icon: '▤',
  command: 'view.toggleThumbs',
  description: '显示 / 隐藏页面缩略图',
  check: { kind: 'toggle', name: 'thumbs' },
  keywords: ['thumbnail', 'thumbs', '缩略图', '页面', '导航'],
}

/**
 * 高保真查看（补全）：只读预览上的入口，用画布引擎只读打开同一份文档（版式与 Word 一致），
 * 再点一次回到轻预览。只在只读预览方案里出现——画布编辑本来就是高保真。
 * 不标 `write`：它不改文档，也不占编辑权、不进协同、不出现保存（见 `PageSurface`）。
 */
export const PAGE_HIFI_ACTION: EditorAction = {
  id: 'page.hifi',
  label: '高保真查看',
  command: 'view.hifi',
  description: '用 Word 排版引擎只读查看，版式与 Word 一致（不能编辑）；再点一次回到轻预览',
  check: { kind: 'toggle', name: 'hifi' },
  keywords: ['hifi', 'fidelity', '高保真', '版式', 'canvas'],
}

/** 只读预览（默认方案）在「视图」分组里额外的两个按钮：缩略图、高保真查看。 */
export const PAGE_READ_VIEW_EXTRA: readonly ToolbarGroup[] = [{ id: 'view', label: '视图', actions: [PAGE_THUMBS_ACTION, PAGE_HIFI_ACTION] }]
/** 画布编辑方案在「视图」分组里额外的按钮：缩略图。 */
export const PAGE_EDIT_VIEW_EXTRA: readonly ToolbarGroup[] = [{ id: 'view', label: '视图', actions: [PAGE_THUMBS_ACTION] }]

export const BUILTIN_PAGE: BuiltinExtension = {
  manifest: builtinManifest({ id: BUILTIN_PAGE_ID, name: 'Word 工具栏', description: 'Word 只读预览的查找 / 大纲 / 缩略图 / 高保真查看，以及画布编辑的格式 / 表格 / 插入 / 缩略图工具栏', permissions: ['ui'] }),
  extension: defineExtension({
    activate(ctx) {
      registerToolbarGroups(ctx, PAGE_TOOLBAR, { kinds: ['page'], profile: 'default' })
      registerToolbarGroups(ctx, PAGE_READ_VIEW_EXTRA, { kinds: ['page'], profile: 'default' })
      registerToolbarGroups(ctx, PAGE_EDIT_CONTRIBUTION.toolbar, { kinds: ['page'], profile: PAGE_EDIT_PROFILE })
      registerToolbarGroups(ctx, PAGE_EDIT_VIEW_EXTRA, { kinds: ['page'], profile: PAGE_EDIT_PROFILE })
    },
  }),
}
