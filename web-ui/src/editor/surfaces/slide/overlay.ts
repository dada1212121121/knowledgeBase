/**
 * 选中框 / 控制点 / 对齐线的几何（骨架， 接编辑手势）
 *
 * 坐标约定：本文件里所有矩形都在「幻灯片坐标」里（缩放 1 的 CSS 像素，原点在页面左上角），
 * 与屏幕无关；视图把它们乘上当前缩放再摆到画布上。这样缩放、DPR、滚动都不影响命中和吸附计算。
 */
import type { SlideRect } from './types'

/** 8 个缩放控制点：北 / 东 / 南 / 西 + 四个角 */
export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export const HANDLE_IDS: readonly HandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** 控制点的屏幕尺寸（CSS px）；触屏更大，手指点不准 8px 的点 */
export const HANDLE_SIZE = 8
export const HANDLE_SIZE_COARSE = 20

export interface Point {
  x: number
  y: number
}

/** 控制点在矩形上的位置（幻灯片坐标） */
export function handlePoint(rect: SlideRect, id: HandleId): Point {
  const left = rect.x
  const right = rect.x + rect.width
  const top = rect.y
  const bottom = rect.y + rect.height
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  switch (id) {
    case 'nw':
      return { x: left, y: top }
    case 'n':
      return { x: cx, y: top }
    case 'ne':
      return { x: right, y: top }
    case 'e':
      return { x: right, y: cy }
    case 'se':
      return { x: right, y: bottom }
    case 's':
      return { x: cx, y: bottom }
    case 'sw':
      return { x: left, y: bottom }
    case 'w':
      return { x: left, y: cy }
  }
}

/** 命中哪个控制点：`slop` 是命中半径（幻灯片坐标，= 屏幕像素 / scale），取最近的一个 */
export function hitHandle(rect: SlideRect, point: Point, slop: number): HandleId | null {
  let best: HandleId | null = null
  let bestDistance = Infinity
  for (const id of HANDLE_IDS) {
    const at = handlePoint(rect, id)
    const distance = Math.hypot(at.x - point.x, at.y - point.y)
    if (distance <= slop && distance < bestDistance) {
      best = id
      bestDistance = distance
    }
  }
  return best
}

export function containsPoint(rect: SlideRect, point: Point): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height
}

/** 多个矩形的包围盒；空数组返回 null */
export function boundingBox(rects: readonly SlideRect[]): SlideRect | null {
  if (!rects.length) return null
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const r of rects) {
    left = Math.min(left, r.x)
    top = Math.min(top, r.y)
    right = Math.max(right, r.x + r.width)
    bottom = Math.max(bottom, r.y + r.height)
  }
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** 一条对齐参考线：`axis` 为 x 表示竖线（位置是 x 坐标），y 表示横线 */
export interface Guide {
  axis: 'x' | 'y'
  position: number
}

export interface SnapResult {
  /** 吸附后的矩形（没吸附上的轴保持原值） */
  rect: SlideRect
  guides: Guide[]
}

/** 一个矩形在某个轴上的三个特征位置：起、中、止 */
function anchors(rect: SlideRect, axis: 'x' | 'y'): number[] {
  return axis === 'x'
    ? [rect.x, rect.x + rect.width / 2, rect.x + rect.width]
    : [rect.y, rect.y + rect.height / 2, rect.y + rect.height]
}

/**
 * 拖动时的对齐吸附：把 `moving` 的边 / 中线吸附到页面边缘、页面中线以及其他形状的边 / 中线上。
 * `threshold` 是吸附距离（幻灯片坐标；屏幕上约 6px，换算成 `6 / scale` 再传进来）。
 * 每个轴只取最近的一个吸附点，并返回对应的参考线，视图据此画粉色辅助线。
 */
export function snapRect(moving: SlideRect, others: readonly SlideRect[], page: { width: number; height: number }, threshold: number): SnapResult {
  const targets = { x: [] as number[], y: [] as number[] }
  const pageRect: SlideRect = { x: 0, y: 0, width: page.width, height: page.height }
  for (const rect of [pageRect, ...others]) {
    targets.x.push(...anchors(rect, 'x'))
    targets.y.push(...anchors(rect, 'y'))
  }
  const result: SlideRect = { ...moving }
  const guides: Guide[] = []
  for (const axis of ['x', 'y'] as const) {
    let bestDelta = 0
    let bestGuide: number | null = null
    let bestDistance = threshold + 1e-9
    for (const mine of anchors(moving, axis)) {
      for (const target of targets[axis]) {
        const distance = Math.abs(target - mine)
        if (distance < bestDistance) {
          bestDistance = distance
          bestDelta = target - mine
          bestGuide = target
        }
      }
    }
    if (bestGuide !== null) {
      result[axis] += bestDelta
      guides.push({ axis, position: bestGuide })
    }
  }
  return { rect: result, guides }
}

/** 幻灯片坐标 → 画布上的 CSS 样式值（给 overlay 里的绝对定位元素用） */
export function toScreen(rect: SlideRect, scale: number): { left: string; top: string; width: string; height: string } {
  return {
    left: `${rect.x * scale}px`,
    top: `${rect.y * scale}px`,
    width: `${rect.width * scale}px`,
    height: `${rect.height * scale}px`,
  }
}
