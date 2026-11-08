/**
 * Text Surface 的查找 / 替换内核
 *
 * 为什么要自己实现而不是用浏览器原生查找：
 * 1. Chrome 的查找条要显示「第 N / 共 M 个」，还要支持替换与全部替换，原生查找拿不到这些数据。
 * 2. 命中高亮必须画在 ProseMirror 内部（Decoration），否则滚动、折叠、重新渲染后高亮会错位。
 * 3. 匹配只在单个文本节点内进行：跨节点（例如加粗边界两侧）拼接会让人以为「命中了一个词」，
 *    实际替换时会拆散标记；这与主流编辑器（VS Code / Notion）的口径一致。
 */
import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'
import type { EditorState, Transaction } from 'prosemirror-state'

/** 一次命中：from/to 是文档绝对位置（可直接用于 setSelection / replaceWith） */
export interface FindMatch {
  from: number
  to: number
  text: string
}

export interface FindState {
  query: string
  matches: FindMatch[]
  /** 当前命中下标；-1 表示没有选中任何一条 */
  index: number
  caseSensitive: boolean
}

/** 查找插件状态：Chrome 只读它，写入一律走事务 meta（避免两处状态不同步） */
export interface FindPluginState {
  matches: FindMatch[]
  index: number
}

export const findPluginKey = new PluginKey<FindPluginState>('kb-text-find')

export const EMPTY_FIND: FindPluginState = { matches: [], index: -1 }

/** 在整篇文档里找 `query`；空查询或没有命中返回空数组 */
export function findMatches(doc: PMNode, query: string, caseSensitive = false): FindMatch[] {
  const needle = query.trim()
  if (!needle) return []
  const lowered = caseSensitive ? needle : needle.toLowerCase()
  const matches: FindMatch[] = []
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true
    const haystack = caseSensitive ? node.text : node.text.toLowerCase()
    let index = haystack.indexOf(lowered)
    while (index >= 0) {
      matches.push({ from: pos + index, to: pos + index + needle.length, text: node.text.slice(index, index + needle.length) })
      index = haystack.indexOf(lowered, index + Math.max(1, needle.length))
    }
    return true
  })
  return matches
}

/**
 * 高亮插件：只认 meta 里的 FindPluginState，不自己算匹配。
 * 这样「查找条按了什么」与「屏幕上亮的是什么」永远来自同一份数据。
 */
export function findHighlightPlugin(): Plugin<FindPluginState> {
  return new Plugin<FindPluginState>({
    key: findPluginKey,
    state: {
      init: () => EMPTY_FIND,
      apply(tr, previous) {
        const meta = tr.getMeta(findPluginKey) as FindPluginState | undefined
        if (meta) return meta
        // 文档被改动后位置会失效：清掉高亮，等下一次查找重建（比画出错位的高亮诚实）
        if (tr.docChanged) return EMPTY_FIND
        return previous
      },
    },
    props: {
      decorations(state) {
        const plugin = findPluginKey.getState(state)
        if (!plugin || plugin.matches.length === 0) return null
        const decorations = plugin.matches.map((match, index) =>
          Decoration.inline(match.from, match.to, {
            class: index === plugin.index ? 'kb-find-hit is-active' : 'kb-find-hit',
          }),
        )
        return DecorationSet.create(state.doc, decorations)
      },
    },
  })
}

/** 生成一次「更新高亮」的事务（供 TextSurface 与测试共用） */
export function withFindState(tr: Transaction, state: FindPluginState): Transaction {
  return tr.setMeta(findPluginKey, state)
}

/** 读取当前插件高亮状态（未挂插件时返回空状态） */
export function readFindState(state: EditorState): FindPluginState {
  return findPluginKey.getState(state) ?? EMPTY_FIND
}
