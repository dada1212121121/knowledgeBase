/**
 * 滚动同步的纯计算（补全）
 *
 * 为什么单独成纯函数：只读预览（DOM 分页）和画布编辑（引擎排版的页几何）是两套完全不同的页面摆放方式，
 * 但「视口参考线落在哪一页」「缩放前后停在同一处」「缩略图栏滚到让当前项可见」这三件事的算法是同一份。
 * 把它们写成只吃数字的函数，两边视图各自量出页的位置再调用，jsdom 里就能把边界（间隙、首尾、空文档）测准，
 * 不依赖真实布局。
 *
 * 坐标约定：`PageBox.top` 是页面在**滚动内容坐标**里的上边（px，当前缩放下）；页按 top 升序、互不重叠。
 */

/** 一页在滚动内容里的位置（当前缩放下的像素） */
export interface PageBox {
  top: number
  height: number
}

/** 阅读位置锚点：第几页（0 起）+ 页内的相对位置（页高的比例，可略小于 0 / 大于 1：参考线落在页间空隙里） */
export interface ReadingAnchor {
  page: number
  fraction: number
}

/** 切换版式（轻预览 ⇄ 高保真）时带过去的阅读位置：锚点 + 缩放；`fit` 为真表示用户没手动缩放过，对面用自己的适应宽度 */
export interface ReadingStart extends ReadingAnchor {
  scale?: number
  fit?: boolean
}

/** 视口参考线的默认位置：视口中线。「当前页」就是中线所在的页，和页码指示、查找起点一致 */
export const REFERENCE_RATIO = 0.5

/** 滚动位置 → 视口参考线在内容坐标里的位置 */
export function referenceLine(scrollTop: number, viewHeight: number, ratio = REFERENCE_RATIO): number {
  return scrollTop + viewHeight * ratio
}

/**
 * 参考线落在哪一页（0 起）：第一个底边不在参考线之上的页；参考线在所有页之下取最后一页；没有页返回 -1。
 * 与旧的 `currentPage`（逐页量 getBoundingClientRect）结果一致，但用二分，几百页也不会在滚动里逐页读布局。
 */
export function pageIndexAtLine(boxes: readonly PageBox[], line: number): number {
  if (!boxes.length) return -1
  let low = 0
  let high = boxes.length - 1
  while (low < high) {
    const middle = (low + high) >> 1
    const box = boxes[middle]!
    if (box.top + box.height >= line) high = middle
    else low = middle + 1
  }
  return low
}

/** 记下参考线所在的阅读位置；没有页返回 null */
export function captureAnchor(boxes: readonly PageBox[], line: number): ReadingAnchor | null {
  const page = pageIndexAtLine(boxes, line)
  if (page < 0) return null
  const box = boxes[page]!
  return { page, fraction: box.height > 0 ? (line - box.top) / box.height : 0 }
}

/** 锚点在（可能已经换了缩放的）新布局里对应的内容坐标；页码越界时夹到首 / 尾页 */
export function lineForAnchor(boxes: readonly PageBox[], anchor: ReadingAnchor): number {
  if (!boxes.length) return 0
  const box = boxes[Math.min(boxes.length - 1, Math.max(0, anchor.page))]!
  return box.top + anchor.fraction * box.height
}

/**
 * 让锚点回到视口参考线上所需的 scrollTop。结果夹在 [0, 内容高 - 视口高]：
 * 缩小到内容不满一屏时只能是 0，不能把页面推出视口。
 */
export function scrollTopForAnchor(boxes: readonly PageBox[], anchor: ReadingAnchor, viewHeight: number, contentHeight: number, ratio = REFERENCE_RATIO): number {
  const wanted = lineForAnchor(boxes, anchor) - viewHeight * ratio
  const max = Math.max(0, contentHeight - viewHeight)
  return Math.min(max, Math.max(0, wanted))
}

/** 让第 `page` 页（0 起）的顶部贴着视口上沿所需的 scrollTop（点缩略图 / 输入页码跳页用），`gap` 留一点上边距 */
export function scrollTopForPage(boxes: readonly PageBox[], page: number, viewHeight: number, contentHeight: number, gap = 0): number {
  if (!boxes.length) return 0
  const box = boxes[Math.min(boxes.length - 1, Math.max(0, page))]!
  return Math.min(Math.max(0, contentHeight - viewHeight), Math.max(0, box.top - gap))
}

/** 夹到合法页码（1 起）；没有页返回 1 */
export function clampPage(page: number, count: number): number {
  if (!Number.isFinite(page)) return 1
  return Math.min(Math.max(1, count), Math.max(1, Math.round(page)))
}

/**
 * 一排等序排列的条目里，与 [offset, offset + view] 相交的第一项和最后一项（含）。
 * `startOf(i)` / `sizeOf(i)` 由调用方给（缩略图栏用 DOM 的 offsetTop / offsetHeight 或按纵横比算出），
 * 这里只做二分，所以几百页的栏滚动一次只读 O(log n) 个条目的布局。没有条目返回 null。
 */
export function visibleRange(count: number, startOf: (index: number) => number, sizeOf: (index: number) => number, offset: number, view: number): { first: number; last: number } | null {
  if (count <= 0) return null
  let low = 0
  let high = count - 1
  while (low < high) {
    const middle = (low + high) >> 1
    if (startOf(middle) + sizeOf(middle) > offset) high = middle
    else low = middle + 1
  }
  const first = low
  let last = first
  const end = offset + view
  low = first
  high = count - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (startOf(middle) < end) low = middle
    else high = middle - 1
  }
  last = Math.max(first, low)
  return { first, last }
}

export interface RevealInput {
  /** 目标条目的起点与长度（沿滚动方向） */
  start: number
  size: number
  /** 当前滚动偏移与视口长度 */
  offset: number
  view: number
  /** 离视口边缘至少留多少，默认 8 */
  margin?: number
}

/**
 * 缩略图栏跟着主视图滚：当前页的缩略图不完全可见时，给出让它可见的新滚动偏移；已经完全可见就原样返回（不抖）。
 * 离得很远（整整一屏以外）就让它居中，近的只挪到刚好露出，避免主视图一页页翻时缩略图栏跟着一格格抖。
 */
export function revealOffset({ start, size, offset, view, margin = 8 }: RevealInput): number {
  const end = start + size
  if (start - margin >= offset && end + margin <= offset + view) return offset
  // 条目比视口还长：贴齐起点
  if (size + margin * 2 >= view) return Math.max(0, start - margin)
  const far = end < offset - view || start > offset + view * 2
  if (far) return Math.max(0, start - (view - size) / 2)
  if (start - margin < offset) return Math.max(0, start - margin)
  return Math.max(0, end + margin - view)
}
