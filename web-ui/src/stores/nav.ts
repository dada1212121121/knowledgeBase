// 侧栏的「现在是什么状态」:把用户的选择(ui store)、屏幕宽度、页面类型合成一个结果。
//
// 三态:expanded(图标 + 文字)· rail(只有图标)· hidden(完全收起)。
// 规则:
//   1. 用户选过就按用户的;没选过用默认(电脑展开;平板 / 横屏小屏是图标栏)。进文档工作台不会自己收起;
//   2. 600–1279 宽的屏幕上「展开」是浮层:盖在内容上、点空白处收回,不挤压内容,也不写进偏好——
//      否则在电脑上选了「展开」,换到 iPad 上一打开就被导航盖住内容;
//   3. 手机(底部标签栏形态)没有侧栏,这里的状态不起作用。
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useViewport, type Tier } from '@/composables/useViewport'
import { RAIL_WIDTH, SNAP_HIDE, SNAP_RAIL, clampSidebarWidth, useUiStore, type SidebarState } from '@/stores/ui'

/** 外观设置里的「导航布局」。rail 只是改默认值;topnav 用顶部导航条,不要侧栏。 */
export type NavLayout = 'sidebar' | 'rail' | 'topnav'

/** 没有用户选择时的默认状态。 */
export function defaultSidebar(options: { tier: Tier; layout?: NavLayout }): SidebarState {
  if (options.layout === 'rail') return 'rail'
  return options.tier === 'desktop' || options.tier === 'wide' ? 'expanded' : 'rail'
}

/** 把选择、宽度、页面类型合成最终状态(纯函数,方便单测)。 */
export function resolveSidebar(options: {
  stored: SidebarState | null
  tier: Tier
  overlay: boolean
  layout?: NavLayout
}): SidebarState {
  const base = options.stored ?? defaultSidebar(options)
  return options.overlay && base === 'expanded' ? 'rail' : base
}

/** ⌘B 的循环顺序:展开 → 图标栏 → 隐藏 → 展开。 */
export function nextInCycle(state: SidebarState): SidebarState {
  return state === 'expanded' ? 'rail' : state === 'rail' ? 'hidden' : 'expanded'
}

/** 拖动边缘松手时:按宽度吸附成哪一态(以及展开时记多宽)。 */
export function snapWidth(width: number): { state: SidebarState; width?: number } {
  if (width < SNAP_HIDE) return { state: 'hidden' }
  if (width < SNAP_RAIL) return { state: 'rail' }
  return { state: 'expanded', width: clampSidebarWidth(width) }
}

export const useNavStore = defineStore('nav', () => {
  const ui = useUiStore()
  const viewport = useViewport()
  /** 当前页面是不是文档工作台(自己带顶栏,全局顶栏让位)。由外壳按路由 meta 设置。 */
  const workbench = ref(false)
  /** 工作台在窄屏(手机 / 竖屏小平板)已经进入文档详情:此时文档自己的顶栏是唯一的顶栏,全局顶栏让位。由浏览器页设置。 */
  const workbenchDetail = ref(false)
  /** 外观设置的导航布局(由外壳同步进来)。 */
  const layout = ref<NavLayout>('sidebar')
  /** 浮层档位里,展开的导航是否正盖在内容上。临时状态,不持久化。 */
  const overlayOpen = ref(false)
  /** 正在拖动边缘时的实时宽度(px);不拖动时为 null。 */
  const dragWidth = ref<number | null>(null)

  /** 是否有侧栏(手机和竖屏小平板用底部标签栏,没有侧栏)。 */
  const hasSidebar = computed(() => viewport.navKind.value === 'sidebar' && layout.value !== 'topnav')
  const overlayTier = computed(() => viewport.overlayNav.value)

  const state = computed<SidebarState>(() =>
    resolveSidebar({
      stored: ui.sidebar,
      tier: viewport.tier.value,
      overlay: overlayTier.value,
      layout: layout.value,
    }),
  )
  /** 视觉上是不是「文字可见」:静态展开,或浮层展开中,或拖动到足够宽。 */
  const labelsVisible = computed(() => {
    if (overlayTier.value && overlayOpen.value) return true
    if (dragWidth.value !== null) return dragWidth.value >= SNAP_RAIL
    return state.value === 'expanded'
  })
  /** 侧栏占位宽度(px,浮层不占位)。 */
  const slotWidth = computed(() => {
    if (!hasSidebar.value) return 0
    if (dragWidth.value !== null) return Math.round(dragWidth.value)
    if (state.value === 'hidden') return 0
    return state.value === 'expanded' ? ui.sidebarWidth : RAIL_WIDTH
  })

  function set(next: SidebarState) {
    ui.setSidebar(next)
  }
  /** ⌘B。电脑上在三态间循环;浮层档位只开合浮层(不改偏好)。 */
  function cycle() {
    if (!hasSidebar.value) return
    if (overlayTier.value) {
      overlayOpen.value = !overlayOpen.value
      return
    }
    set(nextInCycle(state.value))
  }
  /** 顶栏上的按钮:隐藏或图标栏 → 展开;展开 → 图标栏。 */
  function toggle() {
    if (!hasSidebar.value) return
    if (overlayTier.value) {
      overlayOpen.value = !overlayOpen.value
      return
    }
    set(state.value === 'expanded' ? 'rail' : 'expanded')
  }
  /** 侧栏底部的「收起 / 展开」按钮:浮层展开时是「收回浮层」。 */
  function collapseOrExpand() {
    if (overlayTier.value) {
      overlayOpen.value = !overlayOpen.value
      return
    }
    set(state.value === 'expanded' ? 'rail' : 'expanded')
  }
  function closeOverlay() {
    overlayOpen.value = false
  }
  /** 拖动过程中的实时宽度(null 结束)。 */
  function dragTo(width: number | null) {
    dragWidth.value = width === null ? null : Math.max(0, Math.min(width, 420))
  }
  /** 松手:吸附并记住。 */
  function commitDrag(width: number) {
    dragWidth.value = null
    const snapped = snapWidth(width)
    if (snapped.width !== undefined) ui.setSidebarWidth(snapped.width)
    set(snapped.state)
  }

  return {
    workbench,
    workbenchDetail,
    layout,
    overlayOpen,
    dragWidth,
    hasSidebar,
    overlayTier,
    state,
    labelsVisible,
    slotWidth,
    cycle,
    toggle,
    collapseOrExpand,
    closeOverlay,
    dragTo,
    commitDrag,
  }
})
