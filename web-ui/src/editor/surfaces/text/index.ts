/**
 * Text Surface 出口
 *
 * 只导出工厂与类型：schema / 插件的内部实现不对外，避免上层绕过 CommandBus 直接改文档。
 */
export { TextSurface, type TextSurfaceOptions, type TextOutlineItem } from './TextSurface'
export { textSchema, MARK_ORDER, type TableAlignment } from './schema'
export { buildInputRules, markdownInputRules } from './inputRules'
export { buildKeymap, toggleMark } from './keymap'
export { anchorFromState, rangeFromAnchor, selectionFromState, selectAnchor, blockText } from './selection'
export { sanitizePastedHtml, looksLikeMarkdown, markdownSlice, htmlSlice, insertImageFiles, type ImageUploader } from './paste'

import type { SurfaceFactory } from '../registry'
import { TextSurface } from './TextSurface'
import type { EditorAction } from '../../extensions/builtin/text'
import { mergeSlashActions } from '../../extensions/contributions'
import type { ExtensionRegistry } from '../../extensions/registry'
import { getExtensionRegistry } from '../../extensions/runtime'

/**
 * 注册表用的工厂：真正 import 到本文件时才会把 ProseMirror 拉进 chunk。
 * 斜杠菜单的动作全部来自注册表：内置的由 `kb.builtin.text` 注册（与工具栏共用同一份声明），
 * 第三方扩展注册的斜杠项一样；扩展装上 / 卸载后下一次打开菜单就生效。
 * 菜单状态每次选区变化都会重算一遍，所以按注册表版本缓存翻译结果，贡献没变时不重复分配。
 */
export const createTextSurface: SurfaceFactory = () => {
  let cache: { registry: ExtensionRegistry; version: number; actions: readonly EditorAction[] } | null = null
  return new TextSurface({
    slashActions: () => {
      const registry = getExtensionRegistry()
      if (!cache || cache.registry !== registry || cache.version !== registry.version) {
        cache = { registry, version: registry.version, actions: mergeSlashActions([], 'text', registry) }
      }
      return cache.actions
    },
  })
}
