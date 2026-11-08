// 「滑块跟着选中项走」:量选中项的位置和宽度,写成 CSS 变量,由 CSS 的 transform / width 过渡去动。
// 首次渲染直接到位(不从 0 滑过来);窗口 / 内容变化时用 ResizeObserver 重新量。
import { nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

export function useSlider(container: Ref<HTMLElement | null>, itemSelector: string, activeKey: () => unknown) {
  const style = ref<Record<string, string>>({ opacity: '0' })
  const ready = ref(false)
  let observer: ResizeObserver | null = null

  function update() {
    const root = container.value
    if (!root) return
    const active = root.querySelector<HTMLElement>(`${itemSelector}[data-active="true"]`)
    if (!active) {
      style.value = { opacity: '0' }
      return
    }
    style.value = {
      '--sl-x': `${active.offsetLeft}px`,
      '--sl-y': `${active.offsetTop}px`,
      '--sl-w': `${active.offsetWidth}px`,
      '--sl-h': `${active.offsetHeight}px`,
      opacity: '1',
    }
  }

  onMounted(async () => {
    await nextTick()
    update()
    // 下一帧再打开过渡,避免首次定位被当成一次动画
    requestAnimationFrame(() => (ready.value = true))
    if (container.value && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(update)
      observer.observe(container.value)
    }
  })
  watch(activeKey, async () => {
    await nextTick()
    update()
  })
  onBeforeUnmount(() => observer?.disconnect())
  return { style, ready, update }
}
