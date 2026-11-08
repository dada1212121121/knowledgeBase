/** 打印窗口单测：被拦截、状态文字、图片按序排入并等解码、窗口被关、失败清理。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openPrintWindow, type PrintHost, type PrintWindowLike } from './printWindow'

const imageProto = HTMLImageElement.prototype as unknown as { decode?: () => Promise<void> }
const originalDecode = imageProto.decode
afterEach(() => {
  if (originalDecode) imageProto.decode = originalDecode
  else delete imageProto.decode
})

/** 用 jsdom 的 document 造一个假窗口；jsdom 没有 img.decode，按需注入 */
function fakeWindow(options: { decode?: (src: string) => Promise<void> } = {}) {
  const doc = document.implementation.createHTMLDocument('')
  const events: string[] = []
  const win: PrintWindowLike = {
    closed: false,
    opener: 'original',
    document: doc,
    focus: () => void events.push('focus'),
    print: () => void events.push('print'),
    close: () => {
      win.closed = true
      events.push('close')
    },
  }
  // jsdom 的 HTMLImageElement 没有 decode：补一个，按 src 决定成功或失败（afterEach 里还原，不污染别的用例）
  imageProto.decode = function (this: HTMLImageElement) {
    return options.decode ? options.decode(this.src) : Promise.resolve()
  }
  const host: PrintHost = { open: vi.fn(() => win) }
  return { win, doc, events, host }
}

describe('openPrintWindow', () => {
  it('被浏览器拦截（window.open 返回 null）：返回 null，不抛错', () => {
    expect(openPrintWindow('t', { open: () => null })).toBeNull()
  })

  it('打开空白窗口、断开 opener、设标题、写入打印样式与状态行', () => {
    const { win, doc, host } = fakeWindow()
    const session = openPrintWindow('我的文档', host)!
    expect(host.open).toHaveBeenCalledWith('', '_blank')
    expect(win.opener).toBeNull()
    expect(doc.title).toBe('我的文档')
    expect(doc.head.querySelector('style')!.textContent).toContain('break-after: page')
    expect(doc.head.querySelector('style')!.textContent).toContain('@page { margin: 0')
    expect(doc.querySelector('.kb-print-status')!.textContent).toBe('正在准备打印…')
    session.setStatus('第 3 / 20 页')
    expect(doc.querySelector('.kb-print-status')!.textContent).toBe('第 3 / 20 页')
  })

  it('present：按顺序每页一张 img，移除状态行，聚焦后打印', async () => {
    const { doc, events, host } = fakeWindow()
    const session = openPrintWindow('t', host)!
    const printed = await session.present(['data:a', 'data:b', 'data:c'])
    expect(printed).toBe(true)
    expect([...doc.querySelectorAll('img')].map((image) => image.getAttribute('src'))).toEqual(['data:a', 'data:b', 'data:c'])
    expect(doc.querySelector('.kb-print-status')).toBeNull()
    expect(events).toEqual(['focus', 'print'])
  })

  it('图片没解码完不打印；全部解码完才打印', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { events, host } = fakeWindow({ decode: () => gate })
    const session = openPrintWindow('t', host)!
    const pending = session.present(['data:a'])
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual([])
    release()
    await pending
    expect(events).toEqual(['focus', 'print'])
  })

  it('某张图解码失败：不卡死，其余照常打印', async () => {
    const { events, host } = fakeWindow({ decode: (src) => (src.endsWith('bad') ? Promise.reject(new Error('损坏')) : Promise.resolve()) })
    const session = openPrintWindow('t', host)!
    expect(await session.present(['data:ok', 'data:bad'])).toBe(true)
    expect(events).toEqual(['focus', 'print'])
  })

  it('用户在光栅期间关了窗口：present 返回 false，不打印', async () => {
    const { win, events, host } = fakeWindow()
    const session = openPrintWindow('t', host)!
    win.closed = true
    expect(await session.present(['data:a'])).toBe(false)
    expect(events).toEqual([])
  })

  it('解码期间窗口被关：不打印', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { win, events, host } = fakeWindow({ decode: () => gate })
    const session = openPrintWindow('t', host)!
    const pending = session.present(['data:a'])
    win.closed = true
    release()
    expect(await pending).toBe(false)
    expect(events).toEqual([])
  })

  it('abort：关掉窗口；窗口已关则不重复关闭', () => {
    const { win, events, host } = fakeWindow()
    const session = openPrintWindow('t', host)!
    session.abort()
    session.abort()
    expect(win.closed).toBe(true)
    expect(events).toEqual(['close'])
  })

  it('图片地址只经 DOM 属性写入，不拼 HTML：含引号和尖括号的地址不会产生额外节点', async () => {
    const { doc, host } = fakeWindow()
    const session = openPrintWindow('t', host)!
    await session.present(['data:x" onerror="alert(1)"><script>'])
    expect(doc.querySelectorAll('script')).toHaveLength(0)
    expect(doc.querySelectorAll('img')).toHaveLength(1)
    expect(doc.querySelector('img')!.hasAttribute('onerror')).toBe(false)
  })
})
