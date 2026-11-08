import { describe, expect, it } from 'vitest'
import { boundingBox, containsPoint, handlePoint, hitHandle, snapRect, toScreen } from './overlay'

const R = { x: 100, y: 50, width: 200, height: 100 }
const PAGE = { width: 1280, height: 720 }

describe('选中框几何', () => {
  it('8 个控制点落在边与角的正确位置', () => {
    expect(handlePoint(R, 'nw')).toEqual({ x: 100, y: 50 })
    expect(handlePoint(R, 'ne')).toEqual({ x: 300, y: 50 })
    expect(handlePoint(R, 'se')).toEqual({ x: 300, y: 150 })
    expect(handlePoint(R, 'sw')).toEqual({ x: 100, y: 150 })
    expect(handlePoint(R, 'n')).toEqual({ x: 200, y: 50 })
    expect(handlePoint(R, 'e')).toEqual({ x: 300, y: 100 })
    expect(handlePoint(R, 's')).toEqual({ x: 200, y: 150 })
    expect(handlePoint(R, 'w')).toEqual({ x: 100, y: 100 })
  })

  it('命中控制点：半径内取最近的，半径外为 null', () => {
    expect(hitHandle(R, { x: 102, y: 51 }, 6)).toBe('nw')
    expect(hitHandle(R, { x: 299, y: 149 }, 6)).toBe('se')
    expect(hitHandle(R, { x: 200, y: 52 }, 6)).toBe('n')
    expect(hitHandle(R, { x: 200, y: 100 }, 6)).toBeNull()
    // 小框上相邻的点重叠时取更近的，而不是第一个
    const tiny = { x: 0, y: 0, width: 8, height: 8 }
    expect(hitHandle(tiny, { x: 7, y: 7 }, 6)).toBe('se')
  })

  it('点是否落在矩形内（含边界）', () => {
    expect(containsPoint(R, { x: 100, y: 50 })).toBe(true)
    expect(containsPoint(R, { x: 300, y: 150 })).toBe(true)
    expect(containsPoint(R, { x: 99, y: 100 })).toBe(false)
  })

  it('包围盒覆盖所有矩形；空集合为 null', () => {
    expect(boundingBox([])).toBeNull()
    expect(boundingBox([R, { x: 0, y: 200, width: 50, height: 50 }])).toEqual({ x: 0, y: 50, width: 300, height: 200 })
  })

  it('吸附到页面边缘与中线，并给出对应参考线', () => {
    const near = { x: 3, y: 352, width: 100, height: 20 }
    const { rect, guides } = snapRect(near, [], PAGE, 6)
    expect(rect.x).toBe(0)
    // 竖向：矩形中线 365 距页面中线 360 只有 5 → 吸附
    expect(rect.y + rect.height / 2).toBe(360)
    expect(guides).toEqual([
      { axis: 'x', position: 0 },
      { axis: 'y', position: 360 },
    ])
  })

  it('吸附到其他形状的边；超出阈值不吸附', () => {
    const other = { x: 500, y: 100, width: 100, height: 100 }
    const snapped = snapRect({ x: 603, y: 400, width: 80, height: 40 }, [other], PAGE, 6)
    expect(snapped.rect.x).toBe(600)
    expect(snapped.guides).toContainEqual({ axis: 'x', position: 600 })
    const far = snapRect({ x: 700, y: 400, width: 80, height: 40 }, [other], PAGE, 6)
    expect(far.rect).toEqual({ x: 700, y: 400, width: 80, height: 40 })
    expect(far.guides).toEqual([])
  })

  it('只移动被吸附的那个轴，另一个轴保持原值', () => {
    const { rect } = snapRect({ x: 2, y: 222, width: 50, height: 50 }, [], PAGE, 6)
    expect(rect.x).toBe(0)
    expect(rect.y).toBe(222)
  })

  it('幻灯片坐标 → 屏幕样式随缩放线性变化', () => {
    expect(toScreen(R, 0.5)).toEqual({ left: '50px', top: '25px', width: '100px', height: '50px' })
  })
})
