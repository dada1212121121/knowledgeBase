/**
 * PageSurface 适配器测试（补全）：轻预览 ⇄ 高保真查看（画布面只读委托）
 *
 * 画布面（DocxEditSurface）换成替身（真引擎要 WASM + Worker，e2e 里验）；其余——取字节、渲染、命令转发、
 * 状态上报、上下文约束（只读 / 不挂保存快照 / 不重复下载）、失败回退、预取——全是真实代码。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import JSZip from 'jszip'
import type { DocumentSession, EditorCommand, SurfaceContext, SurfaceQuery } from '../../types'
import { PageSurface } from './surface'

const PAGES_HTML = `<div class="kbdocx-wrapper">
  <section class="kbdocx"><p class="kbdocx_heading1">第一章 总则</p><p>合同条款一。</p></section>
  <section class="kbdocx"><p>第二页的合同条款二。</p></section>
  <section class="kbdocx"><p>第三页。</p></section>
</div>`

async function docxBytes(): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>合同条款</w:t></w:r></w:p></w:body></w:document>')
  return zip.generateAsync({ type: 'arraybuffer' })
}

const fetchMock = vi.hoisted(() => vi.fn())
vi.mock('@/utils/fetchOriginal', () => ({ fetchOriginal: fetchMock, OriginalError: class OriginalError extends Error {} }))
vi.mock('docx-preview', () => ({
  renderAsync: vi.fn(async (_buffer: ArrayBuffer, host: HTMLElement) => {
    host.innerHTML = PAGES_HTML
  }),
}))

/** 画布面替身：记录收到的选项 / 上下文 / 命令，位置读写可控 */
interface FakeCanvas {
  options: Record<string, unknown>
  ctx: SurfaceContext | null
  el: HTMLElement | null
  unmounted: boolean
  commands: EditorCommand[]
  thumbs: boolean
  position: { page: number; fraction: number; scale: number; fit: boolean }
  restored: unknown[]
}
const canvases = vi.hoisted(() => [] as unknown[])
const behavior = vi.hoisted(() => ({ failMount: '' as string, gate: null as null | Promise<void> }))
vi.mock('./edit/docxEditSurface', () => {
  class DocxEditSurface {
    fake: FakeCanvas
    constructor(options: Record<string, unknown>) {
      this.fake = { options, ctx: null, el: null, unmounted: false, commands: [], thumbs: options.thumbs !== false, position: { page: 14, fraction: 0.4, scale: 1.2, fit: true }, restored: [] }
      canvases.push(this.fake)
    }
    async mount(el: HTMLElement, ctx: SurfaceContext) {
      this.fake.el = el
      this.fake.ctx = ctx
      if (behavior.gate) await behavior.gate
      if (behavior.failMount) throw new Error(behavior.failMount)
      el.innerHTML = '<div data-testid="fake-canvas">画布</div>'
      // 真画布面会往会话里登记保存快照提供者；适配器给的上下文要把它变成空操作
      ctx.session.setSnapshotProvider?.(() => ({ kind: 'bytes', name: 'x', bytes: new Uint8Array() }) as never)
    }
    whenReady() {
      return Promise.resolve()
    }
    capturePosition() {
      return this.fake.position
    }
    restorePosition(start: unknown) {
      this.fake.restored.push(start)
    }
    isThumbsOpen() {
      return this.fake.thumbs
    }
    unmount() {
      this.fake.unmounted = true
      if (this.fake.el) this.fake.el.innerHTML = ''
    }
    resize() {}
    focus() {}
    async command(command: EditorCommand) {
      this.fake.commands.push(command)
      return { ok: true, data: { from: 'canvas' } }
    }
    async query(query: SurfaceQuery) {
      if (query.type === 'formatState') return { marks: [], block: '', inBlockquote: false, lists: { bullet: false, ordered: false, task: false }, toggles: this.fake.thumbs ? ['thumbs'] : [] }
      return null
    }
    capture() {
      return { kind: 'page' as const, extra: { from: 'canvas' } }
    }
    restore() {}
  }
  return { DocxEditSurface }
})

const engine = vi.hoisted(() => ({ prefetchDocxEngine: vi.fn(), releaseDocxPrefetch: vi.fn() }))
vi.mock('../../engines/docx', () => engine)

const cmd = (type: string, args?: unknown): EditorCommand => ({ id: `t_${type}`, type, args, source: 'user' })

/** 每个用例挂的内容面：用例结束统一卸载（预取监听挂在 document 上，不卸载会漏到下一个用例） */
const mounted: PageSurface[] = []

async function mountSurface() {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const stats = vi.fn()
  const snapshotProvider = vi.fn()
  const errors: Error[] = []
  const ctx = {
    session: { getSelection: () => null, setSnapshotProvider: snapshotProvider } as unknown as DocumentSession,
    document: { kind: 'page', format: 'docx', revision: 0, payload: { kind: 'text', text: '', name: '合同.docx', url: '/raw/a.docx' } },
    permissions: { read: true, write: false, comment: false, ai: false, export: false },
    readonly: true,
    onStatsChange: stats,
    onError: (error: Error) => errors.push(error),
  } as unknown as SurfaceContext
  const surface = new PageSurface()
  mounted.push(surface)
  await surface.mount(el, ctx)
  await flushPromises()
  await vi.waitFor(() => expect(el.querySelectorAll('section.kbdocx')).toHaveLength(3))
  return { surface, el, stats, snapshotProvider, errors, canvas: () => canvases.at(-1) as FakeCanvas | undefined }
}

beforeEach(async () => {
  canvases.length = 0
  behavior.failMount = ''
  behavior.gate = null
  engine.prefetchDocxEngine.mockClear()
  engine.releaseDocxPrefetch.mockClear()
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(await docxBytes())
  Element.prototype.scrollIntoView = () => undefined
})
afterEach(() => {
  for (const surface of mounted.splice(0)) surface.unmount()
  document.body.innerHTML = ''
})

describe('缩略图栏开关（轻预览）', () => {
  it('view.toggleThumbs 取反并回报；formatState 的 toggles 带 thumbs 让工具栏按钮高亮', async () => {
    const { surface } = await mountSurface()
    // jsdom 量不到容器宽度，按"宽屏默认开"
    expect(((await surface.query({ type: 'formatState' })) as { toggles: string[] }).toggles).toEqual(['thumbs'])
    expect((await surface.command(cmd('view.toggleThumbs'))).data).toEqual({ open: false })
    expect(((await surface.query({ type: 'formatState' })) as { toggles: string[] }).toggles).toEqual([])
    expect((await surface.command(cmd('view.toggleThumbs', { open: true }))).data).toEqual({ open: true })
    await flushPromises()
    expect(document.querySelectorAll('[data-testid="page-thumb"]')).toHaveLength(3)
  })

  it('开关变化通知外壳刷新工具栏高亮（onStatsChange）', async () => {
    const { surface, stats } = await mountSurface()
    const before = stats.mock.calls.length
    await surface.command(cmd('view.toggleThumbs'))
    await flushPromises()
    expect(stats.mock.calls.length).toBeGreaterThan(before)
  })
})

describe('高保真查看（画布后端）', () => {
  it('进入：画布面只读、只看不改地挂在舞台里，轻预览被拆掉；原件字节不重新下载；不往会话里挂保存快照', async () => {
    const { surface, el, snapshotProvider } = await mountSurface()
    expect(snapshotProvider).toHaveBeenCalledTimes(1)
    const result = await surface.command(cmd('view.hifi'))
    expect(result).toEqual({ ok: true, data: { hifi: true } })
    const canvas = (canvases.at(-1) as FakeCanvas)!
    expect(canvas.options).toMatchObject({ viewOnly: true, fileName: '合同.docx' })
    expect(canvas.ctx!.readonly).toBe(true)
    const payload = canvas.ctx!.document.payload as { kind: string; bytes: Uint8Array; name: string }
    expect(payload.kind).toBe('bytes')
    expect(payload.bytes.byteLength).toBeGreaterThan(100)
    // 画布面登记保存快照提供者的调用落进了空操作，真实会话只在挂载时登记过一次（"无内容"那个）
    expect(snapshotProvider).toHaveBeenCalledTimes(1)
    // 画布面在舞台里；轻预览已拆
    expect(el.querySelector('[data-testid="page-hifi-stage"] [data-testid="fake-canvas"]')).not.toBeNull()
    expect(el.querySelector('.kb-pgs')).toBeNull()
    expect(el.querySelector('[data-testid="page-hifi-loading"]')).toBeNull()
    // 没有再下载一遍
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('进入时带着轻预览的阅读位置：画布面第一帧后把它放回去', async () => {
    const { surface } = await mountSurface()
    await surface.command(cmd('view.hifi'))
    const canvas = (canvases.at(-1) as FakeCanvas)!
    expect(canvas.restored).toHaveLength(1)
    expect(canvas.restored[0]).toEqual(expect.objectContaining({ page: expect.any(Number), fraction: expect.any(Number) }))
  })

  it('高保真期间：命令 / 查询都转给画布面；工具栏状态补上 hifi 开关', async () => {
    const { surface } = await mountSurface()
    await surface.command(cmd('view.hifi'))
    const canvas = (canvases.at(-1) as FakeCanvas)!
    const result = await surface.command(cmd('search.set', { query: '合同' }))
    expect(result.data).toEqual({ from: 'canvas' })
    await surface.command(cmd('view.toggleThumbs'))
    expect(canvas.commands.map((c) => c.type)).toEqual(['search.set', 'view.toggleThumbs'])
    expect(((await surface.query({ type: 'formatState' })) as { toggles: string[] }).toggles).toEqual(['thumbs', 'hifi'])
    expect(surface.capture().extra).toEqual({ from: 'canvas' })
  })

  it('再点一次回到轻预览：画布面卸载，轻预览用保留的字节重新渲染（不下载），带回阅读位置与缩略图开关；开关里不再有 hifi', async () => {
    const { surface, el } = await mountSurface()
    await surface.command(cmd('view.hifi'))
    const canvas = (canvases.at(-1) as FakeCanvas)!
    canvas.thumbs = false
    const back = await surface.command(cmd('view.hifi'))
    expect(back).toEqual({ ok: true, data: { hifi: false } })
    expect(canvas.unmounted).toBe(true)
    expect(el.querySelector('[data-testid="page-hifi-stage"]')).toBeNull()
    await vi.waitFor(() => expect(el.querySelectorAll('section.kbdocx')).toHaveLength(3))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // 缩略图开关沿用画布面里最后的选择（关）
    await flushPromises()
    expect(el.querySelector('[data-testid="page-thumbs"]')).toBeNull()
    expect(((await surface.query({ type: 'formatState' })) as { toggles: string[] }).toggles).toEqual([])
  })

  it('进入失败（引擎起不来）：如实报原因，留在轻预览，没有残留的舞台 / 加载提示，之后照常可用', async () => {
    const { surface, el } = await mountSurface()
    behavior.failMount = '引擎起不来'
    const result = await surface.command(cmd('view.hifi'))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('高保真查看没有打开')
    expect(result.reason).toContain('引擎起不来')
    expect((canvases.at(-1) as FakeCanvas).unmounted).toBe(true)
    expect(el.querySelector('[data-testid="page-hifi-stage"]')).toBeNull()
    expect(el.querySelector('[data-testid="page-hifi-loading"]')).toBeNull()
    expect(el.querySelectorAll('section.kbdocx')).toHaveLength(3)
    expect(((await surface.command(cmd('search.set', { query: '合同条款' }))).data as { total: number }).total).toBe(0 + ((await surface.query({ type: 'search' })) as { total: number }).total)
  })

  it('切换进行中：加载提示可见，其它命令被拒绝并说明；切换完成后恢复', async () => {
    const { surface, el } = await mountSurface()
    let release!: () => void
    behavior.gate = new Promise<void>((resolve) => (release = resolve))
    const pending = surface.command(cmd('view.hifi'))
    await vi.waitFor(() => expect(el.querySelector('[data-testid="page-hifi-loading"]')).not.toBeNull())
    const blocked = await surface.command(cmd('zoom.in'))
    expect(blocked.ok).toBe(false)
    expect(blocked.reason).toContain('正在切换版式')
    const again = await surface.command(cmd('view.hifi'))
    expect(again.ok).toBe(false)
    release()
    expect((await pending).ok).toBe(true)
    expect((await surface.command(cmd('zoom.in'))).ok).toBe(true)
  })

  it('打开途中画布面报错（如引擎 Worker 起不来）：立刻失败并如实说明，不把错误交给 Host（Host 会整块换成出错页）', async () => {
    const { surface, el, errors } = await mountSurface()
    let release!: () => void
    behavior.gate = new Promise<void>((resolve) => (release = resolve))
    const pending = surface.command(cmd('view.hifi'))
    await vi.waitFor(() => expect((canvases.at(-1) as FakeCanvas | undefined)?.ctx).toBeTruthy())
    ;(canvases.at(-1) as FakeCanvas).ctx!.onError?.(new Error('引擎 Worker 加载失败'))
    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('引擎 Worker 加载失败')
    expect(errors).toEqual([])
    expect(el.querySelector('[data-testid="page-hifi-stage"]')).toBeNull()
    expect(el.querySelectorAll('section.kbdocx')).toHaveLength(3)
    release()
  })

  it('高保真期间画布面出错：退回轻预览并给一条可关闭的提示，不触发 Host 的出错页；位置带回', async () => {
    const { surface, el, errors } = await mountSurface()
    await surface.command(cmd('view.hifi'))
    const canvas = (canvases.at(-1) as FakeCanvas)!
    canvas.ctx!.onError?.(new Error('帧解码失败'))
    await vi.waitFor(() => expect(el.querySelector('[data-testid="page-hifi-notice"]')).not.toBeNull())
    expect(el.querySelector('[data-testid="page-hifi-notice"]')!.textContent).toContain('帧解码失败')
    expect(canvas.unmounted).toBe(true)
    expect(errors).toEqual([])
    await vi.waitFor(() => expect(el.querySelectorAll('section.kbdocx')).toHaveLength(3))
    expect(((await surface.query({ type: 'formatState' })) as { toggles: string[] }).toggles).not.toContain('hifi')
    ;(el.querySelector('[data-testid="page-hifi-notice"] button') as HTMLButtonElement).click()
    expect(el.querySelector('[data-testid="page-hifi-notice"]')).toBeNull()
  })

  it('画布面里关掉窗口（unmount）：画布面释放、舞台清掉', async () => {
    const { surface, el } = await mountSurface()
    await surface.command(cmd('view.hifi'))
    const canvas = (canvases.at(-1) as FakeCanvas)!
    surface.unmount()
    expect(canvas.unmounted).toBe(true)
    expect(el.querySelector('[data-testid="page-hifi-stage"]')).toBeNull()
  })

  it('on 参数：明确要求进入 / 退出时幂等（已经在目标状态就什么也不做）', async () => {
    const { surface } = await mountSurface()
    expect((await surface.command(cmd('view.hifi', { on: false }))).data).toEqual({ hifi: false })
    expect(canvases).toHaveLength(0)
    await surface.command(cmd('view.hifi', { on: true }))
    expect((await surface.command(cmd('view.hifi', { on: true }))).data).toEqual({ hifi: true })
    expect(canvases).toHaveLength(1)
  })
})

describe('悬停预取', () => {
  it('悬停 / 聚焦工具栏上的「高保真查看」预取画布引擎（与在线编辑共用预取槽）；移开释放；别的按钮不触发；卸载后不再响应', async () => {
    const { surface } = await mountSurface()
    const button = document.createElement('button')
    button.dataset.action = 'page.hifi'
    const other = document.createElement('button')
    other.dataset.action = 'find'
    document.body.append(button, other)

    other.dispatchEvent(new Event('pointerover', { bubbles: true }))
    await flushPromises()
    expect(engine.prefetchDocxEngine).not.toHaveBeenCalled()

    button.dispatchEvent(new Event('pointerover', { bubbles: true }))
    await vi.waitFor(() => expect(engine.prefetchDocxEngine).toHaveBeenCalledTimes(1))
    button.dispatchEvent(new Event('pointerout', { bubbles: true }))
    await vi.waitFor(() => expect(engine.releaseDocxPrefetch).toHaveBeenCalledTimes(1))
    button.dispatchEvent(new Event('focusin', { bubbles: true }))
    await vi.waitFor(() => expect(engine.prefetchDocxEngine).toHaveBeenCalledTimes(2))

    surface.unmount()
    button.dispatchEvent(new Event('pointerover', { bubbles: true }))
    await flushPromises()
    expect(engine.prefetchDocxEngine).toHaveBeenCalledTimes(2)
  })
})
