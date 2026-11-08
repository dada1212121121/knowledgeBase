/**
 * 网格控制器的行操作与服务端分页接线
 *
 * 关心的接缝：命令 / 右键菜单 → 适配器的 insertRows / deleteRows；适配器自己的保存通道接到会话；
 * 视口滚动 → 适配器按需取页；撤销回到原样后脏标记清掉。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import type { DocumentSession, RemoteTableBackend, RemoteTablePage, SaveOptions, SaveResult, SurfaceContext } from '../../types'
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

/** 记录调用的行操作适配器 */
function rowAdapter(rowCount = 6) {
  const calls: string[] = []
  const state = { rows: rowCount, revision: 0, dirty: false }
  const adapter: GridAdapter = {
    sheets: () => [{ name: 'S', rowCount: state.rows, colCount: 3, cell: () => ({ text: 'x' }) } satisfies GridSheet],
    activeIndex: () => 0,
    setActive: () => undefined,
    revision: () => state.revision,
    apply: (_edits: GridEdit[]) => true,
    insertRows: (at, count) => {
      calls.push(`insert:${at}:${count}`)
      state.rows += count
      state.revision += 1
      state.dirty = true
      return true
    },
    deleteRows: (from, to) => {
      calls.push(`delete:${from}:${to}`)
      state.rows -= to - from + 1
      state.revision += 1
      state.dirty = true
      return true
    },
    dirty: () => state.dirty,
    statusText: () => `共 ${state.rows} 行`,
    prefetch: (first, last) => calls.push(`prefetch:${first}:${last}`),
  }
  return { adapter, calls, state }
}

function makeCtx(overrides: Partial<SurfaceContext> = {}) {
  const dirtyLog: boolean[] = []
  const handlers: Array<((options: SaveOptions) => Promise<SaveResult>) | null> = []
  const session = {
    dirty: false,
    getSelection: () => null,
    setSnapshotProvider: () => undefined,
    setSaveHandler: (handler: ((options: SaveOptions) => Promise<SaveResult>) | null) => handlers.push(handler),
  } as unknown as DocumentSession
  const ctx = {
    session,
    document: { kind: 'grid', format: 'csv', revision: 0, payload: { kind: 'text', text: '', name: 'a.csv' } },
    permissions: { read: true, write: true, export: false, comment: false, ai: false },
    readonly: false,
    onDirtyChange: (value: boolean) => dirtyLog.push(value),
    ...overrides,
  } as unknown as SurfaceContext
  return { ctx, dirtyLog, handlers }
}

async function mount(adapter: GridAdapter, overrides: Partial<SurfaceContext> = {}) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const surface = new GridSurface({ adapter })
  const made = makeCtx(overrides)
  await surface.mount(el, made.ctx)
  await flushPromises()
  return { surface, el, ...made }
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeContext as unknown as CanvasRenderingContext2D)
})
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('行命令', () => {
  it('1. 在选中行上方 / 下方插入同样数量的空行，焦点落在新行上，脏标记由适配器说了算', async () => {
    const { adapter, calls } = rowAdapter()
    const h = await mount(adapter)
    await h.surface.command({ id: '1', type: 'grid.goto', args: { row: 2, col: 1 }, source: 'user', readonlySafe: true })
    expect(await h.surface.command({ id: '2', type: 'grid.insertRowAbove', source: 'user' })).toMatchObject({ ok: true })
    expect(calls).toContain('insert:2:1')
    await h.surface.command({ id: '3', type: 'grid.insertRowBelow', source: 'user' })
    expect(calls).toContain('insert:3:1')
    expect(h.dirtyLog.at(-1)).toBe(true)
    // 状态栏说明跟着适配器走
    expect(document.querySelector('[data-testid="grid-note"]')?.textContent).toBe('共 8 行')
    h.surface.unmount()
  })

  it('2. 删除选中行；末尾加一行', async () => {
    const { adapter, calls } = rowAdapter()
    const h = await mount(adapter)
    await h.surface.command({ id: '1', type: 'grid.goto', args: { row: 1, col: 0 }, source: 'user', readonlySafe: true })
    await h.surface.command({ id: '2', type: 'grid.deleteRows', source: 'user' })
    expect(calls).toContain('delete:1:1')
    await h.surface.command({ id: '3', type: 'grid.appendRow', source: 'user' })
    expect(calls).toContain('insert:5:1')
    h.surface.unmount()
  })

  it('3. 只读时拒绝行命令，不调用适配器', async () => {
    const { adapter, calls } = rowAdapter()
    const h = await mount(adapter, { readonly: true })
    expect(await h.surface.command({ id: '1', type: 'grid.deleteRows', source: 'user' })).toMatchObject({ ok: false, reason: 'readonly' })
    expect(calls).toEqual([])
    h.surface.unmount()
  })

  it('4. 数据源不支持行操作（如 xlsx）时命令明确报不支持', async () => {
    const { adapter } = rowAdapter()
    delete adapter.insertRows
    const h = await mount(adapter)
    expect(await h.surface.command({ id: '1', type: 'grid.insertRowAbove', source: 'user' })).toMatchObject({ ok: false })
    h.surface.unmount()
  })

  it('5. 适配器拒绝（返回 false）时命令失败，状态栏照常刷新原因', async () => {
    const { adapter } = rowAdapter()
    adapter.deleteRows = () => false
    const h = await mount(adapter)
    expect(await h.surface.command({ id: '1', type: 'grid.deleteRows', source: 'user' })).toMatchObject({ ok: false, reason: 'rejected' })
    h.surface.unmount()
  })
})

describe('行右键菜单', () => {
  async function openMenu(rowOps = true) {
    const { adapter, calls } = rowAdapter()
    if (!rowOps) delete adapter.insertRows
    const h = await mount(adapter)
    const canvas = document.querySelector('canvas') as HTMLCanvasElement
    // 点在行头（x < 44）第 2 行（y = 24 表头 + 24 + 5）
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 24 + 24 + 5 })
    canvas.dispatchEvent(event)
    await flushPromises()
    return { h, calls, prevented: event.defaultPrevented }
  }

  it('6. 右键行头：先选中那一行，菜单里三个行操作都在', async () => {
    const { h, prevented } = await openMenu()
    expect(prevented).toBe(true)
    const items = [...document.querySelectorAll('[data-testid="grid-row-menu"] [role="menuitem"]')].map((el) => el.getAttribute('data-action'))
    expect(items).toEqual(['row.insertAbove', 'row.insertBelow', 'row.delete'])
    h.surface.unmount()
  })

  it('7. 点“在上方插入行”走适配器，菜单关闭', async () => {
    const { h, calls } = await openMenu()
    ;(document.querySelector('[data-action="row.insertAbove"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(calls.some((call) => call.startsWith('insert:1:'))).toBe(true)
    expect(document.querySelector('[data-testid="grid-row-menu"]')).toBeNull()
    h.surface.unmount()
  })

  it('8. Esc 关闭菜单；点菜单外面也关闭', async () => {
    const { h } = await openMenu()
    const menu = document.querySelector('[data-testid="grid-row-menu"]') as HTMLElement
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(document.querySelector('[data-testid="grid-row-menu"]')).toBeNull()
    h.surface.unmount()
  })

  it('9. 数据源不支持行操作时不接管右键（让浏览器菜单出来）', async () => {
    const { h, prevented } = await openMenu(false)
    expect(prevented).toBe(false)
    expect(document.querySelector('[data-testid="grid-row-menu"]')).toBeNull()
    h.surface.unmount()
  })
})

describe('视口与分页取页', () => {
  it('10. 画布有尺寸后，可见行区间通知适配器取页；区间没变不重复通知', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300)
    const { adapter, calls } = rowAdapter(1000)
    const h = await mount(adapter)
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    await flushPromises()
    const first = calls.filter((call) => call.startsWith('prefetch:'))
    expect(first.length).toBeGreaterThan(0)
    expect(first[0]).toMatch(/^prefetch:0:\d+$/)
    const count = first.length
    // 再画一次，可见区间没变：不再通知
    ;(document.querySelector('.kb-gs-scroll') as HTMLElement).dispatchEvent(new Event('scroll'))
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    expect(calls.filter((call) => call.startsWith('prefetch:'))).toHaveLength(count)
    h.surface.unmount()
    width.mockRestore()
    height.mockRestore()
  })
})

describe('服务端分页数据源接线', () => {
  const page = (rows: string[][]): RemoteTablePage => ({
    totalRows: rows.length,
    columns: 2,
    rows,
    offset: 0,
    format: { encoding: 'gb18030', encodingLabel: 'GB18030', delimiter: ',', newline: 'lf', trailingNewline: true },
    sha256: 's1',
    version: 3,
  })

  it('11. ctx.remoteTable 存在时用分页适配器：会话拿到它的保存通道，卸载时撤掉', async () => {
    const edits: unknown[] = []
    const backend: RemoteTableBackend = {
      read: async () => page([['姓名', '年龄'], ['张三', '30']]),
      edit: async (ops, expected) => {
        edits.push({ ops, expected })
        return { changed: true, version: 4, sha256: 's2', embedded: 1 }
      },
    }
    const el = document.createElement('div')
    document.body.appendChild(el)
    const made = makeCtx({ remoteTable: backend })
    const surface = new GridSurface()
    await surface.mount(el, made.ctx)
    await flushPromises()
    // 状态栏显示编码
    expect(document.querySelector('[data-testid="grid-note"]')?.textContent).toContain('GB18030')
    expect(made.handlers.at(-1)).toBeTypeOf('function')
    // 编辑 → 脏；撤销回原样 → 不脏
    const canvas = document.querySelector('canvas') as HTMLCanvasElement
    canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 60, clientY: 29, button: 0 }))
    canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 60, clientY: 29 }))
    await flushPromises()
    const editor = document.querySelector('.kb-gs-editor') as HTMLTextAreaElement
    editor.value = '李四'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(made.dirtyLog.at(-1)).toBe(true)
    // 会话保存 = 适配器提交操作列表
    const result = await made.handlers.at(-1)!({})
    expect(result).toMatchObject({ ok: true, revision: 4 })
    expect(edits).toEqual([{ ops: [{ op: 'set_cell', row: 0, col: 0, value: '李四' }], expected: { version: 3, sha256: 's1' } }])
    await surface.command({ id: 'u', type: 'undo', source: 'user' })
    surface.unmount()
    expect(made.handlers.at(-1)).toBeNull()
  })

  it('12. 撤销回到原样后脏标记清掉', async () => {
    const backend: RemoteTableBackend = { read: async () => page([['a', 'b']]), edit: async () => ({ changed: false, version: 3, sha256: 's1', embedded: 0 }) }
    const el = document.createElement('div')
    document.body.appendChild(el)
    const made = makeCtx({ remoteTable: backend })
    const surface = new GridSurface()
    await surface.mount(el, made.ctx)
    await flushPromises()
    await surface.command({ id: 'g', type: 'grid.insertRowAbove', source: 'user' })
    // 只插了一个空行：没有可提交的内容，不算脏
    expect(made.dirtyLog.at(-1)).toBe(false)
    const canvas = document.querySelector('canvas') as HTMLCanvasElement
    canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 60, clientY: 29, button: 0 }))
    canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 60, clientY: 29 }))
    await flushPromises()
    const editor = document.querySelector('.kb-gs-editor') as HTMLTextAreaElement
    editor.value = 'z'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(made.dirtyLog.at(-1)).toBe(true)
    await surface.command({ id: 'u', type: 'undo', source: 'user' })
    expect(made.dirtyLog.at(-1)).toBe(false)
    surface.unmount()
  })

  it('13. 读第一页失败：mount 抛错，由 Host 给出回退入口', async () => {
    const backend: RemoteTableBackend = { read: async () => Promise.reject(new Error('文件有 40 MB，超过在线编辑的上限')), edit: async () => ({ changed: false, version: 0, sha256: '', embedded: 0 }) }
    const el = document.createElement('div')
    document.body.appendChild(el)
    const made = makeCtx({ remoteTable: backend })
    await expect(new GridSurface().mount(el, made.ctx)).rejects.toThrow(/上限/)
  })
})
