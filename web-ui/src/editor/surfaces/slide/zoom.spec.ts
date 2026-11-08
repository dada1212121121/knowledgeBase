import { describe, expect, it } from 'vitest'
import { FIT_CAP, MAX_ZOOM, MIN_ZOOM, ZOOM_STEPS, clampZoom, cssSize, fitScale, paintScale, pixelSize, stepZoom } from './zoom'

const SLIDE = { width: 1280, height: 720 }

describe('幻灯片缩放', () => {
  it('clampZoom 夹在上下限内，非法值回到 1', () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM)
    expect(clampZoom(99)).toBe(MAX_ZOOM)
    expect(clampZoom(1.5)).toBe(1.5)
    expect(clampZoom(Number.NaN)).toBe(1)
    expect(clampZoom(Infinity)).toBe(1)
  })

  it('适应页面取宽高里更紧的那个，适应宽度只看宽', () => {
    // 视口 1000×400：宽度比例 0.75，高度比例 0.5 → 整页放得下要用 0.5
    const viewport = { width: 1000 + 32, height: 400 + 32 }
    expect(fitScale(viewport, SLIDE, 'page')).toBeCloseTo(400 / 720, 5)
    expect(fitScale(viewport, SLIDE, 'width')).toBeCloseTo(1000 / 1280, 5)
  })

  it('适应页面最多放大到 FIT_CAP；放映可以放开上限', () => {
    expect(fitScale({ width: 9000, height: 9000 }, SLIDE, 'page')).toBe(FIT_CAP)
    expect(fitScale({ width: 9000, height: 9000 }, SLIDE, 'page', 0, MAX_ZOOM)).toBe(MAX_ZOOM)
    expect(fitScale({ width: 2560, height: 1440 }, SLIDE, 'page', 0, MAX_ZOOM)).toBe(2)
  })

  it('容器还没量出尺寸（0）时不产生 0 / Infinity', () => {
    expect(fitScale({ width: 0, height: 0 }, SLIDE)).toBe(1)
    expect(fitScale({ width: 20, height: 20 }, SLIDE, 'page', 16)).toBe(1)
    expect(fitScale({ width: 500, height: 500 }, { width: 0, height: 0 })).toBe(1)
  })

  it('手机宽度（390）下适应页面不小于下限', () => {
    const scale = fitScale({ width: 390, height: 600 }, SLIDE, 'page', 8)
    expect(scale).toBeGreaterThanOrEqual(MIN_ZOOM)
    expect(scale).toBeCloseTo((390 - 16) / 1280, 5)
  })

  it('步进沿档位走，来回点能回到原档位', () => {
    expect(stepZoom(1, 1)).toBe(1.25)
    expect(stepZoom(1.25, -1)).toBe(1)
    expect(stepZoom(0.43, 1)).toBe(0.5)
    expect(stepZoom(0.43, -1)).toBe(0.33)
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM)
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM)
    for (const step of ZOOM_STEPS) expect(stepZoom(stepZoom(step, 1), -1)).toBe(step === MAX_ZOOM ? ZOOM_STEPS.at(-2) : step)
  })

  it('CSS 尺寸四舍五入；物理像素向下取整并按宽高比推高度（保证每个像素被完整覆盖）', () => {
    expect(cssSize(SLIDE, 0.333)).toEqual({ width: 426, height: 240 })
    expect(pixelSize(SLIDE, 0.333, 2)).toEqual({ width: Math.floor(1280 * 0.333 * 2), height: Math.floor((Math.floor(1280 * 0.333 * 2) * 720) / 1280) })
    expect(pixelSize({ width: 1, height: 1 }, 0.0001, 1)).toEqual({ width: 1, height: 1 })
  })

  it('paintScale 让幻灯片宽度正好落在整数像素上，高度不会超出位图', () => {
    for (const scale of [0.2, 0.333, 0.5316, 0.75, 1, 1.37, 2]) {
      for (const dpr of [1, 1.5, 2]) {
        const px = pixelSize(SLIDE, scale, dpr)
        const paint = paintScale(SLIDE, scale, dpr)
        expect(SLIDE.width * paint * dpr).toBeCloseTo(px.width, 6)
        // 画出来的高度不小于位图高度：最后一行完全被盖住，不会露出底色
        expect(SLIDE.height * paint * dpr).toBeGreaterThanOrEqual(px.height - 1e-6)
      }
    }
  })
})
