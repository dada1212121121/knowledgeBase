/**
 * 内置扩展：代码面的视图工具栏
 * 查找替换、软换行、全选、聚焦编辑区。代码面只做源码编辑，不提供改写格式的按钮（Markdown 的格式动作用在源码上会出错）。
 */
import { defineExtension } from '../../api'
import { builtinManifest, registerToolbarGroups, type BuiltinExtension } from './register'
import { CODE_TOOLBAR } from './text'

export const BUILTIN_CODE_ID = 'kb.builtin.code'

export const BUILTIN_CODE: BuiltinExtension = {
  manifest: builtinManifest({ id: BUILTIN_CODE_ID, name: '代码视图工具栏', description: '代码 / 配置文件的查找替换、换行、全选、聚焦', permissions: ['ui'] }),
  extension: defineExtension({
    activate(ctx) {
      registerToolbarGroups(ctx, CODE_TOOLBAR, { kinds: ['code'] })
    },
  }),
}
