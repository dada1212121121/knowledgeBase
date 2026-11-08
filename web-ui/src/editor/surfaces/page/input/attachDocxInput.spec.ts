/**
 * 隐藏输入框的行为单测：键盘、输入法组合、剪贴板、只读、定位。
 * 对应门禁 `e2e/docx-edit-ime.mjs` 里的真实浏览器场景；这里用假 session 验证「事件 → 命令意图」的翻译，
 * 真实输入法的候选窗、光标落点只能在浏览器里验证，不在这里声称。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireBeforeInput, fireComposition, fireInput, fireKey, mountInput, type InputHarness } from './inputHarness.testing'

let current: InputHarness | null = null
const mount = (...args: Parameters<typeof mountInput>) => (current = mountInput(...args))
afterEach(() => {
  current?.dispose()
  current = null
  document.body.innerHTML = ''
})

/** 模拟浏览器的一次可打印字符输入：keydown → beforeinput → value 变化 → input */
function type(h: InputHarness, char: string) {
  fireKey(h.textarea, char)
  fireBeforeInput(h.textarea, 'insertText', char)
  h.textarea.value = char
  fireInput(h.textarea, 'insertText', char)
}

describe('键盘输入', () => {
  it('可打印字符 → insertText，提交后清空 textarea', async () => {
    const h = mount()
    type(h, 'a')
    await h.waitForSubmitted(1)
    expect(h.kinds()).toEqual(['insertText'])
    expect(h.submitted[0]!.payload).toEqual({ text: 'a' })
    expect(h.textarea.value).toBe('')
  })

  it('Backspace / Delete / Enter 各只提交一次（keydown 与 beforeinput 是同一次按键）', async () => {
    const h = mount()
    for (const [key, inputType] of [
      ['Backspace', 'deleteContentBackward'],
      ['Delete', 'deleteContentForward'],
      ['Enter', 'insertParagraph'],
    ] as const) {
      fireKey(h.textarea, key)
      fireBeforeInput(h.textarea, inputType)
      fireInput(h.textarea, inputType)
      h.textarea.dispatchEvent(new KeyboardEvent('keyup', { key }))
    }
    await h.settleTasks()
    expect(h.kinds()).toEqual(['deleteBackward', 'deleteForward', 'paragraphBreak'])
  })

  it('方向键 → navigate，Shift 扩选', async () => {
    const h = mount()
    fireKey(h.textarea, 'ArrowLeft')
    h.textarea.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft' }))
    fireKey(h.textarea, 'ArrowRight', { shiftKey: true })
    await h.waitForSubmitted(2)
    expect(h.kinds()).toEqual(['navigate', 'navigate'])
    expect(h.submitted[0]!.payload).toMatchObject({ direction: 'backward', extend: false })
    expect(h.submitted[1]!.payload).toMatchObject({ direction: 'forward', extend: true })
  })

  it('Ctrl+B 切换粗体，按住重复不重复提交', async () => {
    const h = mount()
    fireKey(h.textarea, 'b', { ctrlKey: true })
    fireKey(h.textarea, 'b', { ctrlKey: true, repeat: true })
    await h.settleTasks()
    expect(h.kinds()).toEqual(['toggleMark'])
    expect(h.submitted[0]!.payload).toEqual({ mark: { type: 'bold' } })
  })

  it('普通段落里的 Tab → 插入制表符，并阻止浏览器切走焦点', async () => {
    const h = mount()
    const event = fireKey(h.textarea, 'Tab')
    await h.waitForSubmitted(1)
    expect(event.defaultPrevented).toBe(true)
    expect(h.kinds()).toEqual(['insertText'])
    expect(h.submitted[0]!.payload).toEqual({ text: '\t' })
  })

  it('Escape 之后的 Tab 把焦点还给页面（键盘陷阱出口）', async () => {
    const h = mount()
    fireKey(h.textarea, 'Escape')
    const event = fireKey(h.textarea, 'Tab')
    await h.settleTasks()
    expect(event.defaultPrevented).toBe(false)
    expect(h.kinds()).toEqual([])
  })

  it('表格里的 Tab → 交给外壳做单元格导航，不插制表符', async () => {
    const onNavigateCell = vi.fn()
    const h = mount({ onNavigateCell })
    ;(h.snapshot.editState as { tableContext: unknown }).tableContext = { row: 0, column: 0 }
    fireKey(h.textarea, 'Tab')
    fireKey(h.textarea, 'Tab', { shiftKey: true })
    await h.settleTasks()
    expect(onNavigateCell.mock.calls).toEqual([['forward'], ['backward']])
    expect(h.kinds()).toEqual([])
  })
})

describe('中文输入法组合', () => {
  it('组合期间不上屏，结束时一次性提交整段文字', async () => {
    const states: Array<string | undefined> = []
    const h = mount({ onCompositionChange: (state) => states.push(state?.text) })
    fireKey(h.textarea, 'Process', { keyCode: 229 })
    fireComposition(h.textarea, 'compositionstart')
    for (const preedit of ['n', 'ni', 'ni hao']) {
      h.textarea.value = preedit
      fireBeforeInput(h.textarea, 'insertCompositionText', preedit)
      fireInput(h.textarea, 'insertCompositionText', preedit, true)
      fireComposition(h.textarea, 'compositionupdate', preedit)
    }
    await h.settleTasks()
    expect(h.kinds()).toEqual([])
    // 预编辑文字留在 textarea 里供输入法继续使用
    expect(h.textarea.value).toBe('ni hao')

    fireComposition(h.textarea, 'compositionend', '你好')
    await h.waitForSubmitted(1)
    expect(h.textarea.value).toBe('')
    const texts = h.submitted.map((entry) => entry.payload.text)
    expect(texts).toContain('你好')
    expect(states.at(-1)).toBeDefined()
  })

  it('Safari 式的尾部重复上屏（compositionend 之后又来一次同样的 insertText）不重复提交', async () => {
    const h = mount()
    fireComposition(h.textarea, 'compositionstart')
    h.textarea.value = '你好'
    fireComposition(h.textarea, 'compositionupdate', '你好')
    fireComposition(h.textarea, 'compositionend', '你好')
    await h.waitForSubmitted(1)
    const before = h.submitted.length
    fireBeforeInput(h.textarea, 'insertText', '你好')
    h.textarea.value = '你好'
    fireInput(h.textarea, 'insertText', '你好')
    await h.settleTasks()
    expect(h.submitted.length).toBe(before)
  })

  it('对照：没有刚结束的组合时，同样的 insertText 会正常提交（上一条不是空过）', async () => {
    const h = mount()
    fireBeforeInput(h.textarea, 'insertText', '你好')
    h.textarea.value = '你好'
    fireInput(h.textarea, 'insertText', '你好')
    await h.waitForSubmitted(1)
    expect(h.kinds()).toEqual(['insertText'])
  })

  it('引擎拒绝组合上屏时，文字交还给用户而不是吞掉', async () => {
    const onRecoverableText = vi.fn()
    const h = mount({ onRecoverableText })
    fireComposition(h.textarea, 'compositionstart')
    fireComposition(h.textarea, 'compositionupdate', '你好')
    fireComposition(h.textarea, 'compositionend', '你好')
    await h.waitForSubmitted(1)
    h.submitted[0]!.settle({ status: 'refused' })
    await h.settleTasks()
    expect(onRecoverableText).toHaveBeenCalledWith('你好')
  })

  it('卸载时还在组合：预编辑文字交还给用户，并释放引擎里的占位', () => {
    const onRecoverableText = vi.fn()
    const h = mount({ onRecoverableText })
    fireComposition(h.textarea, 'compositionstart')
    fireComposition(h.textarea, 'compositionupdate', 'wo')
    h.handle.dispose()
    expect(onRecoverableText).toHaveBeenCalledWith('wo')
  })

  it('失焦时收尾未结束的组合', async () => {
    const h = mount()
    fireComposition(h.textarea, 'compositionstart')
    fireComposition(h.textarea, 'compositionupdate', '中')
    h.textarea.dispatchEvent(new FocusEvent('blur'))
    await h.waitForSubmitted(1)
    expect(h.submitted.map((entry) => entry.payload.text)).toContain('中')
  })
})

describe('剪贴板', () => {
  const paste = (h: InputHarness, data: Record<string, string>) => {
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => data[type] ?? '' } })
    h.textarea.dispatchEvent(event)
    return event
  }

  it('纯文本粘贴 → replaceSelection，换行拆成段落', async () => {
    const h = mount()
    const event = paste(h, { 'text/plain': '第一行\n第二行' })
    await h.waitForSubmitted(3)
    expect(event.defaultPrevented).toBe(true)
    expect(h.kinds()).toEqual(['replaceSelection', 'paragraphBreak', 'insertText'])
    expect(h.submitted[0]!.payload).toEqual({ text: '第一行' })
    expect(h.submitted[2]!.payload).toEqual({ text: '第二行' })
  })

  const TABLE_HTML = '<table><tr><td>甲</td><td>乙</td></tr><tr><td>丙</td><td>丁</td></tr></table>'

  it('带表格的 HTML 被外壳接走时不再按纯文本提交', async () => {
    const onPasteFragment = vi.fn(() => true)
    const h = mount({ onPasteFragment })
    paste(h, { 'text/html': TABLE_HTML, 'text/plain': '甲\t乙\n丙\t丁' })
    await h.settleTasks()
    expect(onPasteFragment).toHaveBeenCalledTimes(1)
    expect(h.kinds()).toEqual([])
  })

  it('外壳不接 HTML 片段时回落到纯文本', async () => {
    const onPasteFragment = vi.fn(() => false)
    const h = mount({ onPasteFragment })
    paste(h, { 'text/html': TABLE_HTML, 'text/plain': '甲乙' })
    await h.waitForSubmitted(1)
    expect(onPasteFragment).toHaveBeenCalledTimes(1)
    expect(h.kinds()).toEqual(['replaceSelection'])
  })

  it('没有表格的普通 HTML 不走片段，按纯文本粘贴', async () => {
    const onPasteFragment = vi.fn(() => true)
    const h = mount({ onPasteFragment })
    paste(h, { 'text/html': '<p>你好 <b>世界</b></p>', 'text/plain': '你好 世界' })
    await h.waitForSubmitted(1)
    expect(onPasteFragment).not.toHaveBeenCalled()
    expect(h.submitted[0]!.payload).toEqual({ text: '你好 世界' })
  })

  it('复制 / 剪切交给外壳，组合期间不处理', async () => {
    const onClipboard = vi.fn(async () => undefined)
    const h = mount({ onClipboard })
    h.textarea.dispatchEvent(new Event('copy', { bubbles: true, cancelable: true }))
    h.textarea.dispatchEvent(new Event('cut', { bubbles: true, cancelable: true }))
    expect((onClipboard.mock.calls as unknown as Array<[boolean]>).map((call) => call[0])).toEqual([false, true])
    fireComposition(h.textarea, 'compositionstart')
    h.textarea.dispatchEvent(new Event('copy', { bubbles: true, cancelable: true }))
    expect(onClipboard).toHaveBeenCalledTimes(2)
  })
})

describe('只读', () => {
  it('textarea 置只读，字符键与删除键被拦下，不提交任何改字命令', async () => {
    const h = mount({ readOnly: true })
    expect(h.textarea.readOnly).toBe(true)
    const a = fireKey(h.textarea, 'a')
    const backspace = fireKey(h.textarea, 'Backspace')
    const tab = fireKey(h.textarea, 'Tab')
    await h.settleTasks()
    expect(a.defaultPrevented).toBe(true)
    expect(backspace.defaultPrevented).toBe(true)
    // 只读的 Tab 让浏览器切焦点，不吞
    expect(tab.defaultPrevented).toBe(false)
    // 准入队列自己会提交 setReadOnly；除此之外不能有任何改字命令
    expect(h.kinds().filter((kind) => kind !== 'navigate' && kind !== 'setReadOnly')).toEqual([])
  })

  it('只读时引擎不认识的输入类型（如 insertFromYank）也不能改动 textarea', async () => {
    const h = mount({ readOnly: true })
    const event = fireBeforeInput(h.textarea, 'insertFromYank', '字')
    await h.settleTasks()
    expect(event.defaultPrevented).toBe(true)
    expect(h.kinds().filter((kind) => kind !== 'setReadOnly')).toEqual([])
  })

  it('对照：可编辑时同样的未知输入类型不被我们拦（交给浏览器，随后 input 事件再清空）', () => {
    const h = mount()
    expect(fireBeforeInput(h.textarea, 'insertFromYank', '字').defaultPrevented).toBe(false)
  })

  it('运行中切换只读会同步 textarea', () => {
    const h = mount()
    expect(h.textarea.readOnly).toBe(false)
    h.setReadOnly(true)
    expect(h.textarea.readOnly).toBe(true)
  })

  it('只读时不开始输入法组合', () => {
    const states: unknown[] = []
    const h = mount({ readOnly: true, onCompositionChange: (state) => states.push(state) })
    fireComposition(h.textarea, 'compositionstart')
    expect(states).toEqual([])
  })
})

describe('定位与卸载', () => {
  it('输入框跟着光标走：宿主左上角 + 光标坐标 × 缩放', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    host.getBoundingClientRect = () => ({ left: 100, top: 50, width: 800, height: 1000 }) as DOMRect
    const h = mount({ host, getZoom: () => 2 })
    h.installGeometry({ caret: { x: 10, y: 20, width: 1, height: 12, pageIndex: 0 } as never })
    expect(h.textarea.style.left).toBe('120px')
    expect(h.textarea.style.top).toBe('90px')
    expect(h.textarea.style.height).toBe('24px')
  })

  it('几何还没覆盖到最新输入时不移动输入框', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const h = mount({ host })
    h.snapshot.throughSeq = 5
    h.installGeometry({ coversThroughSeq: 3, caret: { x: 10, y: 20, width: 1, height: 12, pageIndex: 0 } as never })
    expect(h.textarea.style.left).toBe('')
  })

  it('卸载后不再响应事件', async () => {
    const h = mount()
    h.handle.dispose()
    type(h, 'a')
    await h.settleTasks()
    expect(h.kinds()).toEqual([])
  })
})
