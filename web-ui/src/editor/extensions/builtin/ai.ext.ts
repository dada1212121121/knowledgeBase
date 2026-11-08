/**
 * 内置扩展：AI 入口——润色 / 总结 / 翻译选中
 *
 * 以前是 Chrome 里写死的 `AI_ACTIONS` 三项菜单 + `emit('ai')`。现在它们是三个普通的 AI 工具
 * （`registerAITool`），出现在和第三方 AI 工具同一个「AI」菜单里。区别只有交付方式：`target: 'page'`，
 * `run` 里经宿主页面通道（`api.page`）把「动作 + 选区文字」交给页面的 AI 面板，宿主不弹「建议」条。
 * 页面没接入 AI 能力（`capabilities.ai` 为 false）时这三项不出现；第三方工具不受这个开关影响，只看文档的 AI 权限。
 */
import { defineExtension } from '../../api'
import { builtinManifest, type BuiltinExtension } from './register'

export const BUILTIN_AI_ID = 'kb.builtin.ai'

/** 动作 id 同时是页面收到的 `ai` 事件里的 `action`，与旧版一致。 */
export const BUILTIN_AI_ACTIONS: readonly { id: string; title: string }[] = [
  { id: 'polish', title: '润色选中' },
  { id: 'summary', title: '总结选中' },
  { id: 'translate', title: '翻译选中' },
]

export const BUILTIN_AI: BuiltinExtension = {
  manifest: builtinManifest({ id: BUILTIN_AI_ID, name: 'AI 改写', description: '润色、总结、翻译选中内容（结果由页面的 AI 面板接管）', permissions: ['ai', 'document.read'] }),
  extension: defineExtension({
    activate(ctx) {
      for (const action of BUILTIN_AI_ACTIONS) {
        ctx.registerAITool({
          id: action.id,
          title: action.title,
          target: 'page',
          run: (input, api) => {
            api.page?.emit('ai', { action: action.id, text: input.text })
            return ''
          },
        })
      }
    },
  }),
}
