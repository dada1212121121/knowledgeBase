/**
 * Markdown 式输入规则
 *
 * 只做「打字时能自然出现结构」的最小集合，不追求覆盖全部 Markdown：
 * 1. 块级：`# ` 标题、`- ` / `* ` / `+ ` 无序列表、`1. ` 有序列表、`> ` 引用、``` ``` ``` 代码块、`---` 分割线、`[ ] `/`[x] ` 任务项。
 * 2. 行内：`**粗**`、`*斜*`、`~~删~~`、`` `代码` ``、`[文字](链接)`。
 * 3. 每条规则都必须在「不该触发」时不触发：比如行内规则只在闭合符号输入后才生效，
 *    否则用户打 `2 * 3` 会凭空出现强调标记。
 * 4. 中文输入法：中文标点状态下按这些键出来的是全角符号（`>` → `》`、`.` → `。`、`[` `]` → `【` `】`、`` ` `` → `·`），
 *    块级规则一并认它们，不用为了打一个列表先切到英文。只认段首：中文正文里段落不会以这些符号开头，不会误触发。
 *    行内规则不认全角：`·` 是人名间隔号（列夫·托尔斯泰），认了会把正文改成代码。
 * 5. 规则刚生效时按退格会撤回成原来打的字（keymap 里的 undoInputRule），想要字面的 `## ` / `1. ` 时退一下就行。
 */
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  wrappingInputRule,
  type InputRule as InputRuleType,
} from 'prosemirror-inputrules'
import { TextSelection } from 'prosemirror-state'
import { findWrapping } from 'prosemirror-transform'
import type { Node as PMNode, MarkType, NodeType, Schema } from 'prosemirror-model'

/**
 * 行内标记规则。
 * `closeLen` 是闭合符号长度：内容区间用「匹配末尾往前推」算，避免正则开头的上下文吃进内容。
 */
function markRule(regexp: RegExp, markType: MarkType, closeLen: number): InputRuleType {
  return new InputRule(regexp, (state, match, start, end) => {
    const content = match[1] ?? ''
    // 空内容不建标记，否则 `****` 会留下一段带 mark 的空文本
    if (!content) return null
    const from = end - closeLen - content.length
    if (from < start) return null
    const { tr } = state
    const mark = markType.create()
    tr.replaceWith(from, end, state.schema.text(content, [mark]))
    // 光标落在标记内部末尾：继续输入仍是该标记（与常见编辑器一致）
    tr.setSelection(TextSelection.create(tr.doc, from + content.length))
    return tr
  })
}

/** 把行内文本包成链接（闭合部分是 `](href)`，长度按捕获组算） */
function linkRule(linkType: MarkType): InputRuleType {
  return new InputRule(/\[([^\]\n]+)\]\(([^)\s]+)\)$/, (state, match, start, end) => {
    const text = match[1] ?? ''
    const href = match[2] ?? ''
    if (!text || !href) return null
    const from = end - text.length - href.length - 4 // `](` + `)`
    if (from < start) return null
    const { tr } = state
    tr.replaceWith(from, end, state.schema.text(text, [linkType.create({ href, title: null })]))
    tr.setSelection(TextSelection.create(tr.doc, from + text.length))
    return tr
  })
}

/** 当前光标所在（或上一层）的列表项；不是列表项返回 null */
function enclosingListItem(doc: PMNode, pos: number): { node: PMNode; before: number } | null {
  const $pos = doc.resolve(pos)
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth)
    if (node.type.name === 'list_item') return { node, before: $pos.before(depth) }
  }
  return null
}

/** 组装规则集；schema 由调用方注入，便于测试里换 schema */
export function buildInputRules(schema: Schema): InputRuleType[] {
  const { nodes, marks } = schema
  return [
    // 标题：`# ` … `###### `（全角 `＃` 同样认）
    textblockTypeInputRule(/^([#＃]{1,6})\s$/, nodes.heading, (match) => ({ level: match[1].length })),
    // 引用：`> `，中文标点下是 `》 `（全角 `＞` 也认）
    wrappingInputRule(/^\s*[>》＞]\s$/, nodes.blockquote),
    // 无序列表：`-` / `*` / `+` 后面必须跟空格，否则 `-5` 会被误判（全角写法同样认）
    wrappingInputRule(/^\s*([-+*－＋＊])\s$/, nodes.bullet_list),
    // 有序列表：`1. ` 起步，start 保留真实起始序号；中文标点下的 `1。 ` 一样。
    // `1、` 不认：那是中文自己的编号写法，变成 Markdown 列表后会显示成 `1.`，和作者写的不一样
    wrappingInputRule(
      /^(\d+)[.。．]\s$/,
      nodes.ordered_list,
      (match) => ({ order: Number(match[1]) }),
      (match, node) => node.childCount + node.attrs.order === Number(match[1]),
    ),
    // 任务项：`[ ] ` / `[x] ` / `[] `，中文标点下的 `【】 ` / `【x】 ` 一样。
    // 已经在列表项里：只改这一项的 checked；在普通段落里：直接把这一段变成任务列表（和工具栏「任务列表」同一个结果），
    // 不用先打 `- ` 建列表再打 `[ ] `
    new InputRule(/^\s*[[【［]( |x|X)?[\]】］]\s$/, (state, match, start, end) => {
      const checked = (match[1] ?? ' ').toLowerCase() === 'x'
      const item = enclosingListItem(state.doc, start)
      if (item) {
        const { tr } = state
        tr.setNodeMarkup(item.before, undefined, { ...item.node.attrs, checked })
        tr.delete(start, end)
        return tr
      }
      if (state.doc.resolve(start).parent.type !== nodes.paragraph) return null
      const tr = state.tr.delete(start, end)
      const range = tr.doc.resolve(start).blockRange()
      const wrapping = range && findWrapping(range, nodes.bullet_list)
      if (!range || !wrapping) return null
      tr.wrap(range, wrapping)
      const list = tr.doc.nodeAt(range.start)
      list?.forEach((child, offset) => {
        if (child.type === nodes.list_item) tr.setNodeMarkup(range.start + 1 + offset, undefined, { ...child.attrs, checked })
      })
      return tr
    }),
    // 代码块：``` 加可选语言；中文标点下反引号键打出来的是 `·`（全角 `｀` 也认）
    textblockTypeInputRule(/^[`·｀]{3}([a-zA-Z0-9_+-]*)\s$/, nodes.code_block, (match) => ({
      language: match[1] ?? '',
    })),
    // 分割线：`---` / `***` / `___`
    new InputRule(/^(?:---|\*\*\*|___)$/, (state, match, start) => {
      // 分割线是块级节点，不能像行内内容那样替换光标前的几个字符：
      // 必须把整个文本块换成 hr，否则事务非法（块节点塞进段落）。
      const $from = state.doc.resolve(start)
      if (!$from.parent.isTextblock || $from.parent.textContent !== match[0]) return null
      const blockStart = $from.before($from.depth)
      const blockEnd = $from.after($from.depth)
      const { tr } = state
      const replacement = $from.depth === 1 && blockEnd >= state.doc.content.size
        ? [nodes.hr.create(), nodes.paragraph.create()]
        : [nodes.hr.create()]
      tr.replaceWith(blockStart, blockEnd, replacement)
      tr.setSelection(TextSelection.near(tr.doc.resolve(blockStart + replacement[0].nodeSize + (replacement[1] ? 1 : 0))))
      return tr
    }),
    markRule(/\*\*([^*]+)\*\*$/, marks.strong, 2),
    // 前面加一个非 `*` 的上下文，避免把 `**x**` 拆成两个 `*x*`
    markRule(/(?:^|[^*])\*([^*\n]+)\*$/, marks.emphasis, 1),
    markRule(/~~([^~]+)~~$/, marks.strike_through, 2),
    markRule(/(?:^|[^`])`([^`\n]+)`$/, marks.inlineCode, 1),
    linkRule(marks.link),
  ]
}

/** 打包成可直接塞进 plugins 的插件 */
export function markdownInputRules(schema: Schema) {
  return inputRules({ rules: buildInputRules(schema) })
}
