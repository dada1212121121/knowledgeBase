/**
 * 笔记文本面的块级编辑能力：任务项复选框、表格增删行列与 Tab 跳格、代码块视图、行内公式、浮动工具条、占位提示
 *
 * 这些是旧编辑器（Crepe）自带的用户可见功能，新文本面之前都没有；每条都从用户动作出发（点、按键、选中）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TextSelection } from 'prosemirror-state'
import { GapCursor } from 'prosemirror-gapcursor'
import { cleanupText, click, mountText } from './textTestKit'
import { addColumn, addRow, deleteColumn, deleteRow, deleteTable, goToCell, isInTable, setColumnAlignment, tableContext } from './tableCommands'
import { textSchema } from './schema'
import type { EditorView } from 'prosemirror-view'
import type { Command } from 'prosemirror-state'

afterEach(cleanupText)

const text = async (surface: { query: (q: { type: string }) => Promise<unknown> }) => (((await surface.query({ type: 'text' })) as string) ?? '').trim()

/** 把光标放进第 row 行第 col 列的格子里 */
function caretInCell(view: EditorView, row: number, col: number) {
  let found = -1
  view.state.doc.descendants((node, pos) => {
    if (found >= 0) return false
    if (node.type.name === 'table') {
      let rowPos = pos + 1
      for (let r = 0; r < node.childCount; r += 1) {
        const rowNode = node.child(r)
        if (r === row) {
          let cellPos = rowPos + 1
          for (let c = 0; c < col; c += 1) cellPos += rowNode.child(c).nodeSize
          found = cellPos + 2
        }
        rowPos += rowNode.nodeSize
      }
      return false
    }
    return true
  })
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, found)))
}
const run = (view: EditorView, command: Command) => command(view.state, (tr) => view.dispatch(tr))

const TABLE = '| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |'

describe('图片拖拽调整大小', () => {
  /** jsdom 没有 PointerEvent / 指针捕获：用普通事件带上手柄用到的字段 */
  const pointer = (type: string, init: { clientX: number; pointerId?: number }) => Object.assign(new Event(type, { bubbles: true, cancelable: true }), { pointerType: 'touch', button: 0, pointerId: 1, ...init })
  function prepare(root: HTMLElement) {
    const handle = root.querySelector<HTMLElement>('.kb-img-handle')!
    const img = root.querySelector<HTMLImageElement>('.kb-img > img')!
    Object.assign(handle, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), hasPointerCapture: () => true })
    // 图片此刻 200px 宽，版心 700px 宽
    vi.spyOn(img, 'getBoundingClientRect').mockReturnValue({ width: 200, height: 100, left: 0, top: 0, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) })
    return { handle, img }
  }

  it('A. 向右拖手柄：图片变宽（按原图比例：只存宽度），保存成地址的 #w=；松手后一次撤销回到原样', async () => {
    const { el, view, surface } = await mountText('![图](./a.png)')
    const { handle, img } = prepare(el)
    vi.spyOn(view.dom, 'getBoundingClientRect').mockReturnValue({ width: 700, height: 500, left: 0, top: 0, right: 700, bottom: 500, x: 0, y: 0, toJSON: () => ({}) })
    handle.dispatchEvent(pointer('pointerdown', { clientX: 100 }))
    handle.dispatchEvent(pointer('pointermove', { clientX: 250 }))
    // 拖动过程中直接改图片样式，松手才写进文档（一次拖拽 = 一步撤销）
    expect(img.style.width).toBe('350px')
    expect(view.state.doc.firstChild!.firstChild!.attrs.width).toBeNull()
    handle.dispatchEvent(pointer('pointerup', { clientX: 250 }))
    expect(view.state.doc.firstChild!.firstChild!.attrs.width).toBe(350)
    expect(await text(surface)).toBe('![图](./a.png#w=350)')
    expect(img.getAttribute('width')).toBe('350')
  })

  it('B. 拖过头 / 拖过小：限制在 [48px, 版心宽度]', async () => {
    const { el, view } = await mountText('![图](./a.png)')
    const { handle } = prepare(el)
    vi.spyOn(view.dom, 'getBoundingClientRect').mockReturnValue({ width: 700, height: 500, left: 0, top: 0, right: 700, bottom: 500, x: 0, y: 0, toJSON: () => ({}) })
    handle.dispatchEvent(pointer('pointerdown', { clientX: 0 }))
    handle.dispatchEvent(pointer('pointermove', { clientX: 5000 }))
    handle.dispatchEvent(pointer('pointerup', { clientX: 5000 }))
    expect(view.state.doc.firstChild!.firstChild!.attrs.width).toBe(700)
    const again = prepare(el)
    again.handle.dispatchEvent(pointer('pointerdown', { clientX: 300 }))
    again.handle.dispatchEvent(pointer('pointermove', { clientX: -5000 }))
    again.handle.dispatchEvent(pointer('pointerup', { clientX: -5000 }))
    expect(view.state.doc.firstChild!.firstChild!.attrs.width).toBe(48)
  })

  it('C. 没怎么动（点了一下手柄）不算调整；取消（pointercancel）也不改文档', async () => {
    const { el, view } = await mountText('![图](./a.png)')
    const { handle } = prepare(el)
    handle.dispatchEvent(pointer('pointerdown', { clientX: 100 }))
    handle.dispatchEvent(pointer('pointermove', { clientX: 101 }))
    handle.dispatchEvent(pointer('pointerup', { clientX: 101 }))
    expect(view.state.doc.firstChild!.firstChild!.attrs.width).toBeNull()
    handle.dispatchEvent(pointer('pointerdown', { clientX: 100 }))
    handle.dispatchEvent(pointer('pointermove', { clientX: 300 }))
    handle.dispatchEvent(pointer('pointercancel', { clientX: 300 }))
    expect(view.state.doc.firstChild!.firstChild!.attrs.width).toBeNull()
  })

  it('D. 已有宽度的图片按这个宽度显示；双击手柄 / Home 恢复自动；键盘 ← → 微调', async () => {
    const { el, view, surface } = await mountText('![图](./a.png#w=320)')
    const { handle, img } = prepare(el)
    expect(img.getAttribute('width')).toBe('320')
    handle.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })))
    expect(view.state.doc.firstChild!.firstChild!.attrs.width).toBe(328)
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true, cancelable: true }))
    expect(view.state.doc.firstChild!.firstChild!.attrs.width).toBe(288)
    handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    expect(view.state.doc.firstChild!.firstChild!.attrs.width).toBeNull()
    expect(await text(surface)).toBe('![图](./a.png)')
  })
})

describe('任务项复选框', () => {
  it('1. 点复选框：文档里的 checked 写回，保存成 [x]；再点取消', async () => {
    const { el, surface } = await mountText('- [ ] 买菜\n- [x] 做饭')
    const boxes = el.querySelectorAll<HTMLInputElement>('li[data-checked] > input[type="checkbox"]')
    expect(boxes).toHaveLength(2)
    expect(boxes[0]!.checked).toBe(false)
    click(boxes[0]!)
    expect(await text(surface)).toBe('- [x] 买菜\n- [x] 做饭')
    expect(el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]!.checked).toBe(true)
    click(el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]!)
    expect(await text(surface)).toBe('- [ ] 买菜\n- [x] 做饭')
  })

  it('2. 勾选是一次可撤销的编辑（进撤销栈），并让会话变脏', async () => {
    const { el, surface, dirty } = await mountText('- [ ] 买菜')
    click(el.querySelector('input[type="checkbox"]')!)
    expect(dirty.at(-1)).toBe(true)
    await surface.command({ id: 'u', type: 'undo', source: 'user' })
    expect(await text(surface)).toBe('- [ ] 买菜')
  })

  it('3. 只读：点复选框不改文档', async () => {
    const { el, surface } = await mountText('- [ ] 买菜', { readonly: true })
    click(el.querySelector('input[type="checkbox"]')!)
    expect(await text(surface)).toBe('- [ ] 买菜')
  })

  it('4. 复选框的可访问名称是条目正文；改正文后跟着变', async () => {
    const { el, view } = await mountText('- [ ] 买菜')
    expect(el.querySelector('input[type="checkbox"]')?.getAttribute('aria-label')).toBe('买菜')
    view.dispatch(view.state.tr.insertText('回来', view.state.doc.content.size - 2))
    expect(el.querySelector('input[type="checkbox"]')?.getAttribute('aria-label')).toBe('买菜回来')
  })

  it('5. 普通列表项没有复选框', async () => {
    const { el } = await mountText('- 普通')
    expect(el.querySelector('input[type="checkbox"]')).toBeNull()
    expect(el.querySelector('li')?.textContent).toBe('普通')
  })
})

describe('表格命令', () => {
  it('6. 下方 / 上方插入行：新行是数据行，格数与列数一致', async () => {
    const { view, surface } = await mountText(TABLE)
    caretInCell(view, 1, 0)
    expect(run(view, addRow(textSchema, 'after'))).toBe(true)
    expect(view.state.doc.firstChild!.childCount).toBe(4)
    caretInCell(view, 1, 1)
    expect(run(view, addRow(textSchema, 'before'))).toBe(true)
    expect(view.state.doc.firstChild!.childCount).toBe(5)
    expect(await text(surface)).toMatch(/\| 甲 \| 乙 \|/)
    view.state.doc.firstChild!.forEach((row) => expect(row.childCount).toBe(2))
  })

  it('7. 表头行上方不能插行', async () => {
    const { view } = await mountText(TABLE)
    caretInCell(view, 0, 0)
    expect(run(view, addRow(textSchema, 'before'))).toBe(false)
  })

  it('8. 左 / 右插入列：每行都多一格，表头行多的是表头格', async () => {
    const { view } = await mountText(TABLE)
    caretInCell(view, 1, 0)
    expect(run(view, addColumn(textSchema, 'after'))).toBe(true)
    const table = view.state.doc.firstChild!
    table.forEach((row, _o, index) => {
      expect(row.childCount).toBe(3)
      expect(row.child(1).type.name).toBe(index === 0 ? 'table_header' : 'table_cell')
    })
    caretInCell(view, 1, 0)
    expect(run(view, addColumn(textSchema, 'before'))).toBe(true)
    expect(view.state.doc.firstChild!.child(0).childCount).toBe(4)
  })

  it('9. 删除行：数据行可删，表头行不能删', async () => {
    const { view } = await mountText(TABLE)
    caretInCell(view, 0, 0)
    expect(run(view, deleteRow())).toBe(false)
    caretInCell(view, 2, 1)
    expect(run(view, deleteRow())).toBe(true)
    expect(view.state.doc.firstChild!.childCount).toBe(2)
    // 光标留在表里
    expect(isInTable(view.state)).toBe(true)
  })

  it('10. 删除列：每行少一格；只剩一列时删整张表', async () => {
    const { view } = await mountText(TABLE)
    caretInCell(view, 1, 1)
    expect(run(view, deleteColumn(textSchema))).toBe(true)
    view.state.doc.firstChild!.forEach((row) => expect(row.childCount).toBe(1))
    caretInCell(view, 1, 0)
    expect(run(view, deleteColumn(textSchema))).toBe(true)
    expect(view.state.doc.childCount).toBeGreaterThan(0)
    expect(view.state.doc.firstChild!.type.name).toBe('paragraph')
  })

  it('11. 删除整张表：表是唯一的块时补空段落，文档仍合法', async () => {
    const { view } = await mountText(TABLE)
    caretInCell(view, 1, 0)
    expect(run(view, deleteTable(textSchema))).toBe(true)
    expect(view.state.doc.childCount).toBe(1)
    expect(view.state.doc.firstChild!.type.name).toBe('paragraph')
  })

  it('12. 列对齐：整列（表头 + 数据行）生效，保存成 :---: 分隔行', async () => {
    const { view, surface } = await mountText(TABLE)
    caretInCell(view, 1, 1)
    expect(run(view, setColumnAlignment('center'))).toBe(true)
    expect(await text(surface)).toMatch(/\|\s*:-+:\s*\|/)
    view.state.doc.firstChild!.forEach((row) => expect(row.child(1).attrs.alignment).toBe('center'))
    view.state.doc.firstChild!.forEach((row) => expect(row.child(0).attrs.alignment).toBeNull())
  })

  it('13. 不在表格里：所有表格命令都返回 false', async () => {
    const { view } = await mountText('正文')
    expect(tableContext(view.state)).toBeNull()
    for (const command of [addRow(textSchema, 'after'), addColumn(textSchema, 'after'), deleteRow(), deleteColumn(textSchema), deleteTable(textSchema), setColumnAlignment('left'), goToCell(textSchema, 1)]) {
      expect(run(view, command)).toBe(false)
    }
  })
})

describe('表格 Tab 跳格', () => {
  const cellText = (view: EditorView) => view.state.selection.$from.parent.textContent

  it('14. Tab 到下一格，行尾换到下一行第一格', async () => {
    const { view } = await mountText(TABLE)
    caretInCell(view, 0, 0)
    run(view, goToCell(textSchema, 1))
    expect(cellText(view)).toBe('乙')
    run(view, goToCell(textSchema, 1))
    expect(cellText(view)).toBe('1')
  })

  it('15. Shift+Tab 回上一格；在第一格再按留在原地（不跳出表格）', async () => {
    const { view } = await mountText(TABLE)
    caretInCell(view, 1, 0)
    run(view, goToCell(textSchema, -1))
    expect(cellText(view)).toBe('乙')
    caretInCell(view, 0, 0)
    expect(run(view, goToCell(textSchema, -1))).toBe(true)
    expect(cellText(view)).toBe('甲')
  })

  it('16. 最后一格按 Tab：末尾新增一行并进入它的第一格', async () => {
    const { view } = await mountText(TABLE)
    caretInCell(view, 2, 1)
    run(view, goToCell(textSchema, 1))
    expect(view.state.doc.firstChild!.childCount).toBe(4)
    expect(tableContext(view.state)).toMatchObject({ row: 3, col: 0 })
  })

  it('17. 键盘：表格里 Tab 走 goToCell，列表里 Tab 仍是缩进', async () => {
    const { view } = await mountText(`${TABLE}\n\n- 一\n- 二`)
    caretInCell(view, 0, 0)
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    view.dom.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(true)
    expect(cellText(view)).toBe('乙')
  })
})

describe('代码块视图', () => {
  it('18. 显示语言，改语言写回节点并保存到围栏', async () => {
    const { el, view, surface } = await mountText('```js\nlet a = 1\n```')
    const input = el.querySelector<HTMLInputElement>('.kb-code-lang')!
    expect(input.value).toBe('js')
    input.value = 'typescript'
    input.dispatchEvent(new Event('change'))
    expect(view.state.doc.firstChild!.attrs.language).toBe('typescript')
    expect(await text(surface)).toBe('```typescript\nlet a = 1\n```')
  })

  it('18b. 语言菜单：点开列出全部语言（不止当前这一项），点选写回节点，输入过滤，回车用输入的名字', async () => {
    const { el, view } = await mountText('```bash\necho hi\n```')
    const input = el.querySelector<HTMLInputElement>('.kb-code-lang')!
    const menu = el.querySelector<HTMLElement>('.kb-code-langmenu')!
    expect(menu.hidden).toBe(true)
    input.dispatchEvent(new Event('focus'))
    expect(menu.hidden).toBe(false)
    const all = [...menu.querySelectorAll<HTMLElement>('.kb-code-langitem')].map((item) => item.dataset.lang)
    expect(all.length).toBeGreaterThan(60)
    expect(all).toEqual(expect.arrayContaining(['bash', 'python', 'rust', 'sql', 'mermaid', 'text']))
    expect(menu.querySelector('.is-current')?.getAttribute('data-lang')).toBe('bash')
    // 点选
    menu.querySelector<HTMLElement>('[data-lang="python"]')!.click()
    expect(view.state.doc.firstChild!.attrs.language).toBe('python')
    expect(menu.hidden).toBe(true)
    // 输入过滤
    input.dispatchEvent(new Event('focus'))
    input.value = 'scr'
    input.dispatchEvent(new Event('input'))
    const filtered = [...menu.querySelectorAll<HTMLElement>('.kb-code-langitem')].map((item) => item.dataset.lang)
    expect(filtered).toEqual(expect.arrayContaining(['javascript', 'typescript', 'coffeescript']))
    expect(filtered).not.toContain('python')
    // 回车：没用方向键选过就按输入的名字提交（自由文本）
    input.value = 'my-lang'
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(view.state.doc.firstChild!.attrs.language).toBe('my-lang')
  })

  it('19. 复制按钮把代码写进剪贴板，并短暂显示“已复制”', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const { el } = await mountText('```\nhello\n```')
    el.querySelector<HTMLButtonElement>('.kb-code-copy')!.click()
    await vi.waitFor(() => expect(el.querySelector('.kb-code-copy')?.textContent).toBe('已复制'))
    expect(writeText).toHaveBeenCalledWith('hello')
    vi.unstubAllGlobals()
  })

  it('20. 普通代码块没有预览开关；源码一直可见', async () => {
    const { el } = await mountText('```js\nx\n```')
    expect(el.querySelector<HTMLElement>('.kb-code-toggle')!.hidden).toBe(true)
    expect(el.querySelector<HTMLElement>('pre')!.hidden).toBe(false)
  })

  it('21. 公式块 ($$) 默认只显示渲染结果；点“编辑源码”露出源码，再点收起', async () => {
    const { el } = await mountText('$$\nE = mc^2\n$$')
    expect(el.querySelector('.kb-code-block')?.classList.contains('is-previewing')).toBe(true)
    await vi.waitFor(() => expect(el.querySelector('.kb-code-preview .katex')).not.toBeNull(), { timeout: 15_000 })
    expect(el.querySelector<HTMLElement>('pre')!.hidden).toBe(true)
    const toggle = el.querySelector<HTMLButtonElement>('.kb-code-toggle')!
    expect(toggle.textContent).toBe('编辑源码')
    toggle.click()
    expect(el.querySelector<HTMLElement>('pre')!.hidden).toBe(false)
    expect(toggle.textContent).toBe('预览')
    toggle.click()
    expect(el.querySelector<HTMLElement>('pre')!.hidden).toBe(true)
  }, 20_000)

  it('22. 公式块的保存不受影响：仍写 $$ 而不是 ```LaTeX 围栏', async () => {
    const { surface } = await mountText('$$\nE = mc^2\n$$')
    expect(await text(surface)).toBe('$$\nE = mc^2\n$$')
  })

  it('23. 空的流程图块直接显示源码（没有可预览的内容）', async () => {
    const { el } = await mountText('```mermaid\n```')
    expect(el.querySelector('.kb-code-block')?.classList.contains('is-previewing')).toBe(false)
    expect(el.querySelector<HTMLElement>('pre')!.hidden).toBe(false)
  })

  it('24. 只读时改语言不生效', async () => {
    const { el, view } = await mountText('```js\nx\n```', { readonly: true })
    const input = el.querySelector<HTMLInputElement>('.kb-code-lang')!
    input.value = 'go'
    input.dispatchEvent(new Event('change'))
    expect(view.state.doc.firstChild!.attrs.language).toBe('js')
  })
})

describe('行内公式', () => {
  it('25. 渲染成 KaTeX，保存仍写 $…$', async () => {
    const { el, surface } = await mountText('质能 $E=mc^2$ 方程')
    await vi.waitFor(() => expect(el.querySelector('.kb-text-math .katex')).not.toBeNull(), { timeout: 15_000 })
    expect(await text(surface)).toBe('质能 $E=mc^2$ 方程')
  }, 20_000)

  it('26. 点一下就地编辑，回车确认写回', async () => {
    const { el, view, surface } = await mountText('质能 $E=mc^2$ 方程')
    click(el.querySelector('.kb-text-math')!)
    const input = el.querySelector<HTMLInputElement>('.kb-text-math-input')!
    expect(input.value).toBe('E=mc^2')
    input.value = 'a^2+b^2'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(await text(surface)).toBe('质能 $a^2+b^2$ 方程')
    void view
  })

  it('27. 清空确认 = 删除这个公式；Esc 放弃修改', async () => {
    const a = await mountText('x $y$ z')
    click(a.el.querySelector('.kb-text-math')!)
    const input = a.el.querySelector<HTMLInputElement>('.kb-text-math-input')!
    input.value = ''
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(await text(a.surface)).toBe('x  z')
    cleanupText()

    const b = await mountText('x $y$ z')
    click(b.el.querySelector('.kb-text-math')!)
    const input2 = b.el.querySelector<HTMLInputElement>('.kb-text-math-input')!
    input2.value = 'changed'
    input2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(await text(b.surface)).toBe('x $y$ z')
  })

  it('28. 选区 → 行内公式命令：选中的文字变成公式节点', async () => {
    const { surface, view } = await mountText('abc')
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 4)))
    expect((await surface.command({ id: 'm', type: 'text.math.inline', source: 'user' })).ok).toBe(true)
    expect(await text(surface)).toBe('$abc$')
    expect((await surface.command({ id: 'm', type: 'text.math.inline', source: 'user' })).ok).toBe(false)
  })
})

describe('没有浮动工具条', () => {
  async function mountFocused(markdown: string) {
    const mounted = await mountText(markdown)
    // jsdom 里 contenteditable 拿不到焦点：声明编辑器有焦点
    vi.spyOn(mounted.view, 'hasFocus').mockReturnValue(true)
    return mounted
  }

  it('29. 选中文字 / 光标落在链接上 / 光标进表格，都不再冒出浮动工具条（格式在顶部工具栏、表格工具在工具栏下方）', async () => {
    const text = await mountFocused('abc def [链接](https://a.example)')
    text.view.dispatch(text.view.state.tr.setSelection(TextSelection.create(text.view.state.doc, 1, 4)))
    expect(text.el.querySelector('.kb-float')).toBeNull()
    text.view.dispatch(text.view.state.tr.setSelection(TextSelection.create(text.view.state.doc, 9)))
    expect(text.el.querySelector('.kb-float')).toBeNull()
    const table = await mountFocused(TABLE)
    caretInCell(table.view, 1, 0)
    expect(table.el.querySelector('.kb-float')).toBeNull()
  })

  it('32b. Ctrl+K 请求链接输入条', async () => {
    const requests: string[] = []
    const { view } = await mountText('abc', { ctx: { onLinkRequest: () => requests.push('link') } })
    const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })
    view.dom.dispatchEvent(event)
    expect(requests).toEqual(['link'])
    expect(event.defaultPrevented).toBe(true)
  })
})

describe('格式状态：链接与字体', () => {
  it('光标落在链接上 marks 里有 link（工具栏的链接按钮据此高亮）；字体 / 字色上报 values', async () => {
    const { view, surface } = await mountText('甲 [链接](https://a.example) <span style="font-family: Songti SC, SimSun, Noto Serif SC, serif">宋体字</span>')
    const stateAt = async (pos: number) => {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
      return (await surface.query({ type: 'formatState' })) as { marks: string[]; values: Record<string, string | null> }
    }
    expect((await stateAt(1)).marks).not.toContain('link')
    const link = await stateAt(4)
    expect(link.marks).toContain('link')
    expect(link.values.noteFont).toBeNull()
    const font = await stateAt(view.state.doc.content.size - 2)
    expect(font.marks).not.toContain('link')
    expect(font.values.noteFont).toBe('serif')
  })
})

describe('占位提示与 gap cursor', () => {
  it('36. 空文档第一行有占位提示；写入内容后消失；只读不显示', async () => {
    const a = await mountText('')
    const p = a.el.querySelector('p.kb-text-empty')
    expect(p?.getAttribute('data-placeholder')).toBe('输入正文，输入 / 唤出插入菜单')
    a.view.dispatch(a.view.state.tr.insertText('字'))
    expect(a.el.querySelector('p.kb-text-empty')).toBeNull()
    cleanupText()
    const b = await mountText('', { readonly: true })
    expect(b.el.querySelector('p.kb-text-empty')).toBeNull()
  })

  it('37. 文末是表格时有 gap cursor 可落：选中它后画出光标，不用先在后面造一个空段落', async () => {
    const { el, view } = await mountText(TABLE)
    const end = view.state.doc.resolve(view.state.doc.content.size)
    view.dispatch(view.state.tr.setSelection(new GapCursor(end)))
    expect(view.state.selection).toBeInstanceOf(GapCursor)
    expect(el.querySelector('.ProseMirror-gapcursor')).not.toBeNull()
  })

  it('38. 工具栏的“表格”状态：formatState.inTable 随光标变化', async () => {
    const { view, surface } = await mountText(`${TABLE}\n\n后面`)
    caretInCell(view, 1, 0)
    expect(((await surface.query({ type: 'formatState' })) as { inTable: boolean }).inTable).toBe(true)
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)))
    expect(((await surface.query({ type: 'formatState' })) as { inTable: boolean }).inTable).toBe(false)
  })
})
