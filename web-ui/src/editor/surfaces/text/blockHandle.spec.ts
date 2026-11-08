/**
 * 块手柄与块的键盘移动
 *
 * 手柄：悬停某个块出现 ＋ / 拖动把手；＋ 在下方新起一段并打出 /；拖动把手把整块设成节点选区并告诉视图“正在移动它”。
 * 键盘：Ctrl/⌘+Shift+↑/↓ 把当前块上移 / 下移（拖动之外的等价操作）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TextSelection } from 'prosemirror-state'
import { cleanupText, mountText } from './textTestKit'
import { moveBlock, topBlockAt } from './blockHandle'
import type { EditorView } from 'prosemirror-view'

afterEach(() => {
  cleanupText()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const SOURCE = '# 一\n\n第二段\n\n- 三\n\n第四段'
const blocks = (view: EditorView) => {
  const out: string[] = []
  view.state.doc.forEach((node) => out.push(`${node.type.name}:${node.textContent}`))
  return out
}
const caretIn = (view: EditorView, text: string) => {
  let at = -1
  view.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text?.includes(text)) at = pos + 1
    return at < 0
  })
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)))
}
const run = (view: EditorView, direction: -1 | 1) => moveBlock(direction)(view.state, (tr) => view.dispatch(tr))

describe('键盘移动块', () => {
  it('下移：当前块和后一个块换位，光标跟着块走', async () => {
    const { view } = await mountText(SOURCE)
    caretIn(view, '第二段')
    expect(run(view, 1)).toBe(true)
    expect(blocks(view)).toEqual(['heading:一', 'bullet_list:三', 'paragraph:第二段', 'paragraph:第四段'])
    expect(view.state.selection.$from.parent.textContent).toBe('第二段')
  })

  it('上移：和前一个块换位', async () => {
    const { view } = await mountText(SOURCE)
    caretIn(view, '第四段')
    expect(run(view, -1)).toBe(true)
    expect(blocks(view)).toEqual(['heading:一', 'paragraph:第二段', 'paragraph:第四段', 'bullet_list:三'])
  })

  it('已经在最前 / 最后：返回 false，文档不动', async () => {
    const { view } = await mountText(SOURCE)
    caretIn(view, '一')
    expect(run(view, -1)).toBe(false)
    caretIn(view, '第四段')
    expect(run(view, 1)).toBe(false)
    expect(blocks(view)).toHaveLength(4)
  })

  it('列表里的光标：移动的是整个列表（顶层块），不是列表项', async () => {
    const { view } = await mountText(SOURCE)
    caretIn(view, '三')
    run(view, -1)
    expect(blocks(view)).toEqual(['heading:一', 'bullet_list:三', 'paragraph:第二段', 'paragraph:第四段'])
  })

  it('一次可撤销的编辑；保存的 Markdown 顺序对', async () => {
    const { view, surface } = await mountText('甲\n\n乙\n\n丙')
    caretIn(view, '乙')
    run(view, 1)
    expect(((await surface.query({ type: 'text' })) as string).trim()).toBe('甲\n\n丙\n\n乙')
    await surface.command({ id: 'u', type: 'undo', source: 'user' })
    expect(((await surface.query({ type: 'text' })) as string).trim()).toBe('甲\n\n乙\n\n丙')
  })

  it('快捷键 Ctrl+Shift+↓ / ↑ 走同一命令', async () => {
    const { view } = await mountText('甲\n\n乙\n\n丙')
    caretIn(view, '甲')
    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })
    view.dom.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    expect(blocks(view)).toEqual(['paragraph:乙', 'paragraph:甲', 'paragraph:丙'])
    view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))
    expect(blocks(view)).toEqual(['paragraph:甲', 'paragraph:乙', 'paragraph:丙'])
  })

  it('topBlockAt：块与块之间 / 列表深处都能找到所在的顶层块', async () => {
    const { view } = await mountText(SOURCE)
    caretIn(view, '三')
    expect(topBlockAt(view, view.state.selection.from)?.node.type.name).toBe('bullet_list')
    expect(topBlockAt(view, 0)?.index).toBe(0)
    expect(topBlockAt(view, view.state.doc.content.size)?.index).toBe(3)
  })
})

describe('手柄', () => {
  function hover(view: EditorView, target: HTMLElement) {
    // 鼠标位置 → 文档位置：jsdom 没有布局，直接指定 posAtCoords 的结果
    const block = [...view.dom.children].indexOf(target)
    let start = 0
    for (let i = 0; i < block; i += 1) start += view.state.doc.child(i).nodeSize
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: start + 1, inside: start })
    view.dom.parentElement!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 200, clientY: 40 }))
  }
  function mouse() {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: /hover: hover/.test(query), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }))
  }
  function rooms(view: EditorView) {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const inside = view.dom.contains(this) && this !== view.dom
      return { left: inside ? 120 : 0, right: 700, top: 40, bottom: 70, width: 580, height: 30, x: 0, y: 0, toJSON: () => ({}) }
    })
  }

  it('悬停某个块：出现 ＋ 和拖动把手；移到别的块跟过去；鼠标离开稍后收起', async () => {
    mouse()
    const { view, el } = await mountText(SOURCE)
    rooms(view)
    hover(view, view.dom.children[1] as HTMLElement)
    expect(el.querySelector('.kb-block-handle')).not.toBeNull()
    expect(el.querySelector('.kb-block-handle [data-action="block-add"]')).not.toBeNull()
    expect(el.querySelector<HTMLElement>('.kb-block-handle [data-action="block-grip"]')!.draggable).toBe(true)
    // 两个按钮画的是工具栏同一套线性 SVG，不再用 ＋ ⠿ 字符；可访问名称里也不带字符
    for (const action of ['block-add', 'block-grip']) {
      const button = el.querySelector<HTMLElement>(`.kb-block-handle [data-action="${action}"]`)!
      expect(button.querySelector('svg.kb-tool-icon path')).not.toBeNull()
      expect(button.textContent).toBe('')
      expect(button.getAttribute('aria-label')).not.toMatch(/[＋⠿]/)
    }
    el.dispatchEvent(new MouseEvent('mouseleave'))
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(el.querySelector('.kb-block-handle')).toBeNull()
  })

  it('触屏（没有悬停）/ 只读 / 左边放不下：不出现', async () => {
    const touch = await mountText(SOURCE)
    hover(touch.view, touch.view.dom.children[0] as HTMLElement)
    expect(touch.el.querySelector('.kb-block-handle')).toBeNull()
    cleanupText()
    mouse()
    const ro = await mountText(SOURCE, { readonly: true })
    rooms(ro.view)
    hover(ro.view, ro.view.dom.children[0] as HTMLElement)
    expect(ro.el.querySelector('.kb-block-handle')).toBeNull()
    cleanupText()
    mouse()
    const narrow = await mountText(SOURCE)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 10, right: 300, top: 0, bottom: 30, width: 290, height: 30, x: 0, y: 0, toJSON: () => ({}) })
    hover(narrow.view, narrow.view.dom.children[0] as HTMLElement)
    expect(narrow.el.querySelector('.kb-block-handle')).toBeNull()
  })

  it('点 ＋：在这个块下面新起一段并打出 /（斜杠菜单随之出现）', async () => {
    mouse()
    const { view, el } = await mountText(SOURCE)
    rooms(view)
    hover(view, view.dom.children[1] as HTMLElement)
    el.querySelector<HTMLButtonElement>('[data-action="block-add"]')!.click()
    expect(blocks(view)).toEqual(['heading:一', 'paragraph:第二段', 'paragraph:/', 'bullet_list:三', 'paragraph:第四段'])
    expect(view.state.selection.$from.parent.textContent).toBe('/')
  })

  it('拖动把手：整块变成节点选区，视图记下“正在移动它”', async () => {
    mouse()
    const { view, el } = await mountText(SOURCE)
    rooms(view)
    hover(view, view.dom.children[1] as HTMLElement)
    const data: Record<string, string> = {}
    const event = new Event('dragstart', { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown }
    event.dataTransfer = { effectAllowed: '', setDragImage: () => undefined, setData: (k: string, v: string) => (data[k] = v) }
    el.querySelector('[data-action="block-grip"]')!.dispatchEvent(event)
    const dragging = (view as unknown as { dragging: { slice: { content: { firstChild: { textContent: string } } }; move: boolean } }).dragging
    expect(dragging.move).toBe(true)
    expect(dragging.slice.content.firstChild.textContent).toBe('第二段')
    expect(view.state.selection.constructor.name).toBe('NodeSelection')
    expect(data['text/plain']).toBe('第二段')
  })

  it('文档变化让当前块失效：手柄收起，不指向已经不存在的块', async () => {
    mouse()
    const { view, el } = await mountText(SOURCE)
    rooms(view)
    hover(view, view.dom.children[1] as HTMLElement)
    expect(el.querySelector('.kb-block-handle')).not.toBeNull()
    caretIn(view, '第二段')
    view.dispatch(view.state.tr.insertText('改', view.state.selection.from))
    expect(el.querySelector('.kb-block-handle')).toBeNull()
  })
})

describe('块菜单（点 ⠿）', () => {
  function hover(view: EditorView, index: number) {
    let start = 0
    for (let i = 0; i < index; i += 1) start += view.state.doc.child(i).nodeSize
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: start + 1, inside: start })
    view.dom.parentElement!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 200, clientY: 40 }))
  }
  async function openMenuOn(source: string, index: number) {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: /hover: hover/.test(query), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }))
    const mounted = await mountText(source)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const inside = mounted.view.dom.contains(this) && this !== mounted.view.dom
      return { left: inside ? 120 : 0, right: 700, top: 40, bottom: 70, width: 580, height: 30, x: 0, y: 0, toJSON: () => ({}) }
    })
    hover(mounted.view, index)
    const grip = mounted.el.querySelector<HTMLButtonElement>('[data-action="block-grip"]')!
    grip.click()
    const menu = mounted.el.querySelector<HTMLElement>('[data-testid="block-menu"]')
    return { ...mounted, grip, menu }
  }
  const item = (menu: HTMLElement | null, action: string) => menu!.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!

  it('点把手打开菜单：当前类型打勾不可点，列出能转换的类型和复制 / 上移 / 下移 / 删除；焦点进到第一项', async () => {
    const { grip, menu } = await openMenuOn(SOURCE, 1)
    expect(menu).not.toBeNull()
    expect(menu!.getAttribute('role')).toBe('menu')
    expect(grip.getAttribute('aria-expanded')).toBe('true')
    const paragraph = item(menu, 'convert-paragraph')
    expect(paragraph.getAttribute('aria-checked')).toBe('true')
    expect(paragraph.disabled).toBe(true)
    for (const action of ['convert-heading1', 'convert-quote', 'convert-bullet', 'convert-task', 'convert-code', 'duplicate', 'move-up', 'move-down', 'delete']) {
      expect(item(menu, action), action).not.toBeNull()
    }
    // 菜单项的图标是线性 SVG（标题是「H1」文字），不是字符
    expect(item(menu, 'duplicate').querySelector('svg.kb-tool-icon')).not.toBeNull()
    expect(item(menu, 'convert-heading1').textContent).toContain('H1')
    expect(document.activeElement).toBe(item(menu, 'convert-heading1'))
  })

  it('转换为二级标题：一步可撤销，保存的 Markdown 对；菜单收起、焦点回到正文', async () => {
    const { view, menu, el, surface } = await openMenuOn('甲\n\n乙', 1)
    item(menu, 'convert-heading2').click()
    expect(blocks(view)).toEqual(['paragraph:甲', 'heading:乙'])
    expect(el.querySelector('[data-testid="block-menu"]')).toBeNull()
    expect(((await surface.query({ type: 'text' })) as string).trim()).toBe('甲\n\n## 乙')
    await surface.command({ id: 'u', type: 'undo', source: 'user' })
    expect(((await surface.query({ type: 'text' })) as string).trim()).toBe('甲\n\n乙')
  })

  it('段落变任务列表 / 列表互转 / 列表拆回段落：Markdown 对得上', async () => {
    const task = await openMenuOn('甲\n\n乙', 1)
    item(task.menu, 'convert-task').click()
    expect(((await task.surface.query({ type: 'text' })) as string).trim()).toBe('甲\n\n- [ ] 乙')
    cleanupText()
    const list = await openMenuOn('- 一\n- 二', 0)
    item(list.menu, 'convert-ordered').click()
    expect(((await list.surface.query({ type: 'text' })) as string).trim()).toBe('1. 一\n2. 二')
    cleanupText()
    const flat = await openMenuOn('- 一\n- 二', 0)
    // 列表只能变正文或别的列表，没有标题 / 代码块
    expect(flat.menu!.querySelector('[data-action="convert-heading1"]')).toBeNull()
    item(flat.menu, 'convert-paragraph').click()
    expect(blocks(flat.view)).toEqual(['paragraph:一', 'paragraph:二'])
  })

  it('复制一份 / 下移 / 删除', async () => {
    const dup = await openMenuOn('甲\n\n乙\n\n丙', 1)
    item(dup.menu, 'duplicate').click()
    expect(blocks(dup.view)).toEqual(['paragraph:甲', 'paragraph:乙', 'paragraph:乙', 'paragraph:丙'])
    cleanupText()
    const move = await openMenuOn('甲\n\n乙\n\n丙', 1)
    item(move.menu, 'move-down').click()
    expect(blocks(move.view)).toEqual(['paragraph:甲', 'paragraph:丙', 'paragraph:乙'])
    cleanupText()
    const del = await openMenuOn('甲\n\n乙\n\n丙', 1)
    item(del.menu, 'delete').click()
    expect(blocks(del.view)).toEqual(['paragraph:甲', 'paragraph:丙'])
  })

  it('第一个块的「上移」、最后一个块的「下移」置灰', async () => {
    const first = await openMenuOn('甲\n\n乙', 0)
    expect(item(first.menu, 'move-up').disabled).toBe(true)
    expect(item(first.menu, 'move-down').disabled).toBe(false)
  })

  it('提示块 / 表格这类转换会丢结构的块：不显示「转换为」，只有复制 / 移动 / 删除', async () => {
    const { menu } = await openMenuOn('> [!TIP]\n> 先看这里\n\n正文', 0)
    expect(menu!.querySelector('[data-action^="convert-"]')).toBeNull()
    expect(item(menu, 'duplicate')).not.toBeNull()
  })

  it('Esc 收起菜单，焦点回到正文；方向键在可用项之间移动', async () => {
    const { menu, el, view } = await openMenuOn('甲\n\n乙\n\n丙', 1)
    menu!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(item(menu, 'convert-heading2'))
    menu!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(item(menu, 'delete'))
    menu!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(el.querySelector('[data-testid="block-menu"]')).toBeNull()
    expect(view.hasFocus() || document.activeElement === view.dom).toBe(true)
  })

  it('菜单开着时文档被改（例如别人改了这个块）：菜单收起，不对着旧位置操作', async () => {
    const { view, el } = await openMenuOn('甲\n\n乙', 1)
    caretIn(view, '乙')
    view.dispatch(view.state.tr.insertText('改', view.state.selection.from))
    expect(el.querySelector('[data-testid="block-menu"]')).toBeNull()
  })

  it('点菜单外面收起', async () => {
    const { el } = await openMenuOn('甲\n\n乙', 1)
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(el.querySelector('[data-testid="block-menu"]')).toBeNull()
  })
})
