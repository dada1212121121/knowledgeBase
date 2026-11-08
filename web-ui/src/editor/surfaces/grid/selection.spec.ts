/**
 * 选区与键盘测试
 *
 * 重点不是复述实现，而是钉住用户已经形成的表格肌肉记忆：Shift 扩选、Ctrl 跳边界、
 * Tab/Enter 移动、合并区整块选中，以及不能抢浏览器保留键。
 */
import { describe, expect, it } from 'vitest'
import {
  cellSelection,
  clampCoord,
  isSingleCell,
  moveSelection,
  normalizeRange,
  resolveGridKey,
  selectAll,
  selectColumn,
  selectRow,
  selectionContains,
} from './selection'

const bounds = { rowCount: 10, colCount: 5 }
const at = (row: number, col: number) => cellSelection(row, col)
const key = (patch: Partial<KeyboardEvent>): Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'> => ({
  key: '',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...patch,
})

describe('grid selection', () => {
  it('1. normalizeRange 不区分 anchor/focus 顺序', () => {
    const range = normalizeRange({ anchor: { row: 4, col: 3 }, focus: { row: 1, col: 0 } })
    expect(range).toEqual({ top: 1, left: 0, bottom: 4, right: 3 })
  })

  it('2. clampCoord 把越界坐标夹回表内', () => {
    expect(clampCoord({ row: -3, col: 99 }, bounds)).toEqual({ row: 0, col: 4 })
    expect(clampCoord({ row: 3.8, col: 2.2 }, bounds)).toEqual({ row: 3, col: 2 })
    expect(clampCoord({ row: 3, col: 3 }, { rowCount: 0, colCount: 0 })).toEqual({ row: 0, col: 0 })
  })

  it('3. 方向键移动活动格并重置 anchor', () => {
    const next = moveSelection(at(2, 2), { kind: 'move', rowDelta: 0, colDelta: 1, extend: false, jump: false }, { bounds })
    expect(next).toEqual(at(2, 3))
  })

  it('4. Shift + 方向键只动 focus', () => {
    const next = moveSelection(at(2, 2), { kind: 'move', rowDelta: 1, colDelta: 0, extend: true, jump: false }, { bounds })
    expect(next).toEqual({ anchor: { row: 2, col: 2 }, focus: { row: 3, col: 2 } })
    expect(normalizeRange(next)).toEqual({ top: 2, left: 2, bottom: 3, right: 2 })
  })

  it('5. 到边界后保持原位，不环绕', () => {
    expect(moveSelection(at(0, 0), { kind: 'move', rowDelta: -1, colDelta: -1, extend: false, jump: false }, { bounds })).toEqual(at(0, 0))
    expect(moveSelection(at(9, 4), { kind: 'move', rowDelta: 1, colDelta: 1, extend: false, jump: false }, { bounds })).toEqual(at(9, 4))
  })

  it('6. Ctrl + 方向键跳到内容边界', () => {
    expect(moveSelection(at(3, 2), { kind: 'move', rowDelta: -1, colDelta: 0, extend: false, jump: true }, { bounds })).toEqual(at(0, 2))
    expect(moveSelection(at(3, 2), { kind: 'move', rowDelta: 1, colDelta: 0, extend: false, jump: true }, { bounds })).toEqual(at(9, 2))
    expect(moveSelection(at(3, 2), { kind: 'move', rowDelta: 0, colDelta: 1, extend: false, jump: true }, { bounds })).toEqual(at(3, 4))
  })

  it('7. PageUp / PageDown 按页移动并保留列', () => {
    const down = moveSelection(at(1, 3), { kind: 'page', direction: 'down', extend: false }, { bounds, pageSize: 5 })
    expect(down).toEqual(at(6, 3))
    const up = moveSelection(at(1, 3), { kind: 'page', direction: 'up', extend: false }, { bounds, pageSize: 5 })
    expect(up).toEqual(at(0, 3))
  })

  it('8. Shift + PageDown 扩选', () => {
    const next = moveSelection(at(1, 1), { kind: 'page', direction: 'down', extend: true }, { bounds, pageSize: 3 })
    expect(next).toEqual({ anchor: { row: 1, col: 1 }, focus: { row: 4, col: 1 } })
  })

  it('9. 合并区任意一格都扩成整块', () => {
    const mergedRanges = [{ top: 1, left: 1, bottom: 3, right: 2 }]
    const inside = moveSelection(at(2, 2), { kind: 'move', rowDelta: 0, colDelta: 0, extend: false, jump: false }, { bounds, mergedRanges })
    expect(inside).toEqual(at(1, 1))
    const fromOutside = moveSelection(at(5, 0), { kind: 'move', rowDelta: -3, colDelta: 2, extend: false, jump: false }, { bounds, mergedRanges })
    expect(fromOutside).toEqual(at(1, 1))
  })

  it('10. 整行 / 整列 / 全选的范围正确', () => {
    expect(normalizeRange(selectRow(3, 5))).toEqual({ top: 3, left: 0, bottom: 3, right: 4 })
    expect(normalizeRange(selectColumn(2, 10))).toEqual({ top: 0, left: 2, bottom: 9, right: 2 })
    expect(normalizeRange(selectAll(bounds))).toEqual({ top: 0, left: 0, bottom: 9, right: 4 })
  })

  it('11. selectionContains 与 isSingleCell 一致', () => {
    const selection = { anchor: { row: 1, col: 1 }, focus: { row: 3, col: 2 } }
    expect(selectionContains(selection, 2, 2)).toBe(true)
    expect(selectionContains(selection, 0, 2)).toBe(false)
    expect(isSingleCell(at(1, 1))).toBe(true)
    expect(isSingleCell(selection)).toBe(false)
  })
})

describe('resolveGridKey', () => {
  it('12. 方向键解析为带 jump 标志的移动', () => {
    expect(resolveGridKey(key({ key: 'ArrowDown' }))).toEqual({ kind: 'move', rowDelta: 1, colDelta: 0, extend: false, jump: false })
    expect(resolveGridKey(key({ key: 'ArrowLeft', shiftKey: true }))).toEqual({ kind: 'move', rowDelta: 0, colDelta: -1, extend: true, jump: false })
    expect(resolveGridKey(key({ key: 'ArrowRight', metaKey: true }))).toEqual({ kind: 'move', rowDelta: 0, colDelta: 1, extend: false, jump: true })
  })

  it('13. Tab / Enter 按表格习惯移动', () => {
    expect(resolveGridKey(key({ key: 'Tab' }))).toMatchObject({ kind: 'move', colDelta: 1 })
    expect(resolveGridKey(key({ key: 'Tab', shiftKey: true }))).toMatchObject({ kind: 'move', colDelta: -1 })
    expect(resolveGridKey(key({ key: 'Enter' }))).toMatchObject({ kind: 'move', rowDelta: 1 })
    expect(resolveGridKey(key({ key: 'Enter', shiftKey: true }))).toMatchObject({ kind: 'move', rowDelta: -1 })
  })

  it('14. Home / End 与 Ctrl+Home / Ctrl+End', () => {
    expect(resolveGridKey(key({ key: 'Home' }))).toEqual({ kind: 'move', rowDelta: 0, colDelta: -1, extend: false, jump: true })
    expect(resolveGridKey(key({ key: 'Home', ctrlKey: true }))).toEqual({ kind: 'move', rowDelta: -1, colDelta: -1, extend: false, jump: true })
    expect(resolveGridKey(key({ key: 'End', metaKey: true }))).toEqual({ kind: 'move', rowDelta: 1, colDelta: 1, extend: false, jump: true })
  })

  it('15. Ctrl / ⌘ 组合键只接管表格相关项', () => {
    expect(resolveGridKey(key({ key: 'a', ctrlKey: true }))).toEqual({ kind: 'selectAll' })
    expect(resolveGridKey(key({ key: 'c', metaKey: true }))).toEqual({ kind: 'copy' })
    expect(resolveGridKey(key({ key: 'x', ctrlKey: true }))).toEqual({ kind: 'cut' })
    expect(resolveGridKey(key({ key: 'v', ctrlKey: true }))).toEqual({ kind: 'paste' })
    expect(resolveGridKey(key({ key: 'z', ctrlKey: true }))).toEqual({ kind: 'undo' })
    expect(resolveGridKey(key({ key: 'z', ctrlKey: true, shiftKey: true }))).toEqual({ kind: 'redo' })
    expect(resolveGridKey(key({ key: 'y', metaKey: true }))).toEqual({ kind: 'redo' })
    expect(resolveGridKey(key({ key: 'f', ctrlKey: true }))).toEqual({ kind: 'find' })
  })

  it('16. 编辑态不抢方向键，Alt 组合一律放行', () => {
    expect(resolveGridKey(key({ key: 'ArrowDown' }), true)).toBeNull()
    expect(resolveGridKey(key({ key: 'Enter' }), true)).toBeNull()
    expect(resolveGridKey(key({ key: 'ArrowDown', altKey: true }))).toBeNull()
    expect(resolveGridKey(key({ key: 'a', altKey: true }))).toBeNull()
  })

  it('17. F2 / Delete / 可打印字符', () => {
    expect(resolveGridKey(key({ key: 'F2' }))).toEqual({ kind: 'edit' })
    expect(resolveGridKey(key({ key: 'Delete' }))).toEqual({ kind: 'clear' })
    expect(resolveGridKey(key({ key: 'Backspace' }))).toEqual({ kind: 'clear' })
    expect(resolveGridKey(key({ key: 'x' }))).toEqual({ kind: 'edit' })
    expect(resolveGridKey(key({ key: ' ' }))).toEqual({ kind: 'edit' })
    expect(resolveGridKey(key({ key: 'Shift' }))).toBeNull()
  })
})
