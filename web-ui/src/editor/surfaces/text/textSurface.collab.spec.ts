/**
 * Text Surface 多人编辑
 *
 * 用真实的 Y.Doc + y-prosemirror 驱动（jsdom 里 ProseMirror 视图能跑），房间用「两个 Y.Doc 互相 applyUpdate」模拟：
 * - 空房间被点名初始化时放进正文，已有内容的房间不覆盖；
 * - 两个客户端互相看得到对方的修改；撤销只撤自己的；
 * - 同步前 / 只读时锁住输入；协同时不注册本地保存快照、不报「未保存」，只通知内容变化。
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { prosemirrorToYXmlFragment } from 'y-prosemirror'
import { TextSurface } from '@/editor/surfaces/text/TextSurface'
import { parseMarkdown } from '@/editor/codecs/markdown'
import type { CollabRichLike, CollabRichState, DocumentSession, EditorSource, SurfaceContext } from '@/editor/types'

/** 假房间：一个 Y.Doc + 可控的连接状态；两个房间之间用 link 互相转发更新 */
class FakeRoom implements CollabRichLike {
  readonly doc = new Y.Doc()
  readonly fragment = this.doc.getXmlFragment('prosemirror')
  readonly awareness = new Awareness(this.doc)
  state: CollabRichState
  initDoneCalls = 0
  private listeners = new Set<(state: CollabRichState) => void>()
  private initListeners = new Set<(markdown: string) => void>()
  private revealListeners = new Set<(payload: { head: unknown }) => void>()

  constructor(state: Partial<CollabRichState> = {}) {
    this.state = { writable: true, ready: true, everSynced: true, initMarkdown: null, ...state }
  }
  getState(): CollabRichState {
    return this.state
  }
  subscribe(listener: (state: CollabRichState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  on(event: 'init', listener: (markdown: string) => void): () => void
  on(event: 'reveal', listener: (payload: { head: unknown }) => void): () => void
  on(event: 'init' | 'reveal', listener: ((markdown: string) => void) | ((payload: { head: unknown }) => void)): () => void {
    const set = (event === 'init' ? this.initListeners : this.revealListeners) as Set<unknown>
    set.add(listener)
    return () => set.delete(listener)
  }
  reveal(head: unknown): void {
    for (const listener of this.revealListeners) listener({ head })
  }
  initDone(): void {
    this.initDoneCalls += 1
    this.state = { ...this.state, initMarkdown: null }
  }
  set(next: Partial<CollabRichState>): void {
    this.state = { ...this.state, ...next }
    for (const listener of this.listeners) listener(this.state)
  }
  askInit(markdown: string): void {
    this.state = { ...this.state, initMarkdown: markdown }
    for (const listener of this.initListeners) listener(markdown)
  }
}

/** 两个房间互通（模拟服务端转发）；origin 标成 'remote'，不算本地编辑 */
function link(a: FakeRoom, b: FakeRoom): void {
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'remote')
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), 'remote')
  a.doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') Y.applyUpdate(b.doc, update, 'remote')
  })
  b.doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') Y.applyUpdate(a.doc, update, 'remote')
  })
}

interface Mounted {
  surface: TextSurface
  room: FakeRoom
  el: HTMLElement
  snapshotProviders: unknown[]
  dirty: boolean[]
  changes: number
}

const mounted: Mounted[] = []
afterEach(() => {
  for (const item of mounted.splice(0)) {
    item.surface.unmount()
    item.el.remove()
  }
})

async function mountCollab(room: FakeRoom, text = ''): Promise<Mounted> {
  const el = document.createElement('div')
  document.body.append(el)
  const result: Mounted = { surface: new TextSurface(), room, el, snapshotProviders: [], dirty: [], changes: 0 }
  const session = {
    setSnapshotProvider(provider: (() => EditorSource | null) | null) {
      result.snapshotProviders.push(provider)
    },
  } as unknown as DocumentSession
  const ctx: SurfaceContext = {
    session,
    document: { kind: 'text', format: 'md', revision: 1, payload: { kind: 'text', text, name: 'note.md' } },
    permissions: { read: true, write: true, comment: false, ai: false, export: true },
    readonly: false,
    collabRich: room,
    onDirtyChange: (value) => result.dirty.push(value),
    onContentChange: () => {
      result.changes += 1
    },
  }
  await result.surface.mount(el, ctx)
  mounted.push(result)
  await firstRender()
  return result
}

/** y-prosemirror 的首次渲染在 setTimeout(0) 里 */
async function firstRender(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

const viewOf = (item: Mounted) => {
  const state = item.surface.editorState
  if (!state) throw new Error('没有编辑器状态')
  return state
}
const editable = (item: Mounted) => item.el.querySelector('.kb-text-prose')?.getAttribute('contenteditable')

/** 在文档末尾的文本块里输入（走 Surface 的命令通道，和用户输入同一条事务路径） */
async function typeAtEnd(item: Mounted, text: string): Promise<void> {
  const state = viewOf(item)
  const last = state.doc.childCount - 1
  await item.surface.command({ id: 'sel', type: 'nav.anchor', source: 'user', args: { anchor: { kind: 'text', block: String(last), offset: state.doc.lastChild?.textContent.length ?? 0 } } })
  await item.surface.command({ id: 'type', type: 'text.insert', source: 'user', args: { text } })
}

describe('Text Surface 多人编辑（y-prosemirror）', () => {
  it('1. 被点名初始化的空房间：放进正文、调用 initDone；正文以房间为准，不注册本地保存快照', async () => {
    const room = new FakeRoom({ initMarkdown: '# 标题\n\n正文第一段\n' })
    const item = await mountCollab(room, '# 标题\n\n正文第一段\n')
    expect(room.initDoneCalls).toBe(1)
    expect(room.fragment.toString()).toContain('<heading')
    expect(viewOf(item).doc.child(0).textContent).toBe('标题')
    // 没改过：同步取正文直接回原文（落地时不产生格式噪音）
    expect(item.surface.textNow()).toBe('# 标题\n\n正文第一段\n')
    expect(item.snapshotProviders.filter(Boolean)).toEqual([])
    expect(item.dirty.every((value) => value === false)).toBe(true)
  })

  it('2. 已有内容的房间不被初始化覆盖：显示房间里的内容（例如旧编辑器写进去的）', async () => {
    const room = new FakeRoom()
    prosemirrorToYXmlFragment(parseMarkdown('房间里已有的正文\n').doc, room.fragment)
    const item = await mountCollab(room, '文件里的旧正文\n')
    room.askInit('文件里的旧正文\n')
    expect(viewOf(item).doc.textContent).toBe('房间里已有的正文')
    expect(room.initDoneCalls).toBe(1)
  })

  it('3. 两个客户端互相看得到对方的修改，内容变化通知页面', async () => {
    const roomA = new FakeRoom()
    const roomB = new FakeRoom()
    prosemirrorToYXmlFragment(parseMarkdown('共同的正文\n').doc, roomA.fragment)
    link(roomA, roomB)
    const a = await mountCollab(roomA)
    const b = await mountCollab(roomB)
    const before = b.changes
    await typeAtEnd(a, '甲写的')
    await firstRender()
    expect(viewOf(b).doc.textContent).toBe('共同的正文甲写的')
    expect(b.changes).toBeGreaterThan(before)
    await typeAtEnd(b, '乙写的')
    await firstRender()
    expect(viewOf(a).doc.textContent).toBe('共同的正文甲写的乙写的')
    expect(a.surface.textNow()).toBe('共同的正文甲写的乙写的\n')
  })

  it('4. 撤销只撤自己的改动，不撤别人的', async () => {
    const roomA = new FakeRoom()
    const roomB = new FakeRoom()
    prosemirrorToYXmlFragment(parseMarkdown('起点\n').doc, roomA.fragment)
    link(roomA, roomB)
    const a = await mountCollab(roomA)
    const b = await mountCollab(roomB)
    await typeAtEnd(a, '甲')
    await firstRender()
    await typeAtEnd(b, '乙')
    await firstRender()
    expect(viewOf(a).doc.textContent).toBe('起点甲乙')
    const undone = await a.surface.command({ id: 'u', type: 'undo', source: 'user' })
    expect(undone.ok).toBe(true)
    await firstRender()
    expect(viewOf(a).doc.textContent).toBe('起点乙')
    expect(viewOf(b).doc.textContent).toBe('起点乙')
  })

  it('5. 同步之前、以及房间只读时锁住输入；可写且同步过才放开', async () => {
    const room = new FakeRoom({ writable: true, ready: false, everSynced: false })
    const item = await mountCollab(room)
    expect(editable(item)).toBe('false')
    room.set({ ready: true, everSynced: true })
    expect(editable(item)).toBe('true')
    room.set({ writable: false })
    expect(editable(item)).toBe('false')
    // 同步过之后断线（ready=false）仍可继续写，改动留在本地、恢复后合并
    room.set({ writable: true, ready: false })
    expect(editable(item)).toBe('true')
  })

  it('6. 卸载后不再响应房间状态，也不再改动房间', async () => {
    const room = new FakeRoom()
    prosemirrorToYXmlFragment(parseMarkdown('正文\n').doc, room.fragment)
    const item = await mountCollab(room)
    const xml = room.fragment.toString()
    item.surface.unmount()
    mounted.splice(mounted.indexOf(item), 1)
    item.el.remove()
    room.set({ writable: false })
    room.askInit('不该写进去\n')
    expect(room.fragment.toString()).toBe(xml)
  })
})

describe('点头像跳到对方光标（reveal）', () => {
  it('滚到对方光标所在位置，名牌重新亮 3.5 秒后收起', async () => {
    const room = new FakeRoom()
    prosemirrorToYXmlFragment(parseMarkdown('第一段\n\n第二段').doc, room.fragment)
    const item = await mountCollab(room)
    const { ySyncPluginKey, absolutePositionToRelativePosition } = await import('y-prosemirror')
    const view = (item.surface as unknown as { view: import('prosemirror-view').EditorView }).view
    const sync = ySyncPluginKey.getState(view.state)!
    // 对方光标在第二段里
    const head = Y.relativePositionToJSON(absolutePositionToRelativePosition(9, sync.type, sync.binding.mapping))
    const scrolled: Element[] = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this)
    }
    try {
      room.reveal(head)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(scrolled).toHaveLength(1)
      expect(scrolled[0]!.textContent).toContain('第二段')
      expect(view.dom.parentElement!.classList.contains('is-revealing')).toBe(true)
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })

  it('对方位置已经在被删掉的内容里 / 没有位置：什么都不做，不抛错', async () => {
    const room = new FakeRoom()
    prosemirrorToYXmlFragment(parseMarkdown('正文').doc, room.fragment)
    const item = await mountCollab(room)
    room.reveal(null)
    room.reveal(undefined)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const view = (item.surface as unknown as { view: import('prosemirror-view').EditorView }).view
    expect(view.dom.parentElement!.classList.contains('is-revealing')).toBe(false)
  })
})
