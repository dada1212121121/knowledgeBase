// 图表坐标轴文字的字号。
//
// 堆叠柱图是一张 viewBox 560×190 的 SVG,width=100%:容器越窄,整张图被缩得越小,里面写死 font-size=10 的文字也跟着缩。
// 390 宽的手机上图只有 324px 宽(缩放 0.58),文字实际只有约 5.8px,读不了。sweep / clipcheck 查的是溢出和被裁,查不出这个。
//
// 做法:量出实际缩放比例 scale(渲染宽度 / viewBox 宽度),把图内字号放大到渲染后约等于 TARGET_PX。
// 上限 MAX_UNITS 是为了不互相挤——7 根柱,柱距 74 个图内单位,日期标签最多 5 个字符(如「10-15」),字号超过约 22 就会碰到邻居。
// 所以极窄的屏幕(缩放小于 TARGET_PX / MAX_UNITS ≈ 0.5)渲染后会略小于目标,不会再放大;这是有意的取舍,不是遗漏。

/** 渲染后希望的最小像素字号 */
export const TARGET_PX = 11
/** 图内单位字号的下限:宽屏缩放 ≥ 1 时保持原来的 10 */
export const MIN_UNITS = 10
/** 图内单位字号的上限:再大相邻两根柱的日期标签会挤到一起 */
export const MAX_UNITS = 22

/** scale = 渲染宽度 / viewBox 宽度。拿不到(0、NaN、未挂载)时按原来的 10。 */
export function axisFontSize(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return MIN_UNITS
  return Math.min(MAX_UNITS, Math.max(MIN_UNITS, TARGET_PX / scale))
}

/** 一个半角字符的大致宽度占字号的比例(数字、小数点、逗号;不是中文) */
const CHAR_EM = 0.6
/** 纵轴刻度文字右对齐的默认位置(图内单位)。字号没变大时就是它 */
export const AXIS_ANCHOR = 22

/**
 * 纵轴刻度右对齐的位置。字号放大后,最宽的刻度(例如 1.5)向左伸出去会被 SVG 边界裁掉,所以把右对齐的位置按需右移。
 * limit 是不能越过的位置(第一根柱的起点再留点空隙):宁可略微出界,也不压到柱子上。
 */
export function axisAnchor(fontSize: number, longestTick: number, limit: number): number {
  const needed = longestTick * CHAR_EM * fontSize + 1
  return Math.min(limit, Math.max(AXIS_ANCHOR, needed))
}
