/**
 * 只读预览（DOM 分页）的阅读位置：量页位置、记下 / 恢复阅读位置、量页面未缩放尺寸（补全）
 *
 * 算法在 `thumbs/scrollSync.ts`（纯数字）；这里只负责把 DOM 量成数字、把结果写回 scrollTop。
 * 页的位置一律用 getBoundingClientRect 换算成**滚动内容坐标**：docx-preview 的页放在设了 CSS `zoom` 的容器里，
 * 不同浏览器对 offsetTop / offsetHeight 是否含 zoom 的口径不一，而 getBoundingClientRect 永远是屏幕上看到的像素。
 */
import { pageElements } from './docx-read'
import { captureAnchor, referenceLine, scrollTopForAnchor, type PageBox, type ReadingAnchor } from './thumbs/scrollSync'

/** 各页在滚动内容里的位置（当前缩放下的像素） */
export function pageBoxesOf(scroller: HTMLElement, host: HTMLElement): PageBox[] {
  // 内容坐标原点 = 滚动容器内容区的上沿 = 容器上沿 - 已滚动距离
  const origin = scroller.getBoundingClientRect().top - scroller.scrollTop
  return pageElements(host).map((page) => {
    const rect = page.getBoundingClientRect()
    return { top: rect.top - origin, height: rect.height }
  })
}

/** 视口中线所在的阅读位置（页 + 页内比例）；没有页返回 null */
export function readPosition(scroller: HTMLElement, host: HTMLElement): ReadingAnchor | null {
  return captureAnchor(pageBoxesOf(scroller, host), referenceLine(scroller.scrollTop, scroller.clientHeight))
}

/** 把阅读位置放回视口中线（缩放后 / 切换版式后调用，要在新布局生效之后） */
export function restorePosition(scroller: HTMLElement, host: HTMLElement, anchor: ReadingAnchor): void {
  const boxes = pageBoxesOf(scroller, host)
  if (!boxes.length) return
  scroller.scrollTop = scrollTopForAnchor(boxes, anchor, scroller.clientHeight, scroller.scrollHeight)
}

/**
 * 各页**未缩放**的版面尺寸：屏幕尺寸除以当前缩放。缩略图按它定纵横比、算缩小倍数，
 * 所以不随窗口宽度 / 缩放变（页面在 fit 模式下每次窗口变化缩放都会变）。
 */
export function naturalPageSizes(host: HTMLElement, scale: number): Array<{ width: number; height: number }> {
  const factor = scale > 0 ? scale : 1
  return pageElements(host).map((page) => {
    const rect = page.getBoundingClientRect()
    return { width: rect.width / factor, height: rect.height / factor }
  })
}
