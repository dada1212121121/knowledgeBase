/**
 * 内置扩展：导出入口
 *
 * 以前是 `EditorChrome` 模板里写死的「导出」按钮 + `emit('export')`。现在按钮是顶栏操作区的一个贡献
 * （`placement: 'bar'`），点击执行命令 `export.open`；命令经宿主页面通道（`api.page`）把「导出」交给嵌入编辑器的页面。
 * Host 只负责在收到事件时把当前正文序列化出来，不再认识这个按钮。
 * 页面没接入导出能力（`capabilities.export` 为 false）时按钮不显示；手机上外壳压成一行时也收起（页头已有）。
 */
import { defineExtension } from '../../api'
import { builtinManifest, type BuiltinExtension } from './register'

export const BUILTIN_EXPORT_ID = 'kb.builtin.export'

export const BUILTIN_EXPORT: BuiltinExtension = {
  manifest: builtinManifest({ id: BUILTIN_EXPORT_ID, name: '导出', description: '把当前正文交给页面导出为 Markdown', permissions: ['ui'] }),
  extension: defineExtension({
    activate(ctx) {
      ctx.registerCommand('export.open', (_args, api) => api.page?.emit('export'))
      ctx.registerToolbarItem({
        id: 'export',
        label: '导出',
        description: '导出 Markdown',
        command: 'export.open',
        placement: 'bar',
        capability: 'export',
        compact: 'hide',
      })
    },
  }),
}
