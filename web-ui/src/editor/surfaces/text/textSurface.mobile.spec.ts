/**
 * 笔记文本面 × 手机与输入法
 *
 * - 斜杠菜单：手机（宽 <600 或触屏）变贴键盘的底部面板，高度报给 Host（光标要滚到它上面）；
 * - 光标滚动余量：贴键盘的工具栏 / 面板盖住底部一截，view.reserve 把余量写进 ProseMirror 的 scrollMargin；
 * - 输入法组字：回车 / 方向键 / Esc 归输入法，不能被斜杠菜单当成命令（旧编辑器的硬规矩）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TextSurface } from './TextSurface'
import { TEXT_SLASH_ACTIONS } from '../../extensions/builtin/text'
import { cleanupText, makeBridge, mountText } from './textTestKit'
import { TextSelection } from 'prosemirror-state'
import type { DocumentSession, SurfaceContext } from '../../types'

afterEach(() => {
  cleanupText()
  vi.unstubAllGlobals()
})

function media(coarse: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: coarse && query === '(pointer: coarse)',
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
}

/** 带斜杠菜单与 onSheetHeight 观测的挂载 */
async function mountSlash(width: number, coarse: boolean) {
  vi.stubGlobal('innerWidth', width)
  media(coarse)
  const heights: number[] = []
  const el = document.createElement('div')
  document.body.append(el)
  const ctx: SurfaceContext = {
    session: { setSnapshotProvider: () => undefined } as unknown as DocumentSession,
    document: { kind: 'text', format: 'md', revision: 1, payload: { kind: 'text', text: '', name: 'a.md' } },
    permissions: { read: true, write: true, comment: false, ai: false, export: true },
    readonly: false,
    textHost: makeBridge(),
    onSheetHeight: (height) => heights.push(height),
  }
  const surface = new TextSurface({ slashActions: TEXT_SLASH_ACTIONS })
  await surface.mount(el, ctx)
  const view = (surface as unknown as { view: import('prosemirror-view').EditorView }).view
  // jsdom 没有排版：给底部面板一个高度，才能验证「报给 Host 的是多高」
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { height: this.classList.contains('kb-slash-menu') ? 180 : 0, width: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }
  })
  return { surface, view, el, heights }
}

function typeSlash(view: import('prosemirror-view').EditorView, text = '/') {
  view.dispatch(view.state.tr.insertText(text))
}

describe('斜杠菜单：手机底部面板', () => {
  it('1. 手机宽度：菜单是底部面板（is-sheet），不写 left/top，高度报给 Host', async () => {
    const { view, el, heights } = await mountSlash(390, false)
    typeSlash(view)
    const menu = el.querySelector<HTMLElement>('.kb-slash-menu')!
    expect(menu.classList.contains('is-sheet')).toBe(true)
    expect(menu.style.left).toBe('')
    expect(menu.style.top).toBe('')
    expect(heights.at(-1)).toBe(180)
  })

  it('2. 触屏平板（宽 ≥600 但主要输入是手指）同样是底部面板', async () => {
    const { view, el } = await mountSlash(820, true)
    typeSlash(view)
    expect(el.querySelector('.kb-slash-menu')?.classList.contains('is-sheet')).toBe(true)
  })

  it('3. 桌面（宽屏 + 鼠标）：跟着光标的浮层', async () => {
    const { view, el } = await mountSlash(1440, false)
    typeSlash(view)
    const menu = el.querySelector<HTMLElement>('.kb-slash-menu')!
    expect(menu.classList.contains('is-sheet')).toBe(false)
    expect(menu.style.left).not.toBe('')
  })

  it('4. 菜单收起（删掉 /）后高度归零', async () => {
    const { view, el, heights } = await mountSlash(390, false)
    typeSlash(view)
    expect(heights.at(-1)).toBe(180)
    view.dispatch(view.state.tr.delete(1, view.state.selection.from))
    expect(el.querySelector('.kb-slash-menu')).toBeNull()
    expect(heights.at(-1)).toBe(0)
  })
})

describe('斜杠菜单：分组、图标与最近使用', () => {
  it('9. 空查询分组显示（组名给读屏），图标是线性 SVG / 标题画「H1」，右侧写 Markdown 快捷输入；输入查询词后不分组', async () => {
    localStorage.removeItem('kb.slash.recent')
    const { view, el } = await mountSlash(1440, false)
    typeSlash(view, '/')
    const menu = el.querySelector<HTMLElement>('.kb-slash-menu')!
    const groups = [...menu.querySelectorAll<HTMLElement>('.kb-slash-group')]
    expect(groups.map((group) => group.querySelector('.kb-slash-group-label')?.textContent)).toEqual(['基础', '列表', '插入', '引用与附件', '图表与公式', '提示块', '更多标题'])
    for (const group of groups) {
      expect(group.getAttribute('role')).toBe('group')
      expect(document.getElementById(group.getAttribute('aria-labelledby')!)).not.toBeNull()
    }
    const option = (id: string) => menu.querySelector<HTMLElement>(`[data-slash-id="${id}"]`)!
    expect(option('table').querySelector('.kb-slash-icon svg.kb-tool-icon')).not.toBeNull()
    expect(option('heading.2').querySelector('.kb-slash-icon')!.textContent).toBe('H2')
    expect(option('bullet').querySelector('.kb-slash-hint')!.textContent).toBe('-')
    // 第一项是「正文」并且是当前项；所有选项按出现顺序编号，方向键连续走
    expect(menu.querySelector('.kb-slash-item.is-active')?.getAttribute('data-slash-id')).toBe('paragraph')
    typeSlash(view, 'bg')
    expect(menu.querySelector('.kb-slash-group')).toBeNull()
    expect(menu.querySelector('.kb-slash-item')?.getAttribute('data-slash-id')).toBe('table')
  })

  it('10. 用过的项下次排在最上面的「最近使用」里（记在本机），回车直接选中它', async () => {
    localStorage.removeItem('kb.slash.recent')
    const { view, el, surface } = await mountSlash(1440, false)
    typeSlash(view, '/表格')
    await surface.command({ id: 's', type: 'slash.run', args: { id: 'table' }, source: 'user' })
    expect(JSON.parse(localStorage.getItem('kb.slash.recent') ?? '[]')).toEqual(['table'])
    // 跳出表格，另起一段再打 /
    view.dispatch(view.state.tr.insert(view.state.doc.content.size, view.state.schema.nodes.paragraph.create()))
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)))
    typeSlash(view, '/')
    const menu = el.querySelector<HTMLElement>('.kb-slash-menu')!
    const first = menu.querySelector<HTMLElement>('.kb-slash-group')!
    expect(first.querySelector('.kb-slash-group-label')!.textContent).toBe('最近使用')
    expect(menu.querySelector('.kb-slash-item.is-active')?.getAttribute('data-slash-id')).toBe('table')
    localStorage.removeItem('kb.slash.recent')
  })
})

describe('输入法组字：斜杠菜单不吞键', () => {
  it('5. 组字中的回车不执行菜单项（正文里的 /h 与拼音都还在，菜单仍开着）', async () => {
    const { view, el } = await mountSlash(1440, false)
    typeSlash(view, '/h')
    expect(el.querySelector('.kb-slash-menu')).not.toBeNull()
    // 真实输入法：先 compositionstart，ProseMirror 进入组字态后不再把按键交给 handleKeyDown / 键位表
    view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    const enter = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229, bubbles: true, cancelable: true })
    view.dom.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(false)
    expect(view.state.doc.textContent).toBe('/h')
    expect(el.querySelector('.kb-slash-menu')).not.toBeNull()
  })

  it('6. 直接调 handleKeyDown：isComposing / keyCode 229 的方向键、回车、Esc 都放行', async () => {
    const { view, surface } = await mountSlash(1440, false)
    typeSlash(view, '/')
    const handle = (surface as unknown as { handleKeyDown: (v: unknown, e: KeyboardEvent) => boolean }).handleKeyDown.bind(surface)
    for (const key of ['Enter', 'ArrowDown', 'ArrowUp', 'Escape']) {
      expect(handle(view, new KeyboardEvent('keydown', { key, isComposing: true })), key).toBe(false)
    }
    // 没在组字时回车照常执行菜单项
    expect(handle(view, new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }))).toBe(true)
  })
})

describe('光标滚动余量', () => {
  it('7. view.reserve 把贴键盘的工具栏 / 面板高度加进 ProseMirror 的 scrollMargin', async () => {
    const { surface } = await mountText('正文')
    const margin = (surface as unknown as { scrollMargin: { bottom: number }; scrollThreshold: { bottom: number } })
    await surface.command({ id: 'r', type: 'view.reserve', args: { reserve: 56 }, source: 'api' })
    // 余量 = 高度 + 8px 空隙；阈值同值（离边多近就开始滚）
    expect(margin.scrollMargin.bottom).toBe(64)
    expect(margin.scrollThreshold.bottom).toBe(64)
    await surface.command({ id: 'r', type: 'view.reserve', args: { reserve: 0 }, source: 'api' })
    expect(margin.scrollMargin.bottom).toBe(5)
    expect(margin.scrollThreshold.bottom).toBe(0)
  })

  it('8. 面板变高（reveal）时把光标滚到它上面', async () => {
    const { surface, view } = await mountText('正文')
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)))
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
    const scrollIntoView = vi.fn()
    // scrollRectIntoView 找最近的可滚动祖先；jsdom 里没有，直接验证没抛错并确实排了一帧
    await surface.command({ id: 'r', type: 'view.reserve', args: { reserve: 120, reveal: true }, source: 'api' })
    expect(frames).toHaveLength(1)
    expect(() => frames[0]!(0)).not.toThrow()
    void scrollIntoView
  })
})

describe('组字时不重新过滤斜杠菜单 / 菜单不超出视口（真实浏览器场景暴露的缺口）', () => {
  it('组字中预编辑文字变化：菜单项不变；组字结束（上屏）后按最终文本过滤', async () => {
    const { view, el } = await mountSlash(1440, false)
    typeSlash(view, '/')
    const before = [...el.querySelectorAll('.kb-slash-item')].map((item) => item.textContent)
    expect(before.length).toBeGreaterThan(10)
    // 模拟浏览器进入组字：PM 的 view.composing 为真时，事务里文档变了菜单也不动
    ;(view as unknown as { input: { composing: boolean } }).input.composing = true
    view.dispatch(view.state.tr.insertText('标题'))
    expect([...el.querySelectorAll('.kb-slash-item')].map((item) => item.textContent)).toEqual(before)
    ;(view as unknown as { input: { composing: boolean } }).input.composing = false
    view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '标题' }))
    await vi.waitFor(() => expect([...el.querySelectorAll('.kb-slash-item')].every((item) => item.textContent?.includes('标题'))).toBe(true))
  })

  it('光标在窗口下半部分：菜单翻到光标上方，夹进视口', async () => {
    const { view, el } = await mountSlash(1440, false)
    vi.stubGlobal('innerHeight', 800)
    vi.spyOn(view, 'coordsAtPos').mockReturnValue({ left: 100, right: 101, top: 700, bottom: 720 })
    typeSlash(view)
    const menu = el.querySelector<HTMLElement>('.kb-slash-menu')!
    // 菜单高 180（见 mountSlash 的 getBoundingClientRect 桩）：下方放不下 → 700 − 6 − 180 = 514
    expect(menu.style.top).toBe('514px')
  })

  it('光标在屏幕外：夹进视口而不是落在屏幕外', async () => {
    const { view, el } = await mountSlash(1440, false)
    vi.stubGlobal('innerHeight', 800)
    vi.spyOn(view, 'coordsAtPos').mockReturnValue({ left: 100, right: 101, top: 1500, bottom: 1520 })
    typeSlash(view)
    const top = Number.parseFloat(el.querySelector<HTMLElement>('.kb-slash-menu')!.style.top)
    expect(top).toBeGreaterThanOrEqual(8)
    expect(top + 180).toBeLessThanOrEqual(792)
  })

  it('reveal 滚的是真正溢出的那一层，不是只有 overflow:auto 样式却从不溢出的外壳', async () => {
    const { surface, view } = await mountText('正文')
    const outer = document.createElement('div')
    const stage = document.createElement('div')
    outer.style.overflowY = 'auto'
    stage.style.overflowY = 'auto'
    view.dom.parentElement!.replaceWith(outer)
    outer.append(stage)
    stage.append(view.dom)
    // 外层真的溢出，舞台层 overflow:auto 但不溢出
    Object.defineProperty(outer, 'scrollHeight', { value: 2000, configurable: true })
    Object.defineProperty(outer, 'clientHeight', { value: 600, configurable: true })
    Object.defineProperty(stage, 'scrollHeight', { value: 600, configurable: true })
    Object.defineProperty(stage, 'clientHeight', { value: 600, configurable: true })
    const scrolled: string[] = []
    outer.scrollBy = (() => scrolled.push('outer')) as never
    stage.scrollBy = (() => scrolled.push('stage')) as never
    outer.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) })
    vi.spyOn(view, 'coordsAtPos').mockReturnValue({ left: 10, right: 11, top: 560, bottom: 580 })
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => cb(0))
    document.documentElement.style.setProperty('--kbd-reserve', '200px')
    await surface.command({ id: 'r', type: 'view.reserve', args: { reserve: 200, reveal: true }, source: 'api' })
    document.documentElement.style.removeProperty('--kbd-reserve')
    expect(scrolled).toEqual(['outer'])
  })
})
