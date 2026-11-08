/**
 * 笔记页面面板单测：「引用笔记」「引用文件 / 模板」选择器、图片 / 附件选择、上传回插
 *
 * 面板只负责「选」；选中的结果必须通过命令交回内容面（才进撤销栈、才走只读守卫），所以这里全部断言
 * 「执行了哪条命令、参数是什么」。输入法组字时回车 / 方向键不能被选择器吞掉，是旧编辑器的硬规矩，单独覆盖。
 */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TextPanels from './TextPanels.vue'
import type { CommandResult, TextServices } from '../types'

vi.mock('@/api/upload', () => ({
  uploadFile: vi.fn(async (_file: File, opts: { relPath: string }) => ({ files: [{ rel_path: opts.relPath }], skipped: [] })),
}))

let wrapper: VueWrapper | null = null

function services(overrides: Partial<TextServices> = {}): TextServices {
  return {
    collection: () => 'docs',
    sourcePath: () => 'guide/a.md',
    adminView: () => '',
    linkContext: () => null,
    linkStates: () => ({}),
    fileCollections: () => [{ name: 'docs' }, { name: 'other' }],
    openLink: () => undefined,
    openAttachment: () => undefined,
    linkError: () => undefined,
    searchNotes: async (query) => [
      { id: 'n1', title: `第一篇 ${query}`, kind: '经验' },
      { id: 'n2', title: '第二篇' },
    ],
    searchFiles: async (_query, collection) => [
      { collection, path: 'img/a.png', name: 'a.png', size: 10 },
      { collection, path: 'docs/说明.pdf', name: '说明.pdf', size: 2048 },
      { collection, path: 'tpl/周报.dotx', name: '周报.dotx', template: true },
    ],
    ...overrides,
  }
}

function mountPanels(options: { services?: TextServices; readonly?: boolean; caretTop?: number } = {}) {
  const caretTop = options.caretTop ?? 180
  const calls: { type: string; args?: unknown }[] = []
  const execute = vi.fn(async (type: string, args?: unknown): Promise<CommandResult> => {
    calls.push({ type, args })
    return { ok: true }
  })
  const caret = vi.fn(async () => ({ pos: 5, left: 100, top: caretTop, bottom: caretTop + 20 }))
  wrapper = mount(TextPanels, {
    props: { services: options.services ?? services(), readonly: options.readonly ?? false, execute, caret },
    attachTo: document.body,
    // 拖放遮罩的开关在 Pinia 的 upload store 里
    global: { plugins: [createPinia()] },
  })
  const api = wrapper.vm as unknown as {
    open: (panel: string, options?: { from?: number }) => void
    uploadFiles: (files: File[], pos?: number) => Promise<void>
  }
  return { api, calls, execute, caret }
}

const body = () => document.body
/** 等搜索防抖（160ms）走完并渲染 */
async function settle() {
  await flushPromises()
  await new Promise((resolve) => setTimeout(resolve, 200))
  await flushPromises()
}
const press = (el: Element, init: KeyboardEventInit) => el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
const mousedown = (el: Element) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))

beforeEach(() => {
  document.body.innerHTML = ''
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('引用笔记选择器', () => {
  it('1. 从工具栏打开：先写下 [[，再弹出贴着光标的选择器并搜索', async () => {
    const { api, calls } = mountPanels()
    api.open('wikilink')
    await settle()
    expect(calls[0]).toEqual({ type: 'text.insert', args: { text: '[[' } })
    expect(body().querySelector('[data-testid="note-picker"]')).not.toBeNull()
    expect(body().querySelectorAll('[data-testid="note-picker-item"]')).toHaveLength(2)
  })

  it('2. 输入 [[ 触发的：不再重复写 [[，from 用内容面给的起点', async () => {
    const { api, calls } = mountPanels()
    api.open('wikilink', { from: 3 })
    await settle()
    expect(calls.find((c) => c.type === 'text.insert')).toBeUndefined()
    mousedown(body().querySelector('[data-testid="note-picker-item"]')!)
    await flushPromises()
    expect(calls.at(-1)).toEqual({ type: 'text.wikilink.insert', args: { from: 3, id: 'n1', title: '第一篇 ' } })
    expect(body().querySelector('[data-testid="note-picker"]')).toBeNull()
  })

  it('3. 键盘：↓ 换项、回车确认', async () => {
    const { api, calls } = mountPanels()
    api.open('wikilink', { from: 3 })
    await settle()
    const input = body().querySelector('.kb-text-picker-input')!
    press(input, { key: 'ArrowDown' })
    press(input, { key: 'Enter' })
    await flushPromises()
    expect(calls.at(-1)).toMatchObject({ type: 'text.wikilink.insert', args: { id: 'n2' } })
  })

  it('4. 输入法组字时回车 / 方向键不被选择器吞掉（不选中、不 preventDefault）', async () => {
    const { api, calls } = mountPanels()
    api.open('wikilink', { from: 3 })
    await settle()
    const input = body().querySelector('.kb-text-picker-input')!
    const enter = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })
    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', isComposing: true, bubbles: true, cancelable: true })
    input.dispatchEvent(down)
    input.dispatchEvent(enter)
    await flushPromises()
    expect(enter.defaultPrevented).toBe(false)
    expect(down.defaultPrevented).toBe(false)
    expect(calls.find((c) => c.type === 'text.wikilink.insert')).toBeUndefined()
    expect(body().querySelector('[data-testid="note-picker"]')).not.toBeNull()
  })

  it('5. Esc 关闭并把焦点还给正文', async () => {
    const { api, calls } = mountPanels()
    api.open('wikilink', { from: 3 })
    await settle()
    press(body().querySelector('.kb-text-picker-input')!, { key: 'Escape' })
    await flushPromises()
    expect(body().querySelector('[data-testid="note-picker"]')).toBeNull()
    expect(calls.at(-1)?.type).toBe('view.focus')
  })

  it('6. 只读时不弹', async () => {
    const { api, calls } = mountPanels({ readonly: true })
    api.open('wikilink')
    await settle()
    expect(calls).toHaveLength(0)
    expect(body().querySelector('[data-testid="note-picker"]')).toBeNull()
  })
})

describe('选择器贴着窗口下沿时翻到光标上方（旧编辑器的缺陷：被挤出视口，够不着）', () => {
  /** 给选择器一个高度（jsdom 不排版），窗口高 800 */
  function withHeight(height: number) {
    vi.stubGlobal('innerHeight', 800)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { height: this.classList.contains('kb-text-picker') ? height : 0, width: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }
    })
  }
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('光标在上半屏：放在光标下方', async () => {
    withHeight(200)
    const { api } = mountPanels({ caretTop: 100 })
    api.open('wikilink', { from: 3 })
    await settle()
    expect(body().querySelector<HTMLElement>('[data-testid="note-picker"]')!.style.top).toBe('126px')
  })

  it('光标在下半屏、下方放不下：翻到光标上方（光标顶 − 6 − 面板高）', async () => {
    withHeight(200)
    const { api } = mountPanels({ caretTop: 700 })
    api.open('wikilink', { from: 3 })
    await settle()
    expect(body().querySelector<HTMLElement>('[data-testid="note-picker"]')!.style.top).toBe('494px')
  })

  it('光标本身在屏幕外（滚走了再点工具栏）：面板夹进视口，够得着', async () => {
    withHeight(200)
    const { api } = mountPanels({ caretTop: 1300 })
    api.open('wikilink', { from: 3 })
    await settle()
    const top = Number.parseFloat(body().querySelector<HTMLElement>('[data-testid="note-picker"]')!.style.top)
    expect(top).toBeGreaterThanOrEqual(8)
    expect(top + 200).toBeLessThanOrEqual(792)
  })

  it('上下都放不下：贴着窗口下沿，至少看得到输入框', async () => {
    withHeight(600)
    const { api } = mountPanels({ caretTop: 300 })
    api.open('filelink')
    await settle()
    const top = Number.parseFloat(body().querySelector<HTMLElement>('[data-testid="file-picker"]')!.style.top)
    expect(top).toBeGreaterThanOrEqual(8)
    expect(top + 600).toBeLessThanOrEqual(792)
  })
})

describe('输入法与手机面板', () => {
  it('组字中的 Esc 不冒泡到页面的全局快捷键（否则拼音一取消，整个编辑页被关掉）', async () => {
    const { api } = mountPanels()
    api.open('wikilink', { from: 3 })
    await settle()
    const input = body().querySelector('.kb-text-picker-input')!
    const seen: string[] = []
    const onWindow = (event: KeyboardEvent) => seen.push(event.key)
    window.addEventListener('keydown', onWindow, true)
    try {
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      press(input, { key: 'Escape' })
      expect(seen).toEqual([])
      // 组字结束后（过了守卫窗口）Esc 恢复为关闭选择器
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 80))
      press(input, { key: 'Escape' })
      expect(seen).toEqual(['Escape'])
    } finally {
      window.removeEventListener('keydown', onWindow, true)
    }
  })

  it('手机宽度：选择器是贴键盘的底部面板（is-sheet），高度报给 Host', async () => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({ matches: query === '(pointer: coarse)', media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as never
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { height: this.classList.contains('kb-text-picker') ? 150 : 0, width: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }
    })
    try {
      const { api } = mountPanels()
      api.open('wikilink', { from: 3 })
      await settle()
      const picker = body().querySelector<HTMLElement>('[data-testid="note-picker"]')!
      expect(picker.classList.contains('is-sheet')).toBe(true)
      expect(picker.style.left).toBe('')
      expect(wrapper!.emitted('sheet-height')?.at(-1)).toEqual([150])
      press(body().querySelector('.kb-text-picker-input')!, { key: 'Escape' })
      await flushPromises()
      expect(wrapper!.emitted('sheet-height')?.at(-1)).toEqual([0])
    } finally {
      window.matchMedia = original
      vi.restoreAllMocks()
    }
  })

  it('桌面：选择器是贴着光标的浮层，不上报高度', async () => {
    const { api } = mountPanels()
    api.open('wikilink', { from: 3 })
    await settle()
    const picker = body().querySelector<HTMLElement>('[data-testid="note-picker"]')!
    expect(picker.classList.contains('is-sheet')).toBe(false)
    expect(picker.style.left).not.toBe('')
    expect(wrapper!.emitted('sheet-height')?.every((args) => args[0] === 0) ?? true).toBe(true)
  })
})

describe('引用文件 / 模板选择器', () => {
  it('7. 单击一项：只插这一条（相对路径，有大小所以是附件卡片）', async () => {
    const { api, calls } = mountPanels()
    api.open('filelink')
    await settle()
    const items = body().querySelectorAll('[data-testid="file-picker-item"]')
    expect(items).toHaveLength(3)
    mousedown(items[1]!)
    await flushPromises()
    expect(calls.at(-1)?.type).toBe('text.markdown.insert')
    const markdown = (calls.at(-1)?.args as { markdown: string }).markdown
    expect(markdown).toMatch(/^\[📎 说明\.pdf\]\(\.\.\/docs\/.+ "2(\.0)? KB"\)$/)
  })

  it('8. 图片按图片语法；模板带 download=1', async () => {
    const { api, calls } = mountPanels()
    api.open('filelink')
    await settle()
    mousedown(body().querySelectorAll('[data-testid="file-picker-item"]')[0]!)
    await flushPromises()
    expect((calls.at(-1)?.args as { markdown: string }).markdown).toBe('![a](../img/a.png)')

    api.open('filelink')
    await settle()
    mousedown(body().querySelectorAll('[data-testid="file-picker-item"]')[2]!)
    await flushPromises()
    expect((calls.at(-1)?.args as { markdown: string }).markdown).toContain('download=1')
  })

  it('9. 勾选多项后一次插入，之间空一行', async () => {
    const { api, calls } = mountPanels()
    api.open('filelink')
    await settle()
    const checks = body().querySelectorAll<HTMLInputElement>('.kb-text-picker-check')
    checks[0]!.click()
    checks[1]!.click()
    await flushPromises()
    expect(body().querySelector('.kb-text-picker-foot')?.textContent).toContain('已选 2 个')
    body().querySelector<HTMLButtonElement>('[data-testid="file-picker-insert"]')!.click()
    await flushPromises()
    const markdown = (calls.at(-1)?.args as { markdown: string }).markdown
    expect(markdown.split('\n\n')).toHaveLength(2)
  })

  it('9b. 真实鼠标：按下勾选框不会触发整行的“单击即插入并关闭”（旧编辑器的多选因此一直用不了）', async () => {
    const { api, calls } = mountPanels()
    api.open('filelink')
    await settle()
    const check = body().querySelector<HTMLInputElement>('.kb-text-picker-check')!
    // 浏览器点一下是 mousedown → mouseup → click，三个事件都要走
    check.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    check.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
    check.click()
    await flushPromises()
    expect(body().querySelector('[data-testid="file-picker"]')).not.toBeNull()
    expect(calls.find((c) => c.type === 'text.markdown.insert')).toBeUndefined()
    expect(body().querySelector('.kb-text-picker-foot')?.textContent).toContain('已选 1 个')
  })

  it('10. 页面没有提供搜索能力：提示，不弹面板', async () => {
    const { api } = mountPanels({ services: services({ searchFiles: undefined }) })
    api.open('filelink')
    await settle()
    expect(body().querySelector('[data-testid="file-picker"]')).toBeNull()
    expect(body().querySelector('[data-testid="text-notice"]')?.textContent).toContain('不能浏览文件')
  })

  it('11. 有多个集合时出现集合切换', async () => {
    const { api } = mountPanels()
    api.open('filelink')
    await settle()
    expect(body().querySelectorAll('.kb-text-picker-select option')).toHaveLength(2)
  })
})

describe('图片 / 附件选择与上传回插', () => {
  it('12. 桌面点「图片」直接唤起系统选择器（不问来源）', () => {
    const { api } = mountPanels()
    const input = wrapper!.find<HTMLInputElement>('[data-testid="pick-image"]').element
    const click = vi.spyOn(input, 'click').mockImplementation(() => undefined)
    api.open('image')
    expect(click).toHaveBeenCalled()
    expect(wrapper!.find('[data-testid="pick-camera"]').exists()).toBe(false)
  })

  it('13. 点「附件」唤起不限类型的文件选择', () => {
    const { api } = mountPanels()
    const input = wrapper!.find<HTMLInputElement>('[data-testid="pick-attach"]').element
    const click = vi.spyOn(input, 'click').mockImplementation(() => undefined)
    api.open('attachment')
    expect(click).toHaveBeenCalled()
    expect(input.getAttribute('accept')).toBeNull()
  })

  it('14. 没有目标集合：点图片提示原因，不唤起选择器', async () => {
    const { api } = mountPanels({ services: services({ collection: () => null }) })
    const input = wrapper!.find<HTMLInputElement>('[data-testid="pick-image"]').element
    const click = vi.spyOn(input, 'click').mockImplementation(() => undefined)
    api.open('image')
    await flushPromises()
    expect(click).not.toHaveBeenCalled()
    expect(body().querySelector('[data-testid="text-notice"]')?.textContent).toContain('没有目标集合')
  })

  it('15. 上传完成后把 Markdown 作为块插回 pos，并提示数量', async () => {
    const { api, calls } = mountPanels()
    await api.uploadFiles([new File(['x'], 'a.png', { type: 'image/png' }), new File(['x'], 'b.pdf', { type: 'application/pdf' })], 7)
    await flushPromises()
    const args = calls.find((c) => c.type === 'text.markdown.insert')!.args as { markdown: string; pos: number }
    expect(args.pos).toBe(7)
    expect(args.markdown.split('\n\n')).toHaveLength(2)
    expect(args.markdown).toContain('![a](')
    expect(args.markdown).toContain('[📎 b.pdf](')
    expect(body().querySelector('[data-testid="text-notice"]')?.textContent).toBe('已上传 2 个文件,附件也会被解析进检索')
  })

  it('16. 全部失败时什么都不插', async () => {
    const { uploadFile } = await import('@/api/upload')
    vi.mocked(uploadFile).mockRejectedValueOnce(new Error('断网'))
    const { api, calls } = mountPanels()
    await api.uploadFiles([new File(['x'], 'a.png', { type: 'image/png' })])
    await flushPromises()
    expect(calls.find((c) => c.type === 'text.markdown.insert')).toBeUndefined()
  })

  it('17. 手机触屏上点「图片」先问拍照还是相册', async () => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: query.includes('pointer: coarse'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as never
    try {
      const { api } = mountPanels()
      api.open('image')
      await flushPromises()
      expect(body().textContent).toContain('拍照')
      expect(body().textContent).toContain('从相册选')
      expect(wrapper!.find('[data-testid="pick-camera"]').exists()).toBe(true)
    } finally {
      window.matchMedia = original
    }
  })
})
