/**
 * 滚动视口的几何小工具。
 *
 * 改写自上游 `internals/viewportBand.ts` 与 `@betteroffice/docx/utils/findVerticalScrollParent`、
 * `layout/render` 的 `effectiveZoom`（Apache-2.0，见 NOTICE）。这些是纯 DOM 计算，不依赖引擎，
 * 而 Surface 层不能 import `@betteroffice/*`，所以在这里重写一份同样的实现，并配单测。
 *
 * 为什么要处理「有效缩放」：浏览器的 CSS `zoom` 会让 getBoundingClientRect 的单位和 layout 像素不一致，
 * 光标定位、滚动到可见都要先除以它，否则放大页面后输入框会漂到错误位置。
 */

/** 元素当前的有效 CSS zoom（沿祖先链累乘）；不支持 `currentCSSZoom` 的浏览器退回逐级读取计算样式 */
export function effectiveZoom(element: Element): number {
  const direct = (element as Element & { currentCSSZoom?: number }).currentCSSZoom
  if (typeof direct === 'number') return direct > 0 && Number.isFinite(direct) ? direct : 1
  if (typeof getComputedStyle !== 'function') return 1
  let zoom = 1
  for (let node: Element | null = element; node; node = node.parentElement) {
    const value = Number.parseFloat(getComputedStyle(node).zoom)
    if (value > 0 && Number.isFinite(value)) zoom *= value
  }
  return zoom
}

/** 最近的可纵向滚动的祖先；没有则 null */
export function findVerticalScrollParent(element: HTMLElement): HTMLElement | null {
  let node = element.parentElement
  while (node && node !== document.documentElement) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1) return node
    node = node.parentElement
  }
  return null
}

export function findVerticalScrollParentOrRoot(element: HTMLElement): HTMLElement {
  return findVerticalScrollParent(element) ?? document.documentElement
}

/** 一个滚动容器当前能看到的范围 */
export interface ScrollViewport {
  /** 容器盒子的 client 顶部；根滚动用窗口的 */
  top: number
  /** 容器盒子的 client 底部 */
  bottom: number
  /** 容器显示内容用的 layout 高度 */
  height: number
  /** 每个 scrollTop 单位对应的 client 像素；根滚动按视口单位走，所以是 1 */
  zoom: number
}

function isRootScroller(scroller: Element): boolean {
  return typeof document !== 'undefined' && scroller === (document.scrollingElement ?? document.documentElement)
}

export function scrollViewport(scroller: HTMLElement): ScrollViewport {
  if (isRootScroller(scroller)) return { top: 0, bottom: window.innerHeight, height: window.innerHeight, zoom: 1 }
  const rect = scroller.getBoundingClientRect()
  return { top: rect.top, bottom: rect.bottom, height: scroller.clientHeight, zoom: effectiveZoom(scroller) }
}

/**
 * 滚动视口盖在页面列（column）上的那一段，单位是列的 layout 像素：
 * 这一段从列顶往下 `top - columnTop` 开始。`scroller` 为 null 表示根滚动。
 */
export function viewportColumnBand(
  scroller: HTMLElement | null,
  column: HTMLElement,
): { columnTop: number; top: number; height: number } {
  const viewport = scroller ? scrollViewport(scroller) : { top: 0, height: window.innerHeight, zoom: 1 }
  const zoom = effectiveZoom(column)
  return {
    columnTop: column.getBoundingClientRect().top / zoom,
    top: viewport.top / zoom,
    height: (viewport.height * viewport.zoom) / zoom,
  }
}

/** 让 client 像素区间 [top, bottom] 进入容器盒子并留 `margin` 的边距，需要改变的 scrollTop 量 */
export function scrollIntoViewDelta(viewport: ScrollViewport, top: number, bottom: number, margin: number): number {
  const { zoom } = viewport
  if (top < viewport.top + margin * zoom) return (top - viewport.top) / zoom - margin
  if (bottom > viewport.bottom - margin * zoom) return (bottom - viewport.bottom) / zoom + margin
  return 0
}
