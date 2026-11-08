// 底部弹层「下滑关闭」(设计规范):从顶部把手(或弹层头部)向下拖,超过阈值或速度够快就关闭。
// 只在手柄区域起拖,不拦截内容区的滚动;拖动中弹层跟手移动,松手不够则弹回。
import { ref, type Ref } from 'vue'

export interface SwipeOptions {
  /** 拖动超过这个距离(px)就关闭 */
  distance?: number
  /** 或者松手时速度(px/ms)超过这个值也关闭 */
  velocity?: number
  onDismiss: () => void
}

export function useSwipeDismiss(target: Ref<HTMLElement | null>, options: SwipeOptions) {
  const distance = options.distance ?? 96
  const velocity = options.velocity ?? 0.6
  /** 当前下移量(px);0 = 没在拖 */
  const offset = ref(0)
  const dragging = ref(false)
  let startY = 0
  let startAt = 0
  let activeId = -1

  function onPointerDown(event: PointerEvent) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    dragging.value = true
    startY = event.clientY
    startAt = event.timeStamp
    activeId = event.pointerId
    ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  }
  function onPointerMove(event: PointerEvent) {
    if (!dragging.value || event.pointerId !== activeId) return
    // 只允许往下拖;往上拖带一点阻尼,表示「到头了」
    const delta = event.clientY - startY
    offset.value = delta > 0 ? delta : delta * 0.15
  }
  function finish(event: PointerEvent, cancelled: boolean) {
    if (!dragging.value || event.pointerId !== activeId) return
    dragging.value = false
    const moved = offset.value
    const elapsed = Math.max(1, event.timeStamp - startAt)
    offset.value = 0
    if (!cancelled && (moved >= distance || (moved > 24 && moved / elapsed >= velocity))) options.onDismiss()
  }

  return {
    offset,
    dragging,
    bind: {
      onPointerdown: onPointerDown,
      onPointermove: onPointerMove,
      onPointerup: (event: PointerEvent) => finish(event, false),
      onPointercancel: (event: PointerEvent) => finish(event, true),
    },
    /** 测试 / 外部需要时可用 */
    el: target,
  }
}
