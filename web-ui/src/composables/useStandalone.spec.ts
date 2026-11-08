// 独立窗口检测、外部链接判断与接管。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { canGoBack, detectStandalone, interceptExternalLinks, isExternalLink, useStandalone } from './useStandalone'

function stubDisplayMode(active: string | null) {
  const listeners = new Set<() => void>()
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: active !== null && query === `(display-mode: ${active})`,
    media: query,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  }))
  return {
    switchTo(mode: string | null) {
      active = mode
      listeners.forEach((listener) => listener())
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-display-mode')
})

describe('detectStandalone', () => {
  it('浏览器窗口:不是', () => {
    stubDisplayMode(null)
    expect(detectStandalone()).toBe(false)
  })
  it('display-mode 为 standalone / minimal-ui / fullscreen / window-controls-overlay:是', () => {
    for (const mode of ['standalone', 'minimal-ui', 'fullscreen', 'window-controls-overlay']) {
      stubDisplayMode(mode)
      expect(detectStandalone(), mode).toBe(true)
    }
  })
  it('iOS 主屏幕 App:靠 navigator.standalone(display-mode 不一定命中)', () => {
    stubDisplayMode(null)
    vi.stubGlobal('navigator', { standalone: true })
    expect(detectStandalone()).toBe(true)
    vi.stubGlobal('navigator', { standalone: false })
    expect(detectStandalone()).toBe(false)
  })
  it('没有 matchMedia 的环境不报错', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(detectStandalone()).toBe(false)
  })
})

describe('isExternalLink', () => {
  const origin = 'https://kb.test'
  it('不同源的 http(s) 才是外链', () => {
    expect(isExternalLink('https://example.org/a', origin)).toBe(true)
    expect(isExternalLink('http://kb.test:81/a', origin)).toBe(true) // 端口不同也是不同源
    expect(isExternalLink('//cdn.example.com/x.js', origin)).toBe(true)
  })
  it('同源、相对路径、锚点、mailto / tel / 垃圾输入都不是', () => {
    expect(isExternalLink('/search?q=1', origin)).toBe(false)
    expect(isExternalLink('https://kb.test/mine', origin)).toBe(false)
    expect(isExternalLink('#section', origin)).toBe(false)
    expect(isExternalLink('mailto:a@b.c', origin)).toBe(false)
    expect(isExternalLink('tel:123', origin)).toBe(false)
    expect(isExternalLink('javascript:void(0)', origin)).toBe(false)
    expect(isExternalLink('', origin)).toBe(false)
  })
})

describe('canGoBack', () => {
  it('读 vue-router 写在 history.state.back 里的上一个位置', () => {
    window.history.replaceState({ back: null }, '')
    expect(canGoBack()).toBe(false)
    window.history.replaceState({ back: '/home' }, '')
    expect(canGoBack()).toBe(true)
    window.history.replaceState(null, '')
    expect(canGoBack()).toBe(false)
  })
})

describe('useStandalone', () => {
  const mountIt = () => {
    let api!: ReturnType<typeof useStandalone>
    const wrapper = mount(
      defineComponent({
        setup() {
          api = useStandalone()
          return () => h('div')
        },
      }),
    )
    return { api, wrapper }
  }

  it('把状态写到 <html data-display-mode>,并随显示模式变化更新', () => {
    const media = stubDisplayMode(null)
    const { api, wrapper } = mountIt()
    expect(api.standalone.value).toBe(false)
    expect(document.documentElement.dataset.displayMode).toBe('browser')
    media.switchTo('standalone')
    expect(api.standalone.value).toBe(true)
    expect(document.documentElement.dataset.displayMode).toBe('standalone')
    wrapper.unmount()
  })
  it('卸载后不再监听', () => {
    const media = stubDisplayMode(null)
    const { api, wrapper } = mountIt()
    wrapper.unmount()
    media.switchTo('standalone')
    expect(api.standalone.value).toBe(false)
  })
})

describe('interceptExternalLinks', () => {
  let stop: () => void
  let opened: ReturnType<typeof vi.fn>
  const onOpen = vi.fn()

  beforeEach(() => {
    onOpen.mockReset()
    opened = vi.fn()
    vi.stubGlobal('open', opened)
    document.body.innerHTML = `
      <a id="ext" href="https://example.org/docs">外</a>
      <a id="blank" href="https://example.org/x" target="_blank">新开</a>
      <a id="inner" href="/mine">内</a>
      <a id="hash" href="#top">锚</a>
      <a id="mail" href="mailto:a@b.c">邮</a>
      <span id="plain">字</span>`
    stop = interceptExternalLinks(onOpen)
  })
  afterEach(() => stop())

  // 接管逻辑挂在 document 上;在更靠后的 window 冒泡阶段读它有没有 preventDefault,然后自己拦下(否则 jsdom 会去「导航」并报未实现)
  const click = (id: string, init: MouseEventInit = {}) => {
    const result = { defaultPrevented: false }
    const record = (event: Event) => {
      result.defaultPrevented = event.defaultPrevented
      event.preventDefault()
    }
    window.addEventListener('click', record, { once: true })
    document.getElementById(id)!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }))
    window.removeEventListener('click', record)
    return result
  }

  it('外链:拦下默认跳转,以 noopener 新开,并通知调用方', () => {
    const event = click('ext')
    expect(event.defaultPrevented).toBe(true)
    expect(opened).toHaveBeenCalledWith('https://example.org/docs', '_blank', 'noopener,noreferrer')
    expect(onOpen).toHaveBeenCalledWith('https://example.org/docs')
  })
  it('本来就 target=_blank 的外链:不拦(浏览器自己新开),只通知', () => {
    const event = click('blank')
    expect(event.defaultPrevented).toBe(false)
    expect(opened).not.toHaveBeenCalled()
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
  it('站内链接、锚点、mailto、非链接元素:一律不管', () => {
    for (const id of ['inner', 'hash', 'mail', 'plain']) {
      expect(click(id).defaultPrevented, id).toBe(false)
    }
    expect(opened).not.toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()
  })
  it('带修饰键(⌘/Ctrl/Shift 点击)和非左键:保持浏览器默认行为', () => {
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }]) {
      expect(click('ext', init).defaultPrevented).toBe(false)
    }
    expect(opened).not.toHaveBeenCalled()
  })
  it('卸载后不再拦截', () => {
    stop()
    expect(click('ext').defaultPrevented).toBe(false)
  })
})
