import { describe, expect, it } from 'vitest'
import { alignRects, distributeRects, type Placed } from './align'

const PAGE = { width: 1280, height: 720 }
const a: Placed = { id: 'a', rect: { x: 100, y: 50, width: 200, height: 100 } }
const b: Placed = { id: 'b', rect: { x: 400, y: 300, width: 100, height: 60 } }
const c: Placed = { id: 'c', rect: { x: 900, y: 200, width: 50, height: 400 } }
const rectOf = (list: Placed[], id: string) => list.find((item) => item.id === id)?.rect

describe('多选对齐', () => {
  it('多选对齐到选中形状的包围盒：左 / 右 / 上 / 下', () => {
    // 包围盒：x 100~950，y 50~600
    expect(rectOf(alignRects([a, b, c], 'left', PAGE), 'b')).toEqual({ x: 100, y: 300, width: 100, height: 60 })
    expect(rectOf(alignRects([a, b, c], 'right', PAGE), 'a')).toEqual({ x: 750, y: 50, width: 200, height: 100 })
    expect(rectOf(alignRects([a, b, c], 'top', PAGE), 'c')).toEqual({ x: 900, y: 50, width: 50, height: 400 })
    expect(rectOf(alignRects([a, b, c], 'bottom', PAGE), 'a')).toEqual({ x: 100, y: 500, width: 200, height: 100 })
  })

  it('水平 / 垂直居中：中线落在包围盒中线上', () => {
    const h = alignRects([a, b, c], 'hcenter', PAGE)
    for (const item of h) expect(item.rect.x + item.rect.width / 2).toBeCloseTo((100 + 950) / 2, 6)
    const v = alignRects([a, b, c], 'vcenter', PAGE)
    for (const item of v) expect(item.rect.y + item.rect.height / 2).toBeCloseTo((50 + 600) / 2, 6)
  })

  it('只返回真的会动的形状，对齐轴上本来就对齐的不出现', () => {
    const list = alignRects([a, b, c], 'left', PAGE)
    expect(list.map((item) => item.id).sort()).toEqual(['b', 'c'])
    expect(alignRects([a, { id: 'd', rect: { ...a.rect } }], 'left', PAGE)).toEqual([])
  })

  it('只选一个形状时对齐到整页', () => {
    expect(rectOf(alignRects([b], 'hcenter', PAGE), 'b')).toEqual({ x: 590, y: 300, width: 100, height: 60 })
    expect(rectOf(alignRects([b], 'bottom', PAGE), 'b')).toEqual({ x: 400, y: 660, width: 100, height: 60 })
    expect(rectOf(alignRects([b], 'right', PAGE), 'b')).toEqual({ x: 1180, y: 300, width: 100, height: 60 })
  })

  it('没有形状 → 空；对齐不改尺寸', () => {
    expect(alignRects([], 'left', PAGE)).toEqual([])
    for (const item of alignRects([a, b, c], 'top', PAGE)) {
      const before = [a, b, c].find((x) => x.id === item.id)!
      expect(item.rect.width).toBe(before.rect.width)
      expect(item.rect.height).toBe(before.rect.height)
    }
  })
})

describe('分布', () => {
  it('水平分布：两端不动，相邻间隙相等；与选择顺序无关', () => {
    // a:100~300  b:400~500  c:900~950 → 总跨度 850，形状宽共 350，间隙 250
    for (const order of [[a, b, c], [c, a, b], [b, c, a]]) {
      const moved = distributeRects(order, 'horizontal')
      expect(moved.map((item) => item.id)).toEqual(['b'])
      expect(rectOf(moved, 'b')).toEqual({ x: 550, y: 300, width: 100, height: 60 })
    }
  })

  it('垂直分布：中间的形状让上下间隙相等', () => {
    const rows: Placed[] = [
      { id: 'r1', rect: { x: 0, y: 0, width: 100, height: 100 } },
      { id: 'r2', rect: { x: 0, y: 130, width: 100, height: 50 } },
      { id: 'r3', rect: { x: 0, y: 500, width: 100, height: 200 } },
    ]
    // 跨度 0~700，形状高共 350，间隙 175
    const moved = distributeRects(rows, 'vertical')
    expect(moved.map((item) => item.id)).toEqual(['r2'])
    expect(rectOf(moved, 'r2')).toEqual({ x: 0, y: 275, width: 100, height: 50 })
  })

  it('少于 3 个形状不分布', () => {
    expect(distributeRects([a, b], 'horizontal')).toEqual([])
    expect(distributeRects([], 'vertical')).toEqual([])
  })

  it('已经均匀的不产生修改', () => {
    const even: Placed[] = [0, 1, 2, 3].map((i) => ({ id: `e${i}`, rect: { x: i * 200, y: 10, width: 100, height: 50 } }))
    expect(distributeRects(even, 'horizontal')).toEqual([])
  })

  it('分布不改尺寸和另一个轴', () => {
    for (const item of distributeRects([a, b, c], 'horizontal')) {
      const before = [a, b, c].find((x) => x.id === item.id)!
      expect(item.rect.y).toBe(before.rect.y)
      expect(item.rect.width).toBe(before.rect.width)
    }
  })
})
