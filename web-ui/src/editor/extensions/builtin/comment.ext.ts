/**
 * 内置扩展：评论入口
 *
 * 以前是 Chrome 模板里写死的「评论」按钮 + `emit('comment')`。现在是顶栏操作区的贡献，命令 `comment.open`
 * 经宿主页面通道把「评论选中内容」交给页面（Host 收到事件时附上选区文字与锚点）。页面没接入评论能力时不显示。
 */
import { defineExtension } from '../../api'
import { builtinManifest, type BuiltinExtension } from './register'

export const BUILTIN_COMMENT_ID = 'kb.builtin.comment'

export const BUILTIN_COMMENT: BuiltinExtension = {
  manifest: builtinManifest({ id: BUILTIN_COMMENT_ID, name: '评论', description: '把选中内容交给页面做评论', permissions: ['ui'] }),
  extension: defineExtension({
    activate(ctx) {
      ctx.registerCommand('comment.open', (_args, api) => api.page?.emit('comment'))
      ctx.registerToolbarItem({
        id: 'comment',
        label: '评论',
        description: '评论选中内容',
        command: 'comment.open',
        placement: 'bar',
        capability: 'comment',
      })
    },
  }),
}
