/**
 * Markdown ⇄ ProseMirror 文档
 *
 * 为什么不用 `prosemirror-markdown`：
 * 1. 它的序列化器无法表达仓库的存储约定（`-` 列表、行尾两空格硬换行、紧凑表格、
 *    `[[双链]]` 不被转义），这些约定已在 utils/milkdownConfig.ts 里被真实笔记的历史数据固化。
 * 2. 我们需要 frontmatter / 原始 HTML 块「原样旁路」，上游默认会直接丢弃或转义。
 * 3. 解析侧用 markdown-it（仓库已有直接依赖、GFM 表格与删除线开箱可用），序列化侧自研，
 *    这样解析宽度与输出风格彼此独立，升级任一不影响另一侧。
 *
 * 保真策略（两层）：
 * - 快速路径：文档没被改动时直接回写原始字符串（TextSurface 负责），一个字节都不动。
 * - 序列化路径：改动后用本文件重新生成，风格与 milkdownConfig.ts 一致，diff 只落在改动处。
 */
import { joinImageWidth, splitImageWidth } from '@/utils/imageSize'
import MarkdownIt from 'markdown-it'
import { Node as PMNode, Schema } from 'prosemirror-model'
import { mathPlugin } from '@/utils/markdownMath'
import { COLOR_SPAN_CLOSE, colorSpanOpen, parsePaletteSpan, type ColorProp } from '@/utils/colorPalette'
import { MARK_ORDER, textSchema, type TableAlignment } from '../surfaces/text/schema'

/** markdown-it 的词法 token 结构（只声明用到的字段，避免依赖其内部类型命名） */
interface MdToken {
  type: string
  tag: string
  attrs?: [string, string][] | null
  content: string
  markup: string
  info: string
  hidden: boolean
  meta?: unknown
  children: MdToken[] | null
}

/**
 * 脚注：`[^label]: 内容` 定义块与 `[^label]` 引用。
 * 旧编辑器（remark-gfm）把它们解析成 footnote_definition / footnote_reference，协同房间里也是这两个节点；
 * 这边必须解析成同样的结构，否则新客户端初始化的房间在旧客户端里是一串字面文字，旧客户端保存时还会被转义。
 * 另一个原因：不认脚注时 `[^1]: http://x` 这种单词定义会被 markdown-it 当成链接引用定义直接吞掉——内容丢失。
 */
function footnotePlugin(instance: MarkdownIt): void {
  // 定义块要排在 reference 之前，否则会被当成链接引用定义
  instance.block.ruler.before(
    'reference',
    'kb_footnote_def',
    (state, startLine, endLine, silent) => {
      if (state.sCount[startLine] - state.blkIndent >= 4) return false
      const start = state.bMarks[startLine] + state.tShift[startLine]
      const first = state.src.slice(start, state.eMarks[startLine])
      const match = /^\[\^([^\]\s]+)\]:[ \t]?/.exec(first)
      if (!match) return false
      if (silent) return true
      const lines = [first.slice(match[0].length)]
      let next = startLine + 1
      const blank = (line: number) => state.bMarks[line] + state.tShift[line] >= state.eMarks[line]
      const indented = (line: number) => state.sCount[line] - state.blkIndent >= 4
      while (next < endLine) {
        if (blank(next)) {
          // 空行之后还有缩进行，才算同一个脚注的下一段
          let after = next + 1
          while (after < endLine && blank(after)) after += 1
          if (after < endLine && indented(after)) {
            for (; next < after; next += 1) lines.push('')
            continue
          }
          break
        }
        const raw = state.src.slice(state.bMarks[next], state.eMarks[next])
        if (indented(next)) {
          lines.push(raw.replace(/^(?: {1,4}|\t)/, ''))
          next += 1
          continue
        }
        // 懒续行：紧跟在文字后面、自己又不是新的块（标题 / 列表 / 引用 / 围栏 / 表格 / 另一个脚注）
        if (!/^\s*(?:#{1,6}\s|>|[-*+]\s|\d+[.)]\s|```|~~~|\||\[\^[^\]\s]+\]:)/.test(raw) && lines[lines.length - 1] !== '') {
          lines.push(raw.trimStart())
          next += 1
          continue
        }
        break
      }
      const token = state.push('kb_footnote_def', '', 0)
      token.block = true
      token.meta = { label: match[1] }
      token.content = lines.join('\n')
      token.map = [startLine, next]
      state.line = next
      return true
    },
    { alt: ['paragraph', 'reference'] },
  )
  // 引用：`[^label]`，排在 link 之前；后面紧跟 `(` 的是普通链接（文字恰好以 ^ 开头），不算
  instance.inline.ruler.before('link', 'kb_footnote_ref', (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x5b || state.src.charCodeAt(state.pos + 1) !== 0x5e) return false
    const match = /^\[\^([^\]\s]+)\](?!\()/.exec(state.src.slice(state.pos, state.posMax))
    if (!match) return false
    if (!silent) {
      const token = state.push('kb_footnote_ref', '', 0)
      token.meta = { label: match[1] }
    }
    state.pos += match[0].length
    return true
  })
}

const md = new MarkdownIt({
  // 允许手写 HTML：真实笔记里有 <details> / <video> 等结构，必须能原样保留
  html: true,
  // 不做 linkify：把裸 URL 自动变成链接会改写原文
  linkify: false,
  // 不启用 typographer：会把引号替换成弯引号，属于静默改写
  typographer: false,
  // 不把单个换行当 <br>；硬换行一律由行尾两空格显式表达
  breaks: false,
})
  // 公式与阅读态（MarkdownRead）共用同一套识别规则：`$...$` 行内、`$$...$$` 块级，币值写法不当公式
  .use(mathPlugin)
  .use(footnotePlugin)

/** 解析结果：文档 + 需要原样带回的旁路内容 */
export interface ParsedMarkdown {
  doc: PMNode
  /** frontmatter 原文（含首尾分隔符），没有则为 null */
  frontmatter: string | null
  /** 源文换行风格；保存时沿用，避免整个文件的行尾被改写 */
  eol: '\n' | '\r\n'
}

const FRONTMATTER = /^(?:\uFEFF)?(---|\+\+\+)[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*(?:\r?\n|$)/

/** 拆出 frontmatter；只认文件开头的 `---` / `+++` 块 */
export function splitFrontmatter(source: string): { frontmatter: string | null; body: string } {
  const match = FRONTMATTER.exec(source)
  if (!match) return { frontmatter: null, body: source }
  return { frontmatter: match[0].replace(/\r\n/g, '\n'), body: source.slice(match[0].length) }
}

/** 拆分正文后按 markdown-it 规则分词 */
function tokenize(body: string): MdToken[] {
  return md.parse(body, {}) as unknown as MdToken[]
}

/** 表格单元格对齐方式来自 markdown-it 写入的 style（表头与数据格都有，和旧编辑器一样逐格记录） */
function alignmentOf(token: MdToken): TableAlignment {
  const style = token.attrs?.find(([name]) => name === 'style')?.[1] ?? ''
  if (style.includes('center')) return 'center'
  if (style.includes('right')) return 'right'
  if (style.includes('left')) return 'left'
  return null
}

const LIST_ITEM_PREFIX = /^\[([ xX])\][ \t]/

/** markdown-it 关闭 token → schema 标记名 */
const CLOSE_TO_MARK: Record<string, string> = {
  strong_close: 'strong',
  em_close: 'emphasis',
  s_close: 'strike_through',
  link_close: 'link',
}

/** 预先配对颜色 span：成对出现的颜色 span（常用色或自定义 hex）变成 kb_color 标记，没闭合的按原样 HTML 保留 */
function pairColorSpans(children: MdToken[]): Map<number, { prop: ColorProp; key: string }> {
  const paired = new Map<number, { prop: ColorProp; key: string }>()
  const stack: { index: number; color: { prop: ColorProp; key: string } | null }[] = []
  children.forEach((child, index) => {
    if (child.type !== 'html_inline') return
    const value = child.content.trim()
    const open = parsePaletteSpan(value)
    if (open) {
      stack.push({ index, color: open })
      return
    }
    if (/^<span\b/i.test(value)) {
      stack.push({ index, color: null })
      return
    }
    if (COLOR_SPAN_CLOSE.test(value)) {
      const opened = stack.pop()
      if (opened?.color) {
        paired.set(opened.index, opened.color)
        paired.set(index, opened.color)
      }
    }
  })
  return paired
}

/**
 * 把 markdown-it 的 inline 子 token 转成 ProseMirror 行内节点序列。
 * 任务项复选框（`[ ] `）在块级处理，这里只处理行内标记。
 */
function buildInline(token: MdToken | null | undefined, schema: Schema): PMNode[] {
  if (!token?.children) return []
  const out: PMNode[] = []
  const marks: { name: string; attrs?: Record<string, unknown> }[] = []
  const colors = pairColorSpans(token.children)

  const currentMarks = () => {
    if (!marks.length) return undefined
    // 同一个标记可能出现多次（`****x****` 之类），ProseMirror 会保留重复 mark 并让往返后的
    // 标记数量变多，这里按名称去重（颜色按 prop 区分：字色和底色可以叠加），只保留最外层的一份
    const keyOf = (m: { name: string; attrs?: Record<string, unknown> }) => (m.name === 'kb_color' ? `kb_color:${String(m.attrs?.prop)}` : m.name)
    const unique = [...new Map(marks.map((m) => [keyOf(m), m])).values()]
    const result = unique.map((m) => schema.marks[m.name].create(m.attrs))
    // 按固定顺序规范化，比较时不受开启顺序影响
    result.sort((a, b) => MARK_ORDER.indexOf(a.type.name as never) - MARK_ORDER.indexOf(b.type.name as never))
    return result
  }
  const inlineNode = (name: string, attrs: Record<string, unknown>) => schema.node(name, attrs, undefined, currentMarks())

  token.children.forEach((child, index) => {
    switch (child.type) {
      case 'text':
        if (child.content) out.push(schema.text(child.content, currentMarks()))
        break
      case 'softbreak':
        // 段落内的普通换行：旧编辑器记成 isInline 的 hardbreak，保存时写回换行
        out.push(inlineNode('hardbreak', { isInline: true }))
        break
      case 'hardbreak':
        out.push(inlineNode('hardbreak', { isInline: false }))
        break
      case 'code_inline': {
        // addToSet 会按 excludes 规则挤掉与之互斥的强调标记
        const codeMarks = schema.marks.inlineCode.create().addToSet(currentMarks() ?? [])
        out.push(schema.text(child.content, codeMarks))
        break
      }
      case 'html_inline': {
        const color = colors.get(index)
        if (color) {
          if (COLOR_SPAN_CLOSE.test(child.content.trim())) {
            const at = marks.map((m) => m.name).lastIndexOf('kb_color')
            if (at >= 0) marks.splice(at, 1)
          } else {
            marks.push({ name: 'kb_color', attrs: color })
          }
          break
        }
        // 其它行内 HTML 原样保留成 html 节点（只显示源码，保存时一字不改）
        out.push(inlineNode('html', { value: child.content }))
        break
      }
      case 'strong_open':
        marks.push({ name: 'strong', attrs: { marker: child.markup.charAt(0) || '*' } })
        break
      case 'em_open':
        marks.push({ name: 'emphasis', attrs: { marker: child.markup.charAt(0) || '*' } })
        break
      case 's_open':
        marks.push({ name: 'strike_through' })
        break
      case 'link_open': {
        const attr = (name: string) => child.attrs?.find(([key]) => key === name)?.[1] ?? null
        marks.push({ name: 'link', attrs: { href: attr('href') ?? '', title: attr('title') } })
        break
      }
      case 'strong_close':
      case 'em_close':
      case 's_close':
      case 'link_close': {
        // markdown-it 用 `s` / `em` 表示删除线 / 斜体，schema 里沿用旧编辑器的名字，必须显式映射
        const name = CLOSE_TO_MARK[child.type]
        for (let i = marks.length - 1; i >= 0; i -= 1) {
          if (marks[i].name === name) {
            marks.splice(i, 1)
            break
          }
        }
        break
      }
      case 'image': {
        // markdown-it 把 alt 放在 token.content，src/title 放在 attrs
        const attr = (name: string) => child.attrs?.find(([key]) => key === name)?.[1] ?? ''
        // 地址里的 #w=宽度 拆成 width 属性（编辑器里图片显示成这个宽度；保存时再拼回去）
        const { src, width } = splitImageWidth(attr('src'))
        out.push(inlineNode('image', { src, alt: child.content || '', title: attr('title'), width }))
        break
      }
      case 'kb_math':
        out.push(inlineNode('math_inline', { value: child.content }))
        break
      case 'kb_footnote_ref':
        out.push(inlineNode('footnote_reference', { label: (child.meta as { label: string }).label }))
        break
      default:
        // 未识别的行内 token（emoji 等）：按纯文本兜底，宁可不美化也不要丢内容
        if (child.content) out.push(schema.text(child.content, currentMarks()))
        break
    }
  })
  return out
}

/** 从 i 开始找到与之配对的关闭 token 下标（同类型嵌套计数） */
function closingIndex(tokens: MdToken[], i: number, end: number): number {
  const open = tokens[i].type
  const close = open.replace(/_open$/, '_close')
  let depth = 1
  let j = i + 1
  while (j < end) {
    if (tokens[j].type === open) depth += 1
    else if (tokens[j].type === close) depth -= 1
    if (depth === 0) break
    j += 1
  }
  return j
}

/** 块级解析：把 token 流递归构造成块级节点数组 */
function buildBlocks(tokens: MdToken[], start: number, end: number, schema: Schema): PMNode[] {
  const out: PMNode[] = []
  let i = start

  const inlineAt = (index: number): MdToken | null => (tokens[index]?.type === 'inline' ? tokens[index] : null)

  while (i < end) {
    const token = tokens[i]

    switch (token.type) {
      case 'heading_open': {
        const level = Number(token.tag.slice(1)) || 1
        out.push(schema.node('heading', { level }, buildInline(inlineAt(i + 1), schema)))
        i += 3
        break
      }
      case 'paragraph_open': {
        // 列表内的紧凑段落带 hidden 标记，但结构上仍是段落
        out.push(schema.node('paragraph', null, buildInline(inlineAt(i + 1), schema)))
        i += 3
        break
      }
      case 'inline': {
        // 极少数情况下 inline 直接出现在顶层（例如 markdown-it 的 loose 输出）
        out.push(schema.node('paragraph', null, buildInline(token, schema)))
        i += 1
        break
      }
      case 'blockquote_open': {
        const j = closingIndex(tokens, i, end)
        out.push(schema.node('blockquote', null, buildBlocks(tokens, i + 1, j, schema)))
        i = j + 1
        break
      }
      case 'bullet_list_open':
      case 'ordered_list_open': {
        const ordered = token.type === 'ordered_list_open'
        const startAttr = token.attrs?.find(([key]) => key === 'start')?.[1]
        const order = startAttr ? Number(startAttr) : 1
        const j = closingIndex(tokens, i, end)
        // 紧凑列表（项内段落都是 hidden）旧编辑器记成 spread=false
        const spread = tokens.slice(i + 1, j).some((t) => t.type === 'paragraph_open' && !t.hidden)
        const items = buildListItems(tokens, i + 1, j, schema, { ordered, order, spread })
        out.push(schema.node(ordered ? 'ordered_list' : 'bullet_list', ordered ? { order, spread } : { spread }, items))
        i = j + 1
        break
      }
      case 'fence':
      case 'code_block': {
        const language = token.type === 'fence' ? (token.info.trim().split(/\s+/)[0] ?? '') : ''
        // 代码块内容必须原样保留，去掉 markdown-it 附加的收尾换行
        const content = token.content.replace(/\n$/, '')
        out.push(schema.node('code_block', { language }, content ? schema.text(content) : undefined))
        i += 1
        break
      }
      case 'kb_math': {
        // `$$...$$` 块级公式：旧编辑器把它当 language=LaTeX 的代码块；kbMath 让保存时写回 `$$`
        out.push(schema.node('code_block', { language: 'LaTeX', kbMath: true }, token.content ? schema.text(token.content) : undefined))
        i += 1
        break
      }
      case 'hr':
        out.push(schema.node('hr'))
        i += 1
        break
      case 'table_open': {
        const j = closingIndex(tokens, i, end)
        out.push(buildTable(tokens, i, j, schema))
        i = j + 1
        break
      }
      case 'html_block':
        // 块级原样 HTML：和旧编辑器一样落成「只含一个 html 节点的段落」
        out.push(schema.node('paragraph', null, schema.node('html', { value: token.content.replace(/\n$/, '') })))
        i += 1
        break
      case 'kb_footnote_def': {
        const label = (token.meta as { label: string }).label
        const inner = token.content ? tokenize(token.content) : []
        const body = buildBlocks(inner, 0, inner.length, schema)
        out.push(schema.node('footnote_definition', { label }, body.length ? body : [schema.node('paragraph')]))
        i += 1
        break
      }
      default:
        // thead_open / tbody_open 等由 buildTable 内部消费，其他未知 token 直接跳过
        i += 1
        break
    }
  }
  return out
}

/** 列表项：识别 `[ ]` / `[x]` 前缀并转成任务项；label / listType 与旧编辑器的显示属性一致 */
function buildListItems(
  tokens: MdToken[],
  start: number,
  end: number,
  schema: Schema,
  list: { ordered: boolean; order: number; spread: boolean },
): PMNode[] {
  const items: PMNode[] = []
  let i = start
  while (i < end) {
    if (tokens[i].type !== 'list_item_open') {
      i += 1
      continue
    }
    const j = closingIndex(tokens, i, end)
    const children = buildBlocks(tokens, i + 1, j, schema)
    let checked: boolean | null = null
    const first = children[0]
    if (first?.type.name === 'paragraph' && first.textContent) {
      const match = LIST_ITEM_PREFIX.exec(first.textContent)
      if (match) {
        checked = match[1].toLowerCase() === 'x'
        // 去掉复选框文字，只保留任务内容
        const stripped = first.textContent.slice(match[0].length)
        children[0] = schema.node('paragraph', null, stripped ? buildInlineFromText(stripped, first, schema) : [])
      }
    }
    const label = list.ordered ? `${list.order + items.length}.` : '•'
    items.push(
      schema.node(
        'list_item',
        { label, listType: list.ordered ? 'ordered' : 'bullet', spread: list.spread, checked },
        children.length ? children : [schema.node('paragraph')],
      ),
    )
    i = j + 1
  }
  return items
}

/** 前缀只出现在首个文本节点里；剥掉它并保留其余标记 */
function buildInlineFromText(_text: string, source: PMNode, schema: Schema): PMNode[] {
  const result: PMNode[] = []
  let consumed = false
  source.forEach((child) => {
    if (consumed) {
      result.push(child)
      return
    }
    if (child.isText && child.text) {
      consumed = true
      const rest = child.text.replace(LIST_ITEM_PREFIX, '')
      if (rest) result.push(schema.text(rest, child.marks))
      return
    }
    result.push(child)
  })
  return result.length ? result : [schema.text(_text)]
}

/** 表格：第一行是表头行（table_header_row），其余是数据行；每格都记对齐方式 */
function buildTable(tokens: MdToken[], start: number, end: number, schema: Schema): PMNode {
  const rows: PMNode[] = []
  let i = start + 1
  while (i < end) {
    if (tokens[i].type !== 'tr_open') {
      i += 1
      continue
    }
    const cells: PMNode[] = []
    let header = false
    let j = i + 1
    while (j < end && tokens[j].type !== 'tr_close') {
      const cellToken = tokens[j]
      if (cellToken.type === 'th_open' || cellToken.type === 'td_open') {
        header = cellToken.type === 'th_open'
        const inline = tokens[j + 1]?.type === 'inline' ? tokens[j + 1] : null
        cells.push(
          schema.node(header ? 'table_header' : 'table_cell', { alignment: alignmentOf(cellToken) }, schema.node('paragraph', null, buildInline(inline, schema))),
        )
        j += 1
      }
      j += 1
    }
    rows.push(schema.node(header ? 'table_header_row' : 'table_row', null, cells))
    i = j + 1
  }
  return schema.node('table', null, rows)
}

/** 解析 Markdown 源文为 ProseMirror 文档 */
export function parseMarkdown(source: string): ParsedMarkdown {
  const eol: '\n' | '\r\n' = source.includes('\r\n') ? '\r\n' : '\n'
  const normalized = source.replace(/\r\n/g, '\n')
  const { frontmatter, body } = splitFrontmatter(normalized)
  const tokens = tokenize(body)
  const blocks = buildBlocks(tokens, 0, tokens.length, textSchema)
  // 空文档也要有合法根节点；用空段落而不是空 doc，避免编辑器无法放置光标
  const doc = textSchema.node('doc', null, blocks.length ? blocks : [textSchema.node('paragraph')])
  return { doc, frontmatter, eol }
}

/** 一段文字重新解析时会不会被认成公式（`$a$`）：会的话保存时要转义 `$` */
function wouldParseAsMath(text: string): boolean {
  if (!text.includes('$')) return false
  return (md.parseInline(text, {}) as unknown as MdToken[]).some((token) => token.children?.some((child) => child.type === 'kb_math'))
}

/* ------------------------------- 序列化 ------------------------------- */

const MARK_OPEN: Record<string, (mark: PMNode['marks'][number]) => string> = {
  strong: () => '**',
  emphasis: () => '*',
  strike_through: () => '~~',
  link: () => '[',
  // 颜色写回 span（与旧编辑器、Typora / 语雀的写法一致；自定义色也写成同一个 6 位 hex）
  kb_color: (mark) => colorSpanOpen(mark.attrs.prop as ColorProp, String(mark.attrs.key)),
}

function closeMark(mark: PMNode['marks'][number]): string {
  switch (mark.type.name) {
    case 'strong':
      return '**'
    case 'emphasis':
      return '*'
    case 'strike_through':
      return '~~'
    case 'inlineCode':
      return '`'
    case 'kb_color':
      return '</span>'
    case 'link': {
      const href = String(mark.attrs.href ?? '')
      const title = mark.attrs.title ? ` "${String(mark.attrs.title)}"` : ''
      return `](${href}${title})`
    }
    default:
      return ''
  }
}

/**
 * 行内文本转义。
 * 只转义「真的会被重新解析成语法」的字符，避免 `snake_case`、`[[双链]]`、`A & B` 这类
 * 常见内容被加上反斜杠——那会让每次保存都产生无意义的 diff。
 */
export function escapeInlineText(text: string, options: { atLineStart?: boolean; inTableCell?: boolean } = {}): string {
  let out = ''
  let lineStart = options.atLineStart ?? false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const next = text[i + 1] ?? ''
    const prev = text[i - 1] ?? ''

    if (ch === '\n') {
      out += '\n'
      lineStart = true
      continue
    }

    if (ch === '\\') {
      out += '\\\\'
      lineStart = false
      continue
    }
    if (ch === '`') {
      out += '\\`'
      lineStart = false
      continue
    }
    if (ch === '*') {
      out += '\\*'
      lineStart = false
      continue
    }
    if (ch === '~' && next === '~') {
      out += '\\~'
      lineStart = false
      continue
    }
    if (ch === '_') {
      // 只有可能构成强调的 `_` 才转义；`ins_8b10` / `snake_case` 保持原样
      const beforeWord = /[A-Za-z0-9\u4e00-\u9fa5]/.test(prev)
      const afterWord = /[A-Za-z0-9\u4e00-\u9fa5]/.test(next)
      out += beforeWord && afterWord ? '_' : '\\_'
      lineStart = false
      continue
    }
    if (ch === '[') {
      // `[[双链]]` 不转义；只有可能被解析成链接的 `[x](…)` / `[x][…]` 才转义
      const rest = text.slice(i)
      if (/^\[[^\]\n]*\](?:\(|\[)/.test(rest)) out += '\\['
      else out += '['
      lineStart = false
      continue
    }
    if (ch === '<') {
      out += /^<[A-Za-z/!?]/.test(text.slice(i)) ? '\\<' : '<'
      lineStart = false
      continue
    }
    if (ch === '&') {
      out += /^&#?[A-Za-z0-9]+;/.test(text.slice(i)) ? '\\&' : '&'
      lineStart = false
      continue
    }
    if (ch === '|' && options.inTableCell) {
      out += '\\|'
      lineStart = false
      continue
    }
    if (lineStart) {
      // 行首可能被误认为块级语法：标题、引用、列表、围栏、序号
      if (ch === '#' || ch === '>') {
        out += `\\${ch}`
        lineStart = false
        continue
      }
      // 行首 `|` 会被当成表格行，必须转义，否则整段内容会在重解析时变成表格
      if (ch === '|') {
        out += '\\|'
        lineStart = false
        continue
      }
      if ((ch === '-' || ch === '+' || ch === '=') && (next === ' ' || next === '\t')) {
        out += `\\${ch}`
        lineStart = false
        continue
      }
      if (/[0-9]/.test(ch)) {
        const match = /^[0-9]+([.)])/.exec(text.slice(i))
        if (match) {
          const digits = match[0].length - 1
          out += `${text.slice(i, i + digits)}\\${match[1]}`
          i += digits
          lineStart = false
          continue
        }
      }
      lineStart = false
    }

    out += ch
  }
  return out
}


/** 行内节点序列 → Markdown 片段 */
function serializeInline(
  parent: PMNode,
  options: { inTableCell?: boolean; atLineStart?: boolean } = {},
): string {
  const nodes: PMNode[] = []
  parent.forEach((child) => nodes.push(child))

  const sortMarks = (node: PMNode) =>
    [...node.marks].sort(
      (a, b) => MARK_ORDER.indexOf(a.type.name as never) - MARK_ORDER.indexOf(b.type.name as never),
    )

  let out = ''
  let atLineStart = options.atLineStart ?? true
  let open: PMNode['marks'][number][] = []

  /** 收掉 open 里 target 之后的部分，返回需要重开的下标起点 */
  const closeTo = (target: readonly PMNode['marks'][number][]): number => {
    let common = 0
    while (common < open.length && common < target.length && open[common].type.name === target[common].type.name) {
      common += 1
    }
    for (let i = open.length - 1; i >= common; i -= 1) out += closeFor(open[i])
    open = open.slice(0, common)
    return common
  }

  /** 收尾符：代码段的围栏长度与补齐空格在开标记时已经算好，收尾必须用它 */
  const closeFor = (mark: PMNode['marks'][number]): string =>
    (mark as unknown as { _fence?: string })._fence ?? closeMark(mark)

  const openFrom = (target: readonly PMNode['marks'][number][], from: number, text: string): void => {
    for (let i = from; i < target.length; i += 1) {
      const mark = target[i]
      if (mark.type.name === 'inlineCode') {
        // 代码段内若含反引号，围栏要加长，否则会提前闭合
        const longest = /`+/.exec(text)
        const fence = '`'.repeat(Math.max(1, (longest?.[0].length ?? 0) + 1))
        // 内容以反引号开头/结尾时必须两侧各留一个空格，否则围栏会和内容粘在一起
        const pad = /^`|`$/.test(text) ? ' ' : ''
        out += `${fence}${pad}`
        ;(mark as unknown as { _fence?: string })._fence = `${pad}${fence}`
      } else {
        const opener = MARK_OPEN[mark.type.name]
        out += opener ? opener(mark) : ''
      }
      open.push(mark)
    }
  }

  for (let index = 0; index < nodes.length; index += 1) {
    const child = nodes[index]
    // 软换行（源文里的普通换行）旧编辑器记成 isInline 的 hardbreak；粘贴进来的文字里也可能直接带 '\n'
    const isSoftBreak = (child.type.name === 'hardbreak' && !!child.attrs.isInline) || (child.isText && child.text === '\n')
    const isHardBreak = child.type.name === 'hardbreak' && !child.attrs.isInline
    const nextMarks = sortMarks(nodes[index + 1] ?? child)

    if (isSoftBreak || isHardBreak) {
      // 换行处只收掉「下一段不再延续」的标记：把收尾符放在换行之前，
      // 否则 `**` 会落在行首（前一个字符是空白，无法闭合强调），重解析就变成字面量。
      const common = closeTo(nextMarks)
      open = open.slice(0, common)
      out += isHardBreak ? '  \n' : '\n'
      atLineStart = true
      continue
    }

    const marks = sortMarks(child)
    const common = closeTo(marks)
    openFrom(marks, common, child.text ?? '')

    if (child.type.name === 'image') {
      const alt = String(child.attrs.alt ?? '')
      const title = child.attrs.title ? ` "${String(child.attrs.title)}"` : ''
      out += `![${alt}](${joinImageWidth(String(child.attrs.src ?? ''), child.attrs.width as number | null)}${title})`
      atLineStart = false
    } else if (child.type.name === 'html') {
      // 原样 HTML，不加反斜杠
      out += String(child.attrs.value ?? '')
      atLineStart = false
    } else if (child.type.name === 'math_inline') {
      out += `$${String(child.attrs.value ?? '')}$`
      atLineStart = false
    } else if (child.type.name === 'footnote_reference') {
      out += `[^${String(child.attrs.label ?? '')}]`
      atLineStart = false
    } else if (child.marks.some((mark) => mark.type.name === 'inlineCode')) {
      // 代码段内不转义其它字符，但表格单元格里的 `|` 必须转义——GFM 先按 `|` 切单元格
      const raw = child.text ?? ''
      out += options.inTableCell ? raw.replace(/\|/g, '\\|') : raw
      atLineStart = false
    } else {
      let text = escapeInlineText(child.text ?? '', { atLineStart, inTableCell: options.inTableCell })
      // 文字里的 `$a$` 重新解析会变成公式：只在真会被误认时才转义 `$`，币值「$5 到 $9」保持原样
      if (wouldParseAsMath(text)) text = text.replace(/(?<!\\)\$/g, '\\$')
      out += text
      atLineStart = text.endsWith('\n')
    }
  }

  // 收尾：所有还开着的标记都关掉
  for (let i = open.length - 1; i >= 0; i -= 1) out += closeFor(open[i])
  return out
}

/** 有序列表缩进宽度：跟随最大序号宽度，避免 `10.` 换行后错位 */
function orderedIndent(start: number, count: number): number {
  const widest = `${start + count - 1}.`.length
  return Math.max(3, widest + 1)
}

function serializeCellContent(cell: PMNode): string {
  const parts: string[] = []
  cell.forEach((child) => {
    parts.push(serializeInline(child, { inTableCell: true, atLineStart: false }))
  })
  return parts.join('<br>')
}

function serializeTable(node: PMNode): string {
  const rows: PMNode[] = []
  node.forEach((row) => rows.push(row))
  if (!rows.length) return ''
  // 第一行是表头行（table_header_row）；对齐方式取表头格的（GFM 只在分隔行声明一次）
  const header = rows[0]
  const cellsOf = (row: PMNode) => {
    const cells: PMNode[] = []
    row.forEach((cell) => cells.push(cell))
    return cells
  }
  const headerCells = cellsOf(header)
  const padCell = (cell: PMNode) => ` ${serializeCellContent(cell)} `
  const lines = [
    `|${headerCells.map(padCell).join('|')}|`,
    `|${headerCells
      .map((cell) => {
        const alignment = cell.attrs.alignment as TableAlignment
        if (alignment === 'center') return ':---:'
        if (alignment === 'right') return '---:'
        if (alignment === 'left') return ':---'
        return '---'
      })
      .join('|')}|`,
  ]
  for (const row of rows.slice(1)) {
    lines.push(`|${cellsOf(row).map(padCell).join('|')}|`)
  }
  return lines.join('\n')
}

/** 单个块级节点 → Markdown（不含结尾空行） */
function serializeBlock(node: PMNode): string {
  switch (node.type.name) {
    case 'paragraph':
      return serializeInline(node)
    case 'heading': {
      const level = Number(node.attrs.level) || 1
      // 标题的 `# ` 前缀已经占用了行首，正文里的 `0.` 不能被当成有序列表
      return `${'#'.repeat(level)} ${serializeInline(node, { atLineStart: false })}`
    }
    case 'blockquote': {
      const inner = serializeBlocks(node)
      return inner
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n')
    }
    case 'bullet_list':
    case 'ordered_list': {
      const start = node.type.name === 'ordered_list' ? Number(node.attrs.order) || 1 : 1
      const indent = node.type.name === 'ordered_list' ? orderedIndent(start, node.childCount) : 2
      const items: string[] = []
      node.forEach((item, _offset, index) => {
        const marker = node.type.name === 'ordered_list' ? `${start + index}. ` : '- '
        items.push(serializeListItem(item, marker, indent, !node.attrs.spread))
      })
      // 松散列表（项与项之间有空行，spread=true）照原样留空行；以前一律压成紧凑列表，渲染间距会变
      return items.join(node.attrs.spread ? '\n\n' : '\n')
    }
    case 'code_block': {
      const content = node.textContent
      const language = String(node.attrs.language ?? '')
      // 原文是 `$$` 写法的块级公式，原样写回 `$$`（旧编辑器会改成 ```LaTeX 围栏）
      if (node.attrs.kbMath && language === 'LaTeX' && !content.includes('$$')) return `$$\n${content}\n$$`
      // 内容里出现连续反引号时用更长的围栏，避免提前闭合
      const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length))
      const fence = '`'.repeat(Math.max(3, longest + 1))
      return `${fence}${language}\n${content}\n${fence}`
    }
    case 'hr':
      return '---'
    case 'table':
      return serializeTable(node)
    case 'footnote_definition': {
      // 首块紧跟 `[^label]: `，后续行缩进 4 格（脚注续行的标准写法）
      const inner = serializeBlocks(node)
      return inner
        .split('\n')
        .map((line, index) => (index === 0 ? `[^${String(node.attrs.label ?? '')}]: ${line}` : line ? `    ${line}` : ''))
        .join('\n')
    }
    default:
      // 兜底：把子节点按块拼接，绝不丢内容
      return serializeBlocks(node)
  }
}

/** 能直接打断段落、不需要前置空行的块（紧凑列表里用单换行接在上一块后面，列表才不会变松散） */
function interruptsParagraph(node: PMNode): boolean {
  if (node.type.name === 'code_block') return !node.attrs.kbMath
  return ['heading', 'blockquote', 'bullet_list', 'ordered_list'].includes(node.type.name)
}

function serializeListItem(item: PMNode, marker: string, indentWidth: number, tightList: boolean): string {
  const blocks: string[] = []
  const nodes: PMNode[] = []
  item.forEach((child) => {
    blocks.push(serializeBlock(child))
    nodes.push(child)
  })
  const checked = item.attrs.checked as boolean | null
  const checkbox = checked == null ? '' : checked ? '[x] ' : '[ ] '
  const pad = ' '.repeat(indentWidth)
  // 嵌套列表要紧贴上一块，否则会被解析成另一个列表（松散列表语义会变）
  const joined = blocks.reduce((acc, block, index) => {
    if (index === 0) return block
    // 嵌套列表紧跟上一块（紧凑写法）；列表之后的普通段落必须留空行，
    // 否则会被当成上一个列表项的懒续行，结构就变了
    // 紧凑列表里，围栏代码 / 标题 / 引用也紧跟上一块：中间多一个空行会让整个列表变成松散列表
    // 围栏代码 / 标题自己就结束了，后面的段落也不需要空行（引用和嵌套列表之后不行：会被当成懒续行）
    const closesItself = (node: PMNode) => (node.type.name === 'code_block' && !node.attrs.kbMath) || node.type.name === 'heading'
    const tight =
      /^\s*(?:[-*+] |\d+\. )/.test(block) ||
      (tightList && (interruptsParagraph(nodes[index]) || (nodes[index].type.name === 'paragraph' && closesItself(nodes[index - 1]))))
    return `${acc}${tight ? '\n' : '\n\n'}${block}`
  }, '')
  return joined
    .split('\n')
    .map((line, index) => {
      // 首行紧跟列表标记；续行与嵌套块按列表缩进宽度对齐，嵌套列表才会落在父项内容下方
      if (index === 0) return `${marker}${checkbox}${line}`
      return line ? `${pad}${line}` : ''
    })
    .join('\n')
}

/** 块级节点数组 → Markdown 正文 */
export function serializeBlocks(parent: PMNode): string {
  const parts: string[] = []
  parent.forEach((child) => {
    // 空段落等价于空行，块之间本来就用空行分隔，直接略过即可
    if (child.type.name === 'paragraph' && !child.textContent && !child.childCount) return
    parts.push(serializeBlock(child))
  })
  return parts.join('\n\n')
}

/** 文档 + frontmatter → Markdown 源文 */
export function serializeMarkdown(doc: PMNode, options: { frontmatter?: string | null; eol?: '\n' | '\r\n' } = {}): string {
  const body = serializeBlocks(doc).replace(/\s+$/, '')
  // frontmatter 原文自带结尾换行，拼接前先削掉，否则会多出一个空行
  const frontmatter = options.frontmatter?.replace(/\n+$/, '') ?? ''
  const withFrontmatter = frontmatter ? `${frontmatter}\n\n${body}` : body
  const normalized = `${withFrontmatter}\n`
  return options.eol === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized
}

/**
 * 语义规范化：把文档拍平成「结构 + 属性 + 合并后的行内文本」。
 * 用途是比较两次序列化是否「语义相同」——ProseMirror 会把相邻同标记文本拆成多个节点，
 * 直接比 toJSON 会把这种无害差异误判成内容变化。
 */
export function canonicalizeDoc(doc: PMNode): unknown {
  const markKey = (marks: readonly PMNode['marks'][number][]) =>
    marks
      .map((mark) => `${mark.type.name}:${JSON.stringify(mark.attrs)}`)
      .sort()
      .join('|')

  const inlineRuns = (parent: PMNode): { type: string; marks: string; text?: string; attrs?: unknown }[] => {
    const runs: { type: string; marks: string; text?: string; attrs?: unknown }[] = []
    parent.forEach((child) => {
      if (child.isText) {
        const marks = markKey(child.marks)
        const last = runs[runs.length - 1]
        // 合并相邻同标记文本：这是 ProseMirror 的正常输出差异，不构成语义变化
        if (last && last.type === 'text' && last.marks === marks) {
          last.text = `${last.text ?? ''}${child.text ?? ''}`
        } else {
          runs.push({ type: 'text', marks, text: child.text ?? '' })
        }
        return
      }
      runs.push({ type: child.type.name, marks: markKey(child.marks), attrs: child.attrs })
    })
    return runs
  }

  const canon = (node: PMNode): unknown => {
    // 文本块（段落 / 标题 / 代码块）只有行内内容
    if (node.isTextblock) {
      return { type: node.type.name, attrs: node.attrs, inline: inlineRuns(node) }
    }
    const children: unknown[] = []
    node.forEach((child) => children.push(canon(child)))
    return { type: node.type.name, attrs: node.attrs, content: children }
  }

  return canon(doc)
}

/**
 * 字数：与页头、阅读态用同一个口径——`utils/docText.ts` 的 countWords（中日韩逐字、西文按词、
 * Markdown 标记与代码不计）。以前这里按「正文纯文本 + 空白分词」另算一套，编辑时页头 61 字、工具栏 64 字。
 * 入参是 Markdown 源文，不是纯文本。
 */
export { countWords } from '@/utils/docText'
