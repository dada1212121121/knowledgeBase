/**
 * 文本选区 ⇄ 统一锚点
 *
 * 为什么要自己的映射层：
 * 1. 锚点必须跨会话稳定（评论、搜索命中、AI 引用都存它），而 ProseMirror 的 pos 只是当前文档的偏移，
 *    一次协同换行就全部失效。这里用「块路径 + 块内字符偏移」表达，路径由节点树结构决定。
 * 2. 块路径取 `ResolvedPos.path` 去掉最后一段（文本偏移），例如 `0.1.0` 表示
 *    第 0 个顶层块的第 1 个子块的第 0 个文本块，嵌套列表也能唯一确定。
 * 3. 块内偏移只数「真实字符」，硬换行算一个 `\n`，与 Markdown 序列化口径一致。
 */
import type { Node as PMNode } from 'prosemirror-model'
import { TextSelection, type EditorState } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import type { Anchor, Selection } from '../../types'

/** 块内可见文本：text 原样，硬换行算 `\n`，其它行内节点（图片等）不占偏移 */
export function blockText(node: PMNode): string {
  let out = ''
  node.forEach((child) => {
    if (child.isText) out += child.text ?? ''
    // 软换行 / 硬换行都是一个节点、占一个位置，按 `\n` 计（与原先软换行是 '\n' 文本时的偏移一致）
    else if (child.type.name === 'hardbreak') out += '\n'
  })
  return out
}

/** 某个位置所属块的路径（不含文本偏移） */
/** 文本锚点（kind 固定为 text，便于调用方直接取 block/offset） */
export type TextAnchor = Extract<Anchor, { kind: 'text' }>

export function blockPathAt(doc: PMNode, pos: number): string {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)))
  // ResolvedPos 没有现成的 path：按深度逐层取「当前节点在第几层父节点里」拼出来
  const path: number[] = []
  for (let depth = 1; depth <= $pos.depth; depth += 1) path.push($pos.index(depth - 1))
  // 最后一段是文本偏移；文本块自身的下标就是所属块，保留
  if (!path.length) path.push(0)
  return path.join('.')
}

/** 按路径取块节点的起始偏移；找不到返回 null */
export function blockStartAt(doc: PMNode, path: string): { node: PMNode; start: number } | null {
  const indexes = path
    .split('.')
    .filter(Boolean)
    .map((part) => Number.parseInt(part, 10))
  if (indexes.some((index) => Number.isNaN(index))) return null
  let node: PMNode = doc
  let start = 0
  for (const index of indexes) {
    if (index < 0 || index >= node.childCount) return null
    for (let i = 0; i < index; i += 1) start += node.child(i).nodeSize
    node = node.child(index)
    start += 1 // 进入子节点：+1 跳过该层的开标签位置
  }
  return { node, start }
}

/** 当前选区 → 文本锚点；空选区也返回（length 为 0），无法定位时返回 null */
export function anchorFromState(state: EditorState): TextAnchor | null {
  const { from, to } = state.selection
  if (from === to) {
    const block = blockPathAt(state.doc, from)
    const start = blockStartAt(state.doc, block)
    if (!start) return null
    return { kind: 'text', block, offset: from - start.start, length: 0 }
  }
  const block = blockPathAt(state.doc, from)
  const start = blockStartAt(state.doc, block)
  if (!start) return null
  const offset = from - start.start
  const length = Math.max(0, Math.min(to - from, blockText(start.node).length - offset))
  return { kind: 'text', block, offset, length }
}

/** 锚点 → 当前文档位置区间；锚点失效（文档已变）时返回 null */
export function rangeFromAnchor(
  doc: PMNode,
  anchor: Anchor,
): { from: number; to: number } | null {
  if (anchor.kind !== 'text') return null
  const start = blockStartAt(doc, anchor.block)
  if (!start) return null
  const textLength = blockText(start.node).length
  const from = start.start + Math.max(0, Math.min(anchor.offset, textLength))
  const to = Math.min(from + Math.max(0, anchor.length ?? 0), start.start + textLength)
  return { from, to }
}

/** 选区对象（给 Host / Chrome 展示用） */
export function selectionFromState(state: EditorState): Selection | null {
  const anchor = anchorFromState(state)
  if (!anchor) return null
  const start = blockStartAt(state.doc, anchor.block)
  const length = anchor.length ?? 0
  const quote = start && length ? blockText(start.node).slice(anchor.offset, anchor.offset + length) : undefined
  return {
    kind: 'text',
    anchor: quote ? { ...anchor, quote } : anchor,
    isEmpty: length === 0,
    text: quote,
  }
}

/** 把锚点区间写回视图选区；失败返回 false，不抛异常 */
export function selectAnchor(view: EditorView, anchor: Anchor): boolean {
  const range = rangeFromAnchor(view.state.doc, anchor)
  if (!range) return false
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, range.from, range.to)))
  return true
}
