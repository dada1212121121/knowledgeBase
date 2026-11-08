/**
 * 远端选区矩形的整理
 *
 * 引擎按"每个字符串一个矩形"给出远端选区，长选区能有几百个碎片。直接画会让 DOM 里堆几百个半透明块，
 * 滚动和缩放都卡。整理三步：只留页窗口内的有效矩形 → 同一行上相邻的合并成一条 → 总数超过上限时按页均摊、
 * 每组取外包矩形（选区看起来略粗一点，比卡顿好）。
 *
 * 逻辑来自上游 `overlays/remotePresenceGeometry.ts` 的 `simplifyRemoteSelectionRects`（Apache-2.0，见 NOTICE），
 * 去掉了只服务旧 DOM 渲染路径的那部分，这里只留 Worker 路径用到的纯几何。
 */
export interface PresenceRect {
  pageIndex: number
  x: number
  y: number
  width: number
  height: number
}

export interface PresencePageWindow {
  start: number
  end: number
}

/** 最多画多少块；超过就合并 */
export const REMOTE_PRESENCE_MAX_RECTS = 64

const validRect = (rect: PresenceRect): boolean =>
  Number.isSafeInteger(rect.pageIndex) &&
  Number.isFinite(rect.x) &&
  Number.isFinite(rect.y) &&
  Number.isFinite(rect.width) &&
  Number.isFinite(rect.height) &&
  rect.width > 0 &&
  rect.height > 0

function unionRects(rects: readonly PresenceRect[], start: number, end: number): PresenceRect {
  const first = rects[start]!
  let left = first.x
  let top = first.y
  let right = first.x + first.width
  let bottom = first.y + first.height
  for (let index = start + 1; index < end; index += 1) {
    const rect = rects[index]!
    left = Math.min(left, rect.x)
    top = Math.min(top, rect.y)
    right = Math.max(right, rect.x + rect.width)
    bottom = Math.max(bottom, rect.y + rect.height)
  }
  return { pageIndex: first.pageIndex, x: left, y: top, width: right - left, height: bottom - top }
}

/** 同一页、同一行（y 与高度差 ≤1px）、水平上相接（间隙 ≤2px）的矩形合成一条 */
function mergeLineRects(rects: readonly PresenceRect[]): PresenceRect[] {
  const merged: PresenceRect[] = []
  for (const rect of rects) {
    const previous = merged.at(-1)
    if (previous && previous.pageIndex === rect.pageIndex && Math.abs(previous.y - rect.y) <= 1 && Math.abs(previous.height - rect.height) <= 1 && rect.x <= previous.x + previous.width + 2) {
      const left = Math.min(previous.x, rect.x)
      const top = Math.min(previous.y, rect.y)
      const right = Math.max(previous.x + previous.width, rect.x + rect.width)
      const bottom = Math.max(previous.y + previous.height, rect.y + rect.height)
      previous.x = left
      previous.y = top
      previous.width = right - left
      previous.height = bottom - top
    } else merged.push({ ...rect })
  }
  return merged
}

export function simplifyRemoteSelectionRects(rects: readonly PresenceRect[], window: PresencePageWindow): PresenceRect[] {
  const ordered = rects
    .filter((rect) => rect.pageIndex >= window.start && rect.pageIndex <= window.end && validRect(rect))
    .slice()
    .sort((left, right) => left.pageIndex - right.pageIndex || left.y - right.y || left.x - right.x)
  const merged = mergeLineRects(ordered)
  if (merged.length <= REMOTE_PRESENCE_MAX_RECTS) return merged

  // 超限：每页至少留一块，其余名额按"每块已分到的碎片数"最大者优先分配（碎片多的页拿到更多块）
  const byPage = new Map<number, PresenceRect[]>()
  for (const rect of merged) {
    const pageRects = byPage.get(rect.pageIndex)
    if (pageRects) pageRects.push(rect)
    else byPage.set(rect.pageIndex, [rect])
  }
  const pages = [...byPage.values()]
  const allocations = pages.map(() => 1)
  let remaining = REMOTE_PRESENCE_MAX_RECTS - pages.length
  while (remaining > 0) {
    let choice = -1
    let score = 0
    for (let index = 0; index < pages.length; index += 1) {
      const count = pages[index]!.length
      if (allocations[index]! >= count) continue
      const candidate = count / allocations[index]!
      if (candidate > score) {
        score = candidate
        choice = index
      }
    }
    if (choice < 0) break
    allocations[choice]! += 1
    remaining -= 1
  }
  const simplified: PresenceRect[] = []
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const pageRects = pages[pageIndex]!
    const allocation = allocations[pageIndex]!
    for (let index = 0; index < allocation; index += 1) {
      simplified.push(unionRects(pageRects, Math.floor((index * pageRects.length) / allocation), Math.floor(((index + 1) * pageRects.length) / allocation)))
    }
  }
  return simplified
}
