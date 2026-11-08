/**
 * Text Surface 的编辑命令集
 *
 * 为什么把命令从 TextSurface 里拆出来：
 * 1. 工具栏、斜杠菜单、快捷键、AI 改写最终都落在同一批 ProseMirror 命令上，
 *    集中在这里才能保证「同一个动作只有一种实现」，不会出现按钮能加粗、斜杠菜单加粗失效的情况。
 * 2. 命令是纯函数 `(state, dispatch, view) => boolean`，不依赖 Vue / DOM，
 *    单测可以直接用 `EditorState` 驱动，不必挂真实编辑器。
 * 3. 所有命令在条件不成立时返回 false（不吞默认行为），Host 才能把失败原因如实回给调用方。
 */
import { lift, setBlockType, toggleMark as pmToggleMark, wrapIn } from 'prosemirror-commands'
import { liftListItem, wrapInList } from 'prosemirror-schema-list'
import { TextSelection, type Command, type EditorState } from 'prosemirror-state'
import { Fragment, type Mark, type MarkType, type Node as PMNode, type NodeType, type Schema } from 'prosemirror-model'
import { insertPoint } from 'prosemirror-transform'
import { parseMarkdown } from '../../codecs/markdown'
import { CALLOUT_TYPES, type CalloutType } from '@/utils/callouts'
import { isHexColor, normalizeColorHex, type ColorProp } from '@/utils/colorPalette'

/** 行内标记名 → schema mark 名（与序列化契约一致） */
export const MARK_COMMANDS = ['strong', 'emphasis', 'strike_through', 'inlineCode'] as const
export type MarkCommandName = (typeof MARK_COMMANDS)[number]

/** 块类型判定：用于工具栏高亮 */
export function isInNode(state: EditorState, type: NodeType): boolean {
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type === type) return true
  }
  return false
}

/** 当前块（段落/标题）的类型与层级 */
export function currentBlock(
  state: EditorState,
  schema: Schema,
): { type: 'paragraph' | 'heading' | 'code_block' | 'blockquote' | 'other'; level?: number } {
  const { $from } = state.selection
  // 从最内层往外找第一个「文本块」；引用/列表只是包裹层，不算块类型
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth)
    if (node.type === schema.nodes.heading) {
      return { type: 'heading', level: Number(node.attrs.level) }
    }
    if (node.type === schema.nodes.paragraph) return { type: 'paragraph' }
    if (node.type === schema.nodes.code_block) return { type: 'code_block' }
    if (node.type === schema.nodes.blockquote) return { type: 'blockquote' }
  }
  return { type: 'other' }
}

/** 选区当前生效的标记集合（空选区时用 storedMarks，否则看选区覆盖到的 marks） */
export function activeMarks(state: EditorState): string[] {
  const { empty, from, to, $from } = state.selection
  const held = state.storedMarks ?? $from.marks()
  const names: string[] = empty
    ? held.map((mark) => mark.type.name).filter((name) => (MARK_COMMANDS as readonly string[]).includes(name))
    : MARK_COMMANDS.filter((name) => {
        const type = state.schema.marks[name]
        return !!type && state.doc.rangeHasMark(from, to, type)
      })
  // 链接不在 mark.toggle 的名单里，但工具栏的链接按钮要在光标落在链接上时高亮（链接的打开 / 复制 / 移除都从它进去）
  const link = state.schema.marks.link
  if (link && (empty ? held.some((mark) => mark.type === link) : state.doc.rangeHasMark(from, to, link))) names.push('link')
  return names
}

/** 切换行内标记（空选区只改 storedMarks，与 ProseMirror 官方示例一致） */
export function toggleInlineMark(markType: MarkType): Command {
  return pmToggleMark(markType)
}

/** 设置标题层级；level = 0 表示回到普通段落 */
export function setHeadingLevel(schema: Schema, level: number): Command {
  const size = Math.max(0, Math.min(6, Math.trunc(level)))
  if (size === 0) return setBlockType(schema.nodes.paragraph)
  return setBlockType(schema.nodes.heading, { level: size })
}

/** 引用块开关：已在引用里就提升一级（lift），否则把当前块包进 blockquote */
export function toggleBlockquote(schema: Schema): Command {
  return (state, dispatch, view) => {
    if (isInNode(state, schema.nodes.blockquote)) return lift(state, dispatch, view)
    return wrapIn(schema.nodes.blockquote)(state, dispatch, view)
  }
}

/** 按块类型切换列表：已在该类型列表里 → 提升一级（再点一次就出列表） */
export function toggleListKind(schema: Schema, kind: 'bullet_list' | 'ordered_list'): Command {
  const listType = schema.nodes[kind]
  return (state, dispatch, view) => {
    const { $from } = state.selection
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      if ($from.node(depth).type === listType) return lift(state, dispatch, view)
    }
    return wrapInList(listType)(state, dispatch, view)
  }
}

/**
 * 任务列表开关。
 * 与普通无序列表共用 bullet_list，只把 list_item.checked 从 null 改成 false；
 * 只改「刚包出来 / 当前所在」的那个列表，避免把全文其它普通列表改成任务列表。
 */
export function toggleTaskList(schema: Schema): Command {
  const { bullet_list, list_item } = schema.nodes
  return (state, dispatch, view) => {
    const { $from } = state.selection
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      if ($from.node(depth).type === bullet_list) {
        const item = $from.node(depth - 1)
        // 已经在任务列表里 → 退出（与普通列表一致）
        if (item.type === list_item && item.attrs.checked != null) {
          return lift(state, dispatch, view)
        }
        break
      }
    }
    return wrapInList(bullet_list)(state, (tr) => {
      const $pos = tr.selection.$from
      for (let depth = $pos.depth; depth > 0; depth -= 1) {
        if ($pos.node(depth).type !== bullet_list) continue
        // nodeAt(列表起点) 才是列表本身；+1 进入列表内容，再按子项偏移定位
        const listPos = $pos.before(depth)
        const list = tr.doc.nodeAt(listPos)
        if (!list) break
        list.forEach((child, offset) => {
          if (child.type !== list_item || child.attrs.checked != null) return
          tr.setNodeMarkup(listPos + 1 + offset, undefined, { ...child.attrs, checked: false })
        })
        break
      }
      dispatch?.(tr)
    })
  }
}

/** 插入表格：第一行是表头；行列数做上限保护，避免误点生成巨型表格 */
export function insertTable(schema: Schema, rows: number, cols: number): Command {
  const rowCount = Math.max(1, Math.min(50, Math.trunc(rows) || 3))
  const colCount = Math.max(1, Math.min(12, Math.trunc(cols) || 3))
  return (state, dispatch) => {
    const { table, table_header_row, table_row, table_header, table_cell, paragraph } = schema.nodes
    // 每格恰好一个段落：旧编辑器的单元格只允许一个段落，协同房间里多出来的段落它不认
    const cell = () => paragraph.create()
    const headerRow = table_header_row.create(
      null,
      Array.from({ length: colCount }, () => table_header.create(null, cell())),
    )
    const bodyRows = Array.from({ length: Math.max(0, rowCount - 1) }, () =>
      table_row.create(null, Array.from({ length: colCount }, () => table_cell.create(null, cell()))),
    )
    const node = table.create(null, [headerRow, ...bodyRows])
    if (dispatch) dispatch(state.tr.replaceSelectionWith(node).scrollIntoView())
    return true
  }
}

/**
 * 插入块级节点（分割线）。
 * 光标在文本块里时直接替换该块；不在文本块里（例如刚插完分割线）就插到光标位置，
 * 并在文档末尾补一个空段落——否则光标无处可落，接着输入的字符会丢失。
 */
export function insertHorizontalRule(schema: Schema): Command {
  return (state, dispatch) => {
    const { $from } = state.selection
    if (dispatch) {
      const tr = state.tr
      const rule = schema.nodes.hr.create()
      if ($from.parent.isTextblock) tr.replaceSelectionWith(rule)
      else tr.insert($from.pos, rule)
      const last = tr.doc.lastChild
      if (!last || (last.type !== schema.nodes.paragraph && last.type !== schema.nodes.heading)) {
        tr.insert(tr.doc.content.size, schema.nodes.paragraph.create())
      }
      dispatch(tr.scrollIntoView())
    }
    return true
  }
}

/**
 * 插入图片（地址必须由上方上传通道给出，这里不再拼 base64）。
 * 图片是行内节点：光标在文本块里就替换选区，不在文本块里（如空文档 / 刚插完分割线）
 * 就新建一个段落包住它，保证文档结构仍然合法（doc 只能是 block）。
 */
export function insertImageNode(schema: Schema, src: string, alt = ''): Command {
  return (state, dispatch) => {
    const value = src.trim()
    if (!value) return false
    if (dispatch) {
      const node = schema.nodes.image.create({ src: value, alt: alt || null })
      const { $from } = state.selection
      const tr = $from.parent.isTextblock
        ? state.tr.replaceSelectionWith(node)
        : state.tr.insert($from.pos, schema.nodes.paragraph.create(null, node))
      dispatch(tr.scrollIntoView())
    }
    return true
  }
}

/** 链接地址白名单：只允许 http(s) / mailto / 站内相对地址 / kb 双链，挡掉 javascript: 之类 */
export function isSafeHref(href: string): boolean {
  const value = href.trim()
  if (!value) return false
  if (/^(?:https?:|mailto:|kb:\/\/)/i.test(value)) return true
  // 相对地址 / 锚点：不含协议就算安全（渲染层还会再校验一次）
  return !/^[a-z][a-z0-9+.-]*:/i.test(value)
}

/**
 * 选区所在的链接：光标落在链接文字里（含两端）或选区完全落在同一条链接里时返回它的范围与地址。
 * 旧编辑器的链接浮层靠它回填已有地址；没有它，「编辑链接」只能先手动选中整段文字。
 */
export function linkAtSelection(state: EditorState): { from: number; to: number; href: string; mark: Mark } | null {
  const type = state.schema.marks.link
  if (!type) return null
  const { $from, from, to, empty } = state.selection
  // 空选区：看光标两侧的文字是否带链接（inclusive:false 的标记，光标在末尾时 $from.marks 取不到，要看 nodeBefore）
  const probe = empty ? ($from.nodeAfter?.marks.find((m) => m.type === type) ?? $from.nodeBefore?.marks.find((m) => m.type === type)) : null
  const mark = probe ?? (empty ? null : markCoveringRange(state, from, to, type))
  if (!mark) return null
  // 向两侧扩展到同一条链接（同 href）的完整范围
  const parent = $from.parent
  const start = $from.start()
  let rangeFrom = from
  let rangeTo = to
  parent.forEach((child, childOffset) => {
    const childFrom = start + childOffset
    const childTo = childFrom + child.nodeSize
    const has = child.marks.some((m) => m.type === type && m.attrs.href === mark.attrs.href)
    if (has && childTo >= from && childFrom <= to) {
      rangeFrom = Math.min(rangeFrom, childFrom)
      rangeTo = Math.max(rangeTo, childTo)
    }
  })
  return { from: rangeFrom, to: rangeTo, href: String(mark.attrs.href ?? ''), mark }
}

function markCoveringRange(state: EditorState, from: number, to: number, type: MarkType): Mark | null {
  let found: Mark | null = null
  let covered = true
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return true
    const mark = node.marks.find((m) => m.type === type)
    if (!mark) covered = false
    else if (!found) found = mark
    return false
  })
  return covered ? found : null
}

/** 设置 / 移除链接；空选区时把链接挂到「接下来输入的文字」上，光标在已有链接里时改的是这整条链接 */
export function setLink(schema: Schema, href: string | null): Command {
  const markType = schema.marks.link
  return (state, dispatch) => {
    const trimmed = href?.trim() ?? ''
    if (trimmed && !isSafeHref(trimmed)) return false
    const existing = linkAtSelection(state)
    const { empty } = state.selection
    const from = existing && empty ? existing.from : state.selection.from
    const to = existing && empty ? existing.to : state.selection.to
    const ranged = !empty || !!existing
    if (dispatch) {
      const tr = state.tr
      if (!trimmed) {
        if (ranged) tr.removeMark(from, to, markType)
        else if (markType.isInSet(state.storedMarks ?? [])) tr.removeStoredMark(markType)
      } else {
        // 先去掉旧地址再加新的：同一段文字上不能叠两条链接
        const mark = markType.create({ href: trimmed })
        if (ranged) tr.removeMark(from, to, markType).addMark(from, to, mark)
        else tr.addStoredMark(mark)
      }
      dispatch(tr.scrollIntoView())
    }
    return true
  }
}

/* ---------------- 提示块 / 流程图 / 公式块 ---------------- */

/** 流程图示例：与旧编辑器同一份，用户一眼能看出怎么改 */
export const MERMAID_SAMPLE = 'flowchart LR\n  A[开始] --> B{判断}\n  B -->|是| C[处理]\n  B -->|否| D[结束]'
export const MATH_SAMPLE = 'E = mc^2'

/**
 * 把块级节点放到光标处。
 * - 光标在文档顶层的空段落里：整段替换（不留空行）；
 * - 其它情况：放到当前文本块之后（列表项 / 引用里就放在项内），位置由 insertPoint 校验合法，
 *   单元格这类放不下块级节点的地方返回 false 而不是写出非法文档；
 * - 末尾不是段落 / 标题时补一个空段落，否则光标无处可落，接着输入的字会丢。
 */
export function insertBlocks(schema: Schema, nodes: PMNode[]): Command {
  return (state, dispatch) => {
    const first = nodes[0]
    if (!first) return false
    const { $from, empty } = state.selection
    const replaceEmpty = empty && $from.depth === 1 && $from.parent.type === schema.nodes.paragraph && $from.parent.content.size === 0
    const tr = state.tr
    let at: number
    if (replaceEmpty) {
      at = $from.before()
      tr.replaceWith(at, $from.after(), Fragment.fromArray(nodes))
    } else {
      const point = insertPoint(state.doc, $from.parent.isTextblock ? $from.after() : $from.pos, first.type)
      if (point === null) return false
      at = point
      tr.insert(at, Fragment.fromArray(nodes))
    }
    if (dispatch) {
      const last = tr.doc.lastChild
      if (!last || (last.type !== schema.nodes.paragraph && last.type !== schema.nodes.heading)) {
        tr.insert(tr.doc.content.size, schema.nodes.paragraph.create())
      }
      // 光标放进新块里（文本块），方便直接改示例文字；原子块（分割线）则落在后面
      const inside = tr.doc.resolve(Math.min(at + 1, tr.doc.content.size))
      tr.setSelection(inside.parent.inlineContent ? TextSelection.near(inside) : TextSelection.near(tr.doc.resolve(at + first.nodeSize), 1))
      dispatch(tr.scrollIntoView())
    }
    return true
  }
}

/** `> [!NOTE]` 提示块：走和读取同一个 Markdown 解析，结构与打开含提示块的笔记时完全一致 */
export function insertCallout(schema: Schema, type: CalloutType): Command {
  const label = CALLOUT_TYPES[type]
  if (!label) return () => false
  const parsed = parseMarkdown(`> [!${type.toUpperCase()}]\n> 在这里写${label}内容`)
  const nodes: PMNode[] = []
  parsed.doc.forEach((child) => nodes.push(child))
  return insertBlocks(schema, nodes)
}

/** 流程图：language = mermaid 的代码块（预览由代码块视图渲染） */
export function insertDiagram(schema: Schema): Command {
  return insertBlocks(schema, [schema.nodes.code_block.create({ language: 'mermaid' }, schema.text(MERMAID_SAMPLE))])
}

/** 块级公式：与旧编辑器一致是 language = LaTeX 的代码块，kbMath 让保存时仍写成 `$$` */
export function insertMathBlock(schema: Schema): Command {
  return insertBlocks(schema, [schema.nodes.code_block.create({ language: 'LaTeX', kbMath: true }, schema.text(MATH_SAMPLE))])
}

/* ---------------- 字色 / 底色 ---------------- */

/**
 * 设置 / 清除选区的字色或底色（key 为空 = 清除）。
 * 同一段文字上同一种 prop 只保留一个（先去掉旧的再加），字色与底色可叠加。空选区没有可上色的文字，返回 false。
 */
export function setColor(schema: Schema, prop: ColorProp, key: string | null): Command {
  const type = schema.marks.kb_color
  return (state, dispatch) => {
    if (!type) return false
    const { from, to, empty } = state.selection
    if (empty) return false
    if (dispatch) {
      // 自定义色统一小写 6 位 hex，避免 #E5484D / #e5484d 在 Markdown 里变成两个值
      const nextKey = key && isHexColor(key) ? normalizeColorHex(key) : key
      const tr = state.tr
      state.doc.nodesBetween(from, to, (node, pos) => {
        for (const mark of node.marks) {
          if (mark.type === type && mark.attrs.prop === prop) {
            tr.removeMark(Math.max(from, pos), Math.min(to, pos + node.nodeSize), mark)
          }
        }
      })
      if (nextKey) tr.addMark(from, to, type.create({ prop, key: nextKey }))
      dispatch(tr.scrollIntoView())
    }
    return true
  }
}

/* ---------------- 任务项 ---------------- */

/** 切换 pos 处列表项的勾选状态；pos 不是任务项返回 false。点击复选框与键盘共用 */
export function toggleTaskItemAt(pos: number): Command {
  return (state, dispatch) => {
    const node = state.doc.nodeAt(pos)
    if (!node || node.type.name !== 'list_item' || node.attrs.checked == null) return false
    if (dispatch) dispatch(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !node.attrs.checked }))
    return true
  }
}

/* ---------------- 清除格式 / 格式刷 ---------------- */

/**
 * 「样式」类行内标记：清除格式和格式刷只管这些。链接不算样式——清除格式不该把链接弄丢，刷格式也不该把一个地址复制到别的字上
 * （Word / Google 文档的清除格式同样保留超链接）。
 */
export const STYLE_MARKS = ['strong', 'emphasis', 'strike_through', 'inlineCode', 'kb_color'] as const

function styleMarkTypes(schema: Schema): MarkType[] {
  return STYLE_MARKS.map((name) => schema.marks[name]).filter((type): type is MarkType => !!type)
}

/**
 * 清除选区里的加粗、斜体、删除线、行内代码、字体、字色、底色；链接和段落格式（标题、列表）不动。
 * 空选区：只把「接下来要输入的字」的样式清掉（正打着粗体想停下来时按一下）；本来就没有样式时返回 false。
 */
export function clearFormatting(schema: Schema): Command {
  return (state, dispatch) => {
    const types = styleMarkTypes(schema)
    const { from, to, empty, $from } = state.selection
    if (empty) {
      const held = state.storedMarks ?? $from.marks()
      if (!held.some((mark) => types.includes(mark.type))) return false
      if (dispatch) dispatch(state.tr.setStoredMarks(held.filter((mark) => !types.includes(mark.type))))
      return true
    }
    if (!types.some((type) => state.doc.rangeHasMark(from, to, type))) return false
    if (dispatch) {
      const tr = state.tr
      for (const type of types) tr.removeMark(from, to, type)
      dispatch(tr)
    }
    return true
  }
}

/** 格式刷取样：选区（或光标处）第一段文字带的样式标记 */
export function styleMarksAt(state: EditorState): readonly Mark[] {
  const types = styleMarkTypes(state.schema)
  const { from, to, empty, $from } = state.selection
  let marks: readonly Mark[] = empty ? (state.storedMarks ?? $from.marks()) : []
  if (!empty) {
    let found = false
    state.doc.nodesBetween(from, to, (node) => {
      if (found) return false
      if (node.isText) {
        marks = node.marks
        found = true
        return false
      }
      return true
    })
  }
  return marks.filter((mark) => types.includes(mark.type))
}

/** 格式刷落笔：选区里原来的样式先清掉，再换成取样的那一套（取样是「无样式」时等于清除格式） */
export function applyStyleMarks(marks: readonly Mark[]): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection
    if (empty) return false
    if (dispatch) {
      const tr = state.tr
      for (const type of styleMarkTypes(state.schema)) tr.removeMark(from, to, type)
      for (const mark of marks) tr.addMark(from, to, mark)
      dispatch(tr)
    }
    return true
  }
}

/* ---------------- 代码块缩进 ---------------- */

/**
 * 代码块里一级缩进是什么：先看代码自己怎么缩进（有用 Tab 缩进的行就用 Tab；最小的空格缩进是 4 就用 4 个空格），
 * 没有线索时按语言习惯（Go 用 Tab，Python 4 空格），其余 2 空格。
 */
export function codeIndentUnit(text: string, language: string): string {
  let minSpaces = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('\t')) return '\t'
    const spaces = /^( +)\S/.exec(line)?.[1]?.length ?? 0
    if (spaces && (!minSpaces || spaces < minSpaces)) minSpaces = spaces
  }
  if (minSpaces === 4 || minSpaces === 8) return '    '
  if (minSpaces === 2) return '  '
  const lang = language.toLowerCase()
  if (lang === 'go' || lang === 'golang' || lang === 'makefile') return '\t'
  if (lang === 'python' || lang === 'py') return '    '
  return '  '
}

/**
 * 代码块里的 Tab / Shift+Tab：
 * - Tab：没选中文字时在光标处插一级缩进；选中了文字（单行或多行）时给选区碰到的每一行行首加一级；
 * - Shift+Tab：给光标所在行 / 选区碰到的每一行去掉一级（行首不够一级就去掉现有的空白）。
 * 光标不在代码块里返回 false，Tab 交给后面的命令（表格跳格、列表缩进）。
 */
export function indentCode(schema: Schema, direction: 1 | -1): Command {
  return (state, dispatch) => {
    const { $from, $to, empty } = state.selection
    const block = $from.parent
    if (block.type !== schema.nodes.code_block || $to.parent !== block) return false
    const unit = codeIndentUnit(block.textContent, String(block.attrs.language ?? ''))
    if (!dispatch) return true
    const tr = state.tr
    if (direction > 0 && empty) {
      dispatch(tr.insertText(unit).scrollIntoView())
      return true
    }
    const text = block.textContent
    const base = $from.start()
    const fromOffset = $from.parentOffset
    // 选区结束在某行行首（拖选整行时常见）时，那一行不算被选中
    const toOffset = !empty && $to.parentOffset > fromOffset && text[$to.parentOffset - 1] === '\n' ? $to.parentOffset - 1 : $to.parentOffset
    const starts: number[] = []
    for (let at = text.lastIndexOf('\n', fromOffset - 1) + 1; at <= toOffset; ) {
      starts.push(at)
      const next = text.indexOf('\n', at)
      if (next < 0 || next >= toOffset) break
      at = next + 1
    }
    // 从后往前改，前面行的位置不受后面改动影响
    for (const start of starts.reverse()) {
      if (direction > 0) {
        tr.insertText(unit, base + start)
        continue
      }
      const lead = /^[ \t]*/.exec(text.slice(start))?.[0] ?? ''
      const remove = lead.startsWith('\t') ? 1 : Math.min(lead.length, unit === '\t' ? 4 : unit.length)
      if (remove) tr.delete(base + start, base + start + remove)
    }
    if (!tr.docChanged) return true
    dispatch(tr.scrollIntoView())
    return true
  }
}
