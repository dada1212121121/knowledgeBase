/**
 * 笔记编辑器 × 手机：工具栏贴键盘、底部面板、光标滚动余量
 *
 * 场景与旧编辑器的 DocEditor.spec.ts「工具栏贴键盘(手机)」一一对应，换成新外壳（EditorHost + EditorChrome + TextSurface）：
 * 同样的设备、同样的断言——手机键盘打开才贴、平板桌面不贴、只读不占位、卸载不留变量。
 * 键盘通过 visualViewport 缩小 + 输入框聚焦模拟（和 iOS 一致）。
 */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EditorHost from './EditorHost.vue'
import { TextSurface } from '../surfaces/text/TextSurface'
import type { EditorOpenRequest, Surface, TextServices } from '../types'

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await flushPromises()
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('waitFor 超时')
}

const root = document.documentElement
let vv: EventTarget & { height: number; offsetTop: number }
const surfaces: Surface[] = []
let wrapper: VueWrapper | null = null
const realOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')

const services: TextServices = {
  collection: () => 'docs',
  sourcePath: () => 'a.md',
  adminView: () => '',
  linkContext: () => null,
  linkStates: () => ({}),
  fileCollections: () => [],
  searchNotes: async () => [{ id: 'n1', title: '第一篇' }],
  openLink: () => undefined,
  openAttachment: () => undefined,
  linkError: () => undefined,
}

function request(readonly = false): EditorOpenRequest {
  return {
    fileId: 'note_m',
    collection: 'docs',
    format: 'md',
    source: { kind: 'text', text: '正文', name: 'a.md' },
    readonly,
    revision: 1,
    permissions: { read: true, write: !readonly, comment: false, ai: false, export: true },
  }
}

async function mountHost(readonly = false) {
  const host = mount(EditorHost, {
    props: {
      request: request(readonly),
      transport: { save: async () => ({ ok: true, revision: 2, sha256: 'x' }) },
      loadSurface: () => {
        const surface = new TextSurface()
        surfaces.push(surface)
        return Promise.resolve(surface)
      },
      textServices: services,
      chromeTitle: false,
    },
    attachTo: document.body,
    global: { plugins: [createPinia()] },
  })
  wrapper = host
  await waitFor(() => host.find('.kb-text-prose').exists())
  await flushPromises()
  return host
}

/** 造一个设备:视口宽高、屏幕宽高;键盘通过 openKeyboard 弹出(可视视口缩小 + 有输入框聚焦,和 iOS 一致) */
function device(width: number, height: number, screen = { width, height }) {
  vv = Object.assign(new EventTarget(), { height, offsetTop: 0 })
  vi.stubGlobal('visualViewport', vv)
  vi.stubGlobal('innerWidth', width)
  vi.stubGlobal('innerHeight', height)
  vi.stubGlobal('screen', screen)
  Object.defineProperty(root, 'clientHeight', { value: height, configurable: true })
  const field = document.createElement('input')
  document.body.appendChild(field)
  return {
    field,
    async openKeyboard(keyboard: number) {
      field.focus()
      vv.height = height - keyboard
      vv.dispatchEvent(new Event('resize'))
      await flushPromises()
    },
    async closeKeyboard() {
      field.blur()
      vv.height = height
      vv.dispatchEvent(new Event('resize'))
      await flushPromises()
    },
  }
}

beforeEach(() => {
  // jsdom 不排版,offsetHeight 恒为 0;工具栏量出 56 才能验证「留多高」
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return (this as HTMLElement).classList.contains('kb-editor-chrome-tools') ? 56 : 0
    },
  })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  for (const surface of surfaces) surface.unmount()
  surfaces.length = 0
  if (realOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', realOffsetHeight)
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  root.style.removeProperty('--kbd-bar')
  root.style.removeProperty('--kbd-reserve')
})

// jsdom 没有 scrollIntoView（键盘打开时聚焦输入框会调它）
Element.prototype.scrollIntoView = () => undefined
window.scrollBy = () => undefined

const reserve = () => root.style.getPropertyValue('--kbd-reserve')
const bar = () => root.style.getPropertyValue('--kbd-bar')

describe('工具栏贴键盘（手机）', () => {
  it('1. 手机竖屏键盘打开：工具栏贴键盘，原位留同样高的占位，--kbd-reserve = 工具栏高度', async () => {
    const phone = device(390, 844)
    const host = await mountHost()
    expect(host.find('.kb-editor-chrome').classes()).not.toContain('is-docked')
    expect(host.find('.kb-editor-chrome-spacer').exists()).toBe(false)
    expect(reserve()).toBe('0px')
    await phone.openKeyboard(338)
    await waitFor(() => host.find('.kb-editor-chrome').classes().includes('is-docked'))
    expect((host.find('.kb-editor-chrome-spacer').element as HTMLElement).style.height).toBe('56px')
    await waitFor(() => reserve() === '56px')
    expect(bar()).toBe('56px')
  })

  it('2. 键盘收起：放开，占位消失，--kbd-reserve 归零', async () => {
    const phone = device(390, 844)
    const host = await mountHost()
    await phone.openKeyboard(338)
    await waitFor(() => host.find('.kb-editor-chrome').classes().includes('is-docked'))
    await phone.closeKeyboard()
    await waitFor(() => !host.find('.kb-editor-chrome').classes().includes('is-docked'))
    expect(host.find('.kb-editor-chrome-spacer').exists()).toBe(false)
    await waitFor(() => reserve() === '0px')
  })

  it('3. 手机横屏（844×390，键盘占一半）：同样贴键盘', async () => {
    const phone = device(844, 390)
    const host = await mountHost()
    await phone.openKeyboard(195)
    await waitFor(() => host.find('.kb-editor-chrome').classes().includes('is-docked'))
  })

  it('4. 平板和桌面保持现状：键盘打开也不贴', async () => {
    for (const [width, height] of [
      [820, 1180],
      [1180, 820],
      [1440, 900],
    ] as const) {
      const dev = device(width, height)
      const host = await mountHost()
      await dev.openKeyboard(Math.round(height * 0.4))
      expect(host.find('.kb-editor-chrome').classes(), `${width}×${height}`).not.toContain('is-docked')
      expect(reserve()).toBe('0px')
      wrapper!.unmount()
      wrapper = null
      document.body.innerHTML = ''
    }
  })

  it('5. 安卓平板横屏：软键盘把布局视口压到 500 以下也不当手机（看屏幕短边）', async () => {
    const tablet = device(1180, 420, { width: 1180, height: 820 })
    const host = await mountHost()
    await tablet.openKeyboard(150)
    expect(host.find('.kb-editor-chrome').classes()).not.toContain('is-docked')
  })

  it('6. 只读：没有写入工具栏，也不贴、不占位、不留高度', async () => {
    const phone = device(390, 844)
    const host = await mountHost(true)
    await phone.openKeyboard(338)
    expect(host.find('.kb-editor-chrome').classes()).not.toContain('is-docked')
    expect(host.find('.kb-editor-chrome-spacer').exists()).toBe(false)
    expect(reserve()).toBe('0px')
  })

  it('7. 卸载后不留 --kbd-reserve / --kbd-bar', async () => {
    const phone = device(390, 844)
    await mountHost()
    await phone.openKeyboard(338)
    await waitFor(() => reserve() === '56px')
    wrapper!.unmount()
    wrapper = null
    expect(reserve()).toBe('')
    expect(bar()).toBe('')
  })

  it('8. 贴键盘时下拉菜单往上展开（样式类 is-docked 在 Chrome 根上，菜单继承）', async () => {
    const phone = device(390, 844)
    const host = await mountHost()
    await phone.openKeyboard(338)
    await waitFor(() => host.find('.kb-editor-chrome').classes().includes('is-docked'))
    await host.find('[data-action="insertMore"]').trigger('click')
    expect(host.find('.kb-editor-chrome.is-docked [data-testid="editor-dropdown-insertMore"]').exists()).toBe(true)
  })

  it('9. 选择器面板打开：--kbd-reserve = 工具栏高度 + 面板高度；关掉回到只有工具栏', async () => {
    const phone = device(390, 844)
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(pointer: coarse)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }))
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { height: this.classList.contains('kb-text-picker') ? 150 : 0, width: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }
    })
    const host = await mountHost()
    await phone.openKeyboard(338)
    await waitFor(() => reserve() === '56px')
    await host.find('[data-action="insertMore"]').trigger('click')
    await host.find('[data-action="wikilink"]').trigger('click')
    await waitFor(() => reserve() === '206px')
    expect(bar()).toBe('56px')
    document.querySelector('.kb-text-picker-input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    // 真机上关掉选择器后焦点回到正文、键盘不收；jsdom 里 contenteditable 拿不到焦点，用同一个输入框代替
    phone.field.focus()
    await waitFor(() => reserve() === '56px')
    vi.restoreAllMocks()
  })
})
