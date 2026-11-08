// 多选规则:Ctrl/Shift/选择模式/上限。
import { describe, expect, it } from 'vitest'
import { MAX_SELECTION, pick, pruneSelection, rangeBetween, selectAll, type SelectionState } from './selection'

const order = ['a', 'b', 'c', 'd', 'e']
const empty: SelectionState = { selected: [], anchor: null, selecting: false }
const plain = { ctrl: false, shift: false, selecting: false }

describe('pick', () => {
  it('普通点击且没有在选择:不改选择,交给调用方打开', () => {
    const result = pick(order, empty, 'b', plain)
    expect(result.handled).toBe(false)
    expect(result.selected).toEqual([])
  })

  it('Ctrl / ⌘ + 点击:选中并进入选择模式;再点一次取消', () => {
    const first = pick(order, empty, 'b', { ...plain, ctrl: true })
    expect(first).toMatchObject({ handled: true, selected: ['b'], anchor: 'b', selecting: true })
    const second = pick(order, first, 'b', { ...plain, ctrl: true })
    expect(second.selected).toEqual([])
    // 全部取消后选择模式还在(点「完成」才退出),不会突然变回打开文档
    expect(second.selecting).toBe(true)
  })

  it('选择模式下普通点击是切换,不是打开', () => {
    let state = pick(order, empty, 'a', { ...plain, ctrl: true })
    state = pick(order, state, 'c', plain)
    expect(state.selected).toEqual(['a', 'c'])
    expect(state.handled).toBe(true)
    state = pick(order, state, 'a', plain)
    expect(state.selected).toEqual(['c'])
  })

  it('已经有选中项时,普通点击也是切换(哪怕 selecting 标记丢了)', () => {
    const result = pick(order, { selected: ['a'], anchor: 'a', selecting: false }, 'b', plain)
    expect(result.selected).toEqual(['a', 'b'])
  })

  it('Shift + 点击:起点到这一项连选(不分先后),并上已选的,起点不变', () => {
    let state = pick(order, empty, 'b', { ...plain, ctrl: true })
    state = pick(order, state, 'd', { ...plain, shift: true })
    expect(state.selected).toEqual(['b', 'c', 'd'])
    expect(state.anchor).toBe('b')
    // 往回连选
    state = pick(order, { selected: ['d'], anchor: 'd', selecting: true }, 'a', { ...plain, shift: true })
    expect([...state.selected].sort()).toEqual(['a', 'b', 'c', 'd'])
    // 已选的别处不被冲掉
    state = pick(order, { selected: ['a', 'e'], anchor: 'c', selecting: true }, 'd', { ...plain, shift: true })
    expect([...state.selected].sort()).toEqual(['a', 'c', 'd', 'e'])
  })

  it('Shift 但没有起点:当作一次 Ctrl 点击(选中这一项并成为起点)', () => {
    const result = pick(order, empty, 'c', { ...plain, shift: true, ctrl: true })
    expect(result.selected).toEqual(['c'])
    expect(result.anchor).toBe('c')
    // 纯 Shift 没有起点又没在选择模式:是普通点击
    expect(pick(order, empty, 'c', { ...plain, shift: true }).handled).toBe(false)
  })

  it('Shift 的起点已经不在列表里(翻页了):退化成切换这一项', () => {
    const result = pick(order, { selected: ['x'], anchor: 'x', selecting: true }, 'c', { ...plain, shift: true })
    expect(result.selected).toEqual(['x', 'c'])
  })

  it('一次最多 500 项:超出的被丢掉并如实报告', () => {
    const many = Array.from({ length: 600 }, (_, index) => `k${index}`)
    const state = pick(many, { selected: ['k0'], anchor: 'k0', selecting: true }, 'k599', { ...plain, shift: true })
    expect(state.selected).toHaveLength(MAX_SELECTION)
    expect(state.dropped).toBe(100)
    expect(pick(order, empty, 'a', { ...plain, ctrl: true }).dropped).toBe(0)
  })
})

describe('其它', () => {
  it('rangeBetween 任一端不在列表里返回 null', () => {
    expect(rangeBetween(order, 'b', 'd')).toEqual(['b', 'c', 'd'])
    expect(rangeBetween(order, 'd', 'b')).toEqual(['b', 'c', 'd'])
    expect(rangeBetween(order, 'b', 'zzz')).toBeNull()
  })

  it('全选:超过上限只取前 500 项', () => {
    expect(selectAll(order)).toEqual({ selected: order, dropped: 0 })
    const many = Array.from({ length: 501 }, (_, index) => `k${index}`)
    expect(selectAll(many)).toMatchObject({ dropped: 1 })
    expect(selectAll(many).selected).toHaveLength(500)
  })

  it('换页 / 筛选后丢掉看不到的选中项;跨页选择时原样保留', () => {
    expect(pruneSelection(['a', 'x', 'c'], order)).toEqual(['a', 'c'])
    expect(pruneSelection(['a', 'x'], order, true)).toEqual(['a', 'x'])
  })
})
