// 动效基础件。所有动效都先问一句「现在允许动吗」:
//   - 系统开了「减弱动态效果」(prefers-reduced-motion) 或外观里选了「减少」(data-motion=reduce) → 一律不动,直接到位。
import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

export function motionAllowed(): boolean {
  if (typeof window === 'undefined') return false
  if (document.documentElement.dataset.motion === 'reduce') return false
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/** 读 motion token(--dur-page 等)并换算成毫秒:浏览器可能把 `420ms` 规范化成 `0.42s`,所以要认单位。 */
export function tokenMs(name: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const value = parseFloat(raw)
  if (!Number.isFinite(value)) return fallback
  return /\ds$/.test(raw) && !/ms$/.test(raw) ? value * 1000 : value
}

/**
 * 进入视口时触发一次(uilab 图表的统一手法:「三分之一进入视口才开始画」)。
 * 返回要绑定的元素 ref 和 shown;不允许动画时 shown 立即为 true,图表直接是最终状态。
 */
export function useReveal(threshold = 0.33): { target: Ref<HTMLElement | null>; shown: Ref<boolean> } {
  const target = ref<HTMLElement | null>(null)
  const shown = ref(false)
  let observer: IntersectionObserver | null = null
  onMounted(() => {
    if (!motionAllowed() || typeof IntersectionObserver === 'undefined' || !target.value) {
      shown.value = true
      return
    }
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          shown.value = true
          observer?.disconnect()
        }
      },
      { threshold },
    )
    observer.observe(target.value)
  })
  onBeforeUnmount(() => observer?.disconnect())
  return { target, shown }
}

export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)
