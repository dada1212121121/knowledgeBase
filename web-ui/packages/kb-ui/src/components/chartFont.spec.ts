import { describe, expect, it } from 'vitest'
import { AXIS_ANCHOR, MAX_UNITS, MIN_UNITS, TARGET_PX, axisAnchor, axisFontSize } from './chartFont'

describe('axisFontSize', () => {
  it('宽屏不动:渲染后本来就 ≥ 11px(缩放 ≥ 1.1)时保持原来的 10', () => {
    expect(axisFontSize(1.1)).toBe(MIN_UNITS)
    expect(axisFontSize(1.19)).toBe(MIN_UNITS)
    expect(axisFontSize(2)).toBe(MIN_UNITS)
  })

  it('缩放刚好是 1 时,10 渲染出来只有 10px,低于目标,所以放大到 11', () => {
    expect(axisFontSize(1)).toBe(TARGET_PX)
  })

  it('手机:放大到渲染后约 11px(390 宽缩放 0.58 → 渲染 ≈ 11)', () => {
    const units = axisFontSize(0.58)
    expect(units * 0.58).toBeGreaterThanOrEqual(TARGET_PX - 0.01)
    expect(units).toBeGreaterThan(MIN_UNITS)
  })

  it('平板竖屏(缩放 0.63)也够 11px', () => {
    expect(axisFontSize(0.63) * 0.63).toBeGreaterThanOrEqual(TARGET_PX - 0.01)
  })

  it('有上限,免得相邻柱的日期标签挤到一起', () => {
    expect(axisFontSize(0.2)).toBe(MAX_UNITS)
    // 上限意味着极窄屏渲染后会略小于目标,这是有意的取舍
    expect(axisFontSize(0.4) * 0.4).toBeLessThan(TARGET_PX)
  })

  it('量不到比例(未挂载 / 0 / NaN / 负数):按原来的 10,不炸', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(axisFontSize(bad)).toBe(MIN_UNITS)
  })
})

describe('axisAnchor', () => {
  it('字号没变大、刻度短:保持默认位置', () => {
    expect(axisAnchor(10, 1, 46)).toBe(AXIS_ANCHOR)
    expect(axisAnchor(10, 3, 46)).toBe(AXIS_ANCHOR)
  })

  it('字号放大后最宽刻度(1.5,3 个字符)要右移,才不被左边界裁掉', () => {
    // 390 宽手机:字号 ≈ 19,3 个字符约 34 个图内单位,默认 22 放不下
    const anchor = axisAnchor(19, 3, 46)
    expect(anchor).toBeGreaterThan(AXIS_ANCHOR)
    expect(anchor).toBeGreaterThanOrEqual(3 * 0.6 * 19)
  })

  it('不能越过上限(第一根柱的起点):宁可略微出界也不压到柱子上', () => {
    expect(axisAnchor(22, 8, 46)).toBe(46)
  })
})
