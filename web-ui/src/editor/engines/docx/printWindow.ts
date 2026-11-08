/**
 * 打印窗口：把一组整页位图排进新窗口，等图片都解码完再调用浏览器打印。
 *
 * 为什么自己写而不用 `@betteroffice/docx` 的 `openPrintWindow`：读过它的实现，只有 15 行
 * （`window.open` + `opener = null` + 一段固定样式 + 解析传入的 HTML），没有不可替代的东西；
 * 自己写能用 DOM API 一张张创建 `<img>`（不拼 HTML 字符串，也就没有注入面）、能单测，
 * 也不用往版本锁里再登记一个入口。样式沿用上游思路：每页一张整幅图、页间强制分页、`@page` 零边距。
 *
 * 浏览器只允许在用户手势的同一个调用栈里 `window.open`，之后再 `await` 就会被当成弹窗拦截——
 * 所以 `openPrintWindow` 必须在命令的第一个 `await` 之前调用，拿到窗口句柄后再慢慢光栅每一页。
 */

export interface PrintWindowLike {
  closed: boolean
  opener: unknown
  document: Document
  focus(): void
  print(): void
  close(): void
}

export interface PrintHost {
  open(url: string, target: string): PrintWindowLike | null
}

const PRINT_CSS = [
  'html, body { margin: 0; padding: 0; background: #fff; }',
  'img { display: block; width: 100%; height: auto; break-after: page; }',
  'img:last-child { break-after: auto; }',
  '@page { margin: 0; size: auto; }',
  '.kb-print-status { font: 14px/1.6 system-ui, sans-serif; padding: 24px; color: #333; }',
  '@media print { .kb-print-status { display: none; } }',
].join('\n')

export interface PrintSession {
  window: PrintWindowLike
  /** 光栅过程中给用户看的状态文字（窗口里一行字，打印时隐藏） */
  setStatus(text: string): void
  /** 把所有页放进窗口、等图片解码、调用打印。窗口已被用户关掉则返回 false */
  present(pages: readonly string[]): Promise<boolean>
  /** 失败或取消：关掉空窗口，不留一个白页给用户 */
  abort(): void
}

/** 必须在用户手势内同步调用。被浏览器拦截（返回 null）时返回 null，调用方给出"允许弹窗"的提示 */
export function openPrintWindow(title: string, host: PrintHost = { open: (url, target) => window.open(url, target) }): PrintSession | null {
  const win = host.open('', '_blank')
  if (!win) return null
  // 新窗口不能反过来操作原页面
  win.opener = null
  const doc = win.document
  doc.title = title
  const style = doc.createElement('style')
  style.textContent = PRINT_CSS
  doc.head.appendChild(style)
  const status = doc.createElement('p')
  status.className = 'kb-print-status'
  status.textContent = '正在准备打印…'
  doc.body.appendChild(status)

  return {
    window: win,
    setStatus(text) {
      status.textContent = text
    },
    async present(pages) {
      if (win.closed) return false
      status.remove()
      const images = pages.map((src) => {
        const image = doc.createElement('img')
        image.src = src
        doc.body.appendChild(image)
        return image
      })
      // 图片没解码完就打印会印出空白页；解码失败的那张也不能卡死整个打印
      await Promise.all(images.map((image) => image.decode().catch(() => undefined)))
      if (win.closed) return false
      win.focus()
      win.print()
      return true
    },
    abort() {
      if (!win.closed) win.close()
    },
  }
}
