// 让「内容溢出、能滚动」的容器可以被键盘聚焦(WCAG 2.1.1;axe scrollable-region-focusable)。
//
// 为什么要:宽表格在窄一点的屏幕上会在 .kb-scroll 里横向滚动;鼠标和手指能滚,键盘用户却 Tab 不到它,
// 里面又没有别的可聚焦元素(行不可点)时,就没法用方向键滚动。给溢出的容器 tabindex=0,方向键才能滚。
// 为什么只在溢出时加:不溢出的表格加了只会多一个没用的 Tab 停靠点。
// 为什么用 ResizeObserver:窗口缩放、列数变化、数据行增减都会改变是否溢出,不能只在挂载时量一次。
import { onBeforeUnmount, ref, watch, type Ref } from 'vue'

/** 返回「现在是否溢出」;调用方把它绑成 :tabindex="scrollable ? 0 : undefined"。 */
export function useScrollFocus(el: Ref<HTMLElement | null>): Ref<boolean> {
  const scrollable = ref(false)
  let observer: ResizeObserver | undefined
  const measure = () => {
    const node = el.value
    // 差 1px 以内是亚像素取整造成的,不算溢出
    scrollable.value = !!node && (node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1)
  }
  // 不能只在 onMounted 里量:表格要等数据加载完才从骨架屏换成 .kb-scroll,容器是挂载之后才出现的。
  // 所以跟着 ref 走——容器出现(或被换掉)时重新挂观察器。
  watch(
    el,
    (node) => {
      observer?.disconnect()
      observer = undefined
      measure()
      if (!node || typeof ResizeObserver === 'undefined') return
      observer = new ResizeObserver(measure)
      // 容器自己变大变小,和里面的内容(表格)变宽变高,都要重量
      observer.observe(node)
      for (const child of node.children) observer.observe(child)
    },
    { flush: 'post' },
  )
  onBeforeUnmount(() => observer?.disconnect())
  return scrollable
}
