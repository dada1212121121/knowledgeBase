/**
 * 块菜单的纯函数：类型识别、能转换成什么、转换前后的 Markdown、复制 / 删除 / 移动的边界。
 * 走真实的文本面（schema、Markdown 编解码与线上一致），只调纯函数、不点界面（界面见 blockHandle.spec.ts）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { EditorView } from 'prosemirror-view'
import { cleanupText, mountText } from './textTestKit'
import { blockKind, convertBlock, convertibleTargets, deleteBlock, duplicateBlock, moveBlockAt, topIndexAt } from './blockMenu'

afterEach(() => cleanupText())

/** 第 index 个顶层块的起点 */
const posOf = (view: EditorView, index: number) => {
  let start = 0
  for (let i = 0; i < index; i += 1) start += view.state.doc.child(i).nodeSize
  return start
}
const apply = (view: EditorView, tr: ReturnType<typeof convertBlock>) => {
  expect(tr).not.toBeNull()
  view.dispatch(tr!)
}
const markdown = async (surface: { query: (q: { type: string }) => unknown }) => String(await surface.query({ type: 'text' })).trim()

describe('blockKind / convertibleTargets', () => {
  it('认出段落、各级标题、引用、提示块、三种列表、代码块', async () => {
    const { view } = await mountText('段落\n\n### 三级\n\n> 引用\n\n> [!NOTE]\n> 说明\n\n- 甲\n\n1. 乙\n\n- [ ] 丙\n\n```js\nx\n```')
    const kinds: string[] = []
    view.state.doc.forEach((node) => kinds.push(blockKind(node)))
    expect(kinds).toEqual(['paragraph', 'heading3', 'quote', 'callout', 'bullet', 'ordered', 'task', 'code'])
  })

  it('不含当前类型；引用 / 代码块只能回到正文；提示块不能转换；有图片的段落不给代码块', async () => {
    const { view } = await mountText('## 标题\n\n> 引用\n\n> [!TIP]\n> 提示\n\n```\nx\n```\n\n文字 ![图](a.png) 文字')
    const targets = (index: number) => convertibleTargets(view.state.doc.child(index))
    expect(targets(0)).not.toContain('heading2')
    expect(targets(0)).toContain('code')
    expect(targets(1)).toEqual(['paragraph'])
    expect(targets(2)).toEqual([])
    expect(targets(3)).toEqual(['paragraph'])
    expect(targets(4)).not.toContain('code')
    expect(targets(4)).toContain('heading1')
  })
})

describe('convertBlock', () => {
  it('段落 → 引用 → 回到正文：内容不丢', async () => {
    const { view, surface } = await mountText('甲\n\n乙')
    apply(view, convertBlock(view.state, posOf(view, 1), 'quote'))
    expect(await markdown(surface)).toBe('甲\n\n> 乙')
    apply(view, convertBlock(view.state, posOf(view, 1), 'paragraph'))
    expect(await markdown(surface)).toBe('甲\n\n乙')
  })

  it('带软换行的段落 → 代码块：换行变成代码里的换行；代码块 → 正文：每行一段', async () => {
    const { view, surface } = await mountText('第一行  \n第二行')
    apply(view, convertBlock(view.state, posOf(view, 0), 'code'))
    expect(view.state.doc.child(0).type.name).toBe('code_block')
    expect(view.state.doc.child(0).textContent).toBe('第一行\n第二行')
    apply(view, convertBlock(view.state, posOf(view, 0), 'paragraph'))
    expect(await markdown(surface)).toBe('第一行\n\n第二行')
  })

  it('任务列表 → 无序列表去掉复选框；有序 → 任务列表加上未勾选的复选框', async () => {
    const { view, surface } = await mountText('- [x] 做完\n- [ ] 没做')
    apply(view, convertBlock(view.state, posOf(view, 0), 'bullet'))
    expect(await markdown(surface)).toBe('- 做完\n- 没做')
    apply(view, convertBlock(view.state, posOf(view, 0), 'ordered'))
    expect(await markdown(surface)).toBe('1. 做完\n2. 没做')
    apply(view, convertBlock(view.state, posOf(view, 0), 'task'))
    expect(await markdown(surface)).toBe('- [ ] 做完\n- [ ] 没做')
  })

  it('转换成现在的类型、或不支持的目标：返回 null，文档不动', async () => {
    const { view } = await mountText('> [!NOTE]\n> 说明\n\n段落')
    expect(convertBlock(view.state, posOf(view, 0), 'paragraph')).toBeNull()
    expect(convertBlock(view.state, posOf(view, 1), 'paragraph')).toBeNull()
  })
})

describe('复制 / 删除 / 移动', () => {
  it('复制一份插在后面，光标进到副本', async () => {
    const { view } = await mountText('甲\n\n乙')
    apply(view, duplicateBlock(view.state, posOf(view, 0)))
    expect(view.state.doc.childCount).toBe(3)
    expect(view.state.doc.child(1).textContent).toBe('甲')
    expect(view.state.selection.from).toBeGreaterThan(posOf(view, 1))
  })

  it('删掉唯一的块：留下一个空段落（文档至少一个块）', async () => {
    const { view } = await mountText('只有这一段')
    apply(view, deleteBlock(view.state, 0))
    expect(view.state.doc.childCount).toBe(1)
    expect(view.state.doc.child(0).type.name).toBe('paragraph')
    expect(view.state.doc.child(0).textContent).toBe('')
  })

  it('移动：上移第一个 / 下移最后一个返回 null；pos 不是块起点时 topIndexAt 为 -1', async () => {
    const { view } = await mountText('甲\n\n乙')
    expect(moveBlockAt(view.state, 0, -1)).toBeNull()
    expect(moveBlockAt(view.state, posOf(view, 1), 1)).toBeNull()
    expect(topIndexAt(view.state, 1)).toBe(-1)
    apply(view, moveBlockAt(view.state, 0, 1))
    expect(view.state.doc.child(0).textContent).toBe('乙')
  })
})
