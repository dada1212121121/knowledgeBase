/**
 * 协同在线状态的整理：别人的光标按「哪一页 / 哪个形状」给出，这里换成界面要画的东西
 *
 * - 缩略图栏：哪几页有人，用对方代表色的小圆点 + 名字首字；
 * - 画布上：对方选中的形状画一个对方颜色的框，框上挂名字（只画当前页的）；
 * - 多个人选了同一个形状，框错开叠放，名字标签竖着排，不会盖在一起。
 * 全部是纯函数，不碰 DOM，方便单测。
 */
import type { SlidePeer, SlideRect } from './types'

/** 按页分组（只收有位置的人；slide < 0 = 没有光标或他所在的页已经被删了） */
export function peersBySlide(peers: readonly SlidePeer[]): Map<number, SlidePeer[]> {
  const out = new Map<number, SlidePeer[]>()
  for (const peer of peers) {
    if (peer.slide < 0) continue
    const list = out.get(peer.slide) ?? []
    list.push(peer)
    out.set(peer.slide, list)
  }
  return out
}

export interface PeerBox {
  peer: SlidePeer
  rect: SlideRect
  /** 同一个形状上的第几个人（0 起）：标签竖着排的序号 */
  stack: number
}

/** 当前页上要画框的人：选中了形状、而且这个形状还在的 */
export function presenceBoxes(peers: readonly SlidePeer[], shapes: ReadonlyArray<{ id: string; rect: SlideRect }>, slide: number): PeerBox[] {
  const byId = new Map(shapes.map((shape) => [shape.id, shape.rect]))
  const stacks = new Map<string, number>()
  const out: PeerBox[] = []
  for (const peer of peers) {
    if (peer.slide !== slide || !peer.shapeId) continue
    const rect = byId.get(peer.shapeId)
    if (!rect) continue
    const stack = stacks.get(peer.shapeId) ?? 0
    stacks.set(peer.shapeId, stack + 1)
    out.push({ peer, rect, stack })
  }
  return out
}

/** 名字的头像字：取第一个字符（中文取第一个字，英文取首字母大写） */
export function peerInitial(name: string): string {
  const first = [...name.trim()][0] ?? '?'
  return first.toUpperCase()
}

/** 状态条文字里的在线者摘要：最多列 `limit` 个名字，其余写总数 */
export function peerSummary(names: readonly string[], limit = 3): string {
  if (!names.length) return ''
  const shown = names.slice(0, limit).join('、')
  return names.length > limit ? `${shown} 等 ${names.length} 人` : shown
}
