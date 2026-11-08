/**
 * Code Surface 控制器测试
 *
 * 这里不重测 CodeMirror 的语言包，而是守住统一契约的三条：正文可读写、查找锚点可回放、
 * 未改动时保存快照逐字节相同（BOM / CRLF 不被规范化）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import type { EditorView } from '@codemirror/view'
import type { DocumentSession, EditorSource, SurfaceContext } from '../../types'
import { CodeSurface } from './surface'

interface Harness {
  surface: CodeSurface
  el: HTMLElement
  snapshots: () => EditorSource | null
  dirty: () => boolean
  view: () => EditorView
}

async function mountSurface(text = 'fn main() {\n  println!("hi");\n}\n'): Promise<Harness> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  let snapshot: EditorSource | null = null
  let dirty = false
  const session = {
    getSelection: () => null,
    setSnapshotProvider: (provider: (() => EditorSource | null) | null) => {
      snapshot = provider?.() ?? null
      // 控制器会在 mount 里立即注册 provider；测试保存时重新取一次实时快照
      if (provider) snapshotProvider = provider
    },
  } as unknown as DocumentSession
  let snapshotProvider: (() => EditorSource | null) | null = null
  const ctx = {
    session,
    document: { kind: 'code', format: 'rs', revision: 0, payload: { kind: 'text', text, name: 'main.rs' } },
    permissions: { read: true, write: true, export: false, comment: false, ai: false },
    readonly: false,
    onDirtyChange: (value: boolean) => (dirty = value),
  } as SurfaceContext
  const surface = new CodeSurface()
  await surface.mount(el, ctx)
  await flushPromises()
  const exposed = (surface as unknown as { viewRef: { value: { getView: () => EditorView } } }).viewRef.value
  return {
    surface,
    el,
    snapshots: () => (snapshotProvider ? snapshotProvider() : snapshot),
    dirty: () => dirty,
    view: () => exposed.getView(),
  }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('CodeSurface', () => {
  it('1. 挂载后显示完整源码，未改动时保存快照就是原文', async () => {
    const raw = '\uFEFFfn main() {\r\n  println!("hi");\r\n}\r\n'
    const h = await mountSurface(raw)
    expect(h.el.querySelector('.cm-content')?.textContent).toContain('fn main()')
    expect(h.snapshots()).toMatchObject({ kind: 'text', text: raw, name: 'main.rs' })
    h.surface.unmount()
  })

  it('2. 编辑后脏标记为 true，快照沿用原文件 CRLF / BOM', async () => {
    const h = await mountSurface('\uFEFFa\r\nb\r\n')
    h.view().dispatch({ changes: { from: 3, to: 3, insert: 'X' } })
    await flushPromises()
    expect(h.dirty()).toBe(true)
    expect(h.snapshots()).toMatchObject({ kind: 'text', text: '\uFEFFa\r\nbX\r\n' })
    h.surface.unmount()
  })

  it('3. 查找命令返回命中锚点，next 会选中下一条', async () => {
    const h = await mountSurface('one\ntwo\none\n')
    const first = await h.surface.command({ id: 'f1', type: 'search.set', args: { query: 'one' }, source: 'user', readonlySafe: true })
    expect(first).toMatchObject({ ok: true })
    expect((first.data as { total: number; index: number }).total).toBe(2)
    expect((first.data as { index: number }).index).toBe(0)
    const second = await h.surface.command({ id: 'f2', type: 'search.next', source: 'user', readonlySafe: true })
    expect((second.data as { index: number }).index).toBe(1)
    expect(h.view().state.sliceDoc(h.view().state.selection.main.from, h.view().state.selection.main.to)).toBe('one')
    h.surface.unmount()
  })

  it('4. undo 回到打开时的内容，脏标记恢复 false', async () => {
    const h = await mountSurface('abc')
    h.view().dispatch({ changes: { from: 3, insert: 'd' } })
    await flushPromises()
    expect(h.dirty()).toBe(true)
    await h.surface.command({ id: 'u', type: 'undo', source: 'user' })
    await flushPromises()
    expect(h.dirty()).toBe(false)
    expect(h.snapshots()).toMatchObject({ kind: 'text', text: 'abc' })
    h.surface.unmount()
  })
})
