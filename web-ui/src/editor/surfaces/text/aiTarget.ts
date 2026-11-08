/**
 * AI 写作的「目标区间」（UI-3）：从发起到用户点「替换 / 插入」之间，记住要改的是哪一段。
 *
 * - 区间随每个事务映射（本地继续打字、协同里别人的改动都会移动位置），应用时不会对着过期的位置写；
 * - 区间画成高亮装饰（不进文档、不进撤销栈、不进协同房间），用户一眼看出 AI 要改哪里；
 * - 区间被整个删掉（映射后起点 ≥ 终点且原来不是空的）就失效，应用时报「内容已经变了」。
 */
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'

export interface AiTargetRange {
  from: number
  to: number
  /** 发起时这一段是不是空的（续写 / 没选中时在光标处写）：空区间映射后仍然有效 */
  empty: boolean
  /** 区间是否还有效（被整段删掉后为 false） */
  alive: boolean
}

export const aiTargetKey = new PluginKey<AiTargetRange | null>('kb-ai-target')

type Meta = { set: { from: number; to: number } } | { clear: true }

export function aiTargetPlugin(): Plugin<AiTargetRange | null> {
  return new Plugin<AiTargetRange | null>({
    key: aiTargetKey,
    state: {
      init: () => null,
      apply(tr, value): AiTargetRange | null {
        const meta = tr.getMeta(aiTargetKey) as Meta | undefined
        if (meta && 'clear' in meta) return null
        if (meta && 'set' in meta) {
          const { from, to } = meta.set
          return { from, to, empty: from === to, alive: true }
        }
        if (!value || !tr.docChanged) return value
        // 起点往后靠、终点往前靠：在区间两端紧挨着打的字不算进区间；空区间（光标处）两端都往前靠，
        // 用户在光标处接着打的字排在 AI 内容的后面
        const from = tr.mapping.map(value.from, value.empty ? -1 : 1)
        const to = tr.mapping.map(value.to, -1)
        const alive = value.alive && (value.empty || from < to)
        return { ...value, from, to: Math.max(from, to), alive }
      },
    },
    props: {
      decorations(state) {
        const range = aiTargetKey.getState(state)
        if (!range || !range.alive) return null
        if (range.empty) {
          const caret = document.createElement('span')
          caret.className = 'kb-ai-caret'
          caret.setAttribute('aria-hidden', 'true')
          return DecorationSet.create(state.doc, [Decoration.widget(range.from, caret, { side: -1, key: 'kb-ai-caret' })])
        }
        return DecorationSet.create(state.doc, [Decoration.inline(range.from, range.to, { class: 'kb-ai-target' })])
      },
    },
  })
}

/** 设定 / 清除目标区间的单独事务（只带 meta、不改文档，所以也不进撤销栈） */
export function setAiTarget(tr: Transaction, range: { from: number; to: number } | null): Transaction {
  return tr.setMeta(aiTargetKey, range ? { set: range } : { clear: true }).setMeta('addToHistory', false)
}

/**
 * 在「写回 AI 结果」的那个事务里顺带清掉目标区间：只加插件的 meta，不碰撤销栈的标记——
 * 写回本身要进撤销栈，Ctrl+Z 一步回到原样
 */
export function clearAiTarget(tr: Transaction): Transaction {
  return tr.setMeta(aiTargetKey, { clear: true })
}

export function aiTargetOf(state: EditorState): AiTargetRange | null {
  return aiTargetKey.getState(state) ?? null
}
