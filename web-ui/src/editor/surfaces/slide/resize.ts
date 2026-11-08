/**
 * 拖拽缩放的几何：给定起始矩形、被拖的控制点、位移，算出新矩形
 *
 * 边界规则参考上游 pptx-react 的 resizedBounds（Apache-2.0）：对面的边不动，框不会缩到比最小尺寸还小；
 * 锁定宽高比（图片默认锁、其它形状按住 Shift）时只有四个角可用，缩放因子由对角线方向的投影决定。
 */
import type { HandleId } from './overlay'
import type { SlideRect } from './types'

/** 最小尺寸（幻灯片 px）：76200 EMU，与上游一致，再小就抓不到了 */
export const MIN_SHAPE_SIZE = 8

export function resizeRect(start: SlideRect, handle: HandleId, delta: { x: number; y: number }, options: { lockAspect?: boolean; min?: number } = {}): SlideRect {
  const min = options.min ?? MIN_SHAPE_SIZE
  if (options.lockAspect && handle.length === 2 && start.width > 0 && start.height > 0) {
    const dx = handle.includes('w') ? -delta.x : delta.x
    const dy = handle.startsWith('n') ? -delta.y : delta.y
    const factor = Math.max(1 + (dx * start.width + dy * start.height) / (start.width ** 2 + start.height ** 2), min / start.width, min / start.height)
    const width = start.width * factor
    const height = start.height * factor
    return {
      x: handle.includes('w') ? start.x + start.width - width : start.x,
      y: handle.startsWith('n') ? start.y + start.height - height : start.y,
      width,
      height,
    }
  }
  let { x, y, width, height } = start
  if (handle.includes('w')) {
    const dx = Math.min(delta.x, width - min)
    x += dx
    width -= dx
  } else if (handle.includes('e')) {
    width = Math.max(min, width + delta.x)
  }
  if (handle.startsWith('n')) {
    const dy = Math.min(delta.y, height - min)
    y += dy
    height -= dy
  } else if (handle.startsWith('s')) {
    height = Math.max(min, height + delta.y)
  }
  return { x, y, width, height }
}
