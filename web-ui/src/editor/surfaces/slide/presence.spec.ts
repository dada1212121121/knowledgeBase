import { describe, expect, it } from 'vitest'
import { peerInitial, peerSummary, peersBySlide, presenceBoxes } from './presence'
import type { SlidePeer } from './types'

const peer = (id: number, slide: number, shapeId: string | null = null, name = `用户${id}`): SlidePeer => ({ id, name, color: '#f00', slide, shapeId })
const shapes = [
  { id: 'a', rect: { x: 10, y: 20, width: 100, height: 50 } },
  { id: 'b', rect: { x: 200, y: 20, width: 100, height: 50 } },
]

describe('协同在线状态', () => {
  it('按页分组；没有光标 / 页已删除（slide < 0）的人不进任何一页', () => {
    const map = peersBySlide([peer(1, 0), peer(2, 2), peer(3, 0), peer(4, -1)])
    expect([...map.keys()].sort()).toEqual([0, 2])
    expect(map.get(0)?.map((p) => p.id)).toEqual([1, 3])
    expect(map.has(-1)).toBe(false)
  })

  it('当前页上选了形状的人各画一个框；别的页、没选形状、形状已被删掉的都不画', () => {
    const boxes = presenceBoxes([peer(1, 3, 'a'), peer(2, 4, 'a'), peer(3, 3, null), peer(4, 3, 'gone'), peer(5, 3, 'b')], shapes, 3)
    expect(boxes.map((b) => [b.peer.id, b.rect.x])).toEqual([
      [1, 10],
      [5, 200],
    ])
  })

  it('同一个形状上有多个人：序号递增，标签竖着排', () => {
    const boxes = presenceBoxes([peer(1, 0, 'a'), peer(2, 0, 'a'), peer(3, 0, 'b'), peer(4, 0, 'a')], shapes, 0)
    expect(boxes.filter((b) => b.rect.x === 10).map((b) => b.stack)).toEqual([0, 1, 2])
    expect(boxes.find((b) => b.peer.id === 3)!.stack).toBe(0)
  })

  it('头像字：中文取第一个字，英文取首字母大写，空名字给问号', () => {
    expect(peerInitial('张三')).toBe('张')
    expect(peerInitial(' alice')).toBe('A')
    expect(peerInitial('')).toBe('?')
    expect(peerInitial('😀 smile')).toBe('😀')
  })

  it('在线者摘要：不超过 3 个全列，超过写总数', () => {
    expect(peerSummary([])).toBe('')
    expect(peerSummary(['甲', '乙'])).toBe('甲、乙')
    expect(peerSummary(['甲', '乙', '丙', '丁', '戊'])).toBe('甲、乙、丙 等 5 人')
  })
})
