/**
 * 内置扩展：字数 / 计数单位
 *
 * 以前顶栏的计数写在 `EditorChrome` 模板里，底部状态栏的计数写在 `EditorStatus` 里，各自拼一遍文案。
 * 现在它们是两个状态栏项（`registerStatusItem`）：宿主只负责把内容面上报的数（字数 / 格数 / 页数）和单位交给它们，
 * 文案规则在这里：
 * - 顶栏：任何内容面都显示，单位缺省按「字」；
 * - 底部状态栏：有单位就按单位，没有单位只有文本面显示「N 字」，其它内容面不显示。
 */
import { defineExtension } from '../../api'
import { builtinManifest, type BuiltinExtension } from './register'

export const BUILTIN_STATS_ID = 'kb.builtin.stats'

export const BUILTIN_STATS: BuiltinExtension = {
  manifest: builtinManifest({ id: BUILTIN_STATS_ID, name: '字数统计', description: '顶栏与状态栏的字数 / 计数单位', permissions: ['ui'] }),
  extension: defineExtension({
    activate(ctx) {
      ctx.registerStatusItem({ id: 'count', area: 'chrome', text: (state) => `${state.words} ${state.unitLabel || '字'}` })
      ctx.registerStatusItem({
        id: 'count',
        area: 'status',
        text: (state) => (state.unitLabel ? `${state.words} ${state.unitLabel}` : state.kind === 'text' ? `${state.words} 字` : ''),
      })
    },
  }),
}
