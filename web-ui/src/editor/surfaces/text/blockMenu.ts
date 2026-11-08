/**
 * 块菜单（点块手柄的 ⠿ 打开）的纯函数：认出顶层块是什么、能转换成什么、转换 / 复制 / 移动 / 删除。
 *
 * 只依赖 ProseMirror 的 state / model / transform，单测直接驱动；界面在 blockHandle.ts。
 * 每个操作都是一个事务：撤销一步回到原样，多人编辑时和普通输入一样经 y-prosemirror 同步。
 * 节点 / 属性只用 schema.ts 里已有的（房间格式不变），列表项的 label / listType 显示属性跟着列表类型同步。
 */
import { Fragment, NodeRange, type Node as PMNode } from 'prosemirror-model'
import { TextSelection, type EditorState, type Transaction } from 'prosemirror-state'
import { findWrapping } from 'prosemirror-transform'
import { calloutType } from '@/utils/callouts'

export type BlockKind =
  | 'paragraph'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'heading4'
  | 'heading5'
  | 'heading6'
  | 'quote'
  | 'callout'
  | 'bullet'
  | 'ordered'
  | 'task'
  | 'code'
  | 'other'

/** 「转换为」的目标，顺序即菜单顺序；icon 是工具栏图标名（toolIcons.ts），face 是画成文字的图标 */
export const CONVERT_TARGETS = [
  { kind: 'paragraph', label: '正文', icon: 'paragraph' },
  { kind: 'heading1', label: '一级标题', face: 'H1' },
  { kind: 'heading2', label: '二级标题', face: 'H2' },
  { kind: 'heading3', label: '三级标题', face: 'H3' },
  { kind: 'quote', label: '引用', icon: 'quote' },
  { kind: 'bullet', label: '无序列表', icon: 'bullet' },
  { kind: 'ordered', label: '有序列表', icon: 'ordered' },
  { kind: 'task', label: '任务列表', icon: 'task' },
  { kind: 'code', label: '代码块', icon: 'codeblock' },
] as const

export type ConvertTarget = (typeof CONVERT_TARGETS)[number]['kind']

const TEXT_TARGETS: readonly ConvertTarget[] = CONVERT_TARGETS.map((target) => target.kind)
const LIST_TARGETS: readonly ConvertTarget[] = ['paragraph', 'bullet', 'ordered', 'task']

/** 引用块是不是提示块（首段以 `[!NOTE]` 这类标记开头） */
function isCallout(node: PMNode): boolean {
  const first = node.firstChild
  return !!first && first.isTextblock && calloutType(first.textContent) !== null
}

/** 无序列表里的项带复选框（checked 不是 null）就是任务列表；任务列表开关会把整个列表的项一起改，看第一项即可 */
function isTaskList(node: PMNode): boolean {
  return node.firstChild?.attrs.checked != null
}

export function blockKind(node: PMNode): BlockKind {
  switch (node.type.name) {
    case 'paragraph':
      return 'paragraph'
    case 'heading': {
      const level = Math.max(1, Math.min(6, Number(node.attrs.level) || 1))
      return `heading${level}` as BlockKind
    }
    case 'blockquote':
      return isCallout(node) ? 'callout' : 'quote'
    case 'bullet_list':
      return isTaskList(node) ? 'task' : 'bullet'
    case 'ordered_list':
      return 'ordered'
    case 'code_block':
      return 'code'
    default:
      return 'other'
  }
}

/** 段落 / 标题里除了文字和换行，还有图片、公式、原样 HTML 这类行内节点：变成代码块会丢掉它们，不提供这个目标 */
function hasRichInline(node: PMNode): boolean {
  let rich = false
  node.forEach((child) => {
    if (!child.isText && child.type.name !== 'hardbreak') rich = true
  })
  return rich
}

/**
 * 这个块能转换成哪些类型（不含它现在的类型）。
 * - 段落 / 标题：全部；有图片等行内节点时不给「代码块」
 * - 引用：只能回到正文（去掉引用）；代码块：只能变回正文（每行一段）
 * - 列表：正文（拆成段落）和三种列表互转
 * - 提示块、表格、分割线、脚注等：不提供（转换会丢掉结构或标记）
 */
export function convertibleTargets(node: PMNode): ConvertTarget[] {
  const kind = blockKind(node)
  let allowed: readonly ConvertTarget[]
  if (kind === 'paragraph' || kind.startsWith('heading')) allowed = hasRichInline(node) ? TEXT_TARGETS.filter((target) => target !== 'code') : TEXT_TARGETS
  else if (kind === 'quote' || kind === 'code') allowed = ['paragraph']
  else if (kind === 'bullet' || kind === 'ordered' || kind === 'task') allowed = LIST_TARGETS
  else allowed = []
  return allowed.filter((target) => target !== kind)
}

/** 段落 / 标题的文字（换行节点写成 \n）：变成代码块时用 */
function plainText(node: PMNode): string {
  return node.textBetween(0, node.content.size, '\n', (leaf) => (leaf.type.name === 'hardbreak' ? '\n' : ''))
}

/** 把新列表 / 转换后的列表里每一项的复选框和显示属性统一成目标类型 */
function syncListItems(tr: Transaction, listPos: number, target: 'bullet' | 'ordered' | 'task'): void {
  const list = tr.doc.nodeAt(listPos)
  if (!list) return
  list.forEach((item, offset, index) => {
    const checked = target === 'task' ? (item.attrs.checked ?? false) : null
    const listType = target === 'ordered' ? 'ordered' : 'bullet'
    const label = target === 'ordered' ? `${index + 1}.` : '•'
    if (item.attrs.checked === checked && item.attrs.listType === listType && item.attrs.label === label) return
    tr.setNodeMarkup(listPos + 1 + offset, undefined, { ...item.attrs, checked, listType, label })
  })
}

/** 光标放进刚改过的块开头，接着能打字 */
function caretInto(tr: Transaction, pos: number): Transaction {
  const at = Math.max(0, Math.min(pos + 1, tr.doc.content.size))
  return tr.setSelection(TextSelection.near(tr.doc.resolve(at))).scrollIntoView()
}

/** 把 pos 处的顶层块转换成 target；不能转换（类型相同、不支持、结构不允许）返回 null */
export function convertBlock(state: EditorState, pos: number, target: ConvertTarget): Transaction | null {
  const node = state.doc.nodeAt(pos)
  if (!node || !convertibleTargets(node).includes(target)) return null
  const { schema } = state
  const kind = blockKind(node)
  const end = pos + node.nodeSize
  const tr = state.tr

  if (kind === 'quote') {
    // 去掉引用：引用里的块原样放回顶层
    tr.replaceWith(pos, end, node.content)
    return caretInto(tr, pos)
  }
  if (kind === 'code') {
    // 代码块变回正文：每行一段（空行是空段落），文字不丢
    const lines = node.textContent.split('\n')
    tr.replaceWith(pos, end, Fragment.fromArray(lines.map((line) => schema.nodes.paragraph.create(null, line ? schema.text(line) : null))))
    return caretInto(tr, pos)
  }
  if (kind === 'bullet' || kind === 'ordered' || kind === 'task') {
    if (target === 'paragraph') {
      // 拆掉列表：每一项里的块依次放回顶层（嵌套的子列表仍是列表）
      const blocks: PMNode[] = []
      node.forEach((item) => item.forEach((child) => blocks.push(child)))
      tr.replaceWith(pos, end, Fragment.fromArray(blocks))
      return caretInto(tr, pos)
    }
    const listTarget = target as 'bullet' | 'ordered' | 'task'
    const type = listTarget === 'ordered' ? schema.nodes.ordered_list : schema.nodes.bullet_list
    if (node.type !== type) tr.setNodeMarkup(pos, type, listTarget === 'ordered' ? { order: 1, spread: node.attrs.spread } : { spread: node.attrs.spread })
    syncListItems(tr, pos, listTarget)
    return caretInto(tr, pos + 1)
  }

  // 段落 / 标题
  if (target === 'paragraph' || target.startsWith('heading')) {
    if (target === 'paragraph') tr.setNodeMarkup(pos, schema.nodes.paragraph, null)
    else tr.setNodeMarkup(pos, schema.nodes.heading, { id: '', level: Number(target.slice('heading'.length)) })
    return caretInto(tr, pos)
  }
  if (target === 'code') {
    const text = plainText(node)
    tr.replaceWith(pos, end, schema.nodes.code_block.create({ language: '' }, text ? schema.text(text) : null))
    return caretInto(tr, pos)
  }
  // 引用 / 列表：把这个块包进去
  const wrapType = target === 'quote' ? schema.nodes.blockquote : target === 'ordered' ? schema.nodes.ordered_list : schema.nodes.bullet_list
  const range = new NodeRange(tr.doc.resolve(pos), tr.doc.resolve(end), 0)
  const wrapping = findWrapping(range, wrapType)
  if (!wrapping) return null
  tr.wrap(range, wrapping)
  if (target !== 'quote') syncListItems(tr, pos, target as 'bullet' | 'ordered' | 'task')
  return caretInto(tr, target === 'quote' ? pos + 1 : pos + 2)
}

/** 在块后面复制一份，光标进到副本里 */
export function duplicateBlock(state: EditorState, pos: number): Transaction | null {
  const node = state.doc.nodeAt(pos)
  if (!node) return null
  const end = pos + node.nodeSize
  const tr = state.tr.insert(end, node.copy(node.content))
  return caretInto(tr, end)
}

/** 删掉这个块；它是文档里唯一的块时换成一个空段落（文档至少要有一个块） */
export function deleteBlock(state: EditorState, pos: number): Transaction | null {
  const node = state.doc.nodeAt(pos)
  if (!node) return null
  const end = pos + node.nodeSize
  const tr = state.doc.childCount === 1 ? state.tr.replaceWith(pos, end, state.schema.nodes.paragraph.create()) : state.tr.delete(pos, end)
  return caretInto(tr, Math.min(pos, tr.doc.content.size))
}

/** 顶层块在文档里的序号；pos 不是某个顶层块的起点返回 -1 */
export function topIndexAt(state: EditorState, pos: number): number {
  let start = 0
  for (let index = 0; index < state.doc.childCount; index += 1) {
    if (start === pos) return index
    start += state.doc.child(index).nodeSize
  }
  return -1
}

/** 把 pos 处的顶层块上移 / 下移一位（和 Ctrl/⌘+Shift+↑/↓ 一样）；已在边上返回 null */
export function moveBlockAt(state: EditorState, pos: number, direction: -1 | 1): Transaction | null {
  const index = topIndexAt(state, pos)
  const node = state.doc.nodeAt(pos)
  const target = index + direction
  if (index < 0 || !node || target < 0 || target >= state.doc.childCount) return null
  const tr = state.tr.delete(pos, pos + node.nodeSize)
  // 删掉之后，插入点前面有几个块：上移 = 目标块之前的 target 个；下移 = 到原来的下一个块为止的 index + 1 个
  const before = direction < 0 ? target : index + 1
  let insertAt = 0
  for (let at = 0; at < before; at += 1) insertAt += tr.doc.child(at).nodeSize
  tr.insert(insertAt, node)
  return caretInto(tr, insertAt)
}
