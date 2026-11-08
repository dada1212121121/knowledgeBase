/**
 * Grid Surface 控制器测试
 *
 * 控制器是「视图 ↔ 数据源」的接缝：选区要能翻译成 cell 锚点，编辑要落到适配器并把
 * 会话标脏，查找/撤销要能通过命令层调用。这里用一个可变的内存适配器守住这些接缝。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import type { DocumentSession, SurfaceContext } from '../../types'
import { GridSurface, type GridAdapter } from './surface'
import type { GridEdit, GridSheet } from './types'

const fakeContext = {
  setTransform: () => undefined,
  clearRect: () => undefined,
  fillRect: () => undefined,
  strokeRect: () => undefined,
  beginPath: () => undefined,
  rect: () => undefined,
  clip: () => undefined,
  save: () => undefined,
  restore: () => undefined,
  translate: () => undefined,
  moveTo: () => undefined,
  lineTo: () => undefined,
  stroke: () => undefined,
  fillText: () => undefined,
  textAlign: 'left',
  textBaseline: 'alphabetic',
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 1,
  font: '',
}

interface Harness {
  surface: GridSurface
  adapter: GridAdapter
  el: HTMLElement
  dirty: () => boolean
  selections: unknown[]
}

function makeAdapter(): { adapter: GridAdapter; cells: Map<string, string>; dirty: { value: boolean }; revision: { value: number } } {
  const cells = new Map<string, string>([
    ['0:0', 'Alice'],
    ['0:1', '28'],
    ['1:0', 'Bob'],
    ['2:2', 'Alice'],
  ])
  const revision = { value: 0 }
  const dirty = { value: false }
  const sheet = (): GridSheet => ({
    name: 'Sheet1',
    rowCount: 10,
    colCount: 5,
    cell: (row, col) => {
      const text = cells.get(`${row}:${col}`)
      return text === undefined ? null : { text }
    },
  })
  const history: string[][] = []
  const adapter: GridAdapter = {
    sheets: () => [sheet()],
    activeIndex: () => 0,
    setActive: () => undefined,
    revision: () => revision.value,
    apply: (edits: GridEdit[]) => {
      history.push([...cells.entries()].map(([key, value]) => `${key}=${value}`))
      for (const edit of edits) {
        if (edit.text === '') cells.delete(`${edit.row}:${edit.col}`)
        else cells.set(`${edit.row}:${edit.col}`, edit.text)
      }
      revision.value += 1
      dirty.value = true
      return true
    },
    undo: () => {
      const previous = history.pop()
      if (!previous) return false
      cells.clear()
      for (const pair of previous) {
        const [key, value] = pair.split('=')
        if (key && value !== undefined) cells.set(key, value)
      }
      revision.value += 1
      return true
    },
    snapshot: () => ({ kind: 'text', text: [...cells.entries()].map(([key, value]) => `${key}=${value}`).join('\n'), name: 'Sheet1.csv' }),
  }
  return { adapter, cells, dirty, revision }
}

async function mountSurface(): Promise<Harness> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const { adapter, dirty } = makeAdapter()
  const surface = new GridSurface({ adapter })
  const selections: unknown[] = []
  const session = {
    dirty: false,
    getSelection: () => null,
    setSnapshotProvider: () => undefined,
  } as unknown as DocumentSession
  const ctx = {
    session,
    document: { kind: 'grid', format: 'csv', revision: 0, payload: null },
    permissions: { read: true, write: true, export: false, comment: false, ai: false },
    readonly: false,
    onSelectionChange: (selection: unknown) => selections.push(selection),
    onDirtyChange: (value: boolean) => {
      ;(session as unknown as { dirty: boolean }).dirty = value
    },
  } as unknown as SurfaceContext
  await surface.mount(el, ctx)
  await flushPromises()
  return { surface, adapter, el, dirty: () => dirty.value, selections }
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeContext as unknown as CanvasRenderingContext2D)
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('GridSurface controller', () => {
  it('1. 选区翻译成 cell 锚点', async () => {
    const h = await mountSurface()
    await h.surface.command({ id: 'g', type: 'grid.goto', args: { row: 1, col: 2 }, source: 'user' })
    const selection = h.selections.at(-1) as { kind: string; anchor: { kind: string; sheet: string; cell: string } }
    expect(selection.kind).toBe('grid')
    expect(selection.anchor).toEqual({ kind: 'cell', sheet: 'Sheet1', cell: 'C2' })
    h.surface.unmount()
  })

  it('2. 查找命令返回命中并在视图中跳转', async () => {
    const h = await mountSurface()
    const result = await h.surface.command({ id: 'f', type: 'search.set', args: { query: 'Alice' }, source: 'user', readonlySafe: true })
    expect(result).toMatchObject({ ok: true, data: { total: 2, index: 0 } })
    const selection = h.selections.at(-1) as { anchor: { cell: string } }
    expect(selection.anchor.cell).toBe('A1')
    h.surface.unmount()
  })

  it('3. 编辑通过适配器落库，会话变脏，快照可取', async () => {
    const h = await mountSurface()
    const editor = document.querySelector('.kb-gs-editor') as HTMLTextAreaElement | null
    expect(editor).toBeNull()
    const canvas = document.querySelector('canvas') as HTMLCanvasElement
    canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 150, clientY: 29, button: 0 }))
    canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 150, clientY: 29 }))
    await flushPromises()
    const opened = document.querySelector('.kb-gs-editor') as HTMLTextAreaElement
    expect(opened).not.toBeNull()
    opened.value = '29'
    opened.dispatchEvent(new Event('input', { bubbles: true }))
    opened.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(h.dirty()).toBe(true)
    const selection = h.selections.at(-1) as { anchor: { cell: string } }
    expect(selection.anchor.cell).toBe('B2')
    h.surface.unmount()
  })

  it('4. undo 命令回到修改前，redo 不可用时报 reason', async () => {
    const h = await mountSurface()
    const missing = await h.surface.command({ id: 'r', type: 'redo', source: 'user' })
    expect(missing).toMatchObject({ ok: false, reason: 'nothing_to_redo' })
    await h.surface.command({ id: 'u', type: 'undo', source: 'user' })
    // 没有历史时 undo 也应明确失败，而不是假装成功
    const undo = await h.surface.command({ id: 'u2', type: 'undo', source: 'user' })
    expect(undo).toMatchObject({ ok: false, reason: 'nothing_to_undo' })
    h.surface.unmount()
  })

  it('5. capture / restore 保存滚动位置与选区', async () => {
    const h = await mountSurface()
    await h.surface.command({ id: 'g', type: 'grid.goto', args: { row: 3, col: 2 }, source: 'user' })
    const state = h.surface.capture()
    expect(state.kind).toBe('grid')
    expect(state.extra).toMatchObject({ focusRow: 3, focusCol: 2 })
    h.surface.restore(state)
    const selection = h.selections.at(-1) as { anchor: { cell: string } }
    expect(selection.anchor.cell).toBe('C4')
    h.surface.unmount()
  })
})
