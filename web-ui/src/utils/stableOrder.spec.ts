import { describe, expect, it } from 'vitest'
import { mergeStableOrder } from './stableOrder'

const rows = (...ids: string[]) => ids.map((id) => ({ id, n: id }))
const ids = (list: { id: string }[]) => list.map((row) => row.id)

describe('列表稳定刷新', () => {
  it('改过的那一行服务端排到了最前：它在列表里的位置不动，内容换成最新的', () => {
    const previous = rows('a', 'b', 'c', 'd')
    const next = [{ id: 'c', n: 'c(新)' }, ...rows('a', 'b', 'd')]
    const merged = mergeStableOrder(previous, next, 16)
    expect(ids(merged)).toEqual(['a', 'b', 'c', 'd'])
    expect(merged[2]).toEqual({ id: 'c', n: 'c(新)' })
  })
  it('被删 / 挪到别的页的行去掉', () => {
    expect(ids(mergeStableOrder(rows('a', 'b', 'c'), rows('c', 'a'), 16))).toEqual(['a', 'c'])
  })
  it('新出现的行放在它在服务端结果里前一行的后面；没有前一行放最前', () => {
    expect(ids(mergeStableOrder(rows('a', 'b', 'c'), rows('n', 'a', 'b', 'c'), 16))).toEqual(['n', 'a', 'b', 'c'])
    expect(ids(mergeStableOrder(rows('a', 'b', 'c'), rows('a', 'n', 'b', 'c'), 16))).toEqual(['a', 'n', 'b', 'c'])
  })
  it('不超过一页的条数', () => {
    expect(ids(mergeStableOrder(rows('a', 'b', 'c'), rows('n', 'a', 'b', 'c'), 3))).toEqual(['n', 'a', 'b'])
  })
  it('上一屏是空的：就是服务端结果', () => {
    expect(ids(mergeStableOrder([], rows('x', 'y'), 16))).toEqual(['x', 'y'])
  })
})
