// 软键盘 / 可视视口:占用高度的算法、什么时候算「键盘打开」、事件接线。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { KEYBOARD_MIN_PX, computeKeyboardInset, isTextEntry, keyboardState, useVisualViewport } from './useVisualViewport'

// 整个文件共用一个宿主组件(eslint 的 vue/one-component-per-file):只负责调一次 useVisualViewport
const Host = defineComponent({
  setup() {
    useVisualViewport()
    return () => h('div')
  },
})

describe('computeKeyboardInset', () => {
  it('iOS:布局视口没变、可视视口缩小 → 差值就是键盘高度', () => {
    expect(computeKeyboardInset({ layoutHeight: 844, viewportHeight: 508, viewportTop: 0 })).toBe(336)
  })
  it('iOS 把页面往上推了一截(offsetTop>0)时,键盘占用要把偏移扣掉', () => {
    expect(computeKeyboardInset({ layoutHeight: 844, viewportHeight: 508, viewportTop: 100 })).toBe(236)
  })
  it('Android 默认 resizes-content:布局视口也跟着缩,占用为 0(不重复计算)', () => {
    expect(computeKeyboardInset({ layoutHeight: 508, viewportHeight: 508, viewportTop: 0 })).toBe(0)
  })
  it('不会出负数(缩放、橡皮筋回弹时可视视口可能比布局视口大)', () => {
    expect(computeKeyboardInset({ layoutHeight: 700, viewportHeight: 720, viewportTop: 0 })).toBe(0)
  })
})

describe('isTextEntry', () => {
  it('文本输入 / textarea / contenteditable 会弹键盘;复选框、按钮、范围条不会', () => {
    const make = (html: string) => {
      const box = document.createElement('div')
      box.innerHTML = html
      return box.firstElementChild
    }
    expect(isTextEntry(make('<input type="text">'))).toBe(true)
    expect(isTextEntry(make('<input type="email">'))).toBe(true)
    expect(isTextEntry(make('<input>'))).toBe(true)
    expect(isTextEntry(make('<textarea></textarea>'))).toBe(true)
    expect(isTextEntry(make('<input type="checkbox">'))).toBe(false)
    expect(isTextEntry(make('<input type="radio">'))).toBe(false)
    expect(isTextEntry(make('<input type="range">'))).toBe(false)
    expect(isTextEntry(make('<button></button>'))).toBe(false)
    expect(isTextEntry(null)).toBe(false)
  })
})

describe('useVisualViewport', () => {
  let vv: EventTarget & { height: number; offsetTop: number }
  const root = document.documentElement

  beforeEach(() => {
    vv = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 })
    vi.stubGlobal('visualViewport', vv)
    vi.stubGlobal('innerHeight', 844)
    Object.defineProperty(root, 'clientHeight', { value: 844, configurable: true })
    document.body.innerHTML = '<input id="field" type="text"><button id="btn">b</button>'
  })
  afterEach(() => vi.unstubAllGlobals())

  const mountIt = () => mount(Host)
  const kbd = () => ({ inset: root.style.getPropertyValue('--kbd-inset'), state: root.dataset.kbd })

  it('挂载时就写好:键盘没开 = 0px / closed', () => {
    const wrapper = mountIt()
    expect(kbd()).toEqual({ inset: '0px', state: 'closed' })
    wrapper.unmount()
  })

  it('输入框聚焦 + 可视视口缩小到键盘高度 → 写入占用高度、标记 open', () => {
    const wrapper = mountIt()
    ;(document.getElementById('field') as HTMLInputElement).focus()
    vv.height = 508
    vv.dispatchEvent(new Event('resize'))
    expect(kbd()).toEqual({ inset: '336px', state: 'open' })
    wrapper.unmount()
  })

  it('视口缩小但焦点在按钮上(例如地址栏伸缩)不算键盘打开', () => {
    const wrapper = mountIt()
    ;(document.getElementById('btn') as HTMLButtonElement).focus()
    vv.height = 508
    vv.dispatchEvent(new Event('resize'))
    expect(kbd().state).toBe('closed')
    wrapper.unmount()
  })

  it('缩小幅度不到 120px(地址栏)不算键盘', () => {
    const wrapper = mountIt()
    ;(document.getElementById('field') as HTMLInputElement).focus()
    vv.height = 844 - (KEYBOARD_MIN_PX - 20)
    vv.dispatchEvent(new Event('resize'))
    expect(kbd().state).toBe('closed')
    wrapper.unmount()
  })

  it('键盘收起(视口恢复)→ closed', () => {
    const wrapper = mountIt()
    ;(document.getElementById('field') as HTMLInputElement).focus()
    vv.height = 508
    vv.dispatchEvent(new Event('resize'))
    vv.height = 844
    vv.dispatchEvent(new Event('resize'))
    expect(kbd()).toEqual({ inset: '0px', state: 'closed' })
    wrapper.unmount()
  })

  it('键盘打开且输入框聚焦时,把它滚到可见位置', () => {
    vi.useFakeTimers()
    const field = document.getElementById('field') as HTMLInputElement
    const scroll = vi.fn()
    field.scrollIntoView = scroll
    const wrapper = mountIt()
    field.focus()
    vv.height = 508
    vv.dispatchEvent(new Event('resize'))
    vi.advanceTimersByTime(100)
    expect(scroll).toHaveBeenCalledWith({ block: 'center', inline: 'nearest' })
    wrapper.unmount()
    vi.useRealTimers()
  })

  it('卸载后清理监听和变量,之后的 resize 不再写入', () => {
    const wrapper = mountIt()
    wrapper.unmount()
    ;(document.getElementById('field') as HTMLInputElement).focus()
    vv.height = 508
    vv.dispatchEvent(new Event('resize'))
    expect(root.style.getPropertyValue('--kbd-inset')).toBe('')
  })

  it('没有 visualViewport(老浏览器)时安静地什么都不做', () => {
    vi.stubGlobal('visualViewport', undefined)
    const wrapper = mountIt()
    expect(kbd()).toEqual({ inset: '0px', state: 'closed' })
    wrapper.unmount()
  })
})

describe('keyboardState(响应式)与多处使用', () => {
  let vv: EventTarget & { height: number; offsetTop: number }
  const root = document.documentElement

  beforeEach(() => {
    vv = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 })
    vi.stubGlobal('visualViewport', vv)
    vi.stubGlobal('innerHeight', 844)
    Object.defineProperty(root, 'clientHeight', { value: 844, configurable: true })
    document.body.innerHTML = '<input id="field" type="text">'
  })
  afterEach(() => vi.unstubAllGlobals())

  it('键盘打开 / 收起时 keyboardState 跟着变(编辑器据此决定工具栏贴不贴键盘)', () => {
    const wrapper = mount(Host)
    expect(keyboardState).toEqual({ open: false, inset: 0 })
    ;(document.getElementById('field') as HTMLInputElement).focus()
    vv.height = 508
    vv.dispatchEvent(new Event('resize'))
    expect(keyboardState).toEqual({ open: true, inset: 336 })
    vv.height = 844
    vv.dispatchEvent(new Event('resize'))
    expect(keyboardState).toEqual({ open: false, inset: 0 })
    wrapper.unmount()
  })

  it('外壳和编辑器各用一次:监听只装一份,先卸载一个不影响另一个,都卸载才拆', () => {
    const add = vi.spyOn(vv, 'addEventListener')
    const remove = vi.spyOn(vv, 'removeEventListener')
    const shell = mount(Host)
    const editor = mount(Host)
    expect(add.mock.calls.filter(([name]) => name === 'resize')).toHaveLength(1)
    shell.unmount()
    // 外壳走了,编辑器还在:变量照常更新
    ;(document.getElementById('field') as HTMLInputElement).focus()
    vv.height = 508
    vv.dispatchEvent(new Event('resize'))
    expect(root.style.getPropertyValue('--kbd-inset')).toBe('336px')
    expect(keyboardState.open).toBe(true)
    expect(remove).not.toHaveBeenCalled()
    editor.unmount()
    expect(remove.mock.calls.filter(([name]) => name === 'resize')).toHaveLength(1)
    expect(root.style.getPropertyValue('--kbd-inset')).toBe('')
    expect(keyboardState).toEqual({ open: false, inset: 0 })
  })
})

describe('富文本编辑区聚焦:滚光标所在行,不滚整个编辑区', () => {
  let vv: EventTarget & { height: number; offsetTop: number }
  const root = document.documentElement
  let scrollBy: ReturnType<typeof vi.fn>
  let editor: HTMLElement

  /** 光标行 [top, bottom](视口坐标)、滚动容器 [0, 1000](布局视口很高,可见范围由 visualViewport 决定) */
  function setup(caret: { top: number; bottom: number }, reserve: string) {
    vi.useFakeTimers()
    vv = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 })
    vi.stubGlobal('visualViewport', vv)
    vi.stubGlobal('innerHeight', 844)
    Object.defineProperty(root, 'clientHeight', { value: 844, configurable: true })
    root.style.setProperty('--kbd-reserve', reserve)
    document.body.innerHTML = '<div id="scroller" style="overflow-y:auto"><div id="editor" contenteditable="true"><p id="line">x</p></div></div>'
    const scroller = document.getElementById('scroller') as HTMLElement
    scrollBy = vi.fn()
    scroller.scrollBy = scrollBy as unknown as typeof scroller.scrollBy
    scroller.getBoundingClientRect = () => ({ top: 0, bottom: 844, left: 0, right: 390, width: 390, height: 844, x: 0, y: 0, toJSON: () => ({}) })
    editor = document.getElementById('editor') as HTMLElement
    // jsdom 没实现 contenteditable 的 isContentEditable,也没有 Range 的矩形
    Object.defineProperty(editor, 'isContentEditable', { value: true })
    const range = { getBoundingClientRect: () => ({ top: caret.top, bottom: caret.bottom, height: caret.bottom - caret.top }), startContainer: editor.firstChild }
    vi.spyOn(window, 'getSelection').mockReturnValue({ rangeCount: 1, getRangeAt: () => range } as unknown as Selection)
    editor.scrollIntoView = vi.fn()
    const wrapper = mount(Host)
    editor.focus()
    vv.height = 508
    vv.dispatchEvent(new Event('resize'))
    vi.advanceTimersByTime(100)
    return wrapper
  }
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    root.style.removeProperty('--kbd-reserve')
  })

  it('光标在键盘后面:滚容器把光标行带进可见区,而不是 scrollIntoView 整个编辑区', () => {
    const wrapper = setup({ top: 560, bottom: 584 }, '0px')
    expect(editor.scrollIntoView).not.toHaveBeenCalled()
    expect(scrollBy).toHaveBeenCalledTimes(1)
    const [{ top }] = scrollBy.mock.calls[0] as [{ top: number }]
    expect(top).toBeGreaterThan(0)
    wrapper.unmount()
  })

  it('光标已经在可见区里:不滚', () => {
    const wrapper = setup({ top: 200, bottom: 224 }, '0px')
    expect(scrollBy).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('贴键盘的工具栏(--kbd-reserve)盖住的那一截也算不可见:光标在它后面要滚', () => {
    // 可视高度 508,光标行 470–494:没有工具栏时看得见,工具栏 56 高就被盖住了
    const without = setup({ top: 470, bottom: 494 }, '0px')
    expect(scrollBy).not.toHaveBeenCalled()
    without.unmount()
    const withBar = setup({ top: 470, bottom: 494 }, '56px')
    expect(scrollBy).toHaveBeenCalledTimes(1)
    withBar.unmount()
  })
})

describe('普通输入框:居中之后仍被键盘盖住就补滚', () => {
  const root = document.documentElement
  let vv: EventTarget & { height: number; offsetTop: number }
  let scrollBy: ReturnType<typeof vi.fn>
  let field: HTMLInputElement
  let mounted: ReturnType<typeof mount> | null = null
  // 直接给 window.scrollBy 赋值会泄漏到后面的用例,用完要还原
  const originalScrollBy = window.scrollBy

  /** 键盘升起后,scrollIntoView 把输入框放到 rect(模拟浏览器按**布局视口**居中的结果),再看会不会补滚 */
  function raise(layoutHeight: number, visibleHeight: number, rect: { top: number; bottom: number }) {
    vi.useFakeTimers()
    vv = Object.assign(new EventTarget(), { height: layoutHeight, offsetTop: 0 })
    vi.stubGlobal('visualViewport', vv)
    vi.stubGlobal('innerHeight', layoutHeight)
    Object.defineProperty(root, 'clientHeight', { value: layoutHeight, configurable: true })
    root.style.removeProperty('--kbd-reserve')
    document.body.innerHTML = '<input id="field" type="text">'
    field = document.getElementById('field') as HTMLInputElement
    field.scrollIntoView = vi.fn()
    field.getBoundingClientRect = () => ({ ...rect, left: 0, right: 300, width: 300, height: rect.bottom - rect.top, x: 0, y: rect.top, toJSON: () => ({}) })
    scrollBy = vi.fn()
    window.scrollBy = scrollBy as unknown as typeof window.scrollBy
    mounted = mount(Host)
    field.focus()
    vv.height = visibleHeight
    vv.dispatchEvent(new Event('resize'))
    vi.advanceTimersByTime(100)
  }
  afterEach(() => {
    // 断言失败时用例末尾的代码不会执行:监听要在这里卸载,否则全局只装一份的监听残留,后面的用例装不上
    mounted?.unmount()
    mounted = null
    window.scrollBy = originalScrollBy
    document.body.innerHTML = ''
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('手机横屏:布局视口 390、键盘占一半(可视 195),居中后输入框下缘 217 仍在键盘后面 → 补滚把它带进可见区', () => {
    raise(390, 195, { top: 173, bottom: 217 })
    expect(field.scrollIntoView).toHaveBeenCalledWith({ block: 'center', inline: 'nearest' })
    expect(scrollBy).toHaveBeenCalledTimes(1)
    const [{ top }] = scrollBy.mock.calls[0] as [{ top: number }]
    expect(top).toBeGreaterThan(0)
  })

  it('竖屏:居中之后输入框已经在键盘上方 → 不补滚(不无谓地抖动页面)', () => {
    raise(844, 506, { top: 400, bottom: 444 })
    expect(field.scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollBy).not.toHaveBeenCalled()
  })
})
