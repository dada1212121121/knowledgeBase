/**
 * 幻灯片缩放的纯函数
 *
 * `scale` 的含义：画布的 CSS 宽度 = 幻灯片逻辑宽度 × scale。
 * 单独成文件是为了不依赖 DOM 就能测「适应页面 / 步进 / 夹取」，视图只负责量容器。
 */

/** 缩放下限：手机宽度（约 350px）下 1280px 宽的幻灯片适应宽度只有 0.25，再小就看不清了 */
export const MIN_ZOOM = 0.2
export const MAX_ZOOM = 4
/** 适应页面时最多放大到 2 倍：大屏上把 1280px 的页拉到 4K 宽只会糊 */
export const FIT_CAP = 2
/** 菜单式步进档位（和 PowerPoint 的常用档一致） */
export const ZOOM_STEPS: readonly number[] = [0.2, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4]

export type FitMode = 'page' | 'width'

export interface Box {
  width: number
  height: number
}

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value))
}

/**
 * 适应容器的缩放：`page` 整页都看得见，`width` 只保证宽度放得下（竖向滚动）。
 * `padding` 是容器四周留白（CSS px），容器还没量出来（0 尺寸）时回到 1，避免出现 Infinity / 0。
 * `cap` 是放大上限：普通视图 2 倍，放映时放开到 MAX_ZOOM。
 */
export function fitScale(viewport: Box, slide: Box, mode: FitMode = 'page', padding = 16, cap = FIT_CAP): number {
  if (slide.width <= 0 || slide.height <= 0) return 1
  const w = viewport.width - padding * 2
  const h = viewport.height - padding * 2
  if (w <= 0 || h <= 0) return 1
  const byWidth = w / slide.width
  const value = mode === 'width' ? byWidth : Math.min(byWidth, h / slide.height)
  return Math.min(cap, clampZoom(value))
}

/** 按档位放大 / 缩小一步：从当前值出发取最近的下一档，而不是固定乘一个系数（来回点能回到整数档） */
export function stepZoom(current: number, direction: 1 | -1): number {
  const value = clampZoom(current)
  if (direction > 0) {
    const next = ZOOM_STEPS.find((step) => step > value + 0.005)
    return next ?? MAX_ZOOM
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i -= 1) {
    if (ZOOM_STEPS[i]! < value - 0.005) return ZOOM_STEPS[i]!
  }
  return MIN_ZOOM
}

/** 画布的 CSS 像素尺寸（取整，避免亚像素让相邻的画布边缘出现缝） */
export function cssSize(slide: Box, scale: number): Box {
  return { width: Math.round(slide.width * scale), height: Math.round(slide.height * scale) }
}

/**
 * 画布的物理像素尺寸，**向下取整**并按幻灯片宽高比推算高度。
 * 引擎的 `sizeCanvasForSlide` 向上取整，会让最后一行 / 一列只被幻灯片背景盖住一部分，露出底下的白色，
 * 画面边缘出现一条发亮的细线（深色背景的 deck 上很显眼）。向下取整 + `paintScale` 配套，保证每个像素都被完整覆盖。
 */
export function pixelSize(slide: Box, scale: number, dpr: number): Box {
  const width = Math.max(1, Math.floor(slide.width * scale * dpr))
  const height = slide.width > 0 ? Math.floor((width * slide.height) / slide.width) : width
  return { width, height: Math.max(1, height) }
}

/** 配合 `pixelSize` 实际交给 `frame.paint` 的缩放：让幻灯片宽度正好等于位图宽度（整数像素） */
export function paintScale(slide: Box, scale: number, dpr: number): number {
  if (slide.width <= 0) return scale
  return pixelSize(slide, scale, dpr).width / (slide.width * dpr)
}
