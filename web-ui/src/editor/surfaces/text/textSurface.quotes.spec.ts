/**
 * 笔记文本面 · 选区批注
 *
 * 真实 TextSurface + 真实 ProseMirror 视图，页面的评论栏换成可观测的假实现（TextComments）。
 * 覆盖：高亮定位（含同句多处、已解决、聚焦）、改文后重定位 / 找不到、装饰不进文档不进撤销栈、
 * 选中文字的「评论」入口（只读也能用、没有评论权限不出现）、点高亮通知页面、滚到某条批注、协同里别人改文后高亮跟着走。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { undoDepth } from 'prosemirror-history'
import { TextSelection } from 'prosemirror-state'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { buildTextIndex, locateQuote, type QuoteAnchor } from '@/utils/quoteAnchor'
import type { CollabRichLike, CollabRichState, TextComments, TextQuote } from '../../types'
import { cleanupText, makeBridge, mountText, type Mounted } from './textTestKit'
import { resolveAnchorRange, textAnchorOfRange } from './quotes'

afterEach(cleanupText)

type Anchor = Extract<import('../../types').Anchor, { kind: 'text' }>

interface FakeComments extends TextComments {
  list: TextQuote[]
  active: string | null
  can: boolean
  annotated: { quote: QuoteAnchor; anchor: Anchor }[]
  clicked: string[]
  reports: string[][]
}

function fakeComments(list: TextQuote[] = [], can = true): FakeComments {
  const comments: FakeComments = {
    list,
    active: null,
    can,
    annotated: [],
    clicked: [],
    reports: [],
    quotes: () => comments.list,
    activeQuote: () => comments.active,
    canAnnotate: () => comments.can,
    annotate: (quote, anchor) => comments.annotated.push({ quote, anchor }),
    quoteClick: (id) => comments.clicked.push(id),
    located: (ids) => comments.reports.push(ids),
  }
  return comments
}

const quote = (id: string, text: string, extra: Partial<TextQuote> = {}): TextQuote => ({ id, text, prefix: '', suffix: '', resolved: false, ...extra })

async function mountWith(text: string, comments: FakeComments, options: { readonly?: boolean } = {}): Promise<Mounted> {
  return mountText(text, { ...options, bridge: makeBridge({ comments }) })
}

/** 文档里某段文字的位置区间（按文本索引找，和批注定位同一套口径） */
function rangeOf(m: Mounted, text: string): { from: number; to: number } {
  const range = locateQuote(buildTextIndex(m.view.state.doc), { text, prefix: '', suffix: '' })
  if (!range) throw new Error(`文档里没有「${text}」`)
  return range
}

/** 选中一段文字：同时设置 ProseMirror 选区和浏览器选区（只读视图不会自己把前者写到后者） */
function select(m: Mounted, text: string): void {
  const { from, to } = rangeOf(m, text)
  m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, from, to)))
  const start = m.view.domAtPos(from)
  const end = m.view.domAtPos(to)
  window.getSelection()!.setBaseAndExtent(start.node, start.offset, end.node, end.offset)
  tools(m).update()
}

const tools = (m: Mounted) => (m.surface as unknown as { quoteTools: { update(): void; visible: boolean } }).quoteTools
const button = (m: Mounted) => m.el.querySelector<HTMLButtonElement>('[data-testid="annotate-selection"]')
const marks = (m: Mounted) => [...m.el.querySelectorAll<HTMLElement>('[data-quote-id]')].map((el) => `${el.dataset.quoteId}:${el.textContent}`)

describe('批注高亮', () => {
  it('摘录在正文里的位置画上高亮；已解决、聚焦的各有样式；找不到的不画并从“找得到”里去掉', async () => {
    const comments = fakeComments([quote('a', '第二句'), quote('b', '第三句', { resolved: true }), quote('gone', '已经删掉的话')])
    comments.active = 'a'
    const m = await mountWith('第一句。第二句。第三句。', comments)
    expect(marks(m)).toEqual(['a:第二句', 'b:第三句'])
    expect(m.el.querySelector('[data-quote-id="a"]')!.className).toContain('is-active')
    expect(m.el.querySelector('[data-quote-id="b"]')!.className).toContain('is-resolved')
    expect(comments.reports.at(-1)).toEqual(['a', 'b'])
  })

  it('同一句话出现多次时靠前后文挑对的那一处', async () => {
    const comments = fakeComments([{ id: 'x', text: '好', prefix: '很', suffix: '吃', resolved: false }])
    const m = await mountWith('不好吃。很好吃。', comments)
    const mark = m.el.querySelector('[data-quote-id="x"]')!
    // 命中的是第二个“好”：它前面是“很”
    expect(mark.previousSibling?.textContent).toMatch(/很$/)
    expect(marks(m)).toEqual(['x:好'])
  })

  it('页面还没有任何评论时不向页面汇报；评论列表之后加载进来，再汇报一次', async () => {
    const comments = fakeComments([])
    const m = await mountWith('甲乙丙', comments)
    expect(comments.reports).toEqual([])
    comments.list = [quote('a', '乙')]
    await m.surface.command({ id: '1', type: 'text.quotes.refresh', source: 'api', readonlySafe: true })
    expect(marks(m)).toEqual(['a:乙'])
    expect(comments.reports).toEqual([['a']])
  })

  it('全部评论的原文都被改没了也要汇报（评论栏据此标“原文已改动”）', async () => {
    const comments = fakeComments([quote('gone', '不存在')])
    await mountWith('只有这些字', comments)
    expect(comments.reports).toEqual([[]])
  })

  it('页面评论列表 / 聚焦项变了，下发 text.quotes.refresh 后高亮重算', async () => {
    const comments = fakeComments([quote('a', '乙')])
    const m = await mountWith('甲乙丙', comments)
    comments.active = 'a'
    comments.list = [quote('a', '乙', { resolved: true }), quote('c', '丙')]
    const result = await m.surface.command({ id: '1', type: 'text.quotes.refresh', source: 'api', readonlySafe: true })
    expect(result.ok).toBe(true)
    expect(marks(m)).toEqual(['a:乙', 'c:丙'])
    expect(m.el.querySelector('[data-quote-id="a"]')!.className).toMatch(/is-resolved.*is-active|is-active.*is-resolved/)
  })

  it('页面没有评论栏（没传 comments）时什么都不画，也不出现入口', async () => {
    const m = await mountText('甲乙丙')
    expect(marks(m)).toEqual([])
    select(m, '乙')
    expect(button(m)).toBeNull()
  })
})

describe('文字被改动后重新定位', () => {
  it('摘录前面插入文字：高亮跟着走；摘录里面被改：高亮消失并汇报，评论保留（由评论栏标“原文已改动”）', async () => {
    const comments = fakeComments([quote('a', '关键句')])
    const m = await mountWith('开头。关键句。结尾。', comments)
    expect(marks(m)).toEqual(['a:关键句'])

    m.view.dispatch(m.view.state.tr.insertText('新增的一段，', 1))
    expect(marks(m)).toEqual(['a:关键句'])
    expect(comments.reports.at(-1)).toEqual(['a'])

    const { from } = rangeOf(m, '关键句')
    m.view.dispatch(m.view.state.tr.insertText('X', from + 1))
    expect(marks(m)).toEqual([])
    expect(comments.reports.at(-1)).toEqual([])
    // 评论列表本身没变：页面照样拿得到它，只是“找不到”
    expect(comments.list).toHaveLength(1)
  })

  it('统一锚点按 quote 重新定位：位置没动落在原处；挪了位置按文字找回；文字没了返回 null', async () => {
    const m = await mountText('第一段。\n\n重点内容在这里。\n\n尾声。')
    const { from, to } = rangeOf(m, '重点内容')
    const anchor = textAnchorOfRange(m.view.state.doc, from, to, '重点内容')
    expect(anchor).toMatchObject({ kind: 'text', offset: 0, length: 4, quote: '重点内容' })
    expect(resolveAnchorRange(m.view.state.doc, anchor)).toEqual({ from, to })

    // 前面多了一整段：块路径已经指向别的块，但按文字仍能找回
    m.view.dispatch(m.view.state.tr.insert(0, m.view.state.schema.nodes.paragraph!.create(null, m.view.state.schema.text('新来的段落'))))
    const moved = resolveAnchorRange(m.view.state.doc, anchor)
    expect(moved).toEqual(rangeOf(m, '重点内容'))

    // 文字被改没了
    const now = rangeOf(m, '重点内容')
    m.view.dispatch(m.view.state.tr.delete(now.from, now.to))
    expect(resolveAnchorRange(m.view.state.doc, anchor)).toBeNull()
  })

  it('nav.anchor 带 quote 的锚点：正文改过后仍选中那段话；找不到如实返回 anchor_lost', async () => {
    const m = await mountText('第一段。\n\n重点内容在这里。')
    const { from, to } = rangeOf(m, '重点内容')
    const anchor = textAnchorOfRange(m.view.state.doc, from, to, '重点内容')
    m.view.dispatch(m.view.state.tr.insert(0, m.view.state.schema.nodes.paragraph!.create(null, m.view.state.schema.text('插进来的一段'))))
    const ok = await m.surface.command({ id: '1', type: 'nav.anchor', args: { anchor }, source: 'user', readonlySafe: true })
    expect(ok.ok).toBe(true)
    const selection = m.view.state.selection
    expect(m.view.state.doc.textBetween(selection.from, selection.to)).toBe('重点内容')
    const lost = await m.surface.command({ id: '2', type: 'nav.anchor', args: { anchor: { ...anchor, quote: '根本没有的话' } }, source: 'user', readonlySafe: true })
    expect(lost).toMatchObject({ ok: false, reason: 'anchor_lost' })
  })

  it('query quotes：现在找得到的批注，带统一锚点', async () => {
    const comments = fakeComments([quote('a', '乙乙'), quote('gone', '没有')])
    const m = await mountWith('甲\n\n丙乙乙丁', comments)
    const found = (await m.surface.query({ type: 'quotes' })) as { id: string; anchor: Anchor }[]
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ id: 'a', anchor: { kind: 'text', offset: 1, length: 2, quote: '乙乙' } })
  })
})

describe('装饰不是正文：不改文档、不进撤销栈、不算未保存', () => {
  it('高亮 / 刷新 / 聚焦切换都不产生撤销步骤，不触发“有未保存的改动”，序列化结果仍是原文', async () => {
    const original = '甲乙丙。\n'
    const comments = fakeComments([quote('a', '乙')])
    const m = await mountWith(original, comments)
    expect(undoDepth(m.view.state)).toBe(0)
    comments.active = 'a'
    await m.surface.command({ id: '1', type: 'text.quotes.refresh', source: 'api', readonlySafe: true })
    comments.list = [quote('a', '乙', { resolved: true })]
    await m.surface.command({ id: '2', type: 'text.quotes.refresh', source: 'api', readonlySafe: true })
    expect(undoDepth(m.view.state)).toBe(0)
    expect(m.dirty.every((value) => value === false)).toBe(true)
    expect(m.surface.textNow()).toBe(original)
    // 高亮的 class 不会漏进序列化出来的 Markdown
    await m.surface.command({ id: '3', type: 'text.insert', args: { text: '！' }, source: 'user' })
    expect(m.surface.textNow()).not.toContain('kb-quote')
    expect(m.surface.textNow()).not.toContain('data-quote-id')
  })

  it('撤销只撤销输入，高亮不参与：输入 → 撤销后正文回到原样，批注仍在原处', async () => {
    const comments = fakeComments([quote('a', '乙')])
    const m = await mountWith('甲乙丙', comments)
    m.view.dispatch(m.view.state.tr.insertText('前', 1))
    expect(undoDepth(m.view.state)).toBe(1)
    await m.surface.command({ id: '1', type: 'text.quotes.refresh', source: 'api', readonlySafe: true })
    expect(undoDepth(m.view.state)).toBe(1)
    await m.surface.command({ id: '2', type: 'undo', source: 'user' })
    expect(m.view.state.doc.textContent).toBe('甲乙丙')
    expect(marks(m)).toEqual(['a:乙'])
  })
})

describe('选中文字的「评论」入口', () => {
  it('只读阅读也能用：选中后出现，点击把「摘录 + 前后文」和统一锚点交给页面，浮钮随即收起', async () => {
    const comments = fakeComments()
    const m = await mountWith('前面的话，被评论的这句，后面的话。', comments, { readonly: true })
    expect(button(m)).toBeNull()
    select(m, '被评论的这句')
    const add = button(m)!
    expect(add.hidden).toBe(false)
    expect(add.getAttribute('aria-label')).toBe('对选中的文字发表评论')
    add.click()
    expect(comments.annotated).toHaveLength(1)
    const { quote: stored, anchor } = comments.annotated[0]!
    // 落库的格式是后端的 Quote：摘录 + 前后各一小段上下文
    expect(stored).toEqual({ kind: 'quote', text: '被评论的这句', prefix: '前面的话，', suffix: '，后面的话。' })
    expect(anchor).toMatchObject({ kind: 'text', offset: 5, length: 6, quote: '被评论的这句' })
    expect(button(m)!.hidden).toBe(true)
    // 阅读态不能被改：评论不产生任何编辑
    expect(undoDepth(m.view.state)).toBe(0)
    expect(m.surface.textNow()).toBe('前面的话，被评论的这句，后面的话。')
  })

  it('选区折叠 / 点到别处，浮钮收起', async () => {
    const m = await mountWith('甲乙丙丁', fakeComments(), { readonly: true })
    select(m, '乙丙')
    expect(tools(m).visible).toBe(true)
    window.getSelection()!.removeAllRanges()
    tools(m).update()
    expect(tools(m).visible).toBe(false)
  })

  it('浏览器选区在正文外面（选的是页面别处的字）不出现', async () => {
    const m = await mountWith('甲乙丙丁', fakeComments(), { readonly: true })
    const outside = document.createElement('p')
    outside.textContent = '页面别处的字'
    document.body.append(outside)
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, 1, 3)))
    window.getSelection()!.setBaseAndExtent(outside.firstChild!, 0, outside.firstChild!, 3)
    tools(m).update()
    expect(button(m)).toBeNull()
  })

  it('没有评论权限（canAnnotate 为 false，如管理员只读巡检）：选中文字也不出现', async () => {
    const m = await mountWith('甲乙丙丁', fakeComments([], false), { readonly: true })
    select(m, '乙丙')
    expect(button(m)).toBeNull()
  })

  it('页面把 canAnnotate 从 true 改成 false 后，下发刷新命令，浮钮收起', async () => {
    const comments = fakeComments()
    const m = await mountWith('甲乙丙丁', comments, { readonly: true })
    select(m, '乙丙')
    expect(tools(m).visible).toBe(true)
    comments.can = false
    await m.surface.command({ id: '1', type: 'text.quotes.refresh', source: 'api', readonlySafe: true })
    expect(tools(m).visible).toBe(false)
  })

  it('选中的内容太长 / 只有空白：提示原因，不交给页面', async () => {
    const comments = fakeComments()
    const long = '字'.repeat(1001)
    const m = await mountWith(`${long}\n\n  \n\n尾`, comments, { readonly: true })
    select(m, long)
    button(m)!.click()
    expect(comments.annotated).toHaveLength(0)
    expect(m.bridge.notices.at(-1)).toContain('太长')
  })

  it('编辑态下 canAnnotate 为 true 也能用（是否开放由页面决定）：评论不进撤销栈、不改正文', async () => {
    const comments = fakeComments()
    const m = await mountWith('甲乙丙丁', comments)
    select(m, '乙丙')
    expect(button(m)?.hidden).toBe(false)
    button(m)!.click()
    expect(comments.annotated).toHaveLength(1)
    expect(undoDepth(m.view.state)).toBe(0)
    expect(m.surface.textNow()).toBe('甲乙丙丁')
  })

  it('selectionchange 事件驱动：真实的选字流程（不手动调 update）', async () => {
    const m = await mountWith('甲乙丙丁', fakeComments(), { readonly: true })
    const { from, to } = rangeOf(m, '乙丙')
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, from, to)))
    const start = m.view.domAtPos(from)
    const end = m.view.domAtPos(to)
    window.getSelection()!.setBaseAndExtent(start.node, start.offset, end.node, end.offset)
    document.dispatchEvent(new Event('selectionchange'))
    await vi.waitFor(() => expect(button(m)?.hidden).toBe(false))
  })
})

describe('点批注高亮 / 滚到批注', () => {
  it('点高亮通知页面聚焦那条评论；选着文字时的点击不算', async () => {
    const comments = fakeComments([quote('a', '乙')])
    const m = await mountWith('甲乙丙', comments, { readonly: true })
    const mark = m.el.querySelector<HTMLElement>('[data-quote-id="a"]')!
    mark.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(comments.clicked).toEqual(['a'])

    const start = m.view.domAtPos(1)
    window.getSelection()!.setBaseAndExtent(start.node, start.offset, start.node, start.offset + 1)
    mark.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(comments.clicked).toEqual(['a'])
  })

  it('view.revealQuote：高亮在则滚过去并返回 ok；找不到（原文已改动）返回 anchor_lost', async () => {
    const comments = fakeComments([quote('a', '乙'), quote('gone', '没有')])
    const m = await mountWith('甲乙丙', comments, { readonly: true })
    const scroll = vi.fn()
    ;(m.el.querySelector('[data-quote-id="a"]') as HTMLElement).scrollIntoView = scroll
    expect(await m.surface.command({ id: '1', type: 'view.revealQuote', args: { id: 'a' }, source: 'api', readonlySafe: true })).toEqual({ ok: true })
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ block: 'center' }))
    expect(await m.surface.command({ id: '2', type: 'view.revealQuote', args: { id: 'gone' }, source: 'api', readonlySafe: true })).toMatchObject({ ok: false, reason: 'anchor_lost' })
  })
})

/** 假房间（同 textSurface.collab.spec）：只保留这里要用的最小实现 */
class Room implements CollabRichLike {
  readonly doc = new Y.Doc()
  readonly fragment = this.doc.getXmlFragment('prosemirror')
  readonly awareness = new Awareness(this.doc)
  private state: CollabRichState = { writable: true, ready: true, everSynced: true, initMarkdown: null }
  getState = () => this.state
  subscribe = () => () => undefined
  on = () => () => undefined
  initDone = () => undefined
}

describe('多人编辑里的批注', () => {
  it('别人在摘录前面改了字：本机的高亮跟着走（批注不进房间，每个客户端各自按文字定位）', async () => {
    const roomA = new Room()
    const roomB = new Room()
    const sync = (from: Room, to: Room) => from.doc.on('update', (update: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(to.doc, update, 'remote'))
    const { prosemirrorToYXmlFragment } = await import('y-prosemirror')
    const { parseMarkdown } = await import('../../codecs/markdown')
    prosemirrorToYXmlFragment(parseMarkdown('开头。关键句。结尾。').doc, roomA.fragment)
    Y.applyUpdate(roomB.doc, Y.encodeStateAsUpdate(roomA.doc), 'remote')
    sync(roomA, roomB)
    sync(roomB, roomA)

    const comments = fakeComments([quote('a', '关键句')])
    const bridge = makeBridge({ comments })
    const a = await mountText('', { bridge, ctx: { collabRich: roomA } })
    await vi.waitFor(() => expect(a.el.querySelector('[data-quote-id="a"]')).not.toBeNull())

    // B 端在最前面敲字
    const b = await mountText('', { bridge: makeBridge(), ctx: { collabRich: roomB } })
    await vi.waitFor(() => expect(b.view.state.doc.textContent).toContain('关键句'))
    b.view.dispatch(b.view.state.tr.insertText('别人加的字，', 1))
    await vi.waitFor(() => expect(a.view.state.doc.textContent).toContain('别人加的字'))
    expect(marks(a)).toEqual(['a:关键句'])
    expect(comments.reports.at(-1)).toEqual(['a'])
  })
})
