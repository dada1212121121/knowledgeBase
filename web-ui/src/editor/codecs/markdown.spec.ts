/**
 * Markdown codec 契约测试
 *
 * 这些用例是「存储格式的自由度清单」：每一条都对应一次真实的往返风险。
 * 断言分两类：
 * - 字节级：未改动时输出必须与输入完全相同（保真快速路径的前提）；
 * - 语义级：规范化后的结构必须相同（允许 `*` 列表被规整成 `-`、表格空格补齐等风格差异）。
 */
import { describe, expect, it } from 'vitest'
import { Node as PMNode } from 'prosemirror-model'
import {
  canonicalizeDoc,
  countWords,
  escapeInlineText,
  parseMarkdown,
  serializeMarkdown,
  splitFrontmatter,
} from '@/editor/codecs/markdown'

/** 打开 → 关闭（一次往返） */
function roundtrip(source: string): string {
  const parsed = parseMarkdown(source)
  return serializeMarkdown(parsed.doc, { frontmatter: parsed.frontmatter, eol: parsed.eol })
}

/** 往返两次：用于发现「第一次能过、第二次漂移」的序列化器 bug */
function roundtripTwice(source: string): { once: string; twice: string } {
  const once = roundtrip(source)
  return { once, twice: roundtrip(once) }
}

describe('markdown codec 字节级保真', () => {
  it('1. 普通笔记一次往返字节相同', () => {
    const source = ['# 标题', '', '一段正文，带 `行内代码` 和 **加粗**。', '', '- 列表项一', '- 列表项二', ''].join('\n')
    expect(roundtrip(source)).toBe(source)
  })

  it('2. 列表统一用 `-`（milkdownConfig 的既定契约）', () => {
    expect(roundtrip('* 甲\n* 乙\n')).toBe('- 甲\n- 乙\n')
  })

  it('3. 硬换行写成行尾两个空格，且能读回来', () => {
    const source = '第一行  \n第二行\n'
    expect(roundtrip(source)).toBe(source)
    const parsed = parseMarkdown(source)
    const paragraph = parsed.doc.child(0)
    const types: string[] = []
    paragraph.forEach((child) => types.push(child.type.name))
    expect(types).toContain('hardbreak')
  })

  it('4. 表格保持紧凑形式：单元格两侧各一个空格、分隔行 `|---|`', () => {
    const source = ['| 列一 | 列二 |', '|---|---|', '| `a` | b |', ''].join('\n')
    expect(roundtrip(source)).toBe(source)
  })

  it('5. frontmatter 原样保留（含 `---` 分隔符）', () => {
    const source = ['---', 'title: 测试', 'tags: [a, b]', '---', '', '# 正文', ''].join('\n')
    expect(roundtrip(source)).toBe(source)
    expect(splitFrontmatter(source).frontmatter).toContain('tags: [a, b]')
  })

  it('6. 手写 HTML 块原样旁路，不被转义成文本', () => {
    const source = ['<details>', '<summary>展开</summary>', '', '内部说明', '', '</details>', ''].join('\n')
    const out = roundtrip(source)
    expect(out).toContain('<details>')
    expect(out).not.toContain('&lt;details&gt;')
  })

  it('7. `[[双链]]`、`snake_case`、`A & B` 不被转义', () => {
    const source = '见 [[另一篇笔记]] 的 snake_case 字段，以及 A & B 两个条件。\n'
    expect(roundtrip(source)).toBe(source)
  })

  it('8. 代码段里的反引号按「最长连串 + 1」加长围栏', () => {
    const source = '```` ```mermaid ````\n'
    const out = roundtrip(source)
    expect(out).toContain('```mermaid')
  })

  it('9. 表格单元格里的代码含 `|` 时必须转义，不能把单元格切断', () => {
    const source = ['| 命令 | 说明 |', '|---|---|', '| `grep -E "a|b"` | 过滤 |', ''].join('\n')
    const out = roundtrip(source)
    const parsed = parseMarkdown(out)
    const table = parsed.doc.child(0)
    expect(table.type.name).toBe('table')
    expect(table.child(0).childCount).toBe(2)
  })

  it('10. CRLF 文件往返后仍是 CRLF', () => {
    const source = '# 标题\r\n\r\n正文\r\n'
    expect(roundtrip(source)).toBe(source)
  })

  it('11. 末尾换行只保留一个（多余空行会被裁掉）', () => {
    expect(roundtrip('# 标题\n\n\n')).toBe('# 标题\n')
  })
})

describe('markdown codec 结构', () => {
  it('12. 嵌套列表：子列表紧贴父项，不额外空行', () => {
    const source = ['- 父项', '  - 子项一', '  - 子项二', '- 父项二', ''].join('\n')
    expect(roundtrip(source)).toBe(source)
  })

  it('13. 任务列表：`- [ ]` / `- [x]` 往返保持勾选状态', () => {
    const source = ['- [ ] 待办', '- [x] 已办', ''].join('\n')
    expect(roundtrip(source)).toBe(source)
    const parsed = parseMarkdown(source)
    const items: boolean[] = []
    parsed.doc.child(0).forEach((item) => items.push(item.attrs.checked))
    expect(items).toEqual([false, true])
  })

  it('14. 有序列表保留起始序号', () => {
    const source = ['3. 三', '4. 四', ''].join('\n')
    expect(roundtrip(source)).toBe(source)
    expect(parseMarkdown(source).doc.child(0).attrs.order).toBe(3)
  })

  it('15. 引用块内的多段落往返不变', () => {
    const source = ['> 第一段', '>', '> 第二段', ''].join('\n')
    expect(roundtrip(source)).toBe(source)
  })

  it('16. 链接与图片（含 title）往返不变', () => {
    const source = '见 [文档](https://example.com/a "标题") 与 ![图](https://example.com/i.png)。\n'
    expect(roundtrip(source)).toBe(source)
  })

  it('16b. 图片宽度（地址里的 #w=）拆成 width 属性，保存时原样拼回；没有宽度的图片不受影响', () => {
    const source = '![图](https://example.com/i.png#w=320 "标题") 和 ![另一张](./b.png)\n'
    expect(roundtrip(source)).toBe(source)
    const images: { src: string; width: number | null }[] = []
    parseMarkdown(source).doc.descendants((node) => {
      if (node.type.name === 'image') images.push({ src: node.attrs.src as string, width: node.attrs.width as number | null })
    })
    expect(images).toEqual([
      { src: 'https://example.com/i.png', width: 320 },
      { src: './b.png', width: null },
    ])
  })

  it('17. 重复的强调标记（`****x****`）不会在往返中增殖', () => {
    const source = '****重复****\n'
    const once = roundtrip(source)
    expect(roundtrip(once)).toBe(once)
  })

  it('18. 表格对齐方式保留', () => {
    const source = ['| 左 | 中 | 右 |', '|:---|:---:|---:|', '| a | b | c |', ''].join('\n')
    const out = roundtrip(source)
    expect(out).toContain(':---:')
    expect(out).toContain('---:')
  })

  it('19. 行内 HTML 原样保留', () => {
    const source = '按下 <kbd>Ctrl</kbd> 加上 <kbd>S</kbd> 保存。\n'
    expect(roundtrip(source)).toBe(source)
  })

  it('20. 列表项以引用/代码块开头时仍是同一个列表项', () => {
    const source = ['- > 引用开头的项', '- ```', '  code', '  ```', ''].join('\n')
    const parsed = parseMarkdown(source)
    expect(parsed.doc.child(0).childCount).toBe(2)
    const out = roundtrip(source)
    expect(parseMarkdown(out).doc.child(0).childCount).toBe(2)
  })

  it('21. 序列化是幂等的：两次往返结果相同', () => {
    const source = ['## 小节', '', '1. 一步', '2. 两步', '', '> 引用', '', '```ts', 'const a = 1', '```', ''].join('\n')
    const { once, twice } = roundtripTwice(source)
    expect(twice).toBe(once)
  })
})

describe('markdown codec 边界', () => {
  it('22. 空文档解析成单个空段落，不抛异常', () => {
    const parsed = parseMarkdown('')
    expect(parsed.doc.childCount).toBe(1)
    expect(parsed.doc.child(0).type.name).toBe('paragraph')
  })

  it('23. 只有 frontmatter 的文档不会丢掉 frontmatter', () => {
    const source = ['---', 'title: 只有头', '---', ''].join('\n')
    expect(roundtrip(source)).toContain('title: 只有头')
  })

  it('24. 行首 `|`、`#`、`-`、`1.` 在段落里必须转义，否则重解析会变成新块', () => {
    const source = '| 不是表格\n# 不是标题\n- 不是列表\n1. 不是有序列表\n'
    const parsed = parseMarkdown('段落开始\n\n' + source)
    const out = serializeMarkdown(parsed.doc)
    const again = parseMarkdown(out)
    expect(canonicalizeDoc(again.doc)).toEqual(canonicalizeDoc(parsed.doc))
  })

  it('25. escapeInlineText 只转义会被重解析的字符', () => {
    expect(escapeInlineText('a & b')).toBe('a & b')
    expect(escapeInlineText('snake_case')).toBe('snake_case')
    expect(escapeInlineText('[[双链]]')).toBe('[[双链]]')
    expect(escapeInlineText('# 标题', { atLineStart: true })).toBe('\\# 标题')
  })

  it('26. countWords：CJK 按字、西文按词，Markdown 标记与代码不计（与页头、阅读态同一口径）', () => {
    expect(countWords('中文四个字')).toBe(5)
    expect(countWords('hello world')).toBe(2)
    expect(countWords('中文 mixed words 混排')).toBe(6)
    // 以前编辑器按纯文本计：`kb search` 算 2 个词、`→` 这类符号也算 1 个，和页头对不上
    expect(countWords('守护进程 `kb search` 连接 → 失败')).toBe(8)
  })

  it('27. canonicalizeDoc 合并相邻同标记文本，纯文本等价不算语义变化', () => {
    const a = parseMarkdown('一句话里有**加粗**部分。\n').doc
    const schema = a.type.schema
    // 手工造一份「加粗被拆成两个 mark 节点」的等价文档
    const paragraph = schema.nodes.paragraph.create(null, [
      schema.text('一句话里有'),
      schema.text('加', [schema.marks.strong.create()]),
      schema.text('粗', [schema.marks.strong.create()]),
      schema.text('部分。'),
    ])
    const b = schema.nodes.doc.create(null, [paragraph])
    expect(canonicalizeDoc(b)).toEqual(canonicalizeDoc(a))
  })

  it('28. 大文档（>1000 块）往返仍正确，不触发递归爆栈', () => {
    const blocks: string[] = []
    for (let i = 0; i < 1200; i += 1) blocks.push(`第 ${i} 段，含 \`code\` 与 **粗体**。`, '')
    const source = blocks.join('\n')
    const parsed = parseMarkdown(source)
    const out = serializeMarkdown(parsed.doc)
    expect(canonicalizeDoc(parseMarkdown(out).doc)).toEqual(canonicalizeDoc(parsed.doc))
  })

  it('29. 序列化结果可以被再次解析成 PM 文档（schema 自身一致）', () => {
    const parsed = parseMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n> 引用\n\n- [x] 完成\n')
    const out = serializeMarkdown(parsed.doc)
    expect(() => PMNode.fromJSON(parsed.doc.type.schema, parseMarkdown(out).doc.toJSON())).not.toThrow()
  })
})

/** 文档里出现过的节点名（深度优先） */
function nodeTypes(doc: PMNode): string[] {
  const names: string[] = []
  doc.descendants((node) => {
    names.push(node.type.name)
  })
  return names
}

describe('markdown codec：与旧编辑器房间格式一致的语法', () => {
  it('30. 脚注定义与引用解析成 footnote 节点并原样写回；单词定义不再被当成链接引用吞掉', () => {
    const source = '正文引用[^1]和[^note]。\n\n[^1]: http://example.com\n\n[^note]: 第二个脚注,\n    带续行。\n'
    const parsed = parseMarkdown(source)
    expect(nodeTypes(parsed.doc).filter((name) => name.startsWith('footnote'))).toEqual([
      'footnote_reference',
      'footnote_reference',
      'footnote_definition',
      'footnote_definition',
    ])
    expect(roundtrip(source)).toBe(source)
  })

  it('31. 行内公式与 `$$` 公式块：结构与旧编辑器一致（math_inline / LaTeX 代码块），写回仍是 `$`/`$$`', () => {
    const source = '质能 $E=mc^2$ 公式。\n\n$$\n\\int_0^1 x\\,dx\n$$\n'
    const parsed = parseMarkdown(source)
    expect(parsed.doc.child(0).child(1).type.name).toBe('math_inline')
    expect(parsed.doc.child(1).type.name).toBe('code_block')
    expect(parsed.doc.child(1).attrs.language).toBe('LaTeX')
    expect(roundtrip(source)).toBe(source)
    // 旧编辑器保存过的 ```LaTeX 围栏保持围栏写法，不被改成 `$$`
    const fenced = '```LaTeX\nx^2\n```\n'
    expect(roundtrip(fenced)).toBe(fenced)
  })

  it('32. 币值不是公式；文字里会被误认成公式的 `$` 保存时才转义', () => {
    const price = '价格 $5 到 $9。\n'
    expect(nodeTypes(parseMarkdown(price).doc)).not.toContain('math_inline')
    expect(roundtrip(price)).toBe(price)
    const schema = parseMarkdown('').doc.type.schema
    const typed = schema.node('doc', null, [schema.node('paragraph', null, schema.text('变量 a$b$c 不是公式'))])
    const saved = serializeMarkdown(typed)
    expect(saved).toContain('\\$')
    expect(nodeTypes(parseMarkdown(saved).doc)).not.toContain('math_inline')
  })

  it('33. 常用色映射回 key、自定义 6 位色原样作为 key；没闭合 / 非颜色 span 原样保留', () => {
    const colored = '<span style="color: #e5484d">红字</span>与<span style="background-color: #fff3a3">黄底</span>\n'
    const parsed = parseMarkdown(colored)
    const marks = parsed.doc.child(0).child(0).marks.map((mark) => `${mark.type.name}:${String(mark.attrs.key)}`)
    expect(marks).toEqual(['kb_color:red'])
    expect(roundtrip(colored)).toBe(colored)
    // 自定义色不再退回原样 HTML：整段变成 kb_color 标记，key 就是 hex
    const custom = '<span style="color: #123456">自定义</span>与<span style="background-color: #ABCDEF">自定义底</span>\n'
    const customParsed = parseMarkdown(custom)
    const customMarks = customParsed.doc.child(0).content.content.map((node) => node.marks.map((mark) => `${mark.type.name}:${String(mark.attrs.key)}`).join(','))
    expect(customMarks).toEqual(['kb_color:#123456', '', 'kb_color:#abcdef'])
    // 规范化成小写写回，别的软件写大写也不会产生两份
    expect(roundtrip(custom)).toBe('<span style="color: #123456">自定义</span>与<span style="background-color: #abcdef">自定义底</span>\n')
    for (const raw of ['<span style="color: #e5484d">没闭合\n', '<span class="a">x</span>\n']) {
      expect(nodeTypes(parseMarkdown(raw).doc)).toContain('html')
      expect(roundtrip(raw)).toBe(raw)
    }
  })

  it('33b. 字体 span（font-family 取表里的字体栈）变成 kb_color(font-family) 标记并原样写回；不在表里的字体原样保留', () => {
    const source = '<span style="font-family: Songti SC, SimSun, Noto Serif SC, serif">宋体字</span>和<span style="font-family: Kaiti SC, KaiTi, STKaiti, serif">楷体字</span>\n'
    const parsed = parseMarkdown(source)
    const marks = parsed.doc.child(0).content.content.map((node) => node.marks.map((mark) => `${String(mark.attrs.prop)}:${String(mark.attrs.key)}`).join(','))
    expect(marks).toEqual(['font-family:serif', '', 'font-family:kai'])
    expect(roundtrip(source)).toBe(source)
    // 带引号 / 大小写、空格不同的写法也认得（别的软件改过格式），写回时统一成表里的写法
    const loose = '<span style="font-family: \'SONGTI SC\',SimSun , Noto Serif SC,serif;">甲</span>\n'
    expect(parseMarkdown(loose).doc.child(0).child(0).marks[0]?.attrs.key).toBe('serif')
    const foreign = '<span style="font-family: Comic Sans MS">丙</span>\n'
    expect(nodeTypes(parseMarkdown(foreign).doc)).toContain('html')
    expect(roundtrip(foreign)).toBe(foreign)
  })

  it('34. 行内 / 块级原样 HTML 都是 html 节点（块级时单独占一个段落），一字不改写回', () => {
    const source = '按 <kbd>Ctrl</kbd> 键\n\n<details>\n<summary>折叠</summary>\n\n内部段落\n\n</details>\n'
    const parsed = parseMarkdown(source)
    expect(parsed.doc.child(1).type.name).toBe('paragraph')
    expect(parsed.doc.child(1).childCount).toBe(1)
    expect(parsed.doc.child(1).child(0).type.name).toBe('html')
    expect(roundtrip(source)).toBe(source)
  })

  it('35. 段落内软换行是 isInline 的 hardbreak，写回仍是普通换行', () => {
    const source = '第一行\n第二行\n'
    const paragraph = parseMarkdown(source).doc.child(0)
    expect(paragraph.child(1).type.name).toBe('hardbreak')
    expect(paragraph.child(1).attrs.isInline).toBe(true)
    expect(roundtrip(source)).toBe(source)
  })

  it('36. 表格是表头行 + 数据行，数据格按列记对齐方式', () => {
    const table = parseMarkdown('| a | b |\n|:---|---|\n| 1 | 2 |\n').doc.child(0)
    expect([table.child(0).type.name, table.child(1).type.name]).toEqual(['table_header_row', 'table_row'])
    expect(table.child(1).child(0).attrs.alignment).toBe('left')
    expect(table.child(1).child(1).attrs.alignment).toBeNull()
  })

  it('37. 松散列表保持项间空行；紧凑列表里的围栏代码不插空行（否则列表会变松散）', () => {
    const loose = '- 第一项\n\n- 第二项\n'
    expect(parseMarkdown(loose).doc.child(0).attrs.spread).toBe(true)
    expect(roundtrip(loose)).toBe(loose)
    const tight = '- 命令:\n  ```bash\n  npm test\n  ```\n  跑完再看。\n- 第二项\n'
    expect(parseMarkdown(tight).doc.child(0).attrs.spread).toBe(false)
    expect(roundtrip(tight)).toBe(tight)
  })

  it('38. 有序列表项带旧编辑器的显示属性（label / listType），往返不变', () => {
    const list = parseMarkdown('3. 甲\n4. 乙\n').doc.child(0)
    expect(list.attrs.order).toBe(3)
    expect([list.child(0).attrs.label, list.child(1).attrs.label, list.child(0).attrs.listType]).toEqual(['3.', '4.', 'ordered'])
  })
})
