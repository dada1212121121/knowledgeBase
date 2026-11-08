/**
 * 选区锚点映射测试
 *
 * 锚点要跨会话稳定，所以必须验证「结构变了锚点还能落到合理位置」而不是只测 happy path。
 */
import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import type { Node as PMNode } from 'prosemirror-model'
import { textSchema } from '@/editor/surfaces/text/schema'
import { parseMarkdown } from '@/editor/codecs/markdown'
import {
  anchorFromState,
  blockStartAt,
  blockPathAt,
  blockText,
  rangeFromAnchor,
  selectionFromState,
} from '@/editor/surfaces/text/selection'

function stateAt(source: string, from: number, to = from): EditorState {
  const doc = parseMarkdown(source).doc
  return EditorState.create({ doc, selection: TextSelection.create(doc, from, to) })
}

describe('块路径', () => {
  it('1. 顶层段落路径是顶层序号', () => {
    const doc = parseMarkdown('第一段\n\n第二段\n').doc
    expect(blockPathAt(doc, 1)).toBe('0')
    expect(blockPathAt(doc, doc.child(0).nodeSize + 1)).toBe('1')
  })

  it('2. 嵌套列表项里的路径逐层展开', () => {
    const doc = parseMarkdown('- 甲\n  - 乙\n').doc
    const text = JSON.stringify(doc.toJSON())
    const pos = text.indexOf('乙')
    expect(pos).toBeGreaterThan(-1)
    // 直接按结构取：第 0 个列表项 → 第 1 个子块（子列表）→ 第 0 项 → 段落
    const start = blockStartAt(doc, '0.0.1.0.0')
    expect(start).not.toBeNull()
    expect(blockText(start!.node)).toBe('乙')
  })

  it('3. 路径越界返回 null，不抛异常', () => {
    const doc = parseMarkdown('段落\n').doc
    expect(blockStartAt(doc, '9')).toBeNull()
    expect(blockStartAt(doc, 'abc')).toBeNull()
    expect(blockStartAt(doc, '0.9')).toBeNull()
  })
})

describe('选区 → 锚点', () => {
  it('4. 空选区生成 length 0 的锚点，偏移是块内偏移', () => {
    const state = stateAt('段落内容\n', 3)
    const anchor = anchorFromState(state)
    expect(anchor).not.toBeNull()
    expect(anchor!.block).toBe('0')
    expect(anchor!.offset).toBe(2)
    expect(anchor!.length).toBe(0)
  })

  it('5. 选中文字生成带长度的锚点与 quote', () => {
    const state = stateAt('段落内容在这里\n', 3, 5)
    const selection = selectionFromState(state)
    expect(selection).not.toBeNull()
    expect(selection!.isEmpty).toBe(false)
    expect(selection!.text).toBe('内容')
    expect(selection!.anchor).toMatchObject({ kind: 'text', block: '0', offset: 2, length: 2 })
  })

  it('6. 跨块选区被裁剪到起始块（块内锚点不支持跨块）', () => {
    const doc = parseMarkdown('第一段\n\n第二段\n').doc
    const firstEnd = doc.child(0).nodeSize - 1
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 2, doc.child(0).nodeSize + 3) })
    const anchor = anchorFromState(state)!
    expect(anchor.block).toBe('0')
    expect(anchor.offset + (anchor.length ?? 0)).toBeLessThanOrEqual(firstEnd)
  })
})

describe('锚点 → 区间', () => {
  it('7. 锚点能还原成同一段文字', () => {
    const source = '- 列表项里有 **加粗** 文字\n'
    const doc = parseMarkdown(source).doc
    const start = blockStartAt(doc, '0.0.0')!
    const anchor = { kind: 'text' as const, block: '0.0.0', offset: 3, length: 2 }
    const range = rangeFromAnchor(doc, anchor)!
    expect(blockText(start.node).slice(3, 5)).toBe('里有')
    expect(doc.textBetween(range.from, range.to)).toBe('里有')
  })

  it('8. 偏移超出块长度时被裁剪到块尾，不越界', () => {
    const doc = parseMarkdown('短句\n').doc
    const range = rangeFromAnchor(doc, { kind: 'text', block: '0', offset: 999, length: 5 })!
    expect(doc.textBetween(range.from, range.to)).toBe('')
  })

  it('9. 块已被删除时返回 null（调用方据此丢弃锚点）', () => {
    const doc = parseMarkdown('只剩一段\n').doc
    expect(rangeFromAnchor(doc, { kind: 'text', block: '5', offset: 0 })).toBeNull()
  })

  it('10. 非文本锚点不被误接受', () => {
    const doc = parseMarkdown('段落\n').doc
    expect(rangeFromAnchor(doc, { kind: 'cell', sheet: 'S1', cell: 'A1' })).toBeNull()
  })
})

describe('blockText', () => {
  it('11. 硬换行算一个 `\\n`，图片不占偏移', () => {
    const doc = parseMarkdown('第一行  \n第二行\n\n![图](https://a.b/i.png)\n').doc
    expect(blockText(doc.child(0) as PMNode)).toBe('第一行\n第二行')
    expect(blockText(doc.child(1))).toBe('')
  })
})
