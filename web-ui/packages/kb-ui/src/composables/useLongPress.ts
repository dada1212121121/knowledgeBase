// 长按(触屏):手指按住不动 ≥ 450ms 触发,移动超过容差(在滚动)或抬起就取消;鼠标不触发。
// 设计规范:列表项长按进入多选;文档里的长按交给系统(选字、复制),所以这个只用在列表行 / 卡片上。
// 长按触发后,抬手那一下的 click 要被吞掉(`consumeClick` 返回 true 一次),否则刚选中就又被点掉了。
import { onBeforeUnmount } from 'vue'

export interface LongPressOptions {
  ms?: number
  tolerance?: number
}

export function useLongPress(onLong: (event: PointerEvent) => void, options: LongPressOptions = {}) {
  const ms = options.ms ?? 450
  const tolerance = options.tolerance ?? 8
  let timer: ReturnType<typeof setTimeout> | undefined
  let from = { x: 0, y: 0 }
  let fired = false

  function cancel() {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  function start(event: PointerEvent) {
    if (event.pointerType === 'mouse') return
    fired = false
    from = { x: event.clientX, y: event.clientY }
    cancel()
    timer = setTimeout(() => {
      fired = true
      timer = undefined
      onLong(event)
    }, ms)
  }
  function move(event: PointerEvent) {
    if (timer && Math.hypot(event.clientX - from.x, event.clientY - from.y) > tolerance) cancel()
  }
  /** 抬手后的 click 是否应被忽略(长按刚触发过)。读取即清除。 */
  function consumeClick(): boolean {
    const was = fired
    fired = false
    return was
  }
  onBeforeUnmount(cancel)

  return { start, move, end: cancel, consumeClick, bind: { onPointerdown: start, onPointermove: move, onPointerup: cancel, onPointercancel: cancel } }
}
