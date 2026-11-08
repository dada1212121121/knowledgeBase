// 图表的纯计算:刻度、数字缩写、环形图的分段、折线路径、分桶、回落检测。
// 和组件分开,是为了能直接单测:图画对不对,先看数算对不对。

/** 把 0.5、12、1800 这类数字向上取整成 1 / 2 / 5 × 10^n,作为刻度步长。 */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1
  const base = Math.pow(10, Math.floor(Math.log10(raw)))
  return ([1, 2, 5, 10].map((multiple) => multiple * base).find((step) => step >= raw - 1e-12) ?? base * 10)
}

export interface NiceAxis {
  min: number
  max: number
  step: number
  ticks: number[]
}

/**
 * 给一组数据算出好看的纵轴:刻度是整齐的步长,上下各留出空隙,保证最高点不顶格、最低点不贴底。
 * `floor` / `ceil` 是硬边界(比例类指标不能画到 0 以下或 100% 以上)。
 */
export function niceAxis(low: number, high: number, count = 4, bounds: { floor?: number; ceil?: number } = {}): NiceAxis {
  let min = Math.min(low, high)
  let max = Math.max(low, high)
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0
    max = 1
  }
  if (max === min) {
    // 所有值一样:前后各拉开一点,不然整张图是一条贴边的线
    const pad = Math.abs(max) > 0 ? Math.abs(max) * 0.1 : 1
    min -= pad
    max += pad
  }
  const step = niceStep((max - min) / count)
  // 轴的上下界和刻度必须是同一组数:都先去掉浮点尾巴(0.6000000000000001),否则按轴缩放的位置和刻度线差一丝
  let axisMin = roundTo(Math.floor(min / step + 1e-9) * step, 10)
  let axisMax = roundTo(Math.ceil(max / step - 1e-9) * step, 10)
  if (bounds.floor !== undefined) axisMin = Math.max(bounds.floor, axisMin)
  if (bounds.ceil !== undefined) axisMax = Math.min(bounds.ceil, axisMax)
  if (axisMax <= axisMin) axisMax = axisMin + step
  const ticks: number[] = []
  // 用索引乘步长而不是不停累加,避免 0.1 + 0.2 这类浮点误差让刻度变成 0.30000000000000004
  for (let index = 0; axisMin + index * step <= axisMax + step * 1e-9; index += 1) ticks.push(roundTo(axisMin + index * step, 10))
  return { min: axisMin, max: axisMax, step, ticks }
}

function roundTo(value: number, digits: number): number {
  const factor = Math.pow(10, digits)
  return Math.round(value * factor) / factor
}

/** 1234 → 1,234;12 345 → 1.2 万;123 456 789 → 1.2 亿。去掉没用的 .0。 */
export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  const trim = (n: number) => String(Math.round(n * 10) / 10)
  if (abs >= 1e8) return `${trim(value / 1e8)} 亿`
  if (abs >= 1e4) return `${trim(value / 1e4)} 万`
  return Number.isInteger(value) ? value.toLocaleString('en-US') : trim(value)
}

/** 占比文字:不足 1% 写 `<1%`(有数据却显示 0% 会让人以为没统计到);总数为 0 写 `0%`。 */
export function shareText(value: number, total: number): string {
  if (!(total > 0) || !(value > 0)) return '0%'
  const percent = (value / total) * 100
  return percent < 1 ? '<1%' : `${Math.round(percent)}%`
}

export interface DonutArc {
  index: number
  value: number
  fraction: number
  /** stroke-dasharray 的两个数:画出来的弧长、空白长度 */
  dash: number
  gap: number
  /** stroke-dashoffset:负数 = 从圆周上这一段的起点开始画 */
  offset: number
}

/**
 * 把一组数拆成环形图的弧。
 * 用 stroke-dasharray 画弧(比算 SVG 弧线路径简单,也不会有大弧 / 小弧标志位的坑);
 * 相邻两段之间留 `gap` 的缝,让色块不靠颜色也能分开。只有一段时不留缝(留了就成了一个缺口)。
 * 值为 0 或负数的项不画,但保留 index,调用方可以和图例对上号。
 */
export function donutArcs(values: number[], circumference: number, gap = 2): DonutArc[] {
  const clean = values.map((value) => (Number.isFinite(value) && value > 0 ? value : 0))
  const total = clean.reduce((sum, value) => sum + value, 0)
  if (!(total > 0)) return []
  const drawn = clean.filter((value) => value > 0).length
  const seam = drawn > 1 ? gap : 0
  const arcs: DonutArc[] = []
  let walked = 0
  clean.forEach((value, index) => {
    if (value <= 0) return
    const length = (value / total) * circumference
    const dash = Math.max(0.01, length - seam)
    arcs.push({ index, value, fraction: value / total, dash, gap: circumference - dash, offset: -walked })
    walked += length
  })
  return arcs
}

export interface Pt {
  x: number
  y: number
}

/** 折线路径。遇到 null(这一点没有数据)就断开,不把两边连起来冒充连续。 */
export function linePath(points: (Pt | null)[]): string {
  let path = ''
  let pen = false
  for (const point of points) {
    if (!point) {
      pen = false
      continue
    }
    path += `${pen ? 'L' : 'M'}${round2(point.x)},${round2(point.y)}`
    pen = true
  }
  return path
}

/** 折线下的面积路径,按连续的段分别闭合到 `baseline`。 */
export function areaPath(points: (Pt | null)[], baseline: number): string {
  const runs: Pt[][] = []
  let current: Pt[] = []
  for (const point of points) {
    if (point) current.push(point)
    else if (current.length) {
      runs.push(current)
      current = []
    }
  }
  if (current.length) runs.push(current)
  return runs
    .filter((run) => run.length > 1)
    .map((run) => `${linePath(run)}L${round2(run[run.length - 1]!.x)},${round2(baseline)}L${round2(run[0]!.x)},${round2(baseline)}Z`)
    .join('')
}

const round2 = (value: number) => Math.round(value * 100) / 100

/**
 * 两条线之间的带状面积(堆叠面积图里每一层):上沿用 `top`,下沿用 `bottom` 倒着走回来再闭合。
 * 两边在同一个下标上都有点才画;缺点处断开成多段(堆叠时缺的值按 0 算,所以正常情况不会断)。
 */
export function bandPath(top: (Pt | null)[], bottom: (Pt | null)[]): string {
  const runs: { top: Pt; bottom: Pt }[][] = []
  let current: { top: Pt; bottom: Pt }[] = []
  top.forEach((upper, index) => {
    const lower = bottom[index]
    if (upper && lower) current.push({ top: upper, bottom: lower })
    else if (current.length) {
      runs.push(current)
      current = []
    }
  })
  if (current.length) runs.push(current)
  return runs
    .filter((run) => run.length > 1)
    .map((run) => {
      const forward = run.map((pair, at) => `${at === 0 ? 'M' : 'L'}${round2(pair.top.x)},${round2(pair.top.y)}`).join('')
      const back = [...run].reverse().map((pair) => `L${round2(pair.bottom.x)},${round2(pair.bottom.y)}`).join('')
      return `${forward}${back}Z`
    })
    .join('')
}

/**
 * 堆叠:每个下标上把各序列的值累加。缺的值(null / undefined / 非数)按 0 算,否则一层缺了数据整根柱子 / 整片面积都会断。
 * 返回每层的累计值:`result[i][k]` 是前 i+1 层在第 k 期的合计。负数不堆叠(当 0),监控类指标没有负数。
 */
export function stackValues(series: (number | null | undefined)[][]): number[][] {
  const length = Math.max(0, ...series.map((values) => values.length))
  const out: number[][] = []
  let running: number[] = Array.from({ length }, () => 0)
  for (const values of series) {
    running = running.map((sum, at) => {
      const value = values[at]
      return sum + (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
    })
    out.push(running)
  }
  return out
}

/**
 * 回落检测:返回比前一个有效值低了超过 `tolerance` 的位置。
 * 评测指标要看「这次改动有没有变差」,小幅波动(样本只有几十条,差一条就是 2 个百分点)不算。
 */
export function dropIndices(values: (number | null)[], tolerance: number): number[] {
  const out: number[] = []
  let previous: number | null = null
  values.forEach((value, index) => {
    if (value === null || value === undefined) return
    if (previous !== null && previous - value > tolerance + 1e-12) out.push(index)
    previous = value
  })
  return out
}

export type MarkerShape = 'circle' | 'square' | 'diamond' | 'triangle'
const SHAPES: MarkerShape[] = ['circle', 'square', 'diamond', 'triangle']

/** 第 i 条线用什么形状的点:除了颜色,形状也能区分各条线(色觉差异的人、黑白打印都分得开)。 */
export const markerShape = (index: number): MarkerShape => SHAPES[((index % SHAPES.length) + SHAPES.length) % SHAPES.length]!

/** 点的 SVG 路径。统一用 path,折线上的点、图例、提示气泡里的小标记画的是同一个形状。 */
export function markerPath(shape: MarkerShape, cx: number, cy: number, r: number): string {
  const n = round2
  switch (shape) {
    case 'square':
      return `M${n(cx - r)},${n(cy - r)}h${n(2 * r)}v${n(2 * r)}h${n(-2 * r)}Z`
    case 'diamond':
      return `M${n(cx)},${n(cy - r * 1.25)}L${n(cx + r * 1.25)},${n(cy)}L${n(cx)},${n(cy + r * 1.25)}L${n(cx - r * 1.25)},${n(cy)}Z`
    case 'triangle':
      return `M${n(cx)},${n(cy - r * 1.15)}L${n(cx + r * 1.15)},${n(cy + r * 0.85)}L${n(cx - r * 1.15)},${n(cy + r * 0.85)}Z`
    default:
      return `M${n(cx - r)},${n(cy)}a${n(r)},${n(r)} 0 1,0 ${n(2 * r)},0a${n(r)},${n(r)} 0 1,0 ${n(-2 * r)},0Z`
  }
}

export interface Bucket {
  label: string
  count: number
}

/**
 * 按上界分桶:`edges` 是升序的上界(含),最后一个桶收所有更大的值。
 * 例如 edges=[10,60] labels=['≤10','10–60','>60']。
 */
export function bucketize(values: number[], edges: number[], labels: string[]): Bucket[] {
  const counts = labels.map(() => 0)
  for (const value of values) {
    if (!Number.isFinite(value)) continue
    const at = edges.findIndex((edge) => value <= edge)
    counts[at === -1 ? labels.length - 1 : at] = (counts[at === -1 ? labels.length - 1 : at] ?? 0) + 1
  }
  return labels.map((label, index) => ({ label, count: counts[index] ?? 0 }))
}
