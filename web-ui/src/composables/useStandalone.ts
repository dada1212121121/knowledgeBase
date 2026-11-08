// 「已安装的独立窗口」检测。
//
// 装成 PWA 后没有浏览器的地址栏、后退、刷新,所以外壳要自己补:顶栏出现返回 / 刷新,外链改成交给系统浏览器打开并提示。
// 判断来源:
//   - 标准:display-mode: standalone / minimal-ui / fullscreen / window-controls-overlay;
//   - iOS Safari 的「添加到主屏幕」:navigator.standalone === true(不一定匹配 display-mode)。
import { onBeforeUnmount, ref } from 'vue'

const DISPLAY_MODES = ['standalone', 'minimal-ui', 'fullscreen', 'window-controls-overlay'] as const

/** 一次性判断(不响应变化)。 */
export function detectStandalone(): boolean {
  if (typeof window === 'undefined') return false
  if ((navigator as Navigator & { standalone?: boolean }).standalone === true) return true
  return DISPLAY_MODES.some((mode) => window.matchMedia?.(`(display-mode: ${mode})`).matches)
}

/** 能不能后退:vue-router 会把上一个位置写进 history.state.back,首个页面里是 null。 */
export function canGoBack(): boolean {
  const state = window.history.state as { back?: string | null } | null
  return Boolean(state?.back)
}

/** 外部链接:同源、锚点、mailto/tel 以外的 http(s) 地址。 */
export function isExternalLink(href: string, origin = window.location.origin): boolean {
  try {
    const url = new URL(href, origin)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== origin
  } catch {
    return false
  }
}

/** 响应式的独立窗口状态,并同步到 <html data-display-mode>(给样式用)。 */
export function useStandalone() {
  const standalone = ref(detectStandalone())
  const queries = typeof window === 'undefined' ? [] : DISPLAY_MODES.map((mode) => window.matchMedia?.(`(display-mode: ${mode})`)).filter(Boolean)

  function sync() {
    standalone.value = detectStandalone()
    document.documentElement.dataset.displayMode = standalone.value ? 'standalone' : 'browser'
  }
  sync()
  for (const query of queries) query.addEventListener?.('change', sync)
  onBeforeUnmount(() => {
    for (const query of queries) query.removeEventListener?.('change', sync)
  })
  return { standalone, canGoBack }
}

/**
 * 独立窗口里点外部链接:没有地址栏,窗口里直接跳走就回不来了。
 * 改成新开(交给系统浏览器 / 应用内浏览器),并告诉用户发生了什么。
 * 返回卸载函数。
 */
export function interceptExternalLinks(onOpen: (href: string) => void): () => void {
  const handler = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return
    const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!anchor) return
    const href = anchor.getAttribute('href') ?? ''
    if (!isExternalLink(href)) return
    // 已经声明新开的(target=_blank)不拦,浏览器本来就会处理
    if (anchor.target === '_blank') {
      onOpen(anchor.href)
      return
    }
    event.preventDefault()
    window.open(anchor.href, '_blank', 'noopener,noreferrer')
    onOpen(anchor.href)
  }
  document.addEventListener('click', handler)
  return () => document.removeEventListener('click', handler)
}
