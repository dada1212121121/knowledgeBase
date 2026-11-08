/**
 * 触屏手势归类：放映和主画布共用
 *
 * 只做纯计算：给起点 / 终点 / 用时，回答「这是向左滑、向右滑、轻点还是别的」。
 * 单独成文件是因为阈值是体验问题（太灵敏会误翻页，太迟钝会翻不动），需要有测试钉住。
 */

export type Gesture = 'next' | 'prev' | 'tap' | 'none'

export interface GestureInput {
  dx: number
  dy: number
  /** 毫秒 */
  dt: number
}

/** 横向位移至少这么多才算滑动 */
export const SWIPE_MIN_DISTANCE = 48
/** 横向位移必须是纵向的这么多倍，否则当作上下滚动 */
export const SWIPE_AXIS_RATIO = 1.5
/** 超过这个时长的拖动不算「滑一下」 */
export const SWIPE_MAX_MS = 900
/** 位移小于它且时间短，才算轻点 */
export const TAP_MAX_DISTANCE = 10
export const TAP_MAX_MS = 500

export function classifyGesture({ dx, dy, dt }: GestureInput): Gesture {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (ax <= TAP_MAX_DISTANCE && ay <= TAP_MAX_DISTANCE && dt <= TAP_MAX_MS) return 'tap'
  if (dt > SWIPE_MAX_MS) return 'none'
  if (ax >= SWIPE_MIN_DISTANCE && ax >= ay * SWIPE_AXIS_RATIO) return dx < 0 ? 'next' : 'prev'
  return 'none'
}

/** 放映时的轻点：左 1/3 上一页，其余下一页（和 PowerPoint 手机版一致） */
export function tapTarget(x: number, width: number): 'prev' | 'next' {
  return width > 0 && x < width / 3 ? 'prev' : 'next'
}
