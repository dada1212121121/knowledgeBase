// 视口档位与输入方式(设计规范)。
//
// 按「可用宽度」判断布局,而不是按设备类型:平板分屏、手机横屏、桌面小窗口都要对。
// 五档:phone <600 · fold 600–839 · tablet 840–1279 · desktop 1280–1919 · wide ≥1920。
// 这里的数值和 packages/kb-ui/src/tokens/shell.css 里的 @media 必须一致(CSS 管样式,这里管「要不要渲染」),
// 所以断点只在这个文件里定义一次,并导出给测试和文档引用。
import { computed, readonly, ref } from 'vue'

export type Tier = 'phone' | 'fold' | 'tablet' | 'desktop' | 'wide'

/** 每一档的下界(px);phone 从 0 开始。 */
export const TIER_MIN: Record<Tier, number> = { phone: 0, fold: 600, tablet: 840, desktop: 1280, wide: 1920 }

/** 与 CSS 对齐的媒体查询字符串(测试里也用它们来模拟 matchMedia)。 */
export const TIER_QUERY: Record<Tier, string> = {
  phone: '(max-width: 599px)',
  fold: '(min-width: 600px) and (max-width: 839px)',
  tablet: '(min-width: 840px) and (max-width: 1279px)',
  desktop: '(min-width: 1280px) and (max-width: 1919px)',
  wide: '(min-width: 1920px)',
}

export function tierOfWidth(width: number): Tier {
  if (width >= TIER_MIN.wide) return 'wide'
  if (width >= TIER_MIN.desktop) return 'desktop'
  if (width >= TIER_MIN.tablet) return 'tablet'
  if (width >= TIER_MIN.fold) return 'fold'
  return 'phone'
}

const width = ref(typeof window === 'undefined' ? 1440 : window.innerWidth)
const height = ref(typeof window === 'undefined' ? 900 : window.innerHeight)
const portrait = ref(true)
const touch = ref(false)
let started = false

function mq(query: string): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null
}

function measure() {
  width.value = window.innerWidth
  height.value = window.innerHeight
  // matchMedia 不可用(jsdom)时按宽高比判断,和 CSS 的 orientation 语义一致
  portrait.value = mq('(orientation: portrait)')?.matches ?? height.value >= width.value
  // 触屏:主要输入设备不能悬停或是粗指针。不按宽度判断(大平板也是触屏,触屏笔记本也有鼠标)
  touch.value = mq('(hover: none)')?.matches === true || mq('(pointer: coarse)')?.matches === true
  const root = document.documentElement
  root.dataset.bp = tierOfWidth(width.value)
  root.dataset.input = touch.value ? 'touch' : 'mouse'
  root.dataset.orient = portrait.value ? 'portrait' : 'landscape'
}

/** 开始监听(整个应用只需要一次,重复调用无副作用)。 */
export function startViewport() {
  if (started || typeof window === 'undefined') return
  started = true
  measure()
  window.addEventListener('resize', measure, { passive: true })
  window.addEventListener('orientationchange', measure, { passive: true })
  for (const query of ['(orientation: portrait)', '(hover: none)', '(pointer: coarse)']) {
    mq(query)?.addEventListener?.('change', measure)
  }
}

/** 测试用:重新量一次(vi.stubGlobal 改过 innerWidth / matchMedia 之后调用)。 */
export function remeasureViewport() {
  if (typeof window === 'undefined') return
  started = true
  measure()
}

export function useViewport() {
  startViewport()
  const tier = computed<Tier>(() => tierOfWidth(width.value))
  /**
   * 导航形态:手机、以及竖屏的折叠屏 / 小平板用底部标签栏;其余用侧栏(横屏的 600–839 用图标栏)。
   * 标签栏 + 「我的」页是手机上唯一的导航,不再有汉堡抽屉。
   */
  const navKind = computed<'tabbar' | 'sidebar'>(() =>
    tier.value === 'phone' || (tier.value === 'fold' && portrait.value) ? 'tabbar' : 'sidebar',
  )
  /** 侧栏「展开」是否以浮层方式盖在内容上(600–1279):不挤压内容,也不记进用户偏好。 */
  const overlayNav = computed(() => navKind.value === 'sidebar' && (tier.value === 'fold' || tier.value === 'tablet'))
  return {
    width: readonly(width),
    height: readonly(height),
    portrait: readonly(portrait),
    touch: readonly(touch),
    tier,
    navKind,
    overlayNav,
  }
}
