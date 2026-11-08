/**
 * 键盘命令测试
 *
 * 不走真实 KeyboardEvent：命令本身就是纯函数（state, dispatch, view）→ boolean，
 * 直接驱动才能断言「什么时候拒绝」，而那正是最容易出错的地方（比如在列表项里按退格）。
 */
import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection, type Command, type Transaction } from 'prosemirror-state'
import { history, redo, undo } from 'prosemirror-history'
import type { EditorView } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'
import { textSchema } from '@/editor/surfaces/text/schema'
import { createListEnter, toggleMark } from '@/editor/surfaces/text/keymap'

/** 最小视图替身：命令只用到 dispatch / state，DOM 相关一律不碰 */
function harness(doc: PMNode, pos = 1) {
  let state = EditorState.create({ doc, selection: TextSelection.near(doc.resolve(pos)) })
  const view = {
    get state() {
      return state
    },
    dispatch(tr: Transaction) {
      state = state.apply(tr)
    },
  } as unknown as EditorView
  const dispatch = (tr: Transaction) => {
    state = state.apply(tr)
  }
  return {
    get state() {
      return state
    },
    view,
    dispatch,
    run(command: Command) {
      return command(state, dispatch, view)
    },
  }
}

function doc(...blocks: PMNode[]): PMNode {
  return textSchema.nodes.doc.create(null, blocks)
}

function paragraph(text: string): PMNode {
  return textSchema.nodes.paragraph.create(null, text ? textSchema.text(text) : undefined)
}

function bulletList(...items: string[]): PMNode {
  return textSchema.nodes.bullet_list.create(
    null,
    items.map((text) => textSchema.nodes.list_item.create(null, paragraph(text))),
  )
}

describe('列表回车', () => {
  it('1. 非空列表项回车拆成两项', () => {
    const list = bulletList('甲乙')
    // 光标放在「甲」后
    const h = harness(doc(list), 4)
    expect(h.run(createListEnter(textSchema.nodes.list_item))).toBe(true)
    const listNode = h.state.doc.child(0)
    expect(listNode.childCount).toBe(2)
    expect(listNode.child(0).textContent).toBe('甲')
  })

  it('2. 空列表项回车退出列表（不无限生成空项）', () => {
    const list = bulletList('')
    const h = harness(doc(list), 3)
    h.run(createListEnter(textSchema.nodes.list_item))
    // 退出后顶层应出现一个普通段落，列表被拆掉
    const types: string[] = []
    h.state.doc.forEach((node) => types.push(node.type.name))
    expect(types).toContain('paragraph')
  })

  it('3. 普通段落里回车返回 false，交回浏览器默认行为', () => {
    const h = harness(doc(paragraph('普通段落')), 3)
    expect(createListEnter(textSchema.nodes.list_item)(h.state, h.dispatch, h.view)).toBe(false)
  })
})

describe('行内标记快捷键', () => {
  it('4. 有选区时 Mod-b 给选中的文字加粗', () => {
    const p = paragraph('加粗这段')
    const h = harness(doc(p), 1)
    const state = h.state
    const withSelection = EditorState.create({
      doc: state.doc,
      selection: TextSelection.create(state.doc, 1, 5),
    })
    const applied: Transaction[] = []
    toggleMark(textSchema.marks.strong)(withSelection, (tr) => applied.push(tr))
    const next = withSelection.apply(applied[0])
    expect(JSON.stringify(next.doc.toJSON())).toContain('"strong"')
  })

  it('5. 无选区时 Mod-b 只设置待输入标记，不修改文档', () => {
    const h = harness(doc(paragraph('光标在这里')), 3)
    const before = h.state.doc.toJSON()
    const applied: Transaction[] = []
    toggleMark(textSchema.marks.strong)(h.state, (tr) => applied.push(tr))
    const next = h.state.apply(applied[0])
    expect(next.doc.toJSON()).toEqual(before)
    expect(next.storedMarks?.some((mark) => mark.type.name === 'strong')).toBe(true)
  })
})

describe('撤销栈', () => {
  it('6. undo 能回退、redo 能重做（历史插件已挂载）', () => {
    // 必须挂 history 插件，否则 undo 命令没有可回退的步骤（测试会假绿）
    let state = EditorState.create({ doc: doc(paragraph('原文')), plugins: [history()] })
    // 手工模拟一次可撤销的编辑：替换整段文字
    const tr = state.tr.insertText('新文', 1, 3)
    state = state.apply(tr)
    expect(state.doc.textContent).toBe('新文')

    let undone = state
    undo(state, (next) => {
      undone = undone.apply(next)
    })
    expect(undone.doc.textContent).toBe('原文')

    let redone = undone
    redo(undone, (next) => {
      redone = redone.apply(next)
    })
    expect(redone.doc.textContent).toBe('新文')
  })
})
