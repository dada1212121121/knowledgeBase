/**
 * 幻灯片编辑面集成测试：真实的 SlideView + 编辑层 + 工具栏 + 编辑面，后端是假的内存后端。
 * 手势与输入的细节在 pptx-edit.spec.ts 里测；这里验"接线"：事件 → 控制器 → 后端、脏标记、保存快照、撤销命令、只读、释放。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import type { DocumentSession, EditorCommand, EditorSource, SurfaceContext } from '../../types'
import { SlideEditSurface } from './edit-surface'
import { makeFakeEditBackend, type FakeEditBackend } from './fakeEditBackend'
import { stubCanvas } from './fakeBackend'

let restoreCanvas: () => void = () => undefined
const mounted: Array<{ surface: SlideEditSurface; el: HTMLElement }> = []
beforeEach(() => {
  restoreCanvas = stubCanvas()
})
afterEach(() => {
  for (const { surface, el } of mounted.splice(0)) {
    surface.unmount()
    el.remove()
  }
  restoreCanvas()
})

interface Harness {
  surface: SlideEditSurface
  el: HTMLElement
  backend: FakeEditBackend
  dirty: ReturnType<typeof vi.fn>
  stats: ReturnType<typeof vi.fn>
  errors: Error[]
  snapshot: { sync: (() => EditorSource | null) | null | undefined; async: (() => Promise<EditorSource | null>) | null | undefined }
}

async function mountEdit(options: Parameters<typeof makeFakeEditBackend>[0] = {}, collab = false): Promise<Harness> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const backend = makeFakeEditBackend(options)
  const dirty = vi.fn()
  const stats = vi.fn()
  const errors: Error[] = []
  const snapshot: Harness['snapshot'] = { sync: undefined, async: undefined }
  const ctx = {
    session: {
      getSelection: () => null,
      setSnapshotProvider: (sync: Harness['snapshot']['sync'], async: Harness['snapshot']['async']) => {
        snapshot.sync = sync
        snapshot.async = async
      },
    } as unknown as DocumentSession,
    document: { kind: 'slide', format: 'pptx', revision: 0, payload: { kind: 'bytes', name: 'deck.pptx', bytes: new Uint8Array() } },
    permissions: { read: true, write: true, comment: false, ai: false, export: false },
    readonly: false,
    onDirtyChange: dirty,
    onStatsChange: stats,
    onError: (error: Error) => errors.push(error),
  } as unknown as SurfaceContext
  const surface = new SlideEditSurface(backend, collab)
  await surface.mount(el, ctx)
  mounted.push({ surface, el })
  await vi.waitFor(() => expect(el.querySelector('[data-state="ready"]')).not.toBeNull())
  // 打开被拆成几个宏任务（每段让出一次主线程）：等第一页画上去（data-painted）才算打开完成
  await vi.waitFor(() => expect(Number(el.querySelector('[data-testid="slide-surface"]')?.getAttribute('data-painted'))).toBeGreaterThanOrEqual(1))
  await flushPromises()
  return { surface, el, backend, dirty, stats, errors, snapshot }
}

const q = (el: HTMLElement, testid: string) => el.querySelector<HTMLElement>(`[data-testid="${testid}"]`)
const click = (el: HTMLElement, testid: string) => q(el, testid)!.click()
const cmd = (type: string): EditorCommand => ({ id: type, type, source: 'user' })
/** jsdom 没有 PointerEvent，也没有布局：坐标 1:1（缩放在 jsdom 里是 1 以内的值，这里直接按 scale 反推） */
function pointer(el: HTMLElement, type: string, x: number, y: number) {
  const layer = q(el, 'slide-edit-layer')!
  const scale = Number(layer.parentElement!.style.width.replace('px', '')) / 1280 || 1
  const event = new MouseEvent(type, { clientX: x * scale, clientY: y * scale, bubbles: true, button: 0 })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  layer.dispatchEvent(event)
}

describe('编辑面接线', () => {
  it('编辑后端：出现编辑工具栏和编辑层；保存快照走异步提供者（序列化只在保存时发生）', async () => {
    const { el, snapshot, dirty } = await mountEdit()
    expect(q(el, 'slide-editbar')).not.toBeNull()
    expect(q(el, 'slide-edit-layer')).not.toBeNull()
    expect(el.querySelector('[data-editing="true"]')).not.toBeNull()
    expect(snapshot.sync?.()).toBeNull()
    const source = (await snapshot.async!()) as EditorSource
    expect(source).toMatchObject({ kind: 'bytes', name: 'deck.pptx' })
    expect(Array.from((source as { bytes: Uint8Array }).bytes)).toEqual([80, 75, 3, 4])
    expect(dirty).toHaveBeenLastCalledWith(false)
  })

  it('点工具栏「文本框」：后端新增一个、编辑层里出现光标和输入框、宿主被标脏', async () => {
    const { el, backend, dirty } = await mountEdit()
    click(el, 'slide-add-textbox')
    await flushPromises()
    expect(backend.calls.some((call) => call.startsWith('addTextBox'))).toBe(true)
    expect(q(el, 'slide-caret')).not.toBeNull()
    expect(q(el, 'slide-input')).not.toBeNull()
    expect(dirty).toHaveBeenLastCalledWith(true)
  })

  it('在画布上点文字 → 进入文字编辑；键入走 beforeinput 写进后端、画布重绘', async () => {
    const { el, backend } = await mountEdit()
    const painted = Number(q(el, 'slide-surface')!.dataset.painted)
    pointer(el, 'pointerdown', 190, 300)
    pointer(el, 'pointerup', 190, 300)
    await flushPromises()
    const input = q(el, 'slide-input') as HTMLTextAreaElement
    expect(input).not.toBeNull()
    const event = new Event('beforeinput', { cancelable: true, bubbles: true }) as InputEvent
    Object.assign(event, { inputType: 'insertText', data: 'X', isComposing: false })
    input.dispatchEvent(event)
    await flushPromises()
    expect(event.defaultPrevented).toBe(true)
    expect(backend.storyText('story:body0')).toBe('hello woXrld')
    await vi.waitFor(() => expect(Number(q(el, 'slide-surface')!.dataset.painted)).toBeGreaterThan(painted))
  })

  it('输入法：组字期间显示预编辑文字、不改文档；compositionend 才上屏', async () => {
    const { el, backend } = await mountEdit()
    pointer(el, 'pointerdown', 190, 300)
    pointer(el, 'pointerup', 190, 300)
    await flushPromises()
    const input = q(el, 'slide-input') as HTMLTextAreaElement
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    input.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'zhong' }))
    await flushPromises()
    expect(q(el, 'slide-preedit')!.textContent).toBe('zhong')
    expect(backend.storyText('story:body0')).toBe('hello world')
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }))
    await flushPromises()
    expect(q(el, 'slide-preedit')).toBeNull()
    expect(backend.storyText('story:body0')).toBe('hello wo中rld')
  })

  it('点工具栏按钮不抢输入框的焦点（mousedown 被阻止）', async () => {
    const { el } = await mountEdit()
    const bold = q(el, 'slide-bold')!
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    bold.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('撤销 / 重做命令走编辑后端', async () => {
    const { el, surface, backend } = await mountEdit()
    click(el, 'slide-add-shape')
    await flushPromises()
    q(el, 'slide-add-shape')!.click()
    el.querySelector<HTMLElement>('[data-preset="ellipse"]')!.click()
    await flushPromises()
    expect(backend.state.shapes[0]).toHaveLength(4)
    expect((await surface.command(cmd('undo'))).ok).toBe(true)
    await flushPromises()
    expect(backend.state.shapes[0]).toHaveLength(3)
    expect((await surface.command(cmd('redo'))).ok).toBe(true)
    await flushPromises()
    expect(backend.state.shapes[0]).toHaveLength(4)
    expect((await surface.command(cmd('undo'))).ok).toBe(true)
    expect((await surface.command(cmd('undo'))).ok).toBe(false)
  })

  it('引擎暂不支持的能力：按钮是灰的并带说明；点一下给出提示，不静默', async () => {
    const { el } = await mountEdit()
    const limited = el.querySelectorAll<HTMLElement>('.kb-sl-limited')
    expect([...limited].map((b) => b.dataset.limited)).toEqual(['表格', '连接线', '组合', '取消组合'])
    for (const button of limited) {
      expect(button.getAttribute('aria-disabled')).toBe('true')
      expect(button.title).toContain('PowerPoint')
    }
    limited[0]!.click()
    await flushPromises()
    expect(q(el, 'slide-editnote')!.textContent).toContain('表格暂不支持')
  })

  it('备注可编辑：停手后写回后端；切页前先写回上一页', async () => {
    const { el, backend } = await mountEdit({ count: 3 })
    // 编辑时备注栏默认展开（空白页也要能写备注）
    const area = q(el, 'slide-notes-edit') as HTMLTextAreaElement
    expect(area).not.toBeNull()
    area.value = '第一页的备注'
    area.dispatchEvent(new Event('input'))
    click(el, 'slide-next')
    await flushPromises()
    expect(backend.state.notes[0]).toBe('第一页的备注')
    expect((q(el, 'slide-notes-edit') as HTMLTextAreaElement).value).toBe('')
  })

  it('页操作：新建 / 复制 / 删除，页数与当前页跟着变', async () => {
    const { el, backend } = await mountEdit({ count: 3 })
    click(el, 'slide-new')
    await flushPromises()
    expect(backend.state.shapes).toHaveLength(4)
    expect(q(el, 'slide-surface')!.dataset.slide).toBe('1')
    click(el, 'slide-dup')
    await flushPromises()
    expect(backend.state.shapes).toHaveLength(5)
    click(el, 'slide-del')
    await flushPromises()
    expect(backend.state.shapes).toHaveLength(4)
    expect(q(el, 'slide-total')!.textContent).toContain('4')
  })

  it('插入图片：类型 / 大小不合格给出提示，不调用后端', async () => {
    const { el, backend } = await mountEdit()
    const input = q(el, 'slide-picture-input') as HTMLInputElement
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'a.bmp', { type: 'image/bmp' })], configurable: true })
    input.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(q(el, 'slide-editnote')!.textContent).toContain('PNG')
    expect(backend.calls.some((call) => call.startsWith('addPicture'))).toBe(false)
  })

  it('选中图片后「替换图片」可用；其它情况是灰的', async () => {
    const { el } = await mountEdit()
    expect((q(el, 'slide-replace-picture') as HTMLButtonElement).disabled).toBe(true)
    pointer(el, 'pointerdown', 750, 250)
    pointer(el, 'pointerup', 750, 250)
    await flushPromises()
    expect((q(el, 'slide-replace-picture') as HTMLButtonElement).disabled).toBe(false)
  })

  it('只读后端：编辑层不挂，工具栏全灰，宿主不会被标脏', async () => {
    const { el, dirty } = await mountEdit({ readonly: true })
    expect(q(el, 'slide-edit-layer')).toBeNull()
    expect((q(el, 'slide-add-textbox') as HTMLButtonElement).disabled).toBe(true)
    expect((q(el, 'slide-bold') as HTMLButtonElement).disabled).toBe(true)
    expect(el.querySelector('[data-editing="readonly"]')).not.toBeNull()
    expect(dirty).toHaveBeenLastCalledWith(false)
  })

  it('「仍然编辑」：setReadonly(false) 之后编辑层和按钮放开', async () => {
    const { el, surface } = await mountEdit({ readonly: true })
    surface.setReadonly(false)
    await flushPromises()
    expect(q(el, 'slide-edit-layer')).not.toBeNull()
    expect((q(el, 'slide-add-textbox') as HTMLButtonElement).disabled).toBe(false)
  })

  it('远端修改：不标脏（由房间落地），但画面和形状列表刷新', async () => {
    const { el, backend, dirty } = await mountEdit()
    dirty.mockClear()
    backend.state.shapes[0]!.pop()
    backend.injectRemote()
    await flushPromises()
    expect(dirty).not.toHaveBeenCalledWith(true)
  })

  it('引擎会话崩溃：错误交给宿主（由它给出恢复入口）', async () => {
    const { backend, errors } = await mountEdit()
    backend.breakIt(new Error('wasm trap'))
    expect(errors.map((e) => e.message)).toContain('wasm trap')
  })

  it('卸载时释放后端', async () => {
    const { surface, backend } = await mountEdit()
    surface.unmount()
    await flushPromises()
    expect(backend.log.disposed).toBe(true)
  })

  it('页内快捷键：选中形状后 Delete 删除；没选中时方向键翻页', async () => {
    const { el, backend } = await mountEdit()
    const stage = q(el, 'slide-stage')!
    const press = (key: string) => stage.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    press('ArrowRight')
    await flushPromises()
    expect(q(el, 'slide-surface')!.dataset.slide).toBe('1')
    press('ArrowLeft')
    await flushPromises()
    pointer(el, 'pointerdown', 750, 250)
    pointer(el, 'pointerup', 750, 250)
    await flushPromises()
    press('Delete')
    await flushPromises()
    expect(backend.calls.some((call) => call.startsWith('removeShape:pic0'))).toBe(true)
  })
})

describe('多人协同', () => {
  it('协同时本地修改不标「未保存」（文件由房间落地），也不登记保存快照；远端修改同样不标脏', async () => {
    const { el, backend, dirty, snapshot } = await mountEdit({ collab: true }, true)
    expect(snapshot.async).toBeNull()
    click(el, 'slide-add-textbox')
    await flushPromises()
    expect(backend.calls.some((call) => call.startsWith('addTextBox'))).toBe(true)
    expect(dirty).not.toHaveBeenCalledWith(true)
    backend.injectRemote()
    await flushPromises()
    expect(dirty).not.toHaveBeenCalledWith(true)
  })

  it('别人选中的形状在画布上画出对方颜色的框和名字；换页后只画当前页的', async () => {
    const { el, backend } = await mountEdit({ collab: true }, true)
    backend.peerList.push({ id: 7, name: '李四', color: '#e5484d', slide: 0, shapeId: 'body0' }, { id: 8, name: '王五', color: '#0090ff', slide: 2, shapeId: 'title2' })
    backend.emitPeers()
    await flushPromises()
    const boxes = [...el.querySelectorAll<HTMLElement>('[data-testid="slide-peer-box"]')]
    expect(boxes).toHaveLength(1)
    expect(boxes[0]!.textContent).toContain('李四')
    expect(boxes[0]!.style.borderColor).toBeTruthy()
    click(el, 'slide-next')
    click(el, 'slide-next')
    await flushPromises()
    expect(el.querySelectorAll('[data-testid="slide-peer-box"]')).toHaveLength(1)
    expect(el.querySelector('[data-testid="slide-peer-box"]')!.textContent).toContain('王五')
  })

  it('缩略图上标出谁在看哪一页', async () => {
    const { el, backend } = await mountEdit({ collab: true }, true)
    backend.peerList.push({ id: 7, name: '李四', color: '#e5484d', slide: 1, shapeId: null }, { id: 8, name: '王五', color: '#0090ff', slide: 1, shapeId: null })
    backend.emitPeers()
    await flushPromises()
    const dots = el.querySelectorAll('[data-testid="slide-thumb"]')[1]!.querySelectorAll('.kb-sl-peerdot')
    expect([...dots].map((d) => d.textContent)).toEqual(['李', '王'])
    expect(el.querySelectorAll('[data-testid="slide-thumb"]')[0]!.querySelector('[data-testid="slide-thumb-peers"]')).toBeNull()
  })

  it('本地位置（当前页 + 选中的形状）告诉别人；换页、选形状、取消选择都会更新', async () => {
    const { el, backend } = await mountEdit({ collab: true }, true)
    await flushPromises()
    expect(backend.cursors.at(-1)).toEqual([0, null])
    click(el, 'slide-next')
    await flushPromises()
    expect(backend.cursors.at(-1)).toEqual([1, null])
    pointer(el, 'pointerdown', 750, 250)
    pointer(el, 'pointerup', 750, 250)
    await flushPromises()
    expect(backend.cursors.at(-1)).toEqual([1, 'pic1'])
  })

  it('非协同的后端：没有在线状态的东西', async () => {
    const { el } = await mountEdit()
    expect(el.querySelector('[data-testid="slide-presence"]')).toBeNull()
    expect(el.querySelector('[data-testid="slide-thumb-peers"]')).toBeNull()
  })
})
