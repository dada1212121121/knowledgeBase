/**
 * 内置扩展：演示文稿（slide 面）的工具栏
 *
 * 幻灯片的内置工具栏随 PPTX 编辑（阶段 5）一起落地；这里先把「slide 面的内置贡献由内置扩展注册」这条路接通：
 * 读取 `contributionFor('slide')`，有数据就注册，没有就什么也不做。PPTX 分支只需把工具栏数据放进
 * `text.ts` 的 `CONTRIBUTIONS.slide`，不用再碰注册代码；需要多套方案时在这里按 `registerToolbarGroups` 的 `profile` 区分。
 */
import { defineExtension } from '../../api'
import { builtinManifest, registerContribution, type BuiltinExtension } from './register'
import { contributionFor } from './text'

export const BUILTIN_SLIDE_ID = 'kb.builtin.slide'

export const BUILTIN_SLIDE: BuiltinExtension = {
  manifest: builtinManifest({ id: BUILTIN_SLIDE_ID, name: '演示文稿工具栏', description: '演示文稿的工具栏（随 PPTX 编辑落地）', permissions: ['ui'] }),
  extension: defineExtension({
    activate(ctx) {
      registerContribution(ctx, contributionFor('slide'), { kinds: ['slide'] })
    },
  }),
}
