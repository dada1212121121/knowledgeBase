/**
 * 内置扩展：PDF 的查找
 * 缩放、翻页、页签在内容面自己的工具条里，外壳只补一个只读也安全的「查找」入口。
 */
import { defineExtension } from '../../api'
import { builtinManifest, registerToolbarGroups, type BuiltinExtension } from './register'
import { FIND_ONLY_TOOLBAR } from './text'

export const BUILTIN_PDF_ID = 'kb.builtin.pdf'

export const BUILTIN_PDF: BuiltinExtension = {
  manifest: builtinManifest({ id: BUILTIN_PDF_ID, name: 'PDF 工具栏', description: 'PDF 预览的查找入口', permissions: ['ui'] }),
  extension: defineExtension({
    activate(ctx) {
      registerToolbarGroups(ctx, FIND_ONLY_TOOLBAR, { kinds: ['pdf'] })
    },
  }),
}
