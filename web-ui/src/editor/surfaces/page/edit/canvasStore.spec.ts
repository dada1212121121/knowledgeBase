/** 页面画布仓库单测：按 pageId 复用、回收释放像素。 */
import { describe, expect, it } from 'vitest'
import { CanvasStore } from './canvasStore'

const page = (id: string, index = 0) => ({ pageId: id, pageIndex: index })

describe('CanvasStore', () => {
  it('同一个 pageId 总是拿到同一张画布；页序号变了（插入页）也不串页', () => {
    const store = new CanvasStore()
    const first = store.ensure(page('p1', 0))
    expect(store.ensure(page('p1', 3))).toBe(first)
    expect(store.ensure(page('p2', 1))).not.toBe(first)
    expect(store.size).toBe(2)
  })

  it('existing 只查不建', () => {
    const store = new CanvasStore()
    expect(store.existing(page('x'))).toBeNull()
    expect(store.size).toBe(0)
    const canvas = store.ensure(page('x'))
    expect(store.existing(page('x'))).toBe(canvas)
  })

  it('evict 收回窗口外的画布：摘下 DOM、尺寸置零、从仓库删除', () => {
    const store = new CanvasStore()
    const keep = store.ensure(page('keep'))
    const drop = store.ensure(page('drop'))
    for (const canvas of [keep, drop]) {
      canvas.width = 816
      canvas.height = 1056
      document.body.appendChild(canvas)
    }
    expect(store.evict(new Set(['keep']))).toBe(1)
    expect(store.has('drop')).toBe(false)
    expect(drop.width).toBe(0)
    expect(drop.height).toBe(0)
    expect(drop.isConnected).toBe(false)
    expect(keep.width).toBe(816)
    expect(keep.isConnected).toBe(true)
  })

  it('被收回的页再来时建一张新画布', () => {
    const store = new CanvasStore()
    const old = store.ensure(page('a'))
    store.evict(new Set())
    expect(store.ensure(page('a'))).not.toBe(old)
  })

  it('dispose 清空全部', () => {
    const store = new CanvasStore()
    store.ensure(page('a'))
    store.ensure(page('b'))
    store.dispose()
    expect(store.size).toBe(0)
  })
})
