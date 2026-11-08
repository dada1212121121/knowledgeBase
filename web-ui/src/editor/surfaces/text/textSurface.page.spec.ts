/**
 * 笔记文本面 × 页面桥的集成测试
 *
 * 覆盖旧编辑器里「依赖页面」的那部分用户可见功能：提示块、双链、附件卡片、链接体检虚线、
 * Ctrl/⌘ 点击跟随、相对路径图片、`[[` 触发、粘贴 / 拖入文件、修复坏引用。
 * 每条都从用户动作出发（点、粘贴、输入）、断言可见结果，而不是内部状态。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { TextSelection } from 'prosemirror-state'
import { cleanupText, click, fileEvent, makeBridge, mountText } from './textTestKit'
import { linkKey, noteLinkKey } from '@/utils/links'

afterEach(cleanupText)

describe('提示块 / 双链 / 附件卡片装饰', () => {
  it('1. > [!NOTE] 引用块画成提示块，标记带中文标签', async () => {
    const { el } = await mountText('> [!NOTE]\n> 内容')
    const callout = el.querySelector('blockquote.kb-callout.is-note')
    expect(callout).not.toBeNull()
    expect(callout?.getAttribute('data-label')).toBe('说明')
    expect(el.querySelector('.kb-callout-marker')).not.toBeNull()
  })

  it('2. 普通引用块不是提示块', async () => {
    const { el } = await mountText('> 普通引用')
    expect(el.querySelector('.kb-callout')).toBeNull()
  })

  it('3. 编辑态双链 [[id|标题]] 画成双链，悬停提示是标题', async () => {
    const { el } = await mountText('见 [[ins_1|第一篇]]')
    const wiki = el.querySelector('.kb-wikilink')
    expect(wiki?.getAttribute('data-id')).toBe('ins_1')
    expect(wiki?.getAttribute('title')).toBe('第一篇')
  })

  it('4. 只读时没有别名的双链显示页面解析回来的标题', async () => {
    const bridge = makeBridge({ resolveTitles: async (ids) => Object.fromEntries(ids.map((id) => [id, `标题-${id}`])) })
    const { el } = await mountText('见 [[ins_2]]', { readonly: true, bridge })
    await expect.poll(() => el.querySelector('.kb-wikilink')?.textContent).toBe('标题-ins_2')
  })

  it('5. 附件卡片 [📎 名字](链接) 画成卡片，带类型与大小', async () => {
    const { el } = await mountText('[📎 说明.pdf](./files/说明.pdf "2 KB")')
    const card = el.querySelector('.kb-attach')
    expect(card?.classList.contains('is-pdf')).toBe(true)
    expect(card?.getAttribute('data-size')).toBe('2 KB')
  })

  it('6. 链接体检：目标文件不在 → 虚线并提示原因', async () => {
    const bridge = makeBridge()
    bridge.states[linkKey('docs', 'guide/b.md')] = 'missing'
    const { el } = await mountText('[去看](./b.md)', { bridge })
    const broken = el.querySelector('.kb-link-missing')
    expect(broken).not.toBeNull()
    expect(broken?.getAttribute('title')).toBe('文件不在知识库里')
  })

  it('7. 体检结果异步回来后 text.refresh 重画，不用重建编辑器', async () => {
    const bridge = makeBridge()
    const { el, surface } = await mountText('[去看](./b.md)', { bridge })
    expect(el.querySelector('.kb-link-missing')).toBeNull()
    bridge.states[linkKey('docs', 'guide/b.md')] = 'missing'
    await surface.command({ id: 'r', type: 'text.refresh', source: 'api' })
    expect(el.querySelector('.kb-link-missing')).not.toBeNull()
  })

  it('8. 原电脑路径一律画成不可用', async () => {
    const { el } = await mountText('[本地](C:\\Users\\me\\a.md)')
    expect(el.querySelector('.kb-link-invalid')).not.toBeNull()
  })
})

describe('点击跟随链接', () => {
  it('9. Ctrl 点击双链 → 打开那篇笔记', async () => {
    const { el, bridge } = await mountText('见 [[ins_1|第一篇]]')
    const event = click(el.querySelector('.kb-wikilink')!, { ctrlKey: true })
    expect(bridge.opened).toEqual(['ins_1'])
    expect(event.defaultPrevented).toBe(true)
  })

  it('10. 编辑态不按 Ctrl 点击是在编辑文字，不跳转', async () => {
    const { el, bridge } = await mountText('见 [[ins_1|第一篇]]')
    click(el.querySelector('.kb-wikilink')!)
    expect(bridge.opened).toEqual([])
  })

  it('11. 只读时直接点击双链就跳转', async () => {
    const { el, bridge } = await mountText('见 [[ins_1|第一篇]]', { readonly: true })
    click(el.querySelector('.kb-wikilink')!)
    expect(bridge.opened).toEqual(['ins_1'])
  })

  it('12. Ctrl 点击附件卡片 → 在知识库里打开那个文件（相对路径按当前文件目录解析）', async () => {
    const { el, bridge } = await mountText('[📎 说明.pdf](./files/说明.pdf "2 KB")')
    click(el.querySelector('a')!, { ctrlKey: true })
    expect(bridge.attachments).toMatchObject([{ collection: 'docs', path: 'guide/files/说明.pdf' }])
  })

  it('13. 指向笔记的链接 → 打开那篇笔记', async () => {
    const { el, bridge } = await mountText('[笔记](kb://note/n_abc123)')
    click(el.querySelector('a')!, { ctrlKey: true })
    expect(bridge.opened).toEqual(['n_abc123'])
  })

  it('14. 目标已经不在 → 给一句话，不去打开', async () => {
    const bridge = makeBridge()
    bridge.states[noteLinkKey('n_gone')] = 'missing'
    const { el } = await mountText('[笔记](kb://note/n_gone)', { bridge })
    click(el.querySelector('a')!, { ctrlKey: true })
    expect(bridge.opened).toEqual([])
    expect(bridge.errors).toEqual(['链接指向的笔记不在知识库里'])
  })

  it('15. 原电脑路径点击 → 说明原因', async () => {
    const { el, bridge } = await mountText('[本地](C:\\Users\\me\\a.md)')
    click(el.querySelector('a')!, { ctrlKey: true })
    expect(bridge.errors).toHaveLength(1)
    expect(bridge.errors[0]).toMatch(/电脑|路径/)
  })

  it('16. 文件双链 [[docs/规范.md]] 按文件打开而不是当笔记 id', async () => {
    const { el, bridge } = await mountText('[[docs/规范.md]]')
    click(el.querySelector('.kb-wikilink')!, { ctrlKey: true })
    expect(bridge.opened).toEqual([])
    expect(bridge.attachments[0]).toMatchObject({ collection: 'docs', path: 'docs/规范.md' })
  })
})

describe('相对路径图片', () => {
  it('17. 显示时换成原件地址，节点的 src 与保存的 Markdown 保持作者写的原样', async () => {
    const { el, surface, view } = await mountText('![架构](./img/arch.png)')
    expect(el.querySelector('img:not(.ProseMirror-separator)')?.getAttribute('src')).toBe('/raw/docs/guide/img/arch.png')
    expect(view.state.doc.firstChild?.firstChild?.attrs.src).toBe('./img/arch.png')
    expect(((await surface.query({ type: 'text' })) as string).trim()).toBe('![架构](./img/arch.png)')
  })

  it('18. 外链图片原样显示', async () => {
    const { el } = await mountText('![远程](https://example.com/a.png)')
    expect(el.querySelector('img:not(.ProseMirror-separator)')?.getAttribute('src')).toBe('https://example.com/a.png')
  })

  it('19. 没有页面桥时图片地址原样（单测 / 孤立使用不报错）', async () => {
    const { el } = await mountText('![x](./a.png)', { bridge: null })
    expect(el.querySelector('img:not(.ProseMirror-separator)')?.getAttribute('src')).toBe('./a.png')
  })
})

describe('命令：修复引用 / 插入双链 / 插入 Markdown', () => {
  it('20. text.replaceHref 改链接标记和图片 src，返回改到的处数', async () => {
    const { surface } = await mountText('[旧](./old.md) 和 ![图](./old.md)')
    const result = await surface.command({ id: 'x', type: 'text.replaceHref', args: { oldHref: './old.md', newHref: './new.md' }, source: 'user' })
    expect(result.data).toEqual({ count: 2 })
    expect(((await surface.query({ type: 'text' })) as string).trim()).toBe('[旧](./new.md) 和 ![图](./new.md)')
  })

  it('21. 旧地址已经找不到 → count 为 0，正文不动', async () => {
    const { surface } = await mountText('正文')
    const result = await surface.command({ id: 'x', type: 'text.replaceHref', args: { oldHref: './old.md', newHref: './new.md' }, source: 'user' })
    expect(result.data).toEqual({ count: 0 })
  })

  it('22. 引用笔记：把刚输入的 [[ 换成 [[id|标题]]', async () => {
    const { surface, view } = await mountText('')
    view.dispatch(view.state.tr.insertText('[['))
    const from = view.state.selection.from - 2
    const result = await surface.command({ id: 'x', type: 'text.wikilink.insert', args: { from, id: 'ins_9', title: '第 9 篇' }, source: 'user' })
    expect(result.ok).toBe(true)
    expect(((await surface.query({ type: 'text' })) as string).trim()).toBe('[[ins_9|第 9 篇]]')
  })

  it('23. 标题里的 ] | 换行被清掉，不会弄坏双链语法', async () => {
    const { surface, view } = await mountText('')
    view.dispatch(view.state.tr.insertText('[['))
    await surface.command({ id: 'x', type: 'text.wikilink.insert', args: { from: 1, id: 'ins_9', title: 'a]|b\nc' }, source: 'user' })
    expect(((await surface.query({ type: 'text' })) as string).trim()).toBe('[[ins_9|a  b c]]')
  })

  it('24. text.markdown.insert 把 Markdown 解析成块插入（图片、附件卡片都是真节点，不是字面文字）', async () => {
    const { surface, view } = await mountText('')
    await surface.command({ id: 'x', type: 'text.markdown.insert', args: { markdown: '![a](./a.png)\n\n[📎 b.pdf](./b.pdf "1 KB")' }, source: 'user' })
    let images = 0
    let links = 0
    view.state.doc.descendants((node) => {
      if (node.type.name === 'image') images += 1
      if (node.isText && node.marks.some((m) => m.type.name === 'link')) links += 1
    })
    expect(images).toBe(1)
    expect(links).toBe(1)
  })

  it('25. text.markdown.insert 带 pos：先把光标放过去再插', async () => {
    const { surface, view } = await mountText('第一段\n\n第二段')
    const second = view.state.doc.child(0).nodeSize + 1
    await surface.command({ id: 'x', type: 'text.markdown.insert', args: { markdown: '插入的段', pos: second }, source: 'user' })
    const texts: string[] = []
    view.state.doc.forEach((child) => texts.push(child.textContent))
    expect(texts).toEqual(['第一段', '第二段', '插入的段'])
  })
})

describe('输入触发与文件粘贴', () => {
  it('26. 连续输入 [[ → 请求「引用笔记」面板，from 是 [[ 的起点', async () => {
    const { view, bridge } = await mountText('')
    view.dispatch(view.state.tr.insertText('['))
    const pos = view.state.selection.from
    view.someProp('handleTextInput', (f) => f(view, pos, pos, '[', () => view.state.tr))
    view.dispatch(view.state.tr.insertText('[', pos))
    // 输入处理在下一个宏任务里弹面板（等这次输入落进文档）
    await expect.poll(() => bridge.panels.length).toBe(1)
    expect(bridge.panels[0]).toMatchObject({ panel: 'wikilink' })
  })

  it('27. 粘贴文件 → 交给页面上传，带上光标位置；原生粘贴被拦下', async () => {
    const { view, bridge } = await mountText('正文')
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)))
    const file = new File(['x'], 'a.png', { type: 'image/png' })
    const event = fileEvent('paste', [file])
    view.dom.dispatchEvent(event)
    expect(bridge.uploads).toHaveLength(1)
    expect(bridge.uploads[0]!.files[0]).toBe(file)
    expect(bridge.uploads[0]!.pos).toBe(3)
    expect(event.defaultPrevented).toBe(true)
  })

  it('28. 拖入非图片文件（附件）同样交给上传，不再只认图片', async () => {
    const { view, bridge } = await mountText('正文')
    const file = new File(['x'], '合同.pdf', { type: 'application/pdf' })
    view.dom.dispatchEvent(fileEvent('drop', [file]))
    expect(bridge.uploads).toHaveLength(1)
    expect(bridge.uploads[0]!.files[0]!.name).toBe('合同.pdf')
  })

  it('29. 只读时粘贴文件不上传', async () => {
    const { view, bridge } = await mountText('正文', { readonly: true })
    view.dom.dispatchEvent(fileEvent('paste', [new File(['x'], 'a.png', { type: 'image/png' })]))
    expect(bridge.uploads).toHaveLength(0)
  })
})
