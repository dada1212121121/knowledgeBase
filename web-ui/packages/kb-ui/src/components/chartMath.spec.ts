// 图表计算:刻度要整齐且不顶格、环形图的弧要首尾相接、折线遇到缺数据要断开、回落检测不被小波动惊动。
import { describe, expect, it } from 'vitest'
import { areaPath, bandPath, bucketize, compactNumber, donutArcs, dropIndices, linePath, markerPath, markerShape, niceAxis, niceStep, shareText, stackValues } from './chartMath'

describe('niceStep / niceAxis', () => {
  it('步长只取 1 / 2 / 5 × 10^n', () => {
    expect(niceStep(0.7)).toBe(1)
    expect(niceStep(1.2)).toBe(2)
    expect(niceStep(2.6)).toBe(5)
    expect(niceStep(7)).toBe(10)
    expect(niceStep(0.03)).toBeCloseTo(0.05)
    expect(niceStep(0)).toBe(1)
    expect(niceStep(Number.NaN)).toBe(1)
  })

  it('最高点不顶格、最低点不贴底,刻度整齐', () => {
    const axis = niceAxis(0.62, 0.98, 4)
    expect(axis.min).toBeLessThanOrEqual(0.62)
    expect(axis.max).toBeGreaterThanOrEqual(0.98)
    expect(axis.ticks[0]).toBe(axis.min)
    expect(axis.ticks.at(-1)).toBe(axis.max)
    // 没有 0.30000000000000004 这类浮点尾巴
    expect(axis.ticks.every((tick) => Number(tick.toFixed(10)) === tick)).toBe(true)
  })

  it('比例类指标可以用硬边界:不画到 0 以下、100% 以上', () => {
    const axis = niceAxis(0.95, 0.999, 4, { floor: 0, ceil: 1 })
    expect(axis.max).toBeLessThanOrEqual(1)
    expect(axis.min).toBeGreaterThanOrEqual(0)
  })

  it('所有值一样时前后拉开,不会画成一条贴边的线', () => {
    const axis = niceAxis(5, 5)
    expect(axis.max).toBeGreaterThan(axis.min)
    expect(axis.min).toBeLessThan(5)
    expect(axis.max).toBeGreaterThan(5)
  })

  it('全是 0 也能给出可用的轴', () => {
    const axis = niceAxis(0, 0)
    expect(axis.max).toBeGreaterThan(axis.min)
    expect(axis.ticks.length).toBeGreaterThan(1)
  })

  it('非有限数退回 0–1', () => {
    const axis = niceAxis(Number.NaN, Number.POSITIVE_INFINITY)
    expect(axis.min).toBe(0)
    expect(axis.max).toBeGreaterThanOrEqual(1)
  })
})

describe('compactNumber / shareText', () => {
  it('千位分隔、万、亿,去掉多余的 .0', () => {
    expect(compactNumber(999)).toBe('999')
    expect(compactNumber(1234)).toBe('1,234')
    expect(compactNumber(12000)).toBe('1.2 万')
    expect(compactNumber(20000)).toBe('2 万')
    expect(compactNumber(123456789)).toBe('1.2 亿')
    expect(compactNumber(Number.NaN)).toBe('—')
  })

  it('占比:不足 1% 写 <1%,总数为 0 不除零', () => {
    expect(shareText(1, 1000)).toBe('<1%')
    expect(shareText(50, 200)).toBe('25%')
    expect(shareText(0, 100)).toBe('0%')
    expect(shareText(5, 0)).toBe('0%')
  })
})

describe('donutArcs', () => {
  const C = 100

  it('各段弧长加缝等于周长,首尾相接', () => {
    const arcs = donutArcs([1, 1, 2], C, 2)
    expect(arcs).toHaveLength(3)
    // 画出来的弧长 + 缝 = 这一段占的周长
    expect(arcs[0]!.dash + 2).toBeCloseTo(25)
    expect(arcs[2]!.dash + 2).toBeCloseTo(50)
    // 偏移量依次累加,第一段从 0 开始
    expect(arcs[0]!.offset).toBeCloseTo(0)
    expect(arcs[1]!.offset).toBeCloseTo(-25)
    expect(arcs[2]!.offset).toBeCloseTo(-50)
    expect(arcs.reduce((sum, arc) => sum + arc.fraction, 0)).toBeCloseTo(1)
  })

  it('只有一段不留缝(留了会在圆环上咬出一个缺口)', () => {
    const [only] = donutArcs([0, 7, 0], C, 2)
    expect(only!.dash).toBeCloseTo(C)
    expect(only!.index).toBe(1)
  })

  it('值为 0、负数、NaN 的项不画,其余照常;index 仍指向原位置(和图例对得上)', () => {
    const arcs = donutArcs([3, 0, -1, Number.NaN, 3], C, 0)
    expect(arcs.map((arc) => arc.index)).toEqual([0, 4])
    expect(arcs[0]!.fraction).toBeCloseTo(0.5)
  })

  it('全是 0 返回空,不除以 0', () => {
    expect(donutArcs([0, 0], C)).toEqual([])
    expect(donutArcs([], C)).toEqual([])
  })

  it('很小的一段也至少有一点点弧长,不会消失', () => {
    const arcs = donutArcs([1, 100000], C, 2)
    expect(arcs[0]!.dash).toBeGreaterThan(0)
  })
})

describe('linePath / areaPath', () => {
  it('连续的点连成一条线', () => {
    expect(linePath([{ x: 0, y: 10 }, { x: 5, y: 4 }, { x: 10, y: 6 }])).toBe('M0,10L5,4L10,6')
  })

  it('遇到缺数据的点断开,后面重新起笔(不把两边连起来冒充连续)', () => {
    const path = linePath([{ x: 0, y: 1 }, { x: 1, y: 2 }, null, { x: 3, y: 3 }, { x: 4, y: 4 }])
    expect(path).toBe('M0,1L1,2M3,3L4,4')
  })

  it('全是缺数据返回空串', () => {
    expect(linePath([null, null])).toBe('')
  })

  it('面积按连续段分别闭合到基线;单个孤点没有面积', () => {
    const area = areaPath([{ x: 0, y: 5 }, { x: 2, y: 3 }, null, { x: 6, y: 4 }], 10)
    expect(area).toBe('M0,5L2,3L2,10L0,10Z')
  })
})

describe('dropIndices', () => {
  it('只标出比前一个低、且超过容差的点', () => {
    expect(dropIndices([0.9, 0.95, 0.9, 0.92], 0.02)).toEqual([2])
  })

  it('小幅波动不算(样本只有几十条,差一条就是 2 个点)', () => {
    expect(dropIndices([0.9, 0.89, 0.9, 0.885], 0.02)).toEqual([])
  })

  it('缺数据的点跳过,和它前面最近的有效值比', () => {
    expect(dropIndices([0.9, null, 0.8], 0.02)).toEqual([2])
  })

  it('刚好等于容差不算回落', () => {
    expect(dropIndices([0.5, 0.4], 0.1)).toEqual([])
  })

  it('第一个点没有可比的,永远不标', () => {
    expect(dropIndices([0.1], 0)).toEqual([])
  })
})

describe('markerShape / markerPath', () => {
  it('前四条线形状各不相同,第五条起循环', () => {
    expect([0, 1, 2, 3].map(markerShape)).toEqual(['circle', 'square', 'diamond', 'triangle'])
    expect(markerShape(4)).toBe('circle')
    expect(markerShape(-1)).toBe('triangle')
  })

  it('四种形状的路径互不相同,且都以所给坐标为中心', () => {
    const paths = (['circle', 'square', 'diamond', 'triangle'] as const).map((shape) => markerPath(shape, 10, 20, 4))
    expect(new Set(paths).size).toBe(4)
    expect(markerPath('square', 10, 20, 4)).toBe('M6,16h8v8h-8Z')
    expect(markerPath('circle', 10, 20, 4)).toContain('M6,20')
  })
})

describe('bucketize', () => {
  it('按上界(含)分桶,超过最后一个上界的进最后一桶', () => {
    const buckets = bucketize([1, 10, 11, 60, 61, 500], [10, 60], ['≤10', '11–60', '>60'])
    expect(buckets.map((bucket) => bucket.count)).toEqual([2, 2, 2])
    expect(buckets.map((bucket) => bucket.label)).toEqual(['≤10', '11–60', '>60'])
  })

  it('没有数据每桶都是 0,桶不会消失(图的横轴要稳定)', () => {
    expect(bucketize([], [10], ['a', 'b']).map((bucket) => bucket.count)).toEqual([0, 0])
  })

  it('非有限数忽略', () => {
    expect(bucketize([Number.NaN, 5], [10], ['a', 'b']).map((bucket) => bucket.count)).toEqual([1, 0])
  })
})

describe('stackValues / bandPath', () => {
  it('逐层累加;缺的值和负数按 0 算,不让一层缺数据把整片面积断开', () => {
    expect(stackValues([[1, 2, 3], [4, null, 6], [undefined, 5, -9]])).toEqual([
      [1, 2, 3],
      [5, 2, 9],
      [5, 7, 9],
    ])
    expect(stackValues([])).toEqual([])
  })
  it('长度不一的序列按最长的算', () => {
    expect(stackValues([[1], [1, 2, 3]])).toEqual([
      [1, 0, 0],
      [2, 2, 3],
    ])
  })
  it('带状面积:上沿正着走、下沿倒着走再闭合;只有一个点的段不画;缺点处断开', () => {
    const top = [{ x: 0, y: 10 }, { x: 10, y: 8 }, null, { x: 30, y: 5 }]
    const bottom = [{ x: 0, y: 20 }, { x: 10, y: 20 }, { x: 20, y: 20 }, { x: 30, y: 20 }]
    expect(bandPath(top, bottom)).toBe('M0,10L10,8L10,20L0,20Z')
    expect(bandPath([{ x: 0, y: 1 }], [{ x: 0, y: 2 }])).toBe('')
  })
})
