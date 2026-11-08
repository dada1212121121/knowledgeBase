import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import FileViewer from './FileViewer.vue'

// 预取 WASM 会真的发网络请求：用桩替掉，测试只关心「该不该调用」
const prefetchSpy = vi.hoisted(() => vi.fn())
vi.mock('@/editor/engines/pptxWasm', () => ({ prefetchPptxWasm: prefetchSpy, pptxWasmModule: vi.fn() }))

const block = { anchor: { kind: 'page' as const, page: 1 }, kind: 'paragraph' as const, text: '抽取出来的文字' }
const base = { blocks: [block], chunks: [], highlight: null }
const bytesResponse = (bytes: Uint8Array | string, status = 200) =>
  vi.fn(async () => new Response(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : (bytes as unknown as BodyInit), { status }))
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('FileViewer routing', () => {
  it('shows the text layer for image and media formats (DocViewer owns those)', async () => {
    const wrapper = mount(FileViewer, { props: { ...base, format: 'png', sourceUrl: '/x', rawUrl: '/x' } })
    await flushPromises()
    expect(wrapper.find('.kb-dv').exists()).toBe(true)
  })
  it('uses the text layer when there is no original to read', async () => {
    const wrapper = mount(FileViewer, { props: { ...base, format: 'pdf', sourceUrl: null } })
    await flushPromises()
    expect(wrapper.find('.kb-dv').exists()).toBe(true)
  })
  it('falls back to the text layer with a retry strip when the renderer reports an error', async () => {
    vi.stubGlobal('fetch', bytesResponse('', 404))
    const wrapper = mount(FileViewer, { props: { ...base, format: 'pdf', sourceUrl: '/api/v1/raw?x=1' }, attachTo: document.body })
    await vi.waitFor(() => expect(wrapper.find('.kb-fv-strip.is-warn').exists()).toBe(true), { timeout: 5000 })
    expect(wrapper.find('.kb-fv-strip').text()).toContain('找不到原件')
    expect(wrapper.find('.kb-dv').exists()).toBe(true)
    wrapper.unmount()
  })
  it('shows backend-provided text in the read-only code view, whatever the extension', async () => {
    const wrapper = mount(FileViewer, { props: { ...base, format: 'weird', content: 'let x = 1', sourceUrl: '/x', fileName: 'a.weird' }, attachTo: document.body })
    await vi.waitFor(() => expect(document.querySelector('.kb-ce .cm-content')?.textContent).toContain('let x = 1'), { timeout: 5000 })
    expect(wrapper.find('.kb-fv-strip').exists()).toBe(false)
    wrapper.unmount()
  })
  it('reads an unknown extension, sniffs it as a legacy-free text file and shows it', async () => {
    vi.stubGlobal('fetch', bytesResponse('plain notes\nsecond line'))
    const wrapper = mount(FileViewer, { props: { blocks: [], chunks: [], highlight: null, format: 'weird', sourceUrl: '/x', fileName: 'notes.weird' }, attachTo: document.body })
    await vi.waitFor(() => expect(document.querySelector('.kb-ce .cm-content')?.textContent).toContain('plain notes'), { timeout: 8000 })
    wrapper.unmount()
  })
  it('falls through to a hex dump for unknown binary data', async () => {
    vi.stubGlobal('fetch', bytesResponse(new Uint8Array([0, 1, 2, 3, 0xff, 0x41, 0x42, 0, 0, 9])))
    const wrapper = mount(FileViewer, { props: { blocks: [], chunks: [], highlight: null, format: 'dat', sourceUrl: '/x', fileName: 'blob.dat' }, attachTo: document.body })
    await vi.waitFor(() => expect(wrapper.find('.kb-bv-dump').exists()).toBe(true), { timeout: 8000 })
    expect(wrapper.find('.kb-bv-dump').text()).toContain('00000000')
    expect(wrapper.find('.kb-bv-dump').text()).toContain('|....')
    wrapper.unmount()
  })
  it('opens a zip by content even when named .bin, listing its files', async () => {
    const JSZip = (await import('jszip')).default
    const zip = new JSZip()
    zip.file('hello.txt', 'hi there')
    const bytes = await zip.generateAsync({ type: 'uint8array' })
    vi.stubGlobal('fetch', bytesResponse(bytes))
    const wrapper = mount(FileViewer, { props: { blocks: [], chunks: [], highlight: null, format: 'bin', sourceUrl: '/x', fileName: 'pack.bin' }, attachTo: document.body })
    await vi.waitFor(() => expect(wrapper.find('.kb-av-row').exists()).toBe(true), { timeout: 8000 })
    expect(wrapper.text()).toContain('hello.txt')
    wrapper.unmount()
  })
})

describe('FileViewer xlsx 预览', () => {
  afterEach(() => window.history.replaceState(null, '', '/'))

  it('xlsx 挂原生只读网格，不走 SheetViewer', async () => {
    // 取件挂起：只看路由与插槽，不在 jsdom 里起 xlsx 引擎
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)))
    window.history.replaceState(null, '', '/kb')
    const wrapper = mount(FileViewer, { props: { ...base, format: 'xlsx', sourceUrl: '/api/v1/raw?x=1', fileName: 'a.xlsx' }, attachTo: document.body })
    await vi.waitFor(() => expect(wrapper.find('[data-testid="native-sheet"]').exists()).toBe(true), { timeout: 5000 })
    expect(wrapper.find('.kb-sg').exists()).toBe(false)
    wrapper.unmount()
  })

  it('xls / ods 等老格式不受影响，仍走旧表格视图', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)))
    window.history.replaceState(null, '', '/kb')
    const wrapper = mount(FileViewer, { props: { ...base, format: 'xls', sourceUrl: '/api/v1/raw?x=1', fileName: 'a.xls' }, attachTo: document.body })
    await vi.waitFor(() => expect(wrapper.find('.kb-sg').exists()).toBe(true), { timeout: 5000 })
    expect(wrapper.find('[data-testid="native-sheet"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('FileViewer pptx 预览', () => {
  afterEach(() => window.history.replaceState(null, '', '/'))

  const mountPptx = (chunks: unknown[] = [], blocks: unknown[] = base.blocks) =>
    mount(FileViewer, { props: { ...base, blocks: blocks as never, chunks: chunks as never, format: 'pptx', sourceUrl: '/api/v1/raw?x=1', fileName: 'deck.pptx' }, attachTo: document.body })

  it('pptx 挂统一外壳的幻灯片面', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)))
    window.history.replaceState(null, '', '/kb')
    const wrapper = mountPptx()
    await vi.waitFor(() => expect(wrapper.find('[data-testid="editor-host"][data-surface-kind="slide"]').exists()).toBe(true), { timeout: 5000 })
    wrapper.unmount()
  })

  it('统一外壳的工具栏里保留「文字层」入口，点了切到检索文字层', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)))
    window.history.replaceState(null, '', '/kb')
    const wrapper = mountPptx()
    await vi.waitFor(() => expect(wrapper.find('[data-testid="editor-host"] .kb-fv-switch').exists()).toBe(true), { timeout: 5000 })
    await wrapper.find('[data-testid="editor-host"] .kb-fv-switch').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('.kb-dv').exists()).toBe(true), { timeout: 5000 })
    expect(wrapper.find('[data-testid="editor-host"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('引擎路径读不到原件：直接退到带重试条的文字层，不白屏', async () => {
    vi.stubGlobal('fetch', bytesResponse('', 404))
    window.history.replaceState(null, '', '/kb')
    const wrapper = mountPptx()
    // 引擎路径失败后不会停在错误框上：最终落在带重试条的文字层
    await vi.waitFor(() => expect(wrapper.find('.kb-fv-strip.is-warn').exists()).toBe(true), { timeout: 10_000 })
    expect(wrapper.find('.kb-dv').exists()).toBe(true)
    expect(wrapper.find('[data-testid="editor-host"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('确定要在幻灯片面打开 pptx 时才预取引擎 WASM（1.6 MB）：二进制文件不预取', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)))
    window.history.replaceState(null, '', '/kb')
    prefetchSpy.mockClear()
    // 回归：一开始预取的条件漏了文件类型，随便什么文件的预览都会白下一份 WASM
    const dat = mount(FileViewer, { props: { blocks: [], chunks: [], highlight: null, format: 'dat', sourceUrl: '/x', fileName: 'blob.dat' }, attachTo: document.body })
    await flushPromises()
    expect(prefetchSpy).not.toHaveBeenCalled()
    dat.unmount()

    window.history.replaceState(null, '', '/kb')
    const native = mountPptx()
    await vi.waitFor(() => expect(prefetchSpy).toHaveBeenCalledTimes(1), { timeout: 5000 })
    native.unmount()
  })

  it('检索命中的页码和文字传给幻灯片面作为首屏定位提示', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)))
    window.history.replaceState(null, '', '/kb')
    const chunk = { id: 'ck1', ordinal: 1, anchor: { kind: 'slide', slide: 7 }, start_line: null, end_line: null, title: null, text: '批次 2' }
    const wrapper = mount(FileViewer, {
      props: { ...base, chunks: [chunk] as never, highlight: 'ck1', format: 'pptx', sourceUrl: '/api/v1/raw?x=1', fileName: 'deck.pptx' },
      attachTo: document.body,
    })
    await vi.waitFor(() => expect(wrapper.find('[data-testid="editor-host"]').exists()).toBe(true), { timeout: 5000 })
    const host = wrapper.findComponent({ name: 'EditorHost' })
    const request = host.props('request') as { initialHint?: { text?: string; anchor?: { kind: string; slide: number } } }
    expect(request.initialHint?.anchor).toEqual({ kind: 'slide', slide: 7 })
    expect(request.initialHint?.text).toBe('批次 2')
    wrapper.unmount()
  })
})
