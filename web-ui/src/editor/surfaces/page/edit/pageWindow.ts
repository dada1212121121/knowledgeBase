/**
 * 页窗口：长文档只让 Worker 出「视口附近几页」的图。
 *
 * 逻辑来自上游 `CanvasPagesView.nextPageWindow`（Apache-2.0，见 NOTICE），常量同样是上游的取值：
 * 视口前后各多挂 2 页（滚动时下一页已经画好），再带 1 页的滞回（刚滚出去的页不立刻回收，来回滚动不抖）。
 */
export interface PageWindowRange {
  start: number
  end: number
}

export const PAGE_WINDOW_BUFFER = 2
export const PAGE_WINDOW_HYSTERESIS = 1
/** 页数不超过这个数就整篇都出图，不做窗口（短文档窗口计算只会添乱） */
export const SMALL_DOCUMENT_PAGES = 12

export function nextPageWindow(previous: PageWindowRange | null, firstVisible: number, lastVisible: number, totalPages: number): PageWindowRange {
  const mountStart = Math.max(0, firstVisible - PAGE_WINDOW_BUFFER)
  const mountEnd = Math.min(totalPages - 1, lastVisible + PAGE_WINDOW_BUFFER)
  if (!previous) return { start: mountStart, end: mountEnd }
  const keepStart = Math.max(0, mountStart - PAGE_WINDOW_HYSTERESIS)
  const keepEnd = Math.min(totalPages - 1, mountEnd + PAGE_WINDOW_HYSTERESIS)
  const start = Math.min(mountStart, Math.max(previous.start, keepStart))
  const end = Math.max(mountEnd, Math.min(previous.end, keepEnd))
  if (start === previous.start && end === previous.end) return previous
  return { start, end }
}

/** 页面几何里 y 区间 [top, bottom]（页面坐标）盖住的第一页与最后一页下标（在 pages 数组里的下标） */
export function visiblePageRange(pages: ReadonlyArray<{ bounds: { y: number; height: number } }>, top: number, bottom: number): { first: number; last: number } {
  let first = pages.length - 1
  for (let index = 0; index < pages.length; index += 1) {
    const bounds = pages[index]!.bounds
    if (bounds.y + bounds.height >= top) {
      first = index
      break
    }
  }
  let last = first
  for (let index = pages.length - 1; index >= first; index -= 1) {
    if (pages[index]!.bounds.y <= bottom) {
      last = index
      break
    }
  }
  return { first, last }
}

/** 视口中线落在哪一页（页码，从 1 起）；`scrollTop` 相对页面列顶部、`zoom` 是页面缩放 */
export function pageAtViewport(pages: ReadonlyArray<{ page: { pageIndex: number }; bounds: { y: number; height: number } }>, scrollTop: number, height: number, zoom: number): number {
  if (!pages.length) return 1
  const middle = (scrollTop + height / 2) / zoom
  let low = 0
  let high = pages.length - 1
  while (low < high) {
    const index = (low + high) >> 1
    const bounds = pages[index]!.bounds
    if (bounds.y + bounds.height > middle) high = index
    else low = index + 1
  }
  return pages[low]!.page.pageIndex + 1
}
