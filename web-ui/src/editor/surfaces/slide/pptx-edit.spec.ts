/**
 * 幻灯片编辑控制器测试：假编辑后端，不依赖引擎和 DOM 手势。
 * 覆盖选择 / 拖动 / 缩放 / 吸附 / 文字输入 / 输入法 / 格式 / 插入 / 层级 / 对齐 / 页操作 / 撤销 / 只读 / 错误。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeFakeEditBackend, type FakeEditBackend } from './fakeEditBackend'
import { SlideEditor, type EditorHooks } from './pptx-edit'

const editors: SlideEditor[] = []
afterEach(() => {
  for (const editor of editors.splice(0)) editor.dispose()
})

function setup(options: Parameters<typeof makeFakeEditBackend>[0] = {}, extra: Omit<Partial<EditorHooks>, 'index' | 'scale'> & { index?: number; scale?: number } = {}) {
  const backend = makeFakeEditBackend(options)
  const goto = vi.fn()
  const focus = vi.fn()
  const notes: string[] = []
  let index = extra.index ?? 0
  const editor = new SlideEditor({
    backend,
    index: () => index,
    scale: () => extra.scale ?? 1,
    gotoSlide: (i) => {
      index = i
      goto(i)
    },
    focusInput: focus,
    notify: (message) => notes.push(message),
  })
  editors.push(editor)
  return { backend, editor, goto, focus, notes, setIndex: (i: number) => (index = i) }
}

const callsOf = (backend: FakeEditBackend, prefix: string) => backend.calls.filter((call) => call.startsWith(prefix))
/** body0：x 100~600，y 200~400；文本区域从 x=110 起，每字符 10px */
const INSIDE_BODY = { x: 190, y: 300 }
const BODY_BORDER = { x: 102, y: 300 }

describe('选择', () => {
  it('点文本框中间 → 进入文字编辑（光标落在点中的位置）并要求输入框拿到焦点', () => {
    const { editor, focus } = setup()
    expect(editor.pointerDown(INSIDE_BODY)).toBe('text')
    expect(editor.selected.value).toEqual(['body0'])
    expect(editor.text.value).toMatchObject({ shapeId: 'body0', anchor: 8, focus: 8 })
    expect(editor.caret.value).toMatchObject({ x: 190 })
    expect(focus).toHaveBeenCalled()
  })

  it('点边框 / 图片 → 只选中形状；点空白 → 清空选择', () => {
    const { editor } = setup()
    expect(editor.pointerDown(BODY_BORDER)).toBe('shape')
    expect(editor.selected.value).toEqual(['body0'])
    expect(editor.text.value).toBeNull()
    editor.pointerUp()
    expect(editor.pointerDown({ x: 750, y: 250 })).toBe('shape')
    expect(editor.selected.value).toEqual(['pic0'])
    editor.pointerUp()
    expect(editor.pointerDown({ x: 1200, y: 650 })).toBe('none')
    expect(editor.selected.value).toEqual([])
  })

  it('Shift 点击加选 / 取消', () => {
    const { editor } = setup()
    editor.pointerDown(BODY_BORDER)
    editor.pointerUp()
    editor.pointerDown({ x: 750, y: 250 }, { shift: true })
    editor.pointerUp()
    expect(editor.selected.value).toEqual(['body0', 'pic0'])
    editor.pointerDown({ x: 750, y: 250 }, { shift: true })
    editor.pointerUp()
    expect(editor.selected.value).toEqual(['body0'])
  })

  it('双击带文字的形状边框 → 进入文字编辑，光标在末尾', () => {
    const { editor } = setup()
    expect(editor.pointerDown(BODY_BORDER, { detail: 2 })).toBe('text')
    expect(editor.text.value).toMatchObject({ shapeId: 'body0', anchor: 11, focus: 11 })
  })

  it('Tab 在形状间循环；Ctrl+A 全选；Esc 清空', () => {
    const { editor } = setup()
    expect(editor.shapeKeyDown({ key: 'Tab', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false })).toBe(true)
    expect(editor.selected.value).toEqual(['title0'])
    editor.shapeKeyDown({ key: 'Tab', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false })
    expect(editor.selected.value).toEqual(['body0'])
    editor.shapeKeyDown({ key: 'Tab', shiftKey: true, ctrlKey: false, metaKey: false, altKey: false })
    expect(editor.selected.value).toEqual(['title0'])
    editor.shapeKeyDown({ key: 'a', shiftKey: false, ctrlKey: true, metaKey: false, altKey: false })
    expect(editor.selected.value).toEqual(['title0', 'body0', 'pic0'])
    editor.shapeKeyDown({ key: 'Escape', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false })
    expect(editor.selected.value).toEqual([])
  })
})

describe('拖动与缩放', () => {
  it('拖动期间只更新虚框，不改文档；松手一次提交；提交前先在撤销栈里切一刀', () => {
    const { editor, backend } = setup()
    editor.pointerDown(BODY_BORDER)
    editor.pointerMove({ x: 152, y: 340 })
    expect(editor.preview.value?.get('body0')).toMatchObject({ x: 150, y: 240 })
    expect(callsOf(backend, 'setRect')).toEqual([])
    editor.pointerUp()
    expect(callsOf(backend, 'setRect')).toEqual(['setRect:body0:150,240,500,200'])
    expect(backend.calls.indexOf('boundary')).toBeLessThan(backend.calls.indexOf('setRect:body0:150,240,500,200'))
    expect(editor.preview.value).toBeNull()
    expect(editor.shapes.value.find((s) => s.id === 'body0')!.rect).toMatchObject({ x: 150, y: 240 })
  })

  it('没超过拖动阈值（3 个屏幕像素）不算拖动，也不提交', () => {
    const { editor, backend } = setup({}, { scale: 1 })
    editor.pointerDown(BODY_BORDER)
    editor.pointerMove({ x: 103, y: 301 })
    expect(editor.preview.value).toBeNull()
    editor.pointerUp()
    expect(callsOf(backend, 'setRect')).toEqual([])
  })

  it('阈值按屏幕像素算：放大 4 倍时幻灯片坐标里 1 个单位就超过了', () => {
    const { editor } = setup({}, { scale: 4 })
    editor.pointerDown({ x: 100.5, y: 300 })
    editor.pointerMove({ x: 101.5, y: 300 })
    expect(editor.preview.value).not.toBeNull()
  })

  it('多选一起移动，位移相同；图片也跟着动', () => {
    const { editor, backend } = setup()
    editor.select(['body0', 'pic0'])
    editor.pointerDown({ x: 750, y: 250 })
    editor.pointerMove({ x: 760, y: 280 })
    editor.pointerUp()
    expect(callsOf(backend, 'setRect').sort()).toEqual(['setRect:body0:110,230,500,200', 'setRect:pic0:710,230,200,100'])
  })

  it('靠近别的形状的边时吸附，并给出参考线；按住 Alt 不吸附', () => {
    const { editor } = setup()
    editor.pointerDown({ x: 750, y: 250 })
    // pic0 左边 700，移到 603 附近 → 吸附到 body0 右边 600
    editor.pointerMove({ x: 750 - 97, y: 250 })
    expect(editor.preview.value?.get('pic0')?.x).toBe(600)
    expect(editor.guides.value).toContainEqual({ axis: 'x', position: 600 })
    editor.pointerMove({ x: 750 - 97, y: 250 }, { alt: true })
    expect(editor.preview.value?.get('pic0')?.x).toBe(603)
    editor.pointerUp()
    expect(editor.guides.value).toEqual([])
  })

  it('缩放：东南角拖动提交新矩形；锁宽高比的图片按比例', () => {
    const { editor, backend } = setup()
    editor.select(['body0'])
    editor.startResize('se', { x: 600, y: 400 })
    editor.pointerMove({ x: 650, y: 430 })
    editor.pointerUp()
    expect(callsOf(backend, 'setRect')).toEqual(['setRect:body0:100,200,550,230'])
    editor.select(['pic0'])
    editor.startResize('se', { x: 900, y: 300 })
    editor.pointerMove({ x: 960, y: 300 })
    expect(editor.preview.value?.get('pic0')?.width! / editor.preview.value?.get('pic0')?.height!).toBeCloseTo(2, 6)
    editor.pointerUp()
  })

  it('旋转的形状不能缩放（canResize=false）；多选不能缩放', () => {
    const { editor, backend } = setup({ shapes: [[{ id: 'r', kind: 'shape', rect: { x: 0, y: 0, width: 100, height: 100 }, rotation: 30, text: null, bold: false, fill: null, aspectLocked: false }, { id: 's', kind: 'shape', rect: { x: 200, y: 0, width: 100, height: 100 }, rotation: 0, text: null, bold: false, fill: null, aspectLocked: false }]] })
    editor.select(['r'])
    expect(editor.resizable.value).toBe(false)
    editor.startResize('se', { x: 100, y: 100 })
    editor.pointerMove({ x: 150, y: 150 })
    editor.pointerUp()
    expect(callsOf(backend, 'setRect')).toEqual([])
    editor.select(['r', 's'])
    expect(editor.resizable.value).toBe(false)
    expect(editor.box.value).toMatchObject({ x: 0, y: 0, width: 300, height: 100 })
  })

  it('取消手势：不提交、虚框与参考线清掉', () => {
    const { editor, backend } = setup()
    editor.pointerDown(BODY_BORDER)
    editor.pointerMove({ x: 200, y: 300 })
    editor.cancelGesture()
    editor.pointerUp()
    expect(editor.preview.value).toBeNull()
    expect(callsOf(backend, 'setRect')).toEqual([])
  })

  it('方向键微调 1px，Shift 10px；一次微调后形状列表是新的', () => {
    const { editor, backend } = setup()
    editor.select(['title0'])
    editor.shapeKeyDown({ key: 'ArrowRight', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false })
    editor.shapeKeyDown({ key: 'ArrowDown', shiftKey: true, ctrlKey: false, metaKey: false, altKey: false })
    expect(callsOf(backend, 'setRect')).toEqual(['setRect:title0:101,50,400,60', 'setRect:title0:101,60,400,60'])
  })
})

describe('文字输入', () => {
  const into = (text = 'hello world') => {
    const ctx = setup()
    ctx.editor.beginText('body0', 'story:body0', 5, 5)
    expect(ctx.backend.storyText('story:body0')).toBe(text)
    return ctx
  }

  it('键入字符：写进文本流，光标后移', () => {
    const { editor, backend } = into()
    expect(editor.beforeInput({ inputType: 'insertText', data: '!' })).toBe(true)
    expect(backend.storyText('story:body0')).toBe('hello! world')
    expect(editor.text.value).toMatchObject({ anchor: 6, focus: 6 })
    expect(editor.caret.value?.x).toBe(170)
  })

  it('有选区时键入 = 替换选区', () => {
    const { editor, backend } = into()
    editor.beginText('body0', 'story:body0', 0, 5)
    editor.beforeInput({ inputType: 'insertText', data: 'J' })
    expect(backend.storyText('story:body0')).toBe('J world')
    expect(editor.text.value).toMatchObject({ anchor: 1, focus: 1 })
  })

  it('Backspace / Delete：折叠时删前 / 后一个字，有选区时删选区；到头不报错', () => {
    const { editor, backend } = into()
    editor.beforeInput({ inputType: 'deleteContentBackward', data: null })
    expect(backend.storyText('story:body0')).toBe('hell world')
    editor.beforeInput({ inputType: 'deleteContentForward', data: null })
    expect(backend.storyText('story:body0')).toBe('hellworld')
    editor.beginText('body0', 'story:body0', 0, 0)
    editor.beforeInput({ inputType: 'deleteContentBackward', data: null })
    expect(backend.storyText('story:body0')).toBe('hellworld')
    editor.beginText('body0', 'story:body0', 1, 4)
    editor.beforeInput({ inputType: 'deleteContentBackward', data: null })
    expect(backend.storyText('story:body0')).toBe('hworld')
  })

  it('回车：先删选区再插换行；粘贴多行文本统一换行符', () => {
    const { editor, backend } = into()
    editor.beforeInput({ inputType: 'insertParagraph', data: null })
    expect(backend.storyText('story:body0')).toBe('hello\n world')
    expect(editor.text.value).toMatchObject({ focus: 6 })
    editor.beforeInput({ inputType: 'insertFromPaste', data: null, dataTransferText: 'a\r\nb' })
    expect(backend.storyText('story:body0')).toBe('hello\na\nb world')
  })

  it('每次键入后画布重绘所需的变化通知都发出（形状列表刷新）', () => {
    const { editor, backend } = into()
    const seen = vi.fn()
    backend.onChange(seen)
    editor.beforeInput({ inputType: 'insertText', data: 'x' })
    expect(seen).toHaveBeenCalledWith({ slides: [0], remote: false })
  })

  it('不在文字编辑态 / 只读：beforeinput 不接管', () => {
    const idle = setup()
    expect(idle.editor.beforeInput({ inputType: 'insertText', data: 'x' })).toBe(false)
    const ro = setup({ readonly: true })
    ro.editor.beginText('body0', 'story:body0', 0, 0)
    expect(ro.editor.text.value).toBeNull()
    expect(ro.editor.beforeInput({ inputType: 'insertText', data: 'x' })).toBe(false)
  })

  it('连续键入不插撤销切刀（让引擎按时间窗口合并成一步）', () => {
    const { editor, backend } = into()
    for (const ch of 'abc') editor.beforeInput({ inputType: 'insertText', data: ch })
    expect(backend.calls.filter((c) => c === 'boundary')).toEqual([])
  })
})

describe('输入法', () => {
  const start = () => {
    const ctx = setup()
    ctx.editor.beginText('body0', 'story:body0', 5, 5)
    return ctx
  }

  it('组字期间不改文档，只显示预编辑文字；结束时一次性上屏', () => {
    const { editor, backend } = start()
    editor.compositionStart()
    editor.compositionUpdate('ni')
    editor.compositionUpdate('你')
    expect(editor.preedit.value).toBe('你')
    expect(backend.storyText('story:body0')).toBe('hello world')
    expect(editor.beforeInput({ inputType: 'insertCompositionText', data: '你', isComposing: true })).toBe(false)
    // 有的浏览器组字期间也会发 insertText（带 isComposing）：同样不能写进文档，否则上屏时拼音会和汉字一起留下
    expect(editor.beforeInput({ inputType: 'insertText', data: 'n', isComposing: true })).toBe(false)
    expect(editor.beforeInput({ inputType: 'insertText', data: 'n' })).toBe(false)
    expect(backend.storyText('story:body0')).toBe('hello world')
    editor.compositionEnd('你好')
    expect(backend.storyText('story:body0')).toBe('hello你好 world')
    expect(editor.preedit.value).toBeNull()
    expect(editor.text.value).toMatchObject({ anchor: 7, focus: 7 })
    expect(callsOf(backend, 'insertText')).toHaveLength(1)
  })

  it('选区在组字时被替换；取消组字（空串）不改文档', () => {
    const { editor, backend } = start()
    editor.beginText('body0', 'story:body0', 0, 5)
    editor.compositionStart()
    editor.compositionUpdate('世界')
    editor.compositionEnd('世界')
    expect(backend.storyText('story:body0')).toBe('世界 world')
    editor.compositionStart()
    editor.compositionUpdate('abc')
    editor.compositionEnd('')
    expect(backend.storyText('story:body0')).toBe('世界 world')
  })

  it('浏览器在 compositionend 之后补发的同内容 insertText 被吞掉，不会重复上屏；下一次真实输入照常', () => {
    const { editor, backend } = start()
    editor.compositionStart()
    editor.compositionEnd('好')
    expect(editor.beforeInput({ inputType: 'insertText', data: '好' })).toBe(true)
    expect(backend.storyText('story:body0')).toBe('hello好 world')
    editor.beforeInput({ inputType: 'insertText', data: '好' })
    expect(backend.storyText('story:body0')).toBe('hello好好 world')
  })

  it('组字期间的按键（方向键 / 回车 / keyCode 229）全部归输入法，不移动光标', () => {
    const { editor } = start()
    editor.compositionStart()
    const key = (name: string, extra: object = {}) => editor.textKeyDown({ key: name, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...extra })
    expect(key('ArrowLeft')).toBe(false)
    expect(key('Enter', { keyCode: 229 })).toBe(false)
    expect(key('Escape')).toBe(false)
    expect(editor.text.value).toMatchObject({ focus: 5 })
    expect(editor.isComposing).toBe(true)
  })

  it('撤销时先结束组字，预编辑文字不会悬在变了的文档上', () => {
    const { editor, backend } = start()
    editor.beforeInput({ inputType: 'insertText', data: 'x' })
    editor.compositionStart()
    editor.compositionUpdate('拼')
    editor.undo()
    expect(editor.preedit.value).toBeNull()
    expect(editor.isComposing).toBe(false)
    expect(backend.storyText('story:body0')).toBe('hello world')
  })

  it('组字过程中没有 compositionstart 的结束事件被忽略', () => {
    const { editor, backend } = start()
    editor.compositionEnd('漏')
    expect(backend.storyText('story:body0')).toBe('hello world')
  })

  it('混合：英文键入、中文组字、再英文，文档内容和光标都对', () => {
    const { editor, backend } = start()
    editor.beforeInput({ inputType: 'insertText', data: 'A' })
    editor.compositionStart()
    editor.compositionUpdate('zhong')
    editor.compositionEnd('中')
    editor.beforeInput({ inputType: 'insertText', data: 'B' })
    expect(backend.storyText('story:body0')).toBe('helloA中B world')
    expect(editor.text.value).toMatchObject({ focus: 8 })
  })
})

describe('光标键', () => {
  const key = (editor: SlideEditor, name: string, extra: object = {}) =>
    editor.textKeyDown({ key: name, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...extra })

  it('左右移动；Shift 扩展选区；有选区时按左右键折叠到那一端', () => {
    const { editor } = setup()
    editor.beginText('body0', 'story:body0', 5, 5)
    expect(key(editor, 'ArrowRight')).toBe(true)
    expect(editor.text.value).toMatchObject({ anchor: 6, focus: 6 })
    key(editor, 'ArrowRight', { shiftKey: true })
    key(editor, 'ArrowRight', { shiftKey: true })
    expect(editor.text.value).toMatchObject({ anchor: 6, focus: 8 })
    expect(editor.selRects.value).toHaveLength(1)
    key(editor, 'ArrowLeft')
    expect(editor.text.value).toMatchObject({ anchor: 6, focus: 6 })
    expect(editor.selRects.value).toEqual([])
  })

  it('Home / End / Ctrl+Home / Ctrl+End / Ctrl+左右（按词）', () => {
    const { editor } = setup()
    editor.beginText('body0', 'story:body0', 5, 5)
    key(editor, 'Home')
    expect(editor.text.value?.focus).toBe(0)
    key(editor, 'End')
    expect(editor.text.value?.focus).toBe(11)
    key(editor, 'ArrowLeft', { ctrlKey: true })
    expect(editor.text.value?.focus).toBe(6)
    key(editor, 'Home', { ctrlKey: true })
    expect(editor.text.value?.focus).toBe(0)
  })

  it('Ctrl+A 全选文本；Esc 退出文字编辑但形状保持选中', () => {
    const { editor } = setup()
    editor.beginText('body0', 'story:body0', 3, 3)
    key(editor, 'a', { ctrlKey: true })
    expect(editor.text.value).toMatchObject({ anchor: 0, focus: 11 })
    key(editor, 'Escape')
    expect(editor.text.value).toBeNull()
    expect(editor.selected.value).toEqual(['body0'])
  })

  it('选形状后按 Enter 进入文字编辑，按 Delete 删除形状', () => {
    const { editor, backend } = setup()
    editor.select(['body0'])
    editor.shapeKeyDown({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false })
    expect(editor.text.value).toMatchObject({ shapeId: 'body0', focus: 11 })
    editor.endText()
    editor.select(['pic0'])
    editor.shapeKeyDown({ key: 'Delete', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false })
    expect(callsOf(backend, 'removeShape')).toEqual(['removeShape:pic0'])
    expect(editor.selected.value).toEqual([])
  })

  it('文字编辑态下形状键盘快捷键（Delete 删形状）不抢键', () => {
    const { editor, backend } = setup()
    editor.beginText('body0', 'story:body0', 3, 3)
    expect(editor.shapeKeyDown({ key: 'Delete', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false })).toBe(false)
    expect(callsOf(backend, 'removeShape')).toEqual([])
  })
})

describe('格式', () => {
  it('选区加粗：对选区调用 formatText；工具栏状态跟着变', () => {
    const { editor, backend } = setup()
    editor.beginText('body0', 'story:body0', 0, 5)
    editor.toggleStyle('bold')
    expect(callsOf(backend, 'formatText')).toEqual(['formatText:story:body0:0:5:{"bold":true}'])
    expect(editor.style.value.bold).toBe(true)
    editor.toggleStyle('bold')
    expect(callsOf(backend, 'formatText').at(-1)).toContain('"bold":false')
  })

  it('光标折叠时的格式是"下一次输入的样式"，输入后用掉；移动光标就作废', () => {
    const { editor, backend } = setup()
    editor.beginText('body0', 'story:body0', 5, 5)
    editor.toggleStyle('bold')
    expect(callsOf(backend, 'formatText')).toEqual([])
    expect(editor.style.value.bold).toBe(true)
    editor.beforeInput({ inputType: 'insertText', data: 'B' })
    expect(callsOf(backend, 'insertText').at(-1)).toContain('{"bold":true}')
    editor.beforeInput({ inputType: 'insertText', data: 'c' })
    expect(callsOf(backend, 'insertText').at(-1)).toContain(':null')
    editor.toggleStyle('italic')
    editor.textKeyDown({ key: 'ArrowRight', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false })
    editor.beforeInput({ inputType: 'insertText', data: 'd' })
    expect(callsOf(backend, 'insertText').at(-1)).toContain(':null')
  })

  it('只选中形状（没在编辑文字）：格式作用在整段文字上', () => {
    const { editor, backend } = setup()
    editor.select(['body0', 'title0'])
    editor.format({ bold: true })
    expect(callsOf(backend, 'formatText').sort()).toEqual(['formatText:story:body0:0:11:{"bold":true}', 'formatText:story:title0:0:4:{"bold":true}'])
  })

  it('字号步进：以当前字号为基准，夹在 6~200', () => {
    const { editor, backend } = setup()
    editor.select(['body0'])
    editor.stepFontSize(2)
    expect(callsOf(backend, 'formatText').at(-1)).toContain('"fontSizePt":20')
    editor.stepFontSize(-100)
    expect(callsOf(backend, 'formatText').at(-1)).toContain('"fontSizePt":6')
  })

  it('段落对齐、形状填充色', () => {
    const { editor, backend } = setup()
    editor.select(['body0'])
    editor.alignText('ctr')
    expect(callsOf(backend, 'alignText')).toEqual(['alignText:story:body0:0:11:ctr'])
    editor.setFill('#ff0000')
    expect(callsOf(backend, 'setFill')).toEqual(['setFill:body0:#ff0000'])
    editor.select(['pic0'])
    editor.setFill('#00ff00')
    expect(callsOf(backend, 'setFill')).toHaveLength(1)
  })

  it('每个格式动作前都切一刀：撤销只撤销这一次格式', () => {
    const { editor, backend } = setup()
    editor.beginText('body0', 'story:body0', 0, 5)
    editor.beforeInput({ inputType: 'insertText', data: 'x' })
    editor.beginText('body0', 'story:body0', 0, 3)
    editor.toggleStyle('bold')
    editor.undo()
    expect(backend.state.shapes[0]![1]!.bold).toBe(false)
    expect(backend.storyText('story:body0')).toBe('x world')
  })
})

describe('插入', () => {
  it('文本框：居中、选中并直接进入文字编辑', () => {
    const { editor, backend, focus } = setup()
    editor.insertTextBox()
    const added = editor.selected.value[0]!
    expect(added).toMatch(/^new/)
    expect(backend.state.shapes[0]!.find((s) => s.id === added)!.rect).toEqual({ x: 480, y: 330, width: 320, height: 60 })
    expect(editor.text.value).toMatchObject({ shapeId: added, focus: 0 })
    expect(focus).toHaveBeenCalled()
    editor.beforeInput({ inputType: 'insertText', data: 'Hi' })
    expect(backend.storyText(`story:${added}`)).toBe('Hi')
  })

  it('形状：居中、选中', () => {
    const { editor, backend } = setup()
    editor.insertShape('ellipse')
    expect(editor.selected.value).toHaveLength(1)
    expect(backend.state.shapes[0]!.at(-1)!.rect).toEqual({ x: 540, y: 300, width: 200, height: 120 })
  })

  it('图片：超过页面 60% 时等比缩小，居中', () => {
    const { editor, backend } = setup()
    const id = editor.insertPicture({ bytes: new Uint8Array([1]), contentType: 'image/png', name: 'big.png', width: 3000, height: 1500 })!
    const rect = backend.state.shapes[0]!.find((s) => s.id === id)!.rect
    expect(rect.width).toBe(768)
    expect(rect.height).toBe(384)
    expect(rect.x + rect.width / 2).toBe(640)
    const small = editor.insertPicture({ bytes: new Uint8Array([1]), contentType: 'image/png', name: 's.png', width: 100, height: 50 })!
    expect(backend.state.shapes[0]!.find((s) => s.id === small)!.rect).toMatchObject({ width: 100, height: 50 })
  })

  it('替换图片：只对单选的图片生效', () => {
    const { editor, backend } = setup()
    const image = { bytes: new Uint8Array([1]), contentType: 'image/png', name: 'n.png' }
    editor.select(['body0'])
    expect(editor.replacePicture(image)).toBe(false)
    editor.select(['pic0'])
    expect(editor.replacePicture(image)).toBe(true)
    expect(callsOf(backend, 'replacePicture')).toEqual(['replacePicture:pic0:n.png'])
    expect(editor.selected.value).toHaveLength(1)
    expect(editor.selected.value[0]).not.toBe('pic0')
  })

  it('一个插入动作 = 一个撤销步：插入文本框再撤销，文本框消失', () => {
    const { editor, backend } = setup()
    editor.insertTextBox()
    expect(backend.state.shapes[0]).toHaveLength(4)
    editor.undo()
    expect(backend.state.shapes[0]).toHaveLength(3)
    expect(editor.selected.value).toEqual([])
    expect(editor.text.value).toBeNull()
  })
})

describe('层级、对齐、分布', () => {
  it('置顶：多选时保持彼此的相对顺序', () => {
    const { editor, backend } = setup()
    editor.select(['title0', 'body0'])
    editor.zOrder('front')
    expect(backend.state.shapes[0]!.map((s) => s.id)).toEqual(['pic0', 'title0', 'body0'])
    editor.select(['title0', 'body0'])
    editor.zOrder('back')
    expect(backend.state.shapes[0]!.map((s) => s.id)).toEqual(['title0', 'body0', 'pic0'])
  })

  it('上移一层 / 下移一层', () => {
    const { editor, backend } = setup()
    editor.select(['title0'])
    editor.zOrder('forward')
    expect(backend.state.shapes[0]!.map((s) => s.id)).toEqual(['body0', 'title0', 'pic0'])
    editor.zOrder('backward')
    expect(backend.state.shapes[0]!.map((s) => s.id)).toEqual(['title0', 'body0', 'pic0'])
  })

  it('对齐：多选对齐到包围盒（一批 setRect，同一个撤销步）；单选对齐整页', () => {
    const { editor, backend } = setup()
    editor.select(['title0', 'body0', 'pic0'])
    editor.align('left')
    // body0 / title0 本来就在包围盒左边，只有图片会动
    expect(callsOf(backend, 'setRect')).toEqual(['setRect:pic0:100,200,200,100'])
    editor.undo()
    expect(backend.state.shapes[0]![2]!.rect.x).toBe(700)
    editor.select(['pic0'])
    editor.align('hcenter')
    expect(callsOf(backend, 'setRect').at(-1)).toBe('setRect:pic0:540,200,200,100')
  })

  it('分布：少于 3 个提示，不动文档', () => {
    const { editor, backend, notes } = setup()
    editor.select(['title0', 'body0'])
    editor.distribute('horizontal')
    expect(callsOf(backend, 'setRect')).toEqual([])
    expect(notes.at(-1)).toContain('3 个')
    editor.select(['title0', 'body0', 'pic0'])
    editor.distribute('vertical')
    expect(callsOf(backend, 'setRect').length).toBeGreaterThan(0)
  })

  it('删除后选择与文字态一起清掉', () => {
    const { editor } = setup()
    editor.beginText('body0', 'story:body0', 1, 1)
    editor.removeSelected()
    expect(editor.selected.value).toEqual([])
    expect(editor.text.value).toBeNull()
    expect(editor.shapes.value.map((s) => s.id)).toEqual(['title0', 'pic0'])
  })
})

describe('页操作', () => {
  it('新建 / 复制：切到新页；删除：切到前一页；至少留一页', () => {
    const { editor, backend, goto, notes } = setup({ count: 3 }, { index: 1 })
    editor.insertSlide()
    expect(goto).toHaveBeenLastCalledWith(2)
    expect(backend.state.shapes).toHaveLength(4)
    editor.duplicateSlide()
    expect(callsOf(backend, 'duplicateSlide')).toEqual(['duplicateSlide:2'])
    editor.deleteSlide()
    // 复制后已经切到第 3 页（0 起 2 → 3），删它回到前一页
    expect(goto).toHaveBeenLastCalledWith(2)
    const single = setup({ count: 1 })
    single.editor.deleteSlide()
    expect(single.backend.state.shapes).toHaveLength(1)
    expect(single.notes.at(-1)).toContain('至少')
    void notes
  })

  it('上移 / 下移页，越界忽略', () => {
    const { editor, backend, goto } = setup({ count: 3 }, { index: 0 })
    editor.moveSlide(-1)
    expect(callsOf(backend, 'moveSlide')).toEqual([])
    editor.moveSlide(1)
    expect(callsOf(backend, 'moveSlide')).toEqual(['moveSlide:0:1'])
    expect(goto).toHaveBeenLastCalledWith(1)
  })
})

describe('撤销 / 重做与状态', () => {
  it('按钮状态来自后端；撤销重做走后端', () => {
    const { editor, backend } = setup()
    expect(editor.history.value).toEqual({ undo: false, redo: false })
    editor.select(['pic0'])
    editor.removeSelected()
    expect(editor.history.value.undo).toBe(true)
    expect(editor.undo()).toBe(true)
    expect(backend.state.shapes[0]).toHaveLength(3)
    expect(editor.history.value).toEqual({ undo: false, redo: true })
    expect(editor.redo()).toBe(true)
    expect(backend.state.shapes[0]).toHaveLength(2)
    expect(editor.undo()).toBe(true)
    expect(editor.undo()).toBe(false)
  })

  it('远端修改：形状列表刷新；选中的形状被别人删掉后选择自动去掉', () => {
    const { editor, backend } = setup()
    editor.select(['pic0'])
    backend.state.shapes[0]!.pop()
    backend.injectRemote()
    expect(editor.shapes.value).toHaveLength(2)
    expect(editor.selected.value).toEqual([])
  })

  it('正在编辑的文本框被别人删掉：退出文字编辑并说明原因；自己删掉的不弹这条', () => {
    const { editor, backend, notes } = setup()
    editor.beginText('body0', 'story:body0', 2, 2)
    backend.state.shapes[0]!.splice(1, 1)
    backend.injectRemote()
    expect(editor.text.value).toBeNull()
    expect(notes).toEqual(['这个文本框已被其他人删除，输入已结束'])
    const mine = setup()
    mine.editor.select(['body0'])
    mine.editor.removeSelected()
    expect(mine.notes.filter((note) => note.includes('其他人'))).toEqual([])
  })

  it('别人把文字改短了：光标夹到新的长度内', () => {
    const { editor, backend } = setup()
    editor.beginText('body0', 'story:body0', 11, 11)
    backend.state.shapes[0]![1]!.text = 'hi'
    backend.injectRemote()
    expect(editor.text.value).toMatchObject({ anchor: 2, focus: 2 })
  })

  it('协同：别人在我前面插入文字，我的光标跟着后移，下一个字仍落在我原来的位置', () => {
    const { editor, backend } = setup()
    editor.beginText('body0', 'story:body0', 11, 11)
    backend.state.shapes[0]![1]!.text = 'AAAAA' + backend.state.shapes[0]![1]!.text
    backend.injectRemote()
    expect(editor.text.value).toMatchObject({ anchor: 16, focus: 16 })
    editor.beforeInput({ inputType: 'insertText', data: 'B' })
    expect(backend.state.shapes[0]![1]!.text.endsWith('B')).toBe(true)
  })

  it('协同：改动在光标后面不挪光标；选区两端各自平移；自己的编辑不算远端平移', () => {
    const { editor, backend } = setup()
    editor.beginText('body0', 'story:body0', 2, 6)
    backend.state.shapes[0]![1]!.text += '!!!'
    backend.injectRemote()
    expect(editor.text.value).toMatchObject({ anchor: 2, focus: 6 })
    backend.state.shapes[0]![1]!.text = 'ZZ' + backend.state.shapes[0]![1]!.text
    backend.injectRemote()
    expect(editor.text.value).toMatchObject({ anchor: 4, focus: 8 })
    // 本地敲字：光标只前进一格，不会被当成远端改动再平移一次
    editor.beginText('body0', 'story:body0', 3, 3)
    editor.beforeInput({ inputType: 'insertText', data: 'Q' })
    expect(editor.text.value).toMatchObject({ anchor: 4, focus: 4 })
  })

  it('切页后（refresh）形状列表换成新页的', () => {
    const { editor, setIndex } = setup({ count: 2 })
    expect(editor.shapes.value[0]!.id).toBe('title0')
    setIndex(1)
    editor.refresh()
    expect(editor.shapes.value[0]!.id).toBe('title1')
  })
})

describe('只读与错误', () => {
  it('只读：所有写入口都是空操作，指针也不触发选择手势', () => {
    const { editor, backend } = setup({ readonly: true })
    expect(editor.pointerDown(INSIDE_BODY)).toBe('none')
    editor.select(['title0'])
    editor.removeSelected()
    editor.insertTextBox()
    editor.insertShape('rect')
    editor.format({ bold: true })
    editor.align('left')
    editor.nudge(5, 5)
    editor.insertSlide()
    expect(editor.undo()).toBe(false)
    expect(backend.calls).toEqual([])
  })

  it('后端拒绝（抛错）：不向外抛，记成提示，状态保持', () => {
    const { editor, backend, notes } = setup()
    backend.setReadonly(false)
    const original = backend.removeShape
    backend.removeShape = () => {
      throw new Error('形状已被删除')
    }
    editor.select(['pic0'])
    expect(() => editor.removeSelected()).not.toThrow()
    expect(notes.at(-1)).toContain('形状已被删除')
    expect(editor.notice.value).toContain('删除没有成功')
    backend.removeShape = original
  })

  it('引擎不支持的能力给出明确说明', () => {
    const { editor, notes } = setup()
    editor.unsupported('表格')
    expect(notes.at(-1)).toContain('表格')
    expect(notes.at(-1)).toContain('PowerPoint')
  })

  it('dispose 之后不再响应后端变化', () => {
    const { editor, backend } = setup()
    const before = editor.shapes.value
    editor.dispose()
    backend.removeShape(0, 'pic0')
    expect(editor.shapes.value).toBe(before)
  })
})
