/**
 * 页缩略图的公共类型与尺寸规则（补全）
 *
 * 缩略图来源有两种后端：只读预览是页面 DOM 的缩小克隆（`domThumbSource.ts`），画布编辑 / 高保真查看是引擎的位图
 * （`canvasThumbSource.ts`）。侧栏组件（`PageThumbnails.vue`）只认下面这个接口，所以两种后端换着用，栏的交互、
 * 键盘、滚动同步、生成队列完全共用一份。
 */

/** 栏的方向：宽屏是左侧纵栏，窄屏（手机）是文档下方的横条，不盖在正文上 */
export type ThumbOrientation = 'vertical' | 'horizontal'

/** 一张缩略图的盒子：CSS 像素尺寸 + 设备像素比（画布后端按它决定位图精度） */
export interface ThumbBox {
  width: number
  height: number
  dpr: number
}

export interface ThumbSource {
  /**
   * 生成第 `index` 页（0 起）的缩略图，返回一个可以直接挂进槽里的元素。
   * 元素必须自己撑满 `box`（槽不再套一层尺寸）；`signal` 中止表示这页不要了，尽快放弃。
   */
  render(index: number, box: ThumbBox, signal: AbortSignal): Promise<HTMLElement>
  /** 缩略图被淘汰 / 替换后释放资源（画布缩到 0×0 还内存；DOM 克隆不需要） */
  release?(artifact: HTMLElement): void
  /** 栏关闭 / 文档换了：释放来源占用的一切（引擎会话、定时器） */
  dispose?(): void
}

/** 纵栏里一张缩略图的宽度（与幻灯片目录一致） */
export const THUMB_WIDTH = 144
/** 横条里一张缩略图的高度 */
export const THUMB_STRIP_HEIGHT = 72
/** 没有量到页面尺寸时的宽高比：Letter（8.5×11） */
export const DEFAULT_ASPECT = 816 / 1056

/** 按页的宽高比和栏方向算缩略图盒子的 CSS 尺寸 */
export function thumbBoxFor(aspect: number, orientation: ThumbOrientation): { width: number; height: number } {
  const ratio = Number.isFinite(aspect) && aspect > 0.05 && aspect < 20 ? aspect : DEFAULT_ASPECT
  if (orientation === 'horizontal') return { width: Math.max(24, Math.round(THUMB_STRIP_HEIGHT * ratio)), height: THUMB_STRIP_HEIGHT }
  return { width: THUMB_WIDTH, height: Math.max(24, Math.round(THUMB_WIDTH / ratio)) }
}

/** 窄于这个宽度（容器宽，不是屏幕宽）就用横条：手机竖屏 390 → 横条，平板 / 桌面 → 纵栏 */
export const COMPACT_BELOW = 560
