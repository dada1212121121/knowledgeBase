/**
 * 内置扩展：文本面（Markdown 笔记）的格式工具栏与斜杠菜单
 *
 * 原来 `TEXT_TOOLBAR` / `TEXT_SLASH_ACTIONS` 由 Host 经 `contributionFor('text')` 直接取用；
 * 现在由这个扩展经注册表提供，和第三方扩展走同一套 API。数据本身仍然放在 `text.ts`（一份声明，三处使用）。
 * 查找替换 / 源码 / 大纲三个视图按钮在 `view.ts`（`kb.builtin.view`），必须在本扩展之后安装，
 * 这样「视图」分组排在最后，和迁移前的顺序一致。
 */
import { defineExtension } from '../../api'
import { builtinManifest, registerToolbarGroups, registerSlashActions, type BuiltinExtension } from './register'
import { TEXT_SLASH_ACTIONS, TEXT_TOOLBAR } from './text'

export const BUILTIN_TEXT_ID = 'kb.builtin.text'

export const BUILTIN_TEXT: BuiltinExtension = {
  manifest: builtinManifest({ id: BUILTIN_TEXT_ID, name: '文本格式工具栏', description: '笔记 / Markdown 的段落、格式、列表、插入工具栏与斜杠菜单', permissions: ['ui'] }),
  extension: defineExtension({
    activate(ctx) {
      registerToolbarGroups(ctx, TEXT_TOOLBAR, { kinds: ['text'] })
      registerSlashActions(ctx, TEXT_SLASH_ACTIONS, ['text'])
    },
  }),
}
