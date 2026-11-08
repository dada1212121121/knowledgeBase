/**
 * 内置「视图」动作：作为第一个通过扩展注册表注册的内置贡献（证明）
 *
 * 文本面工具栏里的「查找替换」「大纲」以前写死在 `TEXT_TOOLBAR` 的 view 分组里。
 * 现在它们由这个内置扩展经 `registerToolbarItem` 注册：走的是和第三方扩展同一套注册表，
 * 但内置扩展随应用打包、进程内运行，不需要在清单里声明贡献，也不受 id 前缀限制
 * （按钮 id 与命令名必须保持原样，快捷键、测试选择器和 Chrome 里的 UI 类动作分发都认这些名字）。
 * 其余内置贡献（其它内容面的工具栏、导出 / 评论 / AI、字数）在 里照这个做法迁成了 `builtin/*.ext.ts`，
 * 汇总在 `builtin/index.ts`。这里只管文本面的视图类按钮；它必须在 `text.ext.ts` 之后安装（「视图」分组排最后）。
 */
import { defineExtension } from '../../api'
import type { ExtensionManifest } from '../api'
import { EDITOR_API_VERSION } from '../api'

export const BUILTIN_VIEW_ID = 'kb.builtin.view'

export const BUILTIN_VIEW_MANIFEST: ExtensionManifest = {
  id: BUILTIN_VIEW_ID,
  name: '视图动作',
  version: '1.0.0',
  apiVersion: EDITOR_API_VERSION,
  description: '文本面的查找替换、源码开关与大纲',
  entry: 'builtin',
  permissions: ['ui'],
  contributes: { commands: [], toolbar: [], slash: [], panels: [], codecs: [], surfaces: [], aiTools: [] },
}

export const BUILTIN_VIEW_EXTENSION = defineExtension({
  activate(ctx) {
    // `ui: true` 的命令（search.open / view.toggleOutline）由 Chrome 自己处理，不会发给内容面
    ctx.registerToolbarItem({
      id: 'find',
      label: '查找替换',
      icon: '🔍',
      command: 'search.open',
      shortcut: 'Ctrl+F',
      group: 'view',
      groupLabel: '视图',
      kinds: ['text'],
      ui: true,
    })
    // 在所见即所得与 Markdown 源码之间切换（旧编辑器工具栏最右边的「源码」）；是内容面命令，不是 UI 类动作
    ctx.registerToolbarItem({
      id: 'source',
      label: '源码',
      icon: '</>',
      command: 'view.toggleSource',
      group: 'view',
      groupLabel: '视图',
      kinds: ['text'],
      write: true,
      check: { kind: 'toggle', name: 'source' },
    })
    ctx.registerToolbarItem({
      id: 'outline',
      label: '大纲',
      icon: '☰',
      command: 'view.toggleOutline',
      group: 'view',
      groupLabel: '视图',
      kinds: ['text'],
      ui: true,
    })
  },
})
