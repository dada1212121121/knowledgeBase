/**
 * 多选对齐 / 分布的几何计算
 *
 * 上游引擎没有内置对齐命令，只有 `setShapeRect`，所以由我们在包围盒上算出每个形状的新矩形，
 * 再批量提交（同一个撤销步里）。全部是纯函数、幻灯片坐标（缩放 1 的 CSS 像素）。
 *
 * 约定（与 PowerPoint 一致）：
 * - 选中多个形状：对齐到「选中形状的包围盒」；只选中一个：对齐到整页；
 * - 分布至少要 3 个形状：两端的形状不动，中间的形状让相邻间隙相等（按位置排序，与选择顺序无关）；
 * - 只返回位置真的会变的形状，没变的不产生无意义的修改。
 */
import { boundingBox } from './overlay'
import type { SlideRect } from './types'

export type AlignKind = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'
export type DistributeKind = 'horizontal' | 'vertical'

export interface Placed {
  id: string
  rect: SlideRect
}

/** 两个坐标差小于它视为没动（EMU 取整后 1 EMU ≈ 0.0001 px，远小于它） */
const EPSILON = 1e-3

function changed(items: readonly Placed[], next: Map<string, SlideRect>): Placed[] {
  const out: Placed[] = []
  for (const item of items) {
    const rect = next.get(item.id)
    if (!rect) continue
    if (Math.abs(rect.x - item.rect.x) > EPSILON || Math.abs(rect.y - item.rect.y) > EPSILON) out.push({ id: item.id, rect })
  }
  return out
}

/** 对齐；`page` 是单选时的参照（整页） */
export function alignRects(items: readonly Placed[], kind: AlignKind, page: { width: number; height: number }): Placed[] {
  if (!items.length) return []
  const frame: SlideRect = items.length === 1 ? { x: 0, y: 0, width: page.width, height: page.height } : boundingBox(items.map((item) => item.rect))!
  const next = new Map<string, SlideRect>()
  for (const { id, rect } of items) {
    const moved = { ...rect }
    switch (kind) {
      case 'left':
        moved.x = frame.x
        break
      case 'hcenter':
        moved.x = frame.x + (frame.width - rect.width) / 2
        break
      case 'right':
        moved.x = frame.x + frame.width - rect.width
        break
      case 'top':
        moved.y = frame.y
        break
      case 'vcenter':
        moved.y = frame.y + (frame.height - rect.height) / 2
        break
      case 'bottom':
        moved.y = frame.y + frame.height - rect.height
        break
    }
    next.set(id, moved)
  }
  return changed(items, next)
}

/** 分布：至少 3 个形状才有意义，不足返回空 */
export function distributeRects(items: readonly Placed[], kind: DistributeKind): Placed[] {
  if (items.length < 3) return []
  const horizontal = kind === 'horizontal'
  const start = (r: SlideRect) => (horizontal ? r.x : r.y)
  const size = (r: SlideRect) => (horizontal ? r.width : r.height)
  // 按起点排序（并列时按终点，保证结果稳定）
  const sorted = [...items].sort((a, b) => start(a.rect) - start(b.rect) || start(a.rect) + size(a.rect) - (start(b.rect) + size(b.rect)))
  const first = sorted[0]!
  const last = sorted.at(-1)!
  const span = start(last.rect) + size(last.rect) - start(first.rect)
  const used = sorted.reduce((sum, item) => sum + size(item.rect), 0)
  const gap = (span - used) / (sorted.length - 1)
  const next = new Map<string, SlideRect>()
  let cursor = start(first.rect)
  for (const item of sorted) {
    const moved = { ...item.rect }
    if (horizontal) moved.x = cursor
    else moved.y = cursor
    cursor += size(item.rect) + gap
    next.set(item.id, moved)
  }
  return changed(items, next)
}
