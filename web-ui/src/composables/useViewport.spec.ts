// 五档断点:边界值必须与 CSS 里的 @media 一致(599/600、839/840、1279/1280、1919/1920)。
import { describe, expect, it, vi } from 'vitest'
import { TIER_MIN, TIER_QUERY, remeasureViewport, tierOfWidth, useViewport } from './useViewport'

describe('tierOfWidth', () => {
  it.each([
    [320, 'phone'],
    [599, 'phone'],
    [600, 'fold'],
    [839, 'fold'],
    [840, 'tablet'],
    [1279, 'tablet'],
    [1280, 'desktop'],
    [1919, 'desktop'],
    [1920, 'wide'],
    [2560, 'wide'],
  ])('%ipx → %s', (width, tier) => {
    expect(tierOfWidth(width)).toBe(tier)
  })

  it('下界表和媒体查询字符串互相对得上', () => {
    expect(TIER_MIN).toEqual({ phone: 0, fold: 600, tablet: 840, desktop: 1280, wide: 1920 })
    expect(TIER_QUERY.phone).toContain('599px')
    expect(TIER_QUERY.fold).toContain('600px')
    expect(TIER_QUERY.fold).toContain('839px')
    expect(TIER_QUERY.tablet).toContain('840px')
    expect(TIER_QUERY.tablet).toContain('1279px')
    expect(TIER_QUERY.desktop).toContain('1280px')
    expect(TIER_QUERY.desktop).toContain('1919px')
    expect(TIER_QUERY.wide).toContain('1920px')
  })
})

describe('useViewport', () => {
  function at(width: number, height: number) {
    vi.stubGlobal('innerWidth', width)
    vi.stubGlobal('innerHeight', height)
    remeasureViewport()
    return useViewport()
  }

  it('把档位写到 <html data-bp>,供 CSS 与测试使用', () => {
    at(1440, 900)
    expect(document.documentElement.dataset.bp).toBe('desktop')
    at(700, 900)
    expect(document.documentElement.dataset.bp).toBe('fold')
  })

  it('600–1279 的侧栏展开是浮层;电脑不是', () => {
    expect(at(1000, 1300).overlayNav.value).toBe(true)
    expect(at(1279, 800).overlayNav.value).toBe(true)
    expect(at(1280, 800).overlayNav.value).toBe(false)
    expect(at(1920, 1080).overlayNav.value).toBe(false)
  })

  it('手机没有侧栏', () => {
    expect(at(390, 844).navKind.value).toBe('tabbar')
    expect(at(1440, 900).navKind.value).toBe('sidebar')
  })
})
