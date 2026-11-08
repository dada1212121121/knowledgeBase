/**
 * 插入类命令单测：提示块 / 流程图 / 公式块 / 字色底色 / 链接回填 / 任务项勾选
 *
 * 不挂 DOM：用 EditorState 驱动命令，再经 serializeMarkdown 看「保存出来的 Markdown 是什么」，
 * 这才是这些命令对用户的真实影响（旧编辑器同样是以 Markdown 为准）。
 */
import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection, type Command } from 'prosemirror-state'
import { parseMarkdown, serializeMarkdown } from '@/editor/codecs/markdown'
import {
  insertBlocks,
  insertCallout,
  insertDiagram,
  insertMathBlock,
  linkAtSelection,
  setColor,
  setLink,
  toggleTaskItemAt,
} from '@/editor/surfaces/text/commands'
import { textSchema } from '@/editor/surfaces/text/schema'

function stateFor(markdown: string): EditorState {
  return EditorState.create({ doc: parseMarkdown(markdown).doc })
}
function run(state: EditorState, command: Command): { ok: boolean; state: EditorState } {
  let next = state
  const ok = command(state, (tr) => {
    next = state.apply(tr)
  })
  return { ok, state: next }
}
function select(state: EditorState, from: number, to = from): EditorState {
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)))
}
const md = (state: EditorState) => serializeMarkdown(state.doc, { frontmatter: null, eol: '\n' })

describe('提示块 / 流程图 / 公式块', () => {
  it('1. 空段落里插入提示块：整段替换，保存出 > [!NOTE] 引用块', () => {
    const state = stateFor('')
    const result = run(state, insertCallout(textSchema, 'note'))
    expect(result.ok).toBe(true)
    expect(md(result.state)).toContain('> [!NOTE]')
    expect(md(result.state)).toContain('在这里写说明内容')
    // 顶层第一块就是引用块，没有残留的空段落挤在前面
    expect(result.state.doc.firstChild?.type.name).toBe('blockquote')
  })

  it('2. 五种提示块各自带正确的标记与中文标签', () => {
    for (const [type, label] of [
      ['note', '说明'],
      ['tip', '提示'],
      ['important', '重要'],
      ['warning', '注意'],
      ['caution', '警告'],
    ] as const) {
      const out = md(run(stateFor(''), insertCallout(textSchema, type)).state)
      expect(out).toContain(`> [!${type.toUpperCase()}]`)
      expect(out).toContain(`在这里写${label}内容`)
    }
  })

  it('3. 在有内容的段落里插入：放到当前块之后，原文不动，末尾仍有可落光标的段落', () => {
    const state = select(stateFor('第一段'), 2)
    const result = run(state, insertCallout(textSchema, 'tip'))
    expect(result.ok).toBe(true)
    expect(result.state.doc.child(0).textContent).toBe('第一段')
    expect(result.state.doc.child(1).type.name).toBe('blockquote')
    expect(result.state.doc.lastChild?.type.name).toBe('paragraph')
  })

  it('4. 流程图是 mermaid 代码块，保存成围栏代码块', () => {
    const result = run(stateFor(''), insertDiagram(textSchema))
    expect(result.ok).toBe(true)
    const node = result.state.doc.firstChild!
    expect(node.type.name).toBe('code_block')
    expect(node.attrs.language).toBe('mermaid')
    expect(md(result.state)).toMatch(/```mermaid\nflowchart LR/)
  })

  it('5. 公式块保存成 $$ 写法（kbMath），不是 ```LaTeX 围栏', () => {
    const result = run(stateFor(''), insertMathBlock(textSchema))
    expect(result.ok).toBe(true)
    const node = result.state.doc.firstChild!
    expect(node.attrs).toMatchObject({ language: 'LaTeX', kbMath: true })
    expect(md(result.state)).toContain('$$\nE = mc^2\n$$')
  })

  it('6. 放不下块级节点的位置（表格单元格）返回 false，不写出非法文档', () => {
    const state = stateFor('| a | b |\n| - | - |\n| 1 | 2 |')
    // 光标放进第一个单元格的段落里
    let inCell = -1
    state.doc.descendants((node, pos) => {
      if (inCell < 0 && node.type.name === 'table_header') inCell = pos + 2
      return true
    })
    const result = run(select(state, inCell), insertCallout(textSchema, 'note'))
    expect(result.ok).toBe(false)
  })

  it('7. insertBlocks 没有节点时返回 false', () => {
    expect(run(stateFor('a'), insertBlocks(textSchema, [])).ok).toBe(false)
  })
})

describe('字色 / 底色', () => {
  it('8. 选区加字色，保存成 <span style="color: …">', () => {
    const state = select(stateFor('红色文字'), 1, 3)
    const result = run(state, setColor(textSchema, 'color', 'red'))
    expect(result.ok).toBe(true)
    expect(md(result.state)).toContain('<span style="color: #e5484d">红色</span>文字')
  })

  it('9. 同一段文字再换一种字色：旧的被替换而不是叠加', () => {
    let state = select(stateFor('文字'), 1, 3)
    state = run(state, setColor(textSchema, 'color', 'red')).state
    state = select(state, 1, 3)
    state = run(state, setColor(textSchema, 'color', 'blue')).state
    const out = md(state)
    expect(out).toContain('#0090ff')
    expect(out).not.toContain('#e5484d')
  })

  it('10. 字色与底色可以叠加，key 为空清除对应 prop', () => {
    let state = select(stateFor('文字'), 1, 3)
    state = run(state, setColor(textSchema, 'color', 'red')).state
    state = select(state, 1, 3)
    state = run(state, setColor(textSchema, 'background-color', 'yellow')).state
    expect(md(state)).toContain('#e5484d')
    expect(md(state)).toContain('#fff3a3')
    state = select(state, 1, 3)
    state = run(state, setColor(textSchema, 'color', null)).state
    expect(md(state)).not.toContain('#e5484d')
    expect(md(state)).toContain('#fff3a3')
  })

  it('自定义色接受 6 位 hex，统一小写成小写 #rrggbb 并原样往返', () => {
    const state = select(stateFor('自定义色'), 1, 4)
    const result = run(state, setColor(textSchema, 'color', '#ABCDEF'))
    expect(result.ok).toBe(true)
    expect(md(result.state)).toContain('<span style="color: #abcdef">自定义</span>色')
    const parsed = parseMarkdown(md(result.state))
    expect(parsed.doc.child(0).child(0).marks[0]?.attrs.key).toBe('#abcdef')
  })

  it('12. 空选区没有可上色的文字，返回 false', () => {
    expect(run(select(stateFor('文字'), 2), setColor(textSchema, 'color', 'red')).ok).toBe(false)
  })
})

describe('链接回填与编辑', () => {
  const doc = '前 [链接](https://a.example) 后'

  it('12. 光标在链接文字里：读出整条链接的范围与地址', () => {
    const state = select(stateFor(doc), 4)
    const found = linkAtSelection(state)
    expect(found?.href).toBe('https://a.example')
    expect(state.doc.textBetween(found!.from, found!.to)).toBe('链接')
  })

  it('13. 光标不在链接里：读不到', () => {
    expect(linkAtSelection(select(stateFor(doc), 1))).toBeNull()
  })

  it('14. 光标在链接里直接改地址：改的是整条链接，不是只给空选区挂待输入标记', () => {
    const state = select(stateFor(doc), 4)
    const result = run(state, setLink(textSchema, 'https://b.example'))
    expect(result.ok).toBe(true)
    expect(md(result.state)).toContain('[链接](https://b.example)')
    expect(md(result.state)).not.toContain('a.example')
  })

  it('15. 光标在链接里移除链接：整条链接变回普通文字', () => {
    const state = select(stateFor(doc), 4)
    const result = run(state, setLink(textSchema, ''))
    expect(md(result.state)).toContain('前 链接 后')
  })

  it('16. 危险协议仍然拒绝', () => {
    expect(run(select(stateFor(doc), 4), setLink(textSchema, 'javascript:alert(1)')).ok).toBe(false)
  })
})

describe('任务项勾选', () => {
  it('17. 点复选框等价的命令：未勾 ↔ 已勾，保存成 [x]', () => {
    let state = stateFor('- [ ] 买菜')
    let itemPos = -1
    state.doc.descendants((node, pos) => {
      if (node.type.name === 'list_item') itemPos = pos
      return true
    })
    state = run(state, toggleTaskItemAt(itemPos)).state
    expect(md(state)).toContain('- [x] 买菜')
    state = run(state, toggleTaskItemAt(itemPos)).state
    expect(md(state)).toContain('- [ ] 买菜')
  })

  it('18. 普通列表项不是任务项，不能被勾选', () => {
    const state = stateFor('- 普通')
    let itemPos = -1
    state.doc.descendants((node, pos) => {
      if (node.type.name === 'list_item') itemPos = pos
      return true
    })
    expect(run(state, toggleTaskItemAt(itemPos)).ok).toBe(false)
  })
})
