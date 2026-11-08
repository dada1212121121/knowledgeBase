// 手机上的编辑器（设计规范）:工具栏什么时候贴键盘、斜杠菜单 / `[[` 选择器什么时候走底部面板、
// 光标要滚多少才不被键盘和工具栏盖住。纯函数,不碰 DOM,边界在 editorMobile.spec.ts。

/** 视口宽度小于它算手机(与 kb-ui 的 PHONE_QUERY 一致) */
export const PHONE_MAX_WIDTH = 600
/** 屏幕短边小于它的设备是手机:横屏时视口宽 ≥ 600,但软键盘一弹出来可视高度只剩一小半,同样要把工具栏贴在键盘上 */
export const PHONE_SCREEN_SHORT_SIDE = 500
/** 光标与工具栏 / 视口边缘之间留的空隙(px) */
export const DOCK_GAP = 8
/** ProseMirror 自己的默认滚动余量(px) */
export const DEFAULT_SCROLL_MARGIN = 5

export interface DockEnv {
  /** 软键盘是否打开(useVisualViewport 的 keyboardState.open) */
  keyboardOpen: boolean
  /** 视口宽度(CSS px) */
  width: number
  /** 屏幕短边(CSS px,min(screen.width, screen.height));没有 screen 就传 Infinity */
  screenShortSide: number
}

/**
 * 工具栏是否贴在键盘上沿。
 * 只在软键盘真的打开时才贴:键盘收起时回到顶部的粘性工具栏(不占底部、不盖标签栏)。
 * 平板(视口宽 ≥ 600 且屏幕短边 ≥ 500)保持现状,哪怕安卓平板横屏时软键盘把布局视口压到 500 以下也一样。
 */
export function shouldDockToolbar(env: DockEnv): boolean {
  if (!env.keyboardOpen) return false
  return env.width < PHONE_MAX_WIDTH || env.screenShortSide < PHONE_SCREEN_SHORT_SIDE
}

/**
 * 斜杠菜单 / `[[` 选择器是否改成贴键盘的底部面板(否则是跟着光标的浮层)。
 * 手机宽度,或主要输入是触屏(平板的软键盘同样会盖住光标下方的浮层)。
 */
export function menusAsSheet(env: { width: number; coarse: boolean }): boolean {
  return env.width < PHONE_MAX_WIDTH || env.coarse
}

/** 贴键盘的工具栏盖住了底部多少像素(写进 --kbd-reserve,让光标滚动和底部面板避开它);没贴就是 0 */
export function bottomReserve(input: { docked: boolean; barHeight: number }): number {
  return input.docked ? Math.max(0, Math.round(input.barHeight)) : 0
}

/** ProseMirror 滚动光标时底部要多留的余量:要把工具栏盖住的那一截加上 */
export function scrollMarginBottom(reserve: number): number {
  return reserve > 0 ? reserve + DOCK_GAP : DEFAULT_SCROLL_MARGIN
}

export interface CaretScrollInput {
  /** 光标所在行的矩形(视口坐标) */
  caret: { top: number; bottom: number }
  /** 可滚动区域可见范围的上沿 */
  viewTop: number
  /** 可见范围的下沿(已经扣掉软键盘) */
  viewBottom: number
  /** 贴在键盘上的工具栏等盖住的高度 */
  reserveBottom: number
  /** 光标与上下沿之间留的空隙 */
  margin?: number
}

/**
 * 光标要往下滚多少像素才完整落在可见区里(正数 = 内容往上走;0 = 已经看得见)。
 * 可见区 = [viewTop + margin, viewBottom − reserveBottom − margin];超出就把光标行放到可见区正中,
 * 键盘刚弹出时光标常常恰好在键盘后面,居中比刚好露出一行更稳(再打几个字也不用马上又滚)。
 * 光标行比可见区还高(横屏键盘弹出后只剩一两行)时,让光标行的上沿对齐可见区上沿,至少能看到这一行的开头。
 */
export function caretScrollDelta(input: CaretScrollInput): number {
  const margin = input.margin ?? DOCK_GAP
  const top = input.viewTop + margin
  const bottom = input.viewBottom - Math.max(0, input.reserveBottom) - margin
  const { caret } = input
  const inside = caret.top >= top && caret.bottom <= bottom
  if (inside) return 0
  const band = bottom - top
  if (band <= 0) return 0
  if (caret.bottom - caret.top >= band) return Math.round(caret.top - top)
  const caretMid = (caret.top + caret.bottom) / 2
  return Math.round(caretMid - (top + bottom) / 2)
}
