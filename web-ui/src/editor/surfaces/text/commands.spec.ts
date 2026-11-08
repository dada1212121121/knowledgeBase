/**
 * 文本命令单测
 *
 * 这一层不挂 DOM：直接拿 `EditorState` 驱动命令，验证「按钮按下去文档到底变成什么」。
 * 这样工具栏、斜杠菜单、快捷键共用同一套命令时，行为不会因为入口不同而漂移。
 */
import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { parseMarkdown } from '@/editor/codecs/markdown'
import {
  activeMarks,
  currentBlock,
  insertHorizontalRule,
  insertImageNode,
  insertTable,
  isInNode,
  isSafeHref,
  setHeadingLevel,
  setLink,
  toggleBlockquote,
  toggleInlineMark,
  toggleListKind,
  toggleTaskList,
} from '@/editor/surfaces/text/commands'
import { textSchema } from '@/editor/surfaces/text/schema'
import type { Command } from 'prosemirror-state'

function stateFor(markdown: string): EditorState {
  return EditorState.create({ doc: parseMarkdown(markdown).doc })
}

/** 跑一条命令并把事务应用到原 state；返回 ok 与新 state */
function run(state: EditorState, command: Command): { ok: boolean; state: EditorState } {
  let next = state
  const ok = command(state, (tr) => {
    next = state.apply(tr)
  })
  return { ok, state: next }
}

/** 把光标放进第一个文本块开头 */
function caretAtStart(state: EditorState): EditorState {
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1)))
}

describe('行内标记', () => {
  it('1. 选中文字后 toggle strong / em / strike / code', () => {
    let state = stateFor('正文')
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 3)))
    for (const name of ['strong', 'emphasis', 'strike_through', 'inlineCode'] as const) {
      const result = run(state, toggleInlineMark(textSchema.marks[name]))
      expect(result.ok).toBe(true)
      state = result.state
      expect(activeMarks(state)).toContain(name)
    }
  })

  it('2. 同一标记再切换一次就移除', () => {
    let state = caretAtStart(stateFor('正文'))
    state = run(state, toggleInlineMark(textSchema.marks.strong)).state
    expect(activeMarks(state)).toContain('strong')
    state = run(state, toggleInlineMark(textSchema.marks.strong)).state
    expect(activeMarks(state)).not.toContain('strong')
  })

  it('3. 空选区只改 storedMarks：后续输入自然带上标记', () => {
    const state = caretAtStart(stateFor('正文'))
    const next = run(state, toggleInlineMark(textSchema.marks.emphasis)).state
    expect(next.storedMarks?.map((mark) => mark.type.name)).toContain('emphasis')
  })
})

describe('块级命令', () => {
  it('4. 一级/二级/三级标题与回到正文', () => {
    let state = caretAtStart(stateFor('正文'))
    state = run(state, setHeadingLevel(textSchema, 2)).state
    expect(currentBlock(state, textSchema)).toEqual({ type: 'heading', level: 2 })
    state = run(state, setHeadingLevel(textSchema, 0)).state
    expect(currentBlock(state, textSchema).type).toBe('paragraph')
  })

  it('5. 引用块可以进入也可以退出', () => {
    let state = caretAtStart(stateFor('正文'))
    state = run(state, toggleBlockquote(textSchema)).state
    expect(isInNode(state, textSchema.nodes.blockquote)).toBe(true)
    state = run(state, toggleBlockquote(textSchema)).state
    expect(isInNode(state, textSchema.nodes.blockquote)).toBe(false)
  })

  it('6. 无序 / 有序列表开关', () => {
    let state = caretAtStart(stateFor('正文'))
    state = run(state, toggleListKind(textSchema, 'bullet_list')).state
    expect(isInNode(state, textSchema.nodes.bullet_list)).toBe(true)
    state = run(state, toggleListKind(textSchema, 'bullet_list')).state
    expect(isInNode(state, textSchema.nodes.bullet_list)).toBe(false)
    state = run(state, toggleListKind(textSchema, 'ordered_list')).state
    expect(isInNode(state, textSchema.nodes.ordered_list)).toBe(true)
  })

  it('7. 任务列表只改动当前列表项，别的普通列表保持原样', () => {
    let state = stateFor('- 已有的普通项\n\n正文')
    // 光标放到「正文」段落里（第二个顶层块）
    const paragraphPos = state.doc.child(0).nodeSize + 1
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, paragraphPos)))
    state = run(state, toggleTaskList(textSchema)).state
    const checked: (boolean | null)[] = []
    state.doc.descendants((node) => {
      if (node.type === textSchema.nodes.list_item) checked.push(node.attrs.checked as boolean | null)
      return true
    })
    expect(checked).toEqual([null, false])
  })

  it('8. 插入 3×3 表格：第一行是表头', () => {
    const state = caretAtStart(stateFor('正文'))
    const next = run(state, insertTable(textSchema, 3, 3)).state
    const table = next.doc.firstChild
    expect(table?.type.name).toBe('table')
    expect(table?.childCount).toBe(3)
    expect(table?.firstChild?.childCount).toBe(3)
    expect(table?.firstChild?.type.name).toBe('table_header_row')
    expect(table?.firstChild?.firstChild?.type.name).toBe('table_header')
    // 每格恰好一个段落：旧编辑器的单元格只认一个段落
    expect(table?.firstChild?.firstChild?.childCount).toBe(1)
  })

  it('9. 行列数做上限保护', () => {
    const state = caretAtStart(stateFor('正文'))
    const next = run(state, insertTable(textSchema, 999, 99)).state
    expect(next.doc.firstChild?.childCount).toBe(50)
    expect(next.doc.firstChild?.firstChild?.childCount).toBe(12)
  })

  it('10. 插入分割线与图片', () => {
    let state = caretAtStart(stateFor('正文'))
    state = run(state, insertHorizontalRule(textSchema)).state
    expect(state.doc.firstChild?.type.name).toBe('hr')
    // 分割线后补了空段落，光标有地方可落
    expect(state.doc.lastChild?.type.name).toBe('paragraph')
    // 图片插在独立文档里：行内节点被段落包住
    const image = run(caretAtStart(stateFor('正文')), insertImageNode(textSchema, './a.png', '图')).state
    expect(image.doc.firstChild?.type.name).toBe('paragraph')
    expect(image.doc.firstChild?.firstChild?.type.name).toBe('image')
    expect(image.doc.firstChild?.firstChild?.attrs.src).toBe('./a.png')
  })
})

describe('链接', () => {
  it('11. 相对地址 / https / mailto / kb 双链都允许，javascript: 被拒', () => {
    expect(isSafeHref('./a.md')).toBe(true)
    expect(isSafeHref('../b.md#x')).toBe(true)
    expect(isSafeHref('https://example.com')).toBe(true)
    expect(isSafeHref('mailto:a@b.c')).toBe(true)
    expect(isSafeHref('kb://proj_kb/a.md')).toBe(true)
    expect(isSafeHref('javascript:alert(1)')).toBe(false)
    expect(isSafeHref('data:text/html,x')).toBe(false)
    expect(isSafeHref('  ')).toBe(false)
  })

  it('12. 选中文字加链接，再用空地址移除', () => {
    let state = stateFor('正文')
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 3)))
    state = run(state, setLink(textSchema, 'https://example.com')).state
    expect(state.doc.rangeHasMark(1, 3, textSchema.marks.link)).toBe(true)
    state = run(state, setLink(textSchema, '')).state
    expect(state.doc.rangeHasMark(1, 3, textSchema.marks.link)).toBe(false)
  })

  it('13. 危险协议直接拒绝（ok=false，文档不变）', () => {
    const state = stateFor('正文')
    const next = run(state, setLink(textSchema, 'javascript:alert(1)'))
    expect(next.ok).toBe(false)
    expect(next.state.doc.eq(state.doc)).toBe(true)
  })
})
