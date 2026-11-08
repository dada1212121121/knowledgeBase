/**
 * 输入规则测试
 *
 * 直接驱动 `InputRule.handler`，不经过 DOM：
 * 输入规则本质是「光标前的文本匹配 → 事务」，用不到真实键盘事件，
 * 这样测试既快又能在 Node 环境跑（jsdom 里 contenteditable 的输入模拟非常不可靠）。
 */
import { describe, expect, it } from 'vitest'
import { EditorState } from 'prosemirror-state'
import type { Node as PMNode } from 'prosemirror-model'
import { textSchema } from '@/editor/surfaces/text/schema'
import { buildInputRules } from '@/editor/surfaces/text/inputRules'

const rules = buildInputRules(textSchema)

/** 造一个「段落到光标处」的初始状态 */
function stateWithText(text: string): EditorState {
  const paragraph: PMNode = textSchema.nodes.paragraph.create(null, text ? textSchema.text(text) : undefined)
  return EditorState.create({ doc: textSchema.nodes.doc.create(null, [paragraph]) })
}

/**
 * 模拟「刚输入了 inserted」：插入文本后按 ProseMirror 的规则在光标前匹配。
 * 计算方式与 prosemirror-inputrules 一致：`start = 光标 - match[0].length`。
 */
function typeText(state: EditorState, inserted: string): EditorState {
  const tr = state.tr.insertText(inserted)
  const next = state.apply(tr)
  const $from = next.selection.$from
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc')
  for (const rule of rules) {
    // prosemirror-inputrules 没把 match/handler 写进公开类型，测试里按实现签名取用
    const impl = rule as unknown as {
      match: RegExp
      handler: (state: EditorState, match: RegExpExecArray, start: number, end: number) => typeof next.tr | null
    }
    const match = impl.match.exec(before)
    if (!match) continue
    const end = $from.pos
    const start = end - match[0].length
    const applied = impl.handler(next, match, start, end)
    if (applied) return next.apply(applied)
  }
  return next
}

function docOf(state: EditorState) {
  return state.doc.toJSON() as { content: { type: string; content?: unknown[]; attrs?: Record<string, unknown> }[] }
}

describe('输入规则', () => {
  it('1. `# ` 生成一级标题，`### ` 生成三级标题', () => {
    expect(docOf(typeText(stateWithText(''), '# ')).content[0].type).toBe('heading')
    const h3 = docOf(typeText(stateWithText(''), '### '))
    expect(h3.content[0].attrs?.level).toBe(3)
  })

  it('2. `- ` / `* ` / `+ ` 都生成无序列表，且 `-5` 不触发', () => {
    for (const marker of ['- ', '* ', '+ ']) {
      expect(docOf(typeText(stateWithText(''), marker)).content[0].type).toBe('bullet_list')
    }
    expect(docOf(typeText(stateWithText(''), '-5')).content[0].type).toBe('paragraph')
  })

  it('3. `3. ` 生成有序列表并保留起始序号', () => {
    const doc = docOf(typeText(stateWithText(''), '3. '))
    expect(doc.content[0].type).toBe('ordered_list')
    expect(doc.content[0].attrs?.order).toBe(3)
  })

  it('4. `> ` 生成引用块', () => {
    expect(docOf(typeText(stateWithText(''), '> ')).content[0].type).toBe('blockquote')
  })

  it('5. ``` ```js ``` 生成带语言的代码块', () => {
    const doc = docOf(typeText(stateWithText(''), '```js '))
    expect(doc.content[0].type).toBe('code_block')
    expect(doc.content[0].attrs?.language).toBe('js')
  })

  it('6. `---` 生成分割线', () => {
    expect(docOf(typeText(stateWithText(''), '---')).content[0].type).toBe('hr')
  })

  it('7. `[ ] ` 在列表项里改成未完成任务项；在普通段落里直接把这一段变成任务列表', () => {
    const listState = typeText(typeText(stateWithText(''), '- '), '[ ] ')
    const doc = docOf(listState)
    expect(doc.content[0].type).toBe('bullet_list')
    const item = (doc.content[0].content ?? [])[0] as { attrs?: Record<string, unknown> }
    expect(item.attrs?.checked).toBe(false)

    // 普通段落：`[] ` / `[ ] ` / `[x] ` 都直接建任务列表，不用先打 `- `
    for (const [typed, checked] of [['[] ', false], ['[ ] ', false], ['[x] ', true]] as const) {
      const made = docOf(typeText(stateWithText(''), typed))
      expect(made.content[0].type, typed).toBe('bullet_list')
      const first = (made.content[0].content ?? [])[0] as { attrs?: Record<string, unknown>; content?: unknown[] }
      expect(first.attrs?.checked, typed).toBe(checked)
    }
  })

  it('7b. 中文标点状态下的写法：`【】 ` 任务、`》 ` 引用、`1。 ` 有序列表、`··· ` 代码块、`＃ ` 标题', () => {
    const task = docOf(typeText(stateWithText(''), '【】 '))
    expect(task.content[0].type).toBe('bullet_list')
    expect(((task.content[0].content ?? [])[0] as { attrs?: Record<string, unknown> }).attrs?.checked).toBe(false)
    expect(docOf(typeText(stateWithText(''), '》 ')).content[0].type).toBe('blockquote')
    const ordered = docOf(typeText(stateWithText(''), '3。 '))
    expect(ordered.content[0].type).toBe('ordered_list')
    expect(ordered.content[0].attrs?.order).toBe(3)
    expect(docOf(typeText(stateWithText(''), '··· ')).content[0].type).toBe('code_block')
    expect(docOf(typeText(stateWithText(''), '＃＃ ')).content[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } })
    // 「1、」是中文自己的编号写法，不变成 Markdown 列表；正文中间的「》」不触发
    expect(docOf(typeText(stateWithText(''), '1、 ')).content[0].type).toBe('paragraph')
    // 先有正文，再在正文后输入「》 」：前面不是段首，不能触发引用
    expect(docOf(typeText(typeText(stateWithText(''), '书名'), '》 ')).content[0].type).toBe('paragraph')
  })

  it('8. `**粗体**` 生成 strong 标记，`2 * 3` 不生成任何标记', () => {
    const strong = typeText(stateWithText(''), '**粗体**')
    const marks = JSON.stringify(strong.doc.toJSON())
    expect(marks).toContain('"strong"')

    const plain = typeText(stateWithText('2 *'), ' 3')
    expect(JSON.stringify(plain.doc.toJSON())).not.toContain('"em"')
  })

  it('9. `` `代码` `` 生成行内代码；`~~删除~~` 生成 strike', () => {
    expect(JSON.stringify(typeText(stateWithText(''), '`代码`').doc.toJSON())).toContain('"inlineCode"')
    expect(JSON.stringify(typeText(stateWithText(''), '~~删除~~').doc.toJSON())).toContain('"strike_through"')
  })

  it('10. `[文字](url)` 生成链接标记', () => {
    const json = JSON.stringify(typeText(stateWithText(''), '[文字](https://a.b)').doc.toJSON())
    expect(json).toContain('"link"')
    expect(json).toContain('https://a.b')
  })
})
